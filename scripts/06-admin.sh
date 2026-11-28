#!/usr/bin/env bash
# Admin and read helpers for the OmniPay settlement contract v2 (Testnet).
# Usage: ./06-admin.sh config
#        ./06-admin.sh version
#        ./06-admin.sh is-settled <request_id>
#        ./06-admin.sh pause [--yes] [--dry-run]
#        ./06-admin.sh unpause [--yes] [--dry-run]
#        ./06-admin.sh set-cap <amount_stroops> [--yes] [--dry-run]     (0 = no cap)
# Pause, unpause and set-cap ask for confirmation. Add --yes to skip the prompt.
# Add --dry-run to print the command without running it.
# The contract defaults to the "v2" entry in the deployment manifest.
# Override with INVOKE_CONTRACT_ID. Admin commands are signed by SOURCE_IDENTITY.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh; source ./lib.sh

TARGET_ID="$(resolve_target_id)"
strip_flags "$@"
set -- ${ARGS[@]+"${ARGS[@]}"}

usage() {
  echo "usage: $0 config | version | is-settled <request_id>"
  echo "       $0 pause | unpause | set-cap <amount_stroops>   (add --yes to skip the prompt, --dry-run to preview)"
  exit 1
}

read_call() {
  with_retry stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- "$@"
}

admin_call() {
  local caller; caller=$(stellar keys address "$SOURCE_IDENTITY")
  local fn="$1"; shift
  if [ "$DRY_RUN" = "1" ]; then
    echo "Dry run. Nothing is submitted."
    echo "stellar contract invoke --id $TARGET_ID --network $NETWORK --source $SOURCE_IDENTITY -- $fn --caller $caller $*"
    return 0
  fi
  stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" -- \
    "$fn" --caller "$caller" "$@"
}

ask() {
  [ "$DRY_RUN" = "1" ] && return 0
  echo "Contract: $TARGET_ID"
  confirm "$1" || { echo "Cancelled."; exit 0; }
}

case "${1:-}" in
  config)     [ $# -eq 1 ] || usage; read_call config ;;
  version)    [ $# -eq 1 ] || usage; read_call version ;;
  is-settled) [ $# -eq 2 ] || usage; read_call is_settled --request_id "$2" ;;
  pause)      [ $# -eq 1 ] || usage; ask "Pause settlements on Testnet?"; admin_call pause ;;
  unpause)    [ $# -eq 1 ] || usage; ask "Unpause settlements on Testnet?"; admin_call unpause ;;
  set-cap)
    [ $# -eq 2 ] || usage
    require_stroops "cap" "$2"
    ask "Set the per-settlement cap to $2 stroops (0 = no cap)?"
    admin_call set_cap --cap "$2" ;;
  *) usage ;;
esac