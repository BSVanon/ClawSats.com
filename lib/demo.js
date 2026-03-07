'use strict';

const fs = require('fs');
const path = require('path');
const { fetchApi, isValidIdentityKey, checkRateLimit, writeSpendAudit } = require('./utils');
const { state, deriveBRC29LockingScript, extractActionTxBase64 } = require('./wallets');
const { buildMerklePathFromWocProof } = require('./scholarship-retry');

const WOC_API_BASE = process.env.WOC_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main';
const DEMO_CLAW_ENDPOINT = process.env.DEMO_CLAW_ENDPOINT || 'http://vmi3083711.contaboserver.net:3321';
const DEMO_CAPABILITY = process.env.DEMO_CAPABILITY || 'echo';
const DEMO_ENABLED = String(process.env.DEMO_ENABLED || 'true').toLowerCase() !== 'false';
const DEMO_DAILY_CAP_SATS = Math.max(0, parseInt(process.env.DEMO_DAILY_CAP_SATS || '500', 10));
const DEMO_TOTAL_CAP_SATS = Math.max(0, parseInt(process.env.DEMO_TOTAL_CAP_SATS || '10000', 10));
const RATE_LIMIT_DEMO_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_DEMO_PER_MIN || '3', 10));
const DEMO_BUDGET_PATH = path.join(__dirname, '..', 'demo-budget.json');
const SPEND_AUDIT_PATH = process.env.SPEND_AUDIT_PATH || path.join(__dirname, '..', 'spend-audit.jsonl');

const FEE_IDENTITY_KEY = '0307102dc99293edba7f75bf881712652879c151b454ebf5d8e7a0ba07c4d17364';
const PROVIDER_DERIVATION_SUFFIX = 'clawsats';
const FEE_DERIVATION_SUFFIX = 'fee';

// --- Budget ledger ---

function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadDemoBudget() {
  try {
    if (fs.existsSync(DEMO_BUDGET_PATH)) {
      return JSON.parse(fs.readFileSync(DEMO_BUDGET_PATH, 'utf8'));
    }
  } catch {}
  return { totalSpent: 0, dailySpent: 0, dailyResetDate: todayDateStr(), demos: [] };
}

function saveDemoBudget(budget) {
  try {
    fs.writeFileSync(DEMO_BUDGET_PATH, JSON.stringify(budget, null, 2));
  } catch (err) {
    console.warn(`[DEMO] Failed to save demo budget: ${err && err.message ? err.message : String(err)}`);
  }
}

function resetDailyIfNeeded(budget) {
  const today = todayDateStr();
  if (budget.dailyResetDate !== today) {
    budget.dailySpent = 0;
    budget.dailyResetDate = today;
  }
}

const demoBudget = loadDemoBudget();
let demoLock = Promise.resolve();

// --- Raw P2PKH payment builder ---

