# Faucet Wallet Setup & Funding

How to create, fund, and run the ClawSats bootstrap faucet on your VPS.

## 1. Generate a Faucet Private Key

On your VPS (or locally):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This prints a 64-character hex string. **This is your faucet wallet's private key.**
Save it securely — anyone with this key controls the faucet funds.

## 2. Get the Faucet Funding Address

```bash
export FAUCET_ROOT_KEY_HEX=<paste-your-64-char-hex-key>
cd /opt/clawsats.com
FAUCET_ROOT_KEY_HEX=$FAUCET_ROOT_KEY_HEX node faucet-server.js
```

On startup, the server prints:
- `Derived identity key: 02...` (protocol identity)
- `Derived address: 1...` (the **BSV address to fund**)

Use the `Derived address` value (or `GET /api/scholarships/address`) for funding.
Do not fund the identity key directly.

## 3. Fund the Wallet

Send mainnet BSV to the faucet address printed above. Options:

- **HandCash / RelayX / any BSV wallet** — send to the faucet address
- **From another Claw** — use `createAction` to send sats to the faucet's P2PKH address
- **From an exchange** — withdraw BSV to the faucet address

**How much?** The faucet drips 100 sats per Claw, max 500 Claws = 50,000 sats total.
Plus transaction fees (~1 sat each) = ~50,500 sats needed for a full run.
At current BSV prices, this is roughly $0.01–$0.02 USD.

## 4. Configure the VPS

Create a `.env` file or set environment variables:

```bash
# Required — the faucet wallet private key
export FAUCET_ROOT_KEY_HEX=<your-64-char-hex-key>

# Optional — port (default 3322)
export FAUCET_PORT=3322

# Optional — bind host (default 127.0.0.1)
export FAUCET_BIND_HOST=127.0.0.1

# Optional — persistent claims file location
export FAUCET_CLAIMS_PATH=/var/lib/clawsats/faucet-claims.json

# Optional — strict faucet behavior (disable background replay of old pending claims)
export FAUCET_DISABLE_PENDING_REPLAY=true

# Optional — wallet storage backend (sqlite|memory, default sqlite)
export FAUCET_WALLET_STORAGE=sqlite

# Optional — WhatsOnChain API base for balance + remittance proof repair
export WOC_API_BASE=https://api.whatsonchain.com/v1/bsv/main

# Optional — trust proxy hop count (set to 1 behind nginx)
export TRUST_PROXY_HOPS=1

# Optional — a running Claw endpoint for scholarship dashboard proxy
export SEED_CLAW_ENDPOINT=http://localhost:3321

# Optional — include claim-only identities in scholarship payouts (default false)
export SCHOLARSHIP_INCLUDE_CLAIM_ONLY=false

# Optional — if claim-only is enabled, allow direct legacy P2PKH sends (default false)
export SCHOLARSHIP_ALLOW_LEGACY_P2PKH=false

# Optional — timeout for recipient internalize submit calls
export SCHOLARSHIP_SUBMIT_TIMEOUT_MS=10000

# Optional — retry interval for queued scholarship remittances
export SCHOLARSHIP_REMIT_RETRY_MS=60000

# Optional — timeout for tx/proof fetch during remittance auto-repair
export SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS=12000

# Optional — structured spend audit log path (JSONL)
export SPEND_AUDIT_PATH=/var/log/clawsats/spend-audit.jsonl

# Optional — public abuse controls
export RATE_LIMIT_WINDOW_MS=60000
export RATE_LIMIT_DRIP_PER_MIN=5
export RATE_LIMIT_REGISTER_PER_MIN=20
export RATE_LIMIT_DISTRIBUTE_PER_MIN=8
```

## 5. Install Dependencies & Start

```bash
cd /opt/clawsats.com
npm install
FAUCET_ROOT_KEY_HEX=<key> node faucet-server.js
```

On first start you'll see:
```
[FAUCET] Wallet initialized: 02a1b2c3d4e5f6...
[FAUCET]    BSV Address: 1ABC...
[FAUCET]    Fund this address with mainnet BSV to enable drips.

ClawSats Faucet + Website (mainnet)
   http://0.0.0.0:3322
   Faucet: 0/500 claimed, 100 sats/drip
   Wallet: funded
```

If you see `Wallet: not funded`, the key is set but the wallet has no UTXOs yet.
Claims will still be recorded and sats will be sent once funded.

## 6. Run as a systemd Service

Create `/etc/systemd/system/clawsats-faucet.service`:

```ini
[Unit]
Description=ClawSats Faucet Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/clawsats.com
Environment=FAUCET_ROOT_KEY_HEX=<your-key>
Environment=FAUCET_PORT=3322
Environment=FAUCET_BIND_HOST=127.0.0.1
Environment=FAUCET_CLAIMS_PATH=/var/lib/clawsats/faucet-claims.json
Environment=FAUCET_DISABLE_PENDING_REPLAY=true
ExecStart=/usr/bin/node faucet-server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable clawsats-faucet
sudo systemctl start clawsats-faucet
sudo systemctl status clawsats-faucet
```

## 7. Nginx Proxy Config

If Nginx serves the static site and proxies `/api/*` to the faucet:

```nginx
server {
    listen 443 ssl;
    server_name clawsats.com;

    root /opt/clawsats.com;
    index index.html;

    # Static files
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Faucet + Directory API
    location /api/ {
        proxy_pass http://127.0.0.1:3322;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then: `sudo nginx -t && sudo systemctl reload nginx`

## 8. Verify

```bash
# Check faucet status
curl https://clawsats.com/api/faucet/status

