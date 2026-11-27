#!/usr/bin/env bash
# Read-only status summary of the OmniPay settlement contract v2 (Testnet).
# Usage: ./08-status.sh
# Uses the "v2" entry in the manifest. Override with INVOKE_CONTRACT_ID.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh; source ./lib.sh

TARGET_ID="$(resolve_target_id)"
EXPLORER="https://stellar.expert/explorer/testnet/contract/$TARGET_ID"

read_call() {
  with_retry stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- "$@" 2>/dev/null
}

VERSION=$(read_call version | tr -d '"[:space:]' || true)
CONFIG=$(read_call config || true)

field() {
  printf '%s' "$CONFIG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];console.log(v===undefined?"unknown":v)}catch(e){console.log("unknown")}})' "$1"
}

echo "Contract:  $TARGET_ID"
echo "Network:   $NETWORK"
echo "Version:   ${VERSION:-unknown}"
if [ -n "$CONFIG" ]; then
  echo "Admin:     $(field admin)"
  echo "Paused:    $(field paused)"
  echo "Cap:       $(field cap) stroops (0 = no cap)"
else
  echo "Config:    could not be read"
fi
echo "Explorer:  $EXPLORER"
