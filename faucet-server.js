#!/usr/bin/env node
/**
 * ClawSats Bootstrap Faucet + Scholarship Fund + Claw Directory — Mainnet
 *
 * Entry point only. All logic lives in lib/ modules:
 *   lib/utils.js            — shared helpers (fetchApi, validation, rate limiting, audit)
 *   lib/wallets.js          — wallet init, balance queries, BRC-29 derivation
 *   lib/directory.js        — Claw directory + seed peers + eligible Claw filtering
 *   lib/faucet-routes.js    — faucet drip, claims DB, settle pending, healthz, audit
 *   lib/scholarship-retry.js — remittance queue, AtomicBEEF builders, repair/replay
 *   lib/scholarship.js      — scholarship fund ledger, distribution, scholarship routes
 *   lib/openclaw-proxy.js   — OpenClaw JSON-RPC proxy + Phase D stubs
 *   lib/demo.js             — "Try a Claw" 402 demo flow + budget + demo routes
 *
 * Run: FAUCET_ROOT_KEY_HEX=<key> node faucet-server.js
 */

'use strict';

const express = require('express');
const path = require('path');

// --- Modules ---
const { state, initWallet, initScholarshipWallet, initDemoWallet } = require('./lib/wallets');
const { remittances: scholarshipRemittances, replayScholarshipRemittances } = require('./lib/scholarship-retry');
const { getPendingClaimEntries, settlePendingClaims, db: claimsDb, FAUCET_DISABLE_PENDING_REPLAY } = require('./lib/faucet-routes');
const { SCHOLARSHIP_DISTRIBUTE_TOKEN } = require('./lib/scholarship');
const anvilMesh = require('./lib/anvil-mesh');
const { getEligibleClaws } = require('./lib/directory');

// --- Config ---
const PORT = parseInt(process.env.FAUCET_PORT || '3322', 10);
const BIND_HOST = process.env.FAUCET_BIND_HOST || '127.0.0.1';
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10));
const DEMO_BOOTSTRAP_SATS = Math.max(0, parseInt(process.env.DEMO_BOOTSTRAP_SATS || '500', 10));
const DEMO_ROOT_KEY_HEX = process.env.DEMO_ROOT_KEY_HEX || '';

// --- Express setup ---
const app = express();
app.use(express.json({ limit: '16kb' }));
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HOPS);

// JSON parse error handler
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  return next(err);
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if ((req.secure || req.headers['x-forwarded-proto'] === 'https') && req.method === 'GET') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// --- Mount all routes ---
const routeDeps = { claimsDb, scholarshipRemittances, getPendingClaimEntries };

require('./lib/faucet-routes').mountRoutes(app, { scholarshipRemittances });
require('./lib/directory').mountRoutes(app, { claimsDb });
require('./lib/scholarship').mountRoutes(app, routeDeps);
require('./lib/openclaw-proxy').mountRoutes(app);
require('./lib/demo').mountRoutes(app);

// --- Static file serving ---
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/onboard', express.static(path.join(__dirname, 'onboard')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, 'favicon.svg')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/onboard', (req, res) => res.sendFile(path.join(__dirname, 'onboard.html')));
app.get('/onboard/', (req, res) => res.sendFile(path.join(__dirname, 'onboard', 'index.html')));
app.get('/onboard.html', (req, res) => res.sendFile(path.join(__dirname, 'onboard.html')));

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// --- Demo wallet bootstrap (BRC-100 wallet-to-wallet transfer) ---