async function buildDemoPaymentRaw(providerScript, feeScript, satoshisRequired, feeSatsRequired) {
  const { PrivateKey, P2PKH, fromUtxo, Transaction, Script, SatoshisPerKilobyte, MerklePath } = require('@bsv/sdk');
  const keyHex = process.env.DEMO_ROOT_KEY_HEX;
  const addr = state.demoAddress;
  if (!keyHex || !addr) throw new Error('Raw P2PKH fallback unavailable: missing demo key/address.');

  const priv = PrivateKey.fromHex(keyHex);
  const unlock = new P2PKH().unlock(priv);

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

  if (baseUtxos.length === 0) throw new Error('No spendable UTXOs found for demo address.');

  const totalNeeded = satoshisRequired + feeSatsRequired + 10;
  const tx = new Transaction();
  let inputTotal = 0;
  const selectedUtxos = [];

  for (const base of baseUtxos) {
    const [txhexRaw, proof] = await Promise.all([
      fetchApi(`${WOC_API_BASE}/tx/${base.txid}/hex`),
      fetchApi(`${WOC_API_BASE}/tx/${base.txid}/merkleproof`).catch(() => null)
    ]);
    const txhex = typeof txhexRaw === 'string'
      ? txhexRaw : (txhexRaw?.hex || txhexRaw?.txhex || String(txhexRaw));
    const sourceTx = Transaction.fromHex(txhex);
    if (proof) {
      sourceTx.merklePath = buildMerklePathFromWocProof(base.txid, proof, MerklePath);
    }
    const out = sourceTx.outputs?.[base.vout];
    if (!out || !out.lockingScript) continue;

    const sats = Number(out.satoshis || base.satoshis || 0);
    const input = fromUtxo({
      txid: base.txid, vout: base.vout, satoshis: sats,
      script: out.lockingScript.toHex()
    }, unlock);
    input.sourceTransaction = sourceTx;

    tx.addInput(input);
    inputTotal += sats;
    selectedUtxos.push(base);
    if (inputTotal >= totalNeeded) break;
  }

  if (inputTotal < totalNeeded) throw new Error(`Insufficient UTXO total: need ${totalNeeded}, found ${inputTotal}.`);

  tx.addOutput({ satoshis: satoshisRequired, lockingScript: Script.fromHex(providerScript) });
  tx.addOutput({ satoshis: feeSatsRequired, lockingScript: Script.fromHex(feeScript) });
  tx.addP2PKHOutput(addr);

  await tx.fee(new SatoshisPerKilobyte(1000));
  await tx.sign();

  const atomic = tx.toAtomicBEEF(true);
  const txBase64 = Buffer.from(atomic).toString('base64');
  const txid = tx.id('hex');

  for (const u of selectedUtxos) {
    state.p2pkhSpentUtxos.add(`${u.txid}:${u.vout}`);
  }

  console.log(`[DEMO] Raw P2PKH payment: txid=${txid.substring(0, 16)}... inputs=${selectedUtxos.length} inputTotal=${inputTotal} sats`);
  return { txBase64, txid };
}

// --- Full 402 demo flow ---

