#!/usr/bin/env bash
# Appends/updates the deployment manifest (public data only).
# Usage: ./03-manifest.sh add <label> <contract_id> <wasm_hash> <tx_hash> <wasm_path>
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh
[ "${1:-}" = "add" ] || { echo "usage: $0 add <label> <contract_id> <wasm_hash> <tx_hash> <wasm_path>"; exit 1; }
shift
COMMIT=$(git -C "$CONTRACT_DIR" rev-parse --short HEAD 2>/dev/null || echo "n/a")
ADDR=$(stellar keys address "$SOURCE_IDENTITY")
M="$MANIFEST" LABEL="$1" CID="$2" WH="$3" TX="$4" WP="$5" COMMIT="$COMMIT" ADDR="$ADDR" NET="$NETWORK" EXP="$EXPLORER" \
node -e '
const fs=require("fs"),e=process.env;
let m={network:e.NET,passphrase:"Test SDF Network ; September 2015",rpc:"https://soroban-testnet.stellar.org",deployments:[]};
if(fs.existsSync(e.M)) m=JSON.parse(fs.readFileSync(e.M,"utf8"));
m.deployments.push({label:e.LABEL,contractId:e.CID,wasmHash:e.WH,deployTxHash:e.TX||null,
 deployer:e.ADDR,wasmFile:require("path").basename(e.WP),gitCommit:e.COMMIT,
 deployedAt:new Date().toISOString(),
 explorer:{contract:`${e.EXP}/contract/${e.CID}`,tx:e.TX?`${e.EXP}/tx/${e.TX}`:null}});
fs.mkdirSync(require("path").dirname(e.M),{recursive:true});
fs.writeFileSync(e.M,JSON.stringify(m,null,2)+"\n");
console.log("Manifest updated:",e.M);'
