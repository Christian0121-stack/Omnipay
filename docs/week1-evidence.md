# Sprint 2, Week 1 Evidence

Network: Stellar Testnet

## Contract v2

- Contract ID: CB6MGNV7JM7HFP6AUBMLQMK42P3MTBKLLRF577ZWKIXG4UIIGEJ3TPAM
- Contract: https://stellar.expert/explorer/testnet/contract/CB6MGNV7JM7HFP6AUBMLQMK42P3MTBKLLRF577ZWKIXG4UIIGEJ3TPAM
- Wasm hash: f002a6599adfd944cd983a401ff4a594aa8481d398f508a4e6d79d863178bf6d
- Version: 0.2.0

## Transactions

- initialize: https://stellar.expert/explorer/testnet/tx/cf97c00e9413dd7eef0f9231ef730ac2e521979ee9723b2c16644e57fa0d392f
- settle 1 (week1-test-001, 1 XLM): https://stellar.expert/explorer/testnet/tx/8aef71d91c31c2835f15b22ea1cb429bc6133efeb141581c4042a1efbec1e062
- settle 2 (week1-test-002, 2 XLM): https://stellar.expert/explorer/testnet/tx/12ceb3de22a52c920c6af89a69a2a89716cb144c6c54a95d12eddfa3deb50db1
- settle 3 (week1-test-003, 0.5 XLM): https://stellar.expert/explorer/testnet/tx/5d120db0182f5aebb22a52d0bc9732656de9ce566a037497065c18dceeec9429

## Replay protection

A repeated request ID was rejected with error AlreadyRecorded (#2).

## Admin controls

- pause: https://stellar.expert/explorer/testnet/tx/88cfeef44b6483028164aeb61e7d42961f98073699681aa3ee4eadecea6b4444
- unpause: https://stellar.expert/explorer/testnet/tx/e1e3e3bf04ec4b1b77c234d7425d987a6d408a5c6409e3d16752da85687f3d18

Both transactions succeeded and emitted the `paused` and `unpaused` events. After `unpause`, `config` reports `"paused":false`.

## Scripts

CLI scripts are in `scripts/`. The deployment manifest is `deployments/testnet.json`.

- `05-invoke.sh` calls `get` and `settle` on contract v2.
- `06-admin.sh` runs `config`, `version`, `is-settled`, `pause`, `unpause` and `set-cap` on contract v2.