// Real RSN mode for Nickel Jiggy Slots. The Fun / Real RSN switch above the machine; in RSN mode the player signs
// in with their wallet (a free message signature), deposits RSN into the pot, and every spin is drawn by /api/slots.
// The machine itself (slots.html) only animates the stops the server sends back, through window.RSNSlots.
(() => {
  const $ = id => document.getElementById(id);
  const funBtn = $('mode-fun'), rsnBtn = $('mode-rsn'), panel = $('rsn-panel');
  if (!funBtn || !window.RSNSlots || !window.RSNWallet) return;
  const msg = $('rsn-msg'), who = $('rsn-who'), amount = $('rsn-amount');
  const plate = document.querySelector('.plate'), plateHtml = plate.innerHTML;
  const say = html => { msg.innerHTML = html; };
  const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const short = a => `${a.slice(0, 4)}…${a.slice(-4)}`;
  const fmt = n => Number(n).toLocaleString('en-US');
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('rsn-slots-session')) || null; } catch { return null; } },
    set(v) { try { v ? localStorage.setItem('rsn-slots-session', JSON.stringify(v)) : localStorage.removeItem('rsn-slots-session'); } catch {} },
  };

  let info = null;          // GET /api/slots: { enabled, cluster, bets, maxBet, minDeposit, top }
  let wallet = null;        // connected wallet, only needed to sign in and to deposit
  let auth = store.get();   // { address, session }
  let real = null;          // what the machine plays with while in RSN mode

  const api = async (body, query = '') => {
    const r = await fetch('/api/slots' + query, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && data.signin) signOut();
    if (!r.ok) throw Object.assign(new Error(data.error || 'The machine is not answering right now.'), data);
    return data;
  };
  const txLink = (sig, label) => `<a href="https://solscan.io/tx/${sig}${info.cluster === 'devnet' ? '?cluster=devnet' : ''}" target="_blank" rel="noopener">${label}</a>`;
  const cancelled = e => /reject|cancel|denied|declined/i.test(e.message || '');

  const render = () => {
    const signedIn = !!auth;
    $('rsn-connect').hidden = signedIn;
    who.hidden = !signedIn;
    if (signedIn) who.querySelector('span').textContent = short(auth.address);
    $('rsn-cash').hidden = !signedIn;
    $('rsn-info').textContent = info?.enabled
      ? `${info.cluster === 'devnet' ? 'Test network (devnet). ' : ''}Bets ${info.bets.map(fmt).join(' / ')} RSN, top prize ${info.top}× the bet.`
        + (real && real.maxBet < info.bets[info.bets.length - 1] ? ` The pot covers bets up to ${fmt(real.maxBet)} RSN right now.` : '')
      : '';
  };

  const signOut = () => {
    auth = null; store.set(null);
    if (real) { real.balance = 0; RSNSlots.update(); }
    render();
  };

  const connect = async () => {
    wallet = await RSNWallet.pick();
    if (auth && auth.address !== wallet.address) signOut();
    if (!auth) {
      say('Sign the message in your wallet. It is free and sends nothing.');
      const { message } = await api({ action: 'login', wallet: wallet.address });
      const signature = await wallet.signMessage(new TextEncoder().encode(message));
      const out = await api({ action: 'login', wallet: wallet.address, signature: b64(signature) });
      auth = { address: wallet.address, session: out.session }; store.set(auth);
      real.balance = out.balance;
    }
    say(real.balance ? '' : 'Deposit some RSN to start playing.');
    RSNSlots.update(); render();
  };

  const refresh = async () => {
    info = await api(null, auth ? '?wallet=' + encodeURIComponent(auth.address) : '');
    if (!info.enabled) return;
    real.bets = info.bets; real.maxBet = info.maxBet;
    if (auth) real.balance = info.balance;
    RSNSlots.update(); render();
  };

  const enter = async () => {
    if (RSNSlots.busy) return;
    funBtn.setAttribute('aria-pressed', 'false'); rsnBtn.setAttribute('aria-pressed', 'true');
    panel.hidden = false; say('Checking the pot…');
    try { info = await api(); } catch (e) { info = null; say(esc(e.message)); }
    if (!info?.enabled) {
      if (info) say('Real RSN play opens soon. Fun nickels are on the house meanwhile!');
      return leave(true);
    }
    real = {
      bets: info.bets, maxBet: info.maxBet, balance: 0, unit: 'RSN',
      async spin(bet) {
        if (!auth) throw new Error('Connect your wallet to play with RSN.');
        try {
          const out = await api({ action: 'spin', session: auth.session, bet });
          real.maxBet = out.maxBet; render();
          return out;
        } catch (e) {
          if (e.maxBet !== undefined) { real.maxBet = e.maxBet; render(); }
          if (e.balance !== undefined) real.balance = e.balance;
          throw e;
        }
      },
      needFunds() { amount.focus(); say(auth ? 'Deposit some RSN to keep playing.' : 'Connect your wallet to play with RSN.'); },
    };
    RSNSlots.attach(real);
    plate.innerHTML = `<span class="long">No humans &middot;&nbsp;</span>Real RSN${info.cluster === 'devnet' ? ' (devnet)' : ''}`;
    say(auth ? '' : 'Connect your wallet to play with RSN.');
    render();
    if (auth) refresh().catch(() => {});
  };

  const leave = keepMsg => {
    if (RSNSlots.busy) return;
    funBtn.setAttribute('aria-pressed', 'true'); rsnBtn.setAttribute('aria-pressed', 'false');
    RSNSlots.detach(); real = null;
    plate.innerHTML = plateHtml;
    if (keepMsg !== true) { panel.hidden = true; say(''); }
    else { $('rsn-connect').hidden = true; who.hidden = true; $('rsn-cash').hidden = true; $('rsn-info').textContent = ''; }
  };

  // deposits wait for the chain; a slow one is checked again until it lands
  const waitFor = async sig => {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const out = await api({ action: 'deposit', session: auth.session, check: sig });
      if (!out.pending) return out;
    }
    throw new Error('The deposit is still on its way. Your balance updates once it lands.');
  };

  const deposit = async () => {
    const n = Math.floor(+amount.value);
    if (!(n >= (info.minDeposit || 1))) return say(`Enter at least ${fmt(info.minDeposit || 1)} RSN.`);
    if (!wallet || wallet.address !== auth.address) {
      say('Connect the wallet you signed in with.');
      await connect();
      if (!auth) return;
    }
    say('Preparing your deposit…');
    const { tx } = await api({ action: 'deposit', session: auth.session, amount: n });
    say('Confirm in your wallet…');
    const signed = await wallet.sign(unb64(tx), info.cluster);
    say('Sending to the pot…');
    let out = await api({ action: 'deposit', session: auth.session, signed: b64(signed) });
    if (out.pending) { say(`Waiting for the network… ${txLink(out.signature, 'View transaction')}`); out = { ...(await waitFor(out.signature)), signature: out.signature }; }
    real.balance = out.balance; RSNSlots.update(); amount.value = '';
    say(`${fmt(n)} RSN deposited. ${txLink(out.signature, 'View transaction')}`);
    refresh().catch(() => {});
  };

  const withdraw = async () => {
    const n = Math.floor(+amount.value) || real.balance;
    if (!(n > 0)) return say('Nothing to withdraw yet.');
    if (!confirm(`Withdraw ${fmt(n)} RSN to ${short(auth.address)}?`)) return;
    say('Sending your RSN…');
    const out = await api({ action: 'withdraw', session: auth.session, amount: n });
    real.balance = out.balance; RSNSlots.update(); amount.value = '';
    say(`${fmt(n)} RSN sent to your wallet. ${txLink(out.signature, 'View transaction')}`);
    refresh().catch(() => {});
  };

  // every button reports its own trouble in the panel
  const guard = fn => async () => {
    const btns = panel.querySelectorAll('button');
    btns.forEach(b => b.disabled = true);
    try { await fn(); } catch (e) { say(cancelled(e) ? 'Cancelled in your wallet.' : esc(e.message || 'Something went wrong. Try again.')); }
    btns.forEach(b => b.disabled = false);
  };
  funBtn.addEventListener('click', () => leave());
  rsnBtn.addEventListener('click', enter);
  $('rsn-connect').addEventListener('click', guard(connect));
  who.querySelector('button').addEventListener('click', () => { try { wallet?.disconnect(); } catch {} wallet = null; signOut(); say('Signed out.'); });
  $('rsn-deposit').addEventListener('click', guard(deposit));
  $('rsn-withdraw').addEventListener('click', guard(withdraw));

  // arriving from a wallet app link (?rsn): straight into RSN mode
  if (new URLSearchParams(location.search).has('rsn')) enter();
})();
