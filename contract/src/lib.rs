#![no_std]
//! OmniPay settlement contract v2 (Stellar Testnet).
//!
//! v1 only *recorded* a payment that was made separately on Horizon.
//! v2 moves the value itself through the Stellar Asset Contract (SAC) and writes
//! the settlement record in the SAME transaction. If any step fails, everything reverts.
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env, String,
};

const LEDGERS_PER_DAY: u32 = 17_280;
const RECORD_TTL_THRESHOLD: u32 = 7 * LEDGERS_PER_DAY;
const RECORD_TTL_EXTEND_TO: u32 = 30 * LEDGERS_PER_DAY;
const INSTANCE_TTL_THRESHOLD: u32 = 7 * LEDGERS_PER_DAY;
const INSTANCE_TTL_EXTEND_TO: u32 = 30 * LEDGERS_PER_DAY;

pub const CONTRACT_VERSION: u32 = 2;

/// Error codes. Numbers 1-3 are unchanged from v1 (the Relay matches on #2).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    AlreadyRecorded = 2,
    SameParty = 3,
    Paused = 4,
    OverCap = 5,
    NotAdmin = 6,
    NotInitialized = 7,
    AlreadyInitialized = 8,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub from: Address,
    pub to: Address,
    pub token: Address,
    pub amount: i128,
    pub recorded_at: u64,
}

/// Public configuration returned by `config()`. A cap of 0 means "no cap".
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub paused: bool,
    pub cap: i128,
}

/// Data payload of the `settled` event (topics: "settled", from, to).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettledEvent {
    pub request_id: String,
    pub token: Address,
    pub amount: i128,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
    Cap,
    Settlement(String),
}

#[contract]
pub struct SettlementContract;

fn admin_of(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

/// The caller must authorize AND be the stored admin.
fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    if *caller != admin_of(env)? {
        return Err(Error::NotAdmin);
    }
    Ok(())
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

#[contractimpl]
impl SettlementContract {
    // ----- setup & admin -------------------------------------------------

    /// One-time setup. Sets the admin; starts unpaused with no cap.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Cap, &0i128);
        bump_instance(&env);
        env.events().publish((symbol_short!("init"),), admin);
        Ok(())
    }

    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        bump_instance(&env);
        env.events().publish((symbol_short!("paused"),), caller);
        Ok(())
    }

    pub fn unpause(env: Env, caller: Address) -> Result<(), Error> {
        require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        bump_instance(&env);
        env.events().publish((symbol_short!("unpaused"),), caller);
        Ok(())
    }

    /// Per-transaction cap in stroops. 0 disables the cap.
    pub fn set_cap(env: Env, caller: Address, cap: i128) -> Result<(), Error> {
        require_admin(&env, &caller)?;
        if cap < 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage().instance().set(&DataKey::Cap, &cap);
        bump_instance(&env);
        env.events().publish((symbol_short!("cap_set"),), cap);
        Ok(())
    }

    pub fn set_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), Error> {
        require_admin(&env, &caller)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        bump_instance(&env);
        env.events()
            .publish((symbol_short!("admin_set"), caller), new_admin);
        Ok(())
    }

    /// Replace this contract's Wasm in place (same contract ID). Admin only.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        require_admin(&env, &caller)?;
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events().publish((symbol_short!("upgraded"),), new_wasm_hash);
        Ok(())
    }

    // ----- settlement ----------------------------------------------------

    /// Atomic settlement: transfer `amount` of `token` from -> to through the SAC and
    /// record the Request ID, all in one transaction.
    pub fn settle(
        env: Env,
        request_id: String,
        from: Address,
        to: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), Error> {
        from.require_auth();

        let admin_set = env.storage().instance().has(&DataKey::Admin);
        if !admin_set {
            return Err(Error::NotInitialized);
        }
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            return Err(Error::Paused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if from == to {
            return Err(Error::SameParty);
        }
        let cap: i128 = env.storage().instance().get(&DataKey::Cap).unwrap_or(0);
        if cap > 0 && amount > cap {
            return Err(Error::OverCap);
        }

        let key = DataKey::Settlement(request_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRecorded);
        }

        // Record first, then move the value. A failed transfer reverts the whole tx,
        // including this record.
        let record = Settlement {
            from: from.clone(),
            to: to.clone(),
            token: token.clone(),
            amount,
            recorded_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, RECORD_TTL_THRESHOLD, RECORD_TTL_EXTEND_TO);

        token::Client::new(&env, &token).transfer(&from, &to, &amount);

        bump_instance(&env);
        env.events().publish(
            (symbol_short!("settled"), from, to),
            SettledEvent {
                request_id,
                token,
                amount,
            },
        );
        Ok(())
    }

    // ----- views ---------------------------------------------------------

    pub fn get(env: Env, request_id: String) -> Option<Settlement> {
        env.storage()
            .persistent()
            .get(&DataKey::Settlement(request_id))
    }

    pub fn is_settled(env: Env, request_id: String) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Settlement(request_id))
    }

    pub fn config(env: Env) -> Result<Config, Error> {
        Ok(Config {
            admin: admin_of(&env)?,
            paused: env
                .storage()
                .instance()
                .get(&DataKey::Paused)
                .unwrap_or(false),
            cap: env.storage().instance().get(&DataKey::Cap).unwrap_or(0),
        })
    }

    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }
}

#[cfg(test)]
mod test;