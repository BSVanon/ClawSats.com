#!/usr/bin/env node
/**
 * ClawSats Bootstrap Faucet + Scholarship Fund + Claw Directory — Mainnet
 *
 * Drips mainnet sats to new Claws via BRC-100 wallet (createAction).
 * Manages the general scholarship fund: humans send BSV to the wallet address
 * (displayed as QR code on the website), server distributes to eligible Claws.
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
 *   GET  /api/faucet/status            — { claimed, limit, remaining, funded }
 *   POST /api/faucet/drip              — { identityKey } → { txid, amount }
 *   GET  /api/directory                — all known Claws (faucet claims + self-registered + seeds)
 *   POST /api/directory/register       — Claw self-registers { identityKey, endpoint, capabilities }
 *   GET  /api/scholarships/address     — BSV address for QR code donations
 *   GET  /api/scholarships/status      — { walletBalance, totalDistributed, eligibleClaws }
 *   POST /api/scholarships/distribute  — distribute wallet balance across eligible Claws
 *   GET  /api/network/seed-peers       — list of known seed Claw endpoints
 *   GET  /api/network/dashboard        — proxied scholarship dashboard from seed Claw
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
const BIND_HOST = process.env.FAUCET_BIND_HOST || '127.0.0.1';
const DB_PATH = process.env.FAUCET_CLAIMS_PATH || path.join(__dirname, 'faucet-claims.json');
const FAUCET_ROOT_KEY_HEX = process.env.FAUCET_ROOT_KEY_HEX || '';
const SEED_CLAW_ENDPOINT = process.env.SEED_CLAW_ENDPOINT || '';
const WALLET_STORAGE_MODE = (process.env.FAUCET_WALLET_STORAGE || 'sqlite').toLowerCase();
const WOC_API_BASE = process.env.WOC_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main';
const MIN_DRIP_SPENDABLE = parseInt(process.env.MIN_DRIP_SPENDABLE || '250', 10);

// --- Wallet (lazy-initialized) ---
let faucetWallet = null;
let walletReady = false;
let walletError = null;
let walletBackend = 'none';
let settlingPendingClaims = false;

function getPkgVersion(name) {
  try {
    const mainPath = require.resolve(name);
    let dir = path.dirname(mainPath);
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && pkg.name === name) return pkg.version || 'unknown';
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function logWalletRuntimeDetails() {
  console.log(`[FAUCET] Runtime: node=${process.version} sdk=${getPkgVersion('@bsv/sdk')} wallet-toolbox=${getPkgVersion('@bsv/wallet-toolbox')}`);
  console.log(`[FAUCET] Config: storage=${WALLET_STORAGE_MODE} claimsPath=${DB_PATH}`);
}

function formatErr(err) {
  if (err && err.stack) return err.stack;
  if (err && err.message) return err.message;
  return String(err);
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}: ${body.slice(0, 220)}`);
  }
  return resp.json();
}

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

    logWalletRuntimeDetails();

    const rootKey = PrivateKey.fromHex(FAUCET_ROOT_KEY_HEX);
    const identityKey = rootKey.toPublicKey().toString();
    const address = pubkeyToAddress(identityKey);

    faucetIdentityKey = identityKey;
    faucetAddress = address;

    console.log(`[FAUCET] Derived identity key: ${identityKey}`);
    console.log(`[FAUCET] Derived address: ${address}`);
    console.log(`[FAUCET] Fund this mainnet address for faucet + scholarships.`);

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

    if (WALLET_STORAGE_MODE === 'sqlite') {
      try {
        console.log('[FAUCET] Wallet init: Setup.createWalletSQLite(env, rootKeyHex, filePath, databaseName)');
        const sw = await Setup.createWalletSQLite({
          env,
          rootKeyHex: FAUCET_ROOT_KEY_HEX,
          filePath: path.join(dataDir, 'faucet.sqlite'),
          databaseName: 'clawsats-faucet'
        });
        faucetWallet = sw.wallet;
        walletBackend = 'sqlite';
      } catch (sqliteErr) {
        const sqliteMsg = sqliteErr && sqliteErr.message ? sqliteErr.message : String(sqliteErr);
        console.error(`[FAUCET] SQLite wallet init failed: ${sqliteMsg}`);
        console.error(formatErr(sqliteErr));

        if (sqliteMsg.includes('Function not implemented')) {
          console.warn('[FAUCET] SQLite init is unavailable in this @bsv/wallet-toolbox build. Falling back to memory wallet mode.');
        } else {
          console.warn('[FAUCET] Falling back to memory wallet mode after SQLite init failure.');
        }

        console.log('[FAUCET] Wallet init fallback: Setup.createWalletClientNoEnv(chain, rootKeyHex)');
        faucetWallet = await Setup.createWalletClientNoEnv({
          chain: 'main',
          rootKeyHex: FAUCET_ROOT_KEY_HEX
        });
        walletBackend = 'memory';
      }
    } else {
      console.log('[FAUCET] Wallet init: Setup.createWalletClientNoEnv(chain, rootKeyHex)');
      faucetWallet = await Setup.createWalletClientNoEnv({
        chain: 'main',
        rootKeyHex: FAUCET_ROOT_KEY_HEX
      });
      walletBackend = 'memory';
    }

    walletReady = true;
    console.log(`[FAUCET] ✅ Wallet initialized (${walletBackend}) for ${identityKey.substring(0, 24)}...`);
    console.log(`[FAUCET]    BSV Address: ${address}`);
    console.log(`[FAUCET]    Fund this address with mainnet BSV to enable drips + scholarships.`);
  } catch (err) {
    walletError = err && err.message ? err.message : String(err);
    walletBackend = 'none';
    console.error(`[FAUCET] ❌ Wallet init failed: ${walletError}`);
    console.error(formatErr(err));
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

/**
 * Derive a legacy BSV address (Base58Check) from a compressed public key.
 * Version byte 0x00 for mainnet.
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buffer) {
  let num = BigInt('0x' + buffer.toString('hex'));
  let encoded = '';
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    encoded = BASE58_ALPHABET[Number(remainder)] + encoded;
  }
  // Preserve leading zeros
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    encoded = '1' + encoded;
  }
  return encoded;
}

function pubkeyToAddress(pubkeyHex) {
  const pubkeyBuf = Buffer.from(pubkeyHex, 'hex');
  const sha = crypto.createHash('sha256').update(pubkeyBuf).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha).digest();
  // Version byte 0x00 (mainnet) + 20-byte hash
  const versioned = Buffer.concat([Buffer.from([0x00]), hash160]);
  // Double SHA-256 checksum
  const checksum = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(versioned).digest()
  ).digest().slice(0, 4);
  return base58Encode(Buffer.concat([versioned, checksum]));
}

// Faucet identity key and address (derived at init time)
let faucetIdentityKey = '';
let faucetAddress = '';

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

function isPendingClaim(claim) {
  if (!claim) return false;
  if (claim.txid) return false;
  return (
    claim.status === 'pending_funding' ||
    claim.status === 'wallet_error' ||
    claim.status === 'pending_broadcast'
  );
}

function getPendingClaimEntries() {
  return Object.entries(db.claims).filter(([_, claim]) => isPendingClaim(claim));
}

async function sendDripToIdentityKey(identityKey, descriptionPrefix = 'ClawSats faucet drip') {
  const lockingScript = p2pkhFromPubkey(identityKey);
  try {
    const result = await faucetWallet.createAction({
      description: `${descriptionPrefix} to ${identityKey.substring(0, 16)}...`,
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
    const txid = result.txid || null;
    const status = txid ? 'sent' : 'pending_broadcast';
    return { txid, status };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (walletBackend === 'memory' && (
      msg.toLowerCase().includes('insufficient funds') ||
      msg.toLowerCase().includes('needed')
    )) {
      console.warn('[FAUCET] createAction could not see spendable inputs in memory mode; trying direct P2PKH fallback path.');
      return sendViaDirectP2PKHFallback(identityKey, DRIP_AMOUNT);
    }
    throw err;
  }
}

async function settlePendingClaims(maxClaims = 50) {
  if (!walletReady || !faucetWallet) return { processed: 0, sent: 0, failed: 0, remaining: 0 };
  if (settlingPendingClaims) return { processed: 0, sent: 0, failed: 0, remaining: getPendingClaimEntries().length };

  settlingPendingClaims = true;
  try {
    const available = await getWalletBalance();
    if (available < MIN_DRIP_SPENDABLE) {
      return { processed: 0, sent: 0, failed: 0, remaining: getPendingClaimEntries().length };
    }

    const pending = getPendingClaimEntries();
    if (pending.length === 0) return { processed: 0, sent: 0, failed: 0, remaining: 0 };

    let processed = 0;
    let sent = 0;
    let failed = 0;

    for (const [identityKey, claim] of pending) {
      if (processed >= maxClaims) break;
      processed++;
      try {
        const { txid, status } = await sendDripToIdentityKey(identityKey, 'ClawSats pending faucet drip');
        claim.txid = txid;
        claim.status = status;
        claim.sentAt = new Date().toISOString();
        claim.lastError = null;
        sent++;
        console.log(`[FAUCET] ✅ Settled pending claim for ${identityKey.substring(0, 24)}... txid=${(txid || 'pending').substring(0, 16)}`);
      } catch (err) {
        failed++;
        claim.status = 'wallet_error';
        claim.lastError = err && err.message ? err.message : String(err);
        console.warn(`[FAUCET] Pending claim send failed for ${identityKey.substring(0, 24)}...: ${claim.lastError}`);
      }
    }

    saveClaims(db);
    return {
      processed,
      sent,
      failed,
      remaining: getPendingClaimEntries().length
    };
  } finally {
    settlingPendingClaims = false;
  }
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
app.get('/api/faucet/status', async (req, res) => {
  const balance = await getWalletBalance();
  const reserveForNextDrip = MIN_DRIP_SPENDABLE;
  const funded = walletReady && balance >= reserveForNextDrip;
  const pendingClaims = getPendingClaimEntries().length;

  res.json({
    claimed: db.count,
    limit: MAX_CLAIMS,
    remaining: MAX_CLAIMS - db.count,
    dripAmount: DRIP_AMOUNT,
    chain: 'main',
    funded,
    walletReady,
    walletBackend,
    walletBalance: balance,
    reserveForNextDrip,
    pendingClaims,
    walletError: walletError || null
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
        const send = await sendDripToIdentityKey(identityKey);
        txid = send.txid;
        status = send.status;
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

// --- Claw Directory ---
const DIRECTORY_PATH = path.join(__dirname, 'claw-directory.json');

function loadDirectory() {
  try {
    if (fs.existsSync(DIRECTORY_PATH)) {
      return JSON.parse(fs.readFileSync(DIRECTORY_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveDirectory(dir) {
  fs.writeFileSync(DIRECTORY_PATH, JSON.stringify(dir, null, 2));
}

let directory = loadDirectory();

// GET /api/directory — list all known Claws
app.get('/api/directory', (req, res) => {
  const seedPeers = loadSeedPeers();
  const entries = [];

  // Add seed peers
  for (const peer of seedPeers) {
    entries.push({
      identityKey: peer.identityKey || null,
      endpoint: peer.endpoint,
      source: 'seed',
      status: 'seed',
      registeredAt: null,
      note: peer.note || null
    });
  }

  // Add faucet claims (these are Claws that got bootstrap sats)
  for (const [key, claim] of Object.entries(db.claims)) {
    const dirEntry = directory[key] || {};
    entries.push({
      identityKey: key,
      endpoint: dirEntry.endpoint || null,
      source: 'faucet',
      status: dirEntry.endpoint ? 'registered' : 'claimed',
      claimedAt: claim.claimedAt,
      registeredAt: dirEntry.registeredAt || null,
      capabilities: dirEntry.capabilities || null
    });
  }

  // Add self-registered Claws that didn't use the faucet
  for (const [key, entry] of Object.entries(directory)) {
    if (!db.claims[key]) {
      entries.push({
        identityKey: key,
        endpoint: entry.endpoint,
        source: 'self-registered',
        status: 'registered',
        registeredAt: entry.registeredAt,
        capabilities: entry.capabilities || null
      });
    }
  }

  res.json({
    total: entries.length,
    registered: entries.filter(e => e.endpoint).length,
    claws: entries
  });
});

// POST /api/directory/register — a Claw registers its endpoint after going live
app.post('/api/directory/register', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests.' });
  }

  const { identityKey, endpoint, capabilities } = req.body || {};

  if (!isValidIdentityKey(identityKey)) {
    return res.status(400).json({ error: 'Invalid identity key.' });
  }

  if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid endpoint URL. Must start with http:// or https://' });
  }

  // Sanitize endpoint
  try { new URL(endpoint); } catch {
    return res.status(400).json({ error: 'Malformed endpoint URL.' });
  }

  directory[identityKey] = {
    endpoint: endpoint.replace(/\/+$/, ''),  // strip trailing slashes
    capabilities: Array.isArray(capabilities) ? capabilities.slice(0, 20) : null,
    registeredAt: new Date().toISOString(),
    ip: ip
  };
  saveDirectory(directory);

  console.log(`[DIRECTORY] Registered: ${identityKey.substring(0, 24)}... → ${endpoint}`);

  res.json({
    success: true,
    message: 'Claw registered in directory.',
    identityKey,
    endpoint: directory[identityKey].endpoint
  });
});

// --- General Scholarship Fund ---
// Humans send BSV to the faucet wallet address. The server tracks the wallet
// balance and distributes sats to Claws in the directory.
// Flow: Human sees QR code → sends BSV → server detects balance → distributes.

const FUND_PATH = path.join(__dirname, 'scholarship-fund.json');

function loadFund() {
  try {
    if (fs.existsSync(FUND_PATH)) {
      return JSON.parse(fs.readFileSync(FUND_PATH, 'utf8'));
    }
  } catch {}
  return {
    totalDistributed: 0,
    distributions: [],
    lastBalanceCheck: 0,
    lastKnownBalance: 0
  };
}

function saveFund(fund) {
  fs.writeFileSync(FUND_PATH, JSON.stringify(fund, null, 2));
}

let fund = loadFund();

/**
 * Check the faucet wallet's actual balance via listOutputs.
 * Returns available satoshis.
 */
