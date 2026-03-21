'use strict';

/**
 * Anvil Mesh Bridge — Protocol Ambassador
 *
 * Makes ClawSats discoverable on the Anvil gossip mesh without running a Claw.
 * The faucet server acts as the protocol ambassador:
 *   1. Publishes durable catalog entry (visible on every Anvil Explorer)
 *   2. Publishes the Claw directory as a clawsats:directory topic (hourly refresh)
 *   3. Publishes capability price list so AI agents can discover ClawSats services
 *
 * Signing uses the faucet's FAUCET_ROOT_KEY_HEX (WIF derived).
 * If Anvil is unreachable, faucet keeps working — all calls are fire-and-forget.
 */

const { PrivateKey } = require('@bsv/sdk');
const { AnvilClient } = require('anvil-mesh');

const TAG = 'ANVIL';

// --- Config ---

const ANVIL_NODE_URL = String(process.env.ANVIL_NODE_URL || '').trim();
const DIRECTORY_REFRESH_MS = 55 * 60 * 1000;  // 55 min (TTL is 60 min)
const DIRECTORY_TTL_SECS = 3600;               // 1 hour
const CATALOG_DESCRIPTION = 'BSV micropayment protocol for AI agents. HTTP 402 payments, signed receipts, peer discovery.';

// --- Standard ClawSats capability prices (frozen v1) ---

const CLAWSATS_CAPABILITIES = [
  { name: 'echo', price_sats: 10, description: 'Signed echo — proves 402 flow end-to-end' },
  { name: 'sign_message', price_sats: 5, description: 'Sign message with provider identity key' },
  { name: 'hash_commit', price_sats: 5, description: 'SHA-256 hash commitment with signature' },
  { name: 'timestamp_attest', price_sats: 5, description: 'Timestamp attestation with signature' },
  { name: 'fetch_url', price_sats: 15, description: 'Web proxy from provider vantage point' },
  { name: 'dns_resolve', price_sats: 3, description: 'DNS lookup from provider location' },
  { name: 'verify_receipt', price_sats: 3, description: 'Independent receipt signature verification' },
  { name: 'peer_health_check', price_sats: 5, description: 'Liveness + latency check on a peer' },
  { name: 'bsv_mentor', price_sats: 25, description: 'BSV protocol expert Q&A (premium)' },
  { name: 'broadcast_listing', price_sats: 50, description: 'Spread manifest to peers (viral discovery)' },
];

// --- State ---

let client = null;
let refreshTimer = null;

// --- Init ---

/**
 * Initialize the Anvil bridge. Call after wallet init (needs FAUCET_ROOT_KEY_HEX).
 * Returns true if bridge is active, false if disabled or failed.
 */
function init() {
  if (!ANVIL_NODE_URL) {
    console.log(`[${TAG}] ANVIL_NODE_URL not set — mesh bridge disabled.`);
    return false;
  }

  const rootKeyHex = process.env.FAUCET_ROOT_KEY_HEX || '';
  if (!rootKeyHex || rootKeyHex.length !== 64) {
    console.warn(`[${TAG}] FAUCET_ROOT_KEY_HEX unavailable — mesh bridge disabled.`);
    return false;
  }

  try {
    const pk = PrivateKey.fromHex(rootKeyHex);
    const wif = pk.toWif();

    client = new AnvilClient({
      wif,
      nodeUrl: ANVIL_NODE_URL,
      timeout: 15000,
    });

    console.log(`[${TAG}] Bridge initialized → ${ANVIL_NODE_URL}`);
    return true;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[${TAG}] Bridge init failed: ${msg}`);
    return false;
  }
}

// --- Catalog ---

async function publishCatalog() {
  if (!client) return;
  try {
    const result = await client.publishToCatalog({
      name: 'ClawSats',
      description: CATALOG_DESCRIPTION,
      version: '1.0.0',
      topics: ['clawsats:capabilities', 'clawsats:directory'],
      pricing: 'paid',
      url: 'https://clawsats.com',
      contact: 'https://x.com/ClawSats',
    });
    if (result.accepted) {
      console.log(`[${TAG}] Catalog entry published to mesh.`);
    } else {
      console.warn(`[${TAG}] Catalog rejected: ${result.error || 'unknown'}`);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[${TAG}] Catalog publish failed: ${msg}`);
  }
}

