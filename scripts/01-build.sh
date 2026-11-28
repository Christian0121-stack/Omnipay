#!/usr/bin/env bash
# Runs the tests, builds the optimized wasm and prints its SHA-256.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh
( cd "$CONTRACT_DIR" && cargo test && stellar contract build )
test -f "$WASM_PATH" || { echo "wasm not found at $WASM_PATH"; exit 1; }
( stellar contract optimize --wasm "$WASM_PATH" >/dev/null 2>&1 || true )
OPT="${WASM_PATH%.wasm}.optimized.wasm"; [ -f "$OPT" ] && WASM_PATH="$OPT"
echo "Wasm : $WASM_PATH"
echo "Size : $(wc -c < "$WASM_PATH") bytes"
echo "SHA256: $(sha256sum "$WASM_PATH" | cut -d' ' -f1)"
