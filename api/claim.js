// Nickel Faucet claim service. The payout side (faucet wallet, RSN mint, limits) is switched on
// at token launch; until then every request gets a friendly "not open yet".
module.exports = (req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.status(503).json({ error: 'The faucet opens when RSN launches. Check back soon!' });
};
