#!/usr/bin/env bash
# Calls against the OmniPay settlement contract v2 (Testnet).
# Usage: ./05-invoke.sh get <request_id>
#        ./05-invoke.sh simulate <request_id> <from_identity> <to_G_address> <token|native> <amount_stroops>
#        ./05-invoke.sh settle <request_id> <from_identity> <to_G_address> <token|native> <amount_stroops>
# simulate runs the same call without submitting a transaction.
# The contract defaults to the "v2" entry in the deployment manifest.
# Override with INVOKE_CONTRACT_ID. "native" means the Testnet XLM token contract.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh; source ./lib.sh

TARGET_ID="$(resolve_target_id)"

usage() {
  echo "usage: $0 get <request_id>"
  echo "       $0 simulate <request_id> <from_identity> <to_address> <token|native> <amount_stroops>"
  echo "       $0 settle <request_id> <from_identity> <to_address> <token|native> <amount_stroops>"
  exit 1
}

settle_args() {
  require_stroops "amount" "$6"
  TOKEN="$5"; [ "$TOKEN" = "native" ] && TOKEN="$NATIVE_TOKEN"
  FROM=$(stellar keys address "$3")
}

case "${1:-}" in
  get)
    [ $# -eq 2 ] || usage
    stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- \
      get --request_id "$2" ;;
  simulate)
    [ $# -eq 6 ] || usage
    shift; set -- x "$@"; settle_args "$@"
    echo "Simulation only. No transaction is submitted."
    stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$3" --send=no -- \
      settle --request_id "$2" --from "$FROM" --to "$4" --token "$TOKEN" --amount "$6" ;;
  settle)
    [ $# -eq 6 ] || usage
    settle_args "$@"
    stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$3" -- \
      settle --request_id "$2" --from "$FROM" --to "$4" --token "$TOKEN" --amount "$6" ;;
  *) usage ;;
esac
