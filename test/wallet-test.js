// walletChanges: which edits a wallet may make to a transaction before signing it (api/_shared.js)
const w3 = require('@solana/web3.js'), spl = require('@solana/spl-token');
const { walletChanges } = require('../api/_shared');
const check = (ok, label, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label, extra); if (!ok) process.exitCode = 1; };

const payer = w3.Keypair.generate().publicKey, user = w3.Keypair.generate().publicKey, mint = w3.Keypair.generate().publicKey;
const from = spl.getAssociatedTokenAddressSync(mint, payer), to = spl.getAssociatedTokenAddressSync(mint, user);
const MEMO = new w3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), LIGHTHOUSE = new w3.PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
const bh = () => w3.Keypair.generate().publicKey.toBase58();
const limit = u => w3.ComputeBudgetProgram.setComputeUnitLimit({ units: u }), price = p => w3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p });
const transfer = n => spl.createTransferCheckedInstruction(from, mint, to, payer, n, 6);
const memo = new w3.TransactionInstruction({ programId: MEMO, keys: [{ pubkey: user, isSigner: true, isWritable: false }], data: Buffer.from('fill') });
const build = (ixs, blockhash = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', p = payer) => new w3.VersionedTransaction(new w3.TransactionMessage({ payerKey: p, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
const ours = [limit(80000), price(20000), transfer(10n ** 10n), memo];
const built = build(ours).message.serialize();
const test = (label, ixs, okExpected, opts = {}) => {
  const why = walletChanges(built, build(ixs, opts.blockhash, opts.payer));
  check(okExpected ? why === null : why !== null, label, why || '');
};
test('unchanged transaction accepted', ours, true);
test('fresh blockhash accepted', ours, true, { blockhash: bh() });
test('Lighthouse checks added (Phantom) accepted', [...ours, new w3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: to, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) })], true);
test('priority fee raised a little accepted', [limit(80000), price(500000), transfer(10n ** 10n), memo], true);
test('priority fee raised a lot refused', [limit(1400000), price(10000000), transfer(10n ** 10n), memo], false);
test('compute settings dropped accepted', [transfer(10n ** 10n), memo], true);
test('amount changed refused', [limit(80000), price(20000), transfer(10n ** 11n), memo], false);
test('memo removed refused', [limit(80000), price(20000), transfer(10n ** 10n)], false);
test('SOL transfer added refused', [...ours, w3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: user, lamports: 1e9 })], false);
test('instructions reordered refused', [limit(80000), price(20000), memo, transfer(10n ** 10n)], false);
test('different fee payer refused', ours, false, { payer: user });
const extraSigner = new w3.TransactionInstruction({ programId: LIGHTHOUSE, keys: [{ pubkey: w3.Keypair.generate().publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) });
test('extra signer refused', [...ours, extraSigner], false);
