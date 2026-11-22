#!/usr/bin/env bash
# Fetches the wasm of an already-deployed contract (default: v1) and records its real hash in the manifest.
# Usage: ./04-verify-existing.sh [CONTRACT_ID]
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh
ID="${1:-$V1_CONTRACT_ID}"; OUT="$(mktemp -d)/onchain.wasm"
stellar contract fetch --id "$ID" --network "$NETWORK" --out-file "$OUT"
HASH=$(sha256sum "$OUT" | cut -d' ' -f1)
echo "On-chain wasm SHA256: $HASH"
./03-manifest.sh add "existing-$(date +%Y%m%d)" "$ID" "$HASH" "" "$OUT"