async function bootstrapDemoWallet() {
  if (!DEMO_ROOT_KEY_HEX || !state.demoWalletReady || state.demoWallet === state.faucetWallet) return;
  if (!state.walletReady || !state.faucetWallet) {
    console.log('[DEMO] Bootstrap skipped: faucet wallet not ready.');
    return;
  }
  if (DEMO_BOOTSTRAP_SATS <= 0) return;

  try {
    const existing = await state.demoWallet.listOutputs({ basket: 'default', limit: 1 });
    if (existing && existing.outputs && existing.outputs.length > 0) {
      console.log('[DEMO] Demo wallet already has internal UTXOs — bootstrap not needed.');
      return;
    }
  } catch {}

  console.log(`[DEMO] Bootstrapping demo wallet with ${DEMO_BOOTSTRAP_SATS} sats from faucet...`);

  try {
    const crypto = require('crypto');
    const { deriveBRC29LockingScript, extractActionTxBase64 } = require('./lib/wallets');
    const derivationPrefix = crypto.randomBytes(12).toString('base64');
    const derivationSuffix = 'bootstrap';

    const lockingScript = await deriveBRC29LockingScript(
      state.demoIdentityKey, derivationPrefix, derivationSuffix, state.faucetWallet
    );

    const actionResult = await state.faucetWallet.createAction({
      description: `Bootstrap demo wallet (${DEMO_BOOTSTRAP_SATS} sats)`,
      outputs: [{
        satoshis: DEMO_BOOTSTRAP_SATS, lockingScript,
        outputDescription: 'Demo wallet bootstrap funding',
        tags: ['clawsats-demo-bootstrap'], basket: 'clawsats-demo-bootstrap'
      }],
      labels: ['clawsats-demo-bootstrap'],
      options: { signAndProcess: true, acceptDelayedBroadcast: false, randomizeOutputs: false }
    });

    let txBytes;
    if (actionResult.tx) {
      if (Array.isArray(actionResult.tx)) {
        txBytes = actionResult.tx;
      } else if (typeof actionResult.tx === 'string') {
        txBytes = Array.from(Buffer.from(actionResult.tx, 'base64'));
      } else {
        txBytes = Array.from(actionResult.tx);
      }
    } else if (actionResult.rawTx) {
      console.warn('[DEMO] createAction returned rawTx instead of tx (AtomicBEEF). Internalization may fail.');
      txBytes = Array.isArray(actionResult.rawTx) ? actionResult.rawTx : Array.from(Buffer.from(actionResult.rawTx));
    } else {
      throw new Error('createAction returned no tx data');
    }

    const txid = actionResult.txid || null;
    let outputIndex = 0;
    if (actionResult.outputs && Array.isArray(actionResult.outputs)) {
      const found = actionResult.outputs.findIndex(o => o.satoshis === DEMO_BOOTSTRAP_SATS);
      if (found >= 0) outputIndex = found;
    }

    await state.demoWallet.internalizeAction({
      tx: txBytes,
      outputs: [{
        outputIndex, protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: state.faucetIdentityKey }
      }],
      description: 'Bootstrap funding from faucet'
    });

    console.log(`[DEMO] Bootstrap complete: ${DEMO_BOOTSTRAP_SATS} sats transferred.${txid ? ` txid: ${txid}` : ''}`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[DEMO] Bootstrap failed (non-fatal): ${msg}`);
  }
}

// --- Start ---

async function main() {
  await initWallet();
  await initScholarshipWallet();
  await initDemoWallet();
  await bootstrapDemoWallet();

  if (!SCHOLARSHIP_DISTRIBUTE_TOKEN) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[STARTUP] FATAL: SCHOLARSHIP_DISTRIBUTE_TOKEN must be set in production.');
      process.exit(1);
    }
    console.warn('[SCHOLARSHIP] SCHOLARSHIP_DISTRIBUTE_TOKEN not set: /api/scholarships/distribute is unauthenticated.');
  }

  if (state.walletReady) {
    // Replay pending claims + scholarship remittances at startup
    if (!FAUCET_DISABLE_PENDING_REPLAY) {
      const replay = await settlePendingClaims(100);
      if (replay.processed > 0) {
        console.log(`[FAUCET] Pending claims replay: processed=${replay.processed} sent=${replay.sent} failed=${replay.failed} remaining=${replay.remaining}`);
      }
    }
    const remitReplay = await replayScholarshipRemittances(100);
    if (remitReplay.processed > 0) {
      console.log(`[SCHOLARSHIP] Internalize replay: processed=${remitReplay.processed} delivered=${remitReplay.delivered} failed=${remitReplay.failed} remaining=${remitReplay.remaining}`);
    }

    // Periodic tick
    setInterval(async () => {
      try {
        if (!FAUCET_DISABLE_PENDING_REPLAY) {
          const tick = await settlePendingClaims(25);
          if (tick.processed > 0) {
            console.log(`[FAUCET] Replay tick: processed=${tick.processed} sent=${tick.sent} failed=${tick.failed} remaining=${tick.remaining}`);
          }
        }
        const remitTick = await replayScholarshipRemittances(25);
        if (remitTick.processed > 0) {
          console.log(`[SCHOLARSHIP] Replay tick: processed=${remitTick.processed} delivered=${remitTick.delivered} failed=${remitTick.failed} remaining=${remitTick.remaining}`);
        }
      } catch (tickErr) {
        console.error(`[FAUCET] Replay tick failed: ${tickErr && tickErr.message ? tickErr.message : String(tickErr)}`);
      }
    }, 60_000).unref();
  }

  // --- Anvil mesh bridge (protocol ambassador) ---
  if (anvilMesh.init()) {
    anvilMesh.start(() => getEligibleClaws(claimsDb)).catch(err => {
      console.warn(`[ANVIL] Bridge start failed: ${err && err.message ? err.message : String(err)}`);
    });
  }

  const DRIP_AMOUNT = 100;
  const MAX_CLAIMS = 500;

  const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`\nClawSats Faucet + Website (mainnet)`);
    console.log(`   http://${BIND_HOST}:${PORT}`);
    console.log(`   Faucet: ${claimsDb.count}/${MAX_CLAIMS} claimed, ${DRIP_AMOUNT} sats/drip`);
    console.log(`   Faucet wallet: ${state.walletReady ? `ready (${state.walletBackend})` : 'not ready'} — ${state.faucetAddress || 'no address'}`);
    if (state.dualWalletMode) {
      console.log(`   Scholarship wallet: ${state.scholarshipWalletReady ? `ready (${state.scholarshipWalletBackend})` : 'not ready'} — ${state.scholarshipAddress || 'no address'}`);
    } else {
      console.log(`   Scholarship: shared faucet wallet`);
    }
    if (state.demoWalletReady) {
      console.log(`   Demo wallet: ready (${state.demoWalletBackend}) — ${state.demoAddress || 'no address'}`);
    }
    console.log(`   Status: GET /api/faucet/status`);
    console.log(`   Drip:   POST /api/faucet/drip { identityKey }`);
    console.log(`   Demo:   POST /api/demo/try\n`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[STARTUP] Port ${PORT} already in use. Aborting.`);
    } else {
      console.error(`[STARTUP] Server listen error: ${err.message}`);
    }
    process.exit(1);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
