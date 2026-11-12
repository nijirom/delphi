use anchor_lang::prelude::*;
use crate::{Market,MARKET_SEED,MAX_SYMBOL_LEN,market_hash,error::ErrorCode};
#[derive(Accounts)]
#[instruction(instrument_symbol:String)]
pub struct InitMarket<'info> {
    #[account(mut)] pub payer:Signer<'info>,
    #[account(init,payer=payer,space=8+Market::INIT_SPACE,seeds=[MARKET_SEED,market_hash(&instrument_symbol).as_ref()],bump)]
    pub market:Account<'info,Market>,
    pub system_program:Program<'info,System>,
}
pub fn handle_init_market(ctx:Context<InitMarket>,instrument_symbol:String)->Result<()> {
    require!(!instrument_symbol.is_empty() && instrument_symbol.len()<=MAX_SYMBOL_LEN,ErrorCode::SymbolTooLong);
    ctx.accounts.market.set_inner(Market { market_hash:market_hash(&instrument_symbol),instrument_symbol,resolved:false,outcome_yes:false,resolved_at:0,bump:ctx.bumps.market }); Ok(())
}
