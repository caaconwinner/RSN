// Nickel Jiggy Slots with real RSN (Vercel function). Players deposit RSN into the pot wallet, spin against a
// balance the server keeps, and withdraw back to the same wallet. Spins are drawn here, never in the browser.
//   GET  /api/slots?wallet=<address>                      -> { enabled, cluster, bets, maxBet, minDeposit, balance }
//   POST { action: 'login', wallet }                       -> { message }        text for the wallet to sign (free)
//   POST { action: 'login', wallet, signature }            -> { session, balance }
//   POST { action: 'spin', session, bet }                  -> { stops, mult, win, balance, maxBet }
//   POST { action: 'deposit', session, amount }            -> { tx }             player pays the fee and signs
//   POST { action: 'deposit', session, signed }            -> { signature, balance } or { signature, pending: true }
//   POST { action: 'deposit', session, check: signature }  -> { balance, pending }
//   POST { action: 'withdraw', session, amount }           -> { signature, balance }   pot pays the fee
// Amounts are whole RSN. A bet is only taken while the pot can cover its top prize (250x) on top of what it
// already owes players, so "free pot" = RSN in the pot wallet minus every player's balance.
//
// Settings (Vercel env vars, never in the repo):
//   SLOTS_ENABLED=1        master switch. Anything else and RSN mode says it opens soon.
//   SLOTS_POT_SECRET_KEY   pot hot wallet key, base58 or a JSON byte array
//   SLOTS_BETS             whole RSN per spin, default 10,50,100,500,1000
//   SLOTS_MIN_DEPOSIT      default 10
//   RSN_MINT, SOLANA_RPC_URL, SOLANA_CLUSTER, KV_REST_API_URL + KV_REST_API_TOKEN as for the faucet
const crypto = require('crypto');
const { env, num, kv, storeReady, secretKey, sha, verifySig, readBody } = require('./_shared');
const reels = require('./_slots-math');
let bs58, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram;
let getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, MEMO;
const loadLibs = () => {
  if (MEMO) return;
  bs58 = require('bs58');
  ({ Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js'));
  ({ getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } = require('@solana/spl-token'));
  MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
};

const TX_TTL = 120e3;           // a built deposit must come back signed within 2 minutes
const SESSION_TTL = 12 * 36e5;  // a sign-in lasts 12 hours
const SPIN_GAP = 300;           // ms between spins per wallet
const K = {
  bal: w => `rsn:sl:bal:${w}`, liab: 'rsn:sl:liab', sess: t => `rsn:sl:sess:${t}`, login: w => `rsn:sl:login:${w}`,
  tx: h => `rsn:sl:tx:${h}`, dep: s => `rsn:sl:dep:${s}`, lock: w => `rsn:sl:lock:${w}`,
};
const bets = () => String(env.SLOTS_BETS || '10,50,100,500,1000').split(',').map(Number).filter(n => n > 0 && Number.isInteger(n));
const whole = v => (Number.isInteger(+v) && +v > 0 ? +v : 0);

let setup;
const getSetup = async () => {
  if (setup) return setup;
  const pot = Keypair.fromSecretKey(secretKey(env.SLOTS_POT_SECRET_KEY, bs58));
  const conn = new Connection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
  const mint = new PublicKey(env.RSN_MINT.trim());
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error('RSN mint not found on this network.');
  const program = info.owner;
  const { decimals } = await getMint(conn, mint, 'confirmed', program);
  const potAta = getAssociatedTokenAddressSync(mint, pot.publicKey, false, program);
  const units = n => BigInt(n) * 10n ** BigInt(decimals);
  return (setup = { pot, conn, mint, program, decimals, potAta, units });
};

// RSN in the pot wallet, cached briefly; deposits and withdrawals refresh it
let potCache = { at: 0, rsn: 0 };
const potRsn = async (s, fresh) => {
  if (fresh || Date.now() - potCache.at > 15e3) {
    const b = await s.conn.getTokenAccountBalance(s.potAta).catch(() => null);
    potCache = { at: Date.now(), rsn: b ? Number(BigInt(b.value.amount) / 10n ** BigInt(s.decimals)) : 0 };
  }
  return potCache.rsn;
};
const freePot = async (s, fresh) => (await potRsn(s, fresh)) - (+(await kv('GET', K.liab)) || 0);
const maxBet = free => bets().filter(b => b * reels.TOP <= free).pop() || 0;
const balance = async w => +(await kv('GET', K.bal(w))) || 0;
// move RSN between a player's balance and the pot's books; returns the new balance, or null if it would go below 0
const adjust = async (w, delta) => {
  const n = await kv('INCRBY', K.bal(w), delta);
  if (n < 0) { await kv('INCRBY', K.bal(w), -delta); return null; }
  await kv('INCRBY', K.liab, delta);
  return n;
};
// credit a deposit exactly once: whoever deletes the pending record does the credit
const credit = async sig => {
  const rec = JSON.parse((await kv('GET', K.dep(sig))) || 'null');
  if (!rec || !(await kv('DEL', K.dep(sig)))) return null;
  potCache.at = 0;
  return adjust(rec.w, rec.amt);
};

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const fail = (code, error, extra) => res.status(code).json({ error, ...extra });
  const cluster = env.SOLANA_CLUSTER || 'devnet';
  if (env.SLOTS_ENABLED !== '1' || !env.SLOTS_POT_SECRET_KEY || !env.RSN_MINT || !storeReady()) {
    return req.method === 'GET' ? res.json({ enabled: false, cluster }) : fail(503, 'Real RSN play opens soon. Fun nickels are on the house meanwhile!');
  }
  try { loadLibs(); } catch (e) { console.error('solana libraries failed to load', e); return fail(500, 'The machine jammed. Try again in a minute.'); }
  let body;
  try { body = readBody(req); } catch { return fail(400, 'Bad request.'); }
  const isWallet = a => { try { const k = new PublicKey(String(a || '')); return PublicKey.isOnCurve(k.toBytes()) ? k : null; } catch { return null; } };

  try {
    const s = await getSetup();
    const minDeposit = num(env.SLOTS_MIN_DEPOSIT, 10);
    if (req.method === 'GET') {
      const w = isWallet(req.query?.wallet);
      return res.json({ enabled: true, cluster, bets: bets(), maxBet: maxBet(await freePot(s)), minDeposit, top: reels.TOP, balance: w ? await balance(w.toBase58()) : 0 });
    }
    if (req.method !== 'POST') return fail(405, 'Method not allowed.');

    if (body.action === 'login') {
      const w = isWallet(body.wallet);
      if (!w) return fail(400, 'That is not a Solana wallet address.');
      const address = w.toBase58();
      if (!body.signature) {
        const message = `Robot Sex Nickels slots\nSign in as ${address}\nCode ${crypto.randomBytes(8).toString('hex')}\nThis is free and sends nothing.`;
        await kv('SET', K.login(address), message, 'PX', 5 * 60e3);
        return res.json({ message });
      }
      const message = await kv('GET', K.login(address));
      if (!message) return fail(400, 'Sign-in expired. Try again.');
      let ok = false;
      try { ok = verifySig(w.toBytes(), Buffer.from(message), Buffer.from(String(body.signature), 'base64')); } catch {}
      if (!ok) return fail(401, 'The wallet signature did not check out.');
      await kv('DEL', K.login(address));
      const session = crypto.randomBytes(24).toString('hex');
      await kv('SET', K.sess(session), address, 'PX', SESSION_TTL);
      return res.json({ session, balance: await balance(address) });
    }

    const address = body.session && /^[0-9a-f]{48}$/.test(body.session) ? await kv('GET', K.sess(body.session)) : null;
    if (!address) return fail(401, 'Please sign in with your wallet again.', { signin: true });
    const wallet = new PublicKey(address);

    if (body.action === 'spin') {
      const bet = +body.bet;
      if (!bets().includes(bet)) return fail(400, 'That bet is not on this machine.');
      if (bet > maxBet(await freePot(s))) return fail(409, 'The pot is too low for that bet right now. Try a smaller one.', { maxBet: maxBet(await freePot(s)) });
      if (!(await kv('SET', K.lock(address), 1, 'NX', 'PX', SPIN_GAP))) return fail(429, 'Easy, the reels are still turning.');
      if ((await adjust(address, -bet)) === null) return fail(402, 'Not enough RSN. Deposit some to keep playing.', { balance: await balance(address) });
      const { stops, mult } = reels.spin();
      const win = mult * bet;
      const bal = win ? await adjust(address, win) : await balance(address);
      return res.json({ stops, mult, win, balance: bal, maxBet: maxBet(await freePot(s)) });
    }

    if (body.action === 'deposit') {
      if (body.check) {
        const sig = String(body.check);
        const rec = JSON.parse((await kv('GET', K.dep(sig))) || 'null');
        if (!rec || rec.w !== address) return res.json({ balance: await balance(address), pending: false });
        const st = (await s.conn.getSignatureStatuses([sig])).value[0];
        if (st?.err) { await kv('DEL', K.dep(sig)); return fail(400, 'That deposit failed on chain, no RSN moved.'); }
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) await credit(sig);
        return res.json({ balance: await balance(address), pending: !!(await kv('GET', K.dep(sig))) });
      }
      if (!body.signed) {
        const amount = whole(body.amount);
        if (amount < minDeposit) return fail(400, `The smallest deposit is ${minDeposit} RSN.`);
        const from = getAssociatedTokenAddressSync(s.mint, wallet, false, s.program);
        const [have, { blockhash, lastValidBlockHeight }] = await Promise.all([
          s.conn.getTokenAccountBalance(from).catch(() => null), s.conn.getLatestBlockhash()]);
        if (!have || BigInt(have.value.amount) < s.units(amount)) return fail(400, 'Your wallet does not hold that much RSN.');
        const message = new TransactionMessage({
          payerKey: wallet,
          recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: num(env.PRIORITY_MICROLAMPORTS, 20000) }),
            createAssociatedTokenAccountIdempotentInstruction(wallet, s.potAta, s.pot.publicKey, s.mint, s.program),
            createTransferCheckedInstruction(from, s.mint, s.potAta, wallet, s.units(amount), s.decimals, [], s.program),
            new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('Robot Sex Nickels slots deposit') }),
          ],
        }).compileToV0Message();
        await kv('SET', K.tx(sha(message.serialize())), JSON.stringify({ w: address, amt: amount, b: blockhash, v: lastValidBlockHeight }), 'PX', TX_TTL);
        return res.json({ tx: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64') });
      }
      // the player signed it: check it is the deposit we built, then send it ourselves so we know its signature
      let tx;
      try { tx = VersionedTransaction.deserialize(Buffer.from(String(body.signed), 'base64')); } catch { return fail(400, 'That is not a transaction.'); }
      const msg = tx.message.serialize(), txKey = K.tx(sha(msg));
      const saved = JSON.parse((await kv('GET', txKey)) || 'null');
      if (!saved || saved.w !== address) return fail(400, 'That deposit expired or your wallet changed it. Try again.');
      if (!verifySig(wallet.toBytes(), msg, tx.signatures[0])) return fail(400, 'The wallet signature did not check out.');
      await kv('DEL', txKey);
      const signature = bs58.encode(tx.signatures[0]);
      // recorded before sending, so a deposit that lands is never lost even if this function stops halfway
      await kv('SET', K.dep(signature), JSON.stringify({ w: address, amt: saved.amt }), 'PX', 7 * 864e5);
      try {
        await s.conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
      } catch (e) {
        await kv('DEL', K.dep(signature));
        console.error('deposit send failed', e);
        return fail(400, 'The deposit did not go through, no RSN moved. Check you have a little SOL for the fee.');
      }
      const done = await s.conn.confirmTransaction({ signature, blockhash: saved.b, lastValidBlockHeight: saved.v }, 'confirmed').catch(() => null);
      if (done?.value?.err) { await kv('DEL', K.dep(signature)); return fail(400, 'The deposit failed on chain, no RSN moved.'); }
      if (!done) return res.json({ signature, pending: true, balance: await balance(address), cluster });
      await credit(signature);
      return res.json({ signature, balance: await balance(address), cluster });
    }

    if (body.action === 'withdraw') {
      const amount = whole(body.amount);
      if (!amount) return fail(400, 'Enter how much RSN to withdraw.');
      const [lamports, inPot] = await Promise.all([s.conn.getBalance(s.pot.publicKey), potRsn(s, true)]);
      if (lamports < 0.01e9 || inPot < amount) return fail(503, 'The pot is being refilled. Try again soon, your RSN is safe.');
      if ((await adjust(address, -amount)) === null) return fail(400, 'You can only withdraw what you have.', { balance: await balance(address) });
      const to = getAssociatedTokenAddressSync(s.mint, wallet, false, s.program);
      const { blockhash, lastValidBlockHeight } = await s.conn.getLatestBlockhash();
      const tx = new VersionedTransaction(new TransactionMessage({
        payerKey: s.pot.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: num(env.PRIORITY_MICROLAMPORTS, 20000) }),
          createAssociatedTokenAccountIdempotentInstruction(s.pot.publicKey, to, wallet, s.mint, s.program),
          createTransferCheckedInstruction(s.potAta, s.mint, to, s.pot.publicKey, s.units(amount), s.decimals, [], s.program),
          new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('Robot Sex Nickels slots withdrawal') }),
        ],
      }).compileToV0Message());
      tx.sign([s.pot]);
      let signature;
      try {
        signature = await s.conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
      } catch (e) {
        await adjust(address, amount); // nothing was sent, put it back
        throw e;
      }
      potCache.at = 0;
      const done = await s.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed').catch(() => null);
      if (done?.value?.err) { await adjust(address, amount); return fail(500, 'The withdrawal failed on chain, your RSN is back in your balance.'); }
      // if confirming is slow the transfer almost always lands; the balance stays debited and the link shows it
      return res.json({ signature, balance: await balance(address), cluster });
    }
    return fail(400, 'Bad request.');
  } catch (e) {
    console.error('slots failed', e);
    return fail(500, 'The machine jammed. Try again in a minute.');
  }
};
