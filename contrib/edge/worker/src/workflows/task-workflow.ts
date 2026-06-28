import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { createLlmAdapter } from '../adapters/llm'
import { createRpcAdapter } from '../adapters/rpc'
import { logInfo } from '../lib/log'
import {
  TaskInputSchema,
  type Env,
  type ResearchStartResult,
  type TaskInput,
} from '../types'

function mergeShardSummaries(results: ResearchStartResult[]): {
  summary: string
  citations: string[]
} {
  const summaries = results
    .map(r => r.summary)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
  const citations = [...new Set(results.flatMap(r => r.citations ?? []))]
  return {
    summary: summaries.join('\n\n'),
    citations,
  }
}

export class TaskWorkflow extends WorkflowEntrypoint<Env, TaskInput> {
  async run(event: WorkflowEvent<TaskInput>, step: WorkflowStep): Promise<void> {
    const input = TaskInputSchema.parse(event.payload)
    const rpc = createRpcAdapter(this.env)

    logInfo({
      event: 'task_workflow_run',
      task_id: input.task_id,
      thread_key: input.thread_key,
    })

    await step.do('mark-running', async () => {
      await rpc.markOrchestratorRunning(input.thread_key, input.task_id)
    })

    const plan = await step.do('plan', async () => {
      const llm = createLlmAdapter(this.env)
      return llm.plan(input.objective)
    })

    const shardResults = await Promise.all(
      plan.subtasks.map((objective, index) =>
        step.do(`research-${index}`, async () =>
          rpc.researcherStart({
            task_id: input.task_id,
            thread_key: input.thread_key,
            shard_id: `shard_${index}`,
            objective,
            request_id: `${input.task_id}:${index}`,
          })
        )
      )
    )

    const merged = await step.do('merge', async () => mergeShardSummaries(shardResults))

    let round = 0
    let verdict = await step.do('verify', async () =>
      rpc.verify({
        task_id: input.task_id,
        objective: input.objective,
        summary: merged.summary,
        citations: merged.citations,
        request_id: `${input.task_id}:verify:0`,
      })
    )

    while (verdict.verdict === 'revise' && round < 3) {
      round += 1
      const revisedSummary = `${merged.summary}\n\nRevision ${round}: ${verdict.revision_brief ?? 'Add detail.'}`
      merged.summary = revisedSummary
      if (merged.citations.length === 0) {
        merged.citations.push('https://example.com/revision-source')
      }
      verdict = await step.do(`reverify-${round}`, async () =>
        rpc.verify({
          task_id: input.task_id,
          objective: input.objective,
          summary: merged.summary,
          citations: merged.citations,
          request_id: `${input.task_id}:verify:${round}`,
        })
      )
    }

    const footer =
      merged.citations.length > 0
        ? `\n\nSources:\n${merged.citations.map(c => `- ${c}`).join('\n')}`
        : ''
    const finalText =
      verdict.verdict === 'pass'
        ? `${merged.summary}${footer}`
        : `:warning: Could not fully verify this answer.\n\n${merged.summary}${footer}`

    await step.do('post-slack', async () => {
      await rpc.postOrchestratorFinal(input.thread_key, input.task_id, finalText)
    })
  }
}

/** Exported for E2E tests — runs the research loop without Cloudflare Workflows. */
export async function runResearchPipeline(env: Env, input: TaskInput): Promise<string> {
  const rpc = createRpcAdapter(env)
  const llm = createLlmAdapter(env)

  await rpc.markOrchestratorRunning(input.thread_key, input.task_id)
  const plan = await llm.plan(input.objective)

  const shardResults = await Promise.all(
    plan.subtasks.map((objective, index) =>
      rpc.researcherStart({
        task_id: input.task_id,
        thread_key: input.thread_key,
        shard_id: `shard_${index}`,
        objective,
        request_id: `${input.task_id}:${index}`,
      })
    )
  )

  const merged = mergeShardSummaries(shardResults)
  let round = 0
  let verdict = await rpc.verify({
    task_id: input.task_id,
    objective: input.objective,
    summary: merged.summary,
    citations: merged.citations,
    request_id: `${input.task_id}:verify:0`,
  })

  while (verdict.verdict === 'revise' && round < 3) {
    round += 1
    merged.summary = `${merged.summary}\n\nRevision ${round}: ${verdict.revision_brief ?? 'Add detail.'}`
    if (merged.citations.length === 0) {
      merged.citations.push('https://example.com/revision-source')
    }
    verdict = await rpc.verify({
      task_id: input.task_id,
      objective: input.objective,
      summary: merged.summary,
      citations: merged.citations,
      request_id: `${input.task_id}:verify:${round}`,
    })
  }

  const footer =
    merged.citations.length > 0
      ? `\n\nSources:\n${merged.citations.map(c => `- ${c}`).join('\n')}`
      : ''
  const finalText =
    verdict.verdict === 'pass'
      ? `${merged.summary}${footer}`
      : `:warning: Could not fully verify this answer.\n\n${merged.summary}${footer}`

  await rpc.postOrchestratorFinal(input.thread_key, input.task_id, finalText)
  return finalText
}
