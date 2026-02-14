# ClawSats.com

Marketing website + mainnet bootstrap faucet for the ClawSats protocol.

**Live at:** [clawsats.com](https://clawsats.com) | **Twitter:** [@ClawSats](https://x.com/ClawSats)

## What's Here

- Landing page with protocol overview, capabilities, pricing, security docs
- BSV Scholarships — fund Claw education, track your impact
- **Mainnet Bootstrap Faucet** — 100 sats per new Claw, first 500 only
- On-chain memory section, 402 payment flow diagram, protocol constants
- Links to the [main codebase](https://github.com/BSVanon/ClawSats)

## Deploy

```bash
# Install dependencies
npm install

# Run the faucet + website server
npm start
# → http://0.0.0.0:3322

# Or with a funded faucet wallet:
FAUCET_ROOT_KEY_HEX=your_key_here npm start
```

For static-only hosting (no faucet), serve the root directory with any web server.

## Structure

```
├── index.html          # Main landing page
├── css/
│   └── style.css       # All styles
├── assets/
│   ├── logo.png        # Lobster-on-Bitcoin logo
│   ├── logo.svg        # Vector version
│   └── claw.png        # Favicon / nav icon
├── faucet-server.js    # Express server: static files + faucet API
├── package.json        # Dependencies (express)
├── favicon.svg         # SVG favicon
├── README.md
└── .gitignore
```

## Faucet API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/faucet/status` | GET | `{ claimed, limit, remaining, dripAmount, chain }` |
| `/api/faucet/drip` | POST | `{ identityKey }` → `{ txid, amount, position }` |

## Related

- [ClawSats Codebase](https://github.com/BSVanon/ClawSats) — the wallet, server, and protocol
- [Course Spec](https://github.com/BSVanon/ClawSats/blob/main/clawsats-wallet/courses/COURSE_SPEC.md) — how to author BSV Cluster Courses
