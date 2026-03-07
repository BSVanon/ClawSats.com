'use strict';

const fs = require('fs');
const path = require('path');
const { pubkeyToAddress, formatErr, isValidIdentityKey, fetchApi, getPkgVersion } = require('./utils');

const WOC_API_BASE = process.env.WOC_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main';
const WALLET_STORAGE_MODE = (process.env.FAUCET_WALLET_STORAGE || 'sqlite').toLowerCase();

// --- Shared wallet state (mutable, exported) ---
const state = {
  // Faucet
  faucetWallet: null,
  walletReady: false,
  walletError: null,
  walletBackend: 'none',
  faucetIdentityKey: '',
  faucetAddress: '',
  // Scholarship
  scholarshipWallet: null,
  scholarshipWalletReady: false,
  scholarshipWalletBackend: 'none',
  scholarshipIdentityKey: '',
  scholarshipAddress: '',
  dualWalletMode: false,
  // Demo
  demoWallet: null,
  demoWalletReady: false,
  demoWalletBackend: 'none',
  demoIdentityKey: '',
  demoAddress: '',
  // Mutex / flags
  settlingPendingClaims: false,
  replayingScholarshipRemittances: false,
  distributing: false,
  demoLock: Promise.resolve(),
  // Spent UTXOs tracker (prevents double-spend in distribution loops)
  p2pkhSpentUtxos: new Set()
};

// --- BRC-29 key derivation ---

