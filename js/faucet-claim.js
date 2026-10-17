// Nickel Faucet claim flow:
//   Fill my nickels -> pick a wallet -> connected (Disconnect link) -> Fill it
//   -> Tock turns the valve -> confirm in wallet -> nickels sent, Solscan link -> 4 hour countdown
// Wallets are found through the Wallet Standard (Phantom, Solflare, Backpack and most others register
// themselves), with the older window.phantom / window.solflare / window.backpack objects as a fallback.
// The claim service lives at /api/claim:
//   GET  /api/claim?wallet=<address>   -> { nextClaimAt }              (ms timestamp, 0 = can claim now)
//   POST /api/claim { wallet }          -> { tx }                       (base64 transaction, fee paid by the faucet)
//   POST /api/claim { wallet, signed }  -> { signature, nextClaimAt }   (visitor-signed tx, faucet signs and sends)
(() => {
  const openBtn = document.getElementById('faucet-open');
  const claimBtn = document.getElementById('faucet-claim');
  const msg = document.getElementById('faucet-msg');
  const who = document.getElementById('faucet-wallet');
  const picker = document.getElementById('wallet-picker');
  const list = document.getElementById('wallet-list');
  if (!openBtn || !picker || !window.RSNFaucet) return;

  const WEB3 = 'https://unpkg.com/@solana/web3.js@1.95.8/lib/index.iife.min.js';
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const say = html => { msg.innerHTML = html; };
  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  let timer, conn = null; // conn: { name, address, sign(bytes) -> signed bytes, disconnect() }

  // ---- wallet discovery -------------------------------------------------------------------
  const standard = [];
  const register = (...ws) => {
    for (const w of ws) {
      const f = w.features || {};
      if (!w.chains?.some(c => c.startsWith('solana:')) || !f['standard:connect'] || !f['solana:signTransaction']) continue;
      if (!standard.includes(w)) standard.push(w);
    }
    if (!picker.hidden) renderPicker();
    return () => {};
  };
  const wsApi = { register };
  addEventListener('wallet-standard:register-wallet', e => { try { e.detail(wsApi); } catch {} });
  dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: wsApi }));

  const legacy = () => [
    ['Phantom', window.phantom?.solana], ['Solflare', window.solflare], ['Backpack', window.backpack],
  ].filter(([, p]) => p && typeof p.connect === 'function');

  const KNOWN = [
    { name: 'Phantom', site: 'https://phantom.app/', open: p => `https://phantom.app/ul/browse/${p}` },
    { name: 'Solflare', site: 'https://solflare.com/', open: p => `https://solflare.com/ul/v1/browse/${p}` },
    { name: 'Backpack', site: 'https://backpack.app/' },
  ];

  const chain = cluster => cluster === 'mainnet-beta' || cluster === 'mainnet' ? 'solana:mainnet' : `solana:${cluster || 'devnet'}`;

  const viaStandard = async w => {
    const { accounts } = await w.features['standard:connect'].connect();
    const account = (accounts && accounts[0]) || w.accounts[0];
    if (!account) throw new Error('No account was shared by the wallet.');
    return {
      name: w.name, address: account.address,
      async sign(bytes, cluster) {
        const c = chain(cluster);
        const [out] = await w.features['solana:signTransaction'].signTransaction(
          { account, transaction: bytes, ...(account.chains?.includes(c) || w.chains.includes(c) ? { chain: c } : {}) });
        return out.signedTransaction;
      },
      disconnect: () => w.features['standard:disconnect']?.disconnect(),
    };
  };
  const loadWeb3 = () => window.solanaWeb3 ? Promise.resolve(window.solanaWeb3) : new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = WEB3; s.onload = () => ok(window.solanaWeb3); s.onerror = () => fail(new Error('Could not load the Solana library.'));
    document.head.appendChild(s);
  });
  const viaLegacy = async (name, p) => {
    const res = await p.connect();
    const web3 = loadWeb3(); // older wallets want a transaction object, not bytes
    return {
      name, address: (res?.publicKey || p.publicKey).toString(),
      async sign(bytes) {
        const tx = (await web3).VersionedTransaction.deserialize(bytes);
        return (await p.signTransaction(tx)).serialize();
      },
      disconnect: () => p.disconnect?.(),
    };
  };

  // ---- the picker ------------------------------------------------------------------------
  const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const renderPicker = () => {
    const seen = new Set(), items = [];
    for (const w of standard) { seen.add(w.name.toLowerCase()); items.push({ name: w.name, icon: w.icon, go: () => viaStandard(w) }); }
    for (const [name, p] of legacy()) if (!seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); items.push({ name, go: () => viaLegacy(name, p) }); }
    const here = new URL(location.href); here.searchParams.set('faucet', '');
    const page = encodeURIComponent(here.href), ref = encodeURIComponent(location.origin);
    const missing = KNOWN.filter(k => !seen.has(k.name.toLowerCase()) && (!mobile || k.open));
    list.innerHTML = items.map((it, i) => `<li><button type="button" data-i="${i}">${it.icon ? `<img src="${esc(it.icon)}" alt="">` : '<span class="wp-dot"></span>'}${esc(it.name)}<small>Detected</small></button></li>`).join('')
      + missing.map(k => `<li><a href="${mobile ? `${k.open(page)}?ref=${ref}` : k.site}"${mobile ? '' : ' target="_blank" rel="noopener"'}><span class="wp-dot"></span>${k.name}<small>${mobile ? 'Open in app' : 'Install'}</small></a></li>`).join('');
    list.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => connect(items[b.dataset.i])));
    document.getElementById('wallet-note').textContent = items.length ? '' : mobile
      ? 'Phone browsers can\'t reach your wallet. Open this page in your wallet app instead.'
      : 'No Solana wallet found in this browser.';
  };
  const showPicker = () => { renderPicker(); picker.hidden = false; picker.querySelector('button, a')?.focus(); };
  const hidePicker = () => { picker.hidden = true; };
  picker.addEventListener('click', e => { if (e.target === picker || e.target.closest('.wp-close')) hidePicker(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !picker.hidden) hidePicker(); });

  // ---- claim -----------------------------------------------------------------------------
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
      if (left <= 0) { clearInterval(timer); claimBtn.hidden = !conn; claimBtn.disabled = false; say(extra); return; }
      const h = Math.floor(left / 36e5), m = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60;
      say(`${extra}${extra ? '<br>' : ''}Next fill in <b>${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}</b>`);
    };
    tick(); timer = setInterval(tick, 1000);
  };
  const short = a => `${a.slice(0, 4)}…${a.slice(-4)}`;

  const connect = async item => {
    hidePicker();
    openBtn.hidden = true;
    say(`Connecting ${esc(item.name)}…`);
    try {
      conn = await item.go();
    } catch (e) {
      conn = null; openBtn.hidden = false;
      return say(/reject|cancel|denied/i.test(e.message || '') ? 'Connection cancelled.' : esc(e.message || 'Could not connect.'));
    }
    who.querySelector('span').textContent = short(conn.address);
    who.title = conn.address;
    who.hidden = false;
    say('');
    try {
      const { nextClaimAt, cluster } = await api('GET', null, '?wallet=' + encodeURIComponent(conn.address));
      conn.cluster = cluster;
      if (nextClaimAt > Date.now()) return countdown(nextClaimAt, 'This wallet already filled up.');
    } catch {} // not launched yet or a hiccup: Fill it still plays the animation, then says why
    claimBtn.hidden = false; claimBtn.disabled = false;
  };

  const disconnect = () => {
    clearInterval(timer);
    try { conn?.disconnect(); } catch {}
    conn = null;
    who.hidden = true; claimBtn.hidden = true; claimBtn.disabled = false;
    openBtn.hidden = false; openBtn.disabled = false;
    say('');
  };

  openBtn.addEventListener('click', showPicker);
  who.querySelector('button').addEventListener('click', disconnect);

  claimBtn.addEventListener('click', async () => {
    if (!conn) return showPicker();
    const me = conn;
    claimBtn.disabled = true;
    try {
      if (RSNFaucet.state !== 'open') say('Tock is opening the valve…');
      // the animation and building the transaction run together; the wallet asks once the valve is open
      const [built] = await Promise.all([
        api('POST', { wallet: me.address }).then(ok => ({ ok }), err => ({ err })), RSNFaucet.open()]);
      if (conn !== me) return;
      if (built.err) throw built.err; // e.g. "The faucet opens when RSN launches." once the valve is open
      const { tx } = built.ok;
      say('Confirm in your wallet…');
      const signed = await me.sign(unb64(tx), me.cluster);
      say('Sending your nickels…');
      const out = await api('POST', { wallet: me.address, signed: b64(signed) });
      countdown(out.nextClaimAt, `Nickels sent! <a href="https://solscan.io/tx/${out.signature}${out.cluster === 'devnet' ? '?cluster=devnet' : ''}" target="_blank" rel="noopener">View transaction</a>`);
    } catch (e) {
      claimBtn.disabled = false;
      if (e.nextClaimAt > Date.now()) return countdown(e.nextClaimAt, esc(e.message));
      say(/reject|cancel|denied/i.test(e.message || '') ? 'Cancelled in your wallet. Press Fill it to try again.' : esc(e.message || 'Something went wrong. Try again.'));
    }
  });

  // arriving from a wallet app link (?faucet): go straight to the wallet list
  if (new URLSearchParams(location.search).has('faucet')) setTimeout(showPicker, 300);
})();