// --- Capability announcements ---

async function publishCapabilities() {
  if (!client) return;
  try {
    const result = await client.publish('clawsats:capabilities', {
      type: 'protocol_capabilities',
      protocol: 'clawsats://v1',
      protocol_fee_sats: 17,
      free_trial: true,
      capabilities: CLAWSATS_CAPABILITIES,
      capability_count: CLAWSATS_CAPABILITIES.length,
      directory_url: 'https://clawsats.com/api/directory',
      updated_at: Date.now(),
    }, { ttl: DIRECTORY_TTL_SECS });

    if (result.accepted) {
      console.log(`[${TAG}] Capabilities announced (${CLAWSATS_CAPABILITIES.length} capabilities).`);
    } else {
      console.warn(`[${TAG}] Capability announce rejected: ${result.error || 'unknown'}`);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[${TAG}] Capability announce failed: ${msg}`);
  }
}

// --- Directory publishing ---

/**
 * Publish current Claw directory to the mesh.
 * @param {Function} getDirectoryFn - Returns { eligible: [{identityKey, endpoint}], ... }
 */
async function publishDirectory(getDirectoryFn) {
  if (!client || typeof getDirectoryFn !== 'function') return;
  try {
    const dirData = getDirectoryFn();
    const claws = (dirData.eligible || []).map(c => ({
      identity_key: c.identityKey,
      endpoint: c.endpoint,
    }));

    if (claws.length === 0) {
      // Don't publish empty directory — nothing useful for mesh consumers
      return;
    }

    const result = await client.publish('clawsats:directory', {
      type: 'claw_directory',
      protocol: 'clawsats://v1',
      claws,
      claw_count: claws.length,
      source: 'https://clawsats.com',
      updated_at: Date.now(),
    }, { ttl: DIRECTORY_TTL_SECS });

    if (result.accepted) {
      console.log(`[${TAG}] Directory published (${claws.length} claws).`);
    } else {
      console.warn(`[${TAG}] Directory publish rejected: ${result.error || 'unknown'}`);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[${TAG}] Directory publish failed: ${msg}`);
  }
}

// --- Start / Stop ---

/**
 * Start the bridge: publish catalog + caps + directory, begin refresh loop.
 * @param {Function} getDirectoryFn - Returns eligible Claw list (called each refresh)
 */
async function start(getDirectoryFn) {
  if (!client) return;

  // Check node reachability
  try {
    const st = await client.status();
    console.log(`[${TAG}] Connected to Anvil node v${st.version} (headers: ${st.headers.height})`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[${TAG}] Anvil node unreachable — will retry on refresh: ${msg}`);
  }

  // Fire-and-forget: catalog + capabilities + directory
  publishCatalog().catch(() => {});
  publishCapabilities().catch(() => {});
  publishDirectory(getDirectoryFn).catch(() => {});

  // Periodic refresh
  refreshTimer = setInterval(() => {
    publishCapabilities().catch(() => {});
    publishDirectory(getDirectoryFn).catch(() => {});
  }, DIRECTORY_REFRESH_MS);
  refreshTimer.unref();

  console.log(`[${TAG}] Mesh bridge started (refresh every ${Math.round(DIRECTORY_REFRESH_MS / 60000)} min).`);
}

function stop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  console.log(`[${TAG}] Mesh bridge stopped.`);
}

/**
 * Get the AnvilClient instance (for status endpoints or advanced queries).
 * Returns null if bridge is disabled.
 */
function getClient() {
  return client;
}

module.exports = {
  init,
  start,
  stop,
  getClient,
  publishCatalog,
  publishCapabilities,
  publishDirectory,
};
