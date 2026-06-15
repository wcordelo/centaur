import { describe, expect, it } from 'bun:test'
import type { ButtonElement, CardElement } from 'chat'
import {
  buildQuickDeployCard,
  buildQuickDeployCardFromRefs,
  findQuickSiteUrls,
  MAX_QUICK_CARD_SITES,
  quickActionId
} from '../src/quick-card'
import { parseQuickAction, parseQuickActionKind, quickActionPrompt } from '../src/quick-actions'

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
    expect(findQuickSiteUrls('all done, no site here', DOMAIN)).toEqual([])
  })

  it('returns nothing without text or base domain', () => {
    expect(findQuickSiteUrls('', DOMAIN)).toEqual([])
    expect(findQuickSiteUrls('https://demo.quick.internal', '')).toEqual([])
  })
})

describe('buildQuickDeployCard', () => {
  it('builds a section + actions pair per site with three buttons', () => {
    const card = buildQuickDeployCard('live at https://demo.quick.internal', DOMAIN)
    expect(card).not.toBeNull()
    const children = (card as CardElement).children
    expect(children).toHaveLength(2)

    const section = children[0]
    expect(section?.type).toBe('section')

    const actions = children[1]
    expect(actions?.type).toBe('actions')
    if (actions?.type !== 'actions') throw new Error('expected actions block')
    const buttons = actions.children as ButtonElement[]
    expect(buttons.map(button => button.id)).toEqual([
      'quick_redeploy',
      'quick_files',
      'quick_delete'
    ])
    expect(JSON.parse(buttons[0]!.value!)).toEqual({
      siteId: 'demo',
      url: 'https://demo.quick.internal'
    })
    expect(buttons[2]?.style).toBe('danger')
  })

  it('builds one pair per distinct site', () => {
    const card = buildQuickDeployCard(
      'https://one.quick.internal and https://two.quick.internal',
      DOMAIN
    )
    expect((card as CardElement).children).toHaveLength(4)
  })

  it('returns null when no quick url is present', () => {
    expect(buildQuickDeployCard('all done, no site here', DOMAIN)).toBeNull()
    expect(buildQuickDeployCardFromRefs([])).toBeNull()
  })

  it('buildQuickDeployCardFromRefs accepts explicit refs', () => {
    const card = buildQuickDeployCardFromRefs([
      { siteId: 'demo', url: 'https://demo.quick.internal' }
    ])
    expect((card as CardElement).children).toHaveLength(2)
  })

  it('caps sites at the Slack block limit and notes omissions', () => {
    const sites = Array.from(
      { length: MAX_QUICK_CARD_SITES + 3 },
      (_, index) => `https://site-${index}.${DOMAIN}`
    )
    const card = buildQuickDeployCard(sites.join(' '), DOMAIN)
    expect(card).not.toBeNull()
    const children = (card as CardElement).children
    expect(children).toHaveLength(MAX_QUICK_CARD_SITES * 2 + 1)
    const last = children[children.length - 1]
    expect(last?.type).toBe('section')
    if (last?.type !== 'section') throw new Error('expected trailing section')
    const text = last.children[0]
    expect(text?.type).toBe('text')
    if (text?.type !== 'text') throw new Error('expected text child')
    expect(text.content).toContain('3 more Quick sites')
  })
})

describe('quickActionId', () => {
  it('prefixes the action kind', () => {
    expect(quickActionId('redeploy')).toBe('quick_redeploy')
    expect(quickActionId('files')).toBe('quick_files')
    expect(quickActionId('delete')).toBe('quick_delete')
  })
})

describe('parseQuickAction', () => {
  const value = JSON.stringify({ siteId: 'demo', url: 'https://demo.quick.internal' })

  it('parses a valid quick action', () => {
    const action = parseQuickAction('quick_delete', value)
    expect(action).not.toBeNull()
    expect(action?.kind).toBe('delete')
    expect(action?.ref).toEqual({ siteId: 'demo', url: 'https://demo.quick.internal' })
  })

  it('ignores non-quick action ids', () => {
    expect(parseQuickActionKind('other_thing')).toBeNull()
    expect(parseQuickAction('other_thing', value)).toBeNull()
  })

  it('ignores unknown quick kinds', () => {
    expect(parseQuickActionKind('quick_explode')).toBeNull()
    expect(parseQuickAction('quick_explode', value)).toBeNull()
  })

  it('rejects malformed or missing values', () => {
    expect(parseQuickAction('quick_delete', 'not-json')).toBeNull()
    expect(parseQuickAction('quick_delete', undefined)).toBeNull()
    expect(parseQuickAction('quick_delete', JSON.stringify({ siteId: 'demo' }))).toBeNull()
  })
})

describe('quickActionPrompt', () => {
  const ref = { siteId: 'demo', url: 'https://demo.quick.internal' }

  it('references the right tool per action kind', () => {
    expect(quickActionPrompt({ kind: 'redeploy', ref })).toContain('deploy_artifact')
    expect(quickActionPrompt({ kind: 'files', ref })).toContain('get_site')
    expect(quickActionPrompt({ kind: 'delete', ref })).toContain('delete_site')
  })

  it('mentions the site id', () => {
    expect(quickActionPrompt({ kind: 'delete', ref })).toContain('demo')
  })
})
