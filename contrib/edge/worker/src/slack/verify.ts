const MAX_TIMESTAMP_SKEW_SEC = 60 * 5

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface VerifySlackRequestInput {
  signingSecret: string
  rawBody: string
  timestampHeader: string | null
  signatureHeader: string | null
  nowSec?: number
}

export type VerifySlackResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'invalid_signature' }

export async function verifySlackRequest(input: VerifySlackRequestInput): Promise<VerifySlackResult> {
  const { signingSecret, rawBody, timestampHeader, signatureHeader } = input
  if (!timestampHeader || !signatureHeader) {
    return { ok: false, reason: 'missing_headers' }
  }

  const timestamp = Number.parseInt(timestampHeader, 10)
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - timestamp) > MAX_TIMESTAMP_SKEW_SEC) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  const base = `v0:${timestamp}:${rawBody}`
  const digest = await hmacSha256(signingSecret, base)
  const expected = `v0=${digest}`
  if (!timingSafeEqual(expected, signatureHeader)) {
    return { ok: false, reason: 'invalid_signature' }
  }

  return { ok: true }
}

export function extractObjective(text: string, botUserId?: string): string {
  const withoutMention = botUserId
    ? text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim()
    : text.replace(/<@[A-Z0-9]+>\s*/g, '').trim()
  return withoutMention || text.trim()
}
