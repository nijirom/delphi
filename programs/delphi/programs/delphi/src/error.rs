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
    #[msg("Forecast was forfeited after the reveal window closed")]
    Forfeited,
    #[msg("Reveal window is still open")]
    RevealWindowOpen,
    #[msg("Settlement requires a threshold of at least two distinct authorized signers")]
    InvalidThreshold,
    #[msg("Settlement attestation is missing, malformed, duplicated, or bound to different data")]
    InvalidAttestation,
    #[msg("Settlement signer threshold was not met")]
    InsufficientAttestations,
    #[msg("Bond amount must be positive")]
    InvalidBondAmount,
    #[msg("Forecast bond was already settled")]
    BondAlreadySettled,
    #[msg("Forecast must be revealed or forfeited before its bond can settle")]
    BondNotTerminal,
    #[msg("Bond token account, mint, owner, or recipient is invalid")]
    InvalidBondAccount,
}
