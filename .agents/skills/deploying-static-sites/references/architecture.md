# Quick — Static-Site Deploy Architecture

"Quick" is a zero-friction, folder-based deployment platform for agent-generated
static artifacts (HTML/JS/CSS), inspired by Shopify's "Quick" philosophy. A user
asks for something, an agent generates the artifact, and a single tool call ships
it to a live, access-gated URL.

This document describes how the design maps onto Centaur. The agent-facing
workflow lives in the [skill](../SKILL.md); the implementation lives in
`tools/infra/quick/`.

## High-level data flow

```
Slack (/quick-deploy or "Build Artifact" shortcut)
   │  webhook
   ▼
Centaur API  ──► agent turn (deploying-static-sites skill)
   │                 │ generates HTML/JS/CSS
   │                 ▼
   │           quick.deploy_artifact(site_id, files[])
   │                 │ validate slug + paths, set content types
   │                 ▼
   │           backend upload  ──►  local FS  |  S3 / Cloudflare R2
   ▼
Live URL: https://<site_id>.quick.internal   (behind Cloudflare Access / IAP)
   │
   ▼
Slack thread: live link + [Re-generate] [View Logs] [Delete]
```

## The `deploy_artifact` contract

Mirrors the Notion SPEC schema. The agent calls it with a slug and a list of
files; each file is `{path, content}` with an optional `encoding`:

```json
{
  "site_id": "pricing-demo",
  "files": [
    {"path": "index.html", "content": "<!doctype html>..."},
    {"path": "assets/app.js", "content": "console.log(1)"},
    {"path": "assets/logo.png", "content": "<base64>", "encoding": "base64"}
  ]
}
```

Response:

```json
{
  "site_id": "pricing-demo",
  "url": "https://pricing-demo.quick.internal",
  "backend": "local",
  "file_count": 3,
  "files": ["index.html", "assets/app.js", "assets/logo.png"],
  "bytes": 4096,
  "has_index": true,
  "timestamp": "2026-06-11T02:50:36+00:00"
}
```

### Validation (security)

- `site_id` must be a valid DNS label (`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`),
  because it becomes a subdomain.
- File paths are normalized and rejected if absolute or containing `..`, so a
  deploy can never write outside its own `<site_id>/` prefix.
- Per-file (25 MB), total (100 MB), and file-count (500) limits bound a deploy.
- Content type is derived from the extension, biased to correct web defaults
  (`text/html; charset=utf-8`, `application/javascript; charset=utf-8`, …).

## Backends

The tool exposes one interface with two interchangeable backends, selected by
`QUICK_DEPLOY_BACKEND`.

### `local` (default — local-first testing)

Writes the artifact tree under `QUICK_LOCAL_ROOT/<site_id>/...`. On the local
Centaur stack this directory is served by an in-cluster static server (or, in
dev, `python -m http.server`). Requires no cloud credentials, so the whole flow
is exercisable locally per the AGENTS.md "Local-First Testing" rule.

### `s3` (production — AWS S3 or Cloudflare R2)

PUTs each object to `<endpoint>/<bucket>/<site_id>/<path>` over `httpx`, which
respects `HTTPS_PROXY`. That lets **iron-proxy inject SigV4 credentials** for the
bucket host, so the tool (and the agent) never see raw AWS/R2 keys — matching
Centaur's credential-boundary model. Config:

| Env | Purpose |
|-----|---------|
| `QUICK_S3_BUCKET` | Target bucket. |
| `QUICK_S3_ENDPOINT` | S3-compatible endpoint. R2: `https://<account>.r2.cloudflarestorage.com`. |
| `QUICK_S3_REGION` | Region (`auto` for R2). |
| `QUICK_PUBLIC_BASE_URL` | Optional URL-base override when serving is not subdomain-based. |

To enable credential injection, the deployment adds an `aws_auth` secret to
`tools/infra/quick/pyproject.toml` scoped to the bucket host:

```toml
[tool.centaur]
module = "client.py"
optional_secrets = [
  {type = "aws_auth", name = "QUICK_S3",
   hosts = ["<bucket>.<endpoint-host>"],
   access_key_id = "QUICK_S3_ACCESS_KEY_ID",
   secret_access_key = "QUICK_S3_SECRET_ACCESS_KEY",
   allowed_services = ["s3"]},
]
```

The referenced `QUICK_S3_ACCESS_KEY_ID` / `QUICK_S3_SECRET_ACCESS_KEY` live in the
secrets manager (1Password), never in the repo.

### Serving in production (Cloudflare Worker)

A wildcard worker maps the subdomain to the R2 folder and streams the object,
defaulting `/` to `index.html` and returning 404 for misses. This is the
serving layer described in the SPEC; the tool only handles the upload side.

## Slack UX

- **Trigger**: `/quick-deploy <description>` slash command, or a "Build Artifact"
  shortcut.
- **Interim**: "🚀 Centaur is generating your artifact…"
- **Deploying**: "📦 Deployment in progress to `site-slug.quick.internal`…"
- **Done**: a card with the live **URL** and controls **[Re-generate]**,
  **[View Logs]**, **[Delete]** — backed by re-running the turn,
  `quick.get_site`, and `quick.delete_site` respectively.

## Access control (IAP)

`*.quick.internal` is gated by **Cloudflare Access** or **Google IAP**, so only
authorized org users can open a deployed artifact. Deploys are internal-only by
default; making a site public is an explicit, separate step.
