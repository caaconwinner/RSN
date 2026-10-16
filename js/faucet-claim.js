// Nickel Faucet claim flow (wide screens, under the faucet):
//   Fill my nickels -> Tock turns the valve -> Fill it -> wallet connect + confirm -> Solscan link -> 4 hour countdown
// The claim service lives at /api/claim:
//   GET  /api/claim?wallet=<address>   -> { nextClaimAt }              (ms timestamp, 0 = can claim now)
//   POST /api/claim { wallet }          -> { tx }                       (base64 transaction, fee paid by the faucet)
//   POST /api/claim { wallet, signed }  -> { signature, nextClaimAt }   (visitor-signed tx, faucet signs and sends)
(() => {
  const openBtn = document.getElementById('faucet-open');
  const claimBtn = document.getElementById('faucet-claim');
  const msg = document.getElementById('faucet-msg');
  if (!openBtn || !window.RSNFaucet) return;

  const WEB3 = 'https://unpkg.com/@solana/web3.js@1.95.8/lib/index.iife.min.js';
  const say = html => { msg.innerHTML = html; };
  let timer;

  const wallet = () => {
    const w = window.phantom?.solana || window.solflare || window.backpack || window.solana;
    return w && typeof w.connect === 'function' ? w : null;
  };
  const loadWeb3 = () => window.solanaWeb3 ? Promise.resolve(window.solanaWeb3) : new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = WEB3; s.onload = () => ok(window.solanaWeb3); s.onerror = () => fail(new Error('Could not load the Solana library.'));
    document.head.appendChild(s);
  });
  const api = async (method, body, query = '') => {
    const r = await fetch('/api/claim' + query, method === 'GET' ? {} : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'The faucet is not answering right now.'), data);
    return data;
  };
  const countdown = (until, extra = '') => {
    clearInterval(timer);
    claimBtn.hidden = true;
    const tick = () => {
      const left = until - Date.now();
      if (left <= 0) { clearInterval(timer); claimBtn.hidden = false; claimBtn.disabled = false; say(extra); return; }
      const h = Math.floor(left / 36e5), m = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60;
      say(`${extra}${extra ? '<br>' : ''}Next fill in <b>${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}</b>`);
    };
    tick(); timer = setInterval(tick, 1000);
  };

  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true; openBtn.textContent = 'Tock is on it…';
    await RSNFaucet.open();
    openBtn.hidden = true; claimBtn.hidden = false;
  });

  claimBtn.addEventListener('click', async () => {
    const w = wallet();
    if (!w) { say('You need a Solana wallet such as <a href="https://phantom.app/" target="_blank" rel="noopener">Phantom</a> or <a href="https://solflare.com/" target="_blank" rel="noopener">Solflare</a>.'); return; }
    claimBtn.disabled = true;
    try {
      say('Connecting your wallet…');
      const res = await w.connect();
      const address = (res?.publicKey || w.publicKey).toString();
      const { nextClaimAt } = await api('GET', null, '?wallet=' + encodeURIComponent(address));
      if (nextClaimAt > Date.now()) { countdown(nextClaimAt, 'This wallet already filled up.'); return; }
      say('Pouring your nickels… confirm in your wallet.');
      const [web3, { tx }] = await Promise.all([loadWeb3(), api('POST', { wallet: address })]);
      const unsigned = web3.VersionedTransaction.deserialize(Uint8Array.from(atob(tx), c => c.charCodeAt(0)));
      const signed = await w.signTransaction(unsigned);
      say('Sending…');
      const out = await api('POST', { wallet: address, signed: btoa(String.fromCharCode(...signed.serialize())) });
      countdown(out.nextClaimAt, `Nickels sent! <a href="https://solscan.io/tx/${out.signature}${out.cluster === 'devnet' ? '?cluster=devnet' : ''}" target="_blank" rel="noopener">View transaction</a>`);
    } catch (e) {
      claimBtn.disabled = false;
      if (e.nextClaimAt > Date.now()) return countdown(e.nextClaimAt, e.message);
      say(/reject|cancel|denied/i.test(e.message || '') ? 'Cancelled in your wallet. Press Fill it to try again.' : e.message || 'Something went wrong. Try again.');
    }
  });
})();
