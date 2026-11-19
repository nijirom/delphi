use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use crate::{Config, SettlementConfig, CONFIG_SEED, SETTLEMENT_CONFIG_SEED, MAX_SETTLEMENT_SIGNERS, settlement_message, error::ErrorCode};

#[derive(Accounts)]
pub struct InitializeSettlement<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds=[CONFIG_SEED], bump=config.bump, has_one=authority @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer=authority, space=8+SettlementConfig::INIT_SPACE, seeds=[SETTLEMENT_CONFIG_SEED], bump)]
    pub settlement_config: Account<'info, SettlementConfig>,
    pub system_program: Program<'info, System>,
}

pub fn validate_signers(threshold: u8, signers: &[Pubkey]) -> Result<()> {
    require!(threshold >= 2 && usize::from(threshold) <= signers.len() && signers.len() <= MAX_SETTLEMENT_SIGNERS, ErrorCode::InvalidThreshold);
    for (i, signer) in signers.iter().enumerate() {
        require!(*signer != Pubkey::default() && !signers[..i].contains(signer), ErrorCode::InvalidThreshold);
    }
    Ok(())
}

pub fn handle_initialize_settlement(ctx: Context<InitializeSettlement>, threshold: u8, signers: Vec<Pubkey>) -> Result<()> {
    validate_signers(threshold, &signers)?;
    ctx.accounts.settlement_config.set_inner(SettlementConfig { threshold, signers, bump: ctx.bumps.settlement_config });
    Ok(())
}

fn word(data: &[u8], offset: usize) -> Result<usize> {
    let bytes = data.get(offset..offset + 2).ok_or(ErrorCode::InvalidAttestation)?;
    Ok(usize::from(u16::from_le_bytes([bytes[0], bytes[1]])))
}

/// Only self-contained Ed25519 signatures are accepted; offsets cannot refer to
/// another instruction's key/message while passing this program's binding check.
pub fn count_attestation(data: &[u8], signers: &[Pubkey], expected: &[u8; 32], seen: &mut u8) -> Result<()> {
    require!(data.len() >= 2 && data[0] == 1 && data[1] == 0, ErrorCode::InvalidAttestation);
    let signature_offset = word(data, 2)?;
    let key_offset = word(data, 6)?;
    let message_offset = word(data, 10)?;
    require!(word(data, 4)? == 65535 && word(data, 8)? == 65535 && word(data, 14)? == 65535, ErrorCode::InvalidAttestation);
    require!(word(data, 12)? == 32 && signature_offset >= 16 && key_offset >= 16 && message_offset >= 16, ErrorCode::InvalidAttestation);
    require!(data.get(signature_offset..signature_offset + 64).is_some(), ErrorCode::InvalidAttestation);
    require!(data.get(message_offset..message_offset + 32) == Some(expected.as_slice()), ErrorCode::InvalidAttestation);
    let key_bytes = data.get(key_offset..key_offset + 32).ok_or(ErrorCode::InvalidAttestation)?;
    let index = signers.iter().position(|key| key.as_ref() == key_bytes).ok_or(ErrorCode::Unauthorized)?;
    let bit = 1u8 << index;
    require!(*seen & bit == 0, ErrorCode::InvalidAttestation);
    *seen |= bit;
    Ok(())
}

pub fn verify_attestations(instructions: &AccountInfo, config: &SettlementConfig, config_key: &Pubkey, market: &Pubkey, outcome: bool) -> Result<()> {
    let expected = settlement_message(&crate::id(), config_key, market, outcome);
    let current = load_current_index_checked(instructions)?;
    let ed25519 = pubkey!("Ed25519SigVerify111111111111111111111111111");
    let mut seen = 0u8;
    for index in 0..current {
        let instruction = load_instruction_at_checked(usize::from(index), instructions)?;
        if instruction.program_id == ed25519 {
            require!(instruction.accounts.is_empty(), ErrorCode::InvalidAttestation);
            count_attestation(&instruction.data, &config.signers, &expected, &mut seen)?;
        }
    }
    require!(seen.count_ones() >= u32::from(config.threshold), ErrorCode::InsufficientAttestations);
    Ok(())
}
