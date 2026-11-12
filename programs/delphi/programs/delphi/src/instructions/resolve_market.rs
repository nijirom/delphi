use anchor_lang::prelude::*;
use crate::{Config,Market,CONFIG_SEED,MARKET_SEED,MarketResolved,error::ErrorCode};
#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub authority:Signer<'info>,
    #[account(seeds=[CONFIG_SEED],bump=config.bump,has_one=authority @ ErrorCode::Unauthorized)] pub config:Account<'info,Config>,
    #[account(mut,seeds=[MARKET_SEED,market.market_hash.as_ref()],bump=market.bump,constraint=!market.resolved @ ErrorCode::MarketAlreadyResolved)] pub market:Account<'info,Market>,
}
pub fn handle_resolve_market(ctx:Context<ResolveMarket>,outcome_yes:bool)->Result<()> {
    let market=&mut ctx.accounts.market; market.resolved=true; market.outcome_yes=outcome_yes; market.resolved_at=Clock::get()?.unix_timestamp;
    emit!(MarketResolved { market:market.key(),outcome_yes }); Ok(())
}
