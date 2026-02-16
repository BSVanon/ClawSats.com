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
 *   GET  /api/healthz                  — production health summary
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
const dns = require('dns').promises;
const net = require('net');

const app = express();
app.use(express.json({ limit: '16kb' }));
app.disable('x-powered-by');
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  return next(err);
});

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
const SCHOLARSHIP_TX_FEE_RESERVE = parseInt(process.env.SCHOLARSHIP_TX_FEE_RESERVE || '1000', 10);
const DIRECT_SEND_FEE_BUFFER = parseInt(process.env.DIRECT_SEND_FEE_BUFFER || '1000', 10);
const FAUCET_MIN_RESERVE_SATS = parseInt(process.env.FAUCET_MIN_RESERVE_SATS || '50000', 10);
const FAUCET_RESERVE_SLOTS = Number.isFinite(Number(process.env.FAUCET_RESERVE_SLOTS))
  ? Math.max(0, parseInt(process.env.FAUCET_RESERVE_SLOTS, 10))
  : null;
const SCHOLARSHIP_INCLUDE_CLAIM_ONLY = String(process.env.SCHOLARSHIP_INCLUDE_CLAIM_ONLY || 'false').toLowerCase() === 'true';
const SCHOLARSHIP_ALLOW_LEGACY_P2PKH = String(process.env.SCHOLARSHIP_ALLOW_LEGACY_P2PKH || 'false').toLowerCase() === 'true';
const SCHOLARSHIP_SUBMIT_TIMEOUT_MS = parseInt(process.env.SCHOLARSHIP_SUBMIT_TIMEOUT_MS || '10000', 10);
const SCHOLARSHIP_REMIT_RETRY_MS = parseInt(process.env.SCHOLARSHIP_REMIT_RETRY_MS || '60000', 10);
const SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS = parseInt(process.env.SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS || '12000', 10);
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10));
const RATE_LIMIT_DRIP_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_DRIP_PER_MIN || '5', 10));
const RATE_LIMIT_REGISTER_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_REGISTER_PER_MIN || '20', 10));
const RATE_LIMIT_DISTRIBUTE_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_DISTRIBUTE_PER_MIN || '8', 10));
const RATE_LIMIT_WINDOW_MS = Math.max(1000, parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10));

app.set('trust proxy', TRUST_PROXY_HOPS);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if ((req.secure || req.headers['x-forwarded-proto'] === 'https') && req.method === 'GET') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// --- Wallet (lazy-initialized) ---
let faucetWallet = null;
let walletReady = false;
let walletError = null;
let walletBackend = 'none';
let settlingPendingClaims = false;
let replayingScholarshipRemittances = false;

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

async function fetchApi(url, options = {}) {
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
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return resp.json();
  }
  const text = (await resp.text()).trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

function randomHex(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  return false;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal' || host === 'metadata') return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  return false;
}

function isPublicIp(ip) {
  const candidate = String(ip || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(candidate);
  if (family === 4) return !isPrivateIPv4(candidate);
  if (family === 6) return !isPrivateIPv6(candidate);
  return false;
}

async function assertHostnameResolvesPublic(hostname) {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error('Endpoint hostname did not resolve.');
  }
  for (const answer of answers) {
    if (!answer || !isPublicIp(answer.address)) {
      throw new Error('Endpoint hostname resolves to non-public IP.');
    }
  }
}

async function normalizePublicEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('Invalid endpoint URL.');
  }
  if (endpoint.length > 2048) {
    throw new Error('Endpoint URL is too long.');
  }
  if (endpoint.includes('YOUR_CLAW_HOST')) {
    throw new Error('Endpoint is placeholder text and not a real URL.');
  }
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Endpoint must use http:// or https://');
  }
  if (url.username || url.password) {
    throw new Error('Endpoint must not include credentials.');
  }
  if (!url.hostname || isBlockedHostname(url.hostname)) {
    throw new Error('Endpoint hostname is not allowed.');
  }

  const hostIpFamily = net.isIP(String(url.hostname || '').replace(/^\[|\]$/g, ''));
  if (hostIpFamily) {
    if (!isPublicIp(url.hostname)) {
      throw new Error('Endpoint must resolve to a public IP.');
    }
  } else {
    await assertHostnameResolvesPublic(url.hostname);
  }

  url.hash = '';
  url.search = '';
  return stripTrailingSlash(url.toString());
}

