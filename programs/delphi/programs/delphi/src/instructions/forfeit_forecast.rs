use anchor_lang::prelude::*;
use crate::{Forecast,Forecaster,Market,ForecastScored,BPS,REVEAL_WINDOW_SECS,reputation_bps,error::ErrorCode};
/// Permissionless: closes the free option of never revealing a bad call. Scores the forecast at the worst Brier once the window has passed.
#[derive(Accounts)]
pub struct ForfeitForecast<'info> {
    #[account(mut,has_one=forecaster,has_one=market,constraint=!forecast.revealed @ ErrorCode::AlreadyRevealed,constraint=!forecast.forfeited @ ErrorCode::Forfeited)] pub forecast:Account<'info,Forecast>,
    #[account(mut)] pub forecaster:Account<'info,Forecaster>,
    #[account(constraint=market.resolved @ ErrorCode::MarketNotResolved)] pub market:Account<'info,Market>,
}
pub fn handle_forfeit_forecast(ctx:Context<ForfeitForecast>)->Result<()> {
    let now=Clock::get()?.unix_timestamp;
    require!(now>=ctx.accounts.market.resolved_at.saturating_add(REVEAL_WINDOW_SECS),ErrorCode::RevealWindowOpen);
    let score=u32::from(BPS);
    let forecast=&mut ctx.accounts.forecast; forecast.forfeited=true; forecast.brier_bps=score;
    let forecaster=&mut ctx.accounts.forecaster; forecaster.scored_count=forecaster.scored_count.saturating_add(1); forecaster.brier_sum_bps=forecaster.brier_sum_bps.saturating_add(u64::from(score)); forecaster.reputation_bps=reputation_bps(forecaster.brier_sum_bps,forecaster.scored_count);
    emit!(ForecastScored { forecast:forecast.key(),forecaster:forecaster.key(),prob_bps:0,forfeited:true,brier_bps:score,reputation_bps:forecaster.reputation_bps }); Ok(())
}
