## Edge migration PR (`edge/cloudflare` → `main`)

**Do not merge until Phase 4 MVP criteria met and agent reviews pass.**

Architecture: [docs/public/md/edge-actor-framework.md](../docs/public/md/edge-actor-framework.md)

## Summary

<!-- What changed and why -->

## Gap / adversarial checklist

- [ ] Orchestrator does not block on long-running Researcher RPC (Workflow + outbox)
- [ ] Slack ingress uses **Queue** — not `waitUntil` for heavy work
- [ ] Payloads >256KB use R2, not SQLite rows
- [ ] Verifier receives summary JSON only (<512KB)
- [ ] `alarm_queue` pattern — only one `setAlarm` per DO
- [ ] Slack `event_id` dedup + signing + timestamp skew check
- [ ] Fiber checkpoints survive DO eviction (chaos test)
- [ ] Verifier reject/revise loop (max 3 rounds)
- [ ] Task cancel / supersede by newer `event_ts`
- [ ] Thread context from `conversations.replies`
- [ ] Subrequest + `task_budget` caps enforced
- [ ] Schema migration on DO boot (`schema_version`)
- [ ] Structured logs include `thread_key` / `task_id`
- [ ] No changes to `contrib/chart/` or `services/api-rs/` unless explicitly scoped
- [ ] MVP scope regression documented if user-facing

## Test plan

- [ ] `cd contrib/edge && pnpm test`
- [ ] `wrangler deploy --dry-run` (or preview env)
- [ ] Manual Slack emulate / staging app (if applicable)
