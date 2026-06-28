import { Hono } from 'hono'
import { Orchestrator } from './actors/orchestrator'
import { Researcher } from './actors/researcher'
import { Verifier } from './actors/verifier'
import { logError, logInfo } from './lib/log'
import { handleSlackWebhook } from './slack/handler'
import { TaskWorkflow } from './workflows/task-workflow'
import { SlackQueueMessageSchema, type Env } from './types'

export { Orchestrator, Researcher, Verifier, TaskWorkflow }

const app = new Hono<{ Bindings: Env }>()

app.get('/healthz', c => c.json({ ok: true, service: 'centaur-edge' }))

app.post('/slack/events', async c => {
  return handleSlackWebhook(c.req.raw, c.env)
})

app.get('/admin/tasks/:taskId', async c => {
  const orchestrator = c.env.ORCHESTRATOR.get(
    c.env.ORCHESTRATOR.idFromName(c.req.query('thread_key') ?? c.req.param('taskId'))
  )
  const response = await orchestrator.fetch(`http://orchestrator/tasks/${c.req.param('taskId')}`)
  return response
})

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const payload = SlackQueueMessageSchema.parse(message.body)
        const orchestrator = env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName(payload.thread_key))
        const response = await orchestrator.fetch('http://orchestrator/enqueue', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          throw new Error(`orchestrator enqueue failed: ${response.status}`)
        }
        logInfo({
          event: 'queue_message_processed',
          thread_key: payload.thread_key,
          request_id: payload.event_id,
        })
        message.ack()
      } catch (error) {
        logError({
          event: 'queue_message_failed',
          msg: error instanceof Error ? error.message : String(error),
        })
        message.retry()
      }
    }
  },
}
