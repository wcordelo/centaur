# Edge Actor Framework (draft)

> **Branch:** `edge/cloudflare` — review via PR, not merged to `main` yet.

Architectural transition from K8s/Rust Centaur to a serverless actor framework on **Cloudflare Durable Objects**, **Workers**, and **per-DO SQLite**.

See the [Centaur-to-Edge Migration Spec](https://app.notion.com/p/Centaur-to-Edge-Migration-Spec-38d34448009481f58864e58be2a71c97) for the full design.

## Actors

| Actor | Role |
|-------|------|
| **Orchestrator DO** | Entry point; shards tasks; aggregates results; model circuit breakers |
| **Researcher DO** | Deep research Fibers; SQLite session + research log + verified facts |
| **Verifier DO** | Validates researcher output against objective |

## Key patterns

- **Fibers:** alarm-scheduled steps with SQLite checkpoints (≤20s per burst)
- **Internal DO RPC** with `request_id` deduplication and outbox retries
- **Adapters** wrapping `ctx.storage.sql` and CF RPC for portability
- **LLM:** Cloudflare AI Gateway → direct Anthropic/OpenAI `fetch` (no LiteLLM)

## Code layout (planned)

```
contrib/edge/
  worker/src/actors/     # Orchestrator, Researcher, Verifier
  worker/src/adapters/   # Storage, RPC, LLM, alarms
  wasm/                  # Nix-built Rust → Wasm modules
```

Implementation status: **scaffold** — see [contrib/edge/README.md](../../../contrib/edge/README.md).
