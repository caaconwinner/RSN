# Robot Sex Nickels

Website for Robot Sex Nickels (RSN), rebuilt on the original 2014 robotsexnickels.com theme, plus the Arcade slot machine.

- `index.html`: the main site
- `slots.html`: Nickel Jiggy Slots (play money only)
- `img/`: original theme art and arcade graphics
- `js/faucet-claim.js` + `api/claim.js`: the Nickel Faucet (free RSN, one fill per wallet every 4 hours)

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
| `CLAIM_AMOUNT` | RSN per fill, default 1000. |
| `CLAIM_COOLDOWN_HOURS` | Default 4. |
| `IP_CLAIMS_PER_WINDOW` | Fills per IP address per cooldown, default 3 (stops one person farming many wallets). |
| `DAILY_CLAIM_CAP` | Fills per day for everyone combined, default 500 (caps the damage of a bot wave). |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Claim records. Add the free **Upstash for Redis** integration from Vercel's Marketplace (Storage tab) and these are filled in for you. |

Each fill costs the faucet under 0.00002 SOL in fees, plus about 0.002 SOL the first time a wallet receives RSN (the token account deposit).

Tests run the whole claim flow against an in-process Solana VM: `npm install && npm test` (and `npm run test:2022` for Token-2022 mints).

Artwork by Laura Fletcher, used with permission. Tock The Robot 3D model by snowcapstudios (blendswap.com).