async function getWalletBalance() {
  if (!walletReady || !faucetWallet) return 0;

  // In memory mode, toolbox output tracking may not include direct P2PKH external funding.
  // Use chain index balance for the known faucet address to reflect real on-chain funds.
  if (walletBackend === 'memory' && faucetAddress) {
    try {
      const data = await fetchJson(`${WOC_API_BASE}/address/${faucetAddress}/balance`);
      const confirmed = Number(data.confirmed || 0);
      const unconfirmed = Number(data.unconfirmed || 0);
      return Math.max(0, confirmed + unconfirmed);
    } catch (err) {
      console.warn(`[SCHOLARSHIP] WOC balance check failed: ${err.message}`);
      // Fall through to toolbox listOutputs path below
    }
  }

  try {
    const outputs = await faucetWallet.listOutputs({
      basket: 'default',
      include: 'locking scripts',
      limit: 1000
    });
    // Sum all spendable outputs
    let total = 0;
    if (outputs && outputs.outputs) {
      for (const out of outputs.outputs) {
        if (out.spendable !== false) total += (out.satoshis || 0);
      }
    } else if (outputs && Array.isArray(outputs)) {
      for (const out of outputs) {
        if (out.spendable !== false) total += (out.satoshis || 0);
      }
    }
    return total;
  } catch (err) {
    console.warn(`[SCHOLARSHIP] Balance check failed: ${err.message}`);
    return 0;
  }
}

