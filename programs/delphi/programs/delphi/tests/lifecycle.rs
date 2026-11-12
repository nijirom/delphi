use anchor_lang::{prelude::Pubkey, solana_program::{instruction::Instruction, system_program}, AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

fn execute(svm: &mut LiteSVM, payer: &Keypair, accounts: impl ToAccountMetas, data: impl InstructionData) -> Result<(), String> {
    svm.expire_blockhash();
    let instruction=Instruction::new_with_bytes(delphi::id(), &data.data(), accounts.to_account_metas(None));
    let message=Message::new_with_blockhash(&[instruction],Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx=VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer]).unwrap();
    svm.send_transaction(tx).map(|_|()).map_err(|e|format!("{e:?}"))
}

#[test]
fn committed_forecast_cannot_be_changed_or_scored_twice() {
    let mut svm=LiteSVM::new();
    let bytes=include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"),"/../deploy/delphi.so"));
    svm.add_program(delphi::id(),bytes).unwrap();
    let oracle=Keypair::new(); let seller=Keypair::new(); let buyer=Keypair::new();
    for key in [&oracle,&seller,&buyer] { svm.airdrop(&key.pubkey(),2_000_000_000).unwrap(); }
    let pda=|seeds:&[&[u8]]|Pubkey::find_program_address(seeds,&delphi::id()).0;
    let config=pda(&[b"config"]);
    let forecaster=pda(&[b"forecaster",seller.pubkey().as_ref()]);
    let symbol="GEMI-REGRESSION-UP";
    let hash=delphi::market_hash(symbol);
    let market=pda(&[b"market",&hash]);
    let forecast=pda(&[b"forecast",forecaster.as_ref(),&hash]);
    let purchase=pda(&[b"purchase",forecast.as_ref(),buyer.pubkey().as_ref()]);
    execute(&mut svm,&oracle,delphi::accounts::Initialize{authority:oracle.pubkey(),config,system_program:system_program::ID},delphi::instruction::Initialize{}).unwrap();
    execute(&mut svm,&seller,delphi::accounts::RegisterForecaster{authority:seller.pubkey(),forecaster,system_program:system_program::ID},delphi::instruction::RegisterForecaster{name:"Calibrated".into(),price_per_read:10000}).unwrap();
    execute(&mut svm,&seller,delphi::accounts::InitMarket{payer:seller.pubkey(),market,system_program:system_program::ID},delphi::instruction::InitMarket{instrument_symbol:symbol.into()}).unwrap();
    let salt=[7u8;32];
    execute(&mut svm,&seller,delphi::accounts::PostForecast{authority:seller.pubkey(),forecaster,market,forecast,system_program:system_program::ID},delphi::instruction::PostForecast{commitment:delphi::commitment(7000,&salt)}).unwrap();
    let early=execute(&mut svm,&buyer,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:7000,salt}).unwrap_err();
    assert!(early.contains("MarketNotResolved"),"{early}");
    execute(&mut svm,&buyer,delphi::accounts::RecordPurchase{buyer:buyer.pubkey(),forecaster,market,forecast,purchase,system_program:system_program::ID},delphi::instruction::RecordPurchase{amount:10000,payment_sig:[1;64]}).unwrap();
    let invalid=execute(&mut svm,&buyer,delphi::accounts::ResolveMarket{authority:buyer.pubkey(),config,market},delphi::instruction::ResolveMarket{outcome_yes:true}).unwrap_err();
    assert!(invalid.contains("Unauthorized"),"{invalid}");
    execute(&mut svm,&oracle,delphi::accounts::ResolveMarket{authority:oracle.pubkey(),config,market},delphi::instruction::ResolveMarket{outcome_yes:true}).unwrap();
    let wrong=execute(&mut svm,&buyer,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:8000,salt}).unwrap_err();
    assert!(wrong.contains("CommitmentMismatch"),"{wrong}");
    execute(&mut svm,&buyer,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:7000,salt}).unwrap();
    let account=svm.get_account(&forecaster).unwrap();
    let state=delphi::Forecaster::try_deserialize(&mut &account.data[..]).unwrap();
    assert_eq!(state.scored_count,1); assert_eq!(state.brier_sum_bps,900); assert_eq!(state.reputation_bps,9100);
    let twice=execute(&mut svm,&buyer,delphi::accounts::RevealAndScore{forecast,forecaster,market},delphi::instruction::RevealAndScore{prob_bps:7000,salt}).unwrap_err();
    assert!(twice.contains("AlreadyRevealed"),"{twice}");
    let account=svm.get_account(&forecaster).unwrap();
    assert_eq!(delphi::Forecaster::try_deserialize(&mut &account.data[..]).unwrap().scored_count,1);
}
