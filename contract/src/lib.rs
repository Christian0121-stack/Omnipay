#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String,
};

const LEDGERS_PER_DAY: u32 = 17_280;
const RECORD_TTL_THRESHOLD: u32 = 7 * LEDGERS_PER_DAY;
const RECORD_TTL_EXTEND_TO: u32 = 30 * LEDGERS_PER_DAY;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    AlreadyRecorded = 2,
    SameParty = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub from: Address,
    pub to: Address,
    pub amount: i128,
    pub recorded_at: u64,
}

#[contracttype]
pub enum DataKey {
    Settlement(String),
}

#[contract]
pub struct SettlementContract;

#[contractimpl]
impl SettlementContract {
    pub fn settle(
        env: Env,
        request_id: String,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        from.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        if from == to {
            return Err(Error::SameParty);
        }

        let key = DataKey::Settlement(request_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRecorded);
        }

        let record = Settlement {
            from: from.clone(),
            to: to.clone(),
            amount,
            recorded_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, RECORD_TTL_THRESHOLD, RECORD_TTL_EXTEND_TO);

        env.events()
            .publish((symbol_short!("settled"), from, to), amount);

        Ok(())
    }

    pub fn get(env: Env, request_id: String) -> Option<Settlement> {
        env.storage()
            .persistent()
            .get(&DataKey::Settlement(request_id))
    }
}

#[cfg(test)]
mod test;