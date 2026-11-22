#!/usr/bin/env bash
# Checks tools, the wasm target and the deploy identity (public key only).
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh
echo "== Tools =="; stellar --version | head -1; rustc --version; cargo --version; node --version
echo "== Wasm target =="
if rustup target list --installed | grep -q wasm32v1-none; then echo "wasm32v1-none: OK"
else echo "Missing. Run: rustup target add wasm32v1-none"; exit 1; fi
echo "== Identity: $SOURCE_IDENTITY =="
ADDR=$(stellar keys address "$SOURCE_IDENTITY"); echo "Public key: $ADDR"
echo "== Funded on $NETWORK? =="
if stellar keys fund "$SOURCE_IDENTITY" --network "$NETWORK" >/dev/null 2>&1; then echo "Funded / already funded"
else echo "Could not fund via friendbot (may already exist). Check on $EXPLORER/account/$ADDR"; fi
