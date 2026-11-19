use anchor_lang::{prelude::Pubkey, solana_program::{instruction::Instruction, system_program}, AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token::{self, state::{Account as TokenAccount, AccountState, Mint}};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

fn send(svm: &mut LiteSVM, payer: &Keypair, instructions: &[Instruction]) -> Result<(), String> {
    svm.expire_blockhash();
    let message=Message::new_with_blockhash(instructions,Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx=VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer]).unwrap();
    svm.send_transaction(tx).map(|_|()).map_err(|e|format!("{e:?}"))
}
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction { Instruction::new_with_bytes(delphi::id(), &data.data(), accounts.to_account_metas(None)) }
fn execute(svm: &mut LiteSVM, payer: &Keypair, accounts: impl ToAccountMetas, data: impl InstructionData) -> Result<(), String> {
    send(svm,payer,&[ix(accounts,data)])
}
fn pda(seeds:&[&[u8]]) -> Pubkey { Pubkey::find_program_address(seeds,&delphi::id()).0 }

/// Self-contained Ed25519 precompile instruction: offsets point inside this instruction only.
fn ed25519(signer: &Keypair, message: &[u8;32]) -> Instruction {
    let signature=signer.sign_message(message);
    let (key_at,sig_at,msg_at)=(16u16,48u16,112u16);
    let mut data=vec![1u8,0];
    for word in [sig_at,u16::MAX,key_at,u16::MAX,msg_at,32,u16::MAX] { data.extend_from_slice(&word.to_le_bytes()); }
    data.extend_from_slice(signer.pubkey().as_ref());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);
    Instruction::new_with_bytes("Ed25519SigVerify111111111111111111111111111".parse().unwrap(),&data,vec![])
}

struct Settlement { config: Pubkey, signers: Vec<Keypair> }
fn settlement(svm: &mut LiteSVM, authority: &Keypair) -> Settlement {
    let signers:Vec<Keypair>=(0..3).map(|_|Keypair::new()).collect();
    let config=pda(&[b"settlement_config"]);
    execute(svm,authority,delphi::accounts::InitializeSettlement{authority:authority.pubkey(),config:pda(&[b"config"]),settlement_config:config,system_program:system_program::ID},delphi::instruction::InitializeSettlement{threshold:2,signers:signers.iter().map(|k|k.pubkey()).collect()}).unwrap();
    Settlement { config, signers }
}
/// `signed` are the keys attesting to `signed_outcome`; the instruction claims `outcome`.
fn resolve(svm: &mut LiteSVM, payer: &Keypair, s: &Settlement, market: Pubkey, signed: &[&Keypair], signed_outcome: bool, outcome: bool) -> Result<(), String> {
    let message=delphi::settlement_message(&delphi::id(),&s.config,&market,signed_outcome);
    let mut instructions:Vec<Instruction>=signed.iter().map(|k|ed25519(k,&message)).collect();
    instructions.push(ix(delphi::accounts::ResolveMarket{settlement_config:s.config,instructions:solana_instructions_sysvar::ID,market},delphi::instruction::ResolveMarket{outcome_yes:outcome}));
    send(svm,payer,&instructions)
}

