/**
 * Quick deploy card — decorates final agent messages that contain a Quick site
 * URL (https://<site-id>.<QUICK_BASE_DOMAIN>) with an interactive card:
 *
 *   [ Re-generate ]  [ View files ]  [ Delete site ]
 *
 * Button clicks arrive as chat-SDK action events (see quick-actions.ts) and are
 * converted into ordinary agent turns in the same thread, so they inherit the
 * clicking user's requester identity — which is exactly what the Quick tool's
 * ownership check (QUICK_REQUESTER) keys on.
 */

import type { CardChild, CardElement } from 'chat'

export const QUICK_ACTION_PREFIX = 'quick_'

export type QuickActionKind = 'redeploy' | 'files' | 'delete'

export interface QuickSiteRef {
  siteId: string
  url: string
}

/** DNS label: 1-63 chars, lowercase alphanumerics, internal hyphens. */
const SITE_ID = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'

/** Slack Block Kit caps messages at 50 blocks; each Quick site uses section + actions. */
const SLACK_BLOCK_LIMIT = 50
const BLOCKS_PER_QUICK_SITE = 2
export const MAX_QUICK_CARD_SITES = Math.floor(SLACK_BLOCK_LIMIT / BLOCKS_PER_QUICK_SITE)

/** The chat-SDK action id a Quick button click is routed to. */
export function quickActionId(kind: QuickActionKind): string {
  return `${QUICK_ACTION_PREFIX}${kind}`
}

export function findQuickSiteUrls(text: string, baseDomain: string): QuickSiteRef[] {
  if (!text || !baseDomain) return []
  const domain = baseDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`https://(${SITE_ID})\\.${domain}(?![A-Za-z0-9.-])(?:/[^\\s<>|]*)?`, 'g')
  const seen = new Set<string>()
  const refs: QuickSiteRef[] = []
  for (const match of text.matchAll(re)) {
    const siteId = match[1]
    if (!siteId || seen.has(siteId)) continue
    seen.add(siteId)
    refs.push({ siteId, url: `https://${siteId}.${baseDomain}` })
  }
  return refs
}

/**
 * Build an interactive deploy card for every Quick site referenced in `text`,
 * or null if the message contains none. The site ref is carried in each
 * button's `value` so the action handler knows which site to act on.
 */
export function buildQuickDeployCard(text: string, baseDomain: string): CardElement | null {
  const refs = findQuickSiteUrls(text, baseDomain)
  return buildQuickDeployCardFromRefs(refs)
}

/** Build a deploy card for an explicit list of site refs (used for deduped posts). */
export function buildQuickDeployCardFromRefs(refs: QuickSiteRef[]): CardElement | null {
  if (refs.length === 0) return null

  const shown = refs.slice(0, MAX_QUICK_CARD_SITES)
  const omitted = refs.length - shown.length
  const children: CardChild[] = []
  for (const ref of shown) {
    const value = JSON.stringify(ref)
    children.push(
      {
        type: 'section',
        children: [{ type: 'text', content: `:zap: Quick site *${ref.siteId}* — <${ref.url}|open>` }]
      },
      {
        type: 'actions',
        children: [
          { type: 'button', id: quickActionId('redeploy'), label: 'Re-generate', value },
          { type: 'button', id: quickActionId('files'), label: 'View files', value },
          { type: 'button', id: quickActionId('delete'), label: 'Delete site', style: 'danger', value }
        ]
      }
    )
  }
  if (omitted > 0) {
    children.push({
      type: 'section',
      children: [{
        type: 'text',
        content: `_…and ${omitted} more Quick site${omitted === 1 ? '' : 's'} not shown (Slack block limit)._`
      }]
    })
  }
  return { type: 'card', children }
}
