// End-to-end test of api/claim.js against an in-process Solana VM (LiteSVM) standing in for the RPC.
// Run: npm test (classic SPL token) and npm run test:2022 (Token-2022, which newer pump.fun coins use).
const w3 = require('@solana/web3.js'), spl = require('@solana/spl-token');
const { LiteSVM, FailedTransactionMetadata } = require('litesvm');
const { getTransactionDecoder } = require('@solana/kit');
const prog = process.argv[2] === '2022' ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID;
const raw = new LiteSVM();
const wire = getTransactionDecoder();
const svm = {
  airdrop: (pk, n) => raw.airdrop(pk.toBase58(), n),
  getAccount: pk => { const a = raw.getAccount(pk.toBase58()); return a.exists ? { executable: a.executable, lamports: Number(a.lamports), owner: new w3.PublicKey(a.programAddress), data: a.data } : null; },
  getBalance: pk => raw.getBalance(pk.toBase58()),
  latestBlockhash: () => raw.latestBlockhash(),
  minimumBalanceForRentExemption: n => raw.minimumBalanceForRentExemption(n),
  sendTransaction: tx => raw.sendTransaction(wire.decode(tx.serialize())),
};
const faucet = w3.Keypair.generate(), visitor = w3.Keypair.generate(), mintKp = w3.Keypair.generate();
svm.airdrop(faucet.publicKey, 5n * 10n ** 9n);
const send = (ixs, signers) => {
  const tx = new w3.Transaction().add(...ixs); tx.recentBlockhash = svm.latestBlockhash(); tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  const r = svm.sendTransaction(tx); if (r instanceof FailedTransactionMetadata) throw new Error('setup tx failed ' + r.toString());
};
const space = spl.getMintLen([]);
send([w3.SystemProgram.createAccount({ fromPubkey: faucet.publicKey, newAccountPubkey: mintKp.publicKey, space, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(space))), programId: prog }),
  spl.createInitializeMint2Instruction(mintKp.publicKey, 6, faucet.publicKey, null, prog)], [faucet, mintKp]);
const fAta = spl.getAssociatedTokenAddressSync(mintKp.publicKey, faucet.publicKey, false, prog);
send([spl.createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, fAta, faucet.publicKey, mintKp.publicKey, prog),
  spl.createMintToInstruction(mintKp.publicKey, fAta, faucet.publicKey, 1_000_000n * 10n ** 6n, [], prog)], [faucet]);

// RPC shim: the calls api/claim.js makes, answered from the VM
const acct = pk => { const a = svm.getAccount(pk); return a && { ...a, data: Buffer.from(a.data) }; };
const C = w3.Connection.prototype;
C.getAccountInfo = async pk => acct(pk);
C.getBalance = async pk => Number(svm.getBalance(pk) || 0);
C.getTokenAccountBalance = async pk => { const a = acct(pk); if (!a) throw new Error('no account'); return { value: { amount: spl.unpackAccount(pk, a, prog).amount.toString() } }; };
C.getLatestBlockhash = async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1000 });
C.sendRawTransaction = async raw => {
  const tx = w3.VersionedTransaction.deserialize(raw);
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) throw new Error('send failed: ' + r.err().toString() + '\n' + r.meta().logs().join('\n'));
  return require('bs58').encode(tx.signatures[0]);
};
C.confirmTransaction = async () => ({ value: { err: null } });

Object.assign(process.env, { FAUCET_SECRET_KEY: JSON.stringify([...faucet.secretKey]), RSN_MINT: mintKp.publicKey.toBase58(), FAUCET_DEV_MEMORY: '1' });
const handler = require('../api/claim.js');
const call = (method, body, query = {}, ip = '1.2.3.4') => new Promise(ok => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { ok({ code: this.code, ...d }); } };
  handler({ method, body, query, headers: { 'x-forwarded-for': ip } }, res);
});
const balance = owner => { const a = acct(spl.getAssociatedTokenAddressSync(mintKp.publicKey, owner, false, prog)); return a ? Number(spl.unpackAccount(null, a, prog).amount) / 1e6 : 0; };
const check = (ok, label, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label, extra); if (!ok) process.exitCode = 1; };

