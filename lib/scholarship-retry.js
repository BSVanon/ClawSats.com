'use strict';

const fs = require('fs');
const path = require('path');
const { fetchApi } = require('./utils');

const WOC_API_BASE = process.env.WOC_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main';
const SCHOLARSHIP_SUBMIT_TIMEOUT_MS = parseInt(process.env.SCHOLARSHIP_SUBMIT_TIMEOUT_MS || '10000', 10);
const SCHOLARSHIP_REMIT_RETRY_MS = parseInt(process.env.SCHOLARSHIP_REMIT_RETRY_MS || '60000', 10);
const SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS = parseInt(process.env.SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS || '12000', 10);
const SCHOLARSHIP_REMIT_PATH = path.join(__dirname, '..', 'scholarship-remittances.json');

// --- Persistence ---

function loadScholarshipRemittances() {
  try {
    if (fs.existsSync(SCHOLARSHIP_REMIT_PATH)) {
      const data = JSON.parse(fs.readFileSync(SCHOLARSHIP_REMIT_PATH, 'utf8'));
      if (data && Array.isArray(data.pending)) return { pending: data.pending };
    }
  } catch {}
  return { pending: [] };
}

function saveScholarshipRemittances(store) {
  fs.writeFileSync(SCHOLARSHIP_REMIT_PATH, JSON.stringify(store, null, 2));
}

const remittances = loadScholarshipRemittances();

function queueScholarshipRemittance(remit) {
  const key = `${remit.txid}:${remit.identityKey}:${remit.derivationPrefix}:${remit.derivationSuffix}`;
  const idx = remittances.pending.findIndex(r =>
    `${r.txid}:${r.identityKey}:${r.derivationPrefix}:${r.derivationSuffix}` === key
  );
  if (idx >= 0) {
    remittances.pending[idx] = { ...remittances.pending[idx], ...remit };
  } else {
    remittances.pending.push(remit);
  }
  saveScholarshipRemittances(remittances);
}

function removeScholarshipRemittance(remit) {
  const key = `${remit.txid}:${remit.identityKey}:${remit.derivationPrefix}:${remit.derivationSuffix}`;
  remittances.pending = remittances.pending.filter(r =>
    `${r.txid}:${r.identityKey}:${r.derivationPrefix}:${r.derivationSuffix}` !== key
  );
  saveScholarshipRemittances(remittances);
}

// --- Submit remittance to receiving Claw ---

async function submitScholarshipRemittance(remit) {
  const txPayload = (typeof remit.transaction === 'string' && remit.transaction.length >= 16)
    ? remit.transaction
    : (typeof remit.txhex === 'string' && remit.txhex.length >= 16)
      ? remit.txhex
      : null;
  if (!remit || !txPayload) {
    throw new Error('Missing remittance transaction payload (no AtomicBEEF or txhex).');
  }
  return fetchApi(`${remit.endpoint}/wallet/submit-payment`, {
    method: 'POST',
    signal: AbortSignal.timeout(Math.max(1000, SCHOLARSHIP_SUBMIT_TIMEOUT_MS)),
    body: JSON.stringify({
      protocol: '3241645161d8',
      senderIdentityKey: remit.senderIdentityKey,
      derivationPrefix: remit.derivationPrefix,
      derivationSuffix: remit.derivationSuffix,
      transaction: txPayload,
      amount: remit.satoshis,
      outputIndex: 0,
      note: remit.note
    })
  });
}

// --- WoC AtomicBEEF builders ---

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
  const mpath = [];
  mpath[0] = [
    { offset: proof.pos, hash: txid, txid: true },
    { offset: (proof.pos ^ 1), hash: siblings[0] }
  ];
  for (let h = 1; h < siblings.length; h++) {
    mpath[h] = [{ offset: ((proof.pos >> h) ^ 1), hash: siblings[h] }];
  }
  return new MerklePath(proof.block_height, mpath);
}

