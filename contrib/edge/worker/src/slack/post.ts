import type { Env } from '../types'
import { logWarn } from '../lib/log'

export async function postSlackMessage(
  env: Env,
  input: {
    channelId: string
    threadTs: string
    text: string
  }
): Promise<void> {
  const token = env.SLACK_BOT_TOKEN
  if (!token) {
    logWarn({
      event: 'slack_post_skipped',
      msg: 'SLACK_BOT_TOKEN not configured',
      channel_id: input.channelId,
    })
    return
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: input.channelId,
      thread_ts: input.threadTs,
      text: input.text,
    }),
  })

  const body = (await response.json()) as { ok?: boolean; error?: string }
  if (!response.ok || !body.ok) {
    logWarn({
      event: 'slack_post_failed',
      channel_id: input.channelId,
      error: body.error ?? String(response.status),
    })
  }
}

export async function setAssistantStatus(
  env: Env,
  input: {
    channelId: string
    threadTs: string
    status: string
  }
): Promise<void> {
  const token = env.SLACK_BOT_TOKEN
  if (!token) return

  await fetch('https://slack.com/api/assistant.threads.setStatus', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      status: input.status,
    }),
  })
}
