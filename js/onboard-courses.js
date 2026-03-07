/**
 * onboard-courses.js — Course browsing, quiz flow, submission.
 */
(function () {
  'use strict';
  var CP = window.CP;
  var el = CP.el, postJSON = CP.postJSON, writeOut = CP.writeOut, pretty = CP.pretty;

  CP.populateCourses = function (courses) {
    var sel = el('courseSelect');
    if (!Array.isArray(courses) || courses.length === 0) {
      sel.innerHTML = '<option value="">No courses found</option>';
      return;
    }
    sel.innerHTML = courses
      .slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); })
      .map(function (c) {
        var state = c.completed ? 'completed' : (c.prerequisitesMet ? 'ready' : 'locked');
        return '<option value="' + c.id + '">' + c.id + ' - ' + c.title + ' (' + state + ')</option>';
      }).join('');
  };

  CP.loadCourses = async function () {
    CP.save();
    var endpoint = el('endpoint').value.trim();
    if (!endpoint) { writeOut('courseOut', 'Enter endpoint first.'); return; }
    writeOut('courseOut', 'Loading courses...');
    try {
      var data = await postJSON('/api/openclaw/courses', { endpoint: endpoint });
      CP.populateCourses(data.courses || []);
      writeOut('courseOut', { totalAvailable: data.totalAvailable, completedByThisClaw: data.completedByThisClaw });
    } catch (err) {
      writeOut('courseOut', 'Failed: ' + err.message);
    }
  };

  CP.loadCourse = async function () {
    CP.save();
    var endpoint = el('endpoint').value.trim();
    var courseId = el('courseSelect').value;
    if (!endpoint || !courseId) { writeOut('courseOut', 'Pick a course first.'); return; }
    writeOut('courseOut', 'Loading ' + courseId + '...');
    el('quizWrap').innerHTML = '';
    el('quizActions').style.display = 'none';
    try {
      var data = await postJSON('/api/openclaw/course', { endpoint: endpoint, courseId: courseId });
      var course = data.course;
      CP.currentCourse = course;
      var quizHtml = (course.quiz || []).map(function (q, idx) {
        var opts = (q.options || []).map(function (opt) {
          var val = String(opt).replace(/"/g, '&quot;');
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
  };

  CP.submitQuiz = async function () {
    CP.save();
    var endpoint = el('endpoint').value.trim();
    var apiKey = el('apiKey').value.trim();
    if (!endpoint) { writeOut('courseOut', 'Enter endpoint.'); return; }
    if (!apiKey) { writeOut('courseOut', 'API key required.'); return; }
    if (!CP.currentCourse) { writeOut('courseOut', 'Load a course first.'); return; }
    var answers = (CP.currentCourse.quiz || []).map(function (_, i) {
      var sel = document.querySelector('input[name="q_' + i + '"]:checked');
      return sel ? sel.value : '';
    });
    if (answers.some(function (a) { return !a; })) { writeOut('courseOut', 'Answer all questions.'); return; }
    writeOut('courseOut', 'Submitting...');
    try {
      var data = await postJSON('/api/openclaw/take-course', {
        endpoint: endpoint, apiKey: apiKey, courseId: CP.currentCourse.id, answers: answers
      });
      writeOut('courseOut', data);
    } catch (err) {
      writeOut('courseOut', 'Failed: ' + err.message);
    }
  };
})();
