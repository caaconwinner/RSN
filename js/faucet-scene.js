// Tock and the Nickel Faucet: three pre-rendered clips drawn on a canvas.
//   dry   loops until the faucet is opened
//   turn  plays once: Tock reaches over and turns the valve, the first drop forms
//   drip  loops for good after that
// Every clip starts and ends on the same idle pose, so "turn" waits for the end of the
// current dry loop before it starts. Open it from anywhere with:
//   RSNFaucet.open().then(() => { /* dripping now */ })
(() => {
  const canvas = document.getElementById('faucet-canvas');
  if (!canvas) return;
  const small = matchMedia('(max-width: 1300px)').matches; // phones: fetch the other clips only when they're needed
  const { w, h, cols, frames, fps } = JSON.parse(canvas.dataset.sheet);
  const ctx = canvas.getContext('2d');
  canvas.width = w; canvas.height = h;
  const clips = {};
  const load = name => clips[name] ||= new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => img.decode().then(() => ok(img), () => ok(img));
    img.onerror = fail;
    img.src = `img/faucet-${name}.webp`;
  });
  let clip = 'dry', frame = 0, sheet = null, wantOpen = false, opened;
  const done = new Promise(r => (opened = r));
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(sheet, (frame % cols) * w, Math.floor(frame / cols) * h, w, h, 0, 0, w, h);
  };
  const tick = async () => {
    frame++;
    if (frame === frames) {
      frame = 0;
      if (clip === 'dry' && wantOpen) clip = 'turn';
      else if (clip === 'turn') { clip = 'drip'; opened(); }
      sheet = await load(clip);
    }
    draw();
    setTimeout(tick, 1000 / fps);
  };
  load('dry').then(img => {
    sheet = img; draw(); canvas.classList.add('ready');
    setTimeout(tick, 1000 / fps);
    // fetch the other two in the background so opening never stalls
    if (!small) (window.requestIdleCallback || setTimeout)(() => { load('turn'); load('drip'); });
  });
  window.RSNFaucet = {
    ready: true,
    open() { wantOpen = true; load('turn'); load('drip'); return done; },
    get state() { return clip === 'dry' ? (wantOpen ? 'opening' : 'closed') : clip === 'turn' ? 'opening' : 'open'; },
  };
})();
