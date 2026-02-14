#!/usr/bin/env node
/**
 * ClawSats Bootstrap Faucet — Mainnet
 * 
 * Drips mainnet sats to new Claws. Limited to:
 *   - 1 drip per identity key (wallet ID)
 *   - First 500 Claws total
 *   - 100 sats per drip
 * 
 * Run: node faucet-server.js
 * Requires: FAUCET_ROOT_KEY_HEX env var (the faucet wallet's root key)
 * 
 * Endpoints:
 *   GET  /api/faucet/status  — { claimed, limit, remaining }
 *   POST /api/faucet/drip    — { identityKey } → { txid, amount }
 * 
 * The faucet also serves the static website files.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '16kb' }));

// --- Config ---
const DRIP_AMOUNT = 100;          // sats per drip
const MAX_CLAIMS = 500;           // total faucet slots
const PORT = parseInt(process.env.FAUCET_PORT || '3322', 10);
const DB_PATH = path.join(__dirname, 'faucet-claims.json');

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

// --- Validation ---
function isValidIdentityKey(key) {
  if (typeof key !== 'string') return false;
  // Compressed pubkey: 02 or 03 + 64 hex chars = 66 total
  return /^(02|03)[0-9a-fA-F]{64}$/.test(key);
}

// --- Rate limiting (simple in-memory) ---
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 5;        // max 5 attempts per minute per IP

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

// Status endpoint
app.get('/api/faucet/status', (req, res) => {
  res.json({
    claimed: db.count,
    limit: MAX_CLAIMS,
    remaining: MAX_CLAIMS - db.count,
    dripAmount: DRIP_AMOUNT,
    chain: 'main'
  });
});

// Drip endpoint
app.post('/api/faucet/drip', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  const { identityKey } = req.body || {};

  // Validate
  if (!isValidIdentityKey(identityKey)) {
    return res.status(400).json({
      error: 'Invalid identity key. Must be a compressed public key (66 hex chars starting with 02 or 03).'
    });
  }

  // Check if already claimed
  if (db.claims[identityKey]) {
    return res.status(409).json({
      error: 'This identity key has already claimed a drip.',
      claimedAt: db.claims[identityKey].claimedAt
    });
  }

  // Check if faucet exhausted
  if (db.count >= MAX_CLAIMS) {
    return res.status(410).json({
      error: `Faucet exhausted — all ${MAX_CLAIMS} slots claimed. The network is bootstrapped!`
    });
  }

  // --- Send mainnet sats ---
  // TODO: When faucet wallet is funded, replace this block with real wallet.createAction()
  // using @bsv/wallet-toolbox. The faucet wallet root key comes from FAUCET_ROOT_KEY_HEX env.
  //
  // const { WalletClient } = require('@bsv/wallet-toolbox');
  // const wallet = new WalletClient(process.env.FAUCET_ROOT_KEY_HEX);
  // const result = await wallet.createAction({
  //   description: `ClawSats faucet drip to ${identityKey.substring(0, 16)}...`,
  //   outputs: [{
  //     satoshis: DRIP_AMOUNT,
  //     lockingScript: deriveP2PKHScript(identityKey),
  //     outputDescription: 'faucet drip'
  //   }],
  //   labels: ['clawsats-faucet'],
  //   options: { signAndProcess: true, acceptDelayedBroadcast: true }
  // });
  
  try {
    const claimId = crypto.randomBytes(16).toString('hex');
    
    // Record claim
    db.claims[identityKey] = {
      claimId,
      claimedAt: new Date().toISOString(),
      amount: DRIP_AMOUNT,
      // txid: result.txid  // uncomment when wallet is wired up
      status: 'pending_funding'  // will be 'sent' when faucet wallet is funded and wired
    };
    db.count++;
    saveClaims(db);

    console.log(`[FAUCET] Drip #${db.count}/${MAX_CLAIMS} → ${identityKey.substring(0, 24)}... (${DRIP_AMOUNT} sats)`);

    res.json({
      success: true,
      amount: DRIP_AMOUNT,
      claimId,
      txid: claimId,  // placeholder until real tx
      message: `Claim recorded! ${DRIP_AMOUNT} mainnet sats reserved. Transaction will be broadcast when faucet wallet is funded.`,
      position: db.count,
      remaining: MAX_CLAIMS - db.count
    });

  } catch (err) {
    console.error('[FAUCET] Error:', err);
    res.status(500).json({ error: 'Faucet error — try again later.' });
  }
});

// --- Static file serving ---
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, 'favicon.svg')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Catch-all
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦞 ClawSats Faucet + Website (mainnet)`);
  console.log(`   http://0.0.0.0:${PORT}`);
  console.log(`   Faucet: ${db.count}/${MAX_CLAIMS} claimed, ${DRIP_AMOUNT} sats/drip`);
  console.log(`   Status: GET /api/faucet/status`);
  console.log(`   Drip:   POST /api/faucet/drip { identityKey }\n`);
});