async function executeDemoFlow() {
  const steps = { challenge: 'pending', parse: 'pending', pay: 'pending', execute: 'pending', receipt: 'pending' };
  const demoParams = DEMO_CAPABILITY === 'echo' ? { message: 'Hello from ClawSats!' } : {};

  // Step 1: Challenge
  steps.challenge = 'in_progress';
  let challengeRes;
  try {
    challengeRes = await fetch(`${DEMO_CLAW_ENDPOINT}/call/${DEMO_CAPABILITY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bsv-identity-key': state.demoIdentityKey },
      body: JSON.stringify(demoParams),
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    steps.challenge = 'error';
    throw Object.assign(new Error(`Challenge failed: ${err.message || err}`), { steps });
  }

  if (challengeRes.status !== 402) {
    if (challengeRes.ok) {
      steps.challenge = 'ok'; steps.parse = 'skipped'; steps.pay = 'skipped';
      steps.execute = 'ok'; steps.receipt = 'ok';
      const body = await challengeRes.json().catch(() => ({}));
      return {
        success: true, steps, freeTrial: true,
        result: body.result || body,
        cost: { capability: 0, fee: 0, total: 0 },
        receipt: body.receipt || null, proof: null
      };
    }
    steps.challenge = 'error';
    const errText = await challengeRes.text().catch(() => '');
    throw Object.assign(new Error(`Expected 402, got ${challengeRes.status}: ${errText.slice(0, 200)}`), { steps });
  }
  steps.challenge = 'ok';

  // Step 2: Parse headers
  steps.parse = 'in_progress';
  const satoshisRequired = parseInt(challengeRes.headers.get('x-bsv-payment-satoshis-required') || '0', 10);
  const derivationPrefix = challengeRes.headers.get('x-bsv-payment-derivation-prefix') || '';
  const providerIdentityKey = challengeRes.headers.get('x-bsv-identity-key') || '';
  const feeKey = challengeRes.headers.get('x-clawsats-fee-identity-key') || '';
  const feeSatsRequired = parseInt(challengeRes.headers.get('x-clawsats-fee-satoshis-required') || '17', 10);

  if (!derivationPrefix || !providerIdentityKey || satoshisRequired <= 0) {
    steps.parse = 'error';
    throw Object.assign(new Error('Invalid 402 challenge headers.'), { steps });
  }
  if (feeKey && feeKey !== FEE_IDENTITY_KEY) {
    steps.parse = 'error';
    throw Object.assign(new Error('Fee identity key mismatch.'), { steps });
  }
  steps.parse = 'ok';

  // Step 3: Build payment
  steps.pay = 'in_progress';
  let txBase64, txid;
  try {
    const providerScript = await deriveBRC29LockingScript(
      providerIdentityKey, derivationPrefix, PROVIDER_DERIVATION_SUFFIX, state.demoWallet
    );
    const feeScript = await deriveBRC29LockingScript(
      FEE_IDENTITY_KEY, derivationPrefix, FEE_DERIVATION_SUFFIX, state.demoWallet
    );

    let usedFallback = false;
    try {
      const actionResult = await state.demoWallet.createAction({
        description: `ClawSats demo: ${DEMO_CAPABILITY} (${satoshisRequired} + ${feeSatsRequired} sats)`,
        outputs: [
          { satoshis: satoshisRequired, lockingScript: providerScript, outputDescription: 'Demo capability payment', tags: ['clawsats-demo'], basket: 'clawsats-demo' },
          { satoshis: feeSatsRequired, lockingScript: feeScript, outputDescription: 'ClawSats protocol fee', tags: ['clawsats-demo-fee'], basket: 'clawsats-demo' }
        ],
        labels: ['clawsats-demo'],
        options: { signAndProcess: true, acceptDelayedBroadcast: false, randomizeOutputs: false }
      });
      txBase64 = extractActionTxBase64(actionResult);
      txid = actionResult.txid || null;
    } catch (walletErr) {
      if (!/insufficient funds/i.test(walletErr.message || '')) throw walletErr;
      console.log('[DEMO] createAction failed (no internal UTXOs), falling back to raw P2PKH tx...');
      const result = await buildDemoPaymentRaw(providerScript, feeScript, satoshisRequired, feeSatsRequired);
      txBase64 = result.txBase64;
      txid = result.txid;
      usedFallback = true;
    }
    if (usedFallback) console.log(`[DEMO] Raw P2PKH payment built: txid=${(txid || '').substring(0, 16)}...`);
  } catch (err) {
    steps.pay = 'error';
    throw Object.assign(new Error(`Payment failed: ${err.message || err}`), { steps });
  }
  steps.pay = 'ok';

  // Step 4: Execute with payment
  steps.execute = 'in_progress';
  let executeBody;
  try {
    const paymentHeader = JSON.stringify({
      derivationPrefix, derivationSuffix: PROVIDER_DERIVATION_SUFFIX, transaction: txBase64
    });
    const executeRes = await fetch(`${DEMO_CLAW_ENDPOINT}/call/${DEMO_CAPABILITY}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bsv-identity-key': state.demoIdentityKey,
        'x-bsv-payment': paymentHeader
      },
      body: JSON.stringify(demoParams),
      signal: AbortSignal.timeout(20000)
    });
    executeBody = await executeRes.json().catch(() => ({}));
    if (!executeRes.ok) {
      steps.execute = 'error';
      throw Object.assign(new Error(`Execution rejected: ${executeBody.error || executeBody.message || `HTTP ${executeRes.status}`}`), { steps });
    }
  } catch (err) {
    if (steps.execute !== 'error') steps.execute = 'error';
    throw Object.assign(new Error(err.message), { steps: err.steps || steps });
  }
  steps.execute = 'ok';

  // Step 5: Verify receipt
  if (!executeBody.receipt) {
    steps.receipt = 'error';
    throw Object.assign(new Error('Capability executed but no receipt returned.'), { steps });
  }
  steps.receipt = 'ok';

  const totalCost = satoshisRequired + feeSatsRequired;
  return {
    success: true, steps, freeTrial: false,
    result: executeBody.result || executeBody,
    cost: { capability: satoshisRequired, fee: feeSatsRequired, total: totalCost },
    receipt: executeBody.receipt || null,
    proof: txid ? { txid, whatsonchain: `https://whatsonchain.com/tx/${txid}` } : null
  };
}

// --- Express routes ---

