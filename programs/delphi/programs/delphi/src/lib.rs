pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("EVqrBtTWaQiwnrhXzDgqr5TML6oDpHqHs5jjeLLg42Qc");

#[program]
pub mod delphi {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx)
    }

    pub fn register_forecaster(
        ctx: Context<RegisterForecaster>,
        name: String,
        price_per_read: u64,
    ) -> Result<()> {
        crate::instructions::register_forecaster::handle_register_forecaster(
            ctx,
            name,
            price_per_read,
        )
    }

    pub fn update_forecaster(ctx: Context<UpdateForecaster>, price_per_read: u64) -> Result<()> {
        crate::instructions::update_forecaster::handle_update_forecaster(ctx, price_per_read)
    }

    pub fn init_market(ctx: Context<InitMarket>, instrument_symbol: String) -> Result<()> {
        crate::instructions::init_market::handle_init_market(ctx, instrument_symbol)
    }

    pub fn post_forecast(ctx: Context<PostForecast>, commitment: [u8; 32]) -> Result<()> {
        crate::instructions::post_forecast::handle_post_forecast(ctx, commitment)
    }

    pub fn record_purchase(
        ctx: Context<RecordPurchase>,
        amount: u64,
        payment_sig: [u8; 64],
    ) -> Result<()> {
        crate::instructions::record_purchase::handle_record_purchase(ctx, amount, payment_sig)
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>, outcome_yes: bool) -> Result<()> {
        crate::instructions::resolve_market::handle_resolve_market(ctx, outcome_yes)
    }

    pub fn reveal_and_score(
        ctx: Context<RevealAndScore>,
        prob_bps: u16,
        salt: [u8; 32],
    ) -> Result<()> {
        crate::instructions::reveal_and_score::handle_reveal_and_score(ctx, prob_bps, salt)
    }
}
