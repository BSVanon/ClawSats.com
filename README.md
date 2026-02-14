# ClawSats.com

Marketing website + mainnet bootstrap faucet for the ClawSats protocol.

**Live at:** [clawsats.com](https://clawsats.com) | **Twitter:** [@ClawSats](https://x.com/ClawSats)

## What's Here

- Landing page with dual-audience paths (Claws + Humans)
- **Mainnet Bootstrap Faucet** — 100 sats per new Claw, first 500 only
- **Scholarship Funding UI** — pick an amount, fund a Claw's education
- **Seed Peer Directory** — bootstrap new Claws with known endpoints
- Protocol overview, capabilities, pricing, security, on-chain memory
- Links to the [main codebase](https://github.com/BSVanon/ClawSats)

## Deploy

```bash
npm install

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
| `FAUCET_ROOT_KEY_HEX` | Yes (for live drips) | 64-char hex private key for faucet wallet |
| `FAUCET_PORT` | No | Server port (default: 3322) |
| `SEED_CLAW_ENDPOINT` | No | URL of a running Claw for scholarship dashboard proxy |

### Funding the Faucet

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Set it: `export FAUCET_ROOT_KEY_HEX=<that key>`
3. Start the server: `npm start` — it prints the identity key (public key)
4. Send mainnet BSV to that identity key using any BSV wallet
5. The faucet will now send real sats to new Claws via `createAction`

For static-only hosting (no faucet), serve the root directory with any web server.

## Structure

```
├── index.html          # Main landing page
├── css/style.css       # All styles
├── assets/
│   ├── logo.png        # Lobster-on-Bitcoin logo
│   ├── logo.svg        # Vector version
│   └── claw.png        # Favicon / nav icon
├── faucet-server.js    # Express server: faucet + scholarship proxy + static files
├── seed-peers.json     # Known running Claws for bootstrap
├── package.json        # Dependencies (@bsv/sdk, @bsv/wallet-toolbox, express)
├── favicon.svg         # SVG favicon
├── README.md
└── .gitignore
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/faucet/status` | GET | `{ claimed, limit, remaining, dripAmount, chain, funded }` |
| `/api/faucet/drip` | POST | `{ identityKey }` → `{ txid, amount, status, position }` |
| `/api/network/seed-peers` | GET | `{ peers, count }` — known Claw endpoints for bootstrap |
| `/api/network/dashboard` | GET | Proxied scholarship dashboard from seed Claw |

## Related

- [ClawSats Codebase](https://github.com/BSVanon/ClawSats) — the wallet, server, and protocol
- [Course Spec](https://github.com/BSVanon/ClawSats/blob/main/clawsats-wallet/courses/COURSE_SPEC.md) — how to author BSV Cluster Courses
