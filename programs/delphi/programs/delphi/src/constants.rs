use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const FORECASTER_SEED: &[u8] = b"forecaster";

#[constant]
pub const MARKET_SEED: &[u8] = b"market";

#[constant]
pub const FORECAST_SEED: &[u8] = b"forecast";

#[constant]
pub const PURCHASE_SEED: &[u8] = b"purchase";

pub const MAX_NAME_LEN: usize = 32;

pub const MAX_SYMBOL_LEN: usize = 64;

#[constant]
pub const BPS: u16 = 10_000;

/// Reputation assigned before a forecaster has any scored forecast.
#[constant]
pub const DEFAULT_REPUTATION_BPS: u16 = 5_000;

/// `market_hash = sha256(instrument_symbol)`.
pub fn market_hash(instrument_symbol: &str) -> [u8; 32] {
    solana_sha256_hasher::hash(instrument_symbol.as_bytes()).to_bytes()
}

/// `commitment = sha256(prob_bps as u16 LE || salt)`.
pub fn commitment(prob_bps: u16, salt: &[u8; 32]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[&prob_bps.to_le_bytes(), salt]).to_bytes()
}

/// `brier_bps = (prob_bps - outcome * 10000)^2 / 10000`, range `0..=10000`.
pub fn brier_bps(prob_bps: u16, outcome_yes: bool) -> u32 {
    let o: u32 = if outcome_yes { BPS as u32 } else { 0 };
    let d = (prob_bps as i64 - o as i64).unsigned_abs();
    (d * d / BPS as u64) as u32
}
