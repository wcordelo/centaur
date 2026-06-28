import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { extractObjective, verifySlackRequest } from '../worker/src/slack/verify'

const SIGNING_SECRET = 'test-signing-secret'

function signedBody(body: string, timestamp = Math.floor(Date.now() / 1000)): {
  rawBody: string
  timestampHeader: string
  signatureHeader: string
} {
  const signature = createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')
  return {
    rawBody: body,
    timestampHeader: String(timestamp),
    signatureHeader: `v0=${signature}`,
  }
}

describe('verifySlackRequest', () => {
  it('accepts valid signatures', async () => {
    const body = JSON.stringify({ type: 'event_callback', event_id: 'E1' })
    const signed = signedBody(body)
    const result = await verifySlackRequest({
      signingSecret: SIGNING_SECRET,
      rawBody: signed.rawBody,
      timestampHeader: signed.timestampHeader,
      signatureHeader: signed.signatureHeader,
      nowSec: Number.parseInt(signed.timestampHeader, 10),
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects stale timestamps', async () => {
    const body = JSON.stringify({ type: 'event_callback' })
    const staleTs = Math.floor(Date.now() / 1000) - 600
    const signed = signedBody(body, staleTs)
    const result = await verifySlackRequest({
      signingSecret: SIGNING_SECRET,
      rawBody: signed.rawBody,
      timestampHeader: signed.timestampHeader,
      signatureHeader: signed.signatureHeader,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('stale_timestamp')
    }
  })

  it('rejects invalid signatures', async () => {
    const body = JSON.stringify({ type: 'event_callback' })
    const signed = signedBody(body)
    const result = await verifySlackRequest({
      signingSecret: SIGNING_SECRET,
      rawBody: signed.rawBody,
      timestampHeader: signed.timestampHeader,
      signatureHeader: 'v0=deadbeef',
      nowSec: Number.parseInt(signed.timestampHeader, 10),
    })
    expect(result.ok).toBe(false)
  })
})

describe('extractObjective', () => {
  it('strips bot mention prefix', () => {
    expect(extractObjective('<@U123> summarize Q1 revenue', 'U123')).toBe('summarize Q1 revenue')
  })
})
