#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Transaction, MerklePath, Beef, WhatsOnChain } = require('@bsv/sdk');

const WOC_API_BASE = process.env.WOC_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main';
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.SCHOLARSHIP_REMIT_REPAIR_TIMEOUT_MS || '12000', 10));
const STORE_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), 'scholarship-remittances.json');

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

function buildMerklePathFromWocProof(txid, proof) {
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

  const branch = [];
  branch[0] = [
    { offset: proof.pos, hash: txid, txid: true },
    { offset: (proof.pos ^ 1), hash: siblings[0] }
  ];
  for (let h = 1; h < siblings.length; h++) {
    branch[h] = [{ offset: ((proof.pos >> h) ^ 1), hash: siblings[h] }];
  }
  return new MerklePath(proof.block_height, branch);
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

async function fetchText(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

async function buildVerifiedAtomicBase64(txid) {
  const [txhexRaw, proof] = await Promise.all([
    fetchText(`${WOC_API_BASE}/tx/${txid}/hex`),
    fetchJson(`${WOC_API_BASE}/tx/${txid}/merkleproof`)
  ]);
  const txhex = parseWocTxHex(txhexRaw);
  const tx = Transaction.fromHex(txhex);
  tx.merklePath = buildMerklePathFromWocProof(txid, proof);

  const atomic = tx.toAtomicBEEF(true);
  const beef = Beef.fromBinary(atomic);
  const ok = await beef.verify(new WhatsOnChain('main'), false);
  if (!ok) throw new Error(`AtomicBEEF verification failed for ${txid}`);
  return Buffer.from(atomic).toString('base64');
}

async function main() {
  if (!fs.existsSync(STORE_PATH)) {
    throw new Error(`Not found: ${STORE_PATH}`);
  }

  const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  if (!store || !Array.isArray(store.pending)) {
    throw new Error(`Invalid remittance store shape in ${STORE_PATH}`);
  }

  let updated = 0;
  let skipped = 0;
  for (const remit of store.pending) {
    if (!remit || !remit.txid) {
      skipped++;
      continue;
    }
    const atomic = await buildVerifiedAtomicBase64(remit.txid);
    remit.transaction = atomic;
    remit.lastError = null;
    remit.attempts = 0;
    remit.nextAttemptAt = 0;
    remit.updatedAt = new Date().toISOString();
    updated++;
  }

  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  console.log(`Updated ${updated} remittance payload(s), skipped ${skipped}.`);
  console.log(`Saved: ${STORE_PATH}`);
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
