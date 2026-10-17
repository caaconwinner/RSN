# Robot Sex Nickels

Website for Robot Sex Nickels (RSN), rebuilt on the original 2014 robotsexnickels.com theme, plus the Arcade slot machine.

- `index.html`: the main site
- `slots.html`: Nickel Jiggy Slots (Fun nickels, plus a Real RSN mode that is off until `SLOTS_ENABLED=1`)
- `img/`: original theme art and arcade graphics
- `js/faucet-claim.js` + `api/claim.js`: the Nickel Faucet (free RSN, one fill per wallet every 4 hours)
- `js/slots-rsn.js` + `js/wallet.js` + `api/slots.js`: Real RSN mode for the slots

Static site, no build step. Deployed on Vercel: import the repo and press Deploy.

## Nickel Faucet

Visitors press **Fill my nickels**, Tock opens the valve, they press **Fill it** and approve in their Solana wallet (Phantom, Solflare, Backpack). The faucet wallet pays every network fee and the new-token-account deposit, so the visitor needs no SOL. Each wallet can fill once per cooldown, and the page then shows a countdown.

`api/claim.js` builds the transfer with the faucet as fee payer, the visitor co-signs it (proving they own the wallet), and the server only adds its own signature to that exact transaction. Until the settings below exist, the faucet answers "opens when RSN launches".

Set these in Vercel → Project → Settings → Environment Variables. Never commit keys.

| Variable | What it is |
| --- | --- |
| `FAUCET_SECRET_KEY` | Faucet hot wallet key (base58 export from Phantom, or a JSON byte array). Use a fresh wallet that only holds a small refillable supply of RSN plus a little SOL for fees. |
| `RSN_MINT` | RSN token mint (contract) address. Classic SPL and Token-2022 both work. |
| `SOLANA_RPC_URL` | Defaults to devnet. For mainnet use a dedicated RPC (e.g. a free Helius or QuickNode endpoint); the public mainnet RPC rate-limits hard. |
| `SOLANA_CLUSTER` | `devnet` (default) or `mainnet`, for the Solscan link. |
| `CLAIM_AMOUNT` | RSN per fill, default 10,000 (about $1 each at a $100k market cap). |
| `CLAIM_COOLDOWN_HOURS` | Default 4. |
| `IP_CLAIMS_PER_WINDOW` | Fills per IP address per cooldown, default 3 (stops one person farming many wallets). |
| `DAILY_CLAIM_CAP` | Fills per day for everyone combined, default 500 (caps the damage of a bot wave). |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Claim records. Add the free **Upstash for Redis** integration from Vercel's Marketplace (Storage tab) and these are filled in for you. |

Each fill costs the faucet under 0.00002 SOL in fees, plus about 0.002 SOL the first time a wallet receives RSN (the token account deposit).

## Real RSN slots

The **Real RSN** switch above the machine lets players sign in with their wallet (a free message signature), deposit RSN into the pot wallet, play, and withdraw back to the same wallet. Every spin is drawn on the server (`api/slots.js`, same reels and paytable as the page, about 94.1% return, top prize 250x the bet). A bet is only accepted while the pot can pay its top prize on top of what it already owes players, so the largest bet shrinks automatically when the pot runs low.

Sizing: with bets of 10 / 50 / 100 / 500 / 1,000 RSN the top prize is 250,000 RSN. A pot of 2,000,000 RSN has about a 1 in 2,000 chance of ever running dry (1,000,000 RSN: about 1 in 250). Over time the pot keeps about 6% of what is bet.

Off by default. It uses `RSN_MINT`, `SOLANA_RPC_URL`, `SOLANA_CLUSTER` and the Upstash variables above, plus:

| Variable | What it is |
| --- | --- |
| `SLOTS_ENABLED` | `1` turns Real RSN on. Anything else shows "opens soon". |
| `SLOTS_POT_SECRET_KEY` | Pot hot wallet key. A separate wallet from the faucet, holding the pot RSN plus some SOL for withdrawal fees. |
| `SLOTS_BETS` | Bets in whole RSN, default `10,50,100,500,1000`. |
| `SLOTS_MIN_DEPOSIT` | Default 10. |

Players pay the network fee on deposits; the pot pays it on withdrawals. Balances are stored per mint, so changing `RSN_MINT` for a relaunch starts everyone at zero (have players withdraw first).

Tests run the whole claim flow and the slots deposit / spin / withdraw flow against an in-process Solana VM: `npm install && npm test` (and `npm run test:2022` for Token-2022 mints).

Artwork by Laura Fletcher, used with permission. Tock The Robot 3D model by snowcapstudios (blendswap.com).
