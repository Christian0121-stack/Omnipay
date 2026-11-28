#!/usr/bin/env bash
# Read-only check that the contract on Testnet matches the deployment manifest.
# Usage: ./07-verify-deployment.sh [--json]
# Uses the "v2" entry in the manifest. Override with INVOKE_CONTRACT_ID.
# Nothing is submitted to the network.
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh; source ./lib.sh

JSON=0
[ "${1:-}" = "--json" ] && JSON=1

TARGET_ID="$(resolve_target_id)"
MANIFEST_ID="$(manifest_v2_id)"
fail=0
match="skipped"

say() { [ "$JSON" = "1" ] || echo "$@"; }

say "Contract:  $TARGET_ID"
say "Network:   $NETWORK"

if [ -n "$MANIFEST_ID" ]; then
  if [ "$MANIFEST_ID" = "$TARGET_ID" ]; then say "PASS  contract ID matches the manifest"; match="true"
  else say "FAIL  contract ID differs from the manifest ($MANIFEST_ID)"; match="false"; fail=1; fi
else
  say "SKIP  no v2 entry in the manifest"
fi

VERSION=$(with_retry stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- version 2>/dev/null | tr -d '"[:space:]' || true)
if [ "$VERSION" = "2" ]; then say "PASS  version() returns 2"
else say "FAIL  version() returned '${VERSION:-nothing}', expected 2"; fail=1; fi

CONFIG=""
if CONFIG=$(with_retry stellar contract invoke --id "$TARGET_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- config 2>/dev/null); then
  say "PASS  config() is readable"
  say "$CONFIG"
else
  say "FAIL  config() could not be read"; fail=1
fi

if [ "$JSON" = "1" ]; then
  FAIL="$fail" MATCH="$match" VERSION="$VERSION" CONFIG="$CONFIG" TARGET_ID="$TARGET_ID" NETWORK="$NETWORK" node -e '
let cfg = {};
try { cfg = JSON.parse(process.env.CONFIG || "{}"); } catch (e) {}
console.log(JSON.stringify({
  ok: process.env.FAIL === "0",
  contractId: process.env.TARGET_ID,
  network: process.env.NETWORK,
  manifestMatch: process.env.MATCH,
  version: process.env.VERSION || null,
  admin: cfg.admin || null,
  paused: typeof cfg.paused === "boolean" ? cfg.paused : null,
  cap: cfg.cap !== undefined ? String(cfg.cap) : null
}));'
  [ "$fail" -eq 0 ] || exit 1
else
  [ "$fail" -eq 0 ] && echo "Result: OK" || { echo "Result: FAILED"; exit 1; }
fi
