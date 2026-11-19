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

pub const SETTLEMENT_CONFIG_SEED: &[u8] = b"settlement_config";
pub const BOND_CONFIG_SEED: &[u8] = b"bond_config";
pub const FORECAST_BOND_SEED: &[u8] = b"forecast_bond";
pub const BOND_VAULT_SEED: &[u8] = b"bond_vault";
pub const MAX_SETTLEMENT_SIGNERS: usize = 5;
pub const SETTLEMENT_DOMAIN: &[u8] = b"delphi:settlement:v1";

/// Fixed-size, domain-separated signed digest, including the program and config.
pub fn settlement_message(program: &Pubkey, config: &Pubkey, market: &Pubkey, outcome: bool) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        SETTLEMENT_DOMAIN, program.as_ref(), config.as_ref(), market.as_ref(), &[u8::from(outcome)],
    ]).to_bytes()
}

pub const MAX_NAME_LEN: usize = 32;

pub const MAX_SYMBOL_LEN: usize = 64;

#[constant]
pub const BPS: u16 = 10_000;

/// Reputation assigned before a forecaster has any scored forecast; equals the prior Brier mapped through `reputation_bps`.
#[constant]
pub const DEFAULT_REPUTATION_BPS: u16 = 5_000;

/// Prior Brier (bps) and its weight in pseudo-observations. Shrinks small samples toward 5000 so one lucky call cannot top the leaderboard.
#[constant]
pub const PRIOR_BRIER_BPS: u64 = 5_000;
#[constant]
pub const PRIOR_WEIGHT: u64 = 5;

/// Seconds after market resolution during which a forecast may be revealed. Afterwards anyone may forfeit it at the worst Brier.
#[constant]
pub const REVEAL_WINDOW_SECS: i64 = 3_600;

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

/// `10000 - (brier_sum + PRIOR_WEIGHT * PRIOR_BRIER) / (scored_count + PRIOR_WEIGHT)`.
pub fn reputation_bps(brier_sum_bps: u64, scored_count: u32) -> u16 {
    let mean = (brier_sum_bps + PRIOR_WEIGHT * PRIOR_BRIER_BPS) / (scored_count as u64 + PRIOR_WEIGHT);
    (BPS as u64 - mean) as u16
}