async function sendViaDirectP2PKHFallback(recipientIdentityKey, satoshis) {
  if (!FAUCET_ROOT_KEY_HEX || !faucetAddress) {
    throw new Error('Direct P2PKH fallback unavailable: missing faucet key/address.');
  }

  const { PrivateKey, P2PKH, fromUtxo, Transaction, Script, SatoshisPerKilobyte } = require('@bsv/sdk');
  const { Setup } = require('@bsv/wallet-toolbox');

  const priv = PrivateKey.fromHex(FAUCET_ROOT_KEY_HEX);
  const unlock = new P2PKH().unlock(priv);
  const sourceScriptHex = Setup.getLockP2PKH(faucetAddress).toHex();
  const recipientScriptHex = p2pkhFromPubkey(recipientIdentityKey);

  const rawUtxos = await fetchJson(`${WOC_API_BASE}/address/${faucetAddress}/unspent`);
  const utxos = (Array.isArray(rawUtxos) ? rawUtxos : [])
    .map(u => ({
      txid: u.tx_hash || u.tx_hash_big_endian || u.txid,
      vout: u.tx_pos ?? u.vout ?? u.tx_output_n,
      satoshis: Number(u.value ?? u.satoshis ?? 0)
    }))
    .filter(u => typeof u.txid === 'string' && Number.isInteger(u.vout) && u.satoshis > 0)
    .sort((a, b) => b.satoshis - a.satoshis);

  if (utxos.length === 0) {
    throw new Error('No spendable UTXOs found for faucet address.');
  }

  // Build a candidate tx with selected UTXOs until fee+output are covered.
  const tx = new Transaction();
  let inputTotal = 0;
  let selected = 0;
  const targetFloor = satoshis + MIN_DRIP_SPENDABLE;

  for (const u of utxos) {
    tx.addInput(fromUtxo({
      txid: u.txid,
      vout: u.vout,
      satoshis: u.satoshis,
      script: sourceScriptHex
    }, unlock));
    inputTotal += u.satoshis;
    selected++;
    if (inputTotal >= targetFloor) break;
  }

  if (inputTotal < targetFloor) {
    throw new Error(`Insufficient UTXO total: need at least ${targetFloor}, found ${inputTotal}.`);
  }

  tx.addOutput({
    satoshis,
    lockingScript: Script.fromHex(recipientScriptHex)
  });
  tx.addP2PKHOutput(faucetAddress); // change output

  await tx.fee(new SatoshisPerKilobyte(1000));
  await tx.sign();

  const txhex = tx.toHex();
  const br = await fetchJson(`${WOC_API_BASE}/tx/raw`, {
    method: 'POST',
    body: JSON.stringify({ txhex })
  });

  const txid = br.txid || br || null;
  if (!txid || typeof txid !== 'string') {
    throw new Error(`Broadcast response missing txid: ${JSON.stringify(br).slice(0, 240)}`);
  }

  console.log(`[FAUCET] Direct P2PKH fallback broadcast txid=${txid.substring(0, 16)}... inputs=${selected} totalIn=${inputTotal}`);
  return { txid, status: 'sent' };
}

