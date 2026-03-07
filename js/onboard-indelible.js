/**
 * onboard-indelible.js — Phase D Indelible tab renderers:
 * Agents, Reputation, Escrow, Messages, Oracles.
 */
(function () {
  'use strict';
  var CP = window.CP;
  var el = CP.el, fmt = CP.fmt, short = CP.short, copyable = CP.copyable, ago = CP.ago;

  // ── Agents tab ─────────────────────────────────────────────
  CP.renderAgents = function (d) {
    var ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('ag-count').textContent = '-';
      el('ag-caps').textContent = '-';
      el('agentRoster').querySelector('tbody').innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    var roster = ind.roster || [];
    el('ag-count').textContent = fmt(roster.length);
    el('ag-caps').textContent = fmt(roster.reduce(function (sum, a) { return sum + (a.capabilities?.length || 0); }, 0));
    var rows = roster.map(function (a) {
      return '<tr><td>' + (a.name || '-') + '</td><td>' + copyable(a.pubkey, 16) + '</td>' +
        '<td>' + (a.capabilities || []).join(', ') + '</td><td>' + ago(a.createdAt) + '</td></tr>';
    }).join('');
    el('agentRoster').querySelector('tbody').innerHTML = rows || '<tr><td colspan="4" style="color:var(--muted)">No agents registered</td></tr>';
  };

  // ── Reputation helpers ────────────────────────────────────
  CP.trustGauge = function (score) {
    var s = Math.max(0, Math.min(100, score || 0));
    var r = 13, circ = 2 * Math.PI * r;
    var offset = circ - (s / 100) * circ;
    var color = s >= 70 ? '#27c93f' : s >= 40 ? '#f5a623' : '#e63946';
    return '<span class="mc-trust-gauge">' +
      '<svg class="mc-trust-ring" viewBox="0 0 32 32">' +
      '<circle class="mc-trust-ring-bg" cx="16" cy="16" r="' + r + '"/>' +
      '<circle class="mc-trust-ring-fill" cx="16" cy="16" r="' + r + '" ' +
      'stroke="' + color + '" stroke-dasharray="' + circ.toFixed(1) + '" ' +
      'stroke-dashoffset="' + offset.toFixed(1) + '"/>' +
      '</svg><span class="mc-trust-val" style="color:' + color + '">' + s.toFixed(0) + '</span></span>';
  };

  CP.starDisplay = function (rating) {
    var n = Math.round(Math.max(0, Math.min(5, rating || 0)));
    var s = '';
    for (var i = 1; i <= 5; i++) s += '<span class="mc-star' + (i <= n ? ' lit' : '') + '">&#9733;</span>';
    return '<span class="mc-stars" style="cursor:default;font-size:.9rem;">' + s + '</span>';
  };

  // ── Reputation tab ────────────────────────────────────────
  CP.renderReputation = function (d) {
    var ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('rp-agents').textContent = '-';
      el('rp-attestations').textContent = '-';
      el('reputationTable').querySelector('tbody').innerHTML = '<tr><td colspan="7" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    var rep = ind.reputation || {};
    var entries = Object.entries(rep);
    var totalReviews = entries.reduce(function (sum, e) { return sum + (e[1].attestationCount || 0); }, 0);
    el('rp-agents').textContent = fmt(entries.length);
    el('rp-attestations').textContent = fmt(totalReviews);
    var rows = entries.map(function (entry) {
      var key = entry[0], r = entry[1];
      var b = r.breakdown || {};
      return '<tr><td>' + copyable(key, 16) + '</td>' +
        '<td class="num">' + CP.trustGauge(r.score) + '</td>' +
        '<td class="num">' + CP.starDisplay(b.avgRating) + '</td>' +
        '<td class="num">' + (b.volumeBonus || 0).toFixed(1) + '</td>' +
        '<td class="num">' + (b.diversityBonus || 0).toFixed(1) + '</td>' +
        '<td class="num">' + (b.recencyBonus || 0).toFixed(1) + '</td>' +
        '<td class="num">' + fmt(r.attestationCount || 0) + '</td></tr>';
    }).join('');
    el('reputationTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="7" style="color:var(--muted)">No reviews yet</td></tr>';
    CP.populateAgentPicker(d);
  };

  // ── Escrow tab ────────────────────────────────────────────
  CP.renderEscrow = function (d) {
    var ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('esc-active').textContent = '-';
      el('esc-total-sats').textContent = '-';
      el('escrowTable').querySelector('tbody').innerHTML = '<tr><td colspan="7" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    var escrows = ind.escrows || [];
    var active = escrows.filter(function (e) { return e.status === 'pending' || e.status === 'accepted'; });
    el('esc-active').textContent = fmt(active.length);
    el('esc-total-sats').textContent = fmt(active.reduce(function (s, e) { return s + (e.amount || 0); }, 0));
    var statusBadge = function (s) {
      var cls = s === 'released' ? 'ok' : s === 'disputed' ? 'err' : s === 'expired' ? 'warn' : 'ok';
      return '<span class="cp-badge cp-badge-' + cls + '">' + s + '</span>';
    };
    var escrowActions = function (e) {
      var dis = CP.phaseDAvailable ? '' : ' disabled title="Coming soon"';
      if (e.status === 'pending') return '<button class="btn btn-sm mc-phase-d"' + dis + ' onclick="window._escrowAction(\'' + e.id + '\',\'accept\')">Accept</button>';
      if (e.status === 'accepted') return '<button class="btn btn-sm mc-phase-d"' + dis + ' onclick="window._escrowAction(\'' + e.id + '\',\'release\')">Release</button> ' +
        '<button class="btn btn-sm btn-danger mc-phase-d"' + dis + ' onclick="window._escrowAction(\'' + e.id + '\',\'dispute\')">Dispute</button>';
      return '<span style="color:var(--muted)">-</span>';
    };
    var rows = escrows.map(function (e) {
      return '<tr><td>' + short(e.id, 12) + '</td><td>' + statusBadge(e.status) + '</td>' +
        '<td class="num">' + fmt(e.amount || 0) + '</td><td>' + copyable(e.payeePubKey, 12) + '</td>' +
        '<td>' + short(e.description, 30) + '</td><td>' + ago(e.expiresAt) + '</td>' +
        '<td>' + escrowActions(e) + '</td></tr>';
    }).join('');
    el('escrowTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="7" style="color:var(--muted)">No escrows</td></tr>';
  };

  // ── Messages tab ──────────────────────────────────────────
  CP.renderMessages = function (d) {
    var ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('msg-channels').textContent = '-';
      el('messageTable').querySelector('tbody').innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      var tc = el('msgThreadCard');
      if (tc) tc.style.display = 'none';
      return;
    }
    var channels = ind.channels || [];
    el('msg-channels').textContent = fmt(channels.length);
    var rows = channels.map(function (ch, i) {
      return '<tr><td>' + (ch.participants || []).map(function (p) { return short(p, 12); }).join(', ') + '</td>' +
        '<td>' + (ch.lastAction || '-') + '</td><td>' + ago(ch.lastTimestamp) + '</td>' +
        '<td><button class="btn btn-sm" onclick="window._viewThread(' + i + ')">View</button></td></tr>';
    }).join('');
    el('messageTable').querySelector('tbody').innerHTML = rows || '<tr><td colspan="4" style="color:var(--muted)">No channels</td></tr>';
  };

  // ── Oracles tab ───────────────────────────────────────────
  CP.renderOracles = function (d) {
    var ind = d.indelible;
    if (!ind || !ind.enabled) {
      el('or-registries').textContent = '-';
      el('or-attestations').textContent = '-';
      el('oracleRegTable').querySelector('tbody').innerHTML = '<tr><td colspan="3" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      el('oracleAttTable').querySelector('tbody').innerHTML = '<tr><td colspan="5" style="color:var(--muted)">Connect to Indelible.One to enable</td></tr>';
      return;
    }
    var regs = ind.oracleRegistries || [];
    var atts = ind.oracleAttestations || [];
    el('or-registries').textContent = fmt(regs.length);
    el('or-attestations').textContent = fmt(atts.length);
    var regRows = regs.map(function (r) {
      return '<tr><td>' + copyable(r.agentPubKey, 16) + '</td><td>' + (r.dataTypes || []).join(', ') + '</td>' +
        '<td>' + copyable(r.endpoint, 30) + '</td></tr>';
    }).join('');
    el('oracleRegTable').querySelector('tbody').innerHTML = regRows || '<tr><td colspan="3" style="color:var(--muted)">No oracle registries</td></tr>';
    var attRows = atts.map(function (a) {
      return '<tr><td>' + (a.dataType || '-') + '</td><td>' + short(a.value, 20) + '</td>' +
        '<td>' + short(a.source, 16) + '</td><td class="num">' + ((a.confidence || 0) * 100).toFixed(0) + '%</td>' +
        '<td>' + ago(a.timestamp) + '</td></tr>';
    }).join('');
    el('oracleAttTable').querySelector('tbody').innerHTML = attRows || '<tr><td colspan="5" style="color:var(--muted)">No data points published</td></tr>';
  };
})();
