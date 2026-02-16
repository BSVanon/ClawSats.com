(function () {
  const STORAGE_KEY = 'clawsats_onboard_v1';
  let currentCourse = null;

  const el = (id) => document.getElementById(id);
  const endpointEl = el('endpoint');
  const apiKeyEl = el('apiKey');
  const courseSelectEl = el('courseSelect');
  const quizWrapEl = el('quizWrap');
  const quizActionsEl = el('quizActions');
  const capabilityEl = el('capability');
  const paramsEl = el('capabilityParams');

  function pretty(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function writeOut(id, value) {
    el(id).textContent = typeof value === 'string' ? value : pretty(value);
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.endpoint) endpointEl.value = saved.endpoint;
      if (saved.apiKey) apiKeyEl.value = saved.apiKey;
      if (saved.targetEndpoint) el('targetEndpoint').value = saved.targetEndpoint;
      if (saved.maxTotalSats) el('maxTotalSats').value = saved.maxTotalSats;
    } catch {}
  }

  function save() {
    const payload = {
      endpoint: endpointEl.value.trim(),
      apiKey: apiKeyEl.value.trim(),
      targetEndpoint: el('targetEndpoint').value.trim(),
      maxTotalSats: el('maxTotalSats').value.trim()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  async function postJSON(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data && data.error ? data.error : `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return data;
  }

  async function connect() {
    save();
    const endpoint = endpointEl.value.trim();
    if (!endpoint) {
      writeOut('connectOut', 'Enter your OpenClaw endpoint first.');
      return;
    }

    writeOut('connectOut', 'Checking endpoint...');
    try {
      const data = await postJSON('/api/openclaw/connect', { endpoint });
      writeOut('connectOut', data);
      if (Array.isArray(data?.courses)) {
        populateCourses(data.courses);
      }
    } catch (err) {
      writeOut('connectOut', `Connection failed: ${err.message}`);
    }
  }

  function populateCourses(courses) {
    if (!Array.isArray(courses) || courses.length === 0) {
      courseSelectEl.innerHTML = '<option value="">No courses found</option>';
      return;
    }

    const options = courses
      .slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((c) => {
        const state = c.completed ? 'completed' : (c.prerequisitesMet ? 'ready' : 'locked');
        return `<option value="${c.id}">${c.id} — ${c.title} (${state})</option>`;
      });
    courseSelectEl.innerHTML = options.join('');
  }

  async function loadCourses() {
    save();
    const endpoint = endpointEl.value.trim();
    if (!endpoint) {
      writeOut('courseOut', 'Enter endpoint first.');
      return;
    }

    writeOut('courseOut', 'Loading courses...');
    try {
      const data = await postJSON('/api/openclaw/courses', { endpoint });
      populateCourses(data.courses || []);
      writeOut('courseOut', {
        endpoint: data.endpoint,
        totalAvailable: data.totalAvailable,
        completedByThisClaw: data.completedByThisClaw
      });
    } catch (err) {
      writeOut('courseOut', `Load failed: ${err.message}`);
    }
  }

  async function loadCourse() {
    save();
    const endpoint = endpointEl.value.trim();
    const courseId = courseSelectEl.value;
    if (!endpoint || !courseId) {
      writeOut('courseOut', 'Pick a course first.');
      return;
    }

    writeOut('courseOut', `Loading course ${courseId}...`);
    quizWrapEl.innerHTML = '';
    quizActionsEl.style.display = 'none';

    try {
      const data = await postJSON('/api/openclaw/course', { endpoint, courseId });
      const course = data.course;
      currentCourse = course;

      const quizHtml = (course.quiz || []).map((q, idx) => {
        const opts = (q.options || []).map((opt, optIdx) => {
          const name = `q_${idx}`;
          const value = String(opt).replace(/"/g, '&quot;');
          return `<label class="quiz-option"><input type="radio" name="${name}" value="${value}"> ${opt}</label>`;
        }).join('');
        return `<div class="quiz-q"><p>Q${idx + 1}. ${q.question}</p>${opts}</div>`;
      }).join('');

      quizWrapEl.innerHTML = `
        <div class="panel-note" style="margin-bottom:.7rem;">
          <strong>${course.title}</strong><br>
          ${course.summary}<br>
          Passing score: ${Math.round((course.passingScore || 0) * 100)}%
        </div>
        ${quizHtml}
      `;
      quizActionsEl.style.display = (course.quiz || []).length ? 'flex' : 'none';
      writeOut('courseOut', {
        courseId: course.id,
        title: course.title,
        questionCount: course.questionCount,
        prerequisites: course.prerequisites
      });
    } catch (err) {
      writeOut('courseOut', `Course load failed: ${err.message}`);
    }
  }

  function collectAnswers() {
    if (!currentCourse || !Array.isArray(currentCourse.quiz)) return [];
    return currentCourse.quiz.map((_, idx) => {
      const selected = document.querySelector(`input[name="q_${idx}"]:checked`);
      return selected ? selected.value : '';
    });
  }

  async function submitQuiz() {
    save();
    const endpoint = endpointEl.value.trim();
    const apiKey = apiKeyEl.value.trim();
    if (!endpoint) {
      writeOut('courseOut', 'Enter endpoint first.');
      return;
    }
    if (!apiKey) {
      writeOut('courseOut', 'API key is required to submit a course quiz.');
      return;
    }
    if (!currentCourse) {
      writeOut('courseOut', 'Load a course first.');
      return;
    }

    const answers = collectAnswers();
    if (answers.some((a) => !a)) {
      writeOut('courseOut', 'Answer every question before submitting.');
      return;
    }

    writeOut('courseOut', 'Submitting quiz...');
    try {
      const data = await postJSON('/api/openclaw/take-course', {
        endpoint,
        apiKey,
        courseId: currentCourse.id,
        answers
      });
      writeOut('courseOut', data);
    } catch (err) {
      writeOut('courseOut', `Quiz submit failed: ${err.message}`);
    }
  }

  function applyCapabilityTemplate() {
    const cap = capabilityEl.value;
    const templates = {
      dns_resolve: { hostname: 'clawsats.com', type: 'A' },
      fetch_url: { url: 'https://clawsats.com' },
      peer_health_check: { endpoint: 'http://vmi3083711.contaboserver.net:3321' },
      echo: { message: 'hello from claw panel' }
    };
    paramsEl.value = pretty(templates[cap] || {});
  }

  async function hire() {
    save();
    const endpoint = endpointEl.value.trim();
    const apiKey = apiKeyEl.value.trim();
    const targetEndpoint = el('targetEndpoint').value.trim();
    const capability = capabilityEl.value;

    if (!endpoint || !apiKey || !targetEndpoint || !capability) {
      writeOut('hireOut', 'endpoint, api key, target endpoint, and capability are required.');
      return;
    }

    let params;
    try {
      params = paramsEl.value.trim() ? JSON.parse(paramsEl.value) : {};
    } catch (err) {
      writeOut('hireOut', `Invalid JSON params: ${err.message}`);
      return;
    }

    const maxRaw = el('maxTotalSats').value.trim();
    const maxTotalSats = maxRaw ? Number(maxRaw) : undefined;

    writeOut('hireOut', 'Submitting hire request...');
    try {
      const data = await postJSON('/api/openclaw/hire', {
        endpoint,
        apiKey,
        targetEndpoint,
        capability,
        params,
        maxTotalSats
      });
      writeOut('hireOut', data);
    } catch (err) {
      writeOut('hireOut', `Hire failed: ${err.message}`);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    loadSaved();
    applyCapabilityTemplate();

    el('btnSave').addEventListener('click', function () {
      save();
      writeOut('connectOut', 'Saved endpoint/API key in this browser.');
    });
    el('btnConnect').addEventListener('click', connect);
    el('btnLoadCourses').addEventListener('click', loadCourses);
    el('btnLoadCourse').addEventListener('click', loadCourse);
    el('btnSubmitQuiz').addEventListener('click', submitQuiz);
    el('btnHire').addEventListener('click', hire);
    capabilityEl.addEventListener('change', applyCapabilityTemplate);
  });
})();
