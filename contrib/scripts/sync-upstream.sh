#!/usr/bin/env bash
# Sync local changes with the upstream paradigmxyz/centaur repository.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

UPSTREAM_URL="${CENTAUR_UPSTREAM_URL:-https://github.com/paradigmxyz/centaur.git}"
UPSTREAM_REMOTE="${CENTAUR_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${CENTAUR_UPSTREAM_BRANCH:-main}"
LOCAL_BRANCH=""
FETCH_ONLY=0
USE_REBASE=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Fetch and merge (or rebase) the latest changes from the upstream Centaur repo
(${UPSTREAM_URL}) into your current branch.

Options:
  --branch BRANCH       Upstream branch to sync (default: ${UPSTREAM_BRANCH})
  --local-branch BRANCH Local branch to update (default: current branch)
  --remote NAME         Upstream remote name (default: ${UPSTREAM_REMOTE})
  --url URL             Upstream git URL (default: ${UPSTREAM_URL})
  --fetch-only          Fetch upstream only; do not merge or rebase
  --rebase              Rebase onto upstream instead of merge
  --dry-run             Show planned actions without changing git state
  -h, --help            Show this help

Environment:
  CENTAUR_UPSTREAM_URL, CENTAUR_UPSTREAM_REMOTE, CENTAUR_UPSTREAM_BRANCH

Examples:
  $(basename "$0")
  $(basename "$0") --fetch-only
  $(basename "$0") --rebase
  just sync-upstream
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      UPSTREAM_BRANCH="$2"
      shift 2
      ;;
    --local-branch)
      LOCAL_BRANCH="$2"
      shift 2
      ;;
    --remote)
      UPSTREAM_REMOTE="$2"
      shift 2
      ;;
    --url)
      UPSTREAM_URL="$2"
      shift 2
      ;;
    --fetch-only)
      FETCH_ONLY=1
      shift
      ;;
    --rebase)
      USE_REBASE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FATAL: not a git repository: $REPO_ROOT" >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "FATAL: working tree has uncommitted changes. Commit or stash before syncing." >&2
  git status --short >&2
  exit 1
fi

if [[ -z "$LOCAL_BRANCH" ]]; then
  LOCAL_BRANCH="$(git branch --show-current)"
fi

if [[ -z "$LOCAL_BRANCH" ]]; then
  echo "FATAL: detached HEAD; pass --local-branch" >&2
  exit 1
fi

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  current_url="$(git remote get-url "$UPSTREAM_REMOTE")"
  if [[ "$current_url" != "$UPSTREAM_URL" && "$current_url" != "${UPSTREAM_URL%.git}" ]]; then
    echo "upstream remote '$UPSTREAM_REMOTE' points at $current_url (expected $UPSTREAM_URL)" >&2
  fi
else
  echo "adding upstream remote '$UPSTREAM_REMOTE' -> $UPSTREAM_URL"
  run git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

echo "fetching ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}..."
run git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

if [[ "$FETCH_ONLY" -eq 1 ]]; then
  echo "fetch complete (${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH})"
  exit 0
fi

if ! git show-ref --verify --quiet "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"; then
  echo "FATAL: missing ref ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} after fetch" >&2
  exit 1
fi

upstream_sha="$(git rev-parse "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
local_sha="$(git rev-parse "$LOCAL_BRANCH")"

if git merge-base --is-ancestor "$upstream_sha" "$local_sha"; then
  echo "already up to date with ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} (${upstream_sha:0:12})"
  exit 0
fi

if [[ "$USE_REBASE" -eq 1 ]]; then
  echo "rebasing ${LOCAL_BRANCH} onto ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} (${upstream_sha:0:12})..."
  run git checkout "$LOCAL_BRANCH"
  run git rebase "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
else
  echo "merging ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} (${upstream_sha:0:12}) into ${LOCAL_BRANCH}..."
  run git checkout "$LOCAL_BRANCH"
  run git merge --no-edit "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
fi

echo "sync complete: ${LOCAL_BRANCH} now includes ${upstream_sha:0:12}"
