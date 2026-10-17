// Nickel Faucet claim service (Vercel function). One fill per wallet every few hours, the faucet pays the fees.
//   GET  /api/claim?wallet=<address>   -> { nextClaimAt, amount, cluster }
//   POST /api/claim { wallet }          -> { tx }                          unsigned transaction: faucet pays, visitor co-signs
//   POST /api/claim { wallet, signed }  -> { signature, nextClaimAt, cluster }
// The visitor's signature proves they own the wallet; the faucet only adds its own signature to the exact
// transaction it built (checked by hash), so nothing in it can be swapped out.
//
// Settings (Vercel env vars, never in the repo):
//   FAUCET_SECRET_KEY     faucet hot wallet key, base58 or a JSON byte array. Holds only a small refillable supply.
//   RSN_MINT              RSN token mint address
//   SOLANA_RPC_URL        default https://api.devnet.solana.com
//   SOLANA_CLUSTER        devnet | mainnet (for the explorer link), default devnet
//   CLAIM_AMOUNT          whole RSN per fill, default 10000
//   CLAIM_COOLDOWN_HOURS  default 4
//   IP_CLAIMS_PER_WINDOW  fills per IP address per cooldown window, default 3
//   DAILY_CLAIM_CAP       fills per day across everyone, default 500
//   KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + _TOKEN)  claim records, Upstash Redis
//   FAUCET_DEV_MEMORY=1   keep claim records in memory instead (local testing only)
const { env, num, kv, count, storeReady, secretKey, sha, verifySig, clientIp, readBody } = require('./_shared');
// The Solana libraries load on first use, so the "opens at launch" answer never depends on them.
let bs58, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram;
let getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, MEMO;
const loadLibs = () => {
  if (MEMO) return;
  bs58 = require('bs58');
  ({ Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js'));
  ({ getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } = require('@solana/spl-token'));
  MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
};

const TX_TTL = 120e3; // a built transaction must come back signed within 2 minutes

// --- Solana setup, cached between requests on a warm function ---
let setup;
const getSetup = async () => {
  if (setup) return setup;
  const faucet = Keypair.fromSecretKey(secretKey(env.FAUCET_SECRET_KEY, bs58));
  const conn = new Connection(env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
  const mint = new PublicKey(env.RSN_MINT.trim());
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error('RSN mint not found on this network.');
  const program = info.owner; // classic SPL Token or Token-2022 (newer pump.fun coins)
  const { decimals } = await getMint(conn, mint, 'confirmed', program);
  const faucetAta = getAssociatedTokenAddressSync(mint, faucet.publicKey, false, program);
  return (setup = { faucet, conn, mint, program, decimals, faucetAta });
};

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const fail = (code, error, extra) => res.status(code).json({ error, ...extra });
  // ?selftest checks that the Solana libraries load on this server, before any keys are set up
  if (req.method === 'GET' && req.query && 'selftest' in req.query) {
    try { loadLibs(); return res.json({ ok: true, node: process.version }); } catch (e) { return fail(500, String(e && e.message || e), { node: process.version }); }
  }
  if (!env.FAUCET_SECRET_KEY || !env.RSN_MINT) return fail(503, 'The faucet opens when RSN launches. Check back soon!');
  if (!storeReady()) return fail(503, 'The faucet is being set up. Check back soon!');
  try { loadLibs(); } catch (e) { console.error('solana libraries failed to load', e); return fail(500, 'The faucet jammed. Try again in a minute.'); }

  const cluster = env.SOLANA_CLUSTER || 'devnet';
  const amount = num(env.CLAIM_AMOUNT, 10000);
  const cooldown = num(env.CLAIM_COOLDOWN_HOURS, 4) * 36e5;
  let body;
  try { body = readBody(req); } catch { return fail(400, 'Bad request.'); }
  const address = String((req.method === 'GET' ? req.query?.wallet : body.wallet) || '');
  let wallet;
  try { wallet = new PublicKey(address); if (!PublicKey.isOnCurve(wallet.toBytes())) throw 0; } catch { return fail(400, 'That is not a Solana wallet address.'); }
  const cdKey = `rsn:cd:${wallet}`;

  try {
    const next = +(await kv('GET', cdKey)) || 0;
    if (req.method === 'GET') return res.json({ nextClaimAt: next, amount, cluster });
    if (req.method !== 'POST') return fail(405, 'Method not allowed.');
    if (next > Date.now()) return fail(429, 'This wallet already filled up.', { nextClaimAt: next });

    const ip = clientIp(req), ipKey = `rsn:ip:${ip}`, dayKey = `rsn:day:${new Date().toISOString().slice(0, 10)}`;
    const { faucet, conn, mint, program, decimals, faucetAta } = await getSetup();

    if (!body.signed) {
      // Step 1: build the fill. Limits are checked here and counted when it is sent.
      if ((+(await kv('GET', ipKey)) || 0) >= num(env.IP_CLAIMS_PER_WINDOW, 3)) return fail(429, 'Too many fills from your network. Try again later.');
      if ((+(await kv('GET', dayKey)) || 0) >= num(env.DAILY_CLAIM_CAP, 500)) return fail(429, 'The faucet ran dry for today. Come back tomorrow!');
      const units = BigInt(Math.round(amount * 10 ** Math.min(decimals, 6))) * 10n ** BigInt(Math.max(decimals - 6, 0));
      const [lamports, tokens, { blockhash, lastValidBlockHeight }] = await Promise.all([
        conn.getBalance(faucet.publicKey), conn.getTokenAccountBalance(faucetAta).catch(() => null), conn.getLatestBlockhash(),
      ]);
      if (lamports < 0.01e9 || !tokens || BigInt(tokens.value.amount) < units) return fail(503, 'The faucet is empty right now. Tock is refilling it, check back soon!');
      const recipientAta = getAssociatedTokenAddressSync(mint, wallet, false, program);
      const message = new TransactionMessage({
        payerKey: faucet.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: num(env.PRIORITY_MICROLAMPORTS, 20000) }),
          createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, recipientAta, wallet, mint, program),
          createTransferCheckedInstruction(faucetAta, mint, recipientAta, faucet.publicKey, units, decimals, [], program),
          new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: wallet, isSigner: true, isWritable: false }], data: Buffer.from('Robot Sex Nickels faucet fill') }),
        ],
      }).compileToV0Message();
      // remembered by its hash, so building a fill for someone else's address cannot disturb theirs
      await kv('SET', `rsn:tx:${sha(message.serialize())}`, JSON.stringify({ w: address, b: blockhash, v: lastValidBlockHeight }), 'PX', TX_TTL);
      return res.json({ tx: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64') });
    }

    // Step 2: the visitor signed it. Check it is our transaction and their signature, then the faucet signs and sends.
    let tx;
    try { tx = VersionedTransaction.deserialize(Buffer.from(String(body.signed), 'base64')); } catch { return fail(400, 'That is not a transaction.'); }
    const msg = tx.message.serialize(), txKey = `rsn:tx:${sha(msg)}`;
    const saved = JSON.parse((await kv('GET', txKey)) || 'null');
    if (!saved || saved.w !== address) return fail(400, 'That fill expired or your wallet changed it. Press Fill it again.');
    await kv('DEL', txKey);
    const at = tx.message.staticAccountKeys.findIndex(k => k.equals(wallet));
    if (at < 1 || at >= tx.message.header.numRequiredSignatures || !verifySig(wallet.toBytes(), msg, tx.signatures[at])) return fail(400, 'The wallet signature did not check out. Press Fill it again.');

    const nextClaimAt = Date.now() + cooldown;
    if (!(await kv('SET', cdKey, nextClaimAt, 'NX', 'PX', cooldown))) return fail(429, 'This wallet already filled up.', { nextClaimAt: +(await kv('GET', cdKey)) });
    tx.sign([faucet]);
    let signature;
    try {
      signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    } catch (e) {
      await kv('DEL', cdKey); // nothing was sent, so the wallet can try again
      throw e;
    }
    await Promise.all([count(ipKey, cooldown), count(dayKey, 2 * 864e5)]);
    // Once sent it usually lands within seconds; if confirming is slow, keep the cooldown and still show the link.
    const done = await conn.confirmTransaction({ signature, blockhash: saved.b, lastValidBlockHeight: saved.v }, 'confirmed').catch(() => null);
    if (done?.value?.err) { await kv('DEL', cdKey); return fail(500, 'The fill failed on chain, nothing was sent. Press Fill it again.'); }
    return res.json({ signature, nextClaimAt, cluster });
  } catch (e) {
    console.error('claim failed', e);
    return fail(500, 'The faucet jammed. Try again in a minute.');
  }
};
