(function () {
  'use strict';
  const STORAGE_KEY = 'clawsats_cp_v2';
  let statusData = null;
  let currentCourse = null;
  let dashboardTimer = null;
  let connected = false;
  let lastRefreshAt = 0;
  let freshnessTimer = null;
  let connectData = null;

  // ── Category → sub-tab mapping ────────────────────────────────
  const CATEGORIES = {
    wallet:       ['overview', 'earning', 'spending'],
    network:      ['network', 'agents'],
    intelligence: ['brain', 'memory', 'education'],
    services:     ['reputation', 'escrow', 'messages', 'oracles'],
    system:       ['diagnostics']
  };
  let activeCategory = 'wallet';
  let activeTab = 'overview';

  // ── Helpers ──────────────────────────────────────────────────

  const el = (id) => document.getElementById(id);
  const fmt = (n) => typeof n === 'number' ? n.toLocaleString() : String(n || 0);
  const short = (s, n) => s && s.length > n ? s.substring(0, n) + '...' : s || '';
  const pretty = (v) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Copied to clipboard');
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Copied to clipboard');
    });
  }

  function showToast(msg) {
    let toast = document.getElementById('cp-toast');
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
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 1800);
  }

  // Build a clickable truncated value with copy-on-click
  function copyable(full, displayLen) {
    if (!full) return '<span style="color:var(--muted)">-</span>';
    const display = displayLen && full.length > displayLen ? full.substring(0, displayLen) + '...' : full;
    return '<span class="cp-copyable" title="Click to copy: ' + full + '" onclick="window._cpCopy(\'' +
      full.replace(/'/g, "\\'") + '\')">' + display + '</span>';
  }

  // Expose copy helper globally for inline onclick
  window._cpCopy = copyToClipboard;

  function uptimeFmt(s) {
    if (!s || s < 60) return (s || 0) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h < 24) return h + 'h ' + m + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  function ago(ts) {
    if (!ts) return '-';
    const d = Date.now() - new Date(ts).getTime();
    if (d < 60000) return Math.floor(d / 1000) + 's ago';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  }

  function writeOut(id, value) {
    const elem = el(id);
    if (elem) elem.textContent = typeof value === 'string' ? value : pretty(value);
  }

  async function postJSON(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || res.status + ' ' + res.statusText);
    return data;
  }

  // ── Persistence ──────────────────────────────────────────────

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        // Migrate from v1 key
        const old = localStorage.getItem('clawsats_onboard_v1');
        if (old) {
          localStorage.setItem(STORAGE_KEY, old);
          return loadSaved();
        }
        return;
      }
      const saved = JSON.parse(raw);
      if (saved.endpoint) el('endpoint').value = saved.endpoint;
      if (saved.apiKey) el('apiKey').value = saved.apiKey;
      if (saved.targetEndpoint) el('targetEndpoint').value = saved.targetEndpoint;
      if (saved.maxTotalSats) el('maxTotalSats').value = saved.maxTotalSats;
    } catch {}
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      endpoint: el('endpoint').value.trim(),
      apiKey: el('apiKey').value.trim(),
      targetEndpoint: el('targetEndpoint').value.trim(),
      maxTotalSats: el('maxTotalSats').value.trim()
    }));
  }

  // ── API key visibility toggle ───────────────────────────────
  const toggleBtn = document.getElementById('toggleApiKey');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const inp = el('apiKey');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      toggleBtn.textContent = show ? '\u25CF' : '\u{1F441}';
      toggleBtn.title = show ? 'Hide API key' : 'Show API key';
    });
  }

  // ── Tab switching ────────────────────────────────────────────

  function initTabs() {
    // Category click handlers (tier 1)
    const cats = document.querySelectorAll('.mc-cat');
    cats.forEach(catBtn => {
      catBtn.addEventListener('click', () => {
        const category = catBtn.dataset.category;
        if (category === activeCategory) return;

        // Update category buttons
        cats.forEach(c => c.classList.remove('active'));
        catBtn.classList.add('active');
        activeCategory = category;

        // Show correct sub-tab group
        document.querySelectorAll('.mc-subtab-group').forEach(g => g.classList.remove('active'));
        const group = document.querySelector('.mc-subtab-group[data-category="' + category + '"]');
        if (group) group.classList.add('active');

        // Activate the first sub-tab in this category
        activateSubTab(CATEGORIES[category][0]);
      });
    });

    // Sub-tab click handlers (tier 2)
    document.querySelectorAll('.mc-subtab-group .cp-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activateSubTab(tab.dataset.tab);
      });
    });
  }

  function activateSubTab(tabName) {
    activeTab = tabName;

    // Update all sub-tab buttons
    document.querySelectorAll('.mc-subtab-group .cp-tab').forEach(t => t.classList.remove('active'));
    const activeBtn = document.querySelector('.mc-subtab-group .cp-tab[data-tab="' + tabName + '"]');
    if (activeBtn) activeBtn.classList.add('active');

    // Show correct pane
    document.querySelectorAll('.cp-pane').forEach(p => p.classList.remove('active'));
    const pane = el('pane-' + tabName);
    if (pane) pane.classList.add('active');
  }

  // ── Connect ──────────────────────────────────────────────────

  async function connect() {
    save();
    const endpoint = el('endpoint').value.trim();
    if (!endpoint) {
      el('connectStatus').textContent = 'Enter endpoint first';
      return;
    }

    el('connectStatus').textContent = 'Connecting...';
    try {
      const data = await postJSON('/api/openclaw/connect', { endpoint });
      connected = true;

      // Populate courses if available
      if (Array.isArray(data?.courses)) populateCourses(data.courses);

      // Build partial status from connect response so UI isn't empty
      const health = data?.health || {};
      const disc = data?.discovery || {};
      const caps = (disc.paidCapabilities || []).map(function(c) {
        return { name: c.name, description: c.description || '', pricePerCall: c.pricePerCall, callsServed: 0, revenueSats: 0 };
      });
      connectData = {
        identity: disc.identityKey || '',
        chain: disc.chain || 'main',
        uptime: health.server?.uptime || 0,
        wallet: null,
        economy: {},
        hiring: {},
        capabilities: caps,
        reputation: {},
        network: {},
        peers: [],
        peerCount: 0,
        education: {},
        memory: {},
        brain: {},
        jobs: {},
        activityFeed: [],
        recentEvents: [],
        indelible: null,
        endpoint: endpoint,
        timestamp: new Date().toISOString()
      };

      // Show partial data immediately
      el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-ok">Connected</span> Loading dashboard...';
      updateHeaderStatus(connectData);
      renderAll(connectData);

      // Load full dashboard (may take time or fail)
      await loadDashboard();
      startDashboardRefresh();
    } catch (err) {
      connected = false;
      el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-err">Failed</span> ' + err.message;
      updateHeaderStatus(null);
      stopDashboardRefresh();
    }
  }

  // ── Dashboard loading ────────────────────────────────────────

  async function loadDashboard() {
    const endpoint = el('endpoint').value.trim();
    if (!endpoint) return;
    try {
      statusData = await postJSON('/api/openclaw/status', { endpoint });
      connected = true;
      lastRefreshAt = Date.now();
      el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-ok">Connected</span>';
      renderAll(statusData);
      startFreshnessTicker();
    } catch (err) {
      el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-warn">Refresh failed</span> ' + err.message;
      // Update header to show warning state too
      const dot = el('headerDot');
      const text = el('connectStatusText');
      if (dot) dot.className = 'mc-status-dot mc-status-dot--err';
      if (text) { text.textContent = 'Refresh failed'; text.style.color = '#f5a623'; }
    }
  }

  function startDashboardRefresh() {
    if (dashboardTimer) clearInterval(dashboardTimer);
    dashboardTimer = setInterval(loadDashboard, 15000);
  }

  function stopDashboardRefresh() {
    if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  }

  // ── Data freshness chip ────────────────────────────────────

  function startFreshnessTicker() {
    if (freshnessTimer) return;
    updateFreshnessChip();
    freshnessTimer = setInterval(updateFreshnessChip, 1000);
  }

  function updateFreshnessChip() {
    if (!lastRefreshAt) return;
    const chip = el('freshnessChip');
    const label = el('freshnessLabel');
    if (!chip || !label) return;

    const ago = Math.floor((Date.now() - lastRefreshAt) / 1000);
    const STALE_SECS = 30;

    if (ago < 3) label.textContent = 'Just now';
    else if (ago < 60) label.textContent = ago + 's ago';
    else label.textContent = Math.floor(ago / 60) + 'm ' + (ago % 60) + 's ago';

    chip.classList.toggle('stale', ago > STALE_SECS);
  }

  // ── Header status + metrics bar ─────────────────────────────

  function updateHeaderStatus(d) {
    const dot = el('headerDot');
    const text = el('connectStatusText');
    if (!dot || !text) return;
    if (connected && d) {
      dot.className = 'mc-status-dot mc-status-dot--on';
      text.textContent = 'Connected';
      text.style.color = '#27c93f';
    } else {
      dot.className = 'mc-status-dot mc-status-dot--off';
      text.textContent = 'Disconnected';
      text.style.color = '';
    }
  }

  function updateMetricsBar(d) {
    const bar = el('metricsBar');
    if (!bar) return;
    if (d && connected) {
      bar.style.display = '';
      const wallet = d.wallet || {};
      const econ = d.economy || {};
      const peers = d.peers || [];
      el('hb-balance').textContent = fmt(wallet.balanceSats || 0) + ' sats';
      el('hb-earned').textContent = fmt(econ.totalEarnedSats || 0) + ' sats';
      el('hb-peers').textContent = fmt(peers.length);
      el('hb-uptime').textContent = uptimeFmt(d.uptime || 0);
    } else {
      bar.style.display = 'none';
    }
  }

  function updateIndelibleNotices(d) {
    const indelibleEnabled = d && d.indelible && d.indelible.enabled;
    const tabs = ['agents', 'reputation', 'escrow', 'messages', 'oracles'];
    tabs.forEach(tab => {
      const notice = el('indelible-notice-' + tab);
      if (notice) notice.style.display = indelibleEnabled ? 'none' : 'flex';
    });

    // Gate action buttons when Indelible is unavailable
    const attestBtn = el('btnAttest');
    if (attestBtn) {
      attestBtn.disabled = !indelibleEnabled;
      attestBtn.title = indelibleEnabled ? '' : 'Requires Indelible.One subscription';
    }
  }

  // ── Render all tabs ──────────────────────────────────────────

  function renderAll(d) {
    updateHeaderStatus(d);
    updateMetricsBar(d);
    updateIndelibleNotices(d);
    updatePipeline(d);
    renderOverview(d);
    renderEarning(d);
    renderSpending(d);
    renderNetwork(d);
    renderBrain(d);
    renderMemory(d);
    renderEducation(d);
    renderAgents(d);
    renderReputation(d);
    renderEscrow(d);
    renderMessages(d);
    renderOracles(d);
    renderDiagnostics(d);
  }

  // ── Global pipeline stepper ────────────────────────────────

  function updatePipeline(d) {
    const wrap = el('stepperWrap');
    if (wrap) wrap.style.display = '';

    const econ = d.economy || {};
    const wallet = d.wallet || {};
    const light = (id, on) => {
      const step = el(id);
      if (step) step.classList.toggle('lit', on);
    };
    light('pipe-wallet', (wallet.balanceSats || 0) > 0);
    light('pipe-brain', (d.brain?.completed || 0) > 0);
    light('pipe-memory', (d.memory?.totalMemories || 0) > 0);
    light('pipe-discover', (d.peers || []).length > 0);
    light('pipe-earn', (econ.totalEarnedSats || 0) > 0);
    light('pipe-spend', (econ.totalSpentSats || 0) > 0);
  }

  function initPipelineClicks() {
    document.querySelectorAll('.cp-pipe-click').forEach(step => {
      step.addEventListener('click', () => {
        const nav = step.dataset.nav;
        if (!nav) return;
        const [category, tab] = nav.split('/');

        // Switch category
        const cats = document.querySelectorAll('.mc-cat');
        cats.forEach(c => c.classList.remove('active'));
        const catBtn = document.querySelector('.mc-cat[data-category="' + category + '"]');
        if (catBtn) catBtn.classList.add('active');
        activeCategory = category;

        // Show correct sub-tab group
        document.querySelectorAll('.mc-subtab-group').forEach(g => g.classList.remove('active'));
        const group = document.querySelector('.mc-subtab-group[data-category="' + category + '"]');
        if (group) group.classList.add('active');

        // Activate the target sub-tab
        activateSubTab(tab);
      });
    });
  }

  // ── UTXO health bar (Overview tab) ────────────────────────────

  function renderUtxoBar(d) {
    const bar = el('utxoBar');
    if (!bar) return;
    const wallet = d.wallet || {};
    const total = wallet.utxoTotal || 0;
    if (total === 0) { bar.style.display = 'none'; return; }

    bar.style.display = '';
    const avail = wallet.utxoAvailable || 0;
    const locked = wallet.utxoLocked || 0;
    const stuck = wallet.utxoStuck || 0;

    // Set fill widths as percentages
    const pct = (n) => Math.max(0, Math.min(100, (n / total) * 100)).toFixed(1) + '%';
    el('utxoFillAvail').style.width = pct(avail);
    el('utxoFillLocked').style.width = pct(locked);
    el('utxoFillStuck').style.width = pct(stuck);

    // Update legend numbers
    el('utxoAvailNum').textContent = avail;
    el('utxoTotalNum').textContent = total;

    const lockedLabel = el('utxoLockedLabel');
    if (lockedLabel) {
      lockedLabel.style.display = locked > 0 ? '' : 'none';
      el('utxoLockedNum').textContent = locked;
    }
    const stuckLabel = el('utxoStuckLabel');
    if (stuckLabel) {
      stuckLabel.style.display = stuck > 0 ? '' : 'none';
      el('utxoStuckNum').textContent = stuck;
    }
  }

  // ── Activity feed (rich, filterable) ────────────────────────

  let feedFilter = 'all';

  function classifyFeedType(source, type) {
    if (source === 'earning' || type === 'earn' || type === 'payment_received') return 'earn';
    if (source === 'spending' || type === 'spend' || type === 'hire' || type === 'payment_sent') return 'spend';
    if (source === 'peer' || source === 'network' || type === 'peer_discovered' || type === 'peer_stale') return 'peer';
    if (source === 'brain' || type === 'decision' || type === 'brain_job') return 'brain';
    return 'system';
  }

  function renderActivityFeed(d) {
    const feedEl = el('overviewFeed');
    if (!feedEl) return;
    const feed = d.activityFeed || [];
    if (feed.length === 0) {
      feedEl.innerHTML = '<li class="mc-feed-item" style="color:var(--muted)">No activity yet.</li>';
      return;
    }

    const items = feed.map(e => {
      const cls = classifyFeedType(e.source, e.type);
      return { cls: cls, e: e };
    });

    const filtered = feedFilter === 'all' ? items : items.filter(i => i.cls === feedFilter);

    feedEl.innerHTML = filtered.map(({ cls, e }) => {
      const time = (e.ts || '').substring(11, 19);
      const msg = (e.type || '') + (e.capability ? ' ' + e.capability : '');
      let satsHtml = '';
      if (e.sats) {
        const isPos = cls === 'earn';
        satsHtml = '<span class="mc-feed-sats ' + (isPos ? 'mc-feed-sats--pos' : 'mc-feed-sats--neg') + '">' +
          (isPos ? '+' : '-') + fmt(e.sats) + '</span>';
      }
      return '<li class="mc-feed-item" data-type="' + cls + '">' +
        '<span class="mc-feed-type mc-feed-type--' + cls + '">' + cls + '</span>' +
        '<span class="mc-feed-time">' + time + '</span>' +
        '<span class="mc-feed-msg">' + msg + '</span>' +
        satsHtml + '</li>';
    }).join('');
  }

  function initFeedFilters() {
    const wrap = el('feedFilters');
    if (!wrap) return;
    wrap.addEventListener('click', function(ev) {
      const btn = ev.target.closest('.mc-feed-filter');
      if (!btn) return;
      wrap.querySelectorAll('.mc-feed-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      feedFilter = btn.dataset.filter;
      if (statusData) renderActivityFeed(statusData);
      else if (connectData) renderActivityFeed(connectData);
    });
  }

  // ── Overview tab ─────────────────────────────────────────────

  function renderOverview(d) {
    const econ = d.economy || {};
    const rep = d.reputation || {};
    const wallet = d.wallet || {};

    el('os-balance').textContent = fmt(wallet.balanceSats || 0);
    el('os-earned').textContent = fmt(econ.totalEarnedSats || 0);
    el('os-spent').textContent = fmt(econ.totalSpentSats || 0);
    el('os-net').textContent = fmt(econ.netIncomeSats || 0);
    el('os-calls').textContent = fmt(rep.totalCallsServed || 0);
    el('os-uptime').textContent = uptimeFmt(d.uptime || 0);

    // Capabilities table
    const caps = d.capabilities || [];
    const tbody = caps.map(c =>
      '<tr><td>' + c.name + '</td><td class="num">' + c.pricePerCall + '</td>' +
      '<td class="num">' + fmt(c.callsServed || 0) + '</td>' +
      '<td class="num">' + fmt(c.revenueSats || 0) + '</td></tr>'
    ).join('');
    el('overviewCaps').querySelector('tbody').innerHTML = tbody || '<tr><td colspan="4" style="color:var(--muted)">No capabilities</td></tr>';

    // Activity feed (rich)
    renderActivityFeed(d);

    // UTXO health bar
    renderUtxoBar(d);

    // Indelible overview stats + 30-day chart
    renderIndelibleOverview(d);
  }

  // ── Earning tab ──────────────────────────────────────────────

  function renderEarning(d) {
    const econ = d.economy || {};
    const rep = d.reputation || {};

    el('es-earned').textContent = fmt(econ.totalEarnedSats || 0);
    el('es-calls').textContent = fmt(rep.totalCallsServed || 0);
    el('es-callers').textContent = fmt(rep.uniqueCallers || 0);
    el('es-fees').textContent = fmt(econ.protocolFeesCollected || 0);
    el('es-referrals').textContent = fmt(rep.referralsEarned || 0);

    const caps = d.capabilities || [];
    const rows = caps.map(c => {
      const calls = c.callsServed || 0;
      const rev = c.revenueSats || 0;
      const avg = calls > 0 ? (rev / calls).toFixed(1) : '-';
      const trial = c.pricePerCall > 0 ? '<span class="cp-badge cp-badge-ok">Yes</span>' : '<span style="color:var(--muted)">N/A</span>';
      return '<tr><td>' + c.name + '</td><td class="num">' + c.pricePerCall + '</td>' +
        '<td class="num">' + fmt(calls) + '</td>' +
        '<td class="num">' + fmt(rev) + '</td>' +
        '<td class="num">' + avg + '</td>' +
        '<td>' + trial + '</td></tr>';
    }).join('');
    el('earningTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="6" style="color:var(--muted)">No earnings yet</td></tr>';
  }

  // ── Spending tab ─────────────────────────────────────────────

  function renderSpending(d) {
    const econ = d.economy || {};
    const hiring = d.hiring || {};

    el('ss-spent').textContent = fmt(econ.totalSpentSats || 0);
    el('ss-hires').textContent = fmt(hiring.totalHires || 0);
    el('ss-fees').textContent = fmt(econ.protocolFeesPaid || 0);
    el('ss-mining').textContent = fmt(econ.miningFeesPaid || 0);

    const hires = hiring.recentHires || [];
    const total = hires.length;
    const successes = hires.filter(h => !h.error && h.status !== 'failed').length;
    el('ss-success').textContent = total > 0 ? Math.round((successes / total) * 100) + '%' : '-';

    const rows = hires.map(h => {
      const ok = !h.error && h.status !== 'failed';
      const badge = ok
        ? '<span class="cp-badge cp-badge-ok">OK</span>'
        : '<span class="cp-badge cp-badge-err">' + short(h.error || 'Failed', 20) + '</span>';
      return '<tr><td>' + (h.capability || '-') + '</td>' +
        '<td>' + short(h.peerIdentity || '-', 16) + '</td>' +
        '<td class="num">' + fmt(h.costSats || 0) + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + ago(h.timestamp) + '</td></tr>';
    }).join('');
    el('spendingTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="5" style="color:var(--muted)">No hires yet</td></tr>';
  }

  // ── Network tab ──────────────────────────────────────────────

  function repColor(rep) {
    if (rep >= 70) return '#27c93f';
    if (rep >= 40) return '#f5a623';
    return '#e63946';
  }

  function repBar(rep) {
    const r = Math.max(0, Math.min(100, rep || 0));
    return '<span class="mc-rep-bar">' +
      '<span class="mc-rep-track"><span class="mc-rep-fill" style="width:' + r + '%;background:' + repColor(r) + '"></span></span>' +
      '<span style="font-size:.75rem;color:' + repColor(r) + '">' + r + '</span></span>';
  }

  function renderNetwork(d) {
    const net = d.network || {};
    const peers = d.peers || [];

    el('ns-healthy').textContent = fmt(net.healthyPeers || 0);
    el('ns-stale').textContent = fmt(net.stalePeers || 0);
    el('ns-new').textContent = fmt(net.newPeersThisWeek || 0);
    el('ns-total').textContent = fmt(peers.length);

    // Avg reputation
    if (peers.length > 0) {
      const avg = peers.reduce((s, p) => s + (p.reputation || 0), 0) / peers.length;
      el('ns-avgrep').textContent = avg.toFixed(0);
    } else {
      el('ns-avgrep').textContent = '-';
    }

    const rows = peers.slice(0, 30).map(p =>
      '<tr><td>' + copyable(p.identityKey, 16) + '</td>' +
      '<td>' + copyable(p.endpoint, 35) + '</td>' +
      '<td class="num">' + repBar(p.reputation) + '</td>' +
      '<td>' + ago(p.lastSeenAt) + '</td></tr>'
    ).join('');
    const more = peers.length > 30 ? '<tr><td colspan="4" style="color:var(--muted)">...and ' + (peers.length - 30) + ' more</td></tr>' : '';
    el('networkTable').querySelector('tbody').innerHTML = (rows + more) || '<tr><td colspan="4" style="color:var(--muted)">No peers</td></tr>';
  }

  // ── Brain tab ────────────────────────────────────────────────

  function renderBrain(d) {
    const brain = d.brain || {};

    el('bs-pending').textContent = fmt(brain.pending || 0);
    el('bs-completed').textContent = fmt(brain.completed || 0);
    el('bs-failed').textContent = fmt(brain.failed || 0);
    el('bs-approval').textContent = fmt(brain.needsApproval || 0);
    el('bs-auto').textContent = fmt(brain.autoApproved || 0);
    el('bs-conf').textContent = brain.avgConfidence || '-';

    // Pending approvals
    const approvals = brain.pendingApprovals || [];
    const approvalCard = el('brainApprovalCard');
    if (approvalCard) {
      if (approvals.length > 0 || (brain.needsApproval || 0) > 0) {
        approvalCard.style.display = '';
        el('approvalCount').textContent = approvals.length || brain.needsApproval || 0;
        if (approvals.length > 0) {
          el('brainApprovals').innerHTML = approvals.map(a =>
            '<div class="mc-approval-item">' +
            '<span class="cp-badge cp-badge-warn">' + (a.tool || a.action || 'gated') + '</span> ' +
            '<span style="flex:1;font-size:.82rem;">' + short(a.reason || a.description || 'Pending approval', 60) + '</span>' +
            '<div class="mc-approval-actions">' +
            '<button class="mc-approval-btn mc-approval-btn--approve" data-job="' + (a.jobId || a.id || '') + '" data-action="approve">Approve</button>' +
            '<button class="mc-approval-btn mc-approval-btn--reject" data-job="' + (a.jobId || a.id || '') + '" data-action="reject">Reject</button>' +
            '</div></div>'
          ).join('');
        } else {
          el('brainApprovals').innerHTML = '<div style="color:var(--muted);font-size:.82rem;padding:.4rem;">' +
            (brain.needsApproval || 0) + ' actions pending (details not available via API yet)</div>';
        }
      } else {
        approvalCard.style.display = 'none';
      }
    }

    // Circuit breakers
    const breakers = brain.circuitBreakers || [];
    el('brainBreakers').innerHTML = breakers.length > 0
      ? breakers.map(b => '<span class="cp-badge cp-badge-err">' + b + '</span> ').join('')
      : '<span style="color:var(--muted)">No circuit breakers open</span>';

    // Recent jobs
    const recent = brain.recent || [];
    if (recent.length > 0) {
      el('brainJobs').textContent = recent.map(j =>
        '[' + j.status + '] ' + (j.capability || '-') + ' (' + (j.strategy || '-') + ')' +
        (j.error ? ' ERR: ' + short(j.error, 40) : '')
      ).join('\n');
    } else {
      el('brainJobs').textContent = 'No brain jobs.';
    }

    // Recent events
    const events = d.recentEvents || [];
    if (events.length > 0) {
      el('brainEvents').textContent = events.map(e =>
        (e.ts || '').substring(11, 19) + ' ' + (e.action || '') +
        (e.details?.confidence ? ' (conf: ' + e.details.confidence + ')' : '') +
        (e.reason ? ': ' + short(e.reason, 80) : '')
      ).join('\n');
    } else {
      el('brainEvents').textContent = 'No decision events yet.';
    }
  }

  // ── Brain approval actions ─────────────────────────────────

  async function handleBrainApproval(jobId, action) {
    const endpoint = el('endpoint').value.trim();
    const apiKey = el('apiKey').value.trim();
    if (!endpoint || !apiKey) {
      showToast('API key required for approvals');
      return;
    }
    try {
      await postJSON('/api/openclaw/brain/' + action, { endpoint, apiKey, jobId });
      showToast(action === 'approve' ? 'Approved' : 'Rejected');
      loadDashboard();
    } catch (err) {
      showToast('Failed: ' + err.message);
    }
  }

  // ── Memory tab ───────────────────────────────────────────────

  function renderMemory(d) {
    const mem = d.memory || {};
    el('ms-records').textContent = fmt(mem.totalMemories || 0);
    el('ms-index').textContent = mem.masterIndexTxid ? 'Yes' : 'No';

    // Backend type
    const backend = mem.backend || 'local';
    el('ms-backend').textContent = backend;

    // Sync status badge
    const syncEl = el('ms-sync');
    if (syncEl) {
      const ind = d.indelible;
      if (ind && ind.enabled) {
        const synced = mem.synced !== false;
        syncEl.innerHTML = '<span class="mc-sync-badge ' + (synced ? 'mc-sync-badge--ok' : 'mc-sync-badge--warn') + '">' +
          (synced ? 'Synced' : 'Behind') + '</span>';
      } else {
        syncEl.innerHTML = '<span class="mc-sync-badge mc-sync-badge--off">Local only</span>';
      }
    }

    const lines = [];
    lines.push('Total records: ' + fmt(mem.totalMemories || 0));
    if (mem.masterIndexTxid) lines.push('Master index TXID: ' + mem.masterIndexTxid);
    lines.push('Backend: ' + backend);
    if (mem.lastWriteAt) lines.push('Last write: ' + ago(mem.lastWriteAt));
    if (mem.keys) lines.push('Keys: ' + (Array.isArray(mem.keys) ? mem.keys.join(', ') : mem.keys));
    el('memoryDetails').textContent = lines.join('\n') || 'No memory data.';

    // Session browser (from Indelible)
    renderSessionBrowser(d);
  }

  // ── Education tab ────────────────────────────────────────────

  function renderEducation(d) {
    const edu = d.education || {};
    const completed = edu.coursesCompleted || [];
    const available = edu.coursesAvailable || 0;
    el('edu-completed').textContent = fmt(completed.length);
    el('edu-available').textContent = fmt(available);

    // Teaching stats
    el('edu-taught').textContent = fmt(edu.quizzesServed || 0);
    const attempts = edu.quizAttempts || 0;
    const passes = edu.quizPasses || 0;
    el('edu-passrate').textContent = attempts > 0 ? Math.round((passes / attempts) * 100) + '%' : '-';

    // Progress bar
    const pct = available > 0 ? Math.round((completed.length / available) * 100) : 0;
    el('edu-progress-label').textContent = completed.length + ' / ' + available + ' completed';
    el('edu-progress-pct').textContent = pct + '%';
    const bar = el('edu-progress-bar');
    if (bar) bar.style.width = pct + '%';
  }

  // ── Diagnostics tab ──────────────────────────────────────────

  function renderDiagnostics(d) {
    const wallet = d.wallet || {};
    const econ = d.economy || {};

    el('dx-utxo-total').textContent = fmt(wallet.utxoTotal || 0);
    el('dx-utxo-avail').textContent = fmt(wallet.utxoAvailable || 0);
    el('dx-utxo-locked').textContent = fmt(wallet.utxoLocked || 0);
    el('dx-utxo-stuck').textContent = fmt(wallet.utxoStuck || 0);
    el('dx-503').textContent = fmt(econ.total503s || 0);
    el('dx-concurrency').textContent = fmt(wallet.concurrencySlots || 0);

    // Wallet info (with copyable identity key and funding address)
    const wHtml = [];
    wHtml.push('Balance: ' + fmt(wallet.balanceSats || 0) + ' sats');
    if (wallet.identityKey) wHtml.push('Identity key: ' + copyable(wallet.identityKey, 20));
    if (wallet.fundingAddress) wHtml.push('Funding address: ' + copyable(wallet.fundingAddress, 34));
    wHtml.push('UTXO pool: ' + fmt(wallet.utxoTotal || 0) + ' total, ' + fmt(wallet.utxoAvailable || 0) + ' available');
    if (wallet.utxoStuck > 0) wHtml.push('Stuck UTXOs: ' + wallet.utxoStuck + ' (locked > 5 min)');
    wHtml.push('Concurrency slots: ' + fmt(wallet.concurrencySlots || 0));
    el('diagWallet').innerHTML = wHtml.join('\n');

    // Raw status
    el('diagRaw').textContent = pretty(d);
  }

  // ── Indelible Overview (augments Overview tab) ─────────────

  function renderIndelibleOverview(d) {
    const ind = d.indelible;
    const statsRow = el('overviewIndelibleStats');
    const chartWrap = el('overviewChart');
    if (!ind || !ind.enabled) {
      if (statsRow) statsRow.style.display = 'none';
      if (chartWrap) chartWrap.style.display = 'none';
      return;
    }
    if (statsRow) {
      statsRow.style.display = '';
      const s = ind.stats || {};
      const w = ind.wallet || {};
      el('os-saves').textContent = fmt(s.totalSaves || 0);
      el('os-loads').textContent = fmt(s.totalLoads || 0);
      el('os-agents').textContent = fmt(s.activeAgents || 0);
      el('os-saves-today').textContent = fmt(s.savesToday || 0);
      el('os-onchain-bytes').textContent = fmt(w.totalBytes || 0);
    }

    // 30-day chart (simple bar using canvas)
    const daily = ind.stats?.dailyStats;
    if (chartWrap && Array.isArray(daily) && daily.length > 0) {
      chartWrap.style.display = '';
      const canvas = el('activityChart');
      if (canvas && canvas.getContext) {
        const ctx = canvas.getContext('2d');
        const W = canvas.width = canvas.parentElement.clientWidth || 600;
        const H = canvas.height = 120;
        ctx.clearRect(0, 0, W, H);
        const max = Math.max(...daily.map(d => (d.saves || 0) + (d.loads || 0)), 1);
        const barW = Math.max(4, (W - 20) / daily.length - 2);
        daily.forEach((day, i) => {
          const val = (day.saves || 0) + (day.loads || 0);
          const barH = (val / max) * (H - 20);
          const x = 10 + i * (barW + 2);
          ctx.fillStyle = '#27c93f';
          ctx.fillRect(x, H - 10 - barH, barW, barH);
        });
        ctx.fillStyle = '#666';
        ctx.font = '10px monospace';
        ctx.fillText(daily[0]?.date || '', 10, H - 1);
        ctx.fillText(daily[daily.length - 1]?.date || '', W - 70, H - 1);
      }
    } else if (chartWrap) {
      chartWrap.style.display = 'none';
    }
  }

  // ── Session Browser (augments Memory tab) ──────────────────

  function renderSessionBrowser(d) {
    const card = el('sessionBrowserCard');
    const ind = d.indelible;
    if (!card) return;
    if (!ind || !ind.enabled || !ind.sessions || Object.keys(ind.sessions).length === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    const rows = Object.entries(ind.sessions).map(([addr, s]) =>
      '<tr><td>' + copyable(addr, 16) + '</td>' +
      '<td class="num">' + fmt(s.count || 0) + '</td>' +
      '<td class="num">' + fmt(s.messageCount || 0) + '</td>' +
      '<td class="num">' + fmt(s.bytes || 0) + '</td></tr>'
    ).join('');
    el('sessionTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="4" style="color:var(--muted)">No sessions</td></tr>';
  }

  // ── Agents tab ─────────────────────────────────────────────

  function renderAgents(d) {
    const ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('ag-count').textContent = '-';
      el('ag-caps').textContent = '-';
      el('agentRoster').querySelector('tbody').innerHTML =
        '<tr><td colspan="4" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    const roster = ind.roster || [];
    el('ag-count').textContent = fmt(roster.length);
    el('ag-caps').textContent = fmt(roster.reduce((sum, a) => sum + (a.capabilities?.length || 0), 0));
    const rows = roster.map(a =>
      '<tr><td>' + (a.name || '-') + '</td>' +
      '<td>' + copyable(a.pubkey, 16) + '</td>' +
      '<td>' + (a.capabilities || []).join(', ') + '</td>' +
      '<td>' + ago(a.createdAt) + '</td></tr>'
    ).join('');
    el('agentRoster').querySelector('tbody').innerHTML = rows || '<tr><td colspan="4" style="color:var(--muted)">No agents registered</td></tr>';
  }

  // ── Reputation tab ─────────────────────────────────────────

  function renderReputation(d) {
    const ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('rp-agents').textContent = '-';
      el('rp-attestations').textContent = '-';
      el('reputationTable').querySelector('tbody').innerHTML =
        '<tr><td colspan="7" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    const rep = ind.reputation || {};
    const entries = Object.entries(rep);
    const totalAtts = entries.reduce((sum, [, r]) => sum + (r.attestationCount || 0), 0);
    el('rp-agents').textContent = fmt(entries.length);
    el('rp-attestations').textContent = fmt(totalAtts);
    const rows = entries.map(([key, r]) => {
      const b = r.breakdown || {};
      return '<tr><td>' + copyable(key, 16) + '</td>' +
        '<td class="num">' + (r.score || 0).toFixed(1) + '</td>' +
        '<td class="num">' + (b.avgRating || 0).toFixed(1) + '</td>' +
        '<td class="num">' + (b.volumeBonus || 0).toFixed(1) + '</td>' +
        '<td class="num">' + (b.diversityBonus || 0).toFixed(1) + '</td>' +
        '<td class="num">' + (b.recencyBonus || 0).toFixed(1) + '</td>' +
        '<td class="num">' + fmt(r.attestationCount || 0) + '</td></tr>';
    }).join('');
    el('reputationTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="7" style="color:var(--muted)">No reputation data</td></tr>';
  }

  // ── Escrow tab ─────────────────────────────────────────────

  function renderEscrow(d) {
    const ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('esc-active').textContent = '-';
      el('esc-total-sats').textContent = '-';
      el('escrowTable').querySelector('tbody').innerHTML =
        '<tr><td colspan="6" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    const escrows = ind.escrows || [];
    const active = escrows.filter(e => e.status === 'pending' || e.status === 'accepted');
    el('esc-active').textContent = fmt(active.length);
    el('esc-total-sats').textContent = fmt(active.reduce((s, e) => s + (e.amount || 0), 0));
    const statusBadge = (s) => {
      const cls = s === 'released' ? 'ok' : s === 'disputed' ? 'err' : s === 'expired' ? 'warn' : 'ok';
      return '<span class="cp-badge cp-badge-' + cls + '">' + s + '</span>';
    };
    const rows = escrows.map(e =>
      '<tr><td>' + short(e.id, 12) + '</td>' +
      '<td>' + statusBadge(e.status) + '</td>' +
      '<td class="num">' + fmt(e.amount || 0) + '</td>' +
      '<td>' + copyable(e.payeePubKey, 12) + '</td>' +
      '<td>' + short(e.description, 30) + '</td>' +
      '<td>' + ago(e.expiresAt) + '</td></tr>'
    ).join('');
    el('escrowTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="6" style="color:var(--muted)">No escrows</td></tr>';
  }

  // ── Messages tab ───────────────────────────────────────────

  function renderMessages(d) {
    const ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('msg-channels').textContent = '-';
      el('messageTable').querySelector('tbody').innerHTML =
        '<tr><td colspan="3" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    const channels = ind.channels || [];
    el('msg-channels').textContent = fmt(channels.length);
    const rows = channels.map(ch =>
      '<tr><td>' + (ch.participants || []).map(p => short(p, 12)).join(', ') + '</td>' +
      '<td>' + (ch.lastAction || '-') + '</td>' +
      '<td>' + ago(ch.lastTimestamp) + '</td></tr>'
    ).join('');
    el('messageTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="3" style="color:var(--muted)">No channels</td></tr>';
  }

  // ── Oracles tab ────────────────────────────────────────────

  function renderOracles(d) {
    const ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('or-registries').textContent = '-';
      el('or-attestations').textContent = '-';
      el('oracleRegTable').querySelector('tbody').innerHTML =
        '<tr><td colspan="3" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      el('oracleAttTable').querySelector('tbody').innerHTML =
        '<tr><td colspan="5" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    const regs = ind.oracleRegistries || [];
    const atts = ind.oracleAttestations || [];
    el('or-registries').textContent = fmt(regs.length);
    el('or-attestations').textContent = fmt(atts.length);

    const regRows = regs.map(r =>
      '<tr><td>' + copyable(r.agentPubKey, 16) + '</td>' +
      '<td>' + (r.dataTypes || []).join(', ') + '</td>' +
      '<td>' + copyable(r.endpoint, 30) + '</td></tr>'
    ).join('');
    el('oracleRegTable').querySelector('tbody').innerHTML = regRows || '<tr><td colspan="3" style="color:var(--muted)">No oracle registries</td></tr>';

    const attRows = atts.map(a =>
      '<tr><td>' + (a.dataType || '-') + '</td>' +
      '<td>' + short(a.value, 20) + '</td>' +
      '<td>' + short(a.source, 16) + '</td>' +
      '<td class="num">' + ((a.confidence || 0) * 100).toFixed(0) + '%</td>' +
      '<td>' + ago(a.timestamp) + '</td></tr>'
    ).join('');
    el('oracleAttTable').querySelector('tbody').innerHTML = attRows || '<tr><td colspan="5" style="color:var(--muted)">No attestations</td></tr>';
  }

  // ── Attestation submission ─────────────────────────────────

  async function submitAttestation() {
    const endpoint = el('endpoint').value.trim();
    const apiKey = el('apiKey').value.trim();
    const agentPubKey = el('attestAgent').value.trim();
    const capability = el('attestCap').value.trim();
    const rating = parseInt(el('attestRating').value, 10);
    if (!endpoint || !apiKey || !agentPubKey || !capability || !rating) {
      writeOut('attestOut', 'All fields required.');
      return;
    }
    writeOut('attestOut', 'Submitting...');
    try {
      const data = await postJSON('/api/openclaw/agents/attest', {
        endpoint, apiKey, agentPubKey, capability, rating
      });
      writeOut('attestOut', data);
    } catch (err) {
      writeOut('attestOut', 'Failed: ' + err.message);
    }
  }

  // ── Diagnostic export ───────────────────────────────────────

  function exportDiagnostics() {
    if (!statusData) {
      showToast('Connect to a Claw first');
      return;
    }

    // Deep clone and redact secrets
    const data = JSON.parse(JSON.stringify(statusData));
    const redact = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const key of Object.keys(obj)) {
        const k = key.toLowerCase();
        if (k.includes('rootkey') || k.includes('apikey') || k.includes('secret') || k.includes('password') || k === 'rootkeyhex') {
          obj[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
          redact(obj[key]);
        }
      }
    };
    redact(data);

    const report = {
      exportedAt: new Date().toISOString(),
      endpoint: el('endpoint').value.trim(),
      clawsatsVersion: 'clawsats://v1',
      status: data
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'clawsats-diagnostic-' + new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Diagnostic report downloaded');
  }

  // ── Health test ──────────────────────────────────────────────

  async function testHealth() {
    save();
    const endpoint = el('endpoint').value.trim();
    if (!endpoint) { writeOut('diagHealth', 'Enter endpoint first.'); return; }
    writeOut('diagHealth', 'Testing...');
    try {
      const data = await postJSON('/api/openclaw/connect', { endpoint });
      writeOut('diagHealth', data);
    } catch (err) {
      writeOut('diagHealth', 'Failed: ' + err.message);
    }
  }

  // ── Course flow ──────────────────────────────────────────────

  function populateCourses(courses) {
    const sel = el('courseSelect');
    if (!Array.isArray(courses) || courses.length === 0) {
      sel.innerHTML = '<option value="">No courses found</option>';
      return;
    }
    sel.innerHTML = courses
      .slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map(c => {
        const state = c.completed ? 'completed' : (c.prerequisitesMet ? 'ready' : 'locked');
        return '<option value="' + c.id + '">' + c.id + ' - ' + c.title + ' (' + state + ')</option>';
      }).join('');
  }

  async function loadCourses() {
    save();
    const endpoint = el('endpoint').value.trim();
    if (!endpoint) { writeOut('courseOut', 'Enter endpoint first.'); return; }
    writeOut('courseOut', 'Loading courses...');
    try {
      const data = await postJSON('/api/openclaw/courses', { endpoint });
      populateCourses(data.courses || []);
      writeOut('courseOut', { totalAvailable: data.totalAvailable, completedByThisClaw: data.completedByThisClaw });
    } catch (err) {
      writeOut('courseOut', 'Failed: ' + err.message);
    }
  }

  async function loadCourse() {
    save();
    const endpoint = el('endpoint').value.trim();
    const courseId = el('courseSelect').value;
    if (!endpoint || !courseId) { writeOut('courseOut', 'Pick a course first.'); return; }

    writeOut('courseOut', 'Loading ' + courseId + '...');
    el('quizWrap').innerHTML = '';
    el('quizActions').style.display = 'none';

    try {
      const data = await postJSON('/api/openclaw/course', { endpoint, courseId });
      const course = data.course;
      currentCourse = course;

      const quizHtml = (course.quiz || []).map((q, idx) => {
        const opts = (q.options || []).map(opt => {
          const val = String(opt).replace(/"/g, '&quot;');
          return '<label class="cp-quiz-opt"><input type="radio" name="q_' + idx + '" value="' + val + '"> ' + opt + '</label>';
        }).join('');
        return '<div class="cp-quiz-q"><p>Q' + (idx + 1) + '. ' + q.question + '</p>' + opts + '</div>';
      }).join('');

      el('quizWrap').innerHTML =
        '<div class="cp-note" style="margin-bottom:.7rem;"><strong>' + course.title + '</strong><br>' +
        course.summary + '<br>Passing: ' + Math.round((course.passingScore || 0) * 100) + '%</div>' + quizHtml;
      el('quizActions').style.display = (course.quiz || []).length ? 'flex' : 'none';
      writeOut('courseOut', { courseId: course.id, title: course.title, questions: course.questionCount });
    } catch (err) {
      writeOut('courseOut', 'Failed: ' + err.message);
    }
  }

  async function submitQuiz() {
    save();
    const endpoint = el('endpoint').value.trim();
    const apiKey = el('apiKey').value.trim();
    if (!endpoint) { writeOut('courseOut', 'Enter endpoint.'); return; }
    if (!apiKey) { writeOut('courseOut', 'API key required.'); return; }
    if (!currentCourse) { writeOut('courseOut', 'Load a course first.'); return; }

    const answers = (currentCourse.quiz || []).map((_, i) => {
      const sel = document.querySelector('input[name="q_' + i + '"]:checked');
      return sel ? sel.value : '';
    });
    if (answers.some(a => !a)) { writeOut('courseOut', 'Answer all questions.'); return; }

    writeOut('courseOut', 'Submitting...');
    try {
      const data = await postJSON('/api/openclaw/take-course', { endpoint, apiKey, courseId: currentCourse.id, answers });
      writeOut('courseOut', data);
    } catch (err) {
      writeOut('courseOut', 'Failed: ' + err.message);
    }
  }

  // ── Hire test ────────────────────────────────────────────────

  function applyCapabilityTemplate() {
    const templates = {
      dns_resolve: { hostname: 'clawsats.com', type: 'A' },
      fetch_url: { url: 'https://clawsats.com' },
      peer_health_check: { endpoint: 'http://vmi3083711.contaboserver.net:3321' },
      echo: { message: 'hello from mission control' }
    };
    el('capabilityParams').value = pretty(templates[el('capability').value] || {});
  }

  async function hire() {
    save();
    const endpoint = el('endpoint').value.trim();
    const apiKey = el('apiKey').value.trim();
    const targetEndpoint = el('targetEndpoint').value.trim();
    const capability = el('capability').value;
    if (!endpoint || !apiKey || !targetEndpoint || !capability) {
      writeOut('hireOut', 'All fields required.'); return;
    }

    let params;
    try { params = el('capabilityParams').value.trim() ? JSON.parse(el('capabilityParams').value) : {}; }
    catch (e) { writeOut('hireOut', 'Invalid JSON: ' + e.message); return; }

    const maxRaw = el('maxTotalSats').value.trim();
    writeOut('hireOut', 'Hiring...');
    try {
      const data = await postJSON('/api/openclaw/hire', {
        endpoint, apiKey, targetEndpoint, capability, params,
        maxTotalSats: maxRaw ? Number(maxRaw) : undefined
      });
      writeOut('hireOut', data);
    } catch (err) {
      writeOut('hireOut', 'Failed: ' + err.message);
    }
  }

  // ── Init ─────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    loadSaved();
    initTabs();
    initPipelineClicks();
    initFeedFilters();
    applyCapabilityTemplate();

    // Brain approval delegation
    document.addEventListener('click', function(ev) {
      const btn = ev.target.closest('.mc-approval-btn');
      if (!btn) return;
      handleBrainApproval(btn.dataset.job, btn.dataset.action);
    });

    el('btnConnect').addEventListener('click', connect);
    el('btnTestHealth').addEventListener('click', testHealth);
    el('btnLoadCourses').addEventListener('click', loadCourses);
    el('btnLoadCourse').addEventListener('click', loadCourse);
    el('btnSubmitQuiz').addEventListener('click', submitQuiz);
    el('btnHire').addEventListener('click', hire);
    el('btnExportDiag').addEventListener('click', exportDiagnostics);
    el('capability').addEventListener('change', applyCapabilityTemplate);
    if (el('btnAttest')) el('btnAttest').addEventListener('click', submitAttestation);

    // Auto-connect if endpoint was previously saved
    if (el('endpoint').value.trim()) {
      loadDashboard().then(() => {
        if (statusData) {
          connected = true;
          el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-ok">Connected</span>';
          updateHeaderStatus(statusData);
          startDashboardRefresh();
        }
      }).catch(() => {});
    }
  });
})();
