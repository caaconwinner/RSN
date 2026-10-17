// Solana wallet connect for the arcade: RSNWallet.pick() shows the #wallet-picker list and resolves with
//   { name, address, sign(txBytes, cluster) -> signed bytes, signMessage(bytes) -> signature bytes, disconnect() }
// or rejects if the visitor closes it. Wallets come from the Wallet Standard (Phantom, Solflare, Backpack and most
// others), with the older window.phantom / window.solflare / window.backpack objects as a fallback.
// Same discovery as js/faucet-claim.js; ?rsn on the page URL brings people back here from a wallet app.
(() => {
  const picker = document.getElementById('wallet-picker');
  const list = document.getElementById('wallet-list');
  if (!picker) return;
  const WEB3 = 'https://unpkg.com/@solana/web3.js@1.95.8/lib/index.iife.min.js';
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

  const standard = [];
  const register = (...ws) => {
    for (const w of ws) {
      const f = w.features || {};
      if (!w.chains?.some(c => c.startsWith('solana:')) || !f['standard:connect'] || !f['solana:signTransaction']) continue;
      if (!standard.includes(w)) standard.push(w);
    }
    if (!picker.hidden) render();
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
  const noSignMessage = () => { throw new Error('This wallet cannot sign in here. Try Phantom, Solflare or Backpack.'); };

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
      async signMessage(bytes) {
        const f = w.features['solana:signMessage'];
        if (!f) noSignMessage();
        const [out] = await f.signMessage({ account, message: bytes });
        return out.signature;
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
      async signMessage(bytes) {
        if (typeof p.signMessage !== 'function') noSignMessage();
        const out = await p.signMessage(bytes, 'utf8');
        return out?.signature || out;
      },
      disconnect: () => p.disconnect?.(),
    };
  };

  let pending = null; // { ok, fail } of the open pick()
  const render = () => {
    const seen = new Set(), items = [];
    for (const w of standard) { seen.add(w.name.toLowerCase()); items.push({ name: w.name, icon: w.icon, go: () => viaStandard(w) }); }
    for (const [name, p] of legacy()) if (!seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); items.push({ name, go: () => viaLegacy(name, p) }); }
    const here = new URL(location.href); here.searchParams.set('rsn', '');
    const page = encodeURIComponent(here.href), ref = encodeURIComponent(location.origin);
    const missing = KNOWN.filter(k => !seen.has(k.name.toLowerCase()) && (!mobile || k.open));
    list.innerHTML = items.map((it, i) => `<li><button type="button" data-i="${i}">${it.icon ? `<img src="${esc(it.icon)}" alt="">` : '<span class="wp-dot"></span>'}${esc(it.name)}<small>Detected</small></button></li>`).join('')
      + missing.map(k => `<li><a href="${mobile ? `${k.open(page)}?ref=${ref}` : k.site}"${mobile ? '' : ' target="_blank" rel="noopener"'}><span class="wp-dot"></span>${k.name}<small>${mobile ? 'Open in app' : 'Install'}</small></a></li>`).join('');
    list.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => choose(items[b.dataset.i])));
    document.getElementById('wallet-note').textContent = items.length ? '' : mobile
      ? 'Phone browsers can\'t reach your wallet. Open this page in your wallet app instead.'
      : 'No Solana wallet found in this browser.';
  };
  const close = err => {
    picker.hidden = true;
    const p = pending; pending = null;
    if (p && err) p.fail(err);
    return p;
  };
  const choose = async item => {
    const p = close();
    if (!p) return;
    try { p.ok(await item.go()); } catch (e) { p.fail(e); }
  };
  picker.addEventListener('click', e => { if (e.target === picker || e.target.closest('.wp-close')) close(new Error('Connection cancelled.')); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !picker.hidden) close(new Error('Connection cancelled.')); });

  window.RSNWallet = {
    pick() {
      close(new Error('Connection cancelled.'));
      return new Promise((ok, fail) => {
        pending = { ok, fail };
        render(); picker.hidden = false; picker.querySelector('button, a')?.focus();
      });
    },
  };
})();