async function deriveBRC29LockingScript(recipientIdentityKey, derivationPrefix, derivationSuffix, wallet) {
  const w = wallet || state.faucetWallet;
  if (!w || typeof w.getPublicKey !== 'function') {
    throw new Error('Wallet does not expose getPublicKey for BRC-29 derivation.');
  }
  const { p2pkhFromPubkey } = require('./utils');
  const key = await w.getPublicKey({
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

// --- Extract tx payload from createAction result ---

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

// --- Generic wallet balance (toolbox + WoC external P2PKH) ---

async function getWalletBalanceFor(wallet, address, label) {
  if (!wallet) return 0;
  let toolboxBalance = 0;
  let externalBalance = 0;

  try {
    const outputs = await wallet.listOutputs({ basket: 'default', include: 'locking scripts', limit: 1000 });
    if (outputs && outputs.outputs) {
      for (const out of outputs.outputs) {
        if (out.spendable !== false) toolboxBalance += (out.satoshis || 0);
      }
    } else if (outputs && Array.isArray(outputs)) {
      for (const out of outputs) {
        if (out.spendable !== false) toolboxBalance += (out.satoshis || 0);
      }
    }
  } catch (err) {
    console.warn(`[${label}] Toolbox listOutputs failed: ${err.message}`);
  }

  if (address) {
    try {
      const data = await fetchApi(`${WOC_API_BASE}/address/${address}/balance`);
      const confirmed = Number(data.confirmed || 0);
      const unconfirmed = Number(data.unconfirmed || 0);
      externalBalance = Math.max(0, confirmed + unconfirmed);
    } catch (err) {
      console.warn(`[${label}] WOC balance check failed: ${err.message}`);
    }
  }

  return toolboxBalance + externalBalance;
}

function getFaucetBalance() {
  if (!state.walletReady || !state.faucetWallet) return Promise.resolve(0);
  return getWalletBalanceFor(state.faucetWallet, state.faucetAddress, 'FAUCET');
}

function getScholarshipBalance() {
  if (!state.scholarshipWalletReady || !state.scholarshipWallet) return Promise.resolve(0);
  return getWalletBalanceFor(state.scholarshipWallet, state.scholarshipAddress, 'SCHOLARSHIP');
}

function getWalletBalance() {
  return getFaucetBalance();
}

// --- Init helpers ---

async function createWalletInstance(rootKeyHex, label, sqliteName) {
  const { Setup } = require('@bsv/wallet-toolbox');
  const { PrivateKey } = require('@bsv/sdk');

  const rootKey = PrivateKey.fromHex(rootKeyHex);
  const identityKey = rootKey.toPublicKey().toString();
  const address = pubkeyToAddress(identityKey);

  const dataDir = path.join(__dirname, '..', 'faucet-data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const env = {
    chain: 'main',
    identityKey,
    identityKey2: identityKey,
    filePath: undefined,
    taalApiKey: '',
    devKeys: { [identityKey]: rootKeyHex },
    mySQLConnection: '{}'
  };

  let wallet, backend;
  if (WALLET_STORAGE_MODE === 'sqlite') {
    try {
      const sw = await Setup.createWalletSQLite({
        env, rootKeyHex,
        filePath: path.join(dataDir, `${sqliteName}.sqlite`),
        databaseName: `clawsats-${sqliteName}`
      });
      wallet = sw.wallet;
      backend = 'sqlite';
    } catch (sqliteErr) {
      const msg = sqliteErr && sqliteErr.message ? sqliteErr.message : String(sqliteErr);
      console.warn(`[${label}] SQLite init failed (${msg}), falling back to memory.`);
      wallet = await Setup.createWalletClientNoEnv({ chain: 'main', rootKeyHex });
      backend = 'memory';
    }
  } else {
    wallet = await Setup.createWalletClientNoEnv({ chain: 'main', rootKeyHex });
    backend = 'memory';
  }

  return { wallet, backend, identityKey, address };
}

// --- Faucet wallet ---

async function initWallet() {
  const rootKeyHex = process.env.FAUCET_ROOT_KEY_HEX || '';
  if (!rootKeyHex || rootKeyHex.length !== 64) {
    state.walletError = 'FAUCET_ROOT_KEY_HEX not set or invalid (need 64 hex chars)';
    console.warn(`[FAUCET] ${state.walletError}`);
    console.warn('[FAUCET]    Faucet will record claims but cannot send sats until funded.');
    return;
  }
  try {
    console.log(`[FAUCET] Runtime: node=${process.version} sdk=${getPkgVersion('@bsv/sdk')} wallet-toolbox=${getPkgVersion('@bsv/wallet-toolbox')}`);
    const { wallet, backend, identityKey, address } = await createWalletInstance(rootKeyHex, 'FAUCET', 'faucet');
    state.faucetWallet = wallet;
    state.walletBackend = backend;
    state.faucetIdentityKey = identityKey;
    state.faucetAddress = address;
    state.walletReady = true;
    console.log(`[FAUCET] Wallet initialized (${backend}) for ${identityKey.substring(0, 24)}...`);
    console.log(`[FAUCET]    BSV Address: ${address}`);
  } catch (err) {
    state.walletError = err && err.message ? err.message : String(err);
    state.walletBackend = 'none';
    console.error(`[FAUCET] Wallet init failed: ${state.walletError}`);
    console.error(formatErr(err));
  }
}

// --- Scholarship wallet ---

function fallbackToFaucetWallet(reason) {
  state.dualWalletMode = false;
  state.scholarshipWallet = state.faucetWallet;
  state.scholarshipWalletReady = state.walletReady;
  state.scholarshipWalletBackend = state.walletBackend;
  state.scholarshipIdentityKey = state.faucetIdentityKey;
  state.scholarshipAddress = state.faucetAddress;
  console.log(`[SCHOLARSHIP] ${reason}`);
}

async function initScholarshipWallet() {
  const rootKeyHex = process.env.SCHOLARSHIP_ROOT_KEY_HEX || '';
  if (!rootKeyHex) {
    fallbackToFaucetWallet('Using shared faucet wallet (set SCHOLARSHIP_ROOT_KEY_HEX for independent wallet)');
    return;
  }
  if (rootKeyHex.length !== 64) {
    fallbackToFaucetWallet('SCHOLARSHIP_ROOT_KEY_HEX invalid (need 64 hex chars). Falling back to faucet wallet.');
    return;
  }
  try {
    const { wallet, backend, identityKey, address } = await createWalletInstance(rootKeyHex, 'SCHOLARSHIP', 'scholarship');
    state.scholarshipWallet = wallet;
    state.scholarshipWalletBackend = backend;
    state.scholarshipIdentityKey = identityKey;
    state.scholarshipAddress = address;
    state.scholarshipWalletReady = true;
    state.dualWalletMode = true;
    console.log(`[SCHOLARSHIP] Independent wallet initialized (${backend}) for ${identityKey.substring(0, 24)}...`);
    console.log(`[SCHOLARSHIP]    BSV Address: ${address}`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[SCHOLARSHIP] Wallet init failed: ${msg}`);
    console.error(formatErr(err));
    fallbackToFaucetWallet('Falling back to shared faucet wallet.');
  }
}

// --- Demo wallet ---

function fallbackDemoToFaucet(reason) {
  if (process.env.NODE_ENV === 'production') {
    console.warn(`[DEMO] ${reason}`);
    console.warn('[DEMO] Shared faucet fallback disabled in production. Set DEMO_ROOT_KEY_HEX for a dedicated demo wallet.');
    return;
  }
  state.demoWallet = state.faucetWallet;
  state.demoWalletReady = state.walletReady;
  state.demoWalletBackend = state.walletBackend + ' (shared)';
  state.demoIdentityKey = state.faucetIdentityKey;
  state.demoAddress = state.faucetAddress;
  console.log(`[DEMO] ${reason}`);
}

async function initDemoWallet() {
  const enabled = String(process.env.DEMO_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[DEMO] Demo feature disabled (DEMO_ENABLED=false).');
    return;
  }
  const rootKeyHex = process.env.DEMO_ROOT_KEY_HEX || '';
  if (!rootKeyHex) {
    fallbackDemoToFaucet('Using shared faucet wallet for demos (set DEMO_ROOT_KEY_HEX for dedicated wallet)');
    return;
  }
  if (rootKeyHex.length !== 64) {
    fallbackDemoToFaucet('DEMO_ROOT_KEY_HEX invalid (need 64 hex chars). Falling back to faucet wallet.');
    return;
  }
  try {
    const { wallet, backend, identityKey, address } = await createWalletInstance(rootKeyHex, 'DEMO', 'demo');
    state.demoWallet = wallet;
    state.demoWalletBackend = backend;
    state.demoIdentityKey = identityKey;
    state.demoAddress = address;
    state.demoWalletReady = true;
    console.log(`[DEMO] Demo wallet initialized (${backend}) for ${identityKey.substring(0, 24)}...`);
    console.log(`[DEMO]    BSV Address: ${address}`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[DEMO] Demo wallet init failed: ${msg}`);
    console.error(formatErr(err));
    fallbackDemoToFaucet('Falling back to shared faucet wallet for demos.');
  }
}

module.exports = {
  state,
  deriveBRC29LockingScript,
  extractActionTxBase64,
  getWalletBalanceFor,
  getFaucetBalance,
  getScholarshipBalance,
  getWalletBalance,
  initWallet,
  initScholarshipWallet,
  initDemoWallet
};
