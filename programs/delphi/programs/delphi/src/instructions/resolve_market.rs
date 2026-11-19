use anchor_lang::prelude::*;
use crate::{SettlementConfig,Market,SETTLEMENT_CONFIG_SEED,MARKET_SEED,MarketResolved,error::ErrorCode};
#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(seeds=[SETTLEMENT_CONFIG_SEED],bump=settlement_config.bump)]
    pub settlement_config:Account<'info,SettlementConfig>,
    /// CHECK: verified instructions sysvar; only successful prior Ed25519 precompiles count.
    #[account(address=solana_instructions_sysvar::ID)]
    pub instructions:UncheckedAccount<'info>,
    #[account(mut,seeds=[MARKET_SEED,market.market_hash.as_ref()],bump=market.bump,constraint=!market.resolved @ ErrorCode::MarketAlreadyResolved)] pub market:Account<'info,Market>,
}
pub fn handle_resolve_market(ctx:Context<ResolveMarket>,outcome_yes:bool)->Result<()> {
    crate::instructions::settlement::verify_attestations(
        &ctx.accounts.instructions.to_account_info(), &ctx.accounts.settlement_config,
        &ctx.accounts.settlement_config.key(), &ctx.accounts.market.key(), outcome_yes,
    )?;
    let market=&mut ctx.accounts.market; market.resolved=true; market.outcome_yes=outcome_yes; market.resolved_at=Clock::get()?.unix_timestamp;
    emit!(MarketResolved { market:market.key(),outcome_yes }); Ok(())
}
