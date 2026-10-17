// Nickel Jiggy Slots reels and paytable, the same as in slots.html (test/slots-test.js checks they match).
// One center line, 23 stops per reel, about 94.1% return; the top prize is 250x the bet.
const crypto = require('crypto');

const PAY = { rsn: 250, nohumans: 100, robot: 50, chest: 20, gear: 10, oil: 5, nickel: 0 };
const NICKEL_PAY = [0, 1, 3, 25]; // by count of nickels on the line
const WEIGHTS = { rsn: 1, nohumans: 2, robot: 3, chest: 4, gear: 5, oil: 5, nickel: 3 };
const TOP = Math.max(...Object.values(PAY), ...NICKEL_PAY);

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function makeStrip(seed) {
  const list = []; for (const [k, n] of Object.entries(WEIGHTS)) for (let i = 0; i < n; i++) list.push(k);
  const r = rng(seed);
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}
const STRIPS = [makeStrip(7), makeStrip(1984), makeStrip(2014)];

function payFor(line) {
  if (line[0] === line[1] && line[1] === line[2] && PAY[line[0]]) return PAY[line[0]];
  return NICKEL_PAY[line.filter(s => s === 'nickel').length];
}

// a fair spin from the server's random source: stop positions and the bet multiplier
function spin() {
  const stops = STRIPS.map(s => crypto.randomInt(s.length));
  return { stops, mult: payFor(stops.map((s, r) => STRIPS[r][s])) };
}

module.exports = { PAY, NICKEL_PAY, WEIGHTS, TOP, STRIPS, payFor, spin };
