import { describe, expect, it } from 'vitest'
import { RpcAdapter } from '../../worker/src/adapters/rpc'

describe('RpcAdapter', () => {
  it('derives stable DO ids from task and thread keys', () => {
    const env = {
      RESEARCHER: { idFromName: (name: string) => ({ toString: () => name }) },
      VERIFIER: { idFromName: (name: string) => ({ toString: () => name }) },
      ORCHESTRATOR: { idFromName: (name: string) => ({ toString: () => name }) },
    } as unknown as import('../../worker/src/types').Env

    const rpc = new RpcAdapter(env)
    expect(String(rpc.researcherId('task-1', 'shard_0'))).toBe('task-1:shard_0')
    expect(String(rpc.verifierId('task-1'))).toBe('task-1')
    expect(String(rpc.orchestratorId('slack:T:C:1'))).toBe('slack:T:C:1')
  })
})
