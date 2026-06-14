# Shared helpers for locating local secret files.
# Source from contrib/scripts/*.sh after setting REPO_ROOT.

resolve_centaur_env_file() {
  local repo_root="${1:-}"

  if [[ -n "${CENTAUR_ENV_FILE:-}" ]]; then
    printf '%s\n' "$CENTAUR_ENV_FILE"
    return 0
  fi

  local candidates=()
  if [[ -n "$repo_root" ]]; then
    candidates+=("$repo_root/.env" "$repo_root/../.env")
  fi
  candidates+=("$(pwd)/.env")

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

resolve_centaur_extra_values() {
  local repo_root="${1:-}"

  if [[ -n "${CENTAUR_EXTRA_VALUES:-}" ]]; then
    printf '%s\n' "$CENTAUR_EXTRA_VALUES"
    return 0
  fi

  if [[ -n "$repo_root" && -f "$repo_root/contrib/chart/values.local-slack.example.yaml" ]]; then
    printf '%s\n' "$repo_root/contrib/chart/values.local-slack.example.yaml"
    return 0
  fi

  return 1
}
