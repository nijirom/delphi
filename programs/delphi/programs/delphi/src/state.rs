use anchor_lang::prelude::*;

use crate::constants::{MAX_NAME_LEN, MAX_SYMBOL_LEN};

/// Seeds: `[b"config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Bootstrap authority for the immutable settlement and bond configurations.
    pub authority: Pubkey,
    pub bump: u8,
}

/// Seeds: `[b"forecaster", authority]`.
#[account]
#[derive(InitSpace)]
pub struct Forecaster {
    pub authority: Pubkey,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    /// USDC base units (6 dp) per paid read.
    pub price_per_read: u64,
    pub total_forecasts: u32,
    pub total_reads: u32,
    pub scored_count: u32,
    /// Sum of `brier_bps` over scored (revealed or forfeited) forecasts.
    pub brier_sum_bps: u64,
    /// See `constants::reputation_bps`; `DEFAULT_REPUTATION_BPS` until scored.
    pub reputation_bps: u16,
    pub bump: u8,
}

/// Seeds: `[b"market", market_hash]` where `market_hash = sha256(instrument_symbol)`.
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub market_hash: [u8; 32],
    #[max_len(MAX_SYMBOL_LEN)]
    pub instrument_symbol: String,
    pub resolved: bool,
    pub outcome_yes: bool,
    pub resolved_at: i64,
    pub bump: u8,
}

/// Seeds: `[b"forecast", forecaster, market_hash]`.
#[account]
#[derive(InitSpace)]
pub struct Forecast {
    pub forecaster: Pubkey,
    pub market: Pubkey,
    /// `sha256(prob_bps as u16 LE || salt[32])`.
    pub commitment: [u8; 32],
    /// Snapshot of the forecaster's price at posting time.
    pub price_per_read: u64,
    pub posted_at: i64,
    pub reads: u32,
    pub revealed: bool,
    /// Unrevealed past `REVEAL_WINDOW_SECS` and scored at the worst Brier by anyone.
    pub forfeited: bool,
    /// 0 until revealed.
    pub prob_bps: u16,
    /// 0 until scored.
    pub brier_bps: u32,
    pub bump: u8,
}

/// Seeds: `[b"purchase", forecast, buyer]`.
#[account]
#[derive(InitSpace)]
pub struct Purchase {
    pub forecast: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    /// x402 settlement transaction signature bytes.
    pub payment_sig: [u8; 64],
    pub purchased_at: i64,
    pub bump: u8,
}

/// Separate accounts preserve every pre-existing account layout on upgrade.
#[account]
#[derive(InitSpace)]
pub struct SettlementConfig {
    pub threshold: u8,
    #[max_len(5)]
    pub signers: Vec<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BondConfig {
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ForecastBond {
    pub forecast: Pubkey,
    pub depositor: Pubkey,
    pub refund_account: Pubkey,
    pub amount: u64,
    pub settled: bool,
    pub slashed: bool,
    pub bump: u8,
}
