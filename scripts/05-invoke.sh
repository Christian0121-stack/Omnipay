#!/usr/bin/env bash
# Read-only / test calls against the contract.
# Usage: ./05-invoke.sh get <request_id>
#        ./05-invoke.sh settle <request_id> <from_identity> <to_G_address> <amount_stroops>
set -euo pipefail; cd "$(dirname "$0")"; source ./env.sh
case "${1:-}" in
  get) stellar contract invoke --id "$CONTRACT_ID" --network "$NETWORK" --source "$SOURCE_IDENTITY" --send=no -- get --request_id "$2" ;;
  settle) FROM=$(stellar keys address "$3")
    stellar contract invoke --id "$CONTRACT_ID" --network "$NETWORK" --source "$3" -- settle \
      --request_id "$2" --from "$FROM" --to "$4" --amount "$5" ;;
  *) echo "usage: $0 get <id> | settle <id> <from_identity> <to_address> <stroops>"; exit 1 ;;
esac
