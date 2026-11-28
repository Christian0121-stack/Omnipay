#!/usr/bin/env bash
# Read-only walkthrough of the OmniPay settlement contract v2 on Testnet.
# Usage: ./09-demo.sh [--no-pause]
#        DEMO_TO=<G address> ./09-demo.sh     (also simulates a repeated request)
# Nothing is submitted to the network.
set -uo pipefail; cd "$(dirname "$0")"; source ./env.sh; source ./lib.sh

PAUSE=1
[ "${1:-}" = "--no-pause" ] && PAUSE=0
[ -t 0 ] || PAUSE=0

TARGET_ID="$(resolve_target_id)"
EXPLORER="https://stellar.expert/explorer/testnet"
REQUESTS=(week1-test-001 week1-test-002 week1-test-003)
TX_LINKS=(
  "settle 1|8aef71d91c31c2835f15b22ea1cb429bc6133efeb141581c4042a1efbec1e062"
  "settle 2|12ceb3de22a52c920c6af89a69a2a89716cb144c6c54a95d12eddfa3deb50db1"
  "settle 3|5d120db0182f5aebb22a52d0bc9732656de9ce566a037497065c18dceeec9429"
  "pause|88cfeef44b6483028164aeb61e7d42961f98073699681aa3ee4eadecea6b4444"
  "unpause|e1e3e3bf04ec4b1b77c234d7425d987a6d408a5c6409e3d16752da85687f3d18"
)

heading() {
  echo
  echo "=== $1"
  if [ "$PAUSE" = "1" ]; then read -r -p "Press Enter to run... " _ || true; fi
}

heading "1. Contract status"
./08-status.sh

heading "2. Settlement records"
for id in "${REQUESTS[@]}"; do
  echo "--- $id"
  with_retry stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- get --request_id "$id" 2>/dev/null || echo "not found"
  echo -n "settled: "
  with_retry stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- is_settled --request_id "$id" 2>/dev/null || echo "unknown"
done

if [ -n "${DEMO_TO:-}" ]; then
  heading "3. Replay protection (simulation only)"
  echo "Simulating a repeated request ID: ${REQUESTS[0]}"
  out=$(./05-invoke.sh simulate "${REQUESTS[0]}" "$SOURCE_IDENTITY" "$DEMO_TO" native 10000000 2>&1 || true)
  echo "$out" | tail -n 5
  if echo "$out" | grep -Eq 'Error\(Contract, #2\)|AlreadyRecorded'; then
    echo "Result: rejected as AlreadyRecorded (#2)"
  else
    echo "Result: not rejected as expected, check the output above"
  fi
fi

heading "Explorer links"
echo "Contract: $EXPLORER/contract/$TARGET_ID"
for item in "${TX_LINKS[@]}"; do
  echo "${item%%|*}: $EXPLORER/tx/${item##*|}"
done
