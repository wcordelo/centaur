# shellcheck shell=bash
# Resolve which Slack bot stack is deployed (v1 slackbot vs v2 slackbotv2).
#
# Usage (after sourcing):
#   CENTAUR_RELEASE="${CENTAUR_RELEASE:-centaur}"
#   CENTAUR_NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
#   svc="$(centaur_slackbot_service_name)" || exit 1

centaur_release_name() {
  printf '%s' "${CENTAUR_RELEASE:-centaur}"
}

centaur_slackbot_v1_service() {
  printf '%s-centaur-slackbot' "$(centaur_release_name)"
}

centaur_slackbot_v2_service() {
  printf '%s-centaur-slackbotv2' "$(centaur_release_name)"
}

centaur_api_rs_service() {
  printf '%s-centaur-api-rs' "$(centaur_release_name)"
}

# Prints the in-cluster Service name for the active slackbot (v2 preferred).
centaur_slackbot_service_name() {
  local ns="${CENTAUR_NAMESPACE:-centaur}"
  local v2 v1
  v2="$(centaur_slackbot_v2_service)"
  v1="$(centaur_slackbot_v1_service)"
  if kubectl -n "$ns" get "svc/$v2" >/dev/null 2>&1; then
    printf '%s' "$v2"
  elif kubectl -n "$ns" get "svc/$v1" >/dev/null 2>&1; then
    printf '%s' "$v1"
  else
    echo "FATAL: no slackbot service in namespace $ns (expected $v2 or $v1)" >&2
    return 1
  fi
}

centaur_slack_stack_label() {
  local svc
  svc="$(centaur_slackbot_service_name)" || return 1
  if [[ "$svc" == "$(centaur_slackbot_v2_service)" ]]; then
    printf 'v2'
  else
    printf 'v1'
  fi
}
