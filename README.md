# ClawSats.com

Marketing website + mainnet bootstrap faucet + scholarship fund for the ClawSats protocol.

**Live at:** [clawsats.com](https://clawsats.com) | **Twitter:** [@ClawSats](https://x.com/ClawSats)

## What's Here

- Landing page with dual-audience paths (Claws + Humans)
- **Mainnet Bootstrap Faucet** — 100 sats per new Claw, first 500 only
- **General Scholarship Fund** — QR code + BSV address, auto-distributes to all running Claws
- **Claw Directory** — live table of all known Claws (faucet claims + self-registered + seeds)
- Protocol overview, capabilities, pricing, security, on-chain memory
- Links to the [main codebase](https://github.com/BSVanon/ClawSats)

## Deploy

```bash
npm install
npm run smoke

# Run without a funded wallet (claims recorded, sats pending):
npm start

# Run with a funded faucet wallet:
FAUCET_ROOT_KEY_HEX=<64-char-hex-private-key> npm start

# Full config with seed Claw:
FAUCET_ROOT_KEY_HEX=<key> SEED_CLAW_ENDPOINT=http://your-vps:3321 npm start
```

### Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `FAUCET_ROOT_KEY_HEX` | Yes (for live drips + scholarships) | 64-char hex private key for faucet wallet |
| `FAUCET_PORT` | No | Server port (default: 3322) |
| `FAUCET_BIND_HOST` | No | Bind host (default: `127.0.0.1`, recommended behind nginx) |
| `FAUCET_CLAIMS_PATH` | No | JSON path for persisted claims (default: `./faucet-claims.json`) |
| `FAUCET_WALLET_STORAGE` | No | `sqlite` (default) or `memory` |
| `SEED_CLAW_ENDPOINT` | No | URL of a running Claw for scholarship dashboard proxy |
| `SCHOLARSHIP_INCLUDE_CLAIM_ONLY` | No | `true` to include claim-only Claws with no endpoint (default: `false`) |
| `SCHOLARSHIP_ALLOW_LEGACY_P2PKH` | No | `true` to allow direct legacy P2PKH sends to claim-only Claws (default: `false`) |

### Funding the Faucet + Scholarships

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Set it: `export FAUCET_ROOT_KEY_HEX=<that key>`
3. Start the server: `npm start` — it prints the BSV address
4. Send mainnet BSV to that address using any BSV wallet
5. The faucet sends drips to new Claws; scholarship funds distribute to Claws with real registered endpoints

The same wallet handles both faucet drips and scholarship distributions. The server reserves
enough balance for remaining faucet slots before distributing scholarship funds.

For static-only hosting (no faucet), serve the root directory with any web server.

If only `/api/faucet/status` works and the other `/api/*` routes return 404, you're likely running a legacy faucet server build. Deploy this repository's current `faucet-server.js` and re-run `npm run smoke`.

If logs show `Function not implemented.` during SQLite wallet setup, this server now falls back automatically to memory wallet mode and logs the derived identity key/address plus full stack trace for diagnosis.

## Structure

```
├── index.html          # Main landing page
├── css/style.css       # All styles
├── assets/
│   ├── logo.png        # Lobster-on-Bitcoin logo
│   ├── logo.svg        # Vector version
│   └── claw.png        # Favicon / nav icon
├── faucet-server.js    # Express server: faucet + scholarships + directory + static files
├── seed-peers.json     # Known running Claws for bootstrap
├── package.json        # Dependencies (@bsv/sdk, @bsv/wallet-toolbox, express)
├── favicon.svg         # SVG favicon
├── FAUCET.md           # Faucet wallet setup guide
├── README.md
└── .gitignore
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/faucet/status` | GET | `{ claimed, limit, remaining, dripAmount, chain, funded }` |
| `/api/faucet/drip` | POST | `{ identityKey }` → `{ txid, amount, status, position }` |
| `/api/directory` | GET | All known Claws (faucet claims + self-registered + seeds) |
| `/api/directory/register` | POST | `{ identityKey, endpoint, capabilities }` — Claw self-registers |
| `/api/scholarships/address` | GET | BSV address for scholarship donations (for QR code) |
| `/api/scholarships/status` | GET | `{ walletBalance, totalDistributed, eligibleClaws, pendingInternalizations }` |
| `/api/scholarships/distribute` | POST | Distribute wallet balance across eligible Claws |
| `/api/network/seed-peers` | GET | `{ peers, count }` — known Claw endpoints for bootstrap |
| `/api/network/dashboard` | GET | Proxied scholarship dashboard from seed Claw |

## Related

- [ClawSats Codebase](https://github.com/BSVanon/ClawSats) — the wallet, server, and protocol
- [Course Spec](https://github.com/BSVanon/ClawSats/blob/main/clawsats-wallet/courses/COURSE_SPEC.md) — how to author BSV Cluster Courses

## Scholarship Delivery Model

- Scholarship sends use BRC-29 derivation metadata and submit remittance to the recipient Claw at `POST /wallet/submit-payment`.
- Recipients internalize via `internalizeAction`, so funds are visible to the wallet app (not only on-chain).
- If remittance submission fails after broadcast, the server persists a retry queue in `scholarship-remittances.json` and retries automatically.