#[test]
fn committed_forecast_cannot_be_changed_or_scored_twice() {
    let mut svm=LiteSVM::new();
    let bytes=include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"),"/../deploy/delphi.so"));
    svm.add_program(delphi::id(),bytes).unwrap();
    let oracle=Keypair::new(); let seller=Keypair::new(); let buyer=Keypair::new();
    for key in [&oracle,&seller,&buyer] { svm.airdrop(&key.pubkey(),2_000_000_000).unwrap(); }
    let config=pda(&[b"config"]);
    let forecaster=pda(&[b"forecaster",seller.pubkey().as_ref()]);
    let symbol="GEMI-REGRESSION-UP";
    let hash=delphi::market_hash(symbol);
    let market=pda(&[b"market",&hash]);
    let forecast=pda(&[b"forecast",forecaster.as_ref(),&hash]);
    let purchase=pda(&[b"purchase",forecast.as_ref(),buyer.pubkey().as_ref()]);
    execute(&mut svm,&oracle,delphi::accounts::Initialize{authority:oracle.pubkey(),config,system_program:system_program::ID},delphi::instruction::Initialize{}).unwrap();
    let s=settlement(&mut svm,&oracle);
    execute(&mut svm,&seller,delphi::accounts::RegisterForecaster{authority:seller.pubkey(),forecaster,system_program:system_program::ID},delphi::instruction::RegisterForecaster{name:"Calibrated".into(),price_per_read:10000}).unwrap();
    let zero_price=execute(&mut svm,&seller,delphi::accounts::UpdateForecaster{authority:seller.pubkey(),forecaster},delphi::instruction::UpdateForecaster{price_per_read:0}).unwrap_err();
    assert!(zero_price.contains("InvalidPayment"),"{zero_price}");
    execute(&mut svm,&seller,delphi::accounts::InitMarket{payer:seller.pubkey(),market,system_program:system_program::ID},delphi::instruction::InitMarket{instrument_symbol:symbol.into()}).unwrap();
    let salt=[7u8;32];
    execute(&mut svm,&seller,delphi::accounts::PostForecast{authority:seller.pubkey(),forecaster,market,forecast,system_program:system_program::ID},delphi::instruction::PostForecast{commitment:delphi::commitment(7000,&salt)}).unwrap();
    let early=execute(&mut svm,&buyer,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:7000,salt}).unwrap_err();
    assert!(early.contains("MarketNotResolved"),"{early}");
    execute(&mut svm,&buyer,delphi::accounts::RecordPurchase{buyer:buyer.pubkey(),forecaster,market,forecast,purchase,system_program:system_program::ID},delphi::instruction::RecordPurchase{amount:10000,payment_sig:[1;64]}).unwrap();
    let single=resolve(&mut svm,&buyer,&s,market,&[&s.signers[0]],true,true).unwrap_err();
    assert!(single.contains("InsufficientAttestations"),"{single}");
    let duplicate=resolve(&mut svm,&buyer,&s,market,&[&s.signers[0],&s.signers[0]],true,true).unwrap_err();
    assert!(duplicate.contains("InvalidAttestation"),"{duplicate}");
    let outsider=Keypair::new();
    let unauthorized=resolve(&mut svm,&buyer,&s,market,&[&s.signers[0],&outsider],true,true).unwrap_err();
    assert!(unauthorized.contains("Unauthorized"),"{unauthorized}");
    let flipped=resolve(&mut svm,&buyer,&s,market,&[&s.signers[0],&s.signers[1]],false,true).unwrap_err();
    assert!(flipped.contains("InvalidAttestation"),"{flipped}");
    // The legacy oracle key alone no longer settles anything.
    let legacy=resolve(&mut svm,&oracle,&s,market,&[&oracle],true,true).unwrap_err();
    assert!(legacy.contains("Unauthorized"),"{legacy}");
    // Any relayer can submit a quorum; the signers decide the outcome.
    resolve(&mut svm,&buyer,&s,market,&[&s.signers[2],&s.signers[0]],true,true).unwrap();
    let wrong=execute(&mut svm,&buyer,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:8000,salt}).unwrap_err();
    assert!(wrong.contains("CommitmentMismatch"),"{wrong}");
    execute(&mut svm,&buyer,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:7000,salt}).unwrap();
    let account=svm.get_account(&forecaster).unwrap();
    let state=delphi::Forecaster::try_deserialize(&mut &account.data[..]).unwrap();
    // Brier 900 shrunk toward the 5000 prior with weight 5: 10000 - floor((900 + 25000) / 6) = 5684.
    assert_eq!(state.scored_count,1); assert_eq!(state.brier_sum_bps,900); assert_eq!(state.reputation_bps,5684);
    assert_eq!(delphi::reputation_bps(0,0),delphi::DEFAULT_REPUTATION_BPS);
    assert_eq!(delphi::reputation_bps(0,1),5834,"one perfect call stays far from the top");
    assert_eq!(delphi::reputation_bps(50_000,100),9286,"a long record dominates the prior");
    let twice=execute(&mut svm,&buyer,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:7000,salt}).unwrap_err();
    assert!(twice.contains("AlreadyRevealed"),"{twice}");
    let account=svm.get_account(&forecaster).unwrap();
    assert_eq!(delphi::Forecaster::try_deserialize(&mut &account.data[..]).unwrap().scored_count,1);
}