async function buildVerifiedAtomicRemittanceByTxid(txid, { retries = 2, delayMs = 3000 } = {}) {
  if (!txid || typeof txid !== 'string') throw new Error('Cannot rebuild remittance payload: missing txid.');
  const { Transaction, MerklePath, Beef, WhatsOnChain } = require('@bsv/sdk');
  const timeout = Math.max(1000, SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS);
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, delayMs));
    try {
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
      if (!ok) throw new Error(`AtomicBEEF verification failed for ${txid}.`);
      return Buffer.from(atomic).toString('base64');
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      if (attempt < retries && (msg.includes('404') || msg.includes('Not Found'))) {
        console.log(`[SCHOLARSHIP] WoC not ready for ${txid.substring(0, 16)}... retry ${attempt + 1}/${retries} in ${delayMs}ms`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// --- Repair + Replay ---

function isAtomicRemittanceError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('must be valid atomicbeef') || text.includes('must be valid with at least one transaction to internalize an output from');
}

async function repairScholarshipRemittance(remit, reason = 'unknown') {
  if (!remit || !remit.txid) throw new Error('Cannot repair remittance payload without txid.');
  try {
    const atomicBase64 = await buildVerifiedAtomicRemittanceByTxid(remit.txid);
    remit.transaction = atomicBase64;
    console.log(`[SCHOLARSHIP] Rebuilt AtomicBEEF remittance for ${remit.identityKey.substring(0, 16)}... txid=${(remit.txid || '').substring(0, 16)} reason=${reason}`);
  } catch (buildErr) {
    if (typeof remit.txhex === 'string' && remit.txhex.length >= 16) {
      remit.transaction = remit.txhex;
      const bmsg = buildErr && buildErr.message ? buildErr.message : String(buildErr);
      console.warn(`[SCHOLARSHIP] AtomicBEEF build failed (${bmsg}); using raw txhex fallback for ${remit.identityKey.substring(0, 16)}...`);
    } else {
      throw buildErr;
    }
  }
  remit.lastError = null;
  remit.nextAttemptAt = Date.now();
  remit.updatedAt = new Date().toISOString();
  queueScholarshipRemittance(remit);
}

let replaying = false;

async function replayScholarshipRemittances(maxToProcess = 25) {
  if (replaying) return { processed: 0, delivered: 0, failed: 0, remaining: remittances.pending.length };
  if (!remittances.pending.length) return { processed: 0, delivered: 0, failed: 0, remaining: 0 };

  replaying = true;
  try {
    let processed = 0, delivered = 0, failed = 0;
    const now = Date.now();

    for (const remit of [...remittances.pending]) {
      if (processed >= maxToProcess) break;
      if (remit.nextAttemptAt && Number(remit.nextAttemptAt) > now) continue;
      processed++;
      try {
        if (typeof remit.transaction !== 'string' || remit.transaction.length < 16) {
          await repairScholarshipRemittance(remit, 'missing_or_invalid_payload');
        }
        await submitScholarshipRemittance(remit);
        removeScholarshipRemittance(remit);
        delivered++;
        console.log(`[SCHOLARSHIP] Internalize delivered for ${remit.identityKey.substring(0, 16)}... txid=${(remit.txid || '').substring(0, 16)}`);
      } catch (err) {
        let message = err && err.message ? err.message : String(err);
        if (isAtomicRemittanceError(message) && remit.txid) {
          try {
            await repairScholarshipRemittance(remit, 'recipient_rejected_payload');
            await submitScholarshipRemittance(remit);
            removeScholarshipRemittance(remit);
            delivered++;
            console.log(`[SCHOLARSHIP] Internalize delivered after repair for ${remit.identityKey.substring(0, 16)}...`);
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
    return { processed, delivered, failed, remaining: remittances.pending.length };
  } finally {
    replaying = false;
  }
}

module.exports = {
  remittances,
  queueScholarshipRemittance,
  removeScholarshipRemittance,
  submitScholarshipRemittance,
  buildVerifiedAtomicRemittanceByTxid,
  buildMerklePathFromWocProof,
  repairScholarshipRemittance,
  replayScholarshipRemittances
};
