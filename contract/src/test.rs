#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, FromVal, String, Symbol,
};

const START: i128 = 10_000_000_000; // 1,000 XLM in stroops

struct Ctx {
    env: Env,
    client: SettlementContractClient<'static>,
    admin: Address,
    from: Address,
    to: Address,
    token: Address,
}

impl Ctx {
    fn tok(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token)
    }
    fn id(&self, s: &str) -> String {
        String::from_str(&self.env, s)
    }
}

/// Contract initialized, `from` funded with START of a SAC token.
fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(SettlementContract, ());
    let client = SettlementContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();
    StellarAssetClient::new(&env, &token).mint(&from, &START);
    client.initialize(&admin);
    Ctx { env, client, admin, from, to, token }
}

// ---------- initialize ----------

#[test]
fn initialize_sets_defaults() {
    let c = setup();
    let cfg = c.client.config();
    assert_eq!(cfg.admin, c.admin);
    assert!(!cfg.paused);
    assert_eq!(cfg.cap, 0);
}

#[test]
fn initialize_twice_fails() {
    let c = setup();
    assert_eq!(
        c.client.try_initialize(&c.admin),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn settle_before_initialize_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(SettlementContract, ());
    let client = SettlementContractClient::new(&env, &id);
    let (a, b) = (Address::generate(&env), Address::generate(&env));
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    assert_eq!(
        client.try_settle(&String::from_str(&env, "r"), &a, &b, &sac.address(), &10),
        Err(Ok(Error::NotInitialized))
    );
}

// ---------- atomic settle ----------

#[test]
fn settle_moves_value_and_records() {
    let c = setup();
    c.client.settle(&c.id("req-1"), &c.from, &c.to, &c.token, &1_000_000);
    assert_eq!(c.tok().balance(&c.from), START - 1_000_000);
    assert_eq!(c.tok().balance(&c.to), 1_000_000);
    assert!(c.client.is_settled(&c.id("req-1")));
}

#[test]
fn settle_record_has_all_fields() {
    let c = setup();
    c.client.settle(&c.id("req-2"), &c.from, &c.to, &c.token, &500);
    let r = c.client.get(&c.id("req-2")).unwrap();
    assert_eq!(r.from, c.from);
    assert_eq!(r.to, c.to);
    assert_eq!(r.token, c.token);
    assert_eq!(r.amount, 500);
}

#[test]
fn duplicate_request_rejected_without_second_transfer() {
    let c = setup();
    c.client.settle(&c.id("req-3"), &c.from, &c.to, &c.token, &500);
    let second = c.client.try_settle(&c.id("req-3"), &c.from, &c.to, &c.token, &500);
    assert_eq!(second, Err(Ok(Error::AlreadyRecorded)));
    assert_eq!(c.tok().balance(&c.to), 500); // paid once only
}

#[test]
fn non_positive_amount_rejected() {
    let c = setup();
    assert_eq!(
        c.client.try_settle(&c.id("a"), &c.from, &c.to, &c.token, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        c.client.try_settle(&c.id("b"), &c.from, &c.to, &c.token, &-5),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn same_sender_and_recipient_rejected() {
    let c = setup();
    assert_eq!(
        c.client.try_settle(&c.id("s"), &c.from, &c.from, &c.token, &100),
        Err(Ok(Error::SameParty))
    );
}

#[test]
fn insufficient_balance_reverts_and_leaves_no_record() {
    let c = setup();
    let res = c.client.try_settle(&c.id("big"), &c.from, &c.to, &c.token, &(START + 1));
    assert!(res.is_err());
    assert!(!c.client.is_settled(&c.id("big"))); // atomic: no record without payment
    assert_eq!(c.tok().balance(&c.from), START);
    assert_eq!(c.tok().balance(&c.to), 0);
}

#[test]
fn unknown_request_returns_none_and_false() {
    let c = setup();
    assert!(c.client.get(&c.id("missing")).is_none());
    assert!(!c.client.is_settled(&c.id("missing")));
}

// ---------- pause ----------

#[test]
fn paused_contract_blocks_settle() {
    let c = setup();
    c.client.pause(&c.admin);
    assert!(c.client.config().paused);
    assert_eq!(
        c.client.try_settle(&c.id("p"), &c.from, &c.to, &c.token, &100),
        Err(Ok(Error::Paused))
    );
    assert_eq!(c.tok().balance(&c.from), START);
}

#[test]
fn unpause_restores_settle() {
    let c = setup();
    c.client.pause(&c.admin);
    c.client.unpause(&c.admin);
    c.client.settle(&c.id("u"), &c.from, &c.to, &c.token, &100);
    assert!(c.client.is_settled(&c.id("u")));
}

#[test]
fn non_admin_cannot_pause_or_unpause() {
    let c = setup();
    let other = Address::generate(&c.env);
    assert_eq!(c.client.try_pause(&other), Err(Ok(Error::NotAdmin)));
    assert_eq!(c.client.try_unpause(&other), Err(Ok(Error::NotAdmin)));
}

// ---------- cap ----------

#[test]
fn amount_over_cap_rejected() {
    let c = setup();
    c.client.set_cap(&c.admin, &1_000);
    assert_eq!(
        c.client.try_settle(&c.id("o"), &c.from, &c.to, &c.token, &1_001),
        Err(Ok(Error::OverCap))
    );
}

#[test]
fn amount_equal_to_cap_allowed() {
    let c = setup();
    c.client.set_cap(&c.admin, &1_000);
    c.client.settle(&c.id("e"), &c.from, &c.to, &c.token, &1_000);
    assert_eq!(c.tok().balance(&c.to), 1_000);
}

#[test]
fn zero_cap_means_no_cap() {
    let c = setup();
    c.client.set_cap(&c.admin, &1_000);
    c.client.set_cap(&c.admin, &0);
    c.client.settle(&c.id("n"), &c.from, &c.to, &c.token, &5_000_000);
    assert!(c.client.is_settled(&c.id("n")));
}

#[test]
fn set_cap_requires_admin_and_non_negative() {
    let c = setup();
    let other = Address::generate(&c.env);
    assert_eq!(c.client.try_set_cap(&other, &10), Err(Ok(Error::NotAdmin)));
    assert_eq!(c.client.try_set_cap(&c.admin, &-1), Err(Ok(Error::InvalidAmount)));
}

// ---------- admin ----------

#[test]
fn set_admin_transfers_control() {
    let c = setup();
    let new_admin = Address::generate(&c.env);
    c.client.set_admin(&c.admin, &new_admin);
    assert_eq!(c.client.config().admin, new_admin);
    assert_eq!(c.client.try_pause(&c.admin), Err(Ok(Error::NotAdmin)));
    c.client.pause(&new_admin);
    assert!(c.client.config().paused);
}

#[test]
fn set_admin_requires_admin() {
    let c = setup();
    let other = Address::generate(&c.env);
    assert_eq!(
        c.client.try_set_admin(&other, &other),
        Err(Ok(Error::NotAdmin))
    );
}

#[test]
fn upgrade_requires_admin() {
    let c = setup();
    let other = Address::generate(&c.env);
    let hash = BytesN::from_array(&c.env, &[7u8; 32]);
    assert_eq!(c.client.try_upgrade(&other, &hash), Err(Ok(Error::NotAdmin)));
}

// ---------- views & events ----------

#[test]
fn version_is_two() {
    let c = setup();
    assert_eq!(c.client.version(), 2);
}

#[test]
fn settle_emits_settled_event() {
    let c = setup();
    c.client.settle(&c.id("ev"), &c.from, &c.to, &c.token, &42);
    let events = c.env.events().all();
    let found = events.iter().any(|(contract, topics, _)| {
        contract == c.client.address
            && topics.len() == 3
            && Symbol::from_val(&c.env, &topics.get(0).unwrap()) == Symbol::new(&c.env, "settled")
    });
    assert!(found, "settled event not found");
}

#[test]
fn error_codes_keep_v1_numbers() {
    assert_eq!(Error::InvalidAmount as u32, 1);
    assert_eq!(Error::AlreadyRecorded as u32, 2);
    assert_eq!(Error::SameParty as u32, 3);
}