#[test]
fn unrevealed_forecast_is_forfeited_only_after_the_window() {
    let mut svm=LiteSVM::new();
    let bytes=include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"),"/../deploy/delphi.so"));
    svm.add_program(delphi::id(),bytes).unwrap();
    let oracle=Keypair::new(); let seller=Keypair::new(); let anyone=Keypair::new();
    for key in [&oracle,&seller,&anyone] { svm.airdrop(&key.pubkey(),2_000_000_000).unwrap(); }
    let config=pda(&[b"config"]);
    let forecaster=pda(&[b"forecaster",seller.pubkey().as_ref()]);
    let hash=delphi::market_hash("GEMI-FORFEIT-UP");
    let market=pda(&[b"market",&hash]);
    let forecast=pda(&[b"forecast",forecaster.as_ref(),&hash]);
    execute(&mut svm,&oracle,delphi::accounts::Initialize{authority:oracle.pubkey(),config,system_program:system_program::ID},delphi::instruction::Initialize{}).unwrap();
    let s=settlement(&mut svm,&oracle);
    execute(&mut svm,&seller,delphi::accounts::RegisterForecaster{authority:seller.pubkey(),forecaster,system_program:system_program::ID},delphi::instruction::RegisterForecaster{name:"Silent".into(),price_per_read:10000}).unwrap();
    execute(&mut svm,&seller,delphi::accounts::InitMarket{payer:seller.pubkey(),market,system_program:system_program::ID},delphi::instruction::InitMarket{instrument_symbol:"GEMI-FORFEIT-UP".into()}).unwrap();
    let salt=[9u8;32];
    execute(&mut svm,&seller,delphi::accounts::PostForecast{authority:seller.pubkey(),forecaster,market,forecast,system_program:system_program::ID},delphi::instruction::PostForecast{commitment:delphi::commitment(9000,&salt)}).unwrap();
    let unresolved=execute(&mut svm,&anyone,delphi::accounts::ForfeitForecast{forecast,forecaster,market},delphi::instruction::ForfeitForecast{}).unwrap_err();
    assert!(unresolved.contains("MarketNotResolved"),"{unresolved}");
    resolve(&mut svm,&anyone,&s,market,&[&s.signers[0],&s.signers[1]],false,false).unwrap();
    let early=execute(&mut svm,&anyone,delphi::accounts::ForfeitForecast{forecast,forecaster,market},delphi::instruction::ForfeitForecast{}).unwrap_err();
    assert!(early.contains("RevealWindowOpen"),"{early}");
    let resolved_at=delphi::Market::try_deserialize(&mut &svm.get_account(&market).unwrap().data[..]).unwrap().resolved_at;
    let mut clock=svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>();
    clock.unix_timestamp=resolved_at+delphi::REVEAL_WINDOW_SECS;
    svm.set_sysvar(&clock);
    execute(&mut svm,&anyone,delphi::accounts::ForfeitForecast{forecast,forecaster,market},delphi::instruction::ForfeitForecast{}).unwrap();
    let state=delphi::Forecaster::try_deserialize(&mut &svm.get_account(&forecaster).unwrap().data[..]).unwrap();
    assert_eq!(state.scored_count,1); assert_eq!(state.brier_sum_bps,10000); assert_eq!(state.reputation_bps,10000-(10000+25000)/6);
    let record=delphi::Forecast::try_deserialize(&mut &svm.get_account(&forecast).unwrap().data[..]).unwrap();
    assert!(record.forfeited && !record.revealed && record.brier_bps==10000);
    let late=execute(&mut svm,&seller,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:9000,salt}).unwrap_err();
    assert!(late.contains("Forfeited"),"{late}");
    let twice=execute(&mut svm,&anyone,delphi::accounts::ForfeitForecast{forecast,forecaster,market},delphi::instruction::ForfeitForecast{}).unwrap_err();
    assert!(twice.contains("Forfeited"),"{twice}");
}

