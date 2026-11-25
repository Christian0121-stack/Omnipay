#!/usr/bin/env bash
# Prints a Markdown evidence draft for contract v2 on Testnet. Read-only.
# Usage: ./10-export-evidence.sh [request_id ...] > ../docs/evidence-draft.md
# With no request IDs, week1-test-001 to week1-test-003 are used.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh; source ./lib.sh

TARGET_ID="$(resolve_target_id)"
EXPLORER="https://stellar.expert/explorer/testnet"
[ $# -gt 0 ] && IDS=("$@") || IDS=(week1-test-001 week1-test-002 week1-test-003)

invoke() {
  with_retry stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- "$@" 2>/dev/null
}

VERSION=$(invoke version | tr -d '"[:space:]' || true)
CONFIG=$(invoke config || true)

cfg() {
  printf '%s' "$CONFIG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];console.log(v===undefined?"unknown":v)}catch(e){console.log("unknown")}})' "$1"
}

echo "# Contract v2 Evidence Draft"
echo
echo "Network: Stellar Testnet"
echo
echo "## Contract"
echo
echo "- Contract ID: $TARGET_ID"
echo "- Contract: $EXPLORER/contract/$TARGET_ID"
echo "- Version: ${VERSION:-unknown}"
echo "- Admin: $(cfg admin)"
echo "- Paused: $(cfg paused)"
echo "- Cap: $(cfg cap) stroops (0 = no cap)"
echo
echo "## Settlement records"
echo
echo "| Request ID | Amount (XLM) | Recorded (UTC) | Settled |"
echo "| --- | --- | --- | --- |"
for id in "${IDS[@]}"; do
  record=$(invoke get --request_id "$id" || true)
  settled=$(invoke is_settled --request_id "$id" | tr -d '"[:space:]' || true)
  row=$(printf '%s' "$record" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const x=Number(BigInt(r.amount))/1e7;const t=new Date(Number(r.recorded_at)*1000).toISOString().replace("T"," ").slice(0,19);console.log(x+"|"+t)}catch(e){console.log("not found|not found")}})')
  echo "| $id | ${row%%|*} | ${row##*|} | ${settled:-unknown} |"
done
echo
echo "Transaction links are added by hand from the explorer."
