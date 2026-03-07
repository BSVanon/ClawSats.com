'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { isValidIdentityKey, isBlockedHostname, isPublicIp, normalizePublicEndpoint, checkRateLimit } = require('./utils');

const DIRECTORY_PATH = path.join(__dirname, '..', 'claw-directory.json');
const SEED_PEERS_PATH = path.join(__dirname, '..', 'seed-peers.json');

const SCHOLARSHIP_INCLUDE_CLAIM_ONLY = String(process.env.SCHOLARSHIP_INCLUDE_CLAIM_ONLY || 'false').toLowerCase() === 'true';
const SCHOLARSHIP_ALLOW_LEGACY_P2PKH = String(process.env.SCHOLARSHIP_ALLOW_LEGACY_P2PKH || 'false').toLowerCase() === 'true';
const RATE_LIMIT_REGISTER_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_REGISTER_PER_MIN || '20', 10));
const SEED_CLAW_ENDPOINT = process.env.SEED_CLAW_ENDPOINT || '';

// --- Data persistence ---

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

function loadSeedPeers() {
  try {
    if (fs.existsSync(SEED_PEERS_PATH)) {
      return JSON.parse(fs.readFileSync(SEED_PEERS_PATH, 'utf8'));
    }
  } catch {}
  return [];
}

let directory = loadDirectory();

// --- Eligible Claws for scholarship distribution ---

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

function getEligibleClaws(claimsDb) {
  const eligible = [];
  const seen = new Set();
  let excludedMissingEndpoint = 0;
  let excludedPlaceholderEndpoint = 0;

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

  if (claimsDb && claimsDb.claims) {
    for (const [key] of Object.entries(claimsDb.claims)) {
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
  }

  return {
    eligible,
    excludedMissingEndpoint,
    excludedPlaceholderEndpoint,
    includeClaimOnly: SCHOLARSHIP_INCLUDE_CLAIM_ONLY,
    legacyP2PKHEnabled: SCHOLARSHIP_ALLOW_LEGACY_P2PKH
  };
}

// --- Express routes ---

function mountRoutes(app, { claimsDb }) {
  // GET /api/directory
  app.get('/api/directory', (req, res) => {
    const seedPeers = loadSeedPeers();
    const entries = [];

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

    for (const [key, claim] of Object.entries(claimsDb.claims)) {
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

    for (const [key, entry] of Object.entries(directory)) {
      if (!claimsDb.claims[key]) {
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

  // POST /api/directory/register
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

    const existingEntry = directory[identityKey] && typeof directory[identityKey] === 'object'
      ? directory[identityKey]
      : {};
    const nowIso = new Date().toISOString();
    const firstRegisteredAt = (typeof existingEntry.registeredAt === 'string' && existingEntry.registeredAt.length > 0)
      ? existingEntry.registeredAt
      : nowIso;

    directory[identityKey] = {
      endpoint: normalizedEndpoint,
      capabilities: Array.isArray(capabilities)
        ? capabilities.filter(c => typeof c === 'string' && c.length > 0 && c.length <= 64).slice(0, 20)
        : null,
      registeredAt: firstRegisteredAt,
      lastSeenAt: nowIso,
      ip
    };
    saveDirectory(directory);

    console.log(`[DIRECTORY] Registered: ${identityKey.substring(0, 24)}... -> ${endpoint}`);
    res.json({
      success: true,
      message: 'Claw registered in directory.',
      identityKey,
      endpoint: directory[identityKey].endpoint,
      registeredAt: directory[identityKey].registeredAt,
      lastSeenAt: directory[identityKey].lastSeenAt
    });
  });

  // GET /api/network/seed-peers
  app.get('/api/network/seed-peers', (req, res) => {
    const peers = loadSeedPeers();
    res.json({ peers, count: peers.length, message: 'Known running Claws. Use these to bootstrap your peer network.' });
  });

  // GET /api/network/dashboard — proxy from seed Claw
  app.get('/api/network/dashboard', async (req, res) => {
    if (!SEED_CLAW_ENDPOINT) {
      return res.json({
        message: 'No seed Claw configured yet. Set SEED_CLAW_ENDPOINT env var.',
        totalDonors: 0, totalSats: 0, totalClawsEducated: 0
      });
    }
    try {
      const resp = await fetch(`${SEED_CLAW_ENDPOINT}/scholarships/dashboard`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      res.json({
        message: 'Seed Claw unreachable. Dashboard will update when a Claw is online.',
        error: err.message,
        totalDonors: 0, totalSats: 0, totalClawsEducated: 0
      });
    }
  });
}

module.exports = {
  directory,
  loadDirectory,
  saveDirectory,
  loadSeedPeers,
  getEligibleClaws,
  mountRoutes
};
