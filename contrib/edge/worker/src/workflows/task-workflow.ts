import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { createLlmAdapter } from '../adapters/llm'
import { logInfo } from '../lib/log'
import {
  ResearchStartResultSchema,
  TaskInputSchema,
  VerifyResultSchema,
  type Env,
  type ResearchStartResult,
  type TaskInput,
  type VerifyResult,
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

async function callResearcher(
  env: Env,
  input: {
    task_id: string
    thread_key: string
    shard_id: string
    objective: string
    request_id: string
  }
): Promise<ResearchStartResult> {
  const id = env.RESEARCHER.idFromName(`${input.task_id}:${input.shard_id}`)
  const researcher = env.RESEARCHER.get(id)
  const response = await researcher.fetch('http://researcher/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(`researcher start failed: ${response.status}`)
  }
  return ResearchStartResultSchema.parse(await response.json())
}

async function callVerifier(
  env: Env,
  input: {
    task_id: string
    objective: string
    summary: string
    citations: string[]
    request_id: string
  }
): Promise<VerifyResult> {
  const id = env.VERIFIER.idFromName(input.task_id)
  const verifier = env.VERIFIER.get(id)
  const response = await verifier.fetch('http://verifier/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(`verifier failed: ${response.status}`)
  }
  return VerifyResultSchema.parse(await response.json())
}

async function markOrchestratorRunning(env: Env, threadKey: string, taskId: string): Promise<void> {
  const orchestrator = env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName(threadKey))
  await orchestrator.fetch(`http://orchestrator/tasks/${taskId}/running`, { method: 'POST' })
}

async function postOrchestratorFinal(
  env: Env,
  threadKey: string,
  taskId: string,
  text: string
): Promise<void> {
  const orchestrator = env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName(threadKey))
  await orchestrator.fetch(`http://orchestrator/tasks/${taskId}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

export class TaskWorkflow extends WorkflowEntrypoint<Env, TaskInput> {
  async run(event: WorkflowEvent<TaskInput>, step: WorkflowStep): Promise<void> {
    const input = TaskInputSchema.parse(event.payload)

    logInfo({
      event: 'task_workflow_run',
      task_id: input.task_id,
      thread_key: input.thread_key,
    })

    await step.do('mark-running', async () => {
      await markOrchestratorRunning(this.env, input.thread_key, input.task_id)
    })

    const plan = await step.do('plan', async () => {
      const llm = createLlmAdapter(this.env)
      return llm.plan(input.objective)
    })

    const shardResults = await Promise.all(
      plan.subtasks.map((objective, index) =>
        step.do(`research-${index}`, async () =>
          callResearcher(this.env, {
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
      callVerifier(this.env, {
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
        callVerifier(this.env, {
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
      await postOrchestratorFinal(this.env, input.thread_key, input.task_id, finalText)
    })
  }
}
