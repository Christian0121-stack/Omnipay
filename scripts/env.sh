#!/usr/bin/env bash
# OmniPay - shared config for the Stellar CLI scripts (Testnet only)
# Edit SOURCE_IDENTITY if your deploy identity has another name.
export NETWORK="testnet"
export SOURCE_IDENTITY="${SOURCE_IDENTITY:-deployer-w3}"
export CONTRACT_DIR="${CONTRACT_DIR:-../contract}"          # folder with Cargo.toml
export WASM_NAME="omnipay_settlement"                       # from Cargo.toml: omnipay-settlement
export WASM_PATH="$CONTRACT_DIR/target/wasm32v1-none/release/${WASM_NAME}.wasm"
export MANIFEST="${MANIFEST:-../deployments/testnet.json}"
export V1_CONTRACT_ID="CCR4IAHHPOKX6SEM2ED5N5AKIO4QRBEJ7AA5UH4LZYBUTRAIH7XTD6TH"
export CONTRACT_ID="${CONTRACT_ID:-$V1_CONTRACT_ID}"
export EXPLORER="https://stellar.expert/explorer/testnet"
# Safety: never print secrets. Only public addresses are shown.
