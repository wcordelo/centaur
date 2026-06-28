# Centaur Edge — Cloudflare Actor Framework

This directory is the greenfield home for the **Centaur-less** edge migration on branch `edge/cloudflare`.

## Status

Scaffold only. Implementation follows the migration plan:

- **Spec:** [Centaur-to-Edge Migration Spec](https://app.notion.com/p/Centaur-to-Edge-Migration-Spec-38d34448009481f58864e58be2a71c97)
- **Architecture:** Orchestrator / Researcher / Verifier Durable Objects, per-DO SQLite, Fiber async loops via alarms, Wasm research modules, AI Gateway LLM routing

## Branch workflow

All edge work lands on `edge/cloudflare` via PR into `main`. Do not commit edge changes directly to `main`.

The K8s/Rust stack on `main` (`contrib/chart/`, `services/api-rs/`, etc.) remains the production path until edge MVP is reviewed and cut over.

## Deploy (future)

```bash
cd contrib/edge
wrangler deploy
```
