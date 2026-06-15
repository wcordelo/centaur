/**
 * Quick button-click handling.
 *
 * Rather than building a parallel "Quick API" path from the slackbot to the
 * deploy backend, button clicks are converted into ordinary agent turns in the
 * originating thread: the click is turned into a synthetic in-thread message
 * authored by the clicking user and fed through the same session pipeline as a
 * typed message. That reuses every existing guarantee — dedup, requester
 * identity, sandbox tool execution — and means the Quick tool's ownership check
 * applies to the *clicking* user, not the bot.
 */

import { QUICK_ACTION_PREFIX, type QuickActionKind, type QuickSiteRef } from './quick-card'

export interface QuickAction {
  kind: QuickActionKind
  ref: QuickSiteRef
}

const PROMPTS: Record<QuickActionKind, (ref: QuickSiteRef) => string> = {
  redeploy: ref =>
    `Re-generate the Quick site \`${ref.siteId}\` (${ref.url}). Rebuild the artifact with the same intent as the original request in this thread, improving on any feedback above, and deploy it with deploy_artifact using the same site_id.`,
  files: ref =>
    `Show the current file listing and metadata for the Quick site \`${ref.siteId}\` using get_site, and summarize it briefly.`,
  delete: ref =>
    `Delete the Quick site \`${ref.siteId}\` (${ref.url}) using delete_site, then confirm what was removed.`
}

function isQuickKind(value: string): value is QuickActionKind {
  return value === 'redeploy' || value === 'files' || value === 'delete'
}

/** Map a chat-SDK action id back to its Quick action kind, or null. */
export function parseQuickActionKind(actionId: string): QuickActionKind | null {
  if (!actionId.startsWith(QUICK_ACTION_PREFIX)) return null
  const kind = actionId.slice(QUICK_ACTION_PREFIX.length)
  return isQuickKind(kind) ? kind : null
}

/** Decode the site ref carried in a Quick button's `value` payload, or null. */
export function parseQuickSiteRef(value: string | undefined): QuickSiteRef | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(value) as { siteId?: unknown; url?: unknown }
    if (typeof parsed.siteId !== 'string' || typeof parsed.url !== 'string') return null
    return { siteId: parsed.siteId, url: parsed.url }
  } catch {
    return null
  }
}

/** Parse a chat-SDK action (id + value) into a QuickAction, or null. */
export function parseQuickAction(actionId: string, value: string | undefined): QuickAction | null {
  const kind = parseQuickActionKind(actionId)
  if (!kind) return null
  const ref = parseQuickSiteRef(value)
  if (!ref) return null
  return { kind, ref }
}

/** The natural-language instruction the agent receives for this click. */
export function quickActionPrompt(action: QuickAction): string {
  return PROMPTS[action.kind](action.ref)
}
