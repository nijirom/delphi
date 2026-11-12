use anchor_lang::prelude::*;
use crate::{Config, CONFIG_SEED};
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(init, payer=authority, space=8+Config::INIT_SPACE, seeds=[CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}
pub fn handle_initialize(ctx: Context<Initialize>) -> Result<()> {
    ctx.accounts.config.set_inner(Config { authority: ctx.accounts.authority.key(), bump:ctx.bumps.config });
    Ok(())
}
