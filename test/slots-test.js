// End-to-end test of api/slots.js (real RSN mode) against an in-process Solana VM (LiteSVM).
// Run: npm run test:slots (add 2022 for Token-2022).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { rpc, w3, prog, mintKp, balance, fund, check } = require('./svm');
const reels = require('../api/_slots-math');

const pot = w3.Keypair.generate(), player = w3.Keypair.generate(), other = w3.Keypair.generate();
fund(pot.publicKey, 300_000);
fund(player.publicKey, 5_000);
fund(other.publicKey, 5_000);
Object.assign(process.env, { SLOTS_POT_SECRET_KEY: JSON.stringify([...pot.secretKey]), RSN_MINT: mintKp.publicKey.toBase58(), FAUCET_DEV_MEMORY: '1' });
const handler = require('../api/slots.js');
const call = (method, body, query = {}) => new Promise(ok => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(d) { ok({ code: this.code, ...d }); } };
  handler({ method, body, query, headers: {} }, res);
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const b64 = u => Buffer.from(u).toString('base64');
// what a wallet's signMessage does: ed25519 over the message bytes
const signText = (text, kp) => b64(crypto.sign(null, Buffer.from(text), crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' })));
const login = async kp => {
  const { message } = await call('POST', { action: 'login', wallet: kp.publicKey.toBase58() });
  const signature = signText(message, kp);
  return call('POST', { action: 'login', wallet: kp.publicKey.toBase58(), signature });
};
const deposit = async (session, kp, amount) => {
  const r = await call('POST', { action: 'deposit', session, amount });
  if (!r.tx) return r;
  const tx = w3.VersionedTransaction.deserialize(Buffer.from(r.tx, 'base64')); tx.sign([kp]);
  return call('POST', { action: 'deposit', session, signed: b64(tx.serialize()) });
};

(async () => {
  console.log('token program:', prog.toBase58());

  // the reels here must be the ones players see in slots.html
  const page = fs.readFileSync(path.join(__dirname, '../slots.html'), 'utf8');
  const pageWeights = Function(`return ${page.match(/const WEIGHTS = (\{[^}]*\})/)[1]}`)();
  const pageNickels = JSON.parse(page.match(/const NICKEL_PAY = (\[[^\]]*\])/)[1]);
  const pagePays = Object.fromEntries([...page.matchAll(/(\w+):\s*\{ name: '[^']*', pay: (\d+) \}/g)].map(m => [m[1], +m[2]]));
  check(JSON.stringify(pageWeights) === JSON.stringify(reels.WEIGHTS), 'reel weights match slots.html');
  check(JSON.stringify(pageNickels) === JSON.stringify(reels.NICKEL_PAY), 'nickel pays match slots.html');
  check(Object.entries(pagePays).every(([k, v]) => reels.PAY[k] === v) && Object.keys(pagePays).length === 6, 'symbol pays match slots.html');
  let rtp = 0; const ks = Object.keys(reels.WEIGHTS), N = 23 ** 3;
  for (const a of ks) for (const b of ks) for (const c of ks) rtp += reels.WEIGHTS[a] * reels.WEIGHTS[b] * reels.WEIGHTS[c] / N * reels.payFor([a, b, c]);
  check(Math.abs(rtp - 0.941) < 0.001, 'return to player is 94.1%', rtp.toFixed(4));

  let r = await call('GET', null, {});
  check(r.code === 200 && r.enabled === false, 'switched off unless SLOTS_ENABLED=1');
  r = await call('POST', { action: 'login', wallet: player.publicKey.toBase58() });
  check(r.code === 503, 'switched off: no sign-in', r.error);
  process.env.SLOTS_ENABLED = '1';

  r = await call('GET', null, { wallet: player.publicKey.toBase58() });
  check(r.enabled && r.maxBet === 1000 && r.balance === 0, 'GET: on, 300k pot allows max bet 1000', JSON.stringify(r));

  // sign-in
  const { message } = await call('POST', { action: 'login', wallet: player.publicKey.toBase58() });
  r = await call('POST', { action: 'login', wallet: player.publicKey.toBase58(), signature: signText(message, other) });
  check(r.code === 401, 'sign-in with another wallet\'s signature refused', r.error);
  r = await login(player); const S = r.session;
  check(r.code === 200 && S, 'player signs in');
  r = await call('POST', { action: 'spin', session: 'f'.repeat(48), bet: 10 });
  check(r.code === 401, 'unknown session refused');
  r = await call('POST', { action: 'spin', session: S, bet: 10 });
  check(r.code === 402, 'spin with no balance refused', r.error);
  await wait(320);

  // deposit
  r = await deposit(S, player, 1_000);
  check(r.code === 200 && r.balance === 1000, 'deposit 1000 credited', JSON.stringify(r));
  check(balance(player.publicKey) === 4000 && balance(pot.publicKey) === 301_000, 'tokens moved on chain', `${balance(player.publicKey)} / ${balance(pot.publicKey)}`);
  r = await call('POST', { action: 'deposit', session: S, amount: 1 });
  check(r.code === 400, 'deposit under the minimum refused', r.error);
  r = await call('POST', { action: 'deposit', session: S, amount: 99_999 });
  check(r.code === 400, 'deposit over wallet balance refused', r.error);
  const O = (await login(other)).session;
  r = await call('POST', { action: 'deposit', session: S, amount: 100 });
  let tx = w3.VersionedTransaction.deserialize(Buffer.from(r.tx, 'base64')); tx.sign([player]);
  r = await call('POST', { action: 'deposit', session: O, signed: b64(tx.serialize()) });
  check(r.code === 400, 'another session cannot submit my deposit', r.error);
  r = await call('POST', { action: 'deposit', session: S, amount: 100 });
  tx = w3.VersionedTransaction.deserialize(Buffer.from(r.tx, 'base64'));
  tx.message.compiledInstructions[3].data[2] ^= 1; tx.sign([player]);
  r = await call('POST', { action: 'deposit', session: S, signed: b64(tx.serialize()) });
  check(r.code === 400, 'tampered deposit refused', r.error);

  // spins
  r = await call('POST', { action: 'spin', session: S, bet: 7 });
  check(r.code === 400, 'bet not on the machine refused');
  let bal = 1000, ok = true;
  for (let i = 0; i < 12; i++) {
    r = await call('POST', { action: 'spin', session: S, bet: 50 });
    const line = r.stops.map((s, k) => reels.STRIPS[k][s]);
    bal += r.win - 50;
    ok = ok && r.code === 200 && r.mult === reels.payFor(line) && r.win === r.mult * 50 && r.balance === bal;
    if (i === 0) { const q = await call('POST', { action: 'spin', session: S, bet: 50 }); check(q.code === 429, 'spins too close together refused'); }
    await wait(320);
  }
  check(ok, '12 spins: wins follow the paytable and the balance adds up', `balance ${bal}`);
  process.env.SLOTS_BETS = '10,50,100,500,1000,2000';
  r = await call('POST', { action: 'spin', session: S, bet: 2000 });
  check(r.code === 409 && r.maxBet === 1000, 'bet the pot cannot cover refused', r.error);
  delete process.env.SLOTS_BETS;

  // withdraw
  r = await call('POST', { action: 'withdraw', session: S, amount: bal + 1 });
  check(r.code === 400, 'withdraw more than balance refused', r.error);
  const before = balance(player.publicKey);
  r = await call('POST', { action: 'withdraw', session: S, amount: 100 });
  check(r.code === 200 && r.balance === bal - 100 && balance(player.publicKey) === before + 100, 'withdraw 100 lands in the wallet', JSON.stringify(r));
  bal -= 100;

  // slow confirmation: the deposit waits as pending, then credits exactly once
  rpc.slow = true;
  r = await deposit(S, player, 200);
  check(r.code === 200 && r.pending && r.balance === bal, 'slow deposit is pending', JSON.stringify(r));
  rpc.slow = false;
  const sig = r.signature;
  r = await call('POST', { action: 'deposit', session: O, check: sig });
  check(r.balance === 0, 'another wallet cannot claim my pending deposit');
  r = await call('POST', { action: 'deposit', session: S, check: sig });
  check(r.balance === bal + 200 && !r.pending, 'pending deposit credited after it lands', JSON.stringify(r));
  r = await call('POST', { action: 'deposit', session: S, check: sig });
  check(r.balance === bal + 200, 'checking again does not credit twice');
  bal += 200;

  r = await call('GET', null, { wallet: player.publicKey.toBase58() });
  check(r.balance === bal, 'GET shows the balance', r.balance);
  const mint = process.env.RSN_MINT; process.env.RSN_MINT = w3.Keypair.generate().publicKey.toBase58();
  r = await call('GET', null, { wallet: player.publicKey.toBase58() });
  check(r.balance === 0, 'a new mint (relaunch) starts balances at zero');
  process.env.RSN_MINT = mint;
  process.exit(process.exitCode || 0);
})();
