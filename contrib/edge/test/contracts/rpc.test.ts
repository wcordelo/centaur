import { describe, expect, it } from 'vitest'
import {
  ResearchStartInputSchema,
  ResearchStartResultSchema,
  TaskInputSchema,
  VerifyInputSchema,
  VerifyResultSchema,
} from '../../worker/src/types'

describe('RPC contracts', () => {
  it('parses task workflow input', () => {
    const parsed = TaskInputSchema.parse({
      task_id: 'task-1',
      thread_key: 'slack:T1:C1:123.456',
      objective: 'Research topic',
      channel_id: 'C1',
      thread_ts: '123.456',
      event_id: 'E1',
      event_ts: '123.456',
    })
    expect(parsed.task_id).toBe('task-1')
  })

  it('parses research start IO', () => {
    const input = ResearchStartInputSchema.parse({
      task_id: 'task-1',
      thread_key: 'slack:T1:C1:123.456',
      shard_id: 'shard_0',
      objective: 'Find sources',
      request_id: 'task-1:0',
    })
    const output = ResearchStartResultSchema.parse({
      ok: true,
      task_id: input.task_id,
      shard_id: input.shard_id,
      status: 'completed',
      summary: 'Mock summary',
      citations: ['https://example.com'],
    })
    expect(output.status).toBe('completed')
  })

  it('parses verifier IO', () => {
    const input = VerifyInputSchema.parse({
      task_id: 'task-1',
      objective: 'Research topic',
      summary: 'A sufficiently long summary for verification.',
      citations: ['https://example.com'],
      request_id: 'task-1:verify:0',
    })
    const output = VerifyResultSchema.parse({
      verdict: 'pass',
      issues: [],
      request_id: input.request_id,
    })
    expect(output.verdict).toBe('pass')
  })
})
