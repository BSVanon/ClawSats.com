'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { p2pkhFromPubkey, isValidIdentityKey, checkRateLimit, writeSpendAudit, readSpendAudit, fetchApi } = require('./utils');
const { state, getWalletBalance, getFaucetBalance, getScholarshipBalance } = require('./wallets');

const DB_PATH = process.env.FAUCET_CLAIMS_PATH || path.join(__dirname, '..', 'faucet-claims.json');
const DRIP_AMOUNT = 100;
const MAX_CLAIMS = 500;
const MIN_DRIP_SPENDABLE = parseInt(process.env.MIN_DRIP_SPENDABLE || '250', 10);
const RATE_LIMIT_DRIP_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_DRIP_PER_MIN || '5', 10));
const SPEND_AUDIT_PATH = process.env.SPEND_AUDIT_PATH || path.join(__dirname, '..', 'spend-audit.jsonl');
const FAUCET_DISABLE_PENDING_REPLAY = String(process.env.FAUCET_DISABLE_PENDING_REPLAY || 'false').toLowerCase() === 'true';
const WOC_API_BASE = process.env.WOC_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main';
const DIRECT_SEND_FEE_BUFFER = parseInt(process.env.DIRECT_SEND_FEE_BUFFER || '1000', 10);

// --- Claims database ---

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

const db = loadClaims();

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

// --- Send drip ---

async function sendDripToIdentityKey(identityKey, descriptionPrefix = 'ClawSats faucet drip', spendReason = 'faucet-drip-request') {
  const lockingScript = p2pkhFromPubkey(identityKey);
  try {
    const result = await state.faucetWallet.createAction({
      description: `${descriptionPrefix} to ${identityKey.substring(0, 16)}...`,
      outputs: [{
        satoshis: DRIP_AMOUNT,
        lockingScript,
        outputDescription: 'faucet drip',
        tags: ['clawsats-faucet'],
        basket: 'clawsats-faucet-drips'
      }],
      labels: ['clawsats-faucet'],
      options: { acceptDelayedBroadcast: false }
    });
    const txid = result.txid || null;
    const status = txid ? 'sent' : 'pending_broadcast';
    if (txid) {
      writeSpendAudit({
        reason: spendReason, identityKey, satoshis: DRIP_AMOUNT, txid, status, method: 'createAction'
      }, { auditPath: SPEND_AUDIT_PATH, walletBackend: state.walletBackend });
    }
    return { txid, status };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg.toLowerCase().includes('insufficient funds') || msg.toLowerCase().includes('needed')) {
      console.warn(`[FAUCET] createAction insufficient funds (${state.walletBackend} mode); trying direct P2PKH fallback.`);
      const fallback = await sendViaDirectP2PKHFallback(identityKey, DRIP_AMOUNT);
      if (fallback?.txid) {
        writeSpendAudit({
          reason: spendReason, identityKey, satoshis: DRIP_AMOUNT,
          txid: fallback.txid, status: fallback.status || 'sent', method: 'direct-p2pkh-fallback'
        }, { auditPath: SPEND_AUDIT_PATH, walletBackend: state.walletBackend });
      }
      return fallback;
    }
    throw err;
  }
}

// --- Direct P2PKH fallback (when createAction can't see UTXOs) ---

