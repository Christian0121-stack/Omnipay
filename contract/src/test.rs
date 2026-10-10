#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

fn setup() -> (Env, SettlementContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(SettlementContract, ());
    let client = SettlementContractClient::new(&env, &contract_id);
    let from = Address::generate(&env);
    let to = Address::generate(&env);
    (env, client, from, to)
}

#[test]
fn records_a_settlement() {
    let (env, client, from, to) = setup();
    let id = String::from_str(&env, "req-1");

    client.settle(&id, &from, &to, &1_000_000);

    let record = client.get(&id).unwrap();
    assert_eq!(record.from, from);
    assert_eq!(record.to, to);
    assert_eq!(record.amount, 1_000_000);
}

#[test]
fn rejects_duplicate_request_id() {
    let (env, client, from, to) = setup();
    let id = String::from_str(&env, "req-2");

    client.settle(&id, &from, &to, &500);
    let second = client.try_settle(&id, &from, &to, &500);

    assert_eq!(second, Err(Ok(Error::AlreadyRecorded)));
}

#[test]
fn rejects_non_positive_amount() {
    let (env, client, from, to) = setup();
    let id = String::from_str(&env, "req-3");

    assert_eq!(
        client.try_settle(&id, &from, &to, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client.try_settle(&id, &from, &to, &-5),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn rejects_same_sender_and_recipient() {
    let (env, client, from, _to) = setup();
    let id = String::from_str(&env, "req-4");

    assert_eq!(
        client.try_settle(&id, &from, &from, &100),
        Err(Ok(Error::SameParty))
    );
}

#[test]
fn unknown_request_returns_none() {
    let (env, client, _from, _to) = setup();
    let id = String::from_str(&env, "missing");

    assert!(client.get(&id).is_none());
}
