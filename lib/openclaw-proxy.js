'use strict';

const { normalizePublicEndpoint, checkRateLimit } = require('./utils');

const RATE_LIMIT_OPENCLAW_PROXY_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_OPENCLAW_PROXY_PER_MIN || '30', 10));
const INDELIBLE_COMING_SOON_MSG = 'This feature is coming soon. The Indelible.One server APIs are ready; ClawSats wallet integration is pending.';

// --- JSON-RPC proxy to Claw endpoints ---

async function callOpenClawRpc(endpoint, apiKey, method, params = {}, timeoutMs = 20000) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Missing API key. Provide the OpenClaw admin API key.');
  }
  const payload = { jsonrpc: '2.0', id: Date.now(), method, params };
  const resp = await fetch(`${endpoint}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await resp.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!resp.ok) {
    const detail = body && body.error ? JSON.stringify(body.error) : text.slice(0, 240);
    throw new Error(`OpenClaw RPC HTTP ${resp.status}: ${detail}`);
  }
  if (body && body.error) {
    const msg = body.error.message || JSON.stringify(body.error);
    throw new Error(`OpenClaw RPC error: ${msg}`);
  }
  return body ? body.result : null;
}

async function fetchOpenClawJson(url, timeoutMs = 12000) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!resp.ok) throw new Error(`OpenClaw HTTP ${resp.status}: ${text.slice(0, 220)}`);
  return body;
}

// --- Express routes ---

function mountRoutes(app) {
  app.post('/api/openclaw/connect', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip, 'openclaw-connect', RATE_LIMIT_OPENCLAW_PROXY_PER_MIN)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    try {
      const endpoint = await normalizePublicEndpoint(req.body?.endpoint || '');
      const [health, discovery, courses] = await Promise.all([
        fetchOpenClawJson(`${endpoint}/health`, 12000),
        fetchOpenClawJson(`${endpoint}/discovery`, 12000),
        fetchOpenClawJson(`${endpoint}/courses`, 12000)
      ]);
      res.json({
        endpoint, health, discovery,
        courses: Array.isArray(courses?.courses) ? courses.courses : [],
        coursesSummary: { totalAvailable: courses?.totalAvailable || 0, completedByThisClaw: courses?.completedByThisClaw || 0 }
      });
    } catch (err) {
      res.status(400).json({ error: err && err.message ? err.message : String(err) });
    }
  });

  app.post('/api/openclaw/courses', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip, 'openclaw-courses', RATE_LIMIT_OPENCLAW_PROXY_PER_MIN)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    try {
      const endpoint = await normalizePublicEndpoint(req.body?.endpoint || '');
      const courses = await fetchOpenClawJson(`${endpoint}/courses`, 12000);
      res.json({ endpoint, ...courses });
    } catch (err) {
      res.status(400).json({ error: err && err.message ? err.message : String(err) });
    }
  });

  app.post('/api/openclaw/course', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip, 'openclaw-course', RATE_LIMIT_OPENCLAW_PROXY_PER_MIN)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    try {
      const endpoint = await normalizePublicEndpoint(req.body?.endpoint || '');
      const courseId = String(req.body?.courseId || '').trim();
      if (!courseId) return res.status(400).json({ error: 'Missing courseId' });
      const course = await fetchOpenClawJson(`${endpoint}/courses/${encodeURIComponent(courseId)}`, 12000);
      res.json({ endpoint, course });
    } catch (err) {
      res.status(400).json({ error: err && err.message ? err.message : String(err) });
    }
  });

  app.post('/api/openclaw/take-course', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip, 'openclaw-take-course', RATE_LIMIT_OPENCLAW_PROXY_PER_MIN)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    try {
      const endpoint = await normalizePublicEndpoint(req.body?.endpoint || '');
      const apiKey = String(req.body?.apiKey || '');
      const courseId = String(req.body?.courseId || '').trim();
      const answers = req.body?.answers;
      if (!courseId) return res.status(400).json({ error: 'Missing courseId' });
      if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an array of strings.' });
      const result = await callOpenClawRpc(endpoint, apiKey, 'takeCourse', { courseId, answers });
      res.json({ endpoint, result });
    } catch (err) {
      res.status(400).json({ error: err && err.message ? err.message : String(err) });
    }
  });

  app.post('/api/openclaw/hire', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip, 'openclaw-hire', RATE_LIMIT_OPENCLAW_PROXY_PER_MIN)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    try {
      const endpoint = await normalizePublicEndpoint(req.body?.endpoint || '');
      const apiKey = String(req.body?.apiKey || '');
      const targetEndpoint = await normalizePublicEndpoint(req.body?.targetEndpoint || '');
      const capability = String(req.body?.capability || '').trim();
      const params = req.body?.params && typeof req.body.params === 'object' ? req.body.params : {};
      const maxTotalSats = Number.isFinite(Number(req.body?.maxTotalSats))
        ? Math.max(0, parseInt(req.body.maxTotalSats, 10)) : undefined;
      if (!capability) return res.status(400).json({ error: 'Missing capability' });
      const result = await callOpenClawRpc(endpoint, apiKey, 'hireClaw', {
        endpoint: targetEndpoint, capability, params, maxTotalSats
      }, 30000);
      res.json({ endpoint, result });
    } catch (err) {
      res.status(400).json({ error: err && err.message ? err.message : String(err) });
    }
  });

  app.post('/api/openclaw/status', async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(ip, 'openclaw-status', RATE_LIMIT_OPENCLAW_PROXY_PER_MIN)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    try {
      const endpoint = await normalizePublicEndpoint(req.body?.endpoint || '');
      const status = await fetchOpenClawJson(`${endpoint}/api/status`, 25000);
      res.json({ endpoint, ...status });
    } catch (err) {
      res.status(400).json({ error: err && err.message ? err.message : String(err) });
    }
  });

  // Phase D stubs
  app.post('/api/openclaw/agents/cert/create', (_req, res) => { res.status(501).json({ error: INDELIBLE_COMING_SOON_MSG, service: 'agents' }); });
  app.post('/api/openclaw/agents/attest', (_req, res) => { res.status(501).json({ error: INDELIBLE_COMING_SOON_MSG, service: 'reputation' }); });
  app.post('/api/openclaw/agents/escrow/:action', (_req, res) => { res.status(501).json({ error: INDELIBLE_COMING_SOON_MSG, service: 'escrow' }); });
  app.post('/api/openclaw/agents/message/send', (_req, res) => { res.status(501).json({ error: INDELIBLE_COMING_SOON_MSG, service: 'messaging' }); });
  app.post('/api/openclaw/agents/oracle/attest', (_req, res) => { res.status(501).json({ error: INDELIBLE_COMING_SOON_MSG, service: 'oracle' }); });
  app.post('/api/openclaw/agents/oracle/register', (_req, res) => { res.status(501).json({ error: INDELIBLE_COMING_SOON_MSG, service: 'oracle' }); });
}

module.exports = {
  callOpenClawRpc,
  fetchOpenClawJson,
  mountRoutes
};
