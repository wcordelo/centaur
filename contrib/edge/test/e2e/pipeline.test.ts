import { createHmac } from 'node:crypto'
import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { runResearchPipeline } from '../../worker/src/workflows/task-workflow'
import { TaskInputSchema, type Env } from '../../worker/src/types'

const bindings = env as Env

const SIGNING_SECRET = 'test-signing-secret'

function signedSlackBody(body: Record<string, unknown>): { body: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(body)
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')
  return {
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': `v0=${signature}`,
    },
  }
}

describe('edge e2e', () => {
  it('healthz responds ok', async () => {
    const response = await SELF.fetch('http://centaur-edge/healthz')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, service: 'centaur-edge' })
  })

  it('slack url_verification challenge', async () => {
    const signed = signedSlackBody({ type: 'url_verification', challenge: 'challenge-token' })
    const response = await SELF.fetch('http://centaur-edge/slack/events', {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ challenge: 'challenge-token' })
  })

  it('signed app_mention returns 200 quickly', async () => {
    const signed = signedSlackBody({
      type: 'event_callback',
      event_id: 'E2E-MENTION-1',
      team_id: 'TTEST001',
      event: {
        type: 'app_mention',
        channel: 'CTEST001',
        user: 'UTEST001',
        text: '<@UBOT> summarize edge migration status',
        ts: '1700000001.0001',
        thread_ts: '1700000000.0001',
      },
    })

    const started = Date.now()
    const response = await SELF.fetch('http://centaur-edge/slack/events', {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    })
    const elapsed = Date.now() - started

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(elapsed).toBeLessThan(3000)
  })

  it('research pipeline: Researcher → Verifier → Orchestrator post', async () => {
    const taskInput = TaskInputSchema.parse({
      task_id: crypto.randomUUID(),
      thread_key: 'slack:TTEST001:CTEST001:1700000000.0001',
      objective: 'Summarize Cloudflare edge actor framework',
      channel_id: 'CTEST001',
      thread_ts: '1700000000.0001',
      event_id: 'E2E-TASK-1',
      event_ts: '1700000001.0001',
    })

    const orchestrator = bindings.ORCHESTRATOR.get(bindings.ORCHESTRATOR.idFromName(taskInput.thread_key))
    await orchestrator.fetch('http://orchestrator/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(taskInput),
    })

    const finalText = await runResearchPipeline(bindings, taskInput)
    expect(finalText).toContain('Mock summary')
    expect(finalText).toContain('Sources:')

    const taskResponse = await orchestrator.fetch(`http://orchestrator/tasks/${taskInput.task_id}`)
    const taskBody = (await taskResponse.json()) as { task: { status?: string } | null }
    expect(taskBody.task?.status).toBe('completed')
  })
})
