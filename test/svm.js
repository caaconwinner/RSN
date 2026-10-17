// An in-process Solana VM (LiteSVM) standing in for the RPC, plus an RSN mint, for the api tests.
// prog: classic SPL Token, or Token-2022 when the test runs with the argument 2022 (newer pump.fun coins).
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
const faucet = w3.Keypair.generate(), mintKp = w3.Keypair.generate();
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

// RPC shim: the calls the api makes, answered from the VM. rpc.slow makes confirming time out.
const rpc = { slow: false }, landed = new Set();
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
  const sig = require('bs58').encode(tx.signatures[0]); landed.add(sig); return sig;
};
C.confirmTransaction = async () => { if (rpc.slow) throw new Error('timed out'); return { value: { err: null } }; };
C.getSignatureStatuses = async sigs => ({ value: sigs.map(s => landed.has(s) ? { err: null, confirmationStatus: 'confirmed' } : null) });


const balance = owner => { const a = acct(spl.getAssociatedTokenAddressSync(mintKp.publicKey, owner, false, prog)); return a ? Number(spl.unpackAccount(null, a, prog).amount) / 1e6 : 0; };
const fund = (owner, rsn, lamports = 10n ** 9n) => {
  svm.airdrop(owner, lamports);
  const ata = spl.getAssociatedTokenAddressSync(mintKp.publicKey, owner, false, prog);
  send([spl.createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, ata, owner, mintKp.publicKey, prog),
    spl.createMintToInstruction(mintKp.publicKey, ata, faucet.publicKey, BigInt(rsn) * 10n ** 6n, [], prog)], [faucet]);
};
const check = (ok, label, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label, extra); if (!ok) process.exitCode = 1; };
module.exports = { rpc, w3, spl, svm, prog, faucet, mintKp, acct, balance, fund, check };
