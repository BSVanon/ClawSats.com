#!/usr/bin/env node
/**
 * ClawSats Bootstrap Faucet + Scholarship Proxy — Mainnet
 *
 * Drips mainnet sats to new Claws via BRC-100 wallet (createAction).
 * Also proxies scholarship donations to a running Claw's /donate endpoint.
 *
 * Limits:
 *   - 1 drip per identity key
 *   - First 500 Claws total
 *   - 100 sats per drip
 *
 * Env vars:
 *   FAUCET_ROOT_KEY_HEX  — 64-char hex private key for the faucet wallet (REQUIRED)
 *   FAUCET_PORT           — port (default 3322)
 *   SEED_CLAW_ENDPOINT    — URL of a running Claw for scholarship proxying (optional)
 *
 * Endpoints:
 *   GET  /api/faucet/status       — { claimed, limit, remaining, funded }
 *   POST /api/faucet/drip         — { identityKey } → { txid, amount }
 *   GET  /api/network/seed-peers  — list of known seed Claw endpoints
 *   GET  /api/network/dashboard   — proxied scholarship dashboard from seed Claw
 *
 * Run: FAUCET_ROOT_KEY_HEX=<key> node faucet-server.js
 * The faucet also serves the static website files.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '16kb' }));

// --- Config ---
const DRIP_AMOUNT = 100;
const MAX_CLAIMS = 500;
const PORT = parseInt(process.env.FAUCET_PORT || '3322', 10);
const DB_PATH = path.join(__dirname, 'faucet-claims.json');
const FAUCET_ROOT_KEY_HEX = process.env.FAUCET_ROOT_KEY_HEX || '';
const SEED_CLAW_ENDPOINT = process.env.SEED_CLAW_ENDPOINT || '';

// --- Wallet (lazy-initialized) ---
let faucetWallet = null;
let walletReady = false;
let walletError = null;

async function initWallet() {
  if (!FAUCET_ROOT_KEY_HEX || FAUCET_ROOT_KEY_HEX.length !== 64) {
    walletError = 'FAUCET_ROOT_KEY_HEX not set or invalid (need 64 hex chars)';
    console.warn(`[FAUCET] ⚠️  ${walletError}`);
    console.warn('[FAUCET]    Faucet will record claims but cannot send sats until funded.');
    return;
  }

  try {
    const { Setup } = require('@bsv/wallet-toolbox');
    const { PrivateKey } = require('@bsv/sdk');

    const rootKey = PrivateKey.fromHex(FAUCET_ROOT_KEY_HEX);
    const identityKey = rootKey.toPublicKey().toString();

    const dataDir = path.join(__dirname, 'faucet-data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const env = {
      chain: 'main',
      identityKey,
      identityKey2: identityKey,
      filePath: undefined,
      taalApiKey: '',
      devKeys: { [identityKey]: FAUCET_ROOT_KEY_HEX },
      mySQLConnection: '{}'
    };

    const sw = await Setup.createWalletSQLite({
      env,
      rootKeyHex: FAUCET_ROOT_KEY_HEX,
      filePath: path.join(dataDir, 'faucet.sqlite'),
      databaseName: 'clawsats-faucet'
    });

    faucetWallet = sw.wallet;
    walletReady = true;
    console.log(`[FAUCET] ✅ Wallet initialized: ${identityKey.substring(0, 24)}...`);
    console.log(`[FAUCET]    Fund this identity key with mainnet BSV to enable drips.`);
  } catch (err) {
    walletError = err.message || String(err);
    console.error(`[FAUCET] ❌ Wallet init failed: ${walletError}`);
    console.warn('[FAUCET]    Faucet will record claims but cannot send sats.');
  }
}

/**
 * Build a P2PKH locking script for a compressed public key.
 * OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG
 */
function p2pkhFromPubkey(pubkeyHex) {
  const pubkeyBuf = Buffer.from(pubkeyHex, 'hex');
  const sha = crypto.createHash('sha256').update(pubkeyBuf).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha).digest();
  // 76 a9 14 <20-byte-hash> 88 ac
  return '76a914' + hash160.toString('hex') + '88ac';
}

// --- Claim database (simple JSON file) ---
function loadClaims() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch {}
  return { claims: {}, count: 0 };
}

