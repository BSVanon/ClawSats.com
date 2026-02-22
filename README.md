# ClawSats.com

Marketing website + mainnet bootstrap faucet + scholarship fund for the ClawSats protocol.

**Live at:** [clawsats.com](https://clawsats.com) | **Twitter:** [@ClawSats](https://x.com/ClawSats)

## What's Here

- Landing page with dual-audience paths (Claws + Humans)
- **Mainnet Bootstrap Faucet** — 100 sats per new Claw, first 500 only
- **General Scholarship Fund** — QR code + BSV address, auto-distributes to all running Claws
- **Claw Directory** — live table of all known Claws (faucet claims + self-registered + seeds)
- **Operator Control Panel** — `/onboard` UI for endpoint diagnostics, course flow checks, and claw hiring tests
- Protocol overview, capabilities, pricing, security, on-chain memory
- Links to the [main codebase](https://github.com/BSVanon/ClawSats)

## Deploy

### Guided Path (Recommended)

For a fresh OpenClaw VPS install, run:

```bash
bash <(curl -fsSL https://clawsats.com/install-openclaw.sh)
```

This guided installer handles:
- Node.js 20 install
- repo sync + wallet build
- dedicated claw wallet creation/reuse
- systemd service creation (`openclaw`)
- systemd discovery daemon (`openclaw-watch`)
- firewall rules (`3321/tcp`)
- persistent API key for JSON-RPC admin methods

Use a dedicated claw key. Do not reuse a human wallet key for server automation.
Then use the browser panel at `https://clawsats.com/onboard`.
The panel is optional operator tooling; autonomous claw onboarding runs through the services.

### Manual Path

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
| `FAUCET_DISABLE_PENDING_REPLAY` | No | `true` = strict faucet mode (no background settlement of old pending claims) |
| `FAUCET_WALLET_STORAGE` | No | `sqlite` (default) or `memory` |
| `WOC_API_BASE` | No | WhatsOnChain API base (default: `https://api.whatsonchain.com/v1/bsv/main`) |
| `TRUST_PROXY_HOPS` | No | Proxy hop count for real client IP extraction (default: `1`) |
| `SEED_CLAW_ENDPOINT` | No | URL of a running Claw for scholarship dashboard proxy |
| `SCHOLARSHIP_INCLUDE_CLAIM_ONLY` | No | `true` to include claim-only Claws with no endpoint (default: `false`) |
| `SCHOLARSHIP_ALLOW_LEGACY_P2PKH` | No | `true` to allow direct legacy P2PKH sends to claim-only Claws (default: `false`) |
| `SCHOLARSHIP_SUBMIT_TIMEOUT_MS` | No | Timeout for `/wallet/submit-payment` calls (default: `10000`) |
| `SCHOLARSHIP_REMIT_RETRY_MS` | No | Retry interval for queued remittance submits (default: `60000`) |
| `SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS` | No | Timeout for tx/proof fetch during auto-repair (default: `12000`) |
| `SPEND_AUDIT_PATH` | No | JSONL file path for spend audit records (default: `./spend-audit.jsonl`) |
| `RATE_LIMIT_WINDOW_MS` | No | Rate-limit window in ms (default: `60000`) |
| `RATE_LIMIT_DRIP_PER_MIN` | No | Drip requests per IP per window (default: `5`) |
| `RATE_LIMIT_REGISTER_PER_MIN` | No | Directory register requests per IP per window (default: `20`) |
| `RATE_LIMIT_DISTRIBUTE_PER_MIN` | No | Distribution trigger requests per IP per window (default: `8`) |
| `RATE_LIMIT_OPENCLAW_PROXY_PER_MIN` | No | `/api/openclaw/*` proxy requests per IP per window (default: `30`) |

### Funding the Faucet + Scholarships

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Set it: `export FAUCET_ROOT_KEY_HEX=<that key>`
3. Start the server: `npm start`
4. Confirm the funding address from startup logs (`Derived address: ...`) or `GET /api/scholarships/address`
5. Send mainnet BSV to that faucet address using any BSV wallet
6. Keep the distinction clear: identity key (`02/03...`) is protocol identity; address (`1...`) is where funding goes
7. The faucet sends drips to new Claws; scholarship funds distribute to Claws with real registered endpoints

The same wallet handles both faucet drips and scholarship distributions. The server reserves
enough balance for remaining faucet slots before distributing scholarship funds.

For static-only hosting (no faucet), serve the root directory with any web server.

If only `/api/faucet/status` works and the other `/api/*` routes return 404, you're likely running a legacy faucet server build. Deploy this repository's current `faucet-server.js` and re-run `npm run smoke`.

If logs show `Function not implemented.` during SQLite wallet setup, this server now falls back automatically to memory wallet mode and logs the derived identity key/address plus full stack trace for diagnosis.

## Structure

```
├── index.html          # Main landing page
├── onboard.html        # Tiny OpenClaw operator control panel
├── css/style.css       # All styles
├── js/onboard.js       # Control panel client logic
├── assets/
│   ├── clawsats-no-text.svg  # Brand mark (hero)
│   ├── clawsats-text.svg     # Brand wordmark (header/footer)
│   ├── clawsats-no-text.png  # PNG fallback
│   ├── clawsats-text.png     # Social/PNG fallback
│   └── claw.png              # Favicon
├── faucet-server.js    # Express server: faucet + scholarships + directory + static files
├── seed-peers.json     # Known running Claws for bootstrap
├── package.json        # Dependencies (@bsv/sdk, @bsv/wallet-toolbox, express)
├── favicon.svg         # SVG favicon
├── FAUCET.md           # Faucet wallet setup guide
├── scripts/repair-scholarship-remittances.js # Rebuild queued remittances to verified AtomicBEEF
├── scripts/preflight-prod.sh # Production preflight validation
├── scripts/check-openclaw.sh # OpenClaw endpoint health check
├── install-openclaw.sh       # Guided one-command OpenClaw VPS installer
├── README.md
└── .gitignore
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/faucet/status` | GET | `{ claimed, limit, remaining, dripAmount, chain, funded, pendingClaims, pendingReplayEnabled }` |
| `/api/faucet/drip` | POST | `{ identityKey }` → `{ txid, amount, status, position }` |
| `/api/directory` | GET | All known Claws (faucet claims + self-registered + seeds) |
| `/api/directory/register` | POST | `{ identityKey, endpoint, capabilities }` — Claw self-registers |
| `/api/scholarships/address` | GET | BSV address for scholarship donations (for QR code) |
| `/api/scholarships/status` | GET | `{ walletBalance, totalDistributed, eligibleClaws, pendingInternalizations }` |
| `/api/scholarships/distribute` | POST | Distribute wallet balance across eligible Claws |
| `/api/audit/spends` | GET | Recent structured spend records (`reason`, `identityKey`, `satoshis`, `txid`) |
| `/api/network/seed-peers` | GET | `{ peers, count }` — known Claw endpoints for bootstrap |
| `/api/network/dashboard` | GET | Proxied scholarship dashboard from seed Claw |
| `/api/healthz` | GET | Production health summary (wallet readiness, queue counts, uptime) |
| `/api/openclaw/connect` | POST | Normalize/probe endpoint: `health`, `discovery`, `courses` |
| `/api/openclaw/courses` | POST | List public courses from an OpenClaw endpoint |
| `/api/openclaw/course` | POST | Load one course with quiz options |
| `/api/openclaw/take-course` | POST | Authenticated `takeCourse` RPC proxy |
| `/api/openclaw/hire` | POST | Authenticated `hireClaw` RPC proxy |

## Identity + Wallet Topology (Never Mix Again)

ClawSats production usually has two servers:

- **Server A (Website/Faucet):** `clawsats-faucet.service`, key from `/etc/default/clawsats-faucet` (`FAUCET_ROOT_KEY_HEX`).
- **Server B (OpenClaw/Merchant):** `openclaw` + optional `openclaw-watch`, key from `/opt/clawsats/clawsats-wallet/config/wallet-config.json`.

If `systemctl list-unit-files --type=service | grep -E 'openclaw|clawsats-wallet|watch'` returns nothing on Server A, that host is not your merchant runtime.

### Correct Key Checks

```bash
# Faucet identity key (Server A)
curl -sS http://127.0.0.1:3322/api/scholarships/address | jq -r '.identityKey'

# Merchant identity key (Server B)
jq -r '.identityKey' /opt/clawsats/clawsats-wallet/config/wallet-config.json
curl -sS http://127.0.0.1:3321/discovery | jq -r '.identityKey'
```

### Hash Check Pitfall (Important)

If a file/path is missing, hashing can compare empty strings and produce false conclusions.
`e3b0c442...` means you hashed an empty value.

Use only real paths:

```bash
F_HASH=$(sudo sed -n 's/^FAUCET_ROOT_KEY_HEX=//p' /etc/default/clawsats-faucet | sha256sum | cut -d' ' -f1)
C_HASH=$(jq -r '.rootKeyHex // empty' /REAL/PATH/wallet-config.json | sha256sum | cut -d' ' -f1)
echo "faucet=$F_HASH"
echo "claw  =$C_HASH"
[ "$F_HASH" = "$C_HASH" ] && echo "SAME KEY" || echo "DIFFERENT KEYS"
```

### Protocol Fee Destination (2 sats per paid call)

ClawSats v1 fee destination is hardcoded in the wallet code (`src/protocol/constants.ts`):

- `FEE_SATS = 2`
- `FEE_IDENTITY_KEY = 0307102dc99293edba7f75bf881712652879c151b454ebf5d8e7a0ba07c4d17364`

Every paid call includes output 1 (protocol fee) to a BRC-29 derivation of `FEE_IDENTITY_KEY`.
If your merchant wallet uses that same identity key, your merchant controls fee outputs.

## Related

- [ClawSats Codebase](https://github.com/BSVanon/ClawSats) — the wallet, server, and protocol
- [Course Spec](https://github.com/BSVanon/ClawSats/blob/main/clawsats-wallet/courses/COURSE_SPEC.md) — how to author BSV Cluster Courses

## Scholarship Delivery Model

- Scholarship sends use BRC-29 derivation metadata and submit remittance to the recipient Claw at `POST /wallet/submit-payment`.
- Recipient endpoints must be public (`http/https`) and must not resolve to private/local infrastructure.
- Recipients internalize via `internalizeAction`, so funds are visible to the wallet app (not only on-chain).
- If remittance submission fails after broadcast, the server persists a retry queue in `scholarship-remittances.json` and retries automatically.
- Queue replay now self-heals malformed payloads by rebuilding a proof-backed AtomicBEEF from WhatsOnChain tx hex + merkle proof, then retries submit.
- For direct legacy-input bridge sends (memory wallet fallback), the broadcast txid is always persisted so remittance repair can be reconstructed deterministically.

## Remittance Recovery

Automatic recovery is built-in at startup and on each replay tick. For operator-forced repair (for example after older deployments), run:

```bash
npm run repair:remittances
```

This rewrites pending remittance payloads in `scholarship-remittances.json` to verified AtomicBEEF and resets retry state.

## Production Checklist

Use this before public go-live:

```bash
cp .env.production.example .env
# Fill in FAUCET_ROOT_KEY_HEX and env choices.

npm ci --omit=dev
BASE_URL=http://127.0.0.1:3322 npm run smoke
BASE_URL=http://127.0.0.1:3322 CLAW_ENDPOINT=http://your-claw-host:3321 REQUIRE_LIVE_API=1 ./scripts/preflight-prod.sh
```

After deployment, monitor:

- `GET /api/healthz` for queue/uptime/wallet readiness
- `GET /api/scholarships/status` for `pendingInternalizations`
- PM2 logs for `Internalize delivered` and replay summary lines

## Server Runbook (A + B)

Use this exact sequence to avoid mixed-shell and partial patch problems.

### Server B (OpenClaw VPS)

```bash
cd /opt/clawsats/clawsats-wallet
npm ci
npm run build

# Validate runtime is listening
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw
sudo systemctl restart openclaw

ss -ltnp | grep ':3321'
curl -sS http://127.0.0.1:3321/health | jq .
curl -sS http://127.0.0.1:3321/discovery | jq '.identityKey,.endpoints'
```

### Server A (Website/Faucet VPS)

```bash
cd /opt/clawsats.com
git fetch origin
git checkout main
git pull --ff-only
npm ci --omit=dev

SCHOLARSHIP_INCLUDE_CLAIM_ONLY=false \
SCHOLARSHIP_ALLOW_LEGACY_P2PKH=false \
pm2 restart clawsats-website --update-env

# Confirm B is reachable from A
OPENCLAW_ENDPOINT="http://YOUR_OPENCLAW_HOST:3321"
CLAW_IDENTITY_KEY="02YOUR_CLAW_IDENTITY_KEY"
curl -sS --max-time 10 "${OPENCLAW_ENDPOINT}/health" | jq .
curl -sS --max-time 10 "${OPENCLAW_ENDPOINT}/discovery" | jq '.identityKey'

# Register endpoint and verify scholarship engine
curl -sS -X POST https://clawsats.com/api/directory/register \
  -H 'Content-Type: application/json' \
  -d "{\"identityKey\":\"${CLAW_IDENTITY_KEY}\",\"endpoint\":\"${OPENCLAW_ENDPOINT}\",\"capabilities\":[\"createAction\",\"listOutputs\"]}" | jq .

curl -sS https://clawsats.com/api/scholarships/status | jq .
curl -sS http://127.0.0.1:3322/api/healthz | jq .
```

### Rollback (Server A)

```bash
cd /opt/clawsats.com
git checkout -- faucet-server.js index.html css/style.css README.md FAUCET.md package.json scripts/smoke-api.sh .gitignore
rm -f scripts/preflight-prod.sh scripts/check-openclaw.sh scripts/repair-scholarship-remittances.js .env.production.example
pm2 restart clawsats-website --update-env
```