async function sendViaDirectP2PKHFallback(recipientIdentityKey, satoshis, options = {}) {
  const keyHex = options.rootKeyHex || process.env.FAUCET_ROOT_KEY_HEX;
  const addr = options.fromAddress || state.faucetAddress;
  if (!keyHex || !addr) throw new Error('Direct P2PKH fallback unavailable: missing key/address.');

  const { PrivateKey, P2PKH, fromUtxo, Transaction, Script, SatoshisPerKilobyte } = require('@bsv/sdk');
  const priv = PrivateKey.fromHex(keyHex);
  const unlock = new P2PKH().unlock(priv);
  const recipientScriptHex = options.recipientScriptHex || p2pkhFromPubkey(recipientIdentityKey);

  const rawUtxos = await fetchApi(`${WOC_API_BASE}/address/${addr}/unspent`);
  const baseUtxos = (Array.isArray(rawUtxos) ? rawUtxos : [])
    .map(u => ({
      txid: u.tx_hash || u.tx_hash_big_endian || u.txid,
      vout: u.tx_pos ?? u.vout ?? u.tx_output_n,
      satoshis: Number(u.value ?? u.satoshis ?? 0)
    }))
    .filter(u => typeof u.txid === 'string' && Number.isInteger(u.vout) && u.satoshis > 0 &&
      !state.p2pkhSpentUtxos.has(`${u.txid}:${u.vout}`))
    .sort((a, b) => b.satoshis - a.satoshis);

  if (baseUtxos.length === 0) throw new Error('No spendable UTXOs found for faucet address.');

  async function loadUtxoScript(u) {
    const txhexResp = await fetchApi(`${WOC_API_BASE}/tx/${u.txid}/hex`);
    const txhex = typeof txhexResp === 'string' ? txhexResp : (txhexResp?.hex || txhexResp?.txhex || String(txhexResp));
    const sourceTx = Transaction.fromHex(txhex);
    const out = sourceTx.outputs?.[u.vout];
    if (!out || !out.lockingScript) throw new Error(`Missing source output for ${u.txid}:${u.vout}`);
    return { ...u, satoshis: Number(out.satoshis || u.satoshis || 0), script: out.lockingScript.toHex() };
  }

  const tx = new Transaction();
  let inputTotal = 0;
  const selectedUtxos = [];
  const targetFloor = satoshis + Math.max(1, DIRECT_SEND_FEE_BUFFER);

  for (const base of baseUtxos) {
    const u = await loadUtxoScript(base);
    tx.addInput(fromUtxo({ txid: u.txid, vout: u.vout, satoshis: u.satoshis, script: u.script }, unlock));
    inputTotal += u.satoshis;
    selectedUtxos.push(u);
    if (inputTotal >= targetFloor) break;
  }

  if (inputTotal < targetFloor) throw new Error(`Insufficient UTXO total: need at least ${targetFloor}, found ${inputTotal}.`);

  tx.addOutput({ satoshis, lockingScript: Script.fromHex(recipientScriptHex) });
  tx.addP2PKHOutput(addr);
  await tx.fee(new SatoshisPerKilobyte(1000));
  await tx.sign();

  const txhex = tx.toHex();
  const br = await fetchApi(`${WOC_API_BASE}/tx/raw`, { method: 'POST', body: JSON.stringify({ txhex }) });
  const txid = br.txid || br || null;
  if (!txid || typeof txid !== 'string') throw new Error(`Broadcast response missing txid: ${JSON.stringify(br).slice(0, 240)}`);

  for (const u of selectedUtxos) {
    state.p2pkhSpentUtxos.add(`${u.txid}:${u.vout}`);
  }

  console.log(`[FAUCET] Direct P2PKH fallback broadcast txid=${txid.substring(0, 16)}... inputs=${selectedUtxos.length} totalIn=${inputTotal}`);
  return { txid, status: 'sent', transaction: null, txhex };
}

// --- Settle pending claims ---

async function settlePendingClaims(maxClaims = 50) {
  if (!state.walletReady || !state.faucetWallet) return { processed: 0, sent: 0, failed: 0, remaining: 0 };
  if (state.settlingPendingClaims) return { processed: 0, sent: 0, failed: 0, remaining: getPendingClaimEntries().length };

  state.settlingPendingClaims = true;
  try {
    const available = await getWalletBalance();
    if (available < MIN_DRIP_SPENDABLE) return { processed: 0, sent: 0, failed: 0, remaining: getPendingClaimEntries().length };

    const pending = getPendingClaimEntries();
    if (pending.length === 0) return { processed: 0, sent: 0, failed: 0, remaining: 0 };

    let processed = 0, sent = 0, failed = 0;
    for (const [identityKey, claim] of pending) {
      if (processed >= maxClaims) break;
      processed++;
      try {
        const { txid, status } = await sendDripToIdentityKey(identityKey, 'ClawSats pending faucet drip', 'faucet-pending-replay');
        claim.txid = txid;
        claim.status = status;
        claim.sentAt = new Date().toISOString();
        claim.lastError = null;
        sent++;
      } catch (err) {
        failed++;
        claim.status = 'wallet_error';
        claim.lastError = err && err.message ? err.message : String(err);
      }
    }
    saveClaims(db);
    return { processed, sent, failed, remaining: getPendingClaimEntries().length };
  } finally {
    state.settlingPendingClaims = false;
  }
}

