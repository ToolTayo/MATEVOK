import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
const storage = readFileSync(new URL("../dist/storage.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../dist/styles.css", import.meta.url), "utf8");
const headers = readFileSync(new URL("../dist/_headers", import.meta.url), "utf8");

test("first-use guidance explains the reusable local teacher workflow without sample records", () => {
  assert.match(app, /function firstUseGuide\(\)/);
  assert.match(app, /Create a class/);
  assert.match(app, /Add students once/);
  assert.match(app, /Attendance, Gradebook, Assessment Center, Lessons, Classroom Mode, Student Progress, or Reports/);
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

test("Escape closes ordinary dialogs through focus restoration but cannot dismiss the workspace lock", () => {
  const cancelHandling = app.match(/Object\.entries\(dialogs\)\.forEach\(\(\[name, dialog\]\) => dialog\.addEventListener\("cancel", \(event\) => \{[\s\S]*?\}\)\);/)?.[0] || "";
  assert.ok(cancelHandling);
  assert.match(cancelHandling, /event\.preventDefault\(\)/);
  assert.match(cancelHandling, /name === "workspace-lock"[\s\S]*?\[data-workspace-retry\][\s\S]*?focus\(\)/);
  assert.match(cancelHandling, /hide\(name\)/);
  assert.match(app, /function hide\(name\)[\s\S]*?requestAnimationFrame\(\(\) => \{ if \(returnFocus\?\.isConnected\) returnFocus\.focus\(\); \}\)/);
  assert.match(app, /document\.addEventListener\("keydown", \(event\) => \{ if \(event\.key !== "Escape"\) return; if \(dialogs\["workspace-lock"\]\.open\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); dialogs\["workspace-lock"\]\.querySelector\("\[data-workspace-retry\]"\)\?\.focus\(\); return; \}/);
});

test("Overview, Student Progress, and Reports request records only for the open class", () => {
  assert.match(app, /async function refreshActiveClass\(\) \{ if \(!state\.activeClass\) return; const found = await getRecord\("classes", state\.activeClass\.id\)/);
  assert.match(app, /listAttendanceHistory\(found\.id\), listAssessments\(found\.id\), listLessons\(found\.id\), listScoresForClass\(found\.id\)/);
  assert.match(app, /deriveStudentProgress\(\{ student, classId, attendance: records\[0\], assessments: state\.assessments, scores: records\[1\] \}\)/);
  assert.match(app, /listAttendanceRecords\(classId\), listScoresForClass\(classId\)/);
  assert.match(app, /listAttendanceRecords\(state\.activeClass\.id\), listScoresForClass\(state\.activeClass\.id\)/);
  assert.doesNotMatch(app, /getAllRecords\("(?:students|attendance|assessments|scores|questions|questionOptions|lessons)"/);
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

test("opening a copied class lesson restores its active class workspace navigation", () => {
  const lessonEditor = app.match(/function renderLessonEditor\(\)[\s\S]*?(?=function lessonPrintSection\()/)?.[0] || "";
  assert.match(lessonEditor, /if \(!current \|\| !session\) \{ renderLessonWorkspace\(\); return; \} setWorkspaceLocation\("Lesson Workspace"\);/);
  assert.match(app, /async function openCopiedContent\(\)[\s\S]*?state\.activeClass = success\.target;[\s\S]*?showLessonEditor\(success\.item\)/);
});

test("Student Progress explains an empty active roster and links directly to class Overview", () => {
  assert.match(app, /function progressStudentResults\(\)/);
  assert.match(app, /if \(!state\.students\.length\)[\s\S]*?No active students yet/);
  assert.match(app, /Add or restore students in this class’s roster from Overview before reviewing progress/);
  assert.match(app, /action\("Open class Overview", renderClass, "button button--quiet"\)/);
});

test("active Student Progress history routes to exact Attendance and score records without editing them", () => {
  const attendanceRoute = app.match(/async function openProgressAttendance\(entry\)[\s\S]*?(?=async function openProgressScore\(entry\))/)?.[0] || "";
  const scoreRoute = app.match(/async function openProgressScore\(entry\)[\s\S]*?(?=function progressStudentList\()/)?.[0] || "";
  const progressDetail = app.match(/function renderStudentProgress\(\)[\s\S]*?(?=function renderProgressPrint\()/)?.[0] || "";
  assert.match(progressDetail, /canEditHistory = !progress\.student\.archivedAt && !state\.activeClass\?\.archivedAt && progress\.classId === state\.activeClass\?\.id/);
  assert.match(progressDetail, /action\("Review date", \(\) => openProgressAttendance\(entry\)/);
  assert.match(progressDetail, /action\("Open score entry", \(\) => openProgressScore\(entry\)/);
  assert.match(attendanceRoute, /listAttendanceForDate\(context\.classId, entry\.date\)/);
  assert.match(attendanceRoute, /openAttendance\(entry\.date, \{ focusStudentId: student\.id, progressReturn: \{ classId: context\.classId, student \}, requireRecordedStudent: true \}\)/);
  assert.match(attendanceRoute, /That attendance record is no longer available/);
  assert.match(attendanceRoute, /state\.activeClass\?\.id !== context\.classId/);
  assert.match(scoreRoute, /listAssessments\(context\.classId\)/);
  assert.match(scoreRoute, /item\.id === entry\.assessmentId && item\.classId === context\.classId/);
  assert.match(scoreRoute, /openAssessment\(currentAssessment, \{ focusStudentId: student\.id, progressReturn:/);
  assert.match(scoreRoute, /This assessment is no longer available/);
  assert.match(app, /function focusAttendanceStudent\(studentId\).*row\.scrollIntoView\?\.\(\{ block: "center" \}\); row\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /function focusProgressScoreInput\(studentId\).*input\.scrollIntoView\?\.\(\{ block: "center" \}\); input\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /action\(session\.progressReturn \? "← Student Progress" : "← Gradebook", \(\) => requestScoreExit\(/);
  assert.match(app, /function requestAttendanceExit\(next\) \{ if \(state\.attendance\?\.dirty\)/);
  assert.match(app, /function requestScoreExit\(next\) \{ if \(state\.scoreSession\?\.dirty\)/);
  assert.doesNotMatch(attendanceRoute + scoreRoute, /saveAttendance\(|saveScores\(/);
  assert.match(css, /\.progress-history-action \{[^}]*min-height: 2\.75rem;/);
  assert.match(css, /@media print \{ \.progress-history-action \{ display: none !important; \} \}/);
});

test("mobile breadcrumb and identified module actions have practical 44px touch targets", () => {
  assert.match(css, /@media \(max-width: 700px\) \{\s*\.crumb-nav \.button, \.crumb-nav \.link-button,[\s\S]*?min-height: 44px;/);
  assert.match(css, /\.backup-recency-actions \.link-button \{ min-height: 44px;/);
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

test("Classroom Mode exposes balanced group-count and maximum-size workflows in the existing session", () => {
  assert.match(app, /groupMode: "count", message: "", timer: createTimer\(\)/);
  assert.match(app, /function freshClassroomSession\(classId\).*groupSize: "", groupMode: "count"/);
  assert.match(app, /Grouping method/);
  assert.match(app, /Number of groups/);
  assert.match(app, /Students per group/);
  assert.match(app, /Maximum students per group/);
  assert.match(app, /generateBalancedGroupsBySize\(classroomRoster\(\), session\.groupSize, secureUnit\)/);
  assert.match(app, /Choose a whole-number maximum from 1 to \$\{roster\.length\}/);
  assert.match(app, /function classroomRoster\(\) \{ return state\.students\.filter\(\(student\) => !student\.archivedAt\); \}/);
  assert.match(app, /function copyClassroomGroups\(\).*groupsPlainText\(session\.groups, classroomRoster\(\)\)/);
  assert.match(app, /function renderClassroomDisplay\(\).*session\.groups \? classroomGroupCards\(session\.groups, roster\)/);
  assert.match(css, /\.group-mode-select select \{[^}]*min-height: 2\.8rem;/);
  assert.match(css, /@media \(max-width: 700px\) \{ \.classroom-hero, \.classroom-tool-heading, \.group-input-row \{[^}]*flex-direction: column;/);
});

test("empty-roster Today cards direct teachers to add students, then retain the normal actions", () => {
  const attendance = app.match(/function todayAttendanceCard\(current\)[\s\S]*?(?=function todayScoresCard\(current\))/)?.[0] || "";
  const scores = app.match(/function todayScoresCard\(current\)[\s\S]*?(?=function todayLessonCard\(current\))/)?.[0] || "";
  assert.match(app, /function todayAddStudentsAction\(\) \{ return action\("Add students", \(\) => \{ const heading = root\.querySelector\("#roster-heading"\); heading\?\.scrollIntoView\(\{ block: "center" \}\); heading\?\.focus\(\{ preventScroll: true \}\); \}, "button"\); \}/);
  assert.doesNotMatch(app.match(/function todayAddStudentsAction\(\)[^\n]*/)?.[0] || "", /prepStudent\(/);
  assert.match(attendance, /if \(!state\.students\.length\) return todayCard\("Attendance", "Add students before taking attendance\.", todayAddStudentsAction\(\)\)/);
  assert.match(attendance, /saved \? "Reopen today" : "Take attendance"/);
  assert.match(scores, /if \(!activeCount\) return todayCard\("Scores", "Add students before entering scores\.", todayAddStudentsAction\(\)\)/);
  assert.ok(scores.indexOf("if (!activeCount)") < scores.indexOf("if (!state.assessments.length)"), "roster setup must precede assessment creation guidance");
  assert.match(scores, /action\("Continue scores"/);
});

test("first-time empty states explain Assessment Center and My Materials without changing their workflows", () => {
  assert.match(app, /Create an assessment here or in Gradebook\. Add questions if you want printable student copies or an answer key for that same assessment\./);
  assert.match(app, /action\("Create assessment", \(\) => prepAssessment\(null, true\), "button"\)/);
  assert.match(app, /Choose Save to My Materials on a lesson or assessment in its class workspace\. You can add an independent Draft to another class later\./);
  assert.doesNotMatch(app, /Save a persisted Lesson or authored Assessment from its class list/);
});

test("an empty class can copy active names from another class without bringing its history", () => {
  const rosterCopy = storage.match(/export async function copyActiveRosterToEmptyClass\([\s\S]*?(?=export async function setStudentArchived)/)?.[0] || "";
  const rosterUi = app.match(/function renderRosterCopyReview\([\s\S]*?(?=function copyKindLabel\()/)?.[0] || "";
  const rosterSubmit = app.match(/async function confirmRosterCopy\([\s\S]*?(?=function copyKindLabel\()/)?.[0] || "";
  assert.match(app, /const canCopyRoster = !current\.archivedAt && !state\.students\.length && !state\.archivedStudents\.length/);
  assert.match(app, /action\("Copy roster from another class", prepRosterCopy/);
  assert.match(app, /async function prepRosterCopy\(\)[\s\S]*?\[\.\.\.activeClasses, \.\.\.archivedClasses\]\.filter\(\(item\) => item\.id !== target\.id && item\.studentCount > 0\)/);
  assert.match(app, /item\.archivedAt \? `\$\{item\.className\} · Archived source` : item\.className/);
  assert.match(rosterUi, /Source · \$\{copy\.sourceClassName\}\$\{copy\.sourceArchived \? " \(archived, read-only\)" : ""\} → Destination · \$\{copy\.targetClassName\}/);
  assert.match(rosterUi, /new independent records/);
  assert.match(rosterSubmit, /copy\.submitting \|\| !form\.elements\.confirmCopy\.checked/);
  assert.match(rosterSubmit, /copyActiveRosterToEmptyClass\(sourceId, copy\.targetClassId\)/);
  assert.match(rosterCopy, /db\.transaction\(\["classes", "students"\], "readwrite"\)/);
  assert.match(rosterCopy, /students\.index\("classId"\)\.getAll\(classId\)/);
  assert.match(rosterCopy, /if \(targetStudents\.length\)/);
  assert.match(rosterCopy, /sourceStudents\.filter\(\(student\) => !student\.archivedAt\)/);
  assert.match(rosterCopy, /prepareStudent\(\{ fullName: student\.fullName \}, targetId\)/);
  assert.doesNotMatch(rosterCopy, /saveAttendance\(|saveScores\(|classroomState|assessments|progress|reports/);
  assert.match(html, /data-dialog="copy-roster"[\s\S]*?Archived classes can be read-only sources[\s\S]*?I reviewed the source and destination[\s\S]*?Copy roster/);
});

test("class-scoped navigation resolves an active class instead of disabling teacher tools", () => {
  assert.match(html, /<p class="nav-label" id="class-tools-label">Inside a class<\/p>/);
  assert.match(html, /Choose a class to open a tool\./);
  assert.match(html, /<button class="nav-item nav-item--available" data-nav-item="Attendance" type="button" aria-describedby="class-tools-hint"/);
  assert.doesNotMatch(html, /data-nav-item="Attendance" type="button" disabled/);
  assert.match(app, /classIsOpen = Boolean\(state\.activeClass\)/);
  assert.match(app, /if \(item instanceof HTMLButtonElement\) item\.disabled = false/);
  assert.match(app, /function requestClassTool\(label\)/);
  assert.match(app, /state\.classes = await listClasses\(\);\s*const destination = resolveClassToolDestination\(state\.classes\)/);
  assert.match(app, /if \(label !== "My Materials" && !state\.activeClass\) \{ requestClassTool\(label\); closeMenu\(\); return; \}/);
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

test("open-class switcher keeps the current module and restricts destinations to active classes", () => {
  assert.match(app, /const switchClassButton = action\("Switch class", requestClassSwitch, "nav-switch-class"\)/);
  assert.match(app, /const hasOtherActiveClass = classIsOpen && !state\.activeClass\.archivedAt && state\.classes\.some\(\(item\) => !item\.archivedAt && item\.id !== state\.activeClass\.id\)/);
  assert.match(app, /const classes = state\.classes\.filter\(\(item\) => item\.id !== current\.id\)/);
  assert.match(app, /const label = document\.querySelector\("\[data-nav-item\]\[data-current\]"\)\?\.dataset\.navItem \|\| "Overview"/);
  assert.match(app, /Choose an active class\. MATEVOK will keep you in \$\{session\.label\}; each class's records stay separate\./);
  assert.match(app, /if \(session\.kind === "switch"\) \{ switchClassAfterGuards\(item, session\.label\); return; \}/);
  assert.match(app, /const selected = await getRecord\("classes", classItem\.id\);[\s\S]*?if \(!selected \|\| selected\.archivedAt\) throw new Error\("That class is no longer available/);
  assert.match(css, /\.nav-switch-class \{[^}]*min-height: 2\.75rem;/);
  assert.match(css, /\.nav-switch-class:focus-visible/);
});

test("class switching passes through every existing unsaved-work guard", () => {
  assert.match(app, /function switchClassAfterGuards\(classItem, label\) \{[\s\S]*?if \(state\.attendance\) requestAttendanceExit\(\{ type: "action", run: next \}\);\s*else if \(state\.scoreSession\) requestScoreExit\(next\);\s*else if \(state\.lesson\) requestLessonExit\(next\);\s*else next\(\);/);
  assert.match(app, /if \(state\.attendance\?\.dirty\) \{ state\.pendingAttendanceExit = next; show\("leave-attendance"\); return; \}/);
  assert.match(app, /if \(state\.scoreSession\?\.dirty\) \{ state\.pendingScoreExit = next; show\("leave-scores"\); return; \}/);
  assert.match(app, /function requestLessonExit\(next = renderClass\) \{ if \(state\.lesson\?\.dirty && !window\.confirm\("Leave this lesson without saving your changes\?"\)\) return/);
  assert.match(app, /async \(event\) => \{ event\.preventDefault\(\); const form = event\.currentTarget, openTool = form\.dataset\.openTool \|\| ""; try \{ const saved = await saveClass\([\s\S]*?Promise\.all\(\[refreshClasses\(\), refreshActiveClass\(\)\]\)/);
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
  assert.match(app, /state\.attendance = \{ date, loading: true, request, focusStudentId: options\.focusStudentId/);
  assert.match(app, /if \(state\.attendance\?\.request !== request\) return;/);
  assert.match(app, /if \(!session \|\| session\.loading\) return;/);
  assert.match(app, /Opening attendance for \$\{session\.date\}…/);
  assert.match(app, /attendance-screen--loading/);
});

test("attendance status edits patch existing controls and preserve explicit-save focus", () => {
  const updater = app.match(/function updateAttendanceControls\(\)[\s\S]*?\n\}/)?.[0] || "";
  const setter = app.match(/function setAttendanceStatus\(studentId, status\)[^\n]*/)?.[0] || "";
  const markAll = app.match(/function markAllPresent\(\)[^\n]*/)?.[0] || "";
  assert.match(updater, /root\.querySelectorAll\("\[data-attendance-row\]"\)/);
  assert.match(updater, /button\.setAttribute\("aria-checked", String\(selected\)\)/);
  assert.match(updater, /button\.tabIndex = selected \? 0 : -1/);
  assert.match(updater, /data-attendance-count/);
  assert.match(updater, /data-attendance-save-state/);
  assert.match(setter, /session\.dirty = !session\.saved \|\| !attendanceRowsMatch/);
  assert.match(setter, /updateAttendanceControls\(\)/);
  assert.match(setter, /if \(session\.filter !== "all" && row\.status !== session\.filter\)/);
  assert.match(setter, /root\.querySelector\(`\[data-attendance-count="\$\{filter\}"\]`\)\?\.focus\(\)/);
  assert.doesNotMatch(setter.split("if (session.filter")[0], /renderAttendance\(\)|replaceChildren/);
  assert.match(markAll, /updateAttendanceControls\(\)/);
  assert.match(markAll, /if \(session\.filter !== "all"\)/);
  assert.match(markAll, /root\.querySelector\(`\[data-attendance-count="\$\{filter\}"\]`\)\?\.focus\(\)/);
  assert.match(app, /role: "radiogroup", "aria-label": `Attendance status for \$\{row\.fullName\}`/);
  assert.match(app, /button\.setAttribute\("role", "radio"\); button\.setAttribute\("aria-checked", String\(selected\)\); button\.tabIndex = selected \? 0 : -1/);
  assert.match(app, /function handleAttendanceStatusKey\(event\)[\s\S]*?nextAttendanceStatus\(button\.getAttribute\("data-attendance-status"\), event\.key, ATTENDANCE_STATUSES\)[\s\S]*?event\.preventDefault\(\); setAttendanceStatus\([\s\S]*?\)\?\.focus\(\)/);
  assert.match(app, /root\.addEventListener\("keydown", handleAttendanceStatusKey\)/);
  assert.doesNotMatch(app.match(/function handleAttendanceStatusKey\(event\)[\s\S]*?(?=function markAllPresent)/)?.[0] || "", /persistAttendance\(/);
  assert.match(app, /data-attendance-status", status/);
  assert.match(app, /action\("Save attendance", persistAttendance, "button"\)/);
  assert.match(app, /function persistAttendance\(\)[\s\S]*?saveAttendance\(activeClass\.id, session\.date, session\.rows\)/);
  assert.match(app, /function requestAttendanceExit\(next\) \{ if \(state\.attendance\?\.dirty\)/);
});

test("mobile attendance Save stays reachable without obscuring the final roster rows", () => {
  assert.match(app, /saveActions\("mobile"\)/);
  assert.match(css, /\.attendance-save--mobile \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?\.attendance-save--top \{ display: none; \}/);
  assert.match(css, /\.attendance-save--mobile \{[\s\S]*?position: sticky;[\s\S]*?bottom: 0;/);
  assert.match(css, /\.attendance-save--mobile \.button \{ width: auto; min-height: 2\.75rem;/);
  assert.match(css, /\.status-button, \.attendance-date input,[^\n]*\{ min-height: 2\.75rem; \}/);
  assert.match(css, /\.attendance-list \{ margin-bottom: 5\.25rem; \}/);
  assert.match(css, /padding: \.65rem \.75rem calc\(\.65rem \+ env\(safe-area-inset-bottom, 0px\)\)/);
});

test("backup recency and the shared Gradebook assessment handoff remain visible without changing records", () => {
  assert.match(app, /function backupReminder\(\)/);
  assert.match(app, /noteBackupExport\(\)/);
  const reminder = app.match(/function backupReminder\(\)[^\n]*/)?.[0] || "";
  assert.match(reminder, /action\("Dismiss"[\s\S]*?refreshBackupReminder\(\)/);
  assert.doesNotMatch(reminder, /renderDashboard\(\)/);
  assert.match(app, /function refreshBackupReminder\(\) \{ if \(state\.activeClass\) renderClass\(\); else renderDashboard\(\); \}/);
  assert.match(app, /function refreshBackupReminder\(\)/);
  assert.match(app, /noteBackupExport\(\); refreshBackupReminder\(\);/);
  assert.match(app, /recordBackupDownloadStarted\(backupStatus\(\)\)/);
  assert.match(app, /downloaded backup somewhere safe/);
  assert.doesNotMatch(app, /Changes since your last export are still only on this device/);
  assert.match(app, /noteClassroomChange\(\)/);
  assert.match(app, /Create shared assessments and enter scores/);
  assert.match(app, /same shared Gradebook assessments/);
  assert.match(css, /\.backup-recency \{ display: flex;/);
});

test("backup export encrypts files and restore checks encrypted or legacy input before replacement", () => {
  assert.match(html, /data-dialog="backup-encrypt"/);
  assert.match(html, /data-dialog="backup-unlock"/);
  assert.match(html, /minlength="12"/);
  assert.equal([...html.matchAll(/name="(?:passphrase|confirmPassphrase)" type="password"[^>]*autocomplete="([^"]+)"/g)].every((match) => match[1] === "off"), true);
  assert.match(html, /MATEVOK cannot recover a lost passphrase/);
  assert.match(app, /const encrypted = await encryptBackup\(backup, passphrase\)/);
  assert.match(app, /isEncryptedBackup\(parsed\)/);
  assert.match(app, /showBackupRestoreReview\(parsed, false\)/);
  assert.match(app, /finally \{ input\.value = ""; \}/);
  assert.match(app, /window\.setTimeout\(\(\) => \{ link\.remove\(\); URL\.revokeObjectURL\(url\); \}, 1000\)/);
  assert.match(app, /data-restore-security-note/);
  assert.match(app, /Security warning: this older backup is unencrypted/);
  const restoreSubmit = app.slice(app.indexOf('dialogs.restore.querySelector("form").addEventListener("submit"'));
  assert.ok(restoreSubmit.indexOf("elements.replace.checked") < restoreSubmit.indexOf("await replaceWithBackup(state.backup)"), "replacement must remain behind the explicit confirmation check");
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
  assert.match(html, /<script src="startup\.js\?v=22"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(app, /serviceWorker\.register/);
});

test("My Materials is a permanent library separate from active class workspaces", () => {
  assert.match(html, /data-nav-item="My Materials"/);
  assert.match(app, /function renderMaterials\(\)/);
  assert.match(html, /Save a reusable template/);
  assert.match(app, /Unsaved editor changes are not included/);
  assert.match(app, /Save another template/);
  assert.match(app, /confirm\.disabled = false; confirm\.textContent = duplicates\.length/);
  assert.match(app, /nothing will be overwritten/);
  assert.match(app, /Search by title/);
  assert.match(app, /Material type/);
  assert.match(app, /function beginMaterialAdd\(materialId\)/);
  assert.match(app, /Choose an active destination class/);
  assert.match(app, /as an independent Draft/);
  assert.match(app, /function confirmMaterialAdd\(\)/);
  assert.match(app, /value\.submitting \|\| !value\.targets\.some/);
  assert.match(app, /!state\.activeClass && !state\.archivedView && currentLocation\.textContent !== "My Materials"\) return/);
  assert.match(app, /requestWorkspaceNavigation\("My Classes"\)/);
  assert.match(app, /label === "My Classes" && currentLocation\.textContent === "My Materials"\) \{ navigateWorkspace\(label\); closeMenu\(\); return; \}/);
  assert.match(html, /I reviewed this material and want to add an independent Draft/);
  assert.match(app, /Materials stay on this device\. Include them in your regular backups\./);
  assert.match(html, /data-restore-summary/);
  assert.match(app, /\$\{\(data\.materials \|\| \[\]\)\.length\} materials/);
  assert.match(app, /materialCount\} materials/);
  assert.match(css, /\.materials-grid \{ display: grid;/);
  assert.match(css, /\.material-card-actions \.button \{ width: 100%; min-height: 44px;/);
  assert.match(storage, /BACKUP_STORES = Object\.freeze\(\[[^\]]*"materials"\]\)/);
  assert.match(storage, /"materials", indexes: \[\["kind", "kind"\], \["title", "title"\]\]/);
});

test("opening My Materials from an active class keeps that class as the default destination", () => {
  assert.match(app, /state\.materialTargetClassId = state\.activeClass && !state\.activeClass\.archivedAt \? state\.activeClass\.id : "";\s*requestWorkspaceNavigation\("My Materials"\)/);
  assert.match(app, /if \(targets\.some\(\(entry\) => entry\.id === state\.materialTargetClassId\)\) select\.value = state\.materialTargetClassId/);
  assert.match(app, /Destination · \$\{target\.className\}/);
  assert.match(app, /if \(label === "My Materials"\) \{ state\.activeClass = null/);
});
