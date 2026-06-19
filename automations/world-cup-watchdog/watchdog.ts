/**
 * World Cup webhook watchdog — core logic.
 *
 * This module is the brain of a backup/verification loop for the main
 * "World Cup match alerts" webhook trigger. It is designed to be driven by a
 * scheduled (cron) Devin automation that, on every run:
 *
 *   1. Calls the `2026-world-cup__get_live_matches` MCP tool and saves the raw
 *      result to a JSON file.
 *   2. Looks up the main webhook automation (ingest trigger) via the Devin API
 *      to learn whether it is still enabled and when it last fired.
 *   3. Runs this watchdog, passing the live-matches file, the webhook
 *      enabled/last-event info, and a persistent state file.
 *   4. Reads the watchdog's structured output and notifies the user when alerts
 *      are present.
 *
 * The watchdog itself is pure and side-effect free (except the CLI wrapper in
 * `cli.ts`), so the alerting logic is fully unit-testable.
 */

export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "LIVE",
  "IN_PLAY",
  "INPLAY",
  "IN-PLAY",
  "PLAYING",
  "HALF_TIME",
  "HALFTIME",
  "HALF-TIME",
  "HT",
  "FIRST_HALF",
  "SECOND_HALF",
  "EXTRA_TIME",
  "PENALTIES",
  "PENALTY_SHOOTOUT",
  "PAUSED",
  "BREAK_TIME",
  "INTERRUPTED",
]);

export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "FINISHED",
  "FULL_TIME",
  "FULLTIME",
  "FT",
  "ENDED",
  "COMPLETED",
  "AET",
  "AFTER_EXTRA_TIME",
  "AWARDED",
  "CANCELLED",
  "CANCELED",
  "POSTPONED",
  "ABANDONED",
  "SUSPENDED",
  "NOT_STARTED",
  "SCHEDULED",
  "TIMED",
  "UPCOMING",
]);

export type AlertSeverity = "critical" | "warning" | "info";

export type AlertKind =
  | "webhook_disabled"
  | "webhook_status_unknown"
  | "webhook_never_fired"
  | "webhook_silence_live_match"
  | "match_went_silent";

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  /** Affected match ids, when the alert is about specific matches. */
  matchIds?: string[];
}

export interface NormalizedMatch {
  matchId: string;
  /** Normalized, upper-cased status string. */
  status: string;
  isLive: boolean;
  /** Human readable score, e.g. "1-0". Empty string when unknown. */
  score: string;
  minute: number | null;
  homeTeam: string | null;
  awayTeam: string | null;
  /** Last-update timestamp reported by the API (ISO), if any. */
  apiLastUpdateAt: string | null;
}

export interface MatchState {
  matchId: string;
  status: string;
  score: string;
  minute: number | null;
  homeTeam: string | null;
  awayTeam: string | null;
  apiLastUpdateAt: string | null;
  /** Last poll time (ISO) at which we observed a change for this match. */
  lastProgressAt: string;
  /** Last poll time (ISO) at which this match was live. */
  lastSeenLiveAt: string;
  firstSeenAt: string;
  /** Whether a "went silent" alert was already emitted (dedupe). */
  silenceAlerted: boolean;
}

export interface WebhookState {
  triggerId: string | null;
  lastEventAt: string | null;
  enabled: boolean | null;
  /** Whether a health alert (disabled) was already emitted (dedupe). */
  healthAlerted: boolean;
}

export interface WatchdogState {
  version: number;
  updatedAt: string;
  webhook: WebhookState;
  matches: Record<string, MatchState>;
}

export interface WebhookInfo {
  triggerId: string | null;
  /** ISO timestamp of the most recent webhook event/invocation, or null. */
  lastEventAt: string | null;
  /** true=enabled, false=paused/disabled, null=unknown. */
  enabled: boolean | null;
}

export interface WatchdogConfig {
  /**
   * Max time a match may be live with no recent webhook event before we treat
   * the webhook as failed. Default 12 minutes.
   */
  webhookSilenceMs: number;
  /**
   * Max time a live match may show no progress (score/status/minute/update
   * timestamp unchanged) before we flag it as silent. Default 15 minutes.
   */
  matchStallMs: number;
}

