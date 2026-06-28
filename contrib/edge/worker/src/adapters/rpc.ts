import type { ZodType } from 'zod'
import {
  ResearchStartInputSchema,
  ResearchStartResultSchema,
  VerifyInputSchema,
  VerifyResultSchema,
  type Env,
  type ResearchStartInput,
  type ResearchStartResult,
  type VerifyInput,
  type VerifyResult,
} from '../types'

async function postJson<T>(
  stub: DurableObjectStub,
  path: string,
  body: unknown,
  schema: ZodType<T>
): Promise<T> {
  const response = await stub.fetch(`http://do${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`RPC ${path} failed: ${response.status}`)
  }
  return schema.parse(await response.json())
}

export class RpcAdapter {
  constructor(private readonly env: Env) {}

  researcherId(taskId: string, shardId: string): DurableObjectId {
    return this.env.RESEARCHER.idFromName(`${taskId}:${shardId}`)
  }

  verifierId(taskId: string): DurableObjectId {
    return this.env.VERIFIER.idFromName(taskId)
  }

  orchestratorId(threadKey: string): DurableObjectId {
    return this.env.ORCHESTRATOR.idFromName(threadKey)
  }

  async researcherStart(input: ResearchStartInput): Promise<ResearchStartResult> {
    const stub = this.env.RESEARCHER.get(this.researcherId(input.task_id, input.shard_id))
    return postJson(stub, '/start', ResearchStartInputSchema.parse(input), ResearchStartResultSchema)
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const stub = this.env.VERIFIER.get(this.verifierId(input.task_id))
    return postJson(stub, '/verify', VerifyInputSchema.parse(input), VerifyResultSchema)
  }

  async markOrchestratorRunning(threadKey: string, taskId: string): Promise<void> {
    const stub = this.env.ORCHESTRATOR.get(this.orchestratorId(threadKey))
    const response = await stub.fetch(`http://do/tasks/${taskId}/running`, { method: 'POST' })
    if (!response.ok) {
      throw new Error(`mark running failed: ${response.status}`)
    }
  }

  async postOrchestratorFinal(threadKey: string, taskId: string, text: string): Promise<void> {
    const stub = this.env.ORCHESTRATOR.get(this.orchestratorId(threadKey))
    const response = await stub.fetch(`http://do/tasks/${taskId}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      throw new Error(`post final failed: ${response.status}`)
    }
  }
}

export function createRpcAdapter(env: Env): RpcAdapter {
  return new RpcAdapter(env)
}
