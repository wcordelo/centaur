#!/usr/bin/env bash
# Resolve the latest stable LiteLLM release tag from GitHub (excludes -dev prereleases).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version_file="${repo_root}/contrib/litellm/VERSION"
values_yaml="${repo_root}/contrib/chart/values.yaml"
write=0

usage() {
  cat <<'EOF'
Usage: litellm-resolve-version.sh [--write]

  Print the latest stable LiteLLM tag (e.g. v1.90.0).

  --write  Update contrib/litellm/VERSION and contrib/chart/values.yaml litellm.image.tag.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write) write=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

latest="$(
  curl -fsSL "https://api.github.com/repos/BerriAI/litellm/releases?per_page=30" \
    | python3 -c "
import json, re, sys
releases = json.load(sys.stdin)
stable = [
    r['tag_name']
    for r in releases
    if not r.get('prerelease') and re.fullmatch(r'v\d+\.\d+\.\d+', r['tag_name'])
]
if not stable:
    raise SystemExit('no stable LiteLLM releases found')
print(stable[0])
"
)"

if [[ "$write" -eq 1 ]]; then
  printf '%s\n' "$latest" >"$version_file"
  python3 - "$values_yaml" "$latest" <<'PY'
import pathlib, re, sys
path, tag = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
pattern = re.compile(
    r"(^litellm:\n(?:  .*\n)*?  image:\n(?:    .*\n)*?    tag:\s*)v[\d.]+",
    re.MULTILINE,
)
new_text, n = pattern.subn(rf"\g<1>{tag}", text, count=1)
if n != 1:
    raise SystemExit(f"could not update litellm.image.tag in {path}")
path.write_text(new_text)
PY
  echo "Updated LiteLLM pin to ${latest}"
else
  echo "$latest"
fi
