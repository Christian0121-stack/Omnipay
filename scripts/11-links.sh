#!/usr/bin/env bash
# Prints Stellar Expert links for the contracts and transactions in the manifest.
# Usage: ./11-links.sh
# Read-only. Nothing is sent to the network.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh

[ -f "$MANIFEST" ] || { echo "manifest not found at $MANIFEST"; exit 1; }

node - "$MANIFEST" <<'JS'
const fs = require('fs');
const base = 'https://stellar.expert/explorer/testnet';
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const hex = /^[0-9a-f]{64}$/i;
(m.deployments || []).forEach((d) => {
  console.log('== ' + (d.label || 'unnamed'));
  if (d.contractId) console.log('contract  ' + base + '/contract/' + d.contractId);
  Object.keys(d).forEach((key) => {
    if (/wasm/i.test(key)) return;
    if (hex.test(String(d[key]))) console.log(key.padEnd(9) + ' ' + base + '/tx/' + d[key]);
  });
  console.log('');
});
JS
