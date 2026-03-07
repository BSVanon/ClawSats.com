'use strict';

const fs = require('fs');
const path = require('path');
const { fetchApi, isValidIdentityKey, randomHex, safeTokenEqual, getBearerToken, writeSpendAudit, checkRateLimit } = require('./utils');
const { state, deriveBRC29LockingScript, extractActionTxBase64, getWalletBalance, getScholarshipBalance } = require('./wallets');
const { getEligibleClaws } = require('./directory');
const { queueScholarshipRemittance, submitScholarshipRemittance, buildVerifiedAtomicRemittanceByTxid } = require('./scholarship-retry');

const WOC_API_BASE = process.env.WOC_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main';
const SCHOLARSHIP_TX_FEE_RESERVE = parseInt(process.env.SCHOLARSHIP_TX_FEE_RESERVE || '1000', 10);
const SCHOLARSHIP_SUBMIT_TIMEOUT_MS = parseInt(process.env.SCHOLARSHIP_SUBMIT_TIMEOUT_MS || '10000', 10);
const SCHOLARSHIP_REMIT_RETRY_MS = parseInt(process.env.SCHOLARSHIP_REMIT_RETRY_MS || '60000', 10);
const SCHOLARSHIP_DISTRIBUTE_TOKEN = String(process.env.SCHOLARSHIP_DISTRIBUTE_TOKEN || '');
const FAUCET_MIN_RESERVE_SATS = parseInt(process.env.FAUCET_MIN_RESERVE_SATS || '50000', 10);
const FAUCET_RESERVE_SLOTS = Number.isFinite(Number(process.env.FAUCET_RESERVE_SLOTS))
  ? Math.max(0, parseInt(process.env.FAUCET_RESERVE_SLOTS, 10))
  : null;
const MIN_DRIP_SPENDABLE = parseInt(process.env.MIN_DRIP_SPENDABLE || '250', 10);
const RATE_LIMIT_DISTRIBUTE_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_DISTRIBUTE_PER_MIN || '8', 10));
const SPEND_AUDIT_PATH = process.env.SPEND_AUDIT_PATH || path.join(__dirname, '..', 'spend-audit.jsonl');

// --- Scholarship fund ledger ---

const FUND_PATH = path.join(__dirname, '..', 'scholarship-fund.json');

function loadFund() {
  try {
    if (fs.existsSync(FUND_PATH)) {
      return JSON.parse(fs.readFileSync(FUND_PATH, 'utf8'));
    }
  } catch {}
  return { allocated: 0, totalDistributed: 0, distributions: [], lastBalanceCheck: 0, lastKnownBalance: 0 };
}

function saveFund(f) {
  fs.writeFileSync(FUND_PATH, JSON.stringify(f, null, 2));
}

const fund = loadFund();
if (fund.allocated == null) fund.allocated = 0;

// --- Auth ---

function hasScholarshipDistributeAuth(req) {
  if (!SCHOLARSHIP_DISTRIBUTE_TOKEN) return false;
  const headerToken = String(req.get('x-clawsats-admin-token') || '').trim();
  const bearerToken = getBearerToken(req);
  return (
    safeTokenEqual(SCHOLARSHIP_DISTRIBUTE_TOKEN, headerToken) ||
    safeTokenEqual(SCHOLARSHIP_DISTRIBUTE_TOKEN, bearerToken)
  );
}

// --- Preflight + send ---

async function preflightScholarshipRecipient(identityKey, endpoint) {
  if (!endpoint) throw new Error('Missing endpoint for scholarship recipient.');
  const { normalizePublicEndpoint } = require('./utils');
  const safeEndpoint = await normalizePublicEndpoint(endpoint);
  const discovery = await fetchApi(`${safeEndpoint}/discovery`, {
    signal: AbortSignal.timeout(Math.max(1000, SCHOLARSHIP_SUBMIT_TIMEOUT_MS))
  });
  const discoveredKey = discovery && typeof discovery.identityKey === 'string'
    ? discovery.identityKey : null;
  if (!discoveredKey || !isValidIdentityKey(discoveredKey)) {
    throw new Error('Recipient discovery response missing valid identityKey.');
  }
  if (discoveredKey !== identityKey) {
    throw new Error(`Endpoint identity mismatch: expected ${identityKey.substring(0, 16)}..., got ${discoveredKey.substring(0, 16)}...`);
  }
  return safeEndpoint;
}

