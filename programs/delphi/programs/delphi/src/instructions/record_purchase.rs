use anchor_lang::prelude::*;
use crate::{Forecaster,Forecast,Market,Purchase,PurchaseRecorded,PURCHASE_SEED,error::ErrorCode};
#[derive(Accounts)]
pub struct RecordPurchase<'info> {
    #[account(mut)] pub buyer:Signer<'info>,
    #[account(mut,has_one=forecaster,has_one=market)] pub forecast:Account<'info,Forecast>,
    #[account(mut)] pub forecaster:Account<'info,Forecaster>,
    #[account(constraint=!market.resolved @ ErrorCode::MarketAlreadyResolved)] pub market:Account<'info,Market>,
    #[account(init,payer=buyer,space=8+Purchase::INIT_SPACE,seeds=[PURCHASE_SEED,forecast.key().as_ref(),buyer.key().as_ref()],bump)]
    pub purchase:Account<'info,Purchase>,
    pub system_program:Program<'info,System>,
}
pub fn handle_record_purchase(ctx:Context<RecordPurchase>,amount:u64,payment_sig:[u8;64])->Result<()> {
    require!(amount==ctx.accounts.forecast.price_per_read,ErrorCode::InvalidPayment);
    require!(payment_sig.iter().any(|b|*b!=0),ErrorCode::InvalidPayment);
    ctx.accounts.purchase.set_inner(Purchase { forecast:ctx.accounts.forecast.key(),buyer:ctx.accounts.buyer.key(),amount,payment_sig,purchased_at:Clock::get()?.unix_timestamp,bump:ctx.bumps.purchase });
    ctx.accounts.forecast.reads+=1; ctx.accounts.forecaster.total_reads+=1;
    emit!(PurchaseRecorded { forecast:ctx.accounts.forecast.key(),forecaster:ctx.accounts.forecaster.key(),market:ctx.accounts.market.key(),buyer:ctx.accounts.buyer.key(),amount,payment_sig }); Ok(())
}
