use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::{Config, BondConfig, ForecastBond, Forecast, Forecaster, Market, CONFIG_SEED, BOND_CONFIG_SEED, FORECAST_BOND_SEED, BOND_VAULT_SEED, FORECASTER_SEED, FORECAST_SEED, MARKET_SEED, error::ErrorCode};

#[derive(Accounts)]
pub struct InitializeBonds<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds=[CONFIG_SEED], bump=config.bump, has_one=authority @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer=authority, space=8+BondConfig::INIT_SPACE, seeds=[BOND_CONFIG_SEED], bump)]
    pub bond_config: Account<'info, BondConfig>,
    #[account(constraint=mint.decimals == 6 @ ErrorCode::InvalidBondAccount)]
    pub mint: Account<'info, Mint>,
    #[account(token::mint=mint)]
    pub treasury: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_bonds(ctx: Context<InitializeBonds>) -> Result<()> {
    ctx.accounts.bond_config.set_inner(BondConfig { mint: ctx.accounts.mint.key(), treasury: ctx.accounts.treasury.key(), bump: ctx.bumps.bond_config });
    Ok(())
}

#[derive(Accounts)]
pub struct BondForecast<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds=[BOND_CONFIG_SEED], bump=bond_config.bump, has_one=mint)]
    pub bond_config: Account<'info, BondConfig>,
    #[account(seeds=[FORECASTER_SEED, authority.key().as_ref()], bump=forecaster.bump, has_one=authority @ ErrorCode::Unauthorized)]
    pub forecaster: Account<'info, Forecaster>,
    #[account(seeds=[MARKET_SEED, market.market_hash.as_ref()], bump=market.bump, constraint=!market.resolved @ ErrorCode::MarketAlreadyResolved)]
    pub market: Account<'info, Market>,
    #[account(seeds=[FORECAST_SEED, forecaster.key().as_ref(), market.market_hash.as_ref()], bump=forecast.bump, has_one=forecaster, has_one=market, constraint=!forecast.revealed @ ErrorCode::AlreadyRevealed, constraint=!forecast.forfeited @ ErrorCode::Forfeited)]
    pub forecast: Account<'info, Forecast>,
    #[account(init, payer=authority, space=8+ForecastBond::INIT_SPACE, seeds=[FORECAST_BOND_SEED, forecast.key().as_ref()], bump)]
    pub forecast_bond: Account<'info, ForecastBond>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint=mint, token::authority=authority)]
    pub source: Account<'info, TokenAccount>,
    #[account(init, payer=authority, seeds=[BOND_VAULT_SEED, forecast.key().as_ref()], bump, token::mint=mint, token::authority=forecast_bond)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_bond_forecast(ctx: Context<BondForecast>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidBondAmount);
    token::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
        from: ctx.accounts.source.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.authority.to_account_info(),
    }), amount, 6)?;
    ctx.accounts.forecast_bond.set_inner(ForecastBond {
        forecast: ctx.accounts.forecast.key(), depositor: ctx.accounts.authority.key(),
        refund_account: ctx.accounts.source.key(), amount, settled: false, slashed: false, bump: ctx.bumps.forecast_bond,
    });
    emit!(BondDeposited { forecast: ctx.accounts.forecast.key(), depositor: ctx.accounts.authority.key(), amount });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleForecastBond<'info> {
    #[account(seeds=[BOND_CONFIG_SEED], bump=bond_config.bump, has_one=mint)]
    pub bond_config: Account<'info, BondConfig>,
    pub forecast: Account<'info, Forecast>,
    #[account(mut, seeds=[FORECAST_BOND_SEED, forecast.key().as_ref()], bump=forecast_bond.bump, has_one=forecast, constraint=!forecast_bond.settled @ ErrorCode::BondAlreadySettled)]
    pub forecast_bond: Account<'info, ForecastBond>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds=[BOND_VAULT_SEED, forecast.key().as_ref()], bump, token::mint=mint, token::authority=forecast_bond)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint=mint)]
    pub recipient: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_settle_forecast_bond(ctx: Context<SettleForecastBond>) -> Result<()> {
    let forecast = &ctx.accounts.forecast;
    let bond = &mut ctx.accounts.forecast_bond;
    require!(forecast.revealed || forecast.forfeited, ErrorCode::BondNotTerminal);
    if forecast.forfeited {
        require_keys_eq!(ctx.accounts.recipient.key(), ctx.accounts.bond_config.treasury, ErrorCode::InvalidBondAccount);
    } else {
        require_keys_eq!(ctx.accounts.recipient.key(), bond.refund_account, ErrorCode::InvalidBondAccount);
        require_keys_eq!(ctx.accounts.recipient.owner, bond.depositor, ErrorCode::InvalidBondAccount);
    }
    let forecast_key = forecast.key();
    let bump = [bond.bump];
    let seeds: &[&[u8]] = &[FORECAST_BOND_SEED, forecast_key.as_ref(), &bump];
    token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
        from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.recipient.to_account_info(), authority: bond.to_account_info(),
    }, &[seeds]), bond.amount, 6)?;
    bond.settled = true;
    bond.slashed = forecast.forfeited;
    emit!(BondSettled { forecast: forecast_key, recipient: ctx.accounts.recipient.key(), amount: bond.amount, slashed: bond.slashed });
    Ok(())
}

#[event]
pub struct BondDeposited { pub forecast: Pubkey, pub depositor: Pubkey, pub amount: u64 }
#[event]
pub struct BondSettled { pub forecast: Pubkey, pub recipient: Pubkey, pub amount: u64, pub slashed: bool }