function mountRoutes(app) {
  app.post('/api/demo/try', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    if (!DEMO_ENABLED) return res.status(503).json({ error: 'Demo feature is currently disabled.' });
    if (!state.demoWalletReady || !state.demoWallet) return res.status(503).json({ error: 'Demo wallet is not initialized.' });
    if (!checkRateLimit(ip, 'demo-try', RATE_LIMIT_DEMO_PER_MIN)) {
      return res.status(429).json({ error: 'Too many demo requests. Try again in a minute.' });
    }

    resetDailyIfNeeded(demoBudget);
    if (DEMO_DAILY_CAP_SATS > 0 && demoBudget.dailySpent >= DEMO_DAILY_CAP_SATS) {
      return res.status(429).json({ error: 'Daily demo budget exhausted. Try again tomorrow.' });
    }
    if (DEMO_TOTAL_CAP_SATS > 0 && demoBudget.totalSpent >= DEMO_TOTAL_CAP_SATS) {
      return res.status(429).json({ error: 'Total demo budget exhausted.' });
    }

    // Concurrency mutex
    let release;
    const prev = demoLock;
    demoLock = new Promise(resolve => { release = resolve; });
    await prev;

    const startMs = Date.now();
    try {
      const result = await executeDemoFlow();

      if (!result.freeTrial) {
        const totalSats = result.cost.total;
        demoBudget.totalSpent += totalSats;
        demoBudget.dailySpent += totalSats;
        demoBudget.demos.push({
          ts: new Date().toISOString(), ip: ip || 'unknown',
          sats: totalSats, txid: result.proof?.txid || null,
          durationMs: Date.now() - startMs
        });
        if (demoBudget.demos.length > 1000) demoBudget.demos = demoBudget.demos.slice(-1000);
        saveDemoBudget(demoBudget);

        writeSpendAudit({
          reason: 'demo-try', capability: DEMO_CAPABILITY,
          satoshis: totalSats, txid: result.proof?.txid || null,
          durationMs: Date.now() - startMs, walletBackend: state.demoWalletBackend
        }, { auditPath: SPEND_AUDIT_PATH, walletBackend: state.demoWalletBackend });
      }

      console.log(`[DEMO] Demo completed in ${Date.now() - startMs}ms — ${result.cost.total} sats`);
      res.json(result);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[DEMO] Demo failed: ${msg}`);
      writeSpendAudit({
        reason: 'demo-try-failed', capability: DEMO_CAPABILITY, error: msg,
        steps: err.steps || {}, durationMs: Date.now() - startMs,
        walletBackend: state.demoWalletBackend
      }, { auditPath: SPEND_AUDIT_PATH, walletBackend: state.demoWalletBackend });
      res.status(500).json({ success: false, error: msg, steps: err.steps || {}, cost: { capability: 0, fee: 0, total: 0 } });
    } finally {
      release();
    }
  });

  app.get('/api/demo/status', (req, res) => {
    resetDailyIfNeeded(demoBudget);
    const dailyRemaining = DEMO_DAILY_CAP_SATS > 0 ? Math.max(0, DEMO_DAILY_CAP_SATS - demoBudget.dailySpent) : null;
    const totalRemaining = DEMO_TOTAL_CAP_SATS > 0 ? Math.max(0, DEMO_TOTAL_CAP_SATS - demoBudget.totalSpent) : null;
    const todayStr = todayDateStr();
    res.json({
      enabled: DEMO_ENABLED && state.demoWalletReady,
      capability: DEMO_CAPABILITY, clawEndpoint: DEMO_CLAW_ENDPOINT,
      dailyCapSats: DEMO_DAILY_CAP_SATS, totalCapSats: DEMO_TOTAL_CAP_SATS,
      dailySpent: demoBudget.dailySpent, totalSpent: demoBudget.totalSpent,
      dailyRemaining, totalRemaining,
      demosToday: demoBudget.demos.filter(d => d.ts && d.ts.startsWith(todayStr)).length,
      totalDemos: demoBudget.demos.length,
      demoWallet: {
        ready: state.demoWalletReady, backend: state.demoWalletBackend,
        address: state.demoAddress || null,
        dedicated: !!process.env.DEMO_ROOT_KEY_HEX
      }
    });
  });
}

module.exports = {
  demoBudget,
  buildDemoPaymentRaw,
  executeDemoFlow,
  mountRoutes,
  DEMO_ENABLED
};
