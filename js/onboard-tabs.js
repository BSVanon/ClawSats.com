/**
 * onboard-tabs.js — All render* functions for dashboard tabs,
 * pipeline stepper, UTXO bar, activity feed, header status, metrics bar.
 */
(function () {
  'use strict';
  var CP = window.CP;
  var el = CP.el, fmt = CP.fmt, short = CP.short, pretty = CP.pretty,
      copyable = CP.copyable, uptimeFmt = CP.uptimeFmt, ago = CP.ago;

  // ── Header status + metrics bar ─────────────────────────────
  CP.updateHeaderStatus = function (d) {
    var dot = el('headerDot');
    var text = el('connectStatusText');
    if (!dot || !text) return;
    if (CP.connected && d) {
      dot.className = 'mc-status-dot mc-status-dot--on';
      text.textContent = 'Connected';
      text.style.color = '#27c93f';
    } else {
      dot.className = 'mc-status-dot mc-status-dot--off';
      text.textContent = 'Disconnected';
      text.style.color = '';
    }
  };

  function updateMetricsBar(d) {
    var bar = el('metricsBar');
    if (!bar) return;
    if (d && CP.connected) {
      bar.style.display = '';
      var wallet = d.wallet || {};
      var econ = d.economy || {};
      var peers = d.peers || [];
      el('hb-balance').textContent = fmt(wallet.balanceSats || 0) + ' sats';
      el('hb-earned').textContent = fmt(econ.totalEarnedSats || 0) + ' sats';
      el('hb-peers').textContent = fmt(peers.length);
      el('hb-uptime').textContent = uptimeFmt(d.uptime || 0);
    } else {
      bar.style.display = 'none';
    }
  }

  function updateIndelibleNotices(d) {
    var indelibleEnabled = d && d.indelible && d.indelible.enabled;
    var tabs = ['agents', 'reputation', 'escrow', 'messages', 'oracles'];
    tabs.forEach(function (tab) {
      var notice = el('indelible-notice-' + tab);
      if (notice) notice.style.display = indelibleEnabled ? 'none' : 'flex';
    });
    var attestBtn = el('btnAttest');
    if (attestBtn) {
      attestBtn.disabled = !indelibleEnabled;
      attestBtn.title = indelibleEnabled ? '' : 'Requires Indelible.One subscription';
    }
  }

  // ── Coming-soon gating ──────────────────────────────────────
  function updatePhaseDGating(d) {
    var ind = d.indelible || {};
    CP.phaseDAvailable = !!(ind.enabled && ind.phaseDReady);
    document.querySelectorAll('.mc-phase-d').forEach(function (btn) {
      btn.disabled = !CP.phaseDAvailable;
      btn.title = CP.phaseDAvailable ? '' : 'Coming soon';
    });
    document.querySelectorAll('.mc-phase-d-notice').forEach(function (notice) {
      notice.style.display = CP.phaseDAvailable ? 'none' : '';
    });
  }

  // ── Global pipeline stepper ────────────────────────────────
  CP.updatePipeline = function (d) {
    var wrap = el('stepperWrap');
    if (wrap) wrap.style.display = '';
    var econ = d.economy || {};
    var wallet = d.wallet || {};
    var light = function (id, on) {
      var step = el(id);
      if (step) step.classList.toggle('lit', on);
    };
    light('pipe-wallet', (wallet.balanceSats || 0) > 0);
    light('pipe-brain', (d.brain?.completed || 0) > 0);
    light('pipe-memory', (d.memory?.totalMemories || 0) > 0);
    light('pipe-discover', (d.peers || []).length > 0);
    light('pipe-earn', (econ.totalEarnedSats || 0) > 0);
    light('pipe-spend', (econ.totalSpentSats || 0) > 0);
  };

  CP.initPipelineClicks = function () {
    document.querySelectorAll('.cp-pipe-click').forEach(function (step) {
      step.addEventListener('click', function () {
        var nav = step.dataset.nav;
        if (!nav) return;
        var parts = nav.split('/');
        var category = parts[0], tab = parts[1];
        var cats = document.querySelectorAll('.mc-cat');
        cats.forEach(function (c) { c.classList.remove('active'); });
        var catBtn = document.querySelector('.mc-cat[data-category="' + category + '"]');
        if (catBtn) catBtn.classList.add('active');
        CP.activeCategory = category;
        document.querySelectorAll('.mc-subtab-group').forEach(function (g) { g.classList.remove('active'); });
        var group = document.querySelector('.mc-subtab-group[data-category="' + category + '"]');
        if (group) group.classList.add('active');
        CP.activateSubTab(tab);
      });
    });
  };

  // ── UTXO health bar ────────────────────────────────────────
  function renderUtxoBar(d) {
    var bar = el('utxoBar');
    if (!bar) return;
    var wallet = d.wallet || {};
    var total = wallet.utxoTotal || 0;
    if (total === 0) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    var avail = wallet.utxoAvailable || 0;
    var locked = wallet.utxoLocked || 0;
    var stuck = wallet.utxoStuck || 0;
    var pct = function (n) { return Math.max(0, Math.min(100, (n / total) * 100)).toFixed(1) + '%'; };
    el('utxoFillAvail').style.width = pct(avail);
    el('utxoFillLocked').style.width = pct(locked);
    el('utxoFillStuck').style.width = pct(stuck);
    el('utxoAvailNum').textContent = avail;
    el('utxoTotalNum').textContent = total;
    var lockedLabel = el('utxoLockedLabel');
    if (lockedLabel) { lockedLabel.style.display = locked > 0 ? '' : 'none'; el('utxoLockedNum').textContent = locked; }
    var stuckLabel = el('utxoStuckLabel');
    if (stuckLabel) { stuckLabel.style.display = stuck > 0 ? '' : 'none'; el('utxoStuckNum').textContent = stuck; }
  }

  // ── Activity feed ──────────────────────────────────────────
  function classifyFeedType(source, type) {
    if (source === 'earning' || type === 'earn' || type === 'payment_received') return 'earn';
    if (source === 'spending' || type === 'spend' || type === 'hire' || type === 'payment_sent') return 'spend';
    if (source === 'peer' || source === 'network' || type === 'peer_discovered' || type === 'peer_stale') return 'peer';
    if (source === 'brain' || type === 'decision' || type === 'brain_job') return 'brain';
    return 'system';
  }

  function renderActivityFeed(d) {
    var feedEl = el('overviewFeed');
    if (!feedEl) return;
    var feed = d.activityFeed || [];
    if (feed.length === 0) {
      feedEl.innerHTML = '<li class="mc-feed-item" style="color:var(--muted)">No activity yet.</li>';
      return;
    }
    var items = feed.map(function (e) { return { cls: classifyFeedType(e.source, e.type), e: e }; });
    var filtered = CP.feedFilter === 'all' ? items : items.filter(function (i) { return i.cls === CP.feedFilter; });
    feedEl.innerHTML = filtered.map(function (item) {
      var cls = item.cls, e = item.e;
      var ts = e.ts || '';
      var d2 = ts ? new Date(ts) : null;
      var datePart = d2 ? (String(d2.getMonth()+1).padStart(2,'0') + '/' +
        String(d2.getDate()).padStart(2,'0') + '/' +
        String(d2.getFullYear()).slice(-2)) : '';
      var timePart = ts.substring(11, 19);
      var datetime = datePart ? datePart + ' ' + timePart : timePart;
      var msg = (e.type || '') + (e.capability ? ' ' + e.capability : '');
      var satsHtml = '';
      if (e.sats) {
        var isPos = cls === 'earn';
        satsHtml = '<span class="mc-feed-sats ' + (isPos ? 'mc-feed-sats--pos' : 'mc-feed-sats--neg') + '">' +
          (isPos ? '+' : '-') + fmt(e.sats) + '</span>';
      }
      return '<li class="mc-feed-item" data-type="' + cls + '">' +
        '<span class="mc-feed-type mc-feed-type--' + cls + '">' + cls + '</span>' +
        '<span class="mc-feed-msg">' + msg + '</span>' +
        satsHtml +
        '<span class="mc-feed-time">' + datetime + '</span></li>';
    }).join('');
  }
  CP.renderActivityFeed = renderActivityFeed;

  CP.initFeedFilters = function () {
    var wrap = el('feedFilters');
    if (!wrap) return;
    wrap.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.mc-feed-filter');
      if (!btn) return;
      wrap.querySelectorAll('.mc-feed-filter').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      CP.feedFilter = btn.dataset.filter;
      if (CP.statusData) renderActivityFeed(CP.statusData);
      else if (CP.connectData) renderActivityFeed(CP.connectData);
    });
  };

  // ── Tab renderers ──────────────────────────────────────────

  function renderOverview(d) {
    var econ = d.economy || {};
    var rep = d.reputation || {};
    var wallet = d.wallet || {};
    el('os-balance').textContent = fmt(wallet.balanceSats || 0);
    el('os-earned').textContent = fmt(econ.totalEarnedSats || 0);
    el('os-spent').textContent = fmt(econ.totalSpentSats || 0);
    el('os-net').textContent = fmt(econ.netIncomeSats || 0);
    el('os-calls').textContent = fmt(rep.totalCallsServed || 0);
    el('os-uptime').textContent = uptimeFmt(d.uptime || 0);
    var caps = d.capabilities || [];
    var tbody = caps.map(function (c) {
      return '<tr><td>' + c.name + '</td><td class="num">' + c.pricePerCall + '</td>' +
        '<td class="num">' + fmt(c.callsServed || 0) + '</td>' +
        '<td class="num">' + fmt(c.revenueSats || 0) + '</td></tr>';
    }).join('');
    el('overviewCaps').querySelector('tbody').innerHTML = tbody || '<tr><td colspan="4" style="color:var(--muted)">No capabilities</td></tr>';
    renderActivityFeed(d);
    renderUtxoBar(d);
    renderIndelibleOverview(d);
  }

  function renderEarning(d) {
    var econ = d.economy || {};
    var rep = d.reputation || {};
    el('es-earned').textContent = fmt(econ.totalEarnedSats || 0);
    el('es-calls').textContent = fmt(rep.totalCallsServed || 0);
    el('es-callers').textContent = fmt(rep.uniqueCallers || 0);
    el('es-fees').textContent = fmt(econ.protocolFeesCollected || 0);
    el('es-referrals').textContent = fmt(rep.referralsEarned || 0);
    var caps = d.capabilities || [];
    var rows = caps.map(function (c) {
      var calls = c.callsServed || 0;
      var rev = c.revenueSats || 0;
      var avg = calls > 0 ? (rev / calls).toFixed(1) : '-';
      var trial = c.pricePerCall > 0 ? '<span class="cp-badge cp-badge-ok">Yes</span>' : '<span style="color:var(--muted)">N/A</span>';
      return '<tr><td>' + c.name + '</td><td class="num">' + c.pricePerCall + '</td>' +
        '<td class="num">' + fmt(calls) + '</td><td class="num">' + fmt(rev) + '</td>' +
        '<td class="num">' + avg + '</td><td>' + trial + '</td></tr>';
    }).join('');
    el('earningTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="6" style="color:var(--muted)">No earnings yet</td></tr>';
  }

  function renderSpending(d) {
    var econ = d.economy || {};
    var hiring = d.hiring || {};
    el('ss-spent').textContent = fmt(econ.totalSpentSats || 0);
    el('ss-hires').textContent = fmt(hiring.totalHires || 0);
    el('ss-fees').textContent = fmt(econ.protocolFeesPaid || 0);
    el('ss-mining').textContent = fmt(econ.miningFeesPaid || 0);
    var hires = hiring.recentHires || [];
    var total = hires.length;
    var successes = hires.filter(function (h) { return !h.error && h.status !== 'failed'; }).length;
    el('ss-success').textContent = total > 0 ? Math.round((successes / total) * 100) + '%' : '-';
    var rows = hires.map(function (h) {
      var ok = !h.error && h.status !== 'failed';
      var badge = ok ? '<span class="cp-badge cp-badge-ok">OK</span>'
        : '<span class="cp-badge cp-badge-err">' + short(h.error || 'Failed', 20) + '</span>';
      return '<tr><td>' + (h.capability || '-') + '</td>' +
        '<td>' + short(h.peerIdentity || '-', 16) + '</td>' +
        '<td class="num">' + fmt(h.costSats || 0) + '</td>' +
        '<td>' + badge + '</td><td>' + ago(h.timestamp) + '</td></tr>';
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
    var r = Math.max(0, Math.min(100, rep || 0));
    return '<span class="mc-rep-bar">' +
      '<span class="mc-rep-track"><span class="mc-rep-fill" style="width:' + r + '%;background:' + repColor(r) + '"></span></span>' +
      '<span style="font-size:.75rem;color:' + repColor(r) + '">' + r + '</span></span>';
  }

  function renderNetwork(d) {
    var net = d.network || {};
    var peers = d.peers || [];
    el('ns-healthy').textContent = fmt(net.healthyPeers || 0);
    el('ns-stale').textContent = fmt(net.stalePeers || 0);
    el('ns-new').textContent = fmt(net.newPeersThisWeek || 0);
    el('ns-total').textContent = fmt(peers.length);
    if (peers.length > 0) {
      var avg = peers.reduce(function (s, p) { return s + (p.reputation || 0); }, 0) / peers.length;
      el('ns-avgrep').textContent = avg.toFixed(0);
    } else {
      el('ns-avgrep').textContent = '-';
    }
    var rows = peers.slice(0, 30).map(function (p) {
      return '<tr><td>' + copyable(p.identityKey, 16) + '</td>' +
        '<td>' + copyable(p.endpoint, 35) + '</td>' +
        '<td class="num">' + repBar(p.reputation) + '</td>' +
        '<td>' + ago(p.lastSeenAt) + '</td></tr>';
    }).join('');
    var more = peers.length > 30 ? '<tr><td colspan="4" style="color:var(--muted)">...and ' + (peers.length - 30) + ' more</td></tr>' : '';
    el('networkTable').querySelector('tbody').innerHTML = (rows + more) || '<tr><td colspan="4" style="color:var(--muted)">No peers</td></tr>';
  }

  // ── Brain tab ────────────────────────────────────────────────
  function brainDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return String(d.getMonth()+1).padStart(2,'0') + '/' +
      String(d.getDate()).padStart(2,'0') + '/' +
      String(d.getFullYear()).slice(-2) + ' ' +
      String(d.getHours()).padStart(2,'0') + ':' +
      String(d.getMinutes()).padStart(2,'0');
  }

  function brainDateTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return String(d.getMonth()+1).padStart(2,'0') + '/' +
      String(d.getDate()).padStart(2,'0') + '/' +
      String(d.getFullYear()).slice(-2) + ' ' +
      ts.substring(11, 19);
  }

  function renderBrain(d) {
    var brain = d.brain || {};
    el('bs-pending').textContent = fmt(brain.pending || 0);
    el('bs-completed').textContent = fmt(brain.completed || 0);
    el('bs-failed').textContent = fmt(brain.failed || 0);
    el('bs-approval').textContent = fmt(brain.needsApproval || 0);
    el('bs-conf').textContent = brain.avgConfidence || '-';
    var breakers = brain.circuitBreakers || [];
    el('bs-safety').textContent = fmt(breakers.length);
    var safetyStat = el('bs-safety-stat');
    if (safetyStat) safetyStat.className = breakers.length > 0 ? 'cp-stat cp-stat-red' : 'cp-stat cp-stat-green';
    var approvals = brain.pendingApprovals || [];
    var approvalCard = el('brainApprovalCard');
    if (approvalCard) {
      if (approvals.length > 0 || (brain.needsApproval || 0) > 0) {
        approvalCard.style.display = '';
        el('approvalCount').textContent = approvals.length || brain.needsApproval || 0;
        if (approvals.length > 0) {
          el('brainApprovals').innerHTML = approvals.map(function (a) {
            return '<div class="mc-approval-item">' +
              '<span class="cp-badge cp-badge-warn">' + (a.tool || a.action || 'gated') + '</span> ' +
              '<span style="flex:1;font-size:.82rem;">' + short(a.reason || a.description || 'Pending approval', 60) + '</span>' +
              '<div class="mc-approval-actions">' +
              '<button class="mc-approval-btn mc-approval-btn--approve" data-job="' + (a.jobId || a.id || '') + '" data-action="approve">Approve</button>' +
              '<button class="mc-approval-btn mc-approval-btn--reject" data-job="' + (a.jobId || a.id || '') + '" data-action="reject">Reject</button>' +
              '</div></div>';
          }).join('');
        } else {
          el('brainApprovals').innerHTML = '<div style="color:var(--muted);font-size:.82rem;padding:.4rem;">' +
            (brain.needsApproval || 0) + ' actions pending (details not available via API yet)</div>';
        }
      } else {
        approvalCard.style.display = 'none';
      }
    }
    el('brainBreakers').innerHTML = breakers.length > 0
      ? breakers.map(function (b) { return '<span class="cp-badge cp-badge-err">' + b + '</span> '; }).join('')
      : '<span style="color:#27c93f">All tools operating normally</span>';
    var recent = brain.recent || [];
    if (recent.length > 0) {
      var statusCls = { completed: 'cp-badge-ok', failed: 'cp-badge-err', pending: 'cp-badge-warn', needs_approval: 'cp-badge-warn', running: 'cp-badge-warn' };
      el('brainJobs').innerHTML = '<div style="display:flex;flex-direction:column;gap:2px;">' + recent.map(function (j) {
        var cls = statusCls[j.status] || '';
        var dt = brainDate(j.createdAt);
        return '<div style="display:flex;align-items:center;gap:.5rem;">' +
          '<span class="cp-badge ' + cls + '" style="font-size:.65rem;min-width:60px;text-align:center;">' + (j.status || '-') + '</span>' +
          '<span style="flex:1;">' + (j.capability || '-') + ' <span style="color:var(--muted)">(' + (j.strategy || '-') + ')</span></span>' +
          (j.error ? '<span style="color:#e63946;font-size:.75rem;">ERR: ' + short(j.error, 30) + '</span>' : '') +
          '<span style="color:var(--muted);font-family:\'IBM Plex Mono\',monospace;font-size:.72rem;margin-left:auto;">' + dt + '</span></div>';
      }).join('') + '</div>';
    } else {
      el('brainJobs').innerHTML = '<span style="color:var(--muted)">No brain jobs.</span>';
    }
    var events = d.recentEvents || [];
    if (events.length > 0) {
      el('brainEvents').innerHTML = '<div style="display:flex;flex-direction:column;gap:2px;">' + events.map(function (e) {
        var dt = brainDateTime(e.ts);
        return '<div style="display:flex;align-items:baseline;gap:.5rem;">' +
          '<span style="flex:1;">' + (e.action || '') +
          (e.details && e.details.confidence ? ' <span style="color:var(--muted)">(conf: ' + e.details.confidence + ')</span>' : '') +
          (e.reason ? ': ' + short(e.reason, 70) : '') + '</span>' +
          '<span style="color:var(--muted);font-family:\'IBM Plex Mono\',monospace;font-size:.72rem;margin-left:auto;white-space:nowrap;">' + dt + '</span></div>';
      }).join('') + '</div>';
    } else {
      el('brainEvents').innerHTML = '<span style="color:var(--muted)">No activity yet.</span>';
    }
  }

  // ── Memory tab ──────────────────────────────────────────────
  function renderMemory(d) {
    var mem = d.memory || {};
    var ind = d.indelible || {};
    el('ms-records').textContent = fmt(mem.totalMemories || 0);
    el('ms-index').textContent = mem.masterIndexTxid ? 'Yes' : 'No';
    var storageEl = el('ms-storage');
    if (storageEl) {
      storageEl.innerHTML = ind.enabled
        ? '<span style="color:#27c93f">Indelible.One</span>'
        : '<span>BSV Blockchain</span>';
    }
    var lastWriteEl = el('ms-lastwrite');
    if (lastWriteEl) {
      lastWriteEl.textContent = mem.newestMemory ? ago(mem.newestMemory) : '';
      if (!mem.newestMemory) lastWriteEl.innerHTML = '<span style="color:var(--muted)">Never</span>';
    }
    var lines = [];
    if ((mem.totalMemories || 0) > 0) {
      lines.push('Records: ' + fmt(mem.totalMemories));
      lines.push('On-chain data: ' + fmt(mem.totalOnChainBytes || 0) + ' bytes across ' + fmt(mem.totalTransactions || 0) + ' transactions');
      if (mem.encryptedCount) lines.push('Encrypted: ' + fmt(mem.encryptedCount) + '  |  Plaintext: ' + fmt(mem.plaintextCount || 0));
      if (mem.oldestMemory) lines.push('Oldest: ' + ago(mem.oldestMemory));
      if (mem.newestMemory) lines.push('Newest: ' + ago(mem.newestMemory));
      if (mem.categories) {
        var cats = Object.entries(mem.categories).map(function (e) { return e[0] + ': ' + e[1]; }).join(', ');
        if (cats) lines.push('Categories: ' + cats);
      }
      if (mem.masterIndexTxid) lines.push('Master index: ' + mem.masterIndexTxid);
    } else {
      lines.push('No memories recorded yet.');
      lines.push('Memories are written when the brain stores knowledge on-chain via OP_RETURN transactions.');
    }
    el('memoryDetails').textContent = lines.join('\n');
    renderSessionBrowser(d);
  }

  // ── Education tab ──────────────────────────────────────────
  function renderEducation(d) {
    var edu = d.education || {};
    var completed = edu.coursesCompleted || [];
    var available = edu.coursesAvailable || 0;
    el('edu-completed').textContent = fmt(completed.length);
    el('edu-available').textContent = fmt(available);
    el('edu-taught').textContent = fmt(edu.quizzesServed || 0);
    var attempts = edu.quizAttempts || 0;
    var passes = edu.quizPasses || 0;
    el('edu-passrate').textContent = attempts > 0 ? Math.round((passes / attempts) * 100) + '%' : '-';
    var pct = available > 0 ? Math.round((completed.length / available) * 100) : 0;
    el('edu-progress-label').textContent = completed.length + ' / ' + available + ' completed';
    el('edu-progress-pct').textContent = pct + '%';
    var bar = el('edu-progress-bar');
    if (bar) bar.style.width = pct + '%';
  }

  // ── Diagnostics tab ────────────────────────────────────────
  function renderDiagnostics(d) {
    var wallet = d.wallet || {};
    var econ = d.economy || {};
    el('dx-utxo-total').textContent = fmt(wallet.utxoTotal || 0);
    el('dx-utxo-avail').textContent = fmt(wallet.utxoAvailable || 0);
    el('dx-utxo-locked').textContent = fmt(wallet.utxoLocked || 0);
    el('dx-utxo-stuck').textContent = fmt(wallet.utxoStuck || 0);
    el('dx-503').textContent = fmt(econ.total503s || 0);
    el('dx-concurrency').textContent = fmt(wallet.concurrencySlots || 0);
    var wHtml = [];
    wHtml.push('Balance: ' + fmt(wallet.balanceSats || 0) + ' sats');
    if (wallet.identityKey) wHtml.push('Identity key: ' + copyable(wallet.identityKey, 20));
    if (wallet.fundingAddress) wHtml.push('Funding address: ' + copyable(wallet.fundingAddress, 34));
    wHtml.push('UTXO pool: ' + fmt(wallet.utxoTotal || 0) + ' total, ' + fmt(wallet.utxoAvailable || 0) + ' available');
    if (wallet.utxoStuck > 0) wHtml.push('Stuck UTXOs: ' + wallet.utxoStuck + ' (locked > 5 min)');
    wHtml.push('Concurrency slots: ' + fmt(wallet.concurrencySlots || 0));
    el('diagWallet').innerHTML = wHtml.join('\n');
    el('diagRaw').textContent = pretty(d);
  }

  // ── Indelible Overview ─────────────────────────────────────
  function renderIndelibleOverview(d) {
    var ind = d.indelible;
    var statsRow = el('overviewIndelibleStats');
    var chartWrap = el('overviewChart');
    if (!ind || !ind.enabled) {
      if (statsRow) statsRow.style.display = 'none';
      if (chartWrap) chartWrap.style.display = 'none';
      return;
    }
    if (statsRow) {
      statsRow.style.display = '';
      var s = ind.stats || {};
      var w = ind.wallet || {};
      el('os-saves').textContent = fmt(s.totalSaves || 0);
      el('os-loads').textContent = fmt(s.totalLoads || 0);
      el('os-agents').textContent = fmt(s.activeAgents || 0);
      el('os-saves-today').textContent = fmt(s.savesToday || 0);
      el('os-onchain-bytes').textContent = fmt(w.totalBytes || 0);
    }
    var daily = ind.stats?.dailyStats;
    if (chartWrap && Array.isArray(daily) && daily.length > 0) {
      chartWrap.style.display = '';
      var canvas = el('activityChart');
      if (canvas && canvas.getContext) {
        var ctx = canvas.getContext('2d');
        var W = canvas.width = canvas.parentElement.clientWidth || 600;
        var H = canvas.height = 120;
        ctx.clearRect(0, 0, W, H);
        var max = Math.max.apply(null, daily.map(function (d2) { return (d2.saves || 0) + (d2.loads || 0); }).concat([1]));
        var barW = Math.max(4, (W - 20) / daily.length - 2);
        daily.forEach(function (day, i) {
          var val = (day.saves || 0) + (day.loads || 0);
          var barH = (val / max) * (H - 20);
          var x = 10 + i * (barW + 2);
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

  // ── Session Browser ────────────────────────────────────────
  function renderSessionBrowser(d) {
    var card = el('sessionBrowserCard');
    var ind = d.indelible;
    if (!card) return;
    if (!ind || !ind.enabled || !ind.sessions || Object.keys(ind.sessions).length === 0) {
      card.style.display = 'none';
      var sd = el('sessionDetailCard');
      if (sd) sd.style.display = 'none';
      return;
    }
    card.style.display = '';
    var entries = Object.entries(ind.sessions);
    var rows = entries.map(function (entry, i) {
      var addr = entry[0], s = entry[1];
      return '<tr><td>' + copyable(addr, 16) + '</td>' +
        '<td class="num">' + fmt(s.count || 0) + '</td>' +
        '<td class="num">' + fmt(s.messageCount || 0) + '</td>' +
        '<td class="num">' + fmt(s.bytes || 0) + '</td>' +
        '<td><button class="btn btn-sm" onclick="window._viewSession(' + i + ')">Details</button></td></tr>';
    }).join('');
    el('sessionTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="5" style="color:var(--muted)">No sessions</td></tr>';
  }

  // ── Render all ─────────────────────────────────────────────
  CP.renderAll = function (d) {
    CP.updateHeaderStatus(d);
    updateMetricsBar(d);
    updateIndelibleNotices(d);
    CP.updatePipeline(d);
    updatePhaseDGating(d);
    renderOverview(d);
    renderEarning(d);
    renderSpending(d);
    renderNetwork(d);
    renderBrain(d);
    renderMemory(d);
    renderEducation(d);
    CP.renderAgents(d);
    CP.renderReputation(d);
    CP.renderEscrow(d);
    CP.renderMessages(d);
    CP.renderOracles(d);
    renderDiagnostics(d);
  };
})();
