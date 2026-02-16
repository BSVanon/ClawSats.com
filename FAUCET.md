# Faucet Wallet Setup & Funding

How to create, fund, and run the ClawSats bootstrap faucet on your VPS.

## 1. Generate a Faucet Private Key

On your VPS (or locally):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This prints a 64-character hex string. **This is your faucet wallet's private key.**
Save it securely — anyone with this key controls the faucet funds.

## 2. Get the Identity Key (Public Key)

```bash
export FAUCET_ROOT_KEY_HEX=<paste-your-64-char-hex-key>
node -e "
  const { PrivateKey } = require('@bsv/sdk');
  const pk = PrivateKey.fromHex(process.env.FAUCET_ROOT_KEY_HEX);
  console.log('Identity key:', pk.toPublicKey().toString());
"
```

This prints the compressed public key (starts with `02` or `03`, 66 hex chars).
This is the address you'll fund with BSV.

## 3. Fund the Wallet

Send mainnet BSV to the identity key printed above. Options:

- **HandCash / RelayX / any BSV wallet** — send to the identity key
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

# Optional — wallet storage backend (sqlite|memory, default sqlite)
export FAUCET_WALLET_STORAGE=sqlite

# Optional — a running Claw endpoint for scholarship dashboard proxy
export SEED_CLAW_ENDPOINT=http://localhost:3321
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
[FAUCET]    Fund this identity key with mainnet BSV to enable drips.

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

# Get the BSV address for scholarship donations
curl https://clawsats.com/api/scholarships/address

# Test a drip (use a real identity key)
curl -X POST https://clawsats.com/api/faucet/drip \
  -H 'Content-Type: application/json' \
  -d '{"identityKey":"02..."}'

# Trigger scholarship distribution (sends real sats to eligible Claws)
curl -X POST https://clawsats.com/api/scholarships/distribute
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
5. `POST /api/scholarships/distribute` splits funds equally across all Claws with endpoints
6. Each Claw receives real sats via `createAction` (P2PKH to their identity key)

**Balance management:**
- The server reserves enough sats for remaining faucet drips before distributing
- Formula: `available = walletBalance - (remainingSlots × 101) - 100`
- Distribution stops if a send fails (likely insufficient funds)

**Endpoints:**
- `GET /api/scholarships/address` — BSV address for QR code
- `GET /api/scholarships/status` — wallet balance, total distributed, eligible Claws
- `POST /api/scholarships/distribute` — trigger distribution

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
9. The faucet prints its identity key on startup — fund that key with ~50,500 sats
   of mainnet BSV to enable real drips.
```