// GET /api/scholarships/address — the BSV address to send scholarship donations to
app.get('/api/scholarships/address', (req, res) => {
  if (!faucetAddress) {
    return res.status(503).json({
      error: 'Faucet wallet not initialized. Scholarship address unavailable.'
    });
  }
  res.json({
    address: faucetAddress,
    identityKey: faucetIdentityKey,
    chain: 'main',
    message: `Send mainnet BSV to ${faucetAddress}. All funds go to the general scholarship fund for Claw education.`
  });
});

// GET /api/scholarships/status — fund status with real wallet balance
app.get('/api/scholarships/status', async (req, res) => {
  const dirEntries = Object.entries(directory).filter(([_, e]) => e.endpoint);
  const balance = await getWalletBalance();
  fund.lastKnownBalance = balance;
  fund.lastBalanceCheck = Date.now();

  res.json({
    walletBalance: balance,
    totalDistributed: fund.totalDistributed,
    totalDistributions: fund.distributions.length,
    eligibleClaws: dirEntries.length,
    address: faucetAddress || null,
    chain: 'main',
    recentDistributions: fund.distributions.slice(-10).reverse()
  });
});

// POST /api/scholarships/distribute — distribute wallet balance across eligible Claws
// This sends REAL sats from the faucet wallet to Claws.
// The wallet must have balance (from human donations sent to the QR code address).
app.post('/api/scholarships/distribute', async (req, res) => {
  if (!walletReady || !faucetWallet) {
    return res.status(503).json({ error: 'Faucet wallet not ready. Cannot distribute.' });
  }

  // Check real wallet balance
  const balance = await getWalletBalance();
  // Reserve some sats for faucet drips and tx fees
  const reserveForFaucet = (MAX_CLAIMS - db.count) * (DRIP_AMOUNT + 1);
  const availableForScholarships = Math.max(0, balance - reserveForFaucet - 100); // 100 sat buffer

  if (availableForScholarships < 1) {
    return res.json({
      distributed: 0,
      walletBalance: balance,
      reservedForFaucet: reserveForFaucet,
      message: 'Insufficient balance after reserving for faucet drips. Send more BSV to the scholarship address.'
    });
  }

  // Find eligible Claws: those with endpoints in the directory
  const eligible = [];
  for (const [key, entry] of Object.entries(directory)) {
    if (entry.endpoint) {
      eligible.push({ identityKey: key, endpoint: entry.endpoint });
    }
  }
  // Also include faucet claims that have endpoints
  for (const [key, claim] of Object.entries(db.claims)) {
    const dirEntry = directory[key];
    if (dirEntry && dirEntry.endpoint && !eligible.find(e => e.identityKey === key)) {
      eligible.push({ identityKey: key, endpoint: dirEntry.endpoint });
    }
  }

  if (eligible.length === 0) {
    return res.json({
      distributed: 0,
      message: 'No eligible Claws with endpoints. Claws must register in the directory first.',
      walletBalance: balance
    });
  }

  // Split evenly, minimum 1 sat per Claw, cap at available balance
  const perClaw = Math.max(1, Math.floor(availableForScholarships / eligible.length));
  const totalToDistribute = Math.min(perClaw * eligible.length, availableForScholarships);

  // Shuffle eligible list for fairness (Fisher-Yates)
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }

  const results = [];
  let distributed = 0;

  for (const claw of eligible) {
    if (distributed + perClaw > totalToDistribute) break;

    let txid = null;
    let status = 'failed';

    try {
      const lockingScript = p2pkhFromPubkey(claw.identityKey);
      const result = await faucetWallet.createAction({
        description: `ClawSats scholarship: ${perClaw} sats to ${claw.identityKey.substring(0, 16)}...`,
        outputs: [{
          satoshis: perClaw,
          lockingScript,
          outputDescription: 'Scholarship distribution'
        }],
        labels: ['clawsats-scholarship'],
        options: { acceptDelayedBroadcast: false }
      });
      txid = result.txid || null;
      status = txid ? 'sent' : 'broadcast_pending';
    } catch (err) {
      console.warn(`[SCHOLARSHIP] Send failed for ${claw.identityKey.substring(0, 16)}...: ${err.message}`);
      break; // Stop distributing if wallet errors (likely insufficient funds)
    }

    const dist = {
      identityKey: claw.identityKey,
      endpoint: claw.endpoint,
      satoshis: perClaw,
      txid,
      status,
      distributedAt: new Date().toISOString()
    };
    results.push(dist);
    fund.distributions.push(dist);
    distributed += perClaw;
  }

  fund.totalDistributed += distributed;
  saveFund(fund);

  console.log(`[SCHOLARSHIP] Distributed ${distributed} sats across ${results.length} Claws (${perClaw} each)`);

  res.json({
    distributed,
    perClaw,
    clawsReached: results.length,
    results,
    walletBalance: balance - distributed,
    message: `${distributed} sats distributed to ${results.length} Claws (${perClaw} sats each).`
  });
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
  if (walletReady) {
    const replay = await settlePendingClaims(100);
    if (replay.processed > 0) {
      console.log(`[FAUCET] Pending claims replay: processed=${replay.processed} sent=${replay.sent} failed=${replay.failed} remaining=${replay.remaining}`);
    }
    setInterval(async () => {
      const tick = await settlePendingClaims(25);
      if (tick.processed > 0) {
        console.log(`[FAUCET] Pending claims replay tick: processed=${tick.processed} sent=${tick.sent} failed=${tick.failed} remaining=${tick.remaining}`);
      }
    }, 60_000).unref();
  }

  app.listen(PORT, BIND_HOST, () => {
    console.log(`\n🦞 ClawSats Faucet + Website (mainnet)`);
    console.log(`   http://${BIND_HOST}:${PORT}`);
    console.log(`   Faucet: ${db.count}/${MAX_CLAIMS} claimed, ${DRIP_AMOUNT} sats/drip`);
    console.log(`   Wallet: ${walletReady ? `✅ ready (${walletBackend})` : '⚠️  not ready (claims recorded, sats pending)'}`);
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
