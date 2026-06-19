import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  emptyState,
  parseLiveMatches,
  normalizeMatch,
  migrateState,
  type WatchdogState,
  type NormalizedMatch,
  type WebhookInfo,
} from "./watchdog.ts";

const T0 = new Date("2026-06-19T18:00:00.000Z");

function at(minutesFromT0: number): Date {
  return new Date(T0.getTime() + minutesFromT0 * 60_000);
}

function liveMatch(over: Partial<NormalizedMatch> = {}): NormalizedMatch {
  return {
    matchId: "m1",
    status: "IN_PLAY",
    isLive: true,
    score: "0-0",
    minute: 10,
    homeTeam: "Brazil",
    awayTeam: "France",
    apiLastUpdateAt: null,
    ...over,
  };
}

const enabledWebhook: WebhookInfo = {
  triggerId: "bf76e969",
  lastEventAt: T0.toISOString(),
  enabled: true,
};

test("parseLiveMatches handles bare arrays", () => {
  const out = parseLiveMatches([{ match_id: "x", status: "LIVE", home_score: 1, away_score: 0 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].matchId, "x");
  assert.equal(out[0].isLive, true);
  assert.equal(out[0].score, "1-0");
});

test("parseLiveMatches handles {matches:[...]} and JSON strings", () => {
  const out = parseLiveMatches(JSON.stringify({ matches: [{ id: "a", state: "FINISHED" }] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].matchId, "a");
  assert.equal(out[0].isLive, false);
});

test("parseLiveMatches handles MCP content envelope", () => {
  const env = {
    content: [{ type: "text", text: JSON.stringify({ matches: [{ id: "z", status: "IN_PLAY" }] }) }],
  };
  const out = parseLiveMatches(env);
  assert.equal(out.length, 1);
  assert.equal(out[0].matchId, "z");
  assert.equal(out[0].isLive, true);
});

test("normalizeMatch reads nested score object and various timestamp keys", () => {
  const m = normalizeMatch(
    { matchId: "q", status: "Half-Time", score: { home: 2, away: 1 }, updatedAt: "2026-06-19T18:05:00Z" },
    0,
  );
  assert.ok(m);
  assert.equal(m!.score, "2-1");
  assert.equal(m!.status, "HALF-TIME");
  assert.equal(m!.isLive, true);
  assert.equal(m!.apiLastUpdateAt, "2026-06-19T18:05:00.000Z");
});

test("no alerts when webhook is fresh and matches are live", () => {
  const res = evaluate({
    now: T0,
    prevState: emptyState(),
    liveMatches: [liveMatch()],
    webhook: enabledWebhook,
  });
  assert.equal(res.alerts.length, 0);
  assert.equal(res.summary.liveMatchCount, 1);
  assert.ok(res.nextState.matches["m1"]);
});

test("alerts when a match is live but webhook has been silent past threshold", () => {
  const res = evaluate({
    now: at(20),
    prevState: emptyState(),
    liveMatches: [liveMatch()],
    webhook: { ...enabledWebhook, lastEventAt: T0.toISOString() },
  });
  const kinds = res.alerts.map((a) => a.kind);
  assert.ok(kinds.includes("webhook_silence_live_match"), JSON.stringify(kinds));
  const alert = res.alerts.find((a) => a.kind === "webhook_silence_live_match")!;
  assert.deepEqual(alert.matchIds, ["m1"]);
  assert.match(alert.message, /20 min/);
});

test("critical alert when webhook never fired but matches are live", () => {
  const res = evaluate({
    now: T0,
    prevState: emptyState(),
    liveMatches: [liveMatch()],
    webhook: { triggerId: "bf76e969", lastEventAt: null, enabled: true },
  });
  assert.ok(res.alerts.some((a) => a.kind === "webhook_never_fired"));
});

test("critical alert when webhook is disabled, deduped via state", () => {
  const res = evaluate({
    now: T0,
    prevState: emptyState(),
    liveMatches: [],
    webhook: { triggerId: "bf76e969", lastEventAt: T0.toISOString(), enabled: false },
  });
  assert.ok(res.alerts.some((a) => a.kind === "webhook_disabled"));
  assert.equal(res.nextState.webhook.healthAlerted, true);
});

test("warning when webhook status unknown and matches live", () => {
  const res = evaluate({
    now: T0,
    prevState: emptyState(),
    liveMatches: [liveMatch()],
    webhook: { triggerId: null, lastEventAt: T0.toISOString(), enabled: null },
  });
  assert.ok(res.alerts.some((a) => a.kind === "webhook_status_unknown"));
});

test("detects a live match that stalls (no progress) across polls", () => {
  // Poll 1 at T0: establishes baseline, webhook fresh each poll.
  let state: WatchdogState = emptyState();
  const m = liveMatch({ score: "1-0", minute: 30 });

  const r1 = evaluate({
    now: T0,
    prevState: state,
    liveMatches: [m],
    webhook: { ...enabledWebhook, lastEventAt: T0.toISOString() },
  });
  state = r1.nextState;
  assert.equal(r1.alerts.length, 0);

  // Polls keep returning the EXACT same match data; webhook stays fresh so the
  // only signal is the per-match stall.
  const r2 = evaluate({
    now: at(20),
    prevState: state,
    liveMatches: [m],
    webhook: { ...enabledWebhook, lastEventAt: at(20).toISOString() },
  });
  const silent = r2.alerts.find((a) => a.kind === "match_went_silent");
  assert.ok(silent, JSON.stringify(r2.alerts));
  assert.deepEqual(silent!.matchIds, ["m1"]);
  assert.equal(r2.nextState.matches["m1"].silenceAlerted, true);
});

test("stall alert does not repeat once raised, until progress resumes", () => {
  let state: WatchdogState = emptyState();
  const m = liveMatch({ score: "1-0", minute: 30 });
  state = evaluate({ now: T0, prevState: state, liveMatches: [m], webhook: { ...enabledWebhook, lastEventAt: T0.toISOString() } }).nextState;
  const r2 = evaluate({ now: at(20), prevState: state, liveMatches: [m], webhook: { ...enabledWebhook, lastEventAt: at(20).toISOString() } });
  state = r2.nextState;
  // Still stalled at next poll — should NOT alert again.
  const r3 = evaluate({ now: at(25), prevState: state, liveMatches: [m], webhook: { ...enabledWebhook, lastEventAt: at(25).toISOString() } });
  assert.equal(r3.alerts.filter((a) => a.kind === "match_went_silent").length, 0);

  // Progress resumes (score change) — alert flag resets.
  const moved = liveMatch({ score: "2-0", minute: 50 });
  const r4 = evaluate({ now: at(26), prevState: state, liveMatches: [moved], webhook: { ...enabledWebhook, lastEventAt: at(26).toISOString() } });
  assert.equal(r4.nextState.matches["m1"].silenceAlerted, false);
});

test("finished matches are dropped from active tracking", () => {
  let state: WatchdogState = emptyState();
  state = evaluate({ now: T0, prevState: state, liveMatches: [liveMatch()], webhook: { ...enabledWebhook, lastEventAt: T0.toISOString() } }).nextState;
  assert.ok(state.matches["m1"]);
  const r2 = evaluate({
    now: at(5),
    prevState: state,
    liveMatches: [liveMatch({ status: "FINISHED", isLive: false })],
    webhook: { ...enabledWebhook, lastEventAt: at(5).toISOString() },
  });
  assert.equal(r2.nextState.matches["m1"], undefined);
});

test("migrateState tolerates garbage and partial input", () => {
  assert.deepEqual(migrateState(null).matches, {});
  const s = migrateState({ webhook: { enabled: false } });
  assert.equal(s.webhook.enabled, false);
  assert.equal(s.version, 1);
});
