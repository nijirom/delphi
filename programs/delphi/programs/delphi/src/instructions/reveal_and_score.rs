use anchor_lang::prelude::*;
use crate::{Forecast,Forecaster,Market,commitment,brier_bps,reputation_bps,ForecastScored,error::ErrorCode};
#[derive(Accounts)]
pub struct RevealAndScore<'info> {
    #[account(mut,has_one=forecaster,has_one=market,constraint=!forecast.revealed @ ErrorCode::AlreadyRevealed,constraint=!forecast.forfeited @ ErrorCode::Forfeited)] pub forecast:Account<'info,Forecast>,
    #[account(mut)] pub forecaster:Account<'info,Forecaster>,
    #[account(constraint=market.resolved @ ErrorCode::MarketNotResolved)] pub market:Account<'info,Market>,
}
pub fn handle_reveal_and_score(ctx:Context<RevealAndScore>,prob_bps:u16,salt:[u8;32])->Result<()> {
    require!(prob_bps<=10000,ErrorCode::InvalidProbability);
    require!(commitment(prob_bps,&salt)==ctx.accounts.forecast.commitment,ErrorCode::CommitmentMismatch);
    let score=brier_bps(prob_bps,ctx.accounts.market.outcome_yes);
    let forecast=&mut ctx.accounts.forecast; forecast.revealed=true; forecast.prob_bps=prob_bps; forecast.brier_bps=score;
    let forecaster=&mut ctx.accounts.forecaster; forecaster.scored_count=forecaster.scored_count.saturating_add(1); forecaster.brier_sum_bps=forecaster.brier_sum_bps.saturating_add(u64::from(score)); forecaster.reputation_bps=reputation_bps(forecaster.brier_sum_bps,forecaster.scored_count);
    emit!(ForecastScored { forecast:forecast.key(),forecaster:forecaster.key(),prob_bps,forfeited:false,brier_bps:score,reputation_bps:forecaster.reputation_bps }); Ok(())
}