fn token_account(svm: &mut LiteSVM, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
    let address=Pubkey::new_unique();
    let mut data=vec![0u8;TokenAccount::LEN];
    TokenAccount{mint,owner,amount,state:AccountState::Initialized,..TokenAccount::default()}.pack_into_slice(&mut data);
    svm.set_account(address,solana_account::Account{lamports:svm.minimum_balance_for_rent_exemption(data.len()),data,owner:spl_token::ID,executable:false,rent_epoch:0}).unwrap();
    address
}
fn balance(svm: &LiteSVM, account: Pubkey) -> u64 { TokenAccount::unpack(&svm.get_account(&account).unwrap().data).unwrap().amount }

#[test]
fn bonds_refund_on_reveal_and_slash_to_treasury_on_silence() {
    let mut svm=LiteSVM::new();
    svm.add_program(delphi::id(),include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"),"/../deploy/delphi.so"))).unwrap();
    let admin=Keypair::new(); let honest=Keypair::new(); let silent=Keypair::new(); let anyone=Keypair::new();
    for key in [&admin,&honest,&silent,&anyone] { svm.airdrop(&key.pubkey(),2_000_000_000).unwrap(); }
    let mint=Pubkey::new_unique();
    let mut data=vec![0u8;Mint::LEN];
    Mint{decimals:6,is_initialized:true,supply:10_000_000,..Mint::default()}.pack_into_slice(&mut data);
    svm.set_account(mint,solana_account::Account{lamports:svm.minimum_balance_for_rent_exemption(data.len()),data,owner:spl_token::ID,executable:false,rent_epoch:0}).unwrap();
    let treasury=token_account(&mut svm,mint,admin.pubkey(),0);
    let config=pda(&[b"config"]); let bond_config=pda(&[b"bond_config"]);
    execute(&mut svm,&admin,delphi::accounts::Initialize{authority:admin.pubkey(),config,system_program:system_program::ID},delphi::instruction::Initialize{}).unwrap();
    let s=settlement(&mut svm,&admin);
    let hijack=execute(&mut svm,&anyone,delphi::accounts::InitializeBonds{authority:anyone.pubkey(),config,bond_config,mint,treasury,system_program:system_program::ID},delphi::instruction::InitializeBonds{}).unwrap_err();
    assert!(hijack.contains("Unauthorized"),"{hijack}");
    execute(&mut svm,&admin,delphi::accounts::InitializeBonds{authority:admin.pubkey(),config,bond_config,mint,treasury,system_program:system_program::ID},delphi::instruction::InitializeBonds{}).unwrap();
    let symbol="GEMI-BOND-UP"; let hash=delphi::market_hash(symbol); let market=pda(&[b"market",&hash]);
    execute(&mut svm,&admin,delphi::accounts::InitMarket{payer:admin.pubkey(),market,system_program:system_program::ID},delphi::instruction::InitMarket{instrument_symbol:symbol.into()}).unwrap();
    let salt=[3u8;32];
    let mut posted=vec![];
    for seller in [&honest,&silent] {
        let forecaster=pda(&[b"forecaster",seller.pubkey().as_ref()]);
        let forecast=pda(&[b"forecast",forecaster.as_ref(),&hash]);
        let source=token_account(&mut svm,mint,seller.pubkey(),1_000_000);
        execute(&mut svm,seller,delphi::accounts::RegisterForecaster{authority:seller.pubkey(),forecaster,system_program:system_program::ID},delphi::instruction::RegisterForecaster{name:"Bonded".into(),price_per_read:10000}).unwrap();
        execute(&mut svm,seller,delphi::accounts::PostForecast{authority:seller.pubkey(),forecaster,market,forecast,system_program:system_program::ID},delphi::instruction::PostForecast{commitment:delphi::commitment(6000,&salt)}).unwrap();
        let forecast_bond=pda(&[b"forecast_bond",forecast.as_ref()]); let vault=pda(&[b"bond_vault",forecast.as_ref()]);
        let bond=|amount|delphi::instruction::BondForecast{amount};
        let accounts=||delphi::accounts::BondForecast{authority:seller.pubkey(),bond_config,forecaster,market,forecast,forecast_bond,mint,source,vault,token_program:spl_token::ID,system_program:system_program::ID};
        let zero=execute(&mut svm,seller,accounts(),bond(0)).unwrap_err();
        assert!(zero.contains("InvalidBondAmount"),"{zero}");
        execute(&mut svm,seller,accounts(),bond(250_000)).unwrap();
        assert_eq!(balance(&svm,vault),250_000); assert_eq!(balance(&svm,source),750_000);
        posted.push((forecaster,forecast,forecast_bond,vault,source));
    }
    let settle=|svm:&mut LiteSVM,(_,forecast,forecast_bond,vault,_):(Pubkey,Pubkey,Pubkey,Pubkey,Pubkey),recipient|execute(svm,&anyone,delphi::accounts::SettleForecastBond{bond_config,forecast,forecast_bond,mint,vault,recipient,token_program:spl_token::ID},delphi::instruction::SettleForecastBond{});
    let open=settle(&mut svm,posted[0],posted[0].4).unwrap_err();
    assert!(open.contains("BondNotTerminal"),"{open}");
    resolve(&mut svm,&anyone,&s,market,&[&s.signers[0],&s.signers[1]],true,true).unwrap();
    let (forecaster,forecast,..)=posted[0];
    execute(&mut svm,&anyone,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:6000,salt}).unwrap();
    let stolen=settle(&mut svm,posted[0],treasury).unwrap_err();
    assert!(stolen.contains("InvalidBondAccount"),"a revealed bond cannot be redirected: {stolen}");
    settle(&mut svm,posted[0],posted[0].4).unwrap();
    assert_eq!(balance(&svm,posted[0].4),1_000_000); assert_eq!(balance(&svm,posted[0].3),0);
    let again=settle(&mut svm,posted[0],posted[0].4).unwrap_err();
    assert!(again.contains("BondAlreadySettled"),"{again}");
    let resolved_at=delphi::Market::try_deserialize(&mut &svm.get_account(&market).unwrap().data[..]).unwrap().resolved_at;
    let mut clock=svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>();
    clock.unix_timestamp=resolved_at+delphi::REVEAL_WINDOW_SECS;
    svm.set_sysvar(&clock);
    let (forecaster,forecast,..)=posted[1];
    execute(&mut svm,&anyone,delphi::accounts::ForfeitForecast{forecast,forecaster,market},delphi::instruction::ForfeitForecast{}).unwrap();
    let refund=settle(&mut svm,posted[1],posted[1].4).unwrap_err();
    assert!(refund.contains("InvalidBondAccount"),"a forfeited bond cannot return to the forecaster: {refund}");
    settle(&mut svm,posted[1],treasury).unwrap();
    assert_eq!(balance(&svm,treasury),250_000); assert_eq!(balance(&svm,posted[1].4),750_000);
    let state=delphi::ForecastBond::try_deserialize(&mut &svm.get_account(&posted[1].2).unwrap().data[..]).unwrap();
    assert!(state.settled && state.slashed);
}
