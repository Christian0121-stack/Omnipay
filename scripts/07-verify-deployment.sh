#!/usr/bin/env bash
# Read-only check that the contract on Testnet matches the deployment manifest.
# Usage: ./07-verify-deployment.sh
# Uses the "v2" entry in the manifest. Override with INVOKE_CONTRACT_ID.
# Nothing is submitted to the network.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh; source ./lib.sh

TARGET_ID="$(resolve_target_id)"
MANIFEST_ID="$(manifest_v2_id)"
fail=0

echo "Contract:  $TARGET_ID"
echo "Network:   $NETWORK"

if [ -n "$MANIFEST_ID" ]; then
  if [ "$MANIFEST_ID" = "$TARGET_ID" ]; then echo "PASS  contract ID matches the manifest"
  else echo "FAIL  contract ID differs from the manifest ($MANIFEST_ID)"; fail=1; fi
else
  echo "SKIP  no v2 entry in the manifest"
fi

VERSION=$(stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- version 2>/dev/null | tr -d '"[:space:]' || true)
if [ "$VERSION" = "2" ]; then echo "PASS  version() returns 2"
else echo "FAIL  version() returned '${VERSION:-nothing}', expected 2"; fail=1; fi

if CONFIG=$(stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- config 2>/dev/null); then
  echo "PASS  config() is readable"
  echo "$CONFIG"
else
  echo "FAIL  config() could not be read"; fail=1
fi

[ "$fail" -eq 0 ] && echo "Result: OK" || { echo "Result: FAILED"; exit 1; }