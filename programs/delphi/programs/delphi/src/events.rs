use anchor_lang::prelude::*;

#[event]
pub struct ForecastPosted {
    pub forecast: Pubkey,
    pub forecaster: Pubkey,
    pub market: Pubkey,
    pub commitment: [u8; 32],
}

#[event]
pub struct PurchaseRecorded {
    pub forecast: Pubkey,
    pub forecaster: Pubkey,
    pub market: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub payment_sig: [u8; 64],
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub outcome_yes: bool,
}

#[event]
pub struct ForecastScored {
    pub forecast: Pubkey,
    pub forecaster: Pubkey,
    pub prob_bps: u16,
    pub brier_bps: u32,
    pub reputation_bps: u16,
}
