# Vercel Eve exploration (Centaur repo)

Research notes and a working Eve agent demo living inside [wcordelo/centaur](https://github.com/wcordelo/centaur). Intended as source material for a Notion page comparing Eve to Centaur.

## What is Vercel Eve?

**Eve** (npm package `eve`, v0.11.4 at time of writing) is Vercel’s open-source, filesystem-first framework for **durable backend AI agents**. Public preview announced **June 17, 2026**.

| Aspect | Eve |
|--------|-----|
| Mental model | “Next.js for agents” — agent = directory of files |
| Authoring | `instructions.md` (prompt), `agent.ts` (model), `tools/*.ts`, `skills/`, `channels/`, `subagents/` |
| Durability | Vercel Workflow (checkpointed sessions) |
| Compute | Per-agent sandbox (Docker locally, Vercel Sandbox in prod) |
| Model routing | AI Gateway (`provider/model` strings) or direct AI SDK providers |
| Deploy | `vercel deploy` — same project shape locally and in production |
| HTTP API | `POST /eve/v1/session`, `GET /eve/v1/session/:id/stream`, follow-ups via `continuationToken` |

**Official resources**

- Product: https://vercel.com/eve
- Docs: https://vercel.com/docs/eve
- Concepts: https://vercel.com/docs/eve/concepts
- Launch post: https://vercel.com/blog/introducing-eve
- Source: https://github.com/vercel/eve

Bundled docs ship inside `node_modules/eve/docs/` after install.

## Centaur vs Eve (high level)

| | **Centaur** | **Eve** |
|---|-------------|---------|
| Hosting | Self-hosted Kubernetes (Helm) | Vercel Functions + platform services |
| Primary channel | Slack (`slackbotv2`) | HTTP + optional Slack/Discord/Teams channels |
| Agent runtime | Sandbox pod per thread, harness CLI (Codex/Claude/Amp) | Eve harness + default tool suite + optional sandbox |
| Tools | Python plugins (`tools/`), REST `/tools/{name}/{method}` | TypeScript files under `agent/tools/` |
| Durability | Postgres (`api-rs` session runtime) | Vercel Workflow |
| Credentials | iron-proxy / 1Password injection | AI Gateway OIDC or provider env keys |

Both platforms treat **durable multi-turn sessions**, **typed tools**, and **channel adapters** as first-class concerns.

## Demo project layout

```
contrib/eve-exploration/
├── README.md                 # this file
├── scripts/run-e2e.sh        # reproducible smoke test
├── artifacts/                # captured command output (gitignored)
└── centaur-eve-demo/         # Eve app scaffolded with `npx eve@latest init`
    ├── package.json
    ├── agent/
    │   ├── agent.ts          # model config (direct OpenAI via @ai-sdk/openai)
    │   ├── instructions.md   # Centaur-focused system prompt
    │   ├── channels/eve.ts   # HTTP channel + auth (localDev, vercelOidc, placeholder)
    │   └── tools/
    │       └── describe_centaur.ts
    └── node_modules/eve/docs/  # full Eve documentation (local)
```

## Prerequisites

- **Node.js 24+** (Eve enforces `engines.node: 24.x`)
- Model credential:
  - **AI Gateway**: `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` (`eve link`)
  - **Direct provider**: e.g. `OPENAI_API_KEY` when using `@ai-sdk/openai` in `agent.ts`

On macOS/Linux with nvm:

```bash
nvm install 24
nvm use 24
```

## Quick start

```bash
cd contrib/eve-exploration/centaur-eve-demo
npm install
npm run typecheck
npm run build
export OPENAI_API_KEY=...   # or configure AI Gateway
npm run start -- --host 127.0.0.1 --port 3000
```

Or use the bundled script from `contrib/eve-exploration`:

```bash
chmod +x scripts/run-e2e.sh
./scripts/run-e2e.sh
```

Interactive dev UI:

```bash
npm run dev   # eve dev — terminal UI; Ctrl+C to stop before editing
```

## Key source files

### `agent/instructions.md`

Always-on system prompt. Customized for Centaur architecture Q&A and tool use.

### `agent/agent.ts`

```typescript
import { openai } from "@ai-sdk/openai";
import { defineAgent } from "eve";

export default defineAgent({
  model: openai("gpt-4.1-mini"),
});
```

Gateway model strings (`anthropic/claude-sonnet-4.6`) route through Vercel AI Gateway. Direct SDK providers bypass the gateway and use provider env keys.

### `agent/tools/describe_centaur.ts`

Typed tool (filename → tool name `describe_centaur`). Returns static Centaur facts for topics: `overview`, `architecture`, `api`, `services`, `eve_comparison`.

### `agent/channels/eve.ts`

Default HTTP channel with `localDev()`, `vercelOidc()`, and `placeholderAuth()` — open on localhost during `eve dev`.

## HTTP API exercise

**1. Create session**

```bash
curl -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Call describe_centaur with topic architecture, then answer in one sentence."}'
```

Response (202):

```json
{
  "ok": true,
  "sessionId": "wrun_...",
  "continuationToken": "eve:..."
}
```

Header: `x-eve-session-id: wrun_...`

**2. Stream NDJSON lifecycle events**

```bash
curl -N http://127.0.0.1:3000/eve/v1/session/<sessionId>/stream
```

Expected event types on success: `session.started` → `turn.started` → `message.received` → `step.started` → `actions.requested` → `action.result` → `message.completed` → `session.completed`.

**3. Follow-up message**

```bash
curl -X POST http://127.0.0.1:3000/eve/v1/session/<sessionId> \
  -H 'content-type: application/json' \
  -d '{"continuationToken":"<token>","message":"Now summarize services."}'
```

## Validation performed (Cloud VM)

| Step | Result |
|------|--------|
| `npx eve@latest init centaur-eve-demo` | ✅ Scaffolded eve v0.11.4 |
| `npm run typecheck` | ✅ Pass |
| `npm exec eve info` | ✅ Discovered `describe_centaur` tool + HTTP routes |
| `npm run build` | ✅ Nitro server build to `.output/` |
| Direct `describe_centaur` execute | ✅ Returns architecture summary JSON |
| `POST /eve/v1/session` | ✅ 202 + session id + continuation token |
| `GET .../stream` | ✅ NDJSON lifecycle events emitted |
| Full model turn (tool call + reply) | ⚠️ Blocked — Cloud VM `OPENAI_API_KEY` invalid (401) |

With a valid API key, the same stream should continue past `step.started` to `actions.requested` / `action.result` / `message.completed`.

## Sample captured output

### `eve info` (excerpt)

```
Create  POST /eve/v1/session
Continue POST /eve/v1/session/:sessionId
Stream   GET /eve/v1/session/:sessionId/stream
Diagnostics 0 errors, 0 warnings
```

### Session create

```
HTTP/1.1 202
x-eve-session-id: wrun_01KVBJDFRBS030PP9B4KSBFWXH

{"continuationToken":"eve:...","ok":true,"sessionId":"wrun_01KVBJDFRBS030PP9B4KSBFWXH"}
```

### Stream (credential failure — documents protocol still works)

```json
{"type":"session.started","data":{"runtime":{"agentId":"centaur-eve-demo","modelId":"openai/gpt-4.1-mini"}}}
{"type":"turn.started","data":{"turnId":"turn_0"}}
{"type":"message.received","data":{"message":"Call describe_centaur..."}}
{"type":"step.started","data":{"stepIndex":0}}
{"type":"step.failed","data":{"code":"MODEL_CALL_FAILED","message":"Incorrect API key provided..."}}
{"type":"session.failed","data":{"code":"MODEL_CALL_FAILED"}}
```

### Direct tool (no LLM required)

```json
{
  "topic": "architecture",
  "summary": "Slack/API -> Centaur API (Rust api-rs) -> Postgres durable state -> Kubernetes sandbox -> harness CLI -> tools via REST back to API.",
  "repository": "github.com/wcordelo/centaur"
}
```

## Eve concepts worth highlighting for Notion

1. **Filesystem = contract** — path-derived names (`tools/foo.ts` → `foo` tool); no separate registry.
2. **Default harness** — bash, read/write file, grep, glob, web_fetch, todo, ask_question included without authoring.
3. **Durable sessions** — Workflow-backed; survives cold start and deploy.
4. **Channels** — same agent, multiple entry points (HTTP, Slack, Discord, …).
5. **Evals** — `evals/*.eval.ts` + `eve eval` for regression testing.
6. **Agent Runs** — Vercel dashboard observability (sessions, tools, tokens).

## Related Centaur paths

- Control plane: `services/api-rs/`
- Slack client: `services/slackbotv2/`
- Python tools: `tools/`
- Agent sandbox image: `services/sandbox/`
