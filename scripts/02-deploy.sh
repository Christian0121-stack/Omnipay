#!/usr/bin/env bash
# Deploys the built wasm to Testnet and appends an entry to the deployment manifest.
# Usage: ./02-deploy.sh <label>      e.g. ./02-deploy.sh v1-redeploy
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh
LABEL="${1:?Give a label, e.g. v2-draft}"
OPT="${WASM_PATH%.wasm}.optimized.wasm"; [ -f "$OPT" ] && WASM_PATH="$OPT"
test -f "$WASM_PATH" || { echo "Run ./01-build.sh first"; exit 1; }
LOG=$(mktemp)
echo "Uploading wasm..."
WASM_HASH=$(stellar contract upload --wasm "$WASM_PATH" --source "$SOURCE_IDENTITY" --network "$NETWORK" 2> >(tee -a "$LOG" >&2) | tail -1)
echo "Deploying..."
NEW_ID=$(stellar contract deploy --wasm-hash "$WASM_HASH" --source "$SOURCE_IDENTITY" --network "$NETWORK" 2> >(tee -a "$LOG" >&2) | tail -1)
TX=$(grep -oE 'tx/[0-9a-f]{64}' "$LOG" | tail -1 | cut -d/ -f2 || true)
echo "Contract ID: $NEW_ID"; echo "Wasm hash  : $WASM_HASH"; echo "Tx hash    : ${TX:-not-captured}"
./03-manifest.sh add "$LABEL" "$NEW_ID" "$WASM_HASH" "${TX:-}" "$WASM_PATH"
echo "Explorer: $EXPLORER/contract/$NEW_ID"
