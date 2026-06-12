/**
 * Quick button-click handling.
 *
 * Rather than building a parallel "Quick API" path from the slackbot to the
 * deploy backend, button clicks are converted into ordinary agent turns in the
 * originating thread: a synthetic app_mention envelope is fed through the same
 * processSlackEvent pipeline as a typed message. That reuses every existing
 * guarantee — auth/allowlists, dedup, requester-identity injection, sandbox
 * tool execution — and means the Quick tool's ownership check applies to the
 * *clicking* user, not the bot.
 */

import { QUICK_ACTION_PREFIX, type QuickActionKind, type QuickSiteRef } from './quick-card'

export interface QuickBlockAction {
  kind: QuickActionKind
  ref: QuickSiteRef
  userId: string
  channelId: string
  threadTs: string
  teamId?: string
  responseUrl?: string
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

/** Parse a Slack block_actions envelope into a QuickBlockAction, or null. */
export function parseQuickBlockAction(envelope: any): QuickBlockAction | null {
  if (envelope?.type !== 'block_actions') return null
  const action = Array.isArray(envelope.actions) ? envelope.actions[0] : undefined
  const actionId: string = typeof action?.action_id === 'string' ? action.action_id : ''
  if (!actionId.startsWith(QUICK_ACTION_PREFIX)) return null
  const kind = actionId.slice(QUICK_ACTION_PREFIX.length)
  if (!isQuickKind(kind)) return null

  let ref: QuickSiteRef
  try {
    const parsed = JSON.parse(typeof action?.value === 'string' ? action.value : '')
    if (typeof parsed?.siteId !== 'string' || typeof parsed?.url !== 'string') return null
    ref = { siteId: parsed.siteId, url: parsed.url }
  } catch {
    return null
  }

  const userId = envelope.user?.id
  const channelId = envelope.channel?.id ?? envelope.container?.channel_id
  const threadTs =
    envelope.message?.thread_ts ?? envelope.container?.thread_ts ?? envelope.message?.ts
  if (typeof userId !== 'string' || typeof channelId !== 'string' || typeof threadTs !== 'string') {
    return null
  }
  return {
    kind,
    ref,
    userId,
    channelId,
    threadTs,
    teamId: envelope.team?.id,
    responseUrl: typeof envelope.response_url === 'string' ? envelope.response_url : undefined
  }
}

/** The natural-language instruction the agent receives for this click. */
export function quickActionPrompt(action: QuickBlockAction): string {
  return PROMPTS[action.kind](action.ref)
}

/**
 * Synthesize an event_callback envelope equivalent to the clicking user
 * mentioning the bot in-thread with the action prompt. event_id/ts are derived
 * from the click trigger so dedup treats repeat deliveries as duplicates.
 */
export function synthesizeQuickActionEnvelope(action: QuickBlockAction, triggerId: string): any {
  const ts = `${Math.floor(Date.now() / 1000)}.${triggerId.replace(/\D/g, '').slice(0, 6).padEnd(6, '0')}`
  return {
    type: 'event_callback',
    event_id: `QuickAction-${triggerId}`,
    team_id: action.teamId,
    event: {
      type: 'app_mention',
      user: action.userId,
      text: quickActionPrompt(action),
      channel: action.channelId,
      ts,
      thread_ts: action.threadTs,
      event_ts: ts
    }
  }
}

/** Ephemeral acknowledgement posted via response_url while the agent works. */
export function quickActionAckBody(action: QuickBlockAction): Record<string, unknown> {
  const verbs: Record<QuickActionKind, string> = {
    redeploy: `:arrows_counterclockwise: Re-generating *${action.ref.siteId}* — follow along in this thread.`,
    files: `:open_file_folder: Fetching the file listing for *${action.ref.siteId}*…`,
    delete: `:wastebasket: Deleting *${action.ref.siteId}* — the agent will confirm in this thread.`
  }
  return { response_type: 'ephemeral', replace_original: false, text: verbs[action.kind] }
}