(async () => {
  const w = visitor.publicKey.toBase58();
  console.log('token program:', prog.toBase58());
  let r = await call('GET', null, { wallet: w });
  check(r.code === 200 && r.nextClaimAt === 0, 'GET before claim: can claim now', JSON.stringify(r));
  r = await call('GET', null, { wallet: 'nope' }); check(r.code === 400, 'bad address rejected');
  r = await call('POST', { wallet: w });
  check(r.code === 200 && r.tx, 'POST builds a transaction');
  const tx = w3.VersionedTransaction.deserialize(Buffer.from(r.tx, 'base64'));
  check(tx.message.staticAccountKeys[0].equals(faucet.publicKey), 'faucet is the fee payer');
  // tampered: visitor signs a different transaction
  const evil = w3.VersionedTransaction.deserialize(Buffer.from(r.tx, 'base64')); evil.message.recentBlockhash = svm.latestBlockhash().replace(/.$/, c => c === '1' ? '2' : '1');
  evil.sign([visitor]);
  r = await call('POST', { wallet: w, signed: Buffer.from(evil.serialize()).toString('base64') });
  check(r.code === 400, 'tampered transaction refused', r.error);
  r = await call('POST', { wallet: w, signed: 'garbage' }); check(r.code === 400, 'garbage refused', r.error);
  r = await call('POST', { wallet: w }); const tx2 = w3.VersionedTransaction.deserialize(Buffer.from(r.tx, 'base64'));
  // unsigned (wrong signer) attempt
  r = await call('POST', { wallet: w, signed: Buffer.from(tx2.serialize()).toString('base64') });
  check(r.code === 400, 'missing visitor signature refused', r.error);
  r = await call('POST', { wallet: w }); const tx3 = w3.VersionedTransaction.deserialize(Buffer.from(r.tx, 'base64'));
  const solBefore = svm.getBalance(visitor.publicKey) || 0n;
  tx3.sign([visitor]);
  r = await call('POST', { wallet: w, signed: Buffer.from(tx3.serialize()).toString('base64') });
  check(r.code === 200 && r.signature && r.nextClaimAt > Date.now() + 3.9 * 36e5, 'signed claim sent', JSON.stringify(r));
  check(balance(visitor.publicKey) === 10000, 'visitor received 10,000 RSN (the default)', balance(visitor.publicKey));
  check((svm.getBalance(visitor.publicKey) || 0n) === solBefore, 'visitor paid no SOL');
  r = await call('GET', null, { wallet: w }); check(r.nextClaimAt > Date.now(), 'GET after claim shows countdown');
  r = await call('POST', { wallet: w }); check(r.code === 429 && r.nextClaimAt > Date.now(), 'second claim within 4h refused', r.error);
  // replay of the same signed transaction
  r = await call('POST', { wallet: w, signed: Buffer.from(tx3.serialize()).toString('base64') }); check(r.code !== 200, 'replay refused', r.error);
  // per-IP limit: 3 wallets per IP per window (visitor already used 1)
  for (let i = 0; i < 3; i++) {
    const v = w3.Keypair.generate(); let q = await call('POST', { wallet: v.publicKey.toBase58() });
    if (!q.tx) { check(i === 2 && q.code === 429, `IP limit kicks in at fill #${i + 2}`, q.error); break; }
    const t = w3.VersionedTransaction.deserialize(Buffer.from(q.tx, 'base64')); t.sign([v]);
    q = await call('POST', { wallet: v.publicKey.toBase58(), signed: Buffer.from(t.serialize()).toString('base64') });
    check(q.code === 200, `other wallet fill #${i + 2} from same IP`, q.error || '');
  }
  process.exit(process.exitCode || 0); // exit before LiteSVM's native teardown
})();
