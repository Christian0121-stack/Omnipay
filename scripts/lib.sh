#!/usr/bin/env bash
# Shared helpers for the OmniPay CLI scripts. Source after env.sh.
V2_FALLBACK_ID="CB6MGNV7JM7HFP6AUBMLQMK42P3MTBKLLRF577ZWKIXG4UIIGEJ3TPAM"
NATIVE_TOKEN="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

manifest_v2_id() {
  [ -f "$MANIFEST" ] || return 0
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const d=(m.deployments||[]).filter(x=>x.label==="v2").pop();if(d)console.log(d.contractId)' "$MANIFEST" 2>/dev/null || true
}

resolve_target_id() {
  local id="${INVOKE_CONTRACT_ID:-$(manifest_v2_id)}"
  echo "${id:-$V2_FALLBACK_ID}"
}

require_stroops() {
  local label="$1" value="$2"
  [[ "$value" =~ ^[0-9]{1,30}$ ]] || { echo "$label must be a whole number of stroops"; exit 1; }
}

strip_yes_flag() {
  ASSUME_YES=0
  ARGS=()
  local a
  for a in "$@"; do
    if [ "$a" = "--yes" ]; then ASSUME_YES=1; else ARGS+=("$a"); fi
  done
}

confirm() {
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  local answer=""
  read -r -p "$1 [y/N] " answer || answer=""
  [[ "$answer" =~ ^[Yy]$ ]]
}
