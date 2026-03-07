/**
 * onboard-connect.js — Connection, status polling, Quick Start wizard,
 * tab switching, API key toggle, freshness ticker.
 */
(function () {
  'use strict';
  var CP = window.CP;
  var el = CP.el, postJSON = CP.postJSON;

  // ── API key visibility toggle ───────────────────────────────
  CP.initApiKeyToggle = function () {
    var toggleBtn = document.getElementById('toggleApiKey');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var inp = el('apiKey');
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        toggleBtn.textContent = show ? '\u25CF' : '\u{1F441}';
        toggleBtn.title = show ? 'Hide API key' : 'Show API key';
      });
    }
  };

  // ── Quick Start wizard ─────────────────────────────────────
  var QS_KEY = 'clawsats_qs_done';
  var qsStep = 0;

  function shouldShowQuickStart() {
    try { return !localStorage.getItem(QS_KEY); } catch (e) { return false; }
  }

  function showQuickStart() {
    var overlay = el('qsOverlay');
    if (!overlay) return;
    qsStep = 0;
    updateQsStep();
    overlay.style.display = '';
    requestAnimationFrame(function () { overlay.classList.add('visible'); });
  }

  function dismissQuickStart() {
    var overlay = el('qsOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    setTimeout(function () { overlay.style.display = 'none'; }, 300);
    try { localStorage.setItem(QS_KEY, '1'); } catch (e) {}
  }

  function updateQsStep() {
    var steps = document.querySelectorAll('.qs-step');
    var dots = document.querySelectorAll('.qs-dot');
    steps.forEach(function (s, i) { s.classList.toggle('active', i === qsStep); });
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === qsStep);
      d.classList.toggle('done', i < qsStep);
    });
  }

  CP.initQuickStart = function () {
    var overlay = el('qsOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    if (shouldShowQuickStart()) showQuickStart();
    el('qsClose').addEventListener('click', dismissQuickStart);
    el('qsFinish').addEventListener('click', dismissQuickStart);
    el('qsSkip').addEventListener('click', dismissQuickStart);
    overlay.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-qs]');
      if (!btn) return;
      var action = btn.dataset.qs;
      if (action === 'next' && qsStep < 3) { qsStep++; updateQsStep(); }
      else if (action === 'prev' && qsStep > 0) { qsStep--; updateQsStep(); }
    });
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) dismissQuickStart();
    });
  };

  // ── Tab switching ──────────────────────────────────────────────
  CP.activateSubTab = function (tabName) {
    CP.activeTab = tabName;
    document.querySelectorAll('.mc-subtab-group .cp-tab').forEach(function (t) { t.classList.remove('active'); });
    var activeBtn = document.querySelector('.mc-subtab-group .cp-tab[data-tab="' + tabName + '"]');
    if (activeBtn) activeBtn.classList.add('active');
    document.querySelectorAll('.cp-pane').forEach(function (p) { p.classList.remove('active'); });
    var pane = el('pane-' + tabName);
    if (pane) pane.classList.add('active');
  };

  CP.initTabs = function () {
    var cats = document.querySelectorAll('.mc-cat');
    cats.forEach(function (catBtn) {
      catBtn.addEventListener('click', function () {
        var category = catBtn.dataset.category;
        if (category === CP.activeCategory) return;
        cats.forEach(function (c) { c.classList.remove('active'); });
        catBtn.classList.add('active');
        CP.activeCategory = category;
        document.querySelectorAll('.mc-subtab-group').forEach(function (g) { g.classList.remove('active'); });
        var group = document.querySelector('.mc-subtab-group[data-category="' + category + '"]');
        if (group) group.classList.add('active');
        CP.activateSubTab(CP.CATEGORIES[category][0]);
      });
    });
    document.querySelectorAll('.mc-subtab-group .cp-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { CP.activateSubTab(tab.dataset.tab); });
    });
  };

  // ── Data freshness chip ────────────────────────────────────
  function updateFreshnessChip() {
    var chip = el('dataFreshness');
    if (!chip) return;
    if (!CP.lastRefreshAt) { chip.textContent = ''; return; }
    var secAgo = Math.floor((Date.now() - CP.lastRefreshAt) / 1000);
    chip.textContent = secAgo < 5 ? 'just now' : secAgo + 's ago';
    chip.className = secAgo < 20 ? 'mc-freshness mc-freshness--ok' : 'mc-freshness mc-freshness--stale';
  }

  function startFreshnessTicker() {
    if (CP.freshnessTimer) return;
    updateFreshnessChip();
    CP.freshnessTimer = setInterval(updateFreshnessChip, 1000);
  }

  // ── Connect ────────────────────────────────────────────────────
  CP.connect = async function () {
    CP.save();
    var endpoint = el('endpoint').value.trim();
    if (!endpoint) { el('connectStatus').textContent = 'Enter endpoint first'; return; }

    el('connectStatus').textContent = 'Connecting...';
    try {
      var data = await postJSON('/api/openclaw/connect', { endpoint: endpoint });
      CP.connected = true;
      if (Array.isArray(data?.courses)) CP.populateCourses(data.courses);
      var health = data?.health || {};
      var disc = data?.discovery || {};
      var caps = (disc.paidCapabilities || []).map(function (c) {
        return { name: c.name, description: c.description || '', pricePerCall: c.pricePerCall, callsServed: 0, revenueSats: 0 };
      });
      CP.connectData = {
        identity: disc.identityKey || '', chain: disc.chain || 'main',
        uptime: health.server?.uptime || 0, wallet: null, economy: {},
        hiring: {}, capabilities: caps, reputation: {}, network: {},
        peers: [], peerCount: 0, education: {}, memory: {}, brain: {},
        jobs: {}, activityFeed: [], recentEvents: [], indelible: null,
        endpoint: endpoint, timestamp: new Date().toISOString()
      };
      el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-ok">Connected</span> Loading dashboard...';
      CP.updateHeaderStatus(CP.connectData);
      CP.renderAll(CP.connectData);
      await CP.loadDashboard();
      CP.startDashboardRefresh();
    } catch (err) {
      CP.connected = false;
      el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-err">Failed</span> ' + err.message;
      CP.updateHeaderStatus(null);
      CP.stopDashboardRefresh();
    }
  };

  // ── Dashboard loading ──────────────────────────────────────────
  CP.loadDashboard = async function () {
    var endpoint = el('endpoint').value.trim();
    if (!endpoint) return;
    try {
      CP.statusData = await postJSON('/api/openclaw/status', { endpoint: endpoint });
      CP.connected = true;
      CP.lastRefreshAt = Date.now();
      el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-ok">Connected</span>';
      CP.renderAll(CP.statusData);
      startFreshnessTicker();
    } catch (err) {
      el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-warn">Refresh failed</span> ' + err.message;
      var dot = el('headerDot');
      var text = el('connectStatusText');
      if (dot) dot.className = 'mc-status-dot mc-status-dot--err';
      if (text) { text.textContent = 'Refresh failed'; text.style.color = '#f5a623'; }
    }
  };

  CP.startDashboardRefresh = function () {
    if (CP.dashboardTimer) clearInterval(CP.dashboardTimer);
    CP.dashboardTimer = setInterval(CP.loadDashboard, 15000);
  };

  CP.stopDashboardRefresh = function () {
    if (CP.dashboardTimer) { clearInterval(CP.dashboardTimer); CP.dashboardTimer = null; }
  };
})();
