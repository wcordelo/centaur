import { describe, expect, it } from 'bun:test'
import { buildQuickDeployCards, findQuickSiteUrls } from './quick-card'
import {
  parseQuickBlockAction,
  quickActionAckBody,
  quickActionPrompt,
  synthesizeQuickActionEnvelope
} from './quick-actions'

const DOMAIN = 'quick.internal'

describe('findQuickSiteUrls', () => {
  it('extracts site ids from quick urls and dedupes', () => {
    const text =
      'Deployed! https://my-dash.quick.internal and again <https://my-dash.quick.internal|here>, plus https://other-site.quick.internal/page.html'
    const refs = findQuickSiteUrls(text, DOMAIN)
    expect(refs.map(r => r.siteId)).toEqual(['my-dash', 'other-site'])
    expect(refs[0]?.url).toBe('https://my-dash.quick.internal')
  })

  it('ignores other domains and invalid labels', () => {
    expect(findQuickSiteUrls('see https://evil.quick.internal.attacker.com', DOMAIN)).toEqual([])
    expect(findQuickSiteUrls('see https://example.com/x', DOMAIN)).toEqual([])
  })
})

describe('buildQuickDeployCards', () => {
  it('builds a context + actions pair per site with three buttons', () => {
    const blocks = buildQuickDeployCards('live at https://demo.quick.internal', DOMAIN) as any[]
    expect(blocks).toHaveLength(2)
    const actions = blocks[1]
    expect(actions.type).toBe('actions')
    expect(actions.elements.map((e: any) => e.action_id)).toEqual([
      'quick_redeploy',
      'quick_files',
      'quick_delete'
    ])
    expect(JSON.parse(actions.elements[0].value)).toEqual({
      siteId: 'demo',
      url: 'https://demo.quick.internal'
    })
    expect(actions.elements[2].confirm).toBeDefined() // delete requires confirmation
  })

  it('returns no blocks when no quick url is present', () => {
    expect(buildQuickDeployCards('all done, no site here', DOMAIN)).toEqual([])
  })
})

function clickEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    trigger_id: '12345.67890.abc',
    user: { id: 'U_CLICKER' },
    team: { id: 'T1' },
    channel: { id: 'C1' },
    message: { ts: '1718000000.000100', thread_ts: '1717999999.000001' },
    response_url: 'https://hooks.slack.test/respond',
    actions: [
      {
        action_id: 'quick_delete',
        value: JSON.stringify({ siteId: 'demo', url: 'https://demo.quick.internal' })
      }
    ],
    ...overrides
  }
}

describe('parseQuickBlockAction', () => {
  it('parses a delete click with thread context', () => {
    const action = parseQuickBlockAction(clickEnvelope())
    expect(action).not.toBeNull()
    expect(action?.kind).toBe('delete')
    expect(action?.ref.siteId).toBe('demo')
    expect(action?.userId).toBe('U_CLICKER')
    expect(action?.threadTs).toBe('1717999999.000001')
  })

  it('ignores non-quick actions and malformed values', () => {
    expect(
      parseQuickBlockAction(clickEnvelope({ actions: [{ action_id: 'other_thing', value: '{}' }] }))
    ).toBeNull()
    expect(
      parseQuickBlockAction(clickEnvelope({ actions: [{ action_id: 'quick_delete', value: 'not-json' }] }))
    ).toBeNull()
    expect(parseQuickBlockAction({ type: 'view_submission' })).toBeNull()
  })

  it('falls back to message ts as thread root for top-level messages', () => {
    const action = parseQuickBlockAction(
      clickEnvelope({ message: { ts: '1718000000.000100' } })
    )
    expect(action?.threadTs).toBe('1718000000.000100')
  })
})

describe('synthesized agent turn', () => {
  it('creates an app_mention envelope attributed to the clicking user', () => {
    const action = parseQuickBlockAction(clickEnvelope())!
    const envelope = synthesizeQuickActionEnvelope(action, '12345.67890.abc')
    expect(envelope.type).toBe('event_callback')
    expect(envelope.event_id).toBe('QuickAction-12345.67890.abc')
    expect(envelope.event.type).toBe('app_mention')
    expect(envelope.event.user).toBe('U_CLICKER')
    expect(envelope.event.thread_ts).toBe('1717999999.000001')
    expect(envelope.event.text).toContain('delete_site')
    expect(envelope.event.text).toContain('`demo`')
  })

  it('prompts reference the right tool per action kind', () => {
    const base = parseQuickBlockAction(clickEnvelope())!
    expect(quickActionPrompt({ ...base, kind: 'redeploy' })).toContain('deploy_artifact')
    expect(quickActionPrompt({ ...base, kind: 'files' })).toContain('get_site')
  })

  it('ack body is ephemeral and does not replace the card', () => {
    const action = parseQuickBlockAction(clickEnvelope())!
    const ack = quickActionAckBody(action)
    expect(ack.response_type).toBe('ephemeral')
    expect(ack.replace_original).toBe(false)
  })
})