async function sendScholarshipToIdentityKey(identityKey, satoshis, endpoint) {
  const safeEndpoint = await preflightScholarshipRecipient(identityKey, endpoint);
  const derivationPrefix = randomHex(8);
  const derivationSuffix = randomHex(8);
  const schWallet = state.dualWalletMode ? state.scholarshipWallet : state.faucetWallet;
  const schRootKey = state.dualWalletMode
    ? process.env.SCHOLARSHIP_ROOT_KEY_HEX
    : process.env.FAUCET_ROOT_KEY_HEX;
  const schAddress = state.dualWalletMode ? state.scholarshipAddress : state.faucetAddress;
  const schBackend = state.dualWalletMode ? state.scholarshipWalletBackend : state.walletBackend;
  const schSenderKey = state.dualWalletMode ? state.scholarshipIdentityKey : state.faucetIdentityKey;

  const lockingScript = await deriveBRC29LockingScript(identityKey, derivationPrefix, derivationSuffix, schWallet);

  let txid = null, transaction = null, txhex = null;

  try {
    const result = await schWallet.createAction({
      description: `ClawSats scholarship: ${satoshis} sats to ${identityKey.substring(0, 16)}...`,
      outputs: [{
        satoshis, lockingScript,
        outputDescription: 'Scholarship distribution',
        tags: ['clawsats-scholarship']
      }],
      labels: ['clawsats-scholarship'],
      options: { acceptDelayedBroadcast: false, signAndProcess: true, randomizeOutputs: false }
    });
    txid = result.txid || null;
    transaction = extractActionTxBase64(result);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const isInsufficientFunds = (
      msg.toLowerCase().includes('insufficient funds') ||
      msg.toLowerCase().includes('needed') ||
      msg.toLowerCase().includes('no spendable') ||
      msg.toLowerCase().includes('not enough')
    );
    if (!isInsufficientFunds) throw err;

    console.warn(`[SCHOLARSHIP] createAction could not see spendable inputs (${schBackend} mode); trying direct legacy-input bridge with BRC-29 remittance.`);
    const { sendViaDirectP2PKHFallback } = require('./faucet-routes');
    const direct = await sendViaDirectP2PKHFallback(identityKey, satoshis, {
      recipientScriptHex: lockingScript,
      rootKeyHex: schRootKey,
      fromAddress: schAddress
    });
    txid = direct.txid || null;
    transaction = direct.transaction || null;
    txhex = direct.txhex || null;
    if (!txid) throw new Error('Direct legacy-input bridge did not return a txid.');
    if (!transaction) {
      try {
        transaction = await buildVerifiedAtomicRemittanceByTxid(txid);
      } catch (repairErr) {
        const rmsg = repairErr && repairErr.message ? repairErr.message : String(repairErr);
        if (txhex && txhex.length >= 16) {
          transaction = txhex;
          console.warn(`[SCHOLARSHIP] AtomicBEEF unavailable for ${identityKey.substring(0, 16)}... txid=${txid.substring(0, 16)}: ${rmsg}; using raw txhex fallback`);
        } else {
          console.warn(`[SCHOLARSHIP] Could not build immediate AtomicBEEF payload for ${identityKey.substring(0, 16)}... txid=${txid.substring(0, 16)}: ${rmsg}`);
        }
      }
    }
  }

  const remittance = {
    txid: txid || '', identityKey, endpoint: safeEndpoint, satoshis,
    senderIdentityKey: schSenderKey, derivationPrefix, derivationSuffix,
    transaction, txhex,
    note: `Scholarship payment ${satoshis} sats`,
    attempts: 0, lastError: null, nextAttemptAt: Date.now(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  try {
    const ack = await submitScholarshipRemittance(remittance);
    if (txid) {
      writeSpendAudit({
        reason: 'scholarship-distribution', identityKey, satoshis, txid,
        status: txid ? 'sent' : 'broadcast_pending',
        endpoint: safeEndpoint, internalizePending: false
      }, { auditPath: SPEND_AUDIT_PATH, walletBackend: state.walletBackend });
    }
    return { txid, status: txid ? 'sent' : 'broadcast_pending', remittance: ack || null, internalizePending: false };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    remittance.attempts = 1;
    remittance.lastError = msg;
    remittance.nextAttemptAt = Date.now() + SCHOLARSHIP_REMIT_RETRY_MS;
    remittance.updatedAt = new Date().toISOString();
    queueScholarshipRemittance(remittance);
    if (txid) {
      writeSpendAudit({
        reason: 'scholarship-distribution', identityKey, satoshis, txid,
        status: txid ? 'sent_pending_internalize' : 'broadcast_pending_internalize',
        endpoint: safeEndpoint, internalizePending: true
      }, { auditPath: SPEND_AUDIT_PATH, walletBackend: state.walletBackend });
    }
    console.warn(`[SCHOLARSHIP] Internalize submit failed for ${identityKey.substring(0, 16)}... queued for retry: ${msg}`);
    return { txid, status: txid ? 'sent_pending_internalize' : 'broadcast_pending_internalize', remittance: null, internalizePending: true };
  }
}

// --- Express routes ---

function mountRoutes(app, { claimsDb, scholarshipRemittances, getPendingClaimEntries }) {
  app.get('/api/scholarships/address', (req, res) => {
    const addr = state.scholarshipAddress || state.faucetAddress;
    const key = state.scholarshipIdentityKey || state.faucetIdentityKey;
    if (!addr) {
      return res.status(503).json({ error: 'Scholarship wallet not initialized. Address unavailable.' });
    }
    res.json({
      address: addr, identityKey: key, chain: 'main',
      dualWalletMode: state.dualWalletMode,
      message: `Send mainnet BSV to ${addr}. All funds go to the general scholarship fund for Claw education.`
    });
  });

  app.get('/api/scholarships/status', async (req, res) => {
    const scholarship = getEligibleClaws(claimsDb);
    let balance, scholarshipRemaining;

    if (state.dualWalletMode) {
      balance = await getScholarshipBalance();
      scholarshipRemaining = balance;
    } else {
      balance = await getWalletBalance();
      fund.lastKnownBalance = balance;
      fund.lastBalanceCheck = Date.now();
      const scholarshipBudget = Math.max(0, (fund.allocated || 0) - fund.totalDistributed);
      const pendingClaims = getPendingClaimEntries().length;
      const reserveSlots = FAUCET_RESERVE_SLOTS ?? pendingClaims;
      const reserveForFaucet = Math.max(FAUCET_MIN_RESERVE_SATS, reserveSlots * MIN_DRIP_SPENDABLE);
      const walletAvailable = Math.max(0, balance - reserveForFaucet);
      scholarshipRemaining = Math.min(scholarshipBudget, walletAvailable);
    }

    res.json({
      dualWalletMode: state.dualWalletMode,
      scholarshipAllocated: state.dualWalletMode ? balance : (fund.allocated || 0),
      scholarshipDistributed: fund.totalDistributed,
      scholarshipRemaining, walletBalance: balance,
      totalDistributed: fund.totalDistributed,
      totalDistributions: fund.distributions.length,
      pendingInternalizations: scholarshipRemittances.pending.length,
      eligibleClaws: scholarship.eligible.length,
      excludedMissingEndpoint: scholarship.excludedMissingEndpoint,
      excludedPlaceholderEndpoint: scholarship.excludedPlaceholderEndpoint,
      includeClaimOnly: scholarship.includeClaimOnly,
      legacyP2PKHEnabled: scholarship.legacyP2PKHEnabled,
      address: state.scholarshipAddress || state.faucetAddress || null,
      chain: 'main',
      recentDistributions: fund.distributions.slice(-10).reverse()
    });
  });

  app.post('/api/scholarships/allocate', (req, res) => {
    if (state.dualWalletMode) {
      return res.status(409).json({
        error: 'Dual-wallet mode active. Scholarship budget = scholarship wallet balance. Fund the scholarship address directly instead.',
        scholarshipAddress: state.scholarshipAddress, dualWalletMode: true
      });
    }
    if (!hasScholarshipDistributeAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const { add, set } = req.body || {};
    if (set != null) {
      const val = Math.max(0, Math.floor(Number(set)));
      if (!Number.isFinite(val)) return res.status(400).json({ error: 'Invalid set value.' });
      fund.allocated = val;
    } else if (add != null) {
      const val = Math.max(0, Math.floor(Number(add)));
      if (!Number.isFinite(val)) return res.status(400).json({ error: 'Invalid add value.' });
      fund.allocated = (fund.allocated || 0) + val;
    } else {
      return res.status(400).json({ error: 'Provide { "add": N } or { "set": N }.' });
    }
    saveFund(fund);
    const remaining = Math.max(0, fund.allocated - fund.totalDistributed);
    res.json({
      allocated: fund.allocated, totalDistributed: fund.totalDistributed, remaining,
      message: `Scholarship budget updated. ${remaining.toLocaleString()} sats available for distribution.`
    });
  });

  app.post('/api/scholarships/distribute', async (req, res) => {
    if (!hasScholarshipDistributeAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized scholarship distribution request.' });
    }
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip, 'scholarship-distribute', RATE_LIMIT_DISTRIBUTE_PER_MIN)) {
      return res.status(429).json({ error: 'Too many distribution requests. Try again in a minute.' });
    }
    const schReady = state.dualWalletMode ? state.scholarshipWalletReady : state.walletReady;
    const schWallet = state.dualWalletMode ? state.scholarshipWallet : state.faucetWallet;
    if (!schReady || !schWallet) {
      return res.status(503).json({ error: 'Scholarship wallet not ready. Cannot distribute.' });
    }
    if (state.distributing) {
      return res.status(409).json({ error: 'Distribution already in progress. Try again shortly.' });
    }
    state.distributing = true;

    try {
      const balance = state.dualWalletMode ? await getScholarshipBalance() : await getWalletBalance();
      const scholarship = getEligibleClaws(claimsDb);
      const eligible = scholarship.eligible;
      const txFeeReserveTotal = eligible.length * Math.max(1, SCHOLARSHIP_TX_FEE_RESERVE);
      const pendingClaims = getPendingClaimEntries().length;

      let budgetForOutputs, reserveForFaucet;
      if (state.dualWalletMode) {
        reserveForFaucet = 0;
        budgetForOutputs = Math.max(0, balance - txFeeReserveTotal);
      } else {
        const reserveSlots = FAUCET_RESERVE_SLOTS ?? pendingClaims;
        reserveForFaucet = Math.max(FAUCET_MIN_RESERVE_SATS, reserveSlots * MIN_DRIP_SPENDABLE);
        const walletBudget = balance - reserveForFaucet - txFeeReserveTotal;
        const scholarshipBudget = (fund.allocated || 0) - fund.totalDistributed;
        budgetForOutputs = Math.max(0, Math.min(walletBudget, scholarshipBudget));
      }

      if (eligible.length === 0) {
        const missing = scholarship.excludedMissingEndpoint + scholarship.excludedPlaceholderEndpoint;
        const reason = missing > 0
          ? 'No eligible Claws: register a real public endpoint first via POST /api/directory/register.'
          : 'No eligible Claws found yet.';
        return res.json({
          distributed: 0, message: reason, walletBalance: balance,
          dualWalletMode: state.dualWalletMode,
          excludedMissingEndpoint: scholarship.excludedMissingEndpoint,
          excludedPlaceholderEndpoint: scholarship.excludedPlaceholderEndpoint,
          reservedForFaucet: reserveForFaucet, pendingClaims
        });
      }

      if (budgetForOutputs < eligible.length) {
        return res.json({
          distributed: 0, walletBalance: balance, dualWalletMode: state.dualWalletMode,
          excludedMissingEndpoint: scholarship.excludedMissingEndpoint,
          excludedPlaceholderEndpoint: scholarship.excludedPlaceholderEndpoint,
          reservedForFaucet: reserveForFaucet, reservedForScholarshipFees: txFeeReserveTotal, pendingClaims,
          message: state.dualWalletMode
            ? 'Insufficient scholarship wallet balance after tx fee reserve.'
            : 'Insufficient balance after reserving faucet + tx fees.'
        });
      }

      const perClaw = Math.max(1, Math.floor(budgetForOutputs / eligible.length));
      const totalToDistribute = perClaw * eligible.length;

      // Shuffle for fairness (Fisher-Yates)
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
        try {
          const result = await sendScholarshipToIdentityKey(claw.identityKey, perClaw, claw.endpoint);
          if (result.internalizePending) internalizePending++;
          results.push({
            identityKey: claw.identityKey, endpoint: claw.endpoint, satoshis: perClaw,
            txid: result.txid, status: result.status, remittance: result.remittance || null,
            distributedAt: new Date().toISOString()
          });
          fund.distributions.push(results[results.length - 1]);
          distributed += perClaw;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          console.warn(`[SCHOLARSHIP] Send failed for ${claw.identityKey.substring(0, 16)}...: ${msg}`);
          errors.push({ identityKey: claw.identityKey, error: msg });
        }
      }

      fund.totalDistributed += distributed;
      saveFund(fund);

      console.log(`[SCHOLARSHIP] Distributed ${distributed} sats across ${results.length} Claws (${perClaw} each)`);
      if (errors.length > 0) {
        console.warn(`[SCHOLARSHIP] Distribution halted with ${errors.length} error(s).`);
      }

      res.json({
        distributed, perClaw, clawsReached: results.length, internalizePending,
        results, errors, walletBalance: balance - distributed,
        message: `${distributed} sats distributed to ${results.length} Claws (${perClaw} sats each).`
      });
    } finally {
      state.distributing = false;
    }
  });
}

module.exports = {
  fund,
  loadFund,
  saveFund,
  hasScholarshipDistributeAuth,
  preflightScholarshipRecipient,
  sendScholarshipToIdentityKey,
  mountRoutes,
  SCHOLARSHIP_DISTRIBUTE_TOKEN
};
