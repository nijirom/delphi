use anchor_lang::prelude::*;
use crate::{Forecaster,FORECASTER_SEED,error::ErrorCode};
#[derive(Accounts)]
pub struct UpdateForecaster<'info> {
    pub authority:Signer<'info>,
    #[account(mut,seeds=[FORECASTER_SEED,authority.key().as_ref()],bump=forecaster.bump,has_one=authority @ ErrorCode::Unauthorized)]
    pub forecaster:Account<'info,Forecaster>,
}
pub fn handle_update_forecaster(ctx:Context<UpdateForecaster>,price_per_read:u64)->Result<()> {
    require!(price_per_read>0,ErrorCode::InvalidPayment);
    ctx.accounts.forecaster.price_per_read=price_per_read; Ok(())
}