function extractActionTxBase64(actionResult) {
  if (!actionResult) throw new Error('createAction returned no result');
  if (actionResult.rawTx) {
    if (typeof actionResult.rawTx === 'string') return actionResult.rawTx;
    return Buffer.from(actionResult.rawTx).toString('base64');
  }
  if (actionResult.tx) {
    if (typeof actionResult.tx === 'string') return actionResult.tx;
    return Buffer.from(actionResult.tx).toString('base64');
  }
  throw new Error('createAction result missing tx payload (expected rawTx or tx).');
}

async function deriveBRC29LockingScript(recipientIdentityKey, derivationPrefix, derivationSuffix) {
  if (!faucetWallet || typeof faucetWallet.getPublicKey !== 'function') {
    throw new Error('Wallet does not expose getPublicKey for BRC-29 derivation.');
  }
  const key = await faucetWallet.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey
  });
  const derivedPubKey = key && key.publicKey ? key.publicKey : null;
  if (!derivedPubKey || !isValidIdentityKey(derivedPubKey)) {
    throw new Error('BRC-29 key derivation returned an invalid public key.');
  }
  return p2pkhFromPubkey(derivedPubKey);
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

async function preflightScholarshipRecipient(identityKey, endpoint) {
  if (!endpoint) throw new Error('Missing endpoint for scholarship recipient.');
  const safeEndpoint = await normalizePublicEndpoint(endpoint);

  const discovery = await fetchApi(`${safeEndpoint}/discovery`, {
    signal: AbortSignal.timeout(Math.max(1000, SCHOLARSHIP_SUBMIT_TIMEOUT_MS))
  });
  const discoveredKey = discovery && typeof discovery.identityKey === 'string'
    ? discovery.identityKey
    : null;
  if (!discoveredKey || !isValidIdentityKey(discoveredKey)) {
    throw new Error('Recipient discovery response missing valid identityKey.');
  }
  if (discoveredKey !== identityKey) {
    throw new Error(`Endpoint identity mismatch: expected ${identityKey.substring(0, 16)}..., got ${discoveredKey.substring(0, 16)}...`);
  }
  return safeEndpoint;
}

async function submitScholarshipRemittance(remit) {
  if (!remit || typeof remit.transaction !== 'string' || remit.transaction.length < 16) {
    throw new Error('Missing remittance transaction payload.');
  }
  return fetchApi(`${remit.endpoint}/wallet/submit-payment`, {
    method: 'POST',
    signal: AbortSignal.timeout(Math.max(1000, SCHOLARSHIP_SUBMIT_TIMEOUT_MS)),
    body: JSON.stringify({
      protocol: '3241645161d8',
      senderIdentityKey: remit.senderIdentityKey,
      derivationPrefix: remit.derivationPrefix,
      derivationSuffix: remit.derivationSuffix,
      transaction: remit.transaction,
      amount: remit.satoshis,
      outputIndex: 0,
      note: remit.note
    })
  });
}

