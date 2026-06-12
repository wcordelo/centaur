---
name: deploying-static-sites
description: "Deploy a static web artifact (HTML/JS/CSS) the agent generated to a live URL using the Quick platform. Use when asked to deploy/publish/ship a static site, landing page, dashboard, or one-off HTML/JS/CSS artifact, or to handle a /quick-deploy request."
---

# Deploying Static Sites (Quick)

Ship an agent-generated static artifact to a live URL with one tool call. "Quick"
is a zero-friction, folder-based deploy: generate the files, then call
`quick.deploy_artifact` with a slug and the file list. The platform uploads each
file with the right content type and returns `https://<site_id>.quick.internal`.

This skill is the agent-facing companion to the `quick` tool
(`tools/infra/quick/`). For the full system design (data flow, backends, Slack
UX, IAP gating, the exact `aws_auth` secret entry), read
[references/architecture.md](references/architecture.md).

## When to use

- "Deploy / publish / ship this page", "put this online", "give me a link".
- A `/quick-deploy <description>` Slack request: generate the artifact, then deploy.
- Any time you produced standalone HTML/JS/CSS the user wants to view in a browser.

Do **not** use this for full backend apps, server-rendered frameworks, or
anything needing a runtime — Quick serves static files only.

## Flow

1. **Generate** the artifact as a set of files. Always include an `index.html` at
   the root (it is the default document served at `/`). Use **relative** asset
   paths (`assets/app.js`, not `/assets/app.js`).
2. **Pick a `site_id`** — a DNS label: lowercase letters, digits, internal
   hyphens, 1–63 chars (e.g. `pricing-demo`). It becomes the subdomain. Reusing a
   `site_id` re-deploys (overwrites) that site.
3. **Deploy** with one call:

   ```
   call tools/quick/deploy_artifact '{
     "site_id": "pricing-demo",
     "files": [
       {"path": "index.html", "content": "<!doctype html>..."},
       {"path": "assets/app.js", "content": "console.log(1)"}
     ]
   }'
   ```

   Binary assets (images, fonts): set `"encoding": "base64"` on that file and pass
   base64 content.
4. **Report** the returned `url` back to the user. In Slack, post the live link
   plus the [Re-generate] / [View Logs] / [Delete] affordances (see architecture doc).

## Managing deployed sites

- `quick.list_sites` — list deployed sites.
- `quick.get_site {"site_id": "..."}` — files + metadata for one site.
- `quick.delete_site {"site_id": "..."}` — remove a site and all its files.

## Rules & gotchas

- **Always include `index.html`** at the root, or `/` returns 404. The deploy
  result includes `has_index` — if it is `false`, fix the artifact and re-deploy.
- **Relative paths only** so the site works under its subdomain.
- **Validate before deploying**: `site_id` must be a valid DNS label; file paths
  may not be absolute or contain `..` (the tool rejects both).
- **Static only.** No server code, env secrets, or runtime — inline JS/CSS or
  reference relative bundled assets.
- **Backends are transparent.** Locally the artifact is written to disk and served
  by the in-cluster static server; in production it is pushed to S3/Cloudflare R2.
  You call the same tool either way — do not special-case the backend.
- **Access is gated.** `*.quick.internal` sits behind Cloudflare Access / Google
  IAP, so only authorized org users can open the link. Tell the user if they may
  hit an auth gate.

## CLI (standalone / local testing)

```bash
# Deploy a directory tree, then inspect it.
quick deploy pricing-demo ./dist
quick list
quick get pricing-demo --json
quick delete pricing-demo
```

## Local verification (no install)

To exercise the tool from a fresh checkout without installing it, run the CLI as a
module with the tool dirs on `PYTHONPATH`, point the local backend at a writable
dir, and serve the result with a plain static server (the `*.quick.internal` URL
the tool returns is the production Cloudflare/IAP domain and is **not**
DNS-resolvable in dev):

```bash
export PYTHONPATH=tools/infra:.            # repo root: makes `quick` importable
export QUICK_LOCAL_ROOT=/tmp/quick-e2e     # writable site root

uv run --with typer --with rich --with httpx --with python-dotenv \
  python -m quick.cli deploy demo-site ./dist --json

# Browser proof: serve the local root and open http://localhost:8799/demo-site/
python -m http.server 8799 --directory "$QUICK_LOCAL_ROOT"
```

Run the unit tests the same way: `PYTHONPATH=tools/infra:. uv run pytest tools/infra/quick/tests`.

## Ownership, atomic deploys, and serving (v2)

- Each site records an **owner** (`QUICK_REQUESTER`) in `_quick/manifest.json`
  on first deploy. Redeploying or deleting a site owned by someone else fails —
  pick a different `site_id`. The `_quick/` prefix is reserved; never write to it.
- Deploys are **atomic on the local backend** (stage-and-swap) and ordered on
  s3 (all files first, manifest last, stale files cleaned up after). A failed
  deploy never leaves a half-updated live site, and files removed from a new
  version no longer linger.
- `get_site` / `delete_site` now work on the **s3 backend** too, driven by the
  manifest. `deploy_artifact` responses include `owner` and `removed_stale`.
- To serve local-backend sites end to end, run `python -m quick.server`
  (wildcard `Host` routing for `<site>.quick.internal`, plus a
  `/sites/<site_id>/` path fallback for plain-localhost testing). It never
  serves `_quick/` or dotfiles. Authentication stays at the IAP layer in front,
  per references/architecture.md.
