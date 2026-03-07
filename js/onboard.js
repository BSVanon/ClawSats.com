/**
 * onboard.js — Entry point. Binds DOM events and calls init functions.
 * Requires: onboard-utils.js, onboard-connect.js, onboard-tabs.js,
 *           onboard-actions.js, onboard-courses.js, onboard-demo.js
 */
(function () {
  'use strict';
  var CP = window.CP;
  var el = CP.el;

  document.addEventListener('DOMContentLoaded', function () {
    CP.loadSaved();
    CP.initTabs();
    CP.initPipelineClicks();
    CP.initFeedFilters();
    CP.initQuickStart();
    CP.initStarPicker();
    CP.initApiKeyToggle();
    CP.applyCapabilityTemplate();

    // Load demo status (no connection required)
    CP.loadDemoStatus();

    // Brain approval delegation
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.mc-approval-btn');
      if (!btn) return;
      CP.handleBrainApproval(btn.dataset.job, btn.dataset.action);
    });

    el('btnConnect').addEventListener('click', CP.connect);
    if (el('btnTryDemo')) el('btnTryDemo').addEventListener('click', CP.tryDemo);
    el('btnTestHealth').addEventListener('click', CP.testHealth);
    el('btnLoadCourses').addEventListener('click', CP.loadCourses);
    el('btnLoadCourse').addEventListener('click', CP.loadCourse);
    el('btnSubmitQuiz').addEventListener('click', CP.submitQuiz);
    el('btnHire').addEventListener('click', CP.hire);
    el('btnExportDiag').addEventListener('click', CP.exportDiagnostics);
    el('capability').addEventListener('change', CP.applyCapabilityTemplate);
    if (el('btnAttest')) el('btnAttest').addEventListener('click', CP.submitAttestation);
    if (el('btnCreateAgent')) el('btnCreateAgent').addEventListener('click', CP.submitCreateAgent);
    if (el('btnCreateEscrow')) el('btnCreateEscrow').addEventListener('click', CP.submitCreateEscrow);
    if (el('btnSendMsg')) el('btnSendMsg').addEventListener('click', CP.submitSendMessage);
    if (el('btnOracleAttest')) el('btnOracleAttest').addEventListener('click', CP.submitOracleAttest);
    if (el('btnOracleReg')) el('btnOracleReg').addEventListener('click', CP.submitOracleRegister);

    // Auto-connect if endpoint was previously saved
    if (el('endpoint').value.trim()) {
      CP.loadDashboard().then(function () {
        if (CP.statusData) {
          CP.connected = true;
          el('connectStatus').innerHTML = '<span class="cp-badge cp-badge-ok">Connected</span>';
          CP.updateHeaderStatus(CP.statusData);
          CP.startDashboardRefresh();
        }
      }).catch(function () {});
    }
  });
})();
