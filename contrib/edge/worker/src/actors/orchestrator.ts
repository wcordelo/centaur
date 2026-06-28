import { ensureMigrated, idempotentRequest } from '../db/migrate'
import { sqlOneRow, sqlString } from '../db/sql'
import { logInfo } from '../lib/log'
import { postSlackMessage, setAssistantStatus } from '../slack/post'
import {
  newTaskId,
  OrchestratorNotifySchema,
  SlackQueueMessageSchema,
  TaskInputSchema,
  type Env,
  type OrchestratorNotify,
  type SlackQueueMessage,
  type TaskInput,
} from '../types'

export class Orchestrator {
  private sql!: SqlStorage

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  private async init(): Promise<void> {
    if (this.sql) return
    this.sql = await ensureMigrated(this.ctx, 'orchestrator')
  }

  async fetch(request: Request): Promise<Response> {
    await this.init()
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/seed') {
      const body = TaskInputSchema.parse(await request.json())
      await this.seedTask(body)
      return Response.json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/enqueue') {
      const body = SlackQueueMessageSchema.parse(await request.json())
      const result = await this.enqueue(body)
      return Response.json(result)
    }

    if (request.method === 'POST' && url.pathname === '/notify') {
      const body = OrchestratorNotifySchema.parse(await request.json())
      await this.handleNotify(body)
      return Response.json({ ok: true })
    }

    if (request.method === 'GET' && url.pathname.startsWith('/tasks/')) {
      const parts = url.pathname.split('/').filter(Boolean)
      const taskId = parts[1]
      if (!taskId || parts.length !== 2) {
        return new Response('not found', { status: 404 })
      }
      const row = sqlOneRow(this.sql, `SELECT * FROM tasks WHERE task_id = ?`, taskId)
      return Response.json({ task: row ?? null })
    }

    if (request.method === 'POST' && url.pathname.match(/^\/tasks\/[^/]+\/running$/)) {
      const taskId = url.pathname.split('/')[2]
      if (!taskId) return new Response('missing task id', { status: 400 })
      await this.markRunning(taskId)
      return Response.json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname.match(/^\/tasks\/[^/]+\/post$/)) {
      const taskId = url.pathname.split('/')[2]
      if (!taskId) return new Response('missing task id', { status: 400 })
      const body = (await request.json()) as { text?: string }
      if (!body.text) return new Response('missing text', { status: 400 })
      await this.postFinal(taskId, body.text)
      return Response.json({ ok: true })
    }

    return new Response('not found', { status: 404 })
  }

  async seedTask(input: TaskInput): Promise<void> {
    await this.init()
    const now = new Date().toISOString()
    this.sql.exec(
      `INSERT INTO tasks (
         task_id, thread_key, status, objective, channel_id, thread_ts,
         event_id, event_ts, deadline_at, created_at, updated_at
       ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         status = excluded.status,
         objective = excluded.objective,
         updated_at = excluded.updated_at`,
      input.task_id,
      input.thread_key,
      input.objective,
      input.channel_id,
      input.thread_ts,
      input.event_id,
      input.event_ts,
      null,
      now,
      now
    )
  }

  async enqueue(message: SlackQueueMessage): Promise<{ ok: true; task_id: string; duplicate?: boolean }> {
    await this.init()

    const existing = sqlOneRow(
      this.sql,
      `SELECT event_id FROM processed_slack_events WHERE event_id = ?`,
      message.event_id
    )
    if (existing) {
      return { ok: true, task_id: '', duplicate: true }
    }

    const taskId = newTaskId()
    const now = new Date().toISOString()
    const deadlineMs = Number.parseInt(this.env.EDGE_TASK_DEADLINE_MS, 10)
    const deadlineAt = new Date(Date.now() + (Number.isFinite(deadlineMs) ? deadlineMs : 1_800_000)).toISOString()

    this.sql.exec(
      `UPDATE tasks SET status = 'superseded', updated_at = ?
       WHERE thread_key = ? AND status IN ('queued', 'running')`,
      now,
      message.thread_key
    )

    this.sql.exec(
      `INSERT INTO tasks (
         task_id, thread_key, status, objective, channel_id, thread_ts,
         event_id, event_ts, deadline_at, created_at, updated_at
       ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId,
      message.thread_key,
      message.objective,
      message.channel_id,
      message.thread_ts,
      message.event_id,
      message.event_ts,
      deadlineAt,
      now,
      now
    )

    this.sql.exec(
      `INSERT INTO processed_slack_events (event_id, processed_at) VALUES (?, ?)`,
      message.event_id,
      now
    )

    const taskInput: TaskInput = TaskInputSchema.parse({
      task_id: taskId,
      thread_key: message.thread_key,
      objective: message.objective,
      channel_id: message.channel_id,
      thread_ts: message.thread_ts,
      event_id: message.event_id,
      event_ts: message.event_ts,
    })

    await this.env.TASK_WORKFLOW.create({
      id: taskId,
      params: taskInput,
    })

    logInfo({
      event: 'task_workflow_started',
      actor: 'orchestrator',
      thread_key: message.thread_key,
      task_id: taskId,
      request_id: message.event_id,
    })

    return { ok: true, task_id: taskId }
  }

  async handleNotify(notify: OrchestratorNotify): Promise<void> {
    await this.init()
    const dedupe = idempotentRequest(this.sql, notify.request_id)
    if (dedupe.alreadyProcessed) return

    const task = sqlOneRow(
      this.sql,
      `SELECT channel_id, thread_ts FROM tasks WHERE task_id = ?`,
      notify.task_id
    )
    const channelId = sqlString(task, 'channel_id')
    const threadTs = sqlString(task, 'thread_ts')
    if (!channelId || !threadTs) return

    if (notify.kind === 'progress') {
      await setAssistantStatus(this.env, {
        channelId,
        threadTs,
        status: notify.message.slice(0, 100),
      })
      return
    }

    if (notify.kind === 'complete') {
      await postSlackMessage(this.env, {
        channelId,
        threadTs,
        text: notify.message,
      })
      this.sql.exec(
        `UPDATE tasks SET status = 'completed', updated_at = ? WHERE task_id = ?`,
        new Date().toISOString(),
        notify.task_id
      )
      return
    }

    await postSlackMessage(this.env, {
      channelId,
      threadTs,
      text: `:warning: ${notify.message}`,
    })
    this.sql.exec(
      `UPDATE tasks SET status = 'failed', updated_at = ? WHERE task_id = ?`,
      new Date().toISOString(),
      notify.task_id
    )
  }

  async markRunning(taskId: string): Promise<void> {
    await this.init()
    this.sql.exec(
      `UPDATE tasks SET status = 'running', updated_at = ? WHERE task_id = ?`,
      new Date().toISOString(),
      taskId
    )
  }

  async postFinal(taskId: string, text: string): Promise<void> {
    await this.init()
    const task = sqlOneRow(
      this.sql,
      `SELECT channel_id, thread_ts FROM tasks WHERE task_id = ?`,
      taskId
    )
    const channelId = sqlString(task, 'channel_id')
    const threadTs = sqlString(task, 'thread_ts')
    if (!channelId || !threadTs) return

    await postSlackMessage(this.env, {
      channelId,
      threadTs,
      text,
    })
    this.sql.exec(
      `UPDATE tasks SET status = 'completed', updated_at = ? WHERE task_id = ?`,
      new Date().toISOString(),
      taskId
    )
  }
}
