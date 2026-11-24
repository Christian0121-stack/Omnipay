#!/usr/bin/env bash
# Admin and read helpers for the OmniPay settlement contract v2 (Testnet).
# Usage: ./06-admin.sh config
#        ./06-admin.sh version
#        ./06-admin.sh is-settled <request_id>
#        ./06-admin.sh pause
#        ./06-admin.sh unpause
#        ./06-admin.sh set-cap <amount_stroops>     (0 = no cap)
# The contract defaults to the "v2" entry in the deployment manifest.
# Override with INVOKE_CONTRACT_ID. Admin commands are signed by SOURCE_IDENTITY.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh

V2_FALLBACK_ID="CB6MGNV7JM7HFP6AUBMLQMK42P3MTBKLLRF577ZWKIXG4UIIGEJ3TPAM"

manifest_v2_id() {
  [ -f "$MANIFEST" ] || return 0
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const d=(m.deployments||[]).filter(x=>x.label==="v2").pop();if(d)console.log(d.contractId)' "$MANIFEST" 2>/dev/null || true
}

TARGET_ID="${INVOKE_CONTRACT_ID:-$(manifest_v2_id)}"
TARGET_ID="${TARGET_ID:-$V2_FALLBACK_ID}"

usage() {
  echo "usage: $0 config | version | is-settled <request_id>"
  echo "       $0 pause | unpause | set-cap <amount_stroops>"
  exit 1
}

read_call() {
  stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- "$@"
}

admin_call() {
  local caller; caller=$(stellar keys address "$SOURCE_IDENTITY")
  local fn="$1"; shift
  stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" -- \
    "$fn" --caller "$caller" "$@"
}

case "${1:-}" in
  config)     [ $# -eq 1 ] || usage; read_call config ;;
  version)    [ $# -eq 1 ] || usage; read_call version ;;
  is-settled) [ $# -eq 2 ] || usage; read_call is_settled --request_id "$2" ;;
  pause)      [ $# -eq 1 ] || usage; admin_call pause ;;
  unpause)    [ $# -eq 1 ] || usage; admin_call unpause ;;
  set-cap)
    [ $# -eq 2 ] || usage
    [[ "$2" =~ ^[0-9]+$ ]] || { echo "cap must be a whole number of stroops (0 = no cap)"; exit 1; }
    admin_call set_cap --cap "$2" ;;
  *) usage ;;
esac