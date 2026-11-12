use anchor_lang::prelude::*;
use crate::{Forecaster,Forecast,Market,FORECASTER_SEED,FORECAST_SEED,MARKET_SEED,ForecastPosted,error::ErrorCode};
#[derive(Accounts)]
pub struct PostForecast<'info> {
    #[account(mut)] pub authority:Signer<'info>,
    #[account(mut,seeds=[FORECASTER_SEED,authority.key().as_ref()],bump=forecaster.bump,has_one=authority @ ErrorCode::Unauthorized)]
    pub forecaster:Account<'info,Forecaster>,
    #[account(seeds=[MARKET_SEED,market.market_hash.as_ref()],bump=market.bump,constraint=!market.resolved @ ErrorCode::MarketAlreadyResolved)]
    pub market:Account<'info,Market>,
    #[account(init,payer=authority,space=8+Forecast::INIT_SPACE,seeds=[FORECAST_SEED,forecaster.key().as_ref(),market.market_hash.as_ref()],bump)]
    pub forecast:Account<'info,Forecast>,
    pub system_program:Program<'info,System>,
}
pub fn handle_post_forecast(ctx:Context<PostForecast>,commitment:[u8;32])->Result<()> {
    ctx.accounts.forecast.set_inner(Forecast { forecaster:ctx.accounts.forecaster.key(),market:ctx.accounts.market.key(),commitment,price_per_read:ctx.accounts.forecaster.price_per_read,posted_at:Clock::get()?.unix_timestamp,reads:0,revealed:false,prob_bps:0,brier_bps:0,bump:ctx.bumps.forecast });
    ctx.accounts.forecaster.total_forecasts+=1;
    emit!(ForecastPosted{forecast:ctx.accounts.forecast.key(),forecaster:ctx.accounts.forecaster.key(),market:ctx.accounts.market.key(),commitment}); Ok(())
}
