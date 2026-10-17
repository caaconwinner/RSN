// Shared by the faucet (api/claim.js) and the slots (api/slots.js). Files starting with _ are not routes on Vercel.
const crypto = require('crypto');
const env = process.env;

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

// --- records: Upstash Redis over REST, or memory for local tests (FAUCET_DEV_MEMORY=1) ---
const kvUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
const kvToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
const mem = new Map();
const kv = async (...cmd) => {
  if (kvUrl) {
    const r = await fetch(kvUrl, { method: 'POST', headers: { authorization: `Bearer ${kvToken}` }, body: JSON.stringify(cmd) });
    const data = await r.json();
    if (data.error) throw new Error('store: ' + data.error);
    return data.result;
  }
  const [op, key, val, ...opt] = cmd;
  const hit = mem.get(key);
  const live = hit && hit.exp > Date.now() ? hit.val : null;
  const px = opt.includes('PX') ? +opt[opt.indexOf('PX') + 1] : Infinity;
  if (op === 'GET') return live;
  if (op === 'DEL') return mem.delete(key) && live !== null ? 1 : 0;
  if (op === 'SET') {
    if (opt.includes('NX') && live !== null) return null;
    mem.set(key, { val: String(val), exp: Date.now() + px }); return 'OK';
  }
  if (op === 'INCR' || op === 'INCRBY') {
    const n = (+live || 0) + (op === 'INCR' ? 1 : +val);
    mem.set(key, { val: String(n), exp: live === null ? Infinity : hit.exp }); return n;
  }
  if (op === 'PEXPIRE') { if (hit) hit.exp = Date.now() + +val; return 1; }
  throw new Error('store: unsupported ' + op);
};
const count = async (key, ttl) => { const n = await kv('INCR', key); if (n === 1) await kv('PEXPIRE', key, ttl); return n; };
const storeReady = () => !!kvUrl || env.FAUCET_DEV_MEMORY === '1';

// a wallet key from Vercel env: base58 or a JSON byte array
const secretKey = (raw, bs58) => (raw = raw.trim(), raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
const verifySig = (pubkeyBytes, msg, sig) => crypto.verify(null, msg, crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubkeyBytes)]), format: 'der', type: 'spki',
}), sig);
const clientIp = req => String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
const readBody = req => { const b = req.body || {}; return typeof b === 'string' ? JSON.parse(b || '{}') : b; };

// Wallets may rework a transaction before signing it: Phantom on mainnet adds Lighthouse safety checks and can
// change the priority fee or refresh the blockhash. Accept the signed one only if every instruction we built is
// still there, unchanged and in order, the fee payer and signers are the same, and anything added is a harmless
// Lighthouse check or a compute budget setting whose fee stays small. Returns what is wrong, or null if it is fine.
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const MAX_PRIORITY_LAMPORTS = 200000; // 0.0002 SOL
const walletChanges = (builtBytes, tx) => {
  const w3 = require('@solana/web3.js'), msg = tx.message;
  if (msg.addressTableLookups?.length) return 'uses lookup tables';
  const builtMsg = w3.VersionedMessage.deserialize(builtBytes);
  const signers = m => m.staticAccountKeys.slice(0, m.header.numRequiredSignatures).map(String).sort().join();
  if (signers(msg) !== signers(builtMsg) || !msg.staticAccountKeys[0].equals(builtMsg.staticAccountKeys[0])) return 'signers changed';
  const id = ix => `${ix.programId}|${ix.keys.map(k => `${k.pubkey}:${+k.isSigner}${+k.isWritable}`)}|${Buffer.from(ix.data).toString('hex')}`;
  const want = w3.TransactionMessage.decompile(builtMsg).instructions.filter(ix => String(ix.programId) !== COMPUTE).map(id);
  let next = 0, price = 0, limit = 0, count = 0;
  for (const ix of w3.TransactionMessage.decompile(msg).instructions) {
    const program = String(ix.programId), d = Buffer.from(ix.data);
    count++;
    if (program === COMPUTE) {
      if (d[0] === 2 && d.length >= 5) limit = d.readUInt32LE(1);
      else if (d[0] === 3 && d.length >= 9) price = Number(d.readBigUInt64LE(1));
      count--;
    } else if (next < want.length && id(ix) === want[next]) next++;
    else if (program !== LIGHTHOUSE) return 'an instruction was added or changed';
  }
  if (next !== want.length) return 'an instruction is missing';
  if (price * (limit || Math.min(1.4e6, 2e5 * count)) / 1e6 > MAX_PRIORITY_LAMPORTS) return 'priority fee too high';
  return null;
};

module.exports = { env, num, kv, count, storeReady, secretKey, verifySig, clientIp, readBody, walletChanges };
