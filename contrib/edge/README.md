# Centaur Edge — Cloudflare Actor Framework

Greenfield **Centaur-less** stack on branch [`edge/cloudflare`](https://github.com/wcordelo/centaur/tree/edge/cloudflare).

## Docs

- **[Architecture & gap resolutions](../../docs/public/md/edge-actor-framework.md)** — authoritative design (all adversarial gaps addressed)
- [Notion migration spec](https://app.notion.com/p/Centaur-to-Edge-Migration-Spec-38d34448009481f58864e58be2a71c97)
- Draft PR: [#11](https://github.com/wcordelo/centaur/pull/11)

## Stack

| Layer | Technology |
|-------|------------|
| Ingress | Worker + **Queue** (3s Slack ack) |
| Task DAG | **Cloudflare Workflows** |
| Hot state | **Orchestrator / Researcher / Verifier DOs** + SQLite |
| Blobs | **R2** |
| LLM | **AI Gateway** → Anthropic/OpenAI |
| Research | Parallel/Exa (TS client) |

K8s Centaur on `main` is unchanged until cutover.

## Status

**Phase 1 scaffold implemented** — Wrangler project, Queue ingress, 3 DOs, TaskWorkflow skeleton, mock LLM, Vitest + CI.

```bash
cd contrib/edge
pnpm install   # from repo root: pnpm install
pnpm test
pnpm deploy:dry-run
```

## Deploy (future)

```bash
cd contrib/edge
pnpm install
wrangler deploy --env staging   # or production
```

## Branch rules

- All edge work on `edge/cloudflare` (or `edge/cloudflare/*` → PR into integration branch)
- Never commit edge changes directly to `main`
