import { AlarmScheduler } from '../adapters/alarm-scheduler'
import { createLlmAdapter } from '../adapters/llm'
import { ensureMigrated, idempotentRequest } from '../db/migrate'
import { sqlOneRow, sqlString } from '../db/sql'
import { logInfo } from '../lib/log'
import {
  ResearchStartInputSchema,
  ResearchStartResultSchema,
  type Env,
  type ResearchStartInput,
  type ResearchStartResult,
} from '../types'

export class Researcher {
  private sql!: SqlStorage
  private scheduler!: AlarmScheduler

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  private async init(): Promise<void> {
    if (this.sql) return
    this.sql = await ensureMigrated(this.ctx, 'researcher')
    this.scheduler = new AlarmScheduler(this.sql, this.ctx)
  }

  async fetch(request: Request): Promise<Response> {
    await this.init()
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/start') {
      const body = ResearchStartInputSchema.parse(await request.json())
      const result = await this.startTask(body)
      return Response.json(result)
    }

    return new Response('not found', { status: 404 })
  }

  async startTask(input: ResearchStartInput): Promise<ResearchStartResult> {
    await this.init()
    const dedupe = idempotentRequest(this.sql, input.request_id)
    if (dedupe.alreadyProcessed) {
      const cached = sqlOneRow(
        this.sql,
        `SELECT data FROM session_state WHERE id = ?`,
        input.request_id
      )
      const data = sqlString(cached, 'data')
      if (data) {
        return ResearchStartResultSchema.parse(JSON.parse(data))
      }
    }

    const llm = createLlmAdapter(this.env)
    const summary = await llm.summarize(input.objective)
    const citations = [`https://example.com/source-for-${input.shard_id}`]

    const result: ResearchStartResult = {
      ok: true,
      task_id: input.task_id,
      shard_id: input.shard_id,
      status: 'completed',
      summary,
      citations,
    }

    this.sql.exec(
      `INSERT INTO session_state (id, data, version_id, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      input.request_id,
      JSON.stringify(result),
      new Date().toISOString()
    )

    this.sql.exec(
      `INSERT INTO research_log (id, step_index, status, tool_name, request, response, created_at)
       VALUES (?, 0, 'completed', 'mock_research', ?, ?, ?)`,
      `${input.request_id}:log`,
      JSON.stringify(input),
      JSON.stringify(result),
      new Date().toISOString()
    )

    const outboxId = crypto.randomUUID()
    this.sql.exec(
      `INSERT INTO outbox (id, target_actor, payload, status, created_at)
       VALUES (?, 'orchestrator', ?, 'pending', ?)`,
      outboxId,
      JSON.stringify({
        kind: 'progress',
        task_id: input.task_id,
        thread_key: input.thread_key,
        message: `Shard ${input.shard_id} complete`,
        request_id: `${input.request_id}:progress`,
      }),
      new Date().toISOString()
    )

    this.scheduler.schedule({
      id: `outbox:${outboxId}`,
      kind: 'outbox_retry',
      runAtMs: Date.now() + 100,
      payload: { outbox_id: outboxId },
    })

    logInfo({
      event: 'researcher_shard_complete',
      actor: 'researcher',
      task_id: input.task_id,
      request_id: input.request_id,
    })

    return result
  }

  async alarm(): Promise<void> {
    await this.init()
    const item = this.scheduler.popDue(Date.now())
    if (!item) {
      await this.scheduler.syncNextAlarm()
      return
    }

    if (item.kind === 'outbox_retry' && item.payload?.outbox_id) {
      await this.flushOutbox(String(item.payload.outbox_id))
    }

    await this.scheduler.syncNextAlarm()
  }

  private async flushOutbox(outboxId: string): Promise<void> {
    const row = sqlOneRow(
      this.sql,
      `SELECT payload FROM outbox WHERE id = ? AND status = 'pending'`,
      outboxId
    )
    const payloadRaw = sqlString(row, 'payload')
    if (!payloadRaw) return

    const payload = JSON.parse(payloadRaw) as {
      task_id: string
      thread_key: string
      message: string
      request_id: string
      kind: 'progress' | 'complete' | 'error'
    }

    const orchestratorId = this.env.ORCHESTRATOR.idFromName(payload.thread_key)
    const orchestrator = this.env.ORCHESTRATOR.get(orchestratorId)
    await orchestrator.fetch('http://orchestrator/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    this.sql.exec(`UPDATE outbox SET status = 'sent' WHERE id = ?`, outboxId)
  }
}
