/**
 * onboard-utils.js — Shared state, helpers, formatters, persistence.
 * Creates the global CP namespace used by all onboard-*.js modules.
 */
(function () {
  'use strict';

  var CP = window.CP = {};

  // ── Shared state ───────────────────────────────────────────────
  CP.STORAGE_KEY = 'clawsats_cp_v2';
  CP.statusData = null;
  CP.currentCourse = null;
  CP.dashboardTimer = null;
  CP.connected = false;
  CP.lastRefreshAt = 0;
  CP.freshnessTimer = null;
  CP.connectData = null;
  CP.phaseDAvailable = false;
  CP.feedFilter = 'all';

  CP.CATEGORIES = {
    wallet:       ['overview', 'earning', 'spending'],
    network:      ['network', 'agents'],
    intelligence: ['brain', 'memory', 'education'],
    services:     ['reputation', 'escrow', 'messages', 'oracles'],
    system:       ['diagnostics']
  };
  CP.activeCategory = 'wallet';
  CP.activeTab = 'overview';

  // ── DOM helpers ────────────────────────────────────────────────
  CP.el = function (id) { return document.getElementById(id); };
  CP.fmt = function (n) { return typeof n === 'number' ? n.toLocaleString() : String(n || 0); };
  CP.short = function (s, n) { return s && s.length > n ? s.substring(0, n) + '...' : s || ''; };
  CP.pretty = function (v) { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } };

  CP.copyToClipboard = function (text) {
    navigator.clipboard.writeText(text).then(function () {
      CP.showToast('Copied to clipboard');
    }).catch(function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      CP.showToast('Copied to clipboard');
    });
  };
  window._cpCopy = CP.copyToClipboard;

  CP.showToast = function (msg) {
    var toast = document.getElementById('cp-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'cp-toast';
      toast.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;background:#27c93f;color:#000;' +
        'padding:.5rem 1rem;border-radius:8px;font-size:.85rem;font-weight:600;z-index:999;' +
        'opacity:0;transition:opacity .3s;pointer-events:none;';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { toast.style.opacity = '0'; }, 1800);
  };

  CP.copyable = function (full, displayLen) {
    if (!full) return '<span style="color:var(--muted)">-</span>';
    var display = displayLen && full.length > displayLen ? full.substring(0, displayLen) + '...' : full;
    return '<span class="cp-copyable" title="Click to copy: ' + full + '" onclick="window._cpCopy(\'' +
      full.replace(/'/g, "\\'") + '\')">' + display + '</span>';
  };

  CP.uptimeFmt = function (s) {
    if (!s || s < 60) return (s || 0) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h < 24) return h + 'h ' + m + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  };

  CP.ago = function (ts) {
    if (!ts) return '-';
    var d = Date.now() - new Date(ts).getTime();
    if (d < 60000) return Math.floor(d / 1000) + 's ago';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  };

  CP.writeOut = function (id, value) {
    var elem = CP.el(id);
    if (elem) elem.textContent = typeof value === 'string' ? value : CP.pretty(value);
  };

  CP.postJSON = async function (path, body) {
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var err = new Error(data?.error || res.status + ' ' + res.statusText);
      err.data = data;
      throw err;
    }
    return data;
  };

  // ── Persistence ────────────────────────────────────────────────
  CP.loadSaved = function () {
    try {
      var raw = localStorage.getItem(CP.STORAGE_KEY);
      if (!raw) {
        var old = localStorage.getItem('clawsats_onboard_v1');
        if (old) {
          localStorage.setItem(CP.STORAGE_KEY, old);
          return CP.loadSaved();
        }
        return;
      }
      var saved = JSON.parse(raw);
      if (saved.endpoint) CP.el('endpoint').value = saved.endpoint;
      if (saved.apiKey) CP.el('apiKey').value = saved.apiKey;
      if (saved.targetEndpoint) CP.el('targetEndpoint').value = saved.targetEndpoint;
      if (saved.maxTotalSats) CP.el('maxTotalSats').value = saved.maxTotalSats;
    } catch (e) {}
  };

  CP.save = function () {
    localStorage.setItem(CP.STORAGE_KEY, JSON.stringify({
      endpoint: CP.el('endpoint').value.trim(),
      apiKey: CP.el('apiKey').value.trim(),
      targetEndpoint: CP.el('targetEndpoint').value.trim(),
      maxTotalSats: CP.el('maxTotalSats').value.trim()
    }));
  };
})();
