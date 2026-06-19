/**
 * CLI wrapper around the World Cup webhook watchdog.
 *
 * Run with Node 22+ (no build step required):
 *
 *   node --experimental-strip-types automations/world-cup-watchdog/cli.ts \
 *     --matches live_matches.json \
 *     --state automations/world-cup-watchdog/state.json \
 *     --webhook-id bf76e969-72d3-4bbe-a190-a0400b5dde9d \
 *     --webhook-last-event 2026-06-19T00:30:00Z \
 *     --webhook-enabled true
 *
 * Inputs:
 *   --matches <file>          Path to the JSON output of 2026-world-cup__get_live_matches.
 *   --matches-json <json>     Inline JSON instead of a file. (or env WORLD_CUP_LIVE_MATCHES_JSON)
 *   --state <file>            Persistent state file (read + written). Default ./state.json.
 *   --webhook-id <id>         Id of the main webhook trigger (for messaging).
 *   --webhook-last-event <iso>  ISO timestamp of the last webhook event/invocation.
 *                             (or env WEBHOOK_LAST_EVENT_AT)
 *   --webhook-enabled <v>     true | false | unknown. (or env WEBHOOK_ENABLED)
 *   --now <iso>               Override "now" (mainly for testing).
 *   --webhook-silence-min <n> Minutes of webhook silence (while live) before alerting. Default 12.
 *   --match-stall-min <n>     Minutes a live match may stall before alerting. Default 15.
 *   --help                    Print this help.
 *
 * Output: a human-readable report on stderr/stdout plus a machine-readable JSON
 * block on stdout delimited by ===WATCHDOG_RESULT_JSON=== markers, so the
 * orchestrating Devin session can parse alerts reliably.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  evaluate,
  emptyState,
  migrateState,
  parseLiveMatches,
  renderReport,
  DEFAULT_CONFIG,
  type WatchdogState,
  type WebhookInfo,
} from "./watchdog.ts";

interface Args {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function parseEnabled(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "enabled" || v === "active" || v === "1") return true;
  if (v === "false" || v === "disabled" || v === "paused" || v === "0") return false;
  return null;
}

const HELP = `World Cup webhook watchdog\n\n${__doc()}`;

function __doc(): string {
  return [
    "Usage: node --experimental-strip-types cli.ts [options]",
    "",
    "  --matches <file>            JSON output of 2026-world-cup__get_live_matches",
    "  --matches-json <json>       Inline JSON (or env WORLD_CUP_LIVE_MATCHES_JSON)",
    "  --state <file>              Persistent state file (default ./state.json)",
    "  --webhook-id <id>           Id of the main webhook trigger",
    "  --webhook-last-event <iso>  ISO of last webhook event (or env WEBHOOK_LAST_EVENT_AT)",
    "  --webhook-enabled <v>       true|false|unknown (or env WEBHOOK_ENABLED)",
    "  --now <iso>                 Override current time (testing)",
    "  --webhook-silence-min <n>   Webhook silence threshold, minutes (default 12)",
    "  --match-stall-min <n>       Per-match stall threshold, minutes (default 15)",
    "  --help                      Show this help",
  ].join("\n");
}

function loadMatchesInput(args: Args): unknown {
  const inline = str(args, "matches-json") ?? process.env.WORLD_CUP_LIVE_MATCHES_JSON;
  if (inline) return inline;
  const file = str(args, "matches");
  if (file) {
    return readFileSync(resolve(file), "utf8");
  }
  throw new Error(
    "No live matches input. Provide --matches <file>, --matches-json <json>, " +
      "or set WORLD_CUP_LIVE_MATCHES_JSON.",
  );
}

function loadState(statePath: string): WatchdogState {
  if (!existsSync(statePath)) return emptyState();
  try {
    return migrateState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch (err) {
    process.stderr.write(
      `Warning: could not read state file ${statePath} (${String(err)}); starting fresh.\n`,
    );
    return emptyState();
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }

  const statePath = resolve(str(args, "state") ?? "./state.json");
  const now = str(args, "now") ? new Date(str(args, "now") as string) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Invalid --now value: ${str(args, "now")}`);
  }

  const webhook: WebhookInfo = {
    triggerId: str(args, "webhook-id") ?? process.env.WEBHOOK_TRIGGER_ID ?? null,
    lastEventAt:
      str(args, "webhook-last-event") ?? process.env.WEBHOOK_LAST_EVENT_AT ?? null,
    enabled: parseEnabled(str(args, "webhook-enabled") ?? process.env.WEBHOOK_ENABLED),
  };

  const silenceMin = str(args, "webhook-silence-min");
  const stallMin = str(args, "match-stall-min");

  const liveMatches = parseLiveMatches(loadMatchesInput(args));
  const prevState = loadState(statePath);

  const result = evaluate({
    now,
    prevState,
    liveMatches,
    webhook,
    config: {
      webhookSilenceMs: silenceMin
        ? Number(silenceMin) * 60 * 1000
        : DEFAULT_CONFIG.webhookSilenceMs,
      matchStallMs: stallMin
        ? Number(stallMin) * 60 * 1000
        : DEFAULT_CONFIG.matchStallMs,
    },
  });

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(result.nextState, null, 2) + "\n", "utf8");

  process.stdout.write(renderReport(result) + "\n\n");
  process.stdout.write("===WATCHDOG_RESULT_JSON===\n");
  process.stdout.write(
    JSON.stringify({ alerts: result.alerts, summary: result.summary }, null, 2) + "\n",
  );
  process.stdout.write("===END_WATCHDOG_RESULT_JSON===\n");

  // Exit non-zero when there is at least one alert so the wrapper can branch on
  // it even outside of a Devin session.
  return result.alerts.length > 0 ? 2 : 0;
}

process.exit(main());
