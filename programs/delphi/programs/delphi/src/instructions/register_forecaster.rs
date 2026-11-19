use anchor_lang::prelude::*;
use crate::{Forecaster, FORECASTER_SEED, DEFAULT_REPUTATION_BPS, MAX_NAME_LEN, error::ErrorCode};
#[derive(Accounts)]
pub struct RegisterForecaster<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(init,payer=authority,space=8+Forecaster::INIT_SPACE,seeds=[FORECASTER_SEED,authority.key().as_ref()],bump)]
    pub forecaster: Account<'info, Forecaster>,
    pub system_program: Program<'info, System>,
}
pub fn handle_register_forecaster(ctx:Context<RegisterForecaster>,name:String,price_per_read:u64)->Result<()> {
    require!(!name.is_empty() && name.len()<=MAX_NAME_LEN,ErrorCode::NameTooLong);
    require!(price_per_read>0,ErrorCode::InvalidPayment);
    ctx.accounts.forecaster.set_inner(Forecaster { authority:ctx.accounts.authority.key(),name,price_per_read,total_forecasts:0,total_reads:0,scored_count:0,brier_sum_bps:0,reputation_bps:DEFAULT_REPUTATION_BPS,bump:ctx.bumps.forecaster });
    Ok(())
}