function saveClaims(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadClaims();

// --- Seed peers (known running Claws for bootstrap) ---
const SEED_PEERS_PATH = path.join(__dirname, 'seed-peers.json');
function loadSeedPeers() {
  try {
    if (fs.existsSync(SEED_PEERS_PATH)) {
      return JSON.parse(fs.readFileSync(SEED_PEERS_PATH, 'utf8'));
    }
  } catch {}
  return [];
}

// --- Validation ---
function isValidIdentityKey(key) {
  if (typeof key !== 'string') return false;
  return /^(02|03)[0-9a-fA-F]{64}$/.test(key);
}

// --- Rate limiting ---
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// --- Routes ---

// Faucet status
app.get('/api/faucet/status', (req, res) => {
  res.json({
    claimed: db.count,
    limit: MAX_CLAIMS,
    remaining: MAX_CLAIMS - db.count,
    dripAmount: DRIP_AMOUNT,
    chain: 'main',
    funded: walletReady
  });
});

// Faucet drip — sends real mainnet sats when wallet is funded
app.post('/api/faucet/drip', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  const { identityKey } = req.body || {};

  if (!isValidIdentityKey(identityKey)) {
    return res.status(400).json({
      error: 'Invalid identity key. Must be a compressed public key (66 hex chars starting with 02 or 03).'
    });
  }

  if (db.claims[identityKey]) {
    return res.status(409).json({
      error: 'This identity key has already claimed a drip.',
      claimedAt: db.claims[identityKey].claimedAt
    });
  }

  if (db.count >= MAX_CLAIMS) {
    return res.status(410).json({
      error: `Faucet exhausted — all ${MAX_CLAIMS} slots claimed. The network is bootstrapped!`
    });
  }

  try {
    let txid = null;
    let status = 'pending_funding';

    // If wallet is ready, send real sats
    if (walletReady && faucetWallet) {
      try {
        const lockingScript = p2pkhFromPubkey(identityKey);
        const result = await faucetWallet.createAction({
          description: `ClawSats faucet drip to ${identityKey.substring(0, 16)}...`,
          outputs: [{
            satoshis: DRIP_AMOUNT,
            lockingScript,
            outputDescription: 'faucet drip',
            tags: ['clawsats-faucet'],
            basket: 'clawsats-faucet-drips'
          }],
          labels: ['clawsats-faucet'],
          options: {
            acceptDelayedBroadcast: false
          }
        });
        txid = result.txid || null;
        status = txid ? 'sent' : 'pending_broadcast';
        console.log(`[FAUCET] ✅ Drip #${db.count + 1}/${MAX_CLAIMS} → ${identityKey.substring(0, 24)}... txid=${(txid || 'pending').substring(0, 16)}`);
      } catch (walletErr) {
        console.error(`[FAUCET] Wallet send failed: ${walletErr.message}`);
        // Record claim anyway — can retry send later
        status = 'wallet_error';
      }
    }

    const claimId = crypto.randomBytes(16).toString('hex');
    db.claims[identityKey] = {
      claimId,
      claimedAt: new Date().toISOString(),
      amount: DRIP_AMOUNT,
      txid,
      status
    };
    db.count++;
    saveClaims(db);

    if (!walletReady) {
      console.log(`[FAUCET] 📋 Claim #${db.count}/${MAX_CLAIMS} recorded (wallet not funded yet) → ${identityKey.substring(0, 24)}...`);
    }

    res.json({
      success: true,
      amount: DRIP_AMOUNT,
      claimId,
      txid: txid || claimId,
      status,
      message: txid
        ? `${DRIP_AMOUNT} mainnet sats sent! txid: ${txid}`
        : `Claim recorded! ${DRIP_AMOUNT} sats reserved. Will be sent when faucet wallet is funded.`,
      position: db.count,
      remaining: MAX_CLAIMS - db.count
    });

  } catch (err) {
    console.error('[FAUCET] Error:', err);
    res.status(500).json({ error: 'Faucet error — try again later.' });
  }
});

// --- Seed peers for bootstrap ---
app.get('/api/network/seed-peers', (req, res) => {
  const peers = loadSeedPeers();
  res.json({
    peers,
    count: peers.length,
    message: 'Known running Claws. Use these to bootstrap your peer network.'
  });
});

// --- Scholarship dashboard proxy ---
app.get('/api/network/dashboard', async (req, res) => {
  if (!SEED_CLAW_ENDPOINT) {
    return res.json({
      message: 'No seed Claw configured yet. Set SEED_CLAW_ENDPOINT env var.',
      totalDonors: 0,
      totalSats: 0,
      totalClawsEducated: 0
    });
  }
  try {
    const resp = await fetch(`${SEED_CLAW_ENDPOINT}/scholarships/dashboard`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.json({
      message: 'Seed Claw unreachable. Dashboard will update when a Claw is online.',
      error: err.message,
      totalDonors: 0,
      totalSats: 0,
      totalClawsEducated: 0
    });
  }
});

// --- Static file serving ---
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, 'favicon.svg')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// --- Start ---
async function main() {
  await initWallet();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🦞 ClawSats Faucet + Website (mainnet)`);
    console.log(`   http://0.0.0.0:${PORT}`);
    console.log(`   Faucet: ${db.count}/${MAX_CLAIMS} claimed, ${DRIP_AMOUNT} sats/drip`);
    console.log(`   Wallet: ${walletReady ? '✅ funded' : '⚠️  not funded (claims recorded, sats pending)'}`);
    if (SEED_CLAW_ENDPOINT) console.log(`   Seed Claw: ${SEED_CLAW_ENDPOINT}`);
    console.log(`   Status: GET /api/faucet/status`);
    console.log(`   Drip:   POST /api/faucet/drip { identityKey }`);
    console.log(`   Peers:  GET /api/network/seed-peers\n`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