export const DEFAULT_CONFIG: WatchdogConfig = {
  webhookSilenceMs: 12 * 60 * 1000,
  matchStallMs: 15 * 60 * 1000,
};

export const STATE_VERSION = 1;

export interface EvaluateParams {
  now: Date;
  prevState: WatchdogState;
  liveMatches: NormalizedMatch[];
  webhook: WebhookInfo;
  config?: Partial<WatchdogConfig>;
}

export interface EvaluationResult {
  alerts: Alert[];
  nextState: WatchdogState;
  summary: {
    now: string;
    liveMatchCount: number;
    webhookLastEventAt: string | null;
    webhookAgeMs: number | null;
    webhookEnabled: boolean | null;
    alertCount: number;
  };
}

export function emptyState(): WatchdogState {
  return {
    version: STATE_VERSION,
    updatedAt: new Date(0).toISOString(),
    webhook: {
      triggerId: null,
      lastEventAt: null,
      enabled: null,
      healthAlerted: false,
    },
    matches: {},
  };
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstDefined(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function normalizeStatus(raw: unknown): string {
  const s = asString(raw);
  if (!s) return "UNKNOWN";
  return s.trim().toUpperCase().replace(/\s+/g, "_");
}

function normalizeIso(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    // Treat as epoch millis (or seconds when clearly too small).
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = asString(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function deriveScore(record: Record<string, unknown>): string {
  const direct = firstDefined(record, ["score", "scoreline", "result"]);
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const home = firstDefined(record, [
    "home_score",
    "homeScore",
    "homeGoals",
    "home_goals",
    "goalsHome",
  ]);
  const away = firstDefined(record, [
    "away_score",
    "awayScore",
    "awayGoals",
    "away_goals",
    "goalsAway",
  ]);
  const h = asString(home);
  const a = asString(away);
  if (h !== null && a !== null) return `${h}-${a}`;

  // Nested score object, e.g. { score: { home: 1, away: 0 } }.
  if (direct && typeof direct === "object") {
    const obj = direct as Record<string, unknown>;
    const nh = asString(firstDefined(obj, ["home", "homeScore", "h"]));
    const na = asString(firstDefined(obj, ["away", "awayScore", "a"]));
    if (nh !== null && na !== null) return `${nh}-${na}`;
  }
  return "";
}

export function normalizeMatch(
  raw: unknown,
  index: number,
): NormalizedMatch | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const idRaw = firstDefined(record, [
    "match_id",
    "matchId",
    "id",
    "fixture_id",
    "fixtureId",
    "gameId",
    "game_id",
  ]);
  const matchId = asString(idRaw) ?? `unknown-${index}`;

  const status = normalizeStatus(
    firstDefined(record, ["status", "state", "matchStatus", "match_status", "phase"]),
  );

  const explicitLive = firstDefined(record, ["is_live", "isLive", "live"]);
  const isLive =
    explicitLive === true ||
    explicitLive === "true" ||
    (explicitLive === undefined && LIVE_STATUSES.has(status));

  const minuteRaw = firstDefined(record, ["minute", "elapsed", "clock", "time"]);
  const minuteNum =
    typeof minuteRaw === "number"
      ? minuteRaw
      : typeof minuteRaw === "string" && /^\d+/.test(minuteRaw.trim())
        ? parseInt(minuteRaw.trim(), 10)
        : null;

  return {
    matchId,
    status,
    isLive,
    score: deriveScore(record),
    minute: minuteNum,
    homeTeam: asString(
      firstDefined(record, ["home_team", "homeTeam", "home", "homeName"]),
    ),
    awayTeam: asString(
      firstDefined(record, ["away_team", "awayTeam", "away", "awayName"]),
    ),
    apiLastUpdateAt: normalizeIso(
      firstDefined(record, [
        "last_update",
        "lastUpdate",
        "last_updated",
        "lastUpdated",
        "updated_at",
        "updatedAt",
        "last_update_timestamp",
        "lastUpdateTimestamp",
        "timestamp",
      ]),
    ),
  };
}

/**
 * Tolerantly extract a list of match records from whatever shape the
 * `2026-world-cup__get_live_matches` tool returns: a bare array, an object with
 * a `matches`/`data`/`results` field, or an MCP-style `{ content: [{ text }] }`
 * envelope whose text is JSON.
 */
export function parseLiveMatches(toolResult: unknown): NormalizedMatch[] {
  const records = extractMatchRecords(toolResult);
  const out: NormalizedMatch[] = [];
  records.forEach((rec, i) => {
    const m = normalizeMatch(rec, i);
    if (m) out.push(m);
  });
  return out;
}

function extractMatchRecords(input: unknown): unknown[] {
  if (input === null || input === undefined) return [];
  if (typeof input === "string") {
    try {
      return extractMatchRecords(JSON.parse(input));
    } catch {
      return [];
    }
  }
  if (Array.isArray(input)) return input;
  if (typeof input !== "object") return [];

  const obj = input as Record<string, unknown>;

  // MCP content envelope: { content: [{ type: "text", text: "<json>" }] }
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as unknown[])
      .map((c) =>
        c && typeof c === "object"
          ? asString((c as Record<string, unknown>).text)
          : null,
      )
      .filter((t): t is string => t !== null);
    for (const text of texts) {
      const nested = extractMatchRecords(text);
      if (nested.length) return nested;
    }
  }

  for (const key of ["matches", "liveMatches", "live_matches", "data", "results", "fixtures", "items"]) {
    if (obj[key] !== undefined) {
      const nested = extractMatchRecords(obj[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function matchLabel(m: { matchId: string; homeTeam: string | null; awayTeam: string | null }): string {
  if (m.homeTeam && m.awayTeam) return `${m.homeTeam} vs ${m.awayTeam} (${m.matchId})`;
  return `match ${m.matchId}`;
}

export function evaluate(params: EvaluateParams): EvaluationResult {
  const config: WatchdogConfig = { ...DEFAULT_CONFIG, ...(params.config ?? {}) };
  const now = params.now;
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const { webhook } = params;
  // Defensive: even though get_live_matches should only return live games,
  // ignore anything that isn't actually live (finished/scheduled).
  const liveMatches = params.liveMatches.filter((m) => m.isLive);

  const alerts: Alert[] = [];

  const webhookLastEventMs = webhook.lastEventAt
    ? new Date(webhook.lastEventAt).getTime()
    : null;
  const webhookAgeMs =
    webhookLastEventMs !== null && !Number.isNaN(webhookLastEventMs)
      ? nowMs - webhookLastEventMs
      : null;

  const liveCount = liveMatches.length;

  const nextMatches: Record<string, MatchState> = {};

  // --- Webhook health check -------------------------------------------------
  let healthAlerted = params.prevState.webhook.healthAlerted;
  if (webhook.enabled === false) {
    alerts.push({
      kind: "webhook_disabled",
      severity: "critical",
      message:
        `The main webhook trigger${webhook.triggerId ? ` (${webhook.triggerId})` : ""} ` +
        `is currently PAUSED/disabled. World Cup match alerts will not be delivered ` +
        `until it is re-enabled.`,
    });
    healthAlerted = true;
  } else if (webhook.enabled === true) {
    healthAlerted = false;
  } else if (webhook.enabled === null && liveCount > 0) {
    alerts.push({
      kind: "webhook_status_unknown",
      severity: "warning",
      message:
        `Could not determine whether the main webhook trigger` +
        `${webhook.triggerId ? ` (${webhook.triggerId})` : ""} is active, ` +
        `and ${liveCount} match(es) are live right now. Verify the trigger exists ` +
        `and is enabled.`,
    });
  }

  // --- Webhook silence while matches are live -------------------------------
  if (liveCount > 0) {
    const liveLabels = liveMatches.map(matchLabel);
    const liveIds = liveMatches.map((m) => m.matchId);
    if (webhookLastEventMs === null) {
      alerts.push({
        kind: "webhook_never_fired",
        severity: "critical",
        matchIds: liveIds,
        message:
          `${liveCount} World Cup match(es) are live but the main webhook trigger ` +
          `has NO recorded events. The webhook may never have fired or its history ` +
          `is unavailable. Affected: ${liveLabels.join("; ")}.`,
      });
    } else if (webhookAgeMs !== null && webhookAgeMs > config.webhookSilenceMs) {
      alerts.push({
        kind: "webhook_silence_live_match",
        severity: "critical",
        matchIds: liveIds,
        message:
          `${liveCount} World Cup match(es) are live but no webhook event has been ` +
          `received in ${formatDuration(webhookAgeMs)} ` +
          `(last event ${webhook.lastEventAt}, threshold ` +
          `${formatDuration(config.webhookSilenceMs)}). The webhook trigger ` +
          `${webhook.triggerId ? `(${webhook.triggerId}) ` : ""}may have failed. ` +
          `Affected: ${liveLabels.join("; ")}.`,
      });
    }
  }

  // --- Per-match progress / stall detection ---------------------------------
  for (const m of liveMatches) {
    const prev = params.prevState.matches[m.matchId];
    const changed =
      !prev ||
      prev.status !== m.status ||
      prev.score !== m.score ||
      prev.minute !== m.minute ||
      prev.apiLastUpdateAt !== m.apiLastUpdateAt;

    const firstSeenAt = prev ? prev.firstSeenAt : nowIso;
    const lastProgressAt = changed ? nowIso : prev!.lastProgressAt;
    const stalledMs = nowMs - new Date(lastProgressAt).getTime();
    const isStalled = !changed && stalledMs > config.matchStallMs;

    let silenceAlerted = prev ? prev.silenceAlerted : false;
    if (isStalled && !silenceAlerted) {
      alerts.push({
        kind: "match_went_silent",
        severity: "warning",
        matchIds: [m.matchId],
        message:
          `${matchLabel(m)} is still reported as live (status ${m.status}` +
          `${m.score ? `, score ${m.score}` : ""}) but has shown no updates for ` +
          `${formatDuration(stalledMs)}. This may indicate webhook silence during ` +
          `active play.`,
      });
      silenceAlerted = true;
    } else if (changed) {
      silenceAlerted = false;
    }

    nextMatches[m.matchId] = {
      matchId: m.matchId,
      status: m.status,
      score: m.score,
      minute: m.minute,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      apiLastUpdateAt: m.apiLastUpdateAt,
      lastProgressAt,
      lastSeenLiveAt: nowIso,
      firstSeenAt,
      silenceAlerted,
    };
  }

  const nextState: WatchdogState = {
    version: STATE_VERSION,
    updatedAt: nowIso,
    webhook: {
      triggerId: webhook.triggerId ?? params.prevState.webhook.triggerId,
      lastEventAt: webhook.lastEventAt,
      enabled: webhook.enabled,
      healthAlerted,
    },
    matches: nextMatches,
  };

  return {
    alerts,
    nextState,
    summary: {
      now: nowIso,
      liveMatchCount: liveCount,
      webhookLastEventAt: webhook.lastEventAt,
      webhookAgeMs,
      webhookEnabled: webhook.enabled,
      alertCount: alerts.length,
    },
  };
}

export function migrateState(parsed: unknown): WatchdogState {
  if (!parsed || typeof parsed !== "object") return emptyState();
  const base = emptyState();
  const obj = parsed as Partial<WatchdogState>;
  return {
    version: STATE_VERSION,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : base.updatedAt,
    webhook: {
      triggerId: obj.webhook?.triggerId ?? null,
      lastEventAt: obj.webhook?.lastEventAt ?? null,
      enabled: obj.webhook?.enabled ?? null,
      healthAlerted: obj.webhook?.healthAlerted ?? false,
    },
    matches:
      obj.matches && typeof obj.matches === "object"
        ? (obj.matches as Record<string, MatchState>)
        : {},
  };
}

export function renderReport(result: EvaluationResult): string {
  const lines: string[] = [];
  lines.push(`World Cup webhook watchdog — ${result.summary.now}`);
  lines.push(
    `Live matches: ${result.summary.liveMatchCount} | ` +
      `Webhook last event: ${result.summary.webhookLastEventAt ?? "never"} | ` +
      `Webhook enabled: ${result.summary.webhookEnabled ?? "unknown"}`,
  );
  if (result.alerts.length === 0) {
    lines.push("Status: OK — no webhook issues detected.");
  } else {
    lines.push(`Status: ${result.alerts.length} ALERT(S):`);
    for (const a of result.alerts) {
      lines.push(`  [${a.severity.toUpperCase()}] ${a.message}`);
    }
  }
  return lines.join("\n");
}
