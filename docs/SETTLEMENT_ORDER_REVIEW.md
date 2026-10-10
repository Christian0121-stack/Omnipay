# Settlement Order Review

## Order of operations
1. XLM payment is submitted and confirmed on Horizon.
2. The settlement is recorded on the Soroban contract using the same request ID.
3. Balances and transaction history are updated, and the relay record is marked settled.

## Failure cases
| Case | Result |
|---|---|
| Payment fails | No Soroban record is written. The relay record is marked failed. |
| Payment succeeds, Soroban record fails | Payment stays valid. The relay record stores `sorobanRecordStatus: failed` and the error, and the sender gets a warning event. |
| Soroban confirmation times out | Treated as failed for now. A later retry returns `AlreadyRecorded` if the first call landed, which is handled as already recorded. |
| Same request ID submitted twice | The contract returns `AlreadyRecorded`, so a record can never be duplicated. |

## Why payment goes first
The contract record is an audit trail of money that actually moved. Writing it before the payment could leave a record for a transfer that never happened. Writing it after means the worst case is a payment without a record, which can be retried safely because the request ID is idempotent.

## Known limitation
Records marked `failed` are not retried automatically yet. They stay visible in the relay records until a retry is run.

## Contract
- Network: Stellar Testnet
- Contract ID: `CAGJZAZP2JYN2SORQ2XNBX4KS33ATNSBHYVHQ2Y5U5FLERCKNSEUTG4I`
- Source: `contract/src/lib.rs`
