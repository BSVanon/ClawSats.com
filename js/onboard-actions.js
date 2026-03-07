/**
 * onboard-actions.js — Interactive actions: brain approval, Phase D forms
 * (agents, escrow, messages, oracles), diagnostic export, health test,
 * hire, agent/star picker, session/thread viewers.
 */
(function () {
  'use strict';
  var CP = window.CP;
  var el = CP.el, fmt = CP.fmt, short = CP.short, pretty = CP.pretty,
      postJSON = CP.postJSON, writeOut = CP.writeOut, showToast = CP.showToast,
      copyable = CP.copyable;

  // ── Brain approval actions ─────────────────────────────────
  CP.handleBrainApproval = async function (jobId, action) {
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    if (!endpoint || !apiKey) { showToast('API key required for approvals'); return; }
    try {
      await postJSON('/api/openclaw/brain/' + action, { endpoint: endpoint, apiKey: apiKey, jobId: jobId });
      showToast(action === 'approve' ? 'Approved' : 'Rejected');
      CP.loadDashboard();
    } catch (err) {
      showToast('Failed: ' + err.message);
    }
  };

  // ── Agent picker ──────────────────────────────────────────
  CP.populateAgentPicker = function (d) {
    var picker = el('attestAgent');
    if (!picker || picker.tagName !== 'SELECT') return;
    var existing = picker.value;
    var agents = new Map();
    var roster = d.indelible && d.indelible.roster || [];
    roster.forEach(function (a) { if (a.pubkey) agents.set(a.pubkey, a.name || a.pubkey.substring(0, 16) + '...'); });
    var rep = d.indelible && d.indelible.reputation || {};
    Object.keys(rep).forEach(function (k) { if (!agents.has(k)) agents.set(k, k.substring(0, 16) + '...'); });
    picker.innerHTML = '<option value="">Select agent or type below...</option>';
    agents.forEach(function (label, key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label + ' (' + key.substring(0, 8) + '...)';
      picker.appendChild(opt);
    });
    if (existing && agents.has(existing)) picker.value = existing;
  };

  // ── Star picker interaction ────────────────────────────────
  CP.initStarPicker = function () {
    var container = el('starPicker');
    var hidden = el('attestRating');
    if (!container || !hidden) return;
    function setStars(n) {
      hidden.value = n;
      container.querySelectorAll('.mc-star').forEach(function (s) {
        s.classList.toggle('lit', parseInt(s.dataset.val) <= n);
      });
    }
    container.addEventListener('click', function (ev) {
      var star = ev.target.closest('.mc-star');
      if (star) setStars(parseInt(star.dataset.val));
    });
    container.addEventListener('mouseover', function (ev) {
      var star = ev.target.closest('.mc-star');
      if (!star) return;
      var hoverVal = parseInt(star.dataset.val);
      container.querySelectorAll('.mc-star').forEach(function (s) {
        s.classList.toggle('preview', parseInt(s.dataset.val) <= hoverVal);
      });
    });
    container.addEventListener('mouseleave', function () {
      container.querySelectorAll('.mc-star').forEach(function (s) { s.classList.remove('preview'); });
    });
  };

  // ── Attestation submission ─────────────────────────────────
  CP.submitAttestation = async function () {
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    var pickerVal = el('attestAgent').value;
    var customVal = el('attestAgentCustom') ? el('attestAgentCustom').value.trim() : '';
    var agentPubKey = pickerVal || customVal;
    var capability = el('attestCap').value.trim();
    var rating = parseInt(el('attestRating').value, 10);
    var notes = el('attestNotes') ? el('attestNotes').value.trim() : '';
    if (!endpoint || !apiKey || !agentPubKey || !capability || !rating) {
      writeOut('attestOut', 'All fields required (notes optional).');
      return;
    }
    writeOut('attestOut', 'Submitting...');
    try {
      var body = { endpoint: endpoint, apiKey: apiKey, agentPubKey: agentPubKey, capability: capability, rating: rating };
      if (notes) body.notes = notes;
      var data = await postJSON('/api/openclaw/agents/attest', body);
      writeOut('attestOut', data);
    } catch (err) {
      writeOut('attestOut', 'Failed: ' + err.message);
    }
  };

  // ── Agent registration ─────────────────────────────────────
  CP.submitCreateAgent = async function () {
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    var name = el('newAgentName').value.trim();
    var caps = el('newAgentCaps').value.trim();
    var agentEndpoint = el('newAgentEndpoint').value.trim();
    if (!endpoint || !apiKey || !name || !caps) {
      writeOut('createAgentOut', 'Name and capabilities are required.');
      return;
    }
    writeOut('createAgentOut', 'Registering...');
    try {
      var data = await postJSON('/api/openclaw/agents/cert/create', {
        endpoint: endpoint, apiKey: apiKey, name: name,
        capabilities: caps.split(',').map(function (c) { return c.trim(); }).filter(Boolean),
        agentEndpoint: agentEndpoint || undefined
      });
      writeOut('createAgentOut', data);
    } catch (err) {
      writeOut('createAgentOut', 'Failed: ' + err.message);
    }
  };

  // ── Escrow creation ────────────────────────────────────────
  CP.submitCreateEscrow = async function () {
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    var payeePubKey = el('escPayee').value.trim();
    var amount = parseInt(el('escAmount').value, 10);
    var description = el('escDesc').value.trim();
    var timeoutHours = parseInt(el('escTimeout').value, 10);
    if (!endpoint || !apiKey || !payeePubKey || !amount || amount < 1) {
      writeOut('createEscrowOut', 'Payee and amount are required.');
      return;
    }
    writeOut('createEscrowOut', 'Creating escrow...');
    try {
      var data = await postJSON('/api/openclaw/agents/escrow/create', {
        endpoint: endpoint, apiKey: apiKey, payeePubKey: payeePubKey, amount: amount,
        description: description || undefined, timeoutHours: timeoutHours || 24
      });
      writeOut('createEscrowOut', data);
    } catch (err) {
      writeOut('createEscrowOut', 'Failed: ' + err.message);
    }
  };

  // ── Send message ───────────────────────────────────────────
  CP.submitSendMessage = async function () {
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    var recipientPubKey = el('msgRecipient').value.trim();
    var actionType = el('msgAction').value;
    var payload = el('msgPayload').value.trim();
    if (!endpoint || !apiKey || !recipientPubKey || !payload) {
      writeOut('sendMsgOut', 'Recipient and message are required.');
      return;
    }
    writeOut('sendMsgOut', 'Sending...');
    try {
      var data = await postJSON('/api/openclaw/agents/message/send', {
        endpoint: endpoint, apiKey: apiKey, recipientPubKey: recipientPubKey,
        actionType: actionType, payload: payload
      });
      writeOut('sendMsgOut', data);
    } catch (err) {
      writeOut('sendMsgOut', 'Failed: ' + err.message);
    }
  };

  // ── Oracle attestation ─────────────────────────────────────
  CP.submitOracleAttest = async function () {
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    var dataType = el('oraDataType').value.trim();
    var value = el('oraValue').value.trim();
    var source = el('oraSource').value.trim();
    var confidence = parseFloat(el('oraConfidence').value);
    if (!endpoint || !apiKey || !dataType || !value) {
      writeOut('oracleAttestOut', 'Data type and value are required.');
      return;
    }
    writeOut('oracleAttestOut', 'Signing...');
    try {
      var data = await postJSON('/api/openclaw/agents/oracle/attest', {
        endpoint: endpoint, apiKey: apiKey, dataType: dataType, value: value,
        source: source || undefined, confidence: isNaN(confidence) ? undefined : confidence
      });
      writeOut('oracleAttestOut', data);
    } catch (err) {
      writeOut('oracleAttestOut', 'Failed: ' + err.message);
    }
  };

  // ── Oracle registration ────────────────────────────────────
  CP.submitOracleRegister = async function () {
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    var dataTypes = el('oraRegTypes').value.trim();
    var oracleEndpoint = el('oraRegEndpoint').value.trim();
    if (!endpoint || !apiKey || !dataTypes) {
      writeOut('oracleRegOut', 'Data types are required.');
      return;
    }
    writeOut('oracleRegOut', 'Registering...');
    try {
      var data = await postJSON('/api/openclaw/agents/oracle/register', {
        endpoint: endpoint, apiKey: apiKey,
        dataTypes: dataTypes.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
        oracleEndpoint: oracleEndpoint || undefined
      });
      writeOut('oracleRegOut', data);
    } catch (err) {
      writeOut('oracleRegOut', 'Failed: ' + err.message);
    }
  };

  // ── Escrow action handler ──────────────────────────────────
  async function escrowAction(escrowId, action) {
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    if (!endpoint || !apiKey) { showToast('Connect first'); return; }
    try {
      await postJSON('/api/openclaw/agents/escrow/' + action, {
        endpoint: endpoint, apiKey: apiKey, escrowId: escrowId
      });
      showToast(action + ' successful');
      CP.loadDashboard();
    } catch (err) {
      showToast('Failed: ' + err.message);
    }
  }
  window._escrowAction = escrowAction;

  // ── Message thread viewer ──────────────────────────────────
  function viewThread(channelIndex) {
    var ind = CP.statusData && CP.statusData.indelible;
    var channels = ind && ind.channels || [];
    var ch = channels[channelIndex];
    var card = el('msgThreadCard');
    if (!card || !ch) return;
    card.style.display = '';
    el('msgThreadTitle').textContent = 'Thread: ' + (ch.participants || []).map(function (p) { return p.substring(0, 12) + '...'; }).join(' \u2194 ');
    var lines = [];
    lines.push('Participants: ' + (ch.participants || []).join(', '));
    lines.push('Last action:  ' + (ch.lastAction || '-'));
    lines.push('Last active:  ' + (ch.lastTimestamp ? new Date(ch.lastTimestamp).toLocaleString() : '-'));
    if (ch.messages && ch.messages.length > 0) {
      lines.push('');
      lines.push('--- Messages ---');
      ch.messages.forEach(function (m) {
        lines.push('[' + (m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '?') + '] ' +
          (m.from ? m.from.substring(0, 12) + '...' : '?') + ': ' + (m.payload || m.content || ''));
      });
    } else {
      lines.push('');
      lines.push('Full message history coming soon.');
    }
    writeOut('msgThreadOut', lines.join('\n'));
  }
  window._viewThread = viewThread;

  // ── Session detail viewer ──────────────────────────────────
  function viewSession(sessionIndex) {
    var ind = CP.statusData && CP.statusData.indelible;
    var sessions = ind && ind.sessions;
    if (!sessions) return;
    var entries = Object.entries(sessions);
    var entry = entries[sessionIndex];
    if (!entry) return;
    var addr = entry[0], s = entry[1];
    var card = el('sessionDetailCard');
    if (!card) return;
    card.style.display = '';
    var lines = [];
    lines.push('Agent:         ' + addr);
    lines.push('Sessions:      ' + fmt(s.count || 0));
    lines.push('Messages:      ' + fmt(s.messageCount || 0));
    lines.push('Total bytes:   ' + fmt(s.bytes || 0));
    if (s.firstSeen) lines.push('First seen:    ' + new Date(s.firstSeen).toLocaleString());
    if (s.lastSeen) lines.push('Last seen:     ' + new Date(s.lastSeen).toLocaleString());
    if (s.topics) lines.push('Topics:        ' + (Array.isArray(s.topics) ? s.topics.join(', ') : s.topics));
    if (s.txids) lines.push('TXIDs:         ' + (Array.isArray(s.txids) ? s.txids.length + ' stored' : '-'));
    writeOut('sessionDetailOut', lines.join('\n'));
  }
  window._viewSession = viewSession;

  // ── Diagnostic export ──────────────────────────────────────
  CP.exportDiagnostics = function () {
    if (!CP.statusData) { showToast('Connect to a Claw first'); return; }
    var data = JSON.parse(JSON.stringify(CP.statusData));
    var redact = function (obj) {
      if (!obj || typeof obj !== 'object') return;
      for (var key of Object.keys(obj)) {
        var k = key.toLowerCase();
        if (k.includes('rootkey') || k.includes('apikey') || k.includes('secret') || k.includes('password') || k === 'rootkeyhex') {
          obj[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
          redact(obj[key]);
        }
      }
    };
    redact(data);
    var report = {
      exportedAt: new Date().toISOString(),
      endpoint: el('endpoint').value.trim(),
      clawsatsVersion: 'clawsats://v1',
      status: data
    };
    var blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'clawsats-diagnostic-' + new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Diagnostic report downloaded');
  };

  // ── Health test ────────────────────────────────────────────
  CP.testHealth = async function () {
    CP.save();
    var endpoint = el('endpoint').value.trim();
    if (!endpoint) { writeOut('diagHealth', 'Enter endpoint first.'); return; }
    writeOut('diagHealth', 'Testing...');
    try {
      var data = await postJSON('/api/openclaw/connect', { endpoint: endpoint });
      writeOut('diagHealth', data);
    } catch (err) {
      writeOut('diagHealth', 'Failed: ' + err.message);
    }
  };

  // ── Hire test ──────────────────────────────────────────────
  CP.applyCapabilityTemplate = function () {
    var templates = {
      dns_resolve: { hostname: 'clawsats.com', type: 'A' },
      fetch_url: { url: 'https://clawsats.com' },
      peer_health_check: { endpoint: 'http://vmi3083711.contaboserver.net:3321' },
      echo: { message: 'hello from mission control' }
    };
    el('capabilityParams').value = pretty(templates[el('capability').value] || {});
  };

  CP.hire = async function () {
    CP.save();
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    var targetEndpoint = el('targetEndpoint').value.trim();
    var capability = el('capability').value;
    if (!endpoint || !apiKey || !targetEndpoint || !capability) {
      writeOut('hireOut', 'All fields required.'); return;
    }
    var params;
    try { params = el('capabilityParams').value.trim() ? JSON.parse(el('capabilityParams').value) : {}; }
    catch (e) { writeOut('hireOut', 'Invalid JSON: ' + e.message); return; }
    var maxRaw = el('maxTotalSats').value.trim();
    writeOut('hireOut', 'Hiring...');
    try {
      var data = await postJSON('/api/openclaw/hire', {
        endpoint: endpoint, apiKey: apiKey, targetEndpoint: targetEndpoint,
        capability: capability, params: params,
        maxTotalSats: maxRaw ? Number(maxRaw) : undefined
      });
      writeOut('hireOut', data);
    } catch (err) {
      writeOut('hireOut', 'Failed: ' + err.message);
    }
  };
})();
