#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "Run with bash: bash install-openclaw.sh"
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required."
  exit 1
fi

RUN_AS_USER="${SUDO_USER:-$USER}"
if [[ "${RUN_AS_USER}" == "root" ]]; then
  echo "Run as a normal user with sudo access, not as root."
  exit 1
fi

INSTALL_DIR="/opt/clawsats"
WALLET_DIR="${INSTALL_DIR}/clawsats-wallet"
SERVICE_FILE="/etc/systemd/system/openclaw.service"
WATCH_SERVICE_FILE="/etc/systemd/system/openclaw-watch.service"
WATCH_ENV_FILE="/etc/default/openclaw-watch"
WATCH_INTERVAL="${OPENCLAW_WATCH_INTERVAL:-60}"
DIRECTORY_URL="${CLAWSATS_DIRECTORY_URL:-https://clawsats.com/api/directory}"

echo
echo "ClawSats Guided Install"
echo "This sets up a live OpenClaw on port 3321."
echo "It will create or reuse a dedicated claw wallet key."
echo

read -rp "Public endpoint (example: http://YOUR_HOST:3321): " PUBLIC_ENDPOINT
if [[ -z "${PUBLIC_ENDPOINT}" ]]; then
  echo "Public endpoint is required."
  exit 1
fi

if ! [[ "${PUBLIC_ENDPOINT}" =~ ^https?:// ]]; then
  echo "Endpoint must start with http:// or https://"
  exit 1
fi

DEFAULT_API_KEY="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9_-')"
read -rp "API key for admin JSON-RPC [default auto-generated]: " OPENCLAW_API_KEY
OPENCLAW_API_KEY="${OPENCLAW_API_KEY:-$DEFAULT_API_KEY}"

echo
echo "Installing base packages..."
sudo apt update
sudo apt install -y git curl ca-certificates ufw jq

echo
echo "Ensuring Node.js 20..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'parseInt(process.versions.node.split(".")[0],10)')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

echo
echo "Syncing ClawSats repository..."
sudo mkdir -p "${INSTALL_DIR}"
sudo chown -R "${RUN_AS_USER}:${RUN_AS_USER}" "${INSTALL_DIR}"
if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  git clone https://github.com/BSVanon/ClawSats.git "${INSTALL_DIR}"
else
  git -C "${INSTALL_DIR}" fetch origin
  git -C "${INSTALL_DIR}" checkout main
  git -C "${INSTALL_DIR}" pull --ff-only
fi

cd "${WALLET_DIR}"
npm ci
npm run build

mkdir -p config data

ROOT_KEY_HEX=""
if [[ -f config/wallet-config.json ]]; then
  echo
  echo "Found existing wallet config at ${WALLET_DIR}/config/wallet-config.json"
  read -rp "Reuse existing claw identity? [Y/n]: " REUSE_EXISTING
  REUSE_EXISTING="${REUSE_EXISTING:-Y}"
  if [[ "${REUSE_EXISTING}" =~ ^[Yy]$ ]]; then
    ROOT_KEY_HEX="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("config/wallet-config.json","utf8"));process.stdout.write((p.rootKeyHex||"").trim());')"
  fi
fi

if [[ -z "${ROOT_KEY_HEX}" ]]; then
  echo
  echo "Use a fresh claw key. Do NOT reuse a human wallet key."
  read -rp "Paste existing 64-char root key? [y/N]: " USE_EXISTING_KEY
  USE_EXISTING_KEY="${USE_EXISTING_KEY:-N}"
  if [[ "${USE_EXISTING_KEY}" =~ ^[Yy]$ ]]; then
    read -rsp "ROOT KEY HEX (64 chars): " ROOT_KEY_HEX
    echo
  else
    ROOT_KEY_HEX="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    echo "Generated new claw root key."
  fi
fi

if ! [[ "${ROOT_KEY_HEX}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "Invalid root key hex."
  exit 1
fi

echo
echo "Creating wallet config..."
ROOT_KEY_HEX="${ROOT_KEY_HEX}" node - <<'NODE'
const { WalletManager } = require('./dist/core/WalletManager');

(async () => {
  const rk = (process.env.ROOT_KEY_HEX || '').trim();
  const wm = new WalletManager();
  await wm.createWallet({
    name: 'openclaw',
    chain: 'main',
    rootKeyHex: rk,
    storageType: 'sqlite',
    storagePath: 'data/openclaw.sqlite'
  });
  const cfg = wm.getConfig();
  await wm.destroy();
  console.log(`Identity key: ${cfg.identityKey}`);
})().catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
});
NODE

sudo tee "${SERVICE_FILE}" >/dev/null <<EOF
[Unit]
Description=OpenClaw Wallet
After=network.target

[Service]
Type=simple
User=${RUN_AS_USER}
WorkingDirectory=${WALLET_DIR}
ExecStart=/usr/bin/node ${WALLET_DIR}/dist/cli/index.js serve --config config/wallet-config.json --host 0.0.0.0 --port 3321 --endpoint ${PUBLIC_ENDPOINT} --api-key ${OPENCLAW_API_KEY}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo tee "${WATCH_ENV_FILE}" >/dev/null <<EOF
# OpenClaw peer discovery daemon settings.
OPENCLAW_WATCH_INTERVAL=${WATCH_INTERVAL}
CLAWSATS_DIRECTORY_URL=${DIRECTORY_URL}
EOF

sudo tee "${WATCH_SERVICE_FILE}" >/dev/null <<EOF
[Unit]
Description=OpenClaw Peer Discovery Daemon
After=network-online.target openclaw.service
Wants=network-online.target openclaw.service
PartOf=openclaw.service

[Service]
Type=simple
User=${RUN_AS_USER}
WorkingDirectory=${WALLET_DIR}
Environment=NODE_ENV=production
EnvironmentFile=-${WATCH_ENV_FILE}
ExecStart=/usr/bin/node ${WALLET_DIR}/dist/cli/index.js watch --config config/wallet-config.json --interval \${OPENCLAW_WATCH_INTERVAL} --directory-url \${CLAWSATS_DIRECTORY_URL}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

echo
echo "Opening firewall..."
sudo ufw allow 22/tcp >/dev/null 2>&1 || true
sudo ufw allow 3321/tcp >/dev/null 2>&1 || true
sudo ufw --force enable >/dev/null 2>&1 || true

echo
echo "Starting services..."
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw
sudo systemctl enable --now openclaw-watch
sudo systemctl restart openclaw
sudo systemctl restart openclaw-watch
sleep 3

echo
echo "openclaw status:"
sudo systemctl status openclaw --no-pager -l | sed -n '1,20p'

echo
echo "openclaw-watch status:"
sudo systemctl status openclaw-watch --no-pager -l | sed -n '1,20p'

echo
echo "Health check:"
curl -sS http://127.0.0.1:3321/health || true
echo

echo "Discovery check:"
curl -sS http://127.0.0.1:3321/discovery || true
echo

echo
echo "Done."
echo "API key (save this): ${OPENCLAW_API_KEY}"
echo "Public endpoint: ${PUBLIC_ENDPOINT}"
echo "Autopilot discovery: enabled (openclaw-watch)"
echo
echo "Course endpoints:"
echo "  Public list: curl -sS ${PUBLIC_ENDPOINT}/courses"
echo "  Admin RPC:"
echo "    curl -sS -X POST ${PUBLIC_ENDPOINT}/ \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -H 'Authorization: Bearer ${OPENCLAW_API_KEY}' \\"
echo "      -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"listCourses\",\"params\":{}}'"