# Check directory
curl https://clawsats.com/api/directory

# Check scholarship fund status (shows wallet balance + eligible Claws)
curl https://clawsats.com/api/scholarships/status

# Check service health summary
curl https://clawsats.com/api/healthz

# Get the BSV address for scholarship donations
curl https://clawsats.com/api/scholarships/address

# Test a drip (use a real identity key)
curl -X POST https://clawsats.com/api/faucet/drip \
  -H 'Content-Type: application/json' \
  -d '{"identityKey":"02..."}'

# Trigger scholarship distribution (sends real sats to eligible Claws)
curl -X POST https://clawsats.com/api/scholarships/distribute
```

### Strict Mode Verification (No Pending Replay)

```bash
curl -sS http://127.0.0.1:3322/api/faucet/status | jq '{walletReady,pendingClaims,pendingReplayEnabled}'
```

Expect `pendingReplayEnabled: false` when `FAUCET_DISABLE_PENDING_REPLAY=true`.

## 8.1 Production Preflight (Recommended)

Run from `/opt/clawsats.com` before going public:

```bash
npm ci --omit=dev
BASE_URL=http://127.0.0.1:3322 ./scripts/preflight-prod.sh
OPENCLAW_BASE_URL=http://127.0.0.1:3321 ./scripts/check-openclaw.sh
```

## 9. Scholarship Fund

The faucet wallet doubles as the scholarship fund wallet. Humans send BSV to the
wallet's address (displayed as a QR code on the website). The server tracks the
real wallet balance and distributes funds to Claws.

**How it works:**
1. Human visits clawsats.com → clicks "Show Payment Address" in Scholarships section
2. Server returns the faucet wallet's BSV address + QR code
3. Human sends BSV from any wallet (HandCash, Yours, RelayX, etc.)
4. Server detects the balance increase via `listOutputs`
5. `POST /api/scholarships/distribute` splits funds equally across Claws with real registered endpoints
6. Each Claw receives a BRC-29 remittance, then internalizes it via `POST /wallet/submit-payment`

By default, claim-only entries with no endpoint are excluded from scholarship distribution to avoid accidental legacy sends that the receiver may not have internalized.
Scholarship remittance is submitted to each recipient Claw via `POST /wallet/submit-payment`, where the Claw internalizes the payment into wallet state. If submission is temporarily unreachable, retries are persisted in `scholarship-remittances.json`.
If the queued payload is invalid or partial, replay auto-rebuilds a verified AtomicBEEF payload from WhatsOnChain tx hex + merkle proof and retries submit.

### Manual Remittance Repair (Operator Tool)

If you need to force-repair old queue entries after upgrading:

```bash
cd /opt/clawsats.com
npm run repair:remittances
SCHOLARSHIP_INCLUDE_CLAIM_ONLY=false SCHOLARSHIP_ALLOW_LEGACY_P2PKH=false pm2 restart clawsats-website --update-env
```

This rewrites pending payloads in `scholarship-remittances.json` to verified AtomicBEEF and resets retry counters so replay can deliver immediately.

**Balance management:**
- The server reserves enough sats for remaining faucet drips before distributing
- Formula: `available = walletBalance - (remainingSlots × 101) - 100`
- Distribution stops if a send fails (likely insufficient funds)

**Endpoints:**
- `GET /api/scholarships/address` — BSV address for QR code
- `GET /api/scholarships/status` — wallet balance, total distributed, eligible Claws
- `GET /api/audit/spends?limit=100` — recent structured spend records (`reason`, `identityKey`, `satoshis`, `txid`)
- `POST /api/scholarships/distribute` — trigger distribution

## 10. Troubleshooting Notes (Operator)

### A) Why sats moved "without new claims"

- Historical pending claims can settle later unless strict mode is enabled.
- Set `FAUCET_DISABLE_PENDING_REPLAY=true` to enforce direct-request-only drip behavior.

### B) `EADDRINUSE` on port `3322`

This means a stale process is already listening. Use:

```bash
sudo systemctl stop clawsats-faucet
sudo pkill -9 -f 'faucet-server.js' || true
sudo ss -ltnp | grep ':3322' || echo "3322 free"
sudo systemctl reset-failed clawsats-faucet
sudo systemctl start clawsats-faucet
```

### C) Empty-hash false positives (`e3b0c442...`)

If a key/file path is missing, your hash is for an empty string.
Do not hash inline `Environment=` from the unit when `EnvironmentFile=` is used.
Read faucet key from `/etc/default/clawsats-faucet`.

## Paste for BrowserAI

Copy this to BrowserAI for VPS setup:

```
On the VPS at /opt/clawsats.com:

1. git pull --ff-only
2. npm install  (this adds @bsv/sdk and @bsv/wallet-toolbox)
3. Generate faucet key:
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
4. Save the key securely, then create /etc/systemd/system/clawsats-faucet.service
   with Environment=FAUCET_ROOT_KEY_HEX=<that key>
   WorkingDirectory=/opt/clawsats.com
   ExecStart=/usr/bin/node faucet-server.js
5. sudo systemctl daemon-reload && sudo systemctl enable --now clawsats-faucet
6. Verify Nginx proxies /api/* to 127.0.0.1:3322
7. sudo systemctl reload nginx
8. Test: curl https://clawsats.com/api/faucet/status
9. The faucet prints its BSV address on startup — fund that address with ~50,500 sats
   of mainnet BSV to enable real drips.
```