// --- Express routes ---

function mountRoutes(app, { scholarshipRemittances }) {
  app.get('/api/faucet/status', async (req, res) => {
    const balance = await getWalletBalance();
    const funded = state.walletReady && balance >= MIN_DRIP_SPENDABLE;
    res.json({
      claimed: db.count, limit: MAX_CLAIMS, remaining: MAX_CLAIMS - db.count,
      dripAmount: DRIP_AMOUNT, chain: 'main', funded,
      walletReady: state.walletReady, walletBackend: state.walletBackend,
      walletBalance: balance, reserveForNextDrip: MIN_DRIP_SPENDABLE,
      pendingClaims: getPendingClaimEntries().length,
      pendingReplayEnabled: !FAUCET_DISABLE_PENDING_REPLAY,
      walletError: state.walletError || null
    });
  });

  app.post('/api/faucet/drip', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip, 'faucet-drip', RATE_LIMIT_DRIP_PER_MIN)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    const { identityKey } = req.body || {};
    if (!isValidIdentityKey(identityKey)) {
      return res.status(400).json({ error: 'Invalid identity key. Must be a compressed public key (66 hex chars starting with 02 or 03).' });
    }
    if (db.claims[identityKey]) {
      return res.status(409).json({ error: 'This identity key has already claimed a drip.', claimedAt: db.claims[identityKey].claimedAt });
    }
    if (db.count >= MAX_CLAIMS) {
      return res.status(410).json({ error: `Faucet exhausted — all ${MAX_CLAIMS} slots claimed.` });
    }
    try {
      let txid = null, status = 'pending_funding';
      if (state.walletReady && state.faucetWallet) {
        try {
          const send = await sendDripToIdentityKey(identityKey);
          txid = send.txid;
          status = send.status;
        } catch (walletErr) {
          console.error(`[FAUCET] Wallet send failed: ${walletErr.message}`);
          status = 'wallet_error';
        }
      }
      const claimId = crypto.randomBytes(16).toString('hex');
      db.claims[identityKey] = { claimId, claimedAt: new Date().toISOString(), amount: DRIP_AMOUNT, txid, status };
      db.count++;
      saveClaims(db);
      res.json({
        success: true, amount: DRIP_AMOUNT, claimId, txid: txid || claimId, status,
        message: txid ? `${DRIP_AMOUNT} mainnet sats sent! txid: ${txid}` : `Claim recorded! ${DRIP_AMOUNT} sats reserved.`,
        position: db.count, remaining: MAX_CLAIMS - db.count
      });
    } catch (err) {
      console.error('[FAUCET] Error:', err);
      res.status(500).json({ error: 'Faucet error — try again later.' });
    }
  });

  app.get('/api/healthz', async (req, res) => {
    const fBalance = await getFaucetBalance();
    const sBalance = state.dualWalletMode ? await getScholarshipBalance() : fBalance;
    res.json({
      status: 'ok', timestamp: new Date().toISOString(), uptimeSec: Math.round(process.uptime()),
      dualWalletMode: state.dualWalletMode, walletReady: state.walletReady, walletBackend: state.walletBackend,
      walletBalance: fBalance, scholarshipWalletReady: state.scholarshipWalletReady,
      scholarshipWalletBackend: state.scholarshipWalletBackend, scholarshipBalance: sBalance,
      pendingClaims: getPendingClaimEntries().length,
      pendingInternalizations: scholarshipRemittances ? scholarshipRemittances.pending.length : 0,
      knownDirectoryEntries: 0, faucetClaims: db.count
    });
  });

  app.get('/api/audit/spends', (req, res) => {
    const limit = parseInt(String(req.query.limit || '100'), 10);
    const rows = readSpendAudit(limit, SPEND_AUDIT_PATH);
    res.json({ count: rows.length, limit: Math.max(1, Math.min(1000, Number(limit) || 100)), spends: rows });
  });
}

module.exports = {
  db,
  loadClaims,
  saveClaims,
  getPendingClaimEntries,
  sendDripToIdentityKey,
  sendViaDirectP2PKHFallback,
  settlePendingClaims,
  mountRoutes,
  DRIP_AMOUNT,
  MAX_CLAIMS,
  MIN_DRIP_SPENDABLE,
  SPEND_AUDIT_PATH,
  FAUCET_DISABLE_PENDING_REPLAY
};
