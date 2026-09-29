import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../dist/styles.css", import.meta.url), "utf8");
const headers = readFileSync(new URL("../dist/_headers", import.meta.url), "utf8");

test("first-use guidance explains the reusable local teacher workflow without sample records", () => {
  assert.match(app, /function firstUseGuide\(\)/);
  assert.match(app, /Create a class/);
  assert.match(app, /Add students once/);
  assert.match(app, /Attendance, Gradebook, Assessments, Lessons, Classroom Mode, Progress, or Reports/);
  assert.doesNotMatch(app, /Sample class|Demo class|Sample student|Demo student/);
  assert.doesNotMatch(app, /Your workspace is ready/);
});

test("workspace context, dialog return focus, and small-screen dialog scrolling remain available", () => {
  assert.match(html, /data-current-location>My Classes/);
  assert.match(app, /function setWorkspaceLocation\(label\)/);
  assert.match(app, /dialogReturnFocus: \{\}/);
  assert.match(app, /state\.dialogReturnFocus\[name\]/);
  assert.match(app, /delete state\.dialogReturnFocus\[name\]/);
  assert.match(app, /button:not\(\.icon-button\):not\(\.button--danger\)/);
  assert.match(css, /dialog \{[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/);
  assert.match(css, /@media \(max-width: 700px\) \{ \.first-use-steps \{ grid-template-columns: 1fr;/);
  assert.match(css, /@media \(max-width: 700px\) \{ \.status-button, \.attendance-date input, \.score-input/);
});

test("Progress and Lesson search refresh results in place so typing keeps input focus and caret", () => {
  assert.match(app, /function renderProgressStudentResults\(\)[\s\S]*?host\.replaceChildren\(\.\.\.progressStudentResults\(\)\)/);
  assert.match(app, /state\.progressSearch = event\.currentTarget\.value; renderProgressStudentResults\(\);/);
  assert.doesNotMatch(app, /state\.progressSearch = event\.currentTarget\.value; renderProgressWorkspace\(\);/);
  assert.match(app, /function renderLessonWorkspaceResults\(\)[\s\S]*?host\.replaceChildren\(\.\.\.lessonWorkspaceResults\(current\)\)/);
  assert.match(app, /state\.lessonSearch = event\.currentTarget\.value; renderLessonWorkspaceResults\(\);/);
  assert.doesNotMatch(app, /state\.lessonSearch = event\.currentTarget\.value; renderLessonWorkspace\(\);/);
  assert.match(app, /"data-progress-results"/);
  assert.match(app, /"data-lesson-results"/);
});

test("Student Progress explains an empty active roster and links directly to class Overview", () => {
  assert.match(app, /function progressStudentResults\(\)/);
  assert.match(app, /if \(!state\.students\.length\)[\s\S]*?No active students yet/);
  assert.match(app, /Add or restore students in this class’s roster from Overview before reviewing progress/);
  assert.match(app, /action\("Open class Overview", renderClass, "button button--quiet"\)/);
});

test("mobile breadcrumb and identified module actions have practical 44px touch targets", () => {
  assert.match(css, /@media \(max-width: 700px\) \{\s*\.crumb-nav \.button, \.crumb-nav \.link-button,[\s\S]*?min-height: 44px;/);
});

test("class workspaces keep the roster first and make the current tool visible in navigation", () => {
  assert.match(html, /data-nav-item="My Classes"/);
  assert.match(html, /data-nav-item="Overview"/);
  assert.match(app, /function requestWorkspaceNavigation\(label\)/);
  assert.match(app, /function navigateWorkspace\(label\)/);
  assert.match(html, /data-nav-item="Attendance"/);
  assert.match(html, /Inside a class/);
  assert.match(app, /document\.querySelectorAll\("\[data-nav-item\]"\)/);
  assert.match(app, /root\.append\(todayWorkspace\(current\), roster, tools\)/);
  assert.match(app, /function renderAuthoring\(\).*setWorkspaceLocation\("Assessment Center"\)/s);
  assert.match(css, /\.workspace-tools-grid \{ display: grid;/);
  assert.match(css, /\.nav-item\.is-current, \.nav-item\[data-current\]/);
  assert.match(css, /\.report-table-wrap--compact \.report-table \{ min-width: 0;/);
  assert.match(css, /html, body \{ max-width: 100%; overflow-x: clip;/);
});

test("Class Overview derives compact Today actions from existing class records only", () => {
  assert.match(app, /function todayWorkspace\(current\)/);
  assert.match(app, /function todayAttendanceCard\(current\)/);
  assert.match(app, /saved \? "Reopen today" : "Take attendance"/);
  assert.match(app, /function todayScoresCard\(current\)/);
  assert.match(app, /overviewScoreCounts/);
  assert.match(app, /activeStudentIds\.has\(score\.studentId\)/);
  assert.match(app, /Scores · \$\{assessment\.title\}/);
  assert.match(app, /of \$\{activeCount\} active scores entered/);
  assert.match(app, /function todayLessonCard\(current\)/);
  assert.match(app, /Last edited \$\{lessonUpdatedAt\(lesson\)\}/);
  assert.match(app, /function todayClassroomCard\(current\)/);
  assert.match(app, /Start Classroom Mode/);
  assert.match(app, /todayWorkspace\(current\).*backupReminder\(\)/s);
  assert.match(css, /\/\* Class Overview: factual next actions derived from existing local records\. \*\//);
  assert.match(css, /\.today-grid \{ display: grid;/);
});

test("class-scoped navigation resolves an active class instead of disabling teacher tools", () => {
  assert.match(html, /<p class="nav-label" id="class-tools-label">Inside a class<\/p>/);
  assert.match(html, /Choose a class to open a tool\./);
  assert.match(html, /<button class="nav-item nav-item--available" data-nav-item="Attendance" type="button" aria-describedby="class-tools-hint"/);
  assert.doesNotMatch(html, /data-nav-item="Attendance" type="button" disabled/);
  assert.match(app, /classIsOpen = Boolean\(state\.activeClass\)/);
  assert.match(app, /if \(item instanceof HTMLButtonElement\) item\.disabled = false/);
  assert.match(app, /function requestClassTool\(label\)/);
  assert.match(app, /resolveClassToolDestination\(await listClasses\(\)\)/);
  assert.match(app, /if \(!state\.activeClass\) \{ requestClassTool\(label\); closeMenu\(\); return; \}/);
  assert.match(app, /prepClass\(null, session\.label\)/);
  assert.match(app, /form\.dataset\.openTool = openTool/);
  assert.match(app, /if \(openTool\) navigateWorkspace\(openTool\)/);
  assert.match(html, /data-dialog="class-tool"/);
  assert.match(html, /data-class-tool-choices/);
  assert.match(app, /function requestScoreExit\(next\)/);
  assert.match(html, /data-dialog="leave-scores"/);
  assert.match(app, /data-class-tool": "Reports"/);
  assert.doesNotMatch(css, /content: "Go"/);
  assert.match(css, /grid-template-columns: 1\.35rem minmax\(0, 1fr\);/);
});

test("class navigation is grouped in the teacher workflow order while tools remain available to choose a class", () => {
  const destinations = [
    "Overview", "Attendance", "Gradebook", "Assessment Center", "Lesson Workspace",
    "Classroom Mode", "Student Progress", "Reports"
  ];
  const positions = destinations.map((label) => html.indexOf(`data-nav-item=\"${label}\"`));

  assert.ok(positions.every((position) => position >= 0));
  assert.ok(positions.every((position, index) => index === 0 || positions[index - 1] < position));
  assert.match(html, /id="nav-daily-label">Daily/);
  assert.match(html, /id="nav-teach-label">Prepare &amp; teach/);
  assert.match(html, /id="nav-review-label">Review/);
  assert.doesNotMatch(html, /data-nav-item="Classroom Mode" type="button" disabled/);
  assert.match(css, /\.nav-item--available:disabled \{ color: #a8bfbc;/);
  assert.match(css, /\.primary-nav \{ min-height: 0; overflow-y: auto; overscroll-behavior: contain;/);
});

test("score entry advances only after per-row validation and keeps explicit saving", () => {
  assert.match(app, /function validateScoreRow\(row\)/);
  assert.match(app, /function advanceScoreInput\(studentId, input\)/);
  assert.match(app, /advanceScoreInput\(row\.studentId, event\.currentTarget\)/);
  assert.match(app, /Fix the highlighted score before moving on\./);
  assert.match(app, /"aria-invalid": error \? "true" : null/);
  assert.match(app, /const result = error \? null : el\("span"/);
  assert.match(app, /action\("Save scores", persistScores/);
});

test("Paste scores is a reviewed, draft-only Gradebook path", () => {
  assert.match(html, /data-dialog="score-paste"/);
  assert.match(html, /Blank lines never erase an existing score/);
  assert.match(html, /name="confirmPaste" type="checkbox" disabled/);
  assert.match(app, /import \{ reviewPastedScores \} from "\.\/score-paste\.js"/);
  assert.match(app, /action\("Paste scores", prepScorePaste/);
  assert.match(app, /function renderScorePasteReview\(\)/);
  assert.match(app, /replaces an unsaved edit/);
  assert.match(app, /Remove them before applying so no score can be shifted to the wrong student/);
  assert.match(app, /function applyPastedScores\(\)/);
  assert.match(app, /Select Save scores to store/);
  assert.match(css, /\.score-paste-review-wrap \{ max-height:/);
});

test("cross-class content copy reviews its destination and creates a safe independent Draft", () => {
  assert.match(html, /data-dialog="copy-content"/);
  assert.match(html, /name="confirmCopy" type="checkbox" disabled/);
  assert.match(html, /Students, scores, attendance, reports, progress, and Classroom Mode data are never copied\./);
  assert.match(app, /action\("Copy to another class", \(\) => prepCopyContent\("assessment", assessment\)/);
  assert.match(app, /action\("Copy to another class", \(\) => prepCopyContent\("lesson", lesson\)/);
  assert.match(app, /function prepCopyContent\(kind, source\)/);
  assert.match(app, /listClasses\(\)\)\.filter\(\(entry\) => entry\.id !== state\.activeClass\.id\)/);
  assert.match(app, /copy\.submitting = true/);
  assert.match(app, /function openCopiedContent\(\)/);
  assert.match(app, /copyAuthoredAssessmentToClass/);
  assert.match(app, /copyLessonToClass/);
  assert.match(css, /\.copy-content-review \{ display: grid;/);
});

test("Student Progress only calls attendance missing when no statuses were recorded", () => {
  assert.match(app, /attendance\.recorded \? `Attendance rate \$\{attendance\.attendanceRate\}/);
  assert.match(app, /: "No attendance recorded\."/);
});

test("attendance date changes replace stale controls with a guarded loading state", () => {
  assert.match(app, /const request = \{\};/);
  assert.match(app, /state\.attendance = \{ date, loading: true, request \};/);
  assert.match(app, /if \(state\.attendance\?\.request !== request\) return;/);
  assert.match(app, /if \(!session \|\| session\.loading\) return;/);
  assert.match(app, /Opening attendance for \$\{session\.date\}…/);
  assert.match(app, /attendance-screen--loading/);
});

test("backup recency and the shared Gradebook assessment handoff remain visible without changing records", () => {
  assert.match(app, /function backupReminder\(\)/);
  assert.match(app, /noteBackupExport\(\)/);
  assert.match(app, /function refreshBackupReminder\(\)/);
  assert.match(app, /noteBackupExport\(\); refreshBackupReminder\(\);/);
  assert.match(app, /noteClassroomChange\(\)/);
  assert.match(app, /Create shared assessments and enter scores/);
  assert.match(app, /same shared Gradebook assessments/);
  assert.match(css, /\.backup-recency \{ display: flex;/);
});

test("My Classes keeps its home composition compact and makes existing class information scannable", () => {
  assert.match(app, /class: "page-heading dashboard-heading"/);
  assert.match(app, /class: "dashboard-utilities"/);
  assert.match(app, /class: "class-list", "data-count": state\.classes\.length/);
  assert.match(app, /class: "class-card-details"/);
  assert.match(app, /class: "class-card-schedule"/);
  assert.match(app, /Roster not added yet\. 0 active students\./);
  assert.match(html, /<title>MATEVOK<\/title>/);
  assert.match(html, /aria-label="MATEVOK navigation"/);
  assert.match(html, /MATEVOK · private, local-only teacher workspace/);
  assert.doesNotMatch(html, /Teacher Workspace · working title/);
  assert.match(css, /\/\* My Classes: compact home composition/);
  assert.match(css, /\.class-list\[data-count="1"\]/);
  assert.match(css, /\.dashboard-utilities \{ display: flex;/);
});

test("strict same-origin CSP does not block startup recovery or the cached shell", () => {
  assert.match(headers, /script-src 'self'/);
  assert.match(html, /<script src="startup\.js\?v=14"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(app, /serviceWorker\.register/);
});
