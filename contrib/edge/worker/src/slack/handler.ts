import {
  parseAllowlist,
  SlackEventEnvelopeSchema,
  SlackQueueMessageSchema,
  slackThreadKey,
  type Env,
  type SlackQueueMessage,
} from '../types'
import { extractObjective, verifySlackRequest } from './verify'
import { logInfo, logWarn } from '../lib/log'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function isAllowedSlackEvent(
  env: Env,
  channelId: string | undefined,
  userId: string | undefined
): boolean {
  const allowedChannels = parseAllowlist(env.SLACK_ALLOWED_CHANNEL_IDS)
  if (allowedChannels && channelId && !allowedChannels.has(channelId)) {
    return false
  }

  const allowedUsers = parseAllowlist(env.SLACK_ALLOWED_USER_IDS)
  if (allowedUsers && userId && !allowedUsers.has(userId)) {
    return false
  }

  return true
}

export function buildQueueMessage(
  envelope: ReturnType<typeof SlackEventEnvelopeSchema.parse>
): SlackQueueMessage | null {
  if (envelope.type !== 'event_callback' || !envelope.event || !envelope.event_id) {
    return null
  }

  const event = envelope.event
  const eventType = stringField(event.type)
  if (eventType !== 'app_mention' && eventType !== 'message') {
    return null
  }

  const channelId = stringField(event.channel)
  const text = stringField(event.text)
  const ts = stringField(event.ts)
  const threadTs = stringField(event.thread_ts) ?? ts
  const userId = stringField(event.user)
  const teamId = envelope.team_id

  if (!channelId || !text || !threadTs || !teamId) {
    return null
  }

  if (eventType === 'message') {
    const subtype = stringField(event.subtype)
    if (subtype === 'bot_message' || event.bot_id) {
      return null
    }
  }

  const threadKey = slackThreadKey(teamId, channelId, threadTs)
  const objective = extractObjective(text)

  return SlackQueueMessageSchema.parse({
    event_id: envelope.event_id,
    team_id: teamId,
    thread_key: threadKey,
    objective,
    channel_id: channelId,
    thread_ts: threadTs,
    user_id: userId,
    event_ts: ts ?? threadTs,
    enqueued_at: new Date().toISOString(),
  })
}

export async function handleSlackWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text()

  const verify = await verifySlackRequest({
    signingSecret: env.SLACK_SIGNING_SECRET,
    rawBody,
    timestampHeader: request.headers.get('x-slack-request-timestamp'),
    signatureHeader: request.headers.get('x-slack-signature'),
  })

  if (!verify.ok) {
    logWarn({ event: 'slack_verify_failed', reason: verify.reason })
    return new Response('invalid request', { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new Response('invalid json', { status: 400 })
  }

  if (isRecord(payload) && payload.type === 'url_verification') {
    const challenge = stringField(payload.challenge)
    if (!challenge) {
      return new Response('missing challenge', { status: 400 })
    }
    return Response.json({ challenge })
  }

  const envelope = SlackEventEnvelopeSchema.safeParse(payload)
  if (!envelope.success) {
    return new Response('ignored', { status: 200 })
  }

  const queueMessage = buildQueueMessage(envelope.data)
  if (!queueMessage) {
    return new Response('ignored', { status: 200 })
  }

  if (!isAllowedSlackEvent(env, queueMessage.channel_id, queueMessage.user_id)) {
    logInfo({
      event: 'slack_event_denied',
      thread_key: queueMessage.thread_key,
      channel_id: queueMessage.channel_id,
    })
    return new Response('ignored', { status: 200 })
  }

  await env.SLACK_EVENTS.send(queueMessage)

  logInfo({
    event: 'slack_event_enqueued',
    thread_key: queueMessage.thread_key,
    request_id: queueMessage.event_id,
  })

  return new Response('ok', { status: 200 })
}