async function sendScholarshipToIdentityKey(identityKey, satoshis, endpoint) {
  const safeEndpoint = await preflightScholarshipRecipient(identityKey, endpoint);

  const derivationPrefix = randomHex(8);
  const derivationSuffix = randomHex(8);
  const lockingScript = await deriveBRC29LockingScript(identityKey, derivationPrefix, derivationSuffix);

  let txid = null;
  let transaction = null;
  let txhex = null;

  try {
    const result = await faucetWallet.createAction({
      description: `ClawSats scholarship: ${satoshis} sats to ${identityKey.substring(0, 16)}...`,
      outputs: [{
        satoshis,
        lockingScript,
        outputDescription: 'Scholarship distribution',
        tags: ['clawsats-scholarship']
      }],
      labels: ['clawsats-scholarship'],
      options: {
        acceptDelayedBroadcast: false,
        signAndProcess: true,
        randomizeOutputs: false
      }
    });
    txid = result.txid || null;
    transaction = extractActionTxBase64(result);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!(walletBackend === 'memory' && (
      msg.toLowerCase().includes('insufficient funds') ||
      msg.toLowerCase().includes('needed')
    ))) {
      throw err;
    }
    // Bridge mode for legacy-funded wallets: spend address UTXOs directly,
    // but still pay to a BRC-29 derived script so the recipient can internalize.
    console.warn('[SCHOLARSHIP] createAction could not see spendable inputs in memory mode; trying direct legacy-input bridge with BRC-29 remittance.');
    const direct = await sendViaDirectP2PKHFallback(identityKey, satoshis, { recipientScriptHex: lockingScript });
    txid = direct.txid || null;
    transaction = direct.transaction || null;
    txhex = direct.txhex || null;
    if (!txid) {
      throw new Error('Direct legacy-input bridge did not return a txid.');
    }
    if (!transaction) {
      try {
        transaction = await buildVerifiedAtomicRemittanceByTxid(txid);
      } catch (repairErr) {
        const rmsg = repairErr && repairErr.message ? repairErr.message : String(repairErr);
        console.warn(`[SCHOLARSHIP] Could not build immediate AtomicBEEF payload for ${identityKey.substring(0, 16)}... txid=${txid.substring(0, 16)}: ${rmsg}`);
      }
    }
  }

  const remittance = {
    txid: txid || '',
    identityKey,
    endpoint: safeEndpoint,
    satoshis,
    senderIdentityKey: faucetIdentityKey,
    derivationPrefix,
    derivationSuffix,
    transaction,
    txhex,
    note: `Scholarship payment ${satoshis} sats`,
    attempts: 0,
    lastError: null,
    nextAttemptAt: Date.now(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  try {
    const ack = await submitScholarshipRemittance(remittance);
    return {
      txid,
      status: txid ? 'sent' : 'broadcast_pending',
      remittance: ack || null,
      internalizePending: false
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    remittance.attempts = 1;
    remittance.lastError = msg;
    remittance.nextAttemptAt = Date.now() + SCHOLARSHIP_REMIT_RETRY_MS;
    remittance.updatedAt = new Date().toISOString();
    queueScholarshipRemittance(remittance);
    console.warn(`[SCHOLARSHIP] Internalize submit failed for ${identityKey.substring(0, 16)}... queued for retry: ${msg}`);
    return {
      txid,
      status: txid ? 'sent_pending_internalize' : 'broadcast_pending_internalize',
      remittance: null,
      internalizePending: true
    };
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
function checkRateLimit(ip, routeKey, limitMax, limitWindowMs = RATE_LIMIT_WINDOW_MS) {
  const key = `${routeKey}:${ip || 'unknown'}`;
  const now = Date.now();
  if (rateLimits.size > 50000) {
    for (const [k, v] of rateLimits) {
      if (!v || now - v.start > limitWindowMs) rateLimits.delete(k);
    }
  }
  const entry = rateLimits.get(key);
  if (!entry || now - entry.start > limitWindowMs) {
    rateLimits.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > limitMax) return false;
  return true;
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
  if (!checkRateLimit(ip, 'faucet-drip', RATE_LIMIT_DRIP_PER_MIN)) {
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

function getEligibleClaws() {
  const eligible = [];
  const seen = new Set();
  let excludedMissingEndpoint = 0;
  let excludedPlaceholderEndpoint = 0;

  function isUsableEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'string') return false;
    if (endpoint.includes('YOUR_CLAW_HOST')) return false;
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (url.username || url.password) return false;
      if (!url.hostname || isBlockedHostname(url.hostname)) return false;
      const family = net.isIP(String(url.hostname || '').replace(/^\[|\]$/g, ''));
      if (family && !isPublicIp(url.hostname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  for (const [key, entry] of Object.entries(directory)) {
    const endpoint = entry?.endpoint || null;
    if (!isValidIdentityKey(key)) continue;
    if (isUsableEndpoint(endpoint)) {
      eligible.push({ identityKey: key, endpoint });
      seen.add(key);
      continue;
    }
    if (endpoint && endpoint.includes('YOUR_CLAW_HOST')) {
      excludedPlaceholderEndpoint++;
    } else {
      excludedMissingEndpoint++;
    }
  }

  for (const [key] of Object.entries(db.claims)) {
    if (seen.has(key) || !isValidIdentityKey(key)) continue;
    const entry = directory[key] || null;
    const endpoint = entry?.endpoint || null;

    if (isUsableEndpoint(endpoint)) {
      eligible.push({ identityKey: key, endpoint });
      seen.add(key);
      continue;
    }

    if (SCHOLARSHIP_INCLUDE_CLAIM_ONLY && SCHOLARSHIP_ALLOW_LEGACY_P2PKH) {
      eligible.push({ identityKey: key, endpoint: null });
      seen.add(key);
      continue;
    }

    if (endpoint && endpoint.includes('YOUR_CLAW_HOST')) {
      excludedPlaceholderEndpoint++;
    } else {
      excludedMissingEndpoint++;
    }
  }

  return {
    eligible,
    excludedMissingEndpoint,
    excludedPlaceholderEndpoint,
    includeClaimOnly: SCHOLARSHIP_INCLUDE_CLAIM_ONLY,
    legacyP2PKHEnabled: SCHOLARSHIP_ALLOW_LEGACY_P2PKH
  };
}

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
app.post('/api/directory/register', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip, 'directory-register', RATE_LIMIT_REGISTER_PER_MIN)) {
    return res.status(429).json({ error: 'Too many requests.' });
  }

  const { identityKey, endpoint, capabilities } = req.body || {};

  if (!isValidIdentityKey(identityKey)) {
    return res.status(400).json({ error: 'Invalid identity key.' });
  }

  let normalizedEndpoint;
  try {
    normalizedEndpoint = await normalizePublicEndpoint(endpoint);
  } catch (err) {
    const msg = err && err.message ? err.message : 'Invalid endpoint URL.';
    return res.status(400).json({ error: msg });
  }

  directory[identityKey] = {
    endpoint: normalizedEndpoint,
    capabilities: Array.isArray(capabilities)
      ? capabilities
          .filter(c => typeof c === 'string' && c.length > 0 && c.length <= 64)
          .slice(0, 20)
      : null,
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

const SCHOLARSHIP_REMIT_PATH = path.join(__dirname, 'scholarship-remittances.json');
function loadScholarshipRemittances() {
  try {
    if (fs.existsSync(SCHOLARSHIP_REMIT_PATH)) {
      const data = JSON.parse(fs.readFileSync(SCHOLARSHIP_REMIT_PATH, 'utf8'));
      if (data && Array.isArray(data.pending)) {
        return { pending: data.pending };
      }
    }
  } catch {}
  return { pending: [] };
}

function saveScholarshipRemittances(store) {
  fs.writeFileSync(SCHOLARSHIP_REMIT_PATH, JSON.stringify(store, null, 2));
}

let scholarshipRemittances = loadScholarshipRemittances();

function queueScholarshipRemittance(remit) {
  const key = `${remit.txid}:${remit.identityKey}:${remit.derivationPrefix}:${remit.derivationSuffix}`;
  const idx = scholarshipRemittances.pending.findIndex(r =>
    `${r.txid}:${r.identityKey}:${r.derivationPrefix}:${r.derivationSuffix}` === key
  );
  if (idx >= 0) {
    scholarshipRemittances.pending[idx] = { ...scholarshipRemittances.pending[idx], ...remit };
  } else {
    scholarshipRemittances.pending.push(remit);
  }
  saveScholarshipRemittances(scholarshipRemittances);
}

function removeScholarshipRemittance(remit) {
  const key = `${remit.txid}:${remit.identityKey}:${remit.derivationPrefix}:${remit.derivationSuffix}`;
  scholarshipRemittances.pending = scholarshipRemittances.pending.filter(r =>
    `${r.txid}:${r.identityKey}:${r.derivationPrefix}:${r.derivationSuffix}` !== key
  );
  saveScholarshipRemittances(scholarshipRemittances);
}

function isAtomicRemittanceError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('must be valid atomicbeef') ||
    text.includes('must be valid with at least one transaction to internalize an output from')
  );
}

function parseWocTxHex(raw) {
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/^"|"$/g, '');
    if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0) return cleaned;
  } else if (raw && typeof raw.hex === 'string') {
    return raw.hex.trim();
  } else if (raw && typeof raw.txhex === 'string') {
    return raw.txhex.trim();
  }
  throw new Error('Could not parse tx hex response.');
}

function buildMerklePathFromWocProof(txid, proof, MerklePath) {
  if (!proof || !Number.isInteger(proof.block_height) || !Number.isInteger(proof.pos) || !Array.isArray(proof.merkle)) {
    throw new Error('Invalid merkle proof payload.');
  }
  const siblings = proof.merkle;
  if (!siblings.every(h => typeof h === 'string' && /^[0-9a-fA-F]{64}$/.test(h))) {
    throw new Error('Merkle proof contains invalid sibling hashes.');
  }

  if (siblings.length === 0) {
    return new MerklePath(proof.block_height, [[{ offset: proof.pos, hash: txid, txid: true }]]);
  }

  const path = [];
  path[0] = [
    { offset: proof.pos, hash: txid, txid: true },
    { offset: (proof.pos ^ 1), hash: siblings[0] }
  ];
  for (let h = 1; h < siblings.length; h++) {
    path[h] = [{ offset: ((proof.pos >> h) ^ 1), hash: siblings[h] }];
  }
  return new MerklePath(proof.block_height, path);
}

async function buildVerifiedAtomicRemittanceByTxid(txid) {
  if (!txid || typeof txid !== 'string') {
    throw new Error('Cannot rebuild remittance payload: missing txid.');
  }
  const { Transaction, MerklePath, Beef, WhatsOnChain } = require('@bsv/sdk');

  const timeout = Math.max(1000, SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS);
  const [txhexRaw, proof] = await Promise.all([
    fetchApi(`${WOC_API_BASE}/tx/${txid}/hex`, { signal: AbortSignal.timeout(timeout) }),
    fetchApi(`${WOC_API_BASE}/tx/${txid}/merkleproof`, { signal: AbortSignal.timeout(timeout) })
  ]);

  const txhex = parseWocTxHex(txhexRaw);
  const tx = Transaction.fromHex(txhex);
  tx.merklePath = buildMerklePathFromWocProof(txid, proof, MerklePath);

  const atomic = tx.toAtomicBEEF(true);
  const beef = Beef.fromBinary(atomic);
  const ok = await beef.verify(new WhatsOnChain('main'), false);
  if (!ok) {
    throw new Error(`AtomicBEEF verification failed for ${txid}.`);
  }
  return Buffer.from(atomic).toString('base64');
}

async function repairScholarshipRemittance(remit, reason = 'unknown') {
  if (!remit || !remit.txid) {
    throw new Error('Cannot repair remittance payload without txid.');
  }
  const atomicBase64 = await buildVerifiedAtomicRemittanceByTxid(remit.txid);
  remit.transaction = atomicBase64;
  remit.lastError = null;
  remit.nextAttemptAt = Date.now();
  remit.updatedAt = new Date().toISOString();
  queueScholarshipRemittance(remit);
  console.log(`[SCHOLARSHIP] Rebuilt AtomicBEEF remittance for ${remit.identityKey.substring(0, 16)}... txid=${(remit.txid || '').substring(0, 16)} reason=${reason}`);
}

async function replayScholarshipRemittances(maxToProcess = 25) {
  if (replayingScholarshipRemittances) {
    return { processed: 0, delivered: 0, failed: 0, remaining: scholarshipRemittances.pending.length };
  }
  if (!scholarshipRemittances.pending.length) {
    return { processed: 0, delivered: 0, failed: 0, remaining: 0 };
  }

  replayingScholarshipRemittances = true;
  try {
    let processed = 0;
    let delivered = 0;
    let failed = 0;
    const now = Date.now();

    for (const remit of [...scholarshipRemittances.pending]) {
      if (processed >= maxToProcess) break;
      if (remit.nextAttemptAt && Number(remit.nextAttemptAt) > now) continue;

      processed++;
      try {
        // Older queued entries may have a malformed or partial tx payload; self-heal before submit.
        if (typeof remit.transaction !== 'string' || remit.transaction.length < 16) {
          await repairScholarshipRemittance(remit, 'missing_or_invalid_payload');
        }

        await submitScholarshipRemittance(remit);
        removeScholarshipRemittance(remit);
        delivered++;
        console.log(`[SCHOLARSHIP] Internalize delivered for ${remit.identityKey.substring(0, 16)}... txid=${(remit.txid || '').substring(0, 16)}`);
      } catch (err) {
        let message = err && err.message ? err.message : String(err);

        // If recipient rejects tx payload validation, rebuild a proof-backed AtomicBEEF and retry once.
        if (isAtomicRemittanceError(message) && remit.txid) {
          try {
            await repairScholarshipRemittance(remit, 'recipient_rejected_payload');
            await submitScholarshipRemittance(remit);
            removeScholarshipRemittance(remit);
            delivered++;
            console.log(`[SCHOLARSHIP] Internalize delivered after remittance repair for ${remit.identityKey.substring(0, 16)}... txid=${(remit.txid || '').substring(0, 16)}`);
            continue;
          } catch (repairErr) {
            message = repairErr && repairErr.message ? repairErr.message : String(repairErr);
          }
        }

        failed++;
        remit.attempts = Number(remit.attempts || 0) + 1;
        remit.lastError = message;
        remit.nextAttemptAt = Date.now() + SCHOLARSHIP_REMIT_RETRY_MS;
        remit.updatedAt = new Date().toISOString();
        queueScholarshipRemittance(remit);
        console.warn(`[SCHOLARSHIP] Internalize retry failed for ${remit.identityKey.substring(0, 16)}...: ${remit.lastError}`);
      }
    }

    return {
      processed,
      delivered,
      failed,
      remaining: scholarshipRemittances.pending.length
    };
  } finally {
    replayingScholarshipRemittances = false;
  }
}

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
      const data = await fetchApi(`${WOC_API_BASE}/address/${faucetAddress}/balance`);
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

async function sendViaDirectP2PKHFallback(recipientIdentityKey, satoshis, options = {}) {
  if (!FAUCET_ROOT_KEY_HEX || !faucetAddress) {
    throw new Error('Direct P2PKH fallback unavailable: missing faucet key/address.');
  }

  const { PrivateKey, P2PKH, fromUtxo, Transaction, Script, SatoshisPerKilobyte } = require('@bsv/sdk');

  const priv = PrivateKey.fromHex(FAUCET_ROOT_KEY_HEX);
  const unlock = new P2PKH().unlock(priv);
  const recipientScriptHex = options.recipientScriptHex || p2pkhFromPubkey(recipientIdentityKey);

  const rawUtxos = await fetchApi(`${WOC_API_BASE}/address/${faucetAddress}/unspent`);
  const baseUtxos = (Array.isArray(rawUtxos) ? rawUtxos : [])
    .map(u => ({
      txid: u.tx_hash || u.tx_hash_big_endian || u.txid,
      vout: u.tx_pos ?? u.vout ?? u.tx_output_n,
      satoshis: Number(u.value ?? u.satoshis ?? 0)
    }))
    .filter(u => typeof u.txid === 'string' && Number.isInteger(u.vout) && u.satoshis > 0)
    .sort((a, b) => b.satoshis - a.satoshis);

  if (baseUtxos.length === 0) {
    throw new Error('No spendable UTXOs found for faucet address.');
  }

  async function loadUtxoScript(u) {
    const txhexResp = await fetchApi(`${WOC_API_BASE}/tx/${u.txid}/hex`);
    const txhex = typeof txhexResp === 'string'
      ? txhexResp
      : (txhexResp?.hex || txhexResp?.txhex || String(txhexResp));
    const sourceTx = Transaction.fromHex(txhex);
    const out = sourceTx.outputs?.[u.vout];
    if (!out || !out.lockingScript) {
      throw new Error(`Missing source output for ${u.txid}:${u.vout}`);
    }
    return {
      ...u,
      satoshis: Number(out.satoshis || u.satoshis || 0),
      script: out.lockingScript.toHex()
    };
  }

  // Build a candidate tx with selected UTXOs until fee+output are covered.
  const tx = new Transaction();
  let inputTotal = 0;
  let selected = 0;
  const targetFloor = satoshis + Math.max(1, DIRECT_SEND_FEE_BUFFER);

  for (const base of baseUtxos) {
    const u = await loadUtxoScript(base);
    tx.addInput(fromUtxo({
      txid: u.txid,
      vout: u.vout,
      satoshis: u.satoshis,
      script: u.script
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
  const br = await fetchApi(`${WOC_API_BASE}/tx/raw`, {
    method: 'POST',
    body: JSON.stringify({ txhex })
  });

  const txid = br.txid || br || null;
  if (!txid || typeof txid !== 'string') {
    throw new Error(`Broadcast response missing txid: ${JSON.stringify(br).slice(0, 240)}`);
  }

  // Do not emit immediate AtomicBEEF from raw tx only; it may be missing proof.
  // Caller will rebuild a proof-backed payload from txid or queue for replay repair.
  const transaction = null;

  console.log(`[FAUCET] Direct P2PKH fallback broadcast txid=${txid.substring(0, 16)}... inputs=${selected} totalIn=${inputTotal}`);
  return { txid, status: 'sent', transaction, txhex };
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
  const scholarship = getEligibleClaws();
  const balance = await getWalletBalance();
  fund.lastKnownBalance = balance;
  fund.lastBalanceCheck = Date.now();

  res.json({
    walletBalance: balance,
    totalDistributed: fund.totalDistributed,
    totalDistributions: fund.distributions.length,
    pendingInternalizations: scholarshipRemittances.pending.length,
    eligibleClaws: scholarship.eligible.length,
    excludedMissingEndpoint: scholarship.excludedMissingEndpoint,
    excludedPlaceholderEndpoint: scholarship.excludedPlaceholderEndpoint,
    includeClaimOnly: scholarship.includeClaimOnly,
    legacyP2PKHEnabled: scholarship.legacyP2PKHEnabled,
    address: faucetAddress || null,
    chain: 'main',
    recentDistributions: fund.distributions.slice(-10).reverse()
  });
});

// GET /api/healthz — production health summary
app.get('/api/healthz', async (req, res) => {
  const balance = await getWalletBalance();
  const pendingClaims = getPendingClaimEntries().length;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    walletReady,
    walletBackend,
    walletBalance: balance,
    pendingClaims,
    pendingInternalizations: scholarshipRemittances.pending.length,
    knownDirectoryEntries: Object.keys(directory).length,
    faucetClaims: db.count
  });
});

// POST /api/scholarships/distribute — distribute wallet balance across eligible Claws
// This sends REAL sats from the faucet wallet to Claws.
// The wallet must have balance (from human donations sent to the QR code address).
app.post('/api/scholarships/distribute', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip, 'scholarship-distribute', RATE_LIMIT_DISTRIBUTE_PER_MIN)) {
    return res.status(429).json({ error: 'Too many distribution requests. Try again in a minute.' });
  }

  if (!walletReady || !faucetWallet) {
    return res.status(503).json({ error: 'Faucet wallet not ready. Cannot distribute.' });
  }

  // Check real wallet balance
  const balance = await getWalletBalance();
  // Reserve sats for pending claims only by default (or explicit env override).
  // Reserving all future 499 potential claims blocks scholarship distribution.
  const pendingClaims = getPendingClaimEntries().length;
  const reserveSlots = FAUCET_RESERVE_SLOTS ?? pendingClaims;
  const reserveFromSlots = reserveSlots * MIN_DRIP_SPENDABLE;
  const reserveForFaucet = Math.max(FAUCET_MIN_RESERVE_SATS, reserveFromSlots);
  const scholarship = getEligibleClaws();
  const eligible = scholarship.eligible;
  const txFeeReserveTotal = eligible.length * Math.max(1, SCHOLARSHIP_TX_FEE_RESERVE);
  const budgetForOutputs = Math.max(0, balance - reserveForFaucet - txFeeReserveTotal);

  if (eligible.length === 0) {
    const missing = scholarship.excludedMissingEndpoint + scholarship.excludedPlaceholderEndpoint;
    const reason = missing > 0
      ? 'No eligible Claws: register a real public endpoint first via POST /api/directory/register.'
      : 'No eligible Claws found yet.';
    return res.json({
      distributed: 0,
      message: reason,
      walletBalance: balance,
      excludedMissingEndpoint: scholarship.excludedMissingEndpoint,
      excludedPlaceholderEndpoint: scholarship.excludedPlaceholderEndpoint,
      reservedForFaucet: reserveForFaucet,
      faucetMinReserve: FAUCET_MIN_RESERVE_SATS,
      reserveSlots,
      pendingClaims
    });
  }

  if (budgetForOutputs < eligible.length) {
    return res.json({
      distributed: 0,
      walletBalance: balance,
      excludedMissingEndpoint: scholarship.excludedMissingEndpoint,
      excludedPlaceholderEndpoint: scholarship.excludedPlaceholderEndpoint,
      reservedForFaucet: reserveForFaucet,
      faucetMinReserve: FAUCET_MIN_RESERVE_SATS,
      reservedForScholarshipFees: txFeeReserveTotal,
      reserveSlots,
      pendingClaims,
      message: 'Insufficient balance after reserving faucet + tx fees for scholarship sends. Send more BSV to the scholarship address.'
    });
  }

  // Split evenly from output budget after reserving expected tx-fee headroom.
  const perClaw = Math.max(1, Math.floor(budgetForOutputs / eligible.length));
  const totalToDistribute = perClaw * eligible.length;

  // Shuffle eligible list for fairness (Fisher-Yates)
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }

  const results = [];
  const errors = [];
  let distributed = 0;
  let internalizePending = 0;

  for (const claw of eligible) {
    if (distributed + perClaw > totalToDistribute) break;

    let txid = null;
    let status = 'failed';
    let remittance = null;

    try {
      const result = await sendScholarshipToIdentityKey(claw.identityKey, perClaw, claw.endpoint);
      txid = result.txid;
      status = result.status;
      remittance = result.remittance || null;
      if (result.internalizePending) internalizePending++;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn(`[SCHOLARSHIP] Send failed for ${claw.identityKey.substring(0, 16)}...: ${msg}`);
      errors.push({
        identityKey: claw.identityKey,
        error: msg
      });
      continue;
    }

    const dist = {
      identityKey: claw.identityKey,
      endpoint: claw.endpoint,
      satoshis: perClaw,
      txid,
      status,
      remittance,
      distributedAt: new Date().toISOString()
    };
    results.push(dist);
    fund.distributions.push(dist);
    distributed += perClaw;
  }

  fund.totalDistributed += distributed;
  saveFund(fund);

  console.log(`[SCHOLARSHIP] Distributed ${distributed} sats across ${results.length} Claws (${perClaw} each)`);
  if (errors.length > 0) {
    console.warn(`[SCHOLARSHIP] Distribution halted with ${errors.length} error(s).`);
  }

  res.json({
    distributed,
    perClaw,
    clawsReached: results.length,
    internalizePending,
    results,
    errors,
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
    const remitReplay = await replayScholarshipRemittances(100);
    if (remitReplay.processed > 0) {
      console.log(`[SCHOLARSHIP] Internalize replay: processed=${remitReplay.processed} delivered=${remitReplay.delivered} failed=${remitReplay.failed} remaining=${remitReplay.remaining}`);
    }
    setInterval(async () => {
      try {
        const tick = await settlePendingClaims(25);
        if (tick.processed > 0) {
          console.log(`[FAUCET] Pending claims replay tick: processed=${tick.processed} sent=${tick.sent} failed=${tick.failed} remaining=${tick.remaining}`);
        }
        const remitTick = await replayScholarshipRemittances(25);
        if (remitTick.processed > 0) {
          console.log(`[SCHOLARSHIP] Internalize replay tick: processed=${remitTick.processed} delivered=${remitTick.delivered} failed=${remitTick.failed} remaining=${remitTick.remaining}`);
        }
      } catch (tickErr) {
        const msg = tickErr && tickErr.message ? tickErr.message : String(tickErr);
        console.error(`[FAUCET] Replay tick failed: ${msg}`);
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
