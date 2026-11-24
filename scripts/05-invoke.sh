#!/usr/bin/env bash
# Calls against the OmniPay settlement contract v2 (Testnet).
# Usage: ./05-invoke.sh get <request_id>
#        ./05-invoke.sh settle <request_id> <from_identity> <to_G_address> <token|native> <amount_stroops>
# The contract defaults to the "v2" entry in the deployment manifest.
# Override with INVOKE_CONTRACT_ID. "native" means the Testnet XLM token contract.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh

V2_FALLBACK_ID="CB6MGNV7JM7HFP6AUBMLQMK42P3MTBKLLRF577ZWKIXG4UIIGEJ3TPAM"
NATIVE_TOKEN="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

manifest_v2_id() {
  [ -f "$MANIFEST" ] || return 0
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const d=(m.deployments||[]).filter(x=>x.label==="v2").pop();if(d)console.log(d.contractId)' "$MANIFEST" 2>/dev/null || true
}

TARGET_ID="${INVOKE_CONTRACT_ID:-$(manifest_v2_id)}"
TARGET_ID="${TARGET_ID:-$V2_FALLBACK_ID}"

usage() {
  echo "usage: $0 get <request_id>"
  echo "       $0 settle <request_id> <from_identity> <to_address> <token|native> <amount_stroops>"
  exit 1
}

case "${1:-}" in
  get)
    [ $# -eq 2 ] || usage
    stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- \
      get --request_id "$2" ;;
  settle)
    [ $# -eq 6 ] || usage
    [[ "$6" =~ ^[0-9]+$ ]] || { echo "amount must be a whole number of stroops"; exit 1; }
    TOKEN="$5"; [ "$TOKEN" = "native" ] && TOKEN="$NATIVE_TOKEN"
    FROM=$(stellar keys address "$3")
    stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$3" -- \
      settle --request_id "$2" --from "$FROM" --to "$4" --token "$TOKEN" --amount "$6" ;;
  *) usage ;;
esac