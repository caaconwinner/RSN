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
const sha = buf => crypto.createHash('sha256').update(buf).digest('base64');
const verifySig = (pubkeyBytes, msg, sig) => crypto.verify(null, msg, crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubkeyBytes)]), format: 'der', type: 'spki',
}), sig);
const clientIp = req => String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
const readBody = req => { const b = req.body || {}; return typeof b === 'string' ? JSON.parse(b || '{}') : b; };

module.exports = { env, num, kv, count, storeReady, secretKey, sha, verifySig, clientIp, readBody };
