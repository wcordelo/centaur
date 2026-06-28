import type { Env } from '../types'

export interface LlmPlanResult {
  subtasks: string[]
}

export interface LlmAdapter {
  plan(objective: string): Promise<LlmPlanResult>
  summarize(text: string): Promise<string>
}

export class MockLlmAdapter implements LlmAdapter {
  async plan(objective: string): Promise<LlmPlanResult> {
    return {
      subtasks: [
        `Research background for: ${objective.slice(0, 120)}`,
        `Find primary sources for: ${objective.slice(0, 120)}`,
      ],
    }
  }

  async summarize(text: string): Promise<string> {
    return `Mock summary: ${text.slice(0, 200)}`
  }
}

export class LiveLlmAdapter implements LlmAdapter {
  constructor(private readonly env: Env) {}

  async plan(objective: string): Promise<LlmPlanResult> {
    const prompt = `Break this research objective into at most 3 subtasks as JSON {"subtasks":["..."]}: ${objective}`
    const response = await this.chat(prompt)
    try {
      const parsed = JSON.parse(response) as { subtasks?: string[] }
      if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
        return { subtasks: parsed.subtasks.slice(0, 3) }
      }
    } catch {
      // fall through
    }
    return { subtasks: [objective] }
  }

  async summarize(text: string): Promise<string> {
    return this.chat(`Summarize concisely:\n\n${text.slice(0, 8000)}`)
  }

  private async chat(prompt: string): Promise<string> {
    const gateway = this.env.AI_GATEWAY_URL
    const anthropicKey = this.env.ANTHROPIC_API_KEY
    if (!gateway || !anthropicKey) {
      throw new Error('AI_GATEWAY_URL and ANTHROPIC_API_KEY required for live LLM mode')
    }

    const response = await fetch(`${gateway}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status}`)
    }

    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = body.content?.find(part => part.type === 'text')?.text
    if (!text) {
      throw new Error('LLM response missing text content')
    }
    return text
  }
}

export function createLlmAdapter(env: Env): LlmAdapter {
  if (env.LLM_MODE === 'mock') {
    return new MockLlmAdapter()
  }
  return new LiveLlmAdapter(env)
}
