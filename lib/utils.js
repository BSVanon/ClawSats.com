'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');

// --- HTTP fetch wrapper ---

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

// --- Crypto / Address helpers ---

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer) {
  let num = BigInt('0x' + buffer.toString('hex'));
  let encoded = '';
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    encoded = BASE58_ALPHABET[Number(remainder)] + encoded;
  }
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    encoded = '1' + encoded;
  }
  return encoded;
}

function p2pkhFromPubkey(pubkeyHex) {
  const pubkeyBuf = Buffer.from(pubkeyHex, 'hex');
  const sha = crypto.createHash('sha256').update(pubkeyBuf).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha).digest();
  return '76a914' + hash160.toString('hex') + '88ac';
}

function pubkeyToAddress(pubkeyHex) {
  const pubkeyBuf = Buffer.from(pubkeyHex, 'hex');
  const sha = crypto.createHash('sha256').update(pubkeyBuf).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha).digest();
  const versioned = Buffer.concat([Buffer.from([0x00]), hash160]);
  const checksum = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(versioned).digest()
  ).digest().slice(0, 4);
  return base58Encode(Buffer.concat([versioned, checksum]));
}

function randomHex(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

// --- Auth helpers ---

function safeTokenEqual(expected, received) {
  if (!expected || !received) return false;
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(received), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getBearerToken(req) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// --- Validation ---

function isValidIdentityKey(key) {
  if (typeof key !== 'string') return false;
  return /^(02|03)[0-9a-fA-F]{64}$/.test(key);
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

// --- IP / SSRF protection ---

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] >= 224) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
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

// --- Error formatting ---

function formatErr(err) {
  if (err && err.stack) return err.stack;
  if (err && err.message) return err.message;
  return String(err);
}

// --- Spend audit ---

function writeSpendAudit(entry, { auditPath, walletBackend } = {}) {
  const record = {
    ts: new Date().toISOString(),
    walletBackend: walletBackend || 'unknown',
    ...entry
  };
  try {
    if (auditPath) {
      fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[SPEND] Failed to write audit file: ${msg}`);
  }
  console.log(`[SPEND] ${JSON.stringify(record)}`);
}

function readSpendAudit(limit = 100, auditPath) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 100));
  try {
    if (!auditPath || !fs.existsSync(auditPath)) return [];
    const lines = fs.readFileSync(auditPath, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const slice = lines.slice(Math.max(0, lines.length - cap));
    return slice.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// --- Rate limiting ---

const rateLimits = new Map();

function checkRateLimit(ip, routeKey, limitMax, limitWindowMs = 60000) {
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

// --- Package version helper ---

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

module.exports = {
  fetchApi,
  p2pkhFromPubkey,
  pubkeyToAddress,
  randomHex,
  safeTokenEqual,
  getBearerToken,
  isValidIdentityKey,
  stripTrailingSlash,
  isBlockedHostname,
  isPublicIp,
  normalizePublicEndpoint,
  formatErr,
  writeSpendAudit,
  readSpendAudit,
  checkRateLimit,
  getPkgVersion
};
