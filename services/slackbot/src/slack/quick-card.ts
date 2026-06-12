/**
 * Quick deploy card — decorates final agent messages that contain a Quick
 * site URL (https://<site-id>.<QUICK_BASE_DOMAIN>) with an interactive card:
 *
 *   [ Re-generate ]  [ View files ]  [ Delete site ]
 *
 * Button clicks arrive as block_actions payloads (see quick-actions.ts) and
 * are converted into ordinary agent turns in the same thread, so they inherit
 * the clicking user's requester identity — which is exactly what the Quick
 * tool's ownership check (QUICK_REQUESTER) keys on.
 */

export const QUICK_ACTION_PREFIX = 'quick_'
export const QUICK_ACTIONS_BLOCK_ID = 'quick_deploy_card'

export type QuickActionKind = 'redeploy' | 'files' | 'delete'

export interface QuickSiteRef {
  siteId: string
  url: string
}

/** DNS label: 1-63 chars, lowercase alphanumerics, internal hyphens. */
const SITE_ID = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'

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

function button(kind: QuickActionKind, label: string, ref: QuickSiteRef, style?: 'danger') {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label, emoji: true },
    action_id: `${QUICK_ACTION_PREFIX}${kind}`,
    value: JSON.stringify(ref),
    ...(style ? { style } : {}),
    ...(style === 'danger'
      ? {
          confirm: {
            title: { type: 'plain_text', text: 'Delete this site?' },
            text: {
              type: 'mrkdwn',
              text: `*${ref.siteId}* and all of its files will be removed. This cannot be undone.`
            },
            confirm: { type: 'plain_text', text: 'Delete' },
            deny: { type: 'plain_text', text: 'Cancel' }
          }
        }
      : {})
  }
}

/** One context + actions block pair per deployed site found in the message. */
export function buildQuickDeployCards(text: string, baseDomain: string): unknown[] {
  const blocks: unknown[] = []
  for (const ref of findQuickSiteUrls(text, baseDomain)) {
    blocks.push(
      {
        type: 'context',
        block_id: `${QUICK_ACTIONS_BLOCK_ID}_ctx_${ref.siteId}`,
        elements: [{ type: 'mrkdwn', text: `:zap: Quick site *${ref.siteId}* — <${ref.url}|open>` }]
      },
      {
        type: 'actions',
        block_id: `${QUICK_ACTIONS_BLOCK_ID}_${ref.siteId}`,
        elements: [
          button('redeploy', ':arrows_counterclockwise: Re-generate', ref),
          button('files', ':open_file_folder: View files', ref),
          button('delete', ':wastebasket: Delete site', ref, 'danger')
        ]
      }
    )
  }
  return blocks
}
