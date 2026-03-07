/**
 * onboard-demo.js — "Try a Claw" demo feature: step animation, result display.
 */
(function () {
  'use strict';
  var CP = window.CP;
  var el = CP.el, fmt = CP.fmt, short = CP.short, pretty = CP.pretty,
      postJSON = CP.postJSON, copyable = CP.copyable;

  function setDemoStep(stepId, state) {
    var step = el(stepId);
    if (!step) return;
    step.className = 'demo-step ' + state;
  }

  function resetDemoSteps() {
    ['ds-challenge', 'ds-pay', 'ds-execute', 'ds-receipt'].forEach(function (id) {
      setDemoStep(id, '');
    });
  }

  CP.loadDemoStatus = async function () {
    try {
      var res = await fetch('/api/demo/status');
      var data = await res.json();
      var badge = el('demoBudgetBadge');
      var card = el('demoCard');
      var btn = el('btnTryDemo');
      if (!data.enabled) { if (card) card.style.display = 'none'; return; }
      if (badge) {
        if (data.dailyRemaining !== null && data.dailyRemaining !== undefined) {
          var approxDemos = Math.floor(data.dailyRemaining / 27);
          badge.textContent = approxDemos > 0 ? approxDemos + ' demos left today' : 'Daily limit reached';
          if (approxDemos <= 0 && btn) btn.disabled = true;
        }
      }
    } catch (e) {
      var card = el('demoCard');
      if (card) card.style.display = 'none';
    }
  };

  CP.tryDemo = async function () {
    var btn = el('btnTryDemo');
    var stepsEl = el('demoSteps');
    var resultEl = el('demoResult');
    var errorEl = el('demoError');
    var statsEl = el('demoStats');
    var outputEl = el('demoOutput');

    if (btn) btn.disabled = true;
    if (stepsEl) stepsEl.style.display = 'block';
    if (resultEl) resultEl.style.display = 'none';
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
    resetDemoSteps();
    setDemoStep('ds-challenge', 'active');

    try {
      var data = await postJSON('/api/demo/try', {});
      var s = data.steps || {};
      setDemoStep('ds-challenge', s.challenge === 'ok' ? 'ok' : s.challenge === 'skipped' ? 'skipped' : 'error');
      setDemoStep('ds-pay', s.pay === 'ok' ? 'ok' : s.pay === 'skipped' ? 'skipped' : (s.pay === 'error' ? 'error' : 'ok'));
      setDemoStep('ds-execute', s.execute === 'ok' ? 'ok' : (s.execute === 'error' ? 'error' : 'ok'));
      setDemoStep('ds-receipt', s.receipt === 'ok' ? 'ok' : (s.receipt === 'missing' ? 'skipped' : 'ok'));

      if (data.success) {
        if (resultEl) resultEl.style.display = 'block';
        if (statsEl) {
          var costLabel = data.freeTrial ? 'Free trial' : fmt(data.cost.total) + ' sats';
          statsEl.innerHTML =
            '<div class="cp-stat cp-stat-green"><div class="cp-stat-num">&#x2713;</div><div class="cp-stat-lbl">Success</div></div>' +
            '<div class="cp-stat"><div class="cp-stat-num">' + costLabel + '</div><div class="cp-stat-lbl">Cost</div></div>' +
            (data.cost.capability > 0
              ? '<div class="cp-stat"><div class="cp-stat-num">' + fmt(data.cost.capability) + '</div><div class="cp-stat-lbl">Capability</div></div>' +
                '<div class="cp-stat"><div class="cp-stat-num">' + fmt(data.cost.fee) + '</div><div class="cp-stat-lbl">Protocol Fee</div></div>'
              : '') +
            (data.proof?.txid
              ? '<div class="cp-stat"><div class="cp-stat-num" style="font-size:.85rem;">' +
                copyable(data.proof.txid, 12) +
                '</div><div class="cp-stat-lbl">TX ID</div></div>'
              : '');
        }
        if (outputEl) {
          var output = '';
          if (data.result) {
            output += 'Result: ' + (typeof data.result === 'string' ? data.result : pretty(data.result)) + '\n';
          }
          if (data.receipt) {
            output += '\nReceipt ID: ' + (data.receipt.receiptId || '-') + '\n';
            output += 'Provider:   ' + short(data.receipt.provider, 24) + '\n';
            if (data.receipt.signature) output += 'Signature:  ' + short(data.receipt.signature, 32) + '\n';
          }
          if (data.proof?.whatsonchain) output += '\nView on chain: ' + data.proof.whatsonchain + '\n';
          if (data.freeTrial) {
            output += '\nThis was a free trial — your first call to any Claw is free.\n';
            output += 'Next call will use the full 402 payment flow.\n';
          }
          outputEl.textContent = output.trim();
        }
        CP.loadDemoStatus();
      }
    } catch (err) {
      if (errorEl) {
        errorEl.style.display = 'block';
        errorEl.textContent = err.message || 'Demo failed. Try again later.';
      }
      var errData = err.data || {};
      if (errData.steps) {
        Object.entries(errData.steps).forEach(function (entry) {
          setDemoStep('ds-' + entry[0], entry[1] === 'error' ? 'error' : (entry[1] === 'ok' ? 'ok' : entry[1]));
        });
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  };
})();
