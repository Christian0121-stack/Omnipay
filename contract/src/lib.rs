#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String,
};

const TTL_THRESHOLD: u32 = 518_400;
const TTL_EXTEND_TO: u32 = 3_110_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    DuplicateRequest = 1,
    InvalidAmount = 2,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Request(String),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub sender: Address,
    pub recipient: Address,
    pub amount: i128,
    pub ledger: u32,
}

#[contract]
pub struct OmniPaySettlement;

#[contractimpl]
impl OmniPaySettlement {
    pub fn settle(
        env: Env,
        request_id: String,
        sender: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let key = DataKey::Request(request_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::DuplicateRequest);
        }

        sender.require_auth();

        let record = Settlement {
            sender,
            recipient,
            amount,
            ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        env.events()
            .publish((symbol_short!("settled"), request_id), amount);

        Ok(())
    }

    pub fn is_settled(env: Env, request_id: String) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Request(request_id))
    }

    pub fn get_settlement(env: Env, request_id: String) -> Option<Settlement> {
        env.storage()
            .persistent()
            .get(&DataKey::Request(request_id))
    }
}