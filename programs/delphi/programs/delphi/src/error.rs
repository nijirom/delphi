use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Market is already resolved")]
    MarketAlreadyResolved,
    #[msg("Market is not resolved yet")]
    MarketNotResolved,
    #[msg("Forecast has already been revealed")]
    AlreadyRevealed,
    #[msg("Reveal does not match the stored commitment")]
    CommitmentMismatch,
    #[msg("Probability must be in basis points 0..=10000")]
    InvalidProbability,
    #[msg("Instrument symbol exceeds 64 bytes")]
    SymbolTooLong,
    #[msg("Forecaster name exceeds 32 bytes")]
    NameTooLong,
    #[msg("Signer is not authorized")]
    Unauthorized,
    #[msg("Payment amount or transaction signature is invalid")]
    InvalidPayment,
}
