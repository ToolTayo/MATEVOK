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

test("class workspaces keep the roster first and make the current tool visible in navigation", () => {
  assert.match(html, /data-nav-item="My Classes"/);
  assert.match(html, /data-nav-item="Overview"/);
  assert.match(app, /function requestWorkspaceNavigation\(label\)/);
  assert.match(app, /function navigateWorkspace\(label\)/);
  assert.match(html, /data-nav-item="Attendance"/);
  assert.match(html, /Inside a class/);
  assert.match(app, /document\.querySelectorAll\("\[data-nav-item\]"\)/);
  assert.match(app, /root\.append\(roster, tools\)/);
  assert.match(app, /function renderAuthoring\(\).*setWorkspaceLocation\("Assessment Center"\)/s);
  assert.match(css, /\.workspace-tools-grid \{ display: grid;/);
  assert.match(css, /\.nav-item\.is-current, \.nav-item\[data-current\]/);
  assert.match(css, /\.report-table-wrap--compact \.report-table \{ min-width: 0;/);
  assert.match(css, /html, body \{ max-width: 100%; overflow-x: clip;/);
});

test("class-only navigation is explicitly locked until a class is open and then exposes guarded destinations", () => {
  assert.match(html, /<p class="nav-label" id="class-tools-label">Inside a class<\/p>/);
  assert.match(html, /Open a class to use these tools\./);
  assert.match(html, /<button class="nav-item nav-item--available" data-nav-item="Attendance" type="button" disabled/);
  assert.match(app, /classIsOpen = Boolean\(state\.activeClass\)/);
  assert.match(app, /item\.disabled = !classIsOpen/);
  assert.match(app, /function requestScoreExit\(next\)/);
  assert.match(html, /data-dialog="leave-scores"/);
  assert.match(app, /data-class-tool": "Reports"/);
  assert.doesNotMatch(css, /content: "Go"/);
  assert.match(css, /grid-template-columns: 1\.35rem minmax\(0, 1fr\);/);
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

test("Student Progress only calls attendance missing when no statuses were recorded", () => {
  assert.match(app, /attendance\.recorded \? `Attendance rate \$\{attendance\.attendanceRate\}/);
  assert.match(app, /: "No attendance recorded\."/);
});

test("backup recency and the shared Gradebook assessment handoff remain visible without changing records", () => {
  assert.match(app, /function backupReminder\(\)/);
  assert.match(app, /noteBackupExport\(\)/);
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
