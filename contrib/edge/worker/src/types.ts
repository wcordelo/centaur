import { z } from 'zod'

export interface Env {
  ORCHESTRATOR: DurableObjectNamespace
  RESEARCHER: DurableObjectNamespace
  VERIFIER: DurableObjectNamespace
  TASK_WORKFLOW: Workflow
  SLACK_EVENTS: Queue<SlackQueueMessage>
  BLOBS: R2Bucket
  EDGE_FLAGS: KVNamespace

  SLACK_SIGNING_SECRET: string
  SLACK_BOT_TOKEN?: string
  LLM_MODE: 'mock' | 'live'
  EDGE_TASK_DEADLINE_MS: string
  SLACK_ALLOWED_CHANNEL_IDS?: string
  SLACK_ALLOWED_USER_IDS?: string
  AI_GATEWAY_URL?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

export const SlackEventEnvelopeSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  token: z.string().optional(),
  team_id: z.string().optional(),
  event_id: z.string().optional(),
  event_time: z.number().optional(),
  event: z.record(z.unknown()).optional(),
})

export type SlackEventEnvelope = z.infer<typeof SlackEventEnvelopeSchema>

export const SlackQueueMessageSchema = z.object({
  event_id: z.string(),
  team_id: z.string().optional(),
  thread_key: z.string(),
  objective: z.string(),
  channel_id: z.string(),
  thread_ts: z.string(),
  user_id: z.string().optional(),
  event_ts: z.string(),
  enqueued_at: z.string(),
})

export type SlackQueueMessage = z.infer<typeof SlackQueueMessageSchema>

export const TaskInputSchema = z.object({
  task_id: z.string(),
  thread_key: z.string(),
  objective: z.string(),
  channel_id: z.string(),
  thread_ts: z.string(),
  event_id: z.string(),
  event_ts: z.string(),
  thread_context_r2_key: z.string().optional(),
})

export type TaskInput = z.infer<typeof TaskInputSchema>

export const ResearchStartInputSchema = z.object({
  task_id: z.string(),
  thread_key: z.string(),
  shard_id: z.string(),
  objective: z.string(),
  request_id: z.string(),
  thread_context_r2_key: z.string().optional(),
})

export type ResearchStartInput = z.infer<typeof ResearchStartInputSchema>

export const ResearchStartResultSchema = z.object({
  ok: z.literal(true),
  task_id: z.string(),
  shard_id: z.string(),
  status: z.enum(['started', 'continuing', 'completed']),
  summary: z.string().optional(),
  citations: z.array(z.string()).optional(),
})

export type ResearchStartResult = z.infer<typeof ResearchStartResultSchema>

export const VerifyInputSchema = z.object({
  task_id: z.string(),
  objective: z.string(),
  summary: z.string(),
  citations: z.array(z.string()),
  request_id: z.string(),
})

export type VerifyInput = z.infer<typeof VerifyInputSchema>

export const VerifyResultSchema = z.object({
  verdict: z.enum(['pass', 'reject', 'revise']),
  issues: z.array(z.string()),
  revision_brief: z.string().optional(),
  request_id: z.string(),
})

export type VerifyResult = z.infer<typeof VerifyResultSchema>

export const OrchestratorNotifySchema = z.object({
  kind: z.enum(['progress', 'complete', 'error']),
  task_id: z.string(),
  thread_key: z.string(),
  message: z.string(),
  request_id: z.string(),
})

export type OrchestratorNotify = z.infer<typeof OrchestratorNotifySchema>

export interface TaskBudget {
  max_alarms: number
  max_llm_calls: number
  max_tool_calls: number
  max_parallel_jobs: number
}

export const DEFAULT_TASK_BUDGET: TaskBudget = {
  max_alarms: 200,
  max_llm_calls: 50,
  max_tool_calls: 30,
  max_parallel_jobs: 2,
}

export function parseAllowlist(raw: string | undefined): Set<string> | null {
  if (!raw?.trim()) return null
  return new Set(
    raw
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  )
}

export function slackThreadKey(teamId: string, channelId: string, threadTs: string): string {
  return `slack:${teamId}:${channelId}:${threadTs}`
}

export function newTaskId(): string {
  return crypto.randomUUID()
}
