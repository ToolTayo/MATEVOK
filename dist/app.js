import { ATTENDANCE_STATUSES, QUESTION_TYPES, attendanceCounts, copyActiveRosterToEmptyClass, copyAuthoredAssessmentToClass, copyLessonToClass, createBackup, deleteAssessmentPermanently, deleteClassPermanently, deleteMaterialPermanently, deleteQuestionPermanently, deleteLessonPermanently, deleteClassWorkPermanently, duplicateAuthoredAssessment, duplicateLesson, getLocalDateString, getLocalStoreHealth, getRecord, listAssessments, listAttendanceForDate, listAttendanceHistory, listAttendanceRecords, listClasses, listLessons, listClassWork, listWorkSubmissionsForClass, listWorkSubmissionsForItem, listWorkSubmissionsForStudent, listMaterials, listQuestions, listScores, listScoresForClass, listStudents, materializeMaterialToClass, moveQuestion, questionTotalPoints, replaceWithBackup, reviewRoster, saveAssessment, saveAssessmentToMaterials, saveAttendance, saveAuthoredQuestion, saveClass, saveLesson, saveClassWork, saveWorkSubmissions, saveLessonToMaterials, saveScores, saveStudent, saveStudents, setClassArchived, setStudentArchived, syncAssessmentMaximumToQuestionTotal, updateAssessmentAuthoringStatus, validateBackup, validateAssessmentReady } from "./storage.js";
import { GENERIC_RAW_POLICY, scoreDisplay, validateScoreInput } from "./gradebook.js";
import { addTimerMinute, createPickerState, createTimer, formatTimer, generateBalancedGroups, generateBalancedGroupsBySize, groupsPlainText, pauseTimer, pickStudent, resetPickerRound, resetTimer, secureRandomIndex, startTimer, timerSnapshot } from "./classroom.js";
import { deriveStudentProgress } from "./progress.js";
import { assessmentCsv, attendanceCsv, classWorkStatusCsv, deriveClassWorkStatusReport, deriveAssessmentResults, deriveAttendanceSummary, deriveClassOverview, deriveClassRoster, rosterCsv } from "./reports.js";
import { BACKUP_STATUS_KEY, backupStatusLabel, dismissBackupReminder, needsBackupReminder, readBackupStatus, recordBackupDownloadStarted, recordDataChange } from "./backup-status.js";
import { reviewPastedScores } from "./score-paste.js";
import { decryptBackup, encryptBackup, isEncryptedBackup, MAX_ENCRYPTED_BACKUP_FILE_BYTES, validateEncryptedBackupEnvelope } from "./backup-crypto.js";
import { resolveClassToolDestination } from "./class-tool-navigation.js";
import { nextAttendanceStatus } from "./attendance-keyboard.js";
import { acquireWorkspaceLock, createSingleFlight } from "./workspace-lock.js";
import { selectLessonReference } from "./lesson-reference.js";
import { commitSubmissionDraftSnapshot, deriveClassWorkCountsByItem, deriveClassWorkSummary, deriveDueTodayClassWork, submissionDraftIsDirty, WORK_SUBMISSION_LABELS, WORK_SUBMISSION_STATUSES } from "./class-work.js";

const root = document.querySelector("[data-app]");
const live = document.querySelector("[data-live]");
const currentLocation = document.querySelector("[data-current-location]");
const dialogs = Object.fromEntries([...document.querySelectorAll("dialog")].map((dialog) => [dialog.dataset.dialog, dialog]));
let workspaceLock = null;
const pendingForms = new WeakSet();
const state = { classes: [], activeClass: null, students: [], archivedStudents: [], archivedView: false, rosterSearch: "", rosterSearchClassId: "", backup: null, encryptedBackupEnvelope: null, attendanceHistory: [], attendance: null, pendingAttendanceExit: null, assessments: [], overviewScoreCounts: new Map(), gradebookSearch: "", gradebookSearchClassId: "", gradebookScoreFilter: "all", activeAssessment: null, scoreSession: null, scorePaste: null, copy: null, copySuccess: null, rosterCopy: null, classTool: null, pendingScoreExit: null, authoredQuestions: [], lessons: [], lesson: null, lessonSearch: "", classWork: [], workSubmissions: [], classWorkSearch: "", classWorkStatusFilter: "all", classWorkSession: null, pendingClassWorkExit: null, classWorkDelete: null, materials: [], materialSearch: "", materialKind: "all", materialTargetClassId: "", materialSave: null, materialAdd: null, materialDelete: null, progress: null, progressSearch: "", reports: null, dialogReturnFocus: {}, classroom: { picker: createPickerState(), groups: null, groupCount: "", groupSize: "", groupMode: "count", message: "", timer: createTimer(), completionAnnounced: false } };

function el(tag, attrs = {}, children = []) { const node = document.createElement(tag); Object.entries(attrs).forEach(([key, value]) => { if (key === "class") node.className = value; else if (key === "text") node.textContent = value; else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value); else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : String(value)); }); children.flat().forEach((child) => node.append(child?.nodeType ? child : document.createTextNode(String(child ?? "")))); return node; }
function searchQuery(value) { return String(value ?? "").trim().toLocaleLowerCase(); }
function matchesSearch(query, ...values) { return !query || values.some((value) => String(value ?? "").toLocaleLowerCase().includes(query)); }
function addAssessmentAuthoringFields() { const form = dialogs.assessment.querySelector("form"), grid = form.querySelector(".form-grid"); if (form.elements.assessmentKind) return; const kind = el("label", { class: "field" }, [el("span", { text: "Assessment kind" }), el("select", { name: "assessmentKind" }, [el("option", { value: "quiz", text: "Quiz" }), el("option", { value: "test", text: "Test" }), el("option", { value: "worksheet", text: "Worksheet" }), el("option", { value: "practice", text: "Practice" })])]); const instructions = el("label", { class: "field field--wide" }, [el("span", { text: "Student instructions (optional)" }), el("textarea", { name: "instructions", rows: 3, maxlength: 2000, placeholder: "Directions shown on the printable student copy" })]); grid.append(kind, instructions); const showPoints = el("label", { class: "check-row" }, [el("input", { name: "showPoints", type: "checkbox" }), el("span", { text: "Show point values on the printable student copy" })]); form.querySelector("#assessment-max-help").before(showPoints); }
addAssessmentAuthoringFields();
function action(label, click, type = "button") { const runOnce = createSingleFlight(); return el("button", { type: "button", class: type, text: label, onClick: (event) => { const button = event.currentTarget; let pending; try { pending = runOnce(() => click(event)); } catch (error) { errorMessage(error); return; } if (!pending) return; button.setAttribute("aria-busy", "true"); pending.catch(errorMessage).finally(() => { if (button.isConnected) button.removeAttribute("aria-busy"); }); } }); }
const activeClassLabel = el("span", { class: "nav-class-context-name" });
const switchClassButton = action("Switch class", requestClassSwitch, "nav-switch-class"); switchClassButton.setAttribute("aria-haspopup", "dialog");
const classSwitchContext = el("div", { class: "nav-class-context", hidden: true }, [activeClassLabel, switchClassButton]);
document.querySelector("#class-tools-hint")?.after(classSwitchContext);
function announce(message) { document.querySelectorAll("[data-operation-error]").forEach((notice) => notice.remove()); live.textContent = ""; requestAnimationFrame(() => { live.textContent = message; }); }
function errorMessage(error) { const message = error?.message || "That change could not be completed. Your saved information is unchanged.", activeDialog = document.querySelector("dialog[open]"), form = document.activeElement?.closest?.("form") || activeDialog?.querySelector("form"); releasePendingForm(form); announce(message); const scope = form || activeDialog || root; let notice = scope.querySelector("[data-operation-error]"); if (!notice) { notice = el("p", { class: "form-error", role: "alert", "data-operation-error": "" }); const heading = activeDialog?.querySelector(".dialog-heading") || form?.querySelector(".dialog-heading"); if (heading) heading.after(notice); else scope.prepend(notice); } notice.textContent = message; }
function submitOnce(form, handler) { const runOnce = createSingleFlight(); form.addEventListener("submit", (event) => { event.preventDefault(); const submit = form.querySelector('[type="submit"]'), wasDisabled = submit?.disabled; let pending; try { pending = runOnce(() => handler(event)); } catch (error) { errorMessage(error); return; } if (!pending) return; if (submit) submit.disabled = true; pending.catch(errorMessage).finally(() => { if (submit?.isConnected) submit.disabled = wasDisabled; }); }); }
function releasePendingForm(form) { if (!form || !pendingForms.has(form)) return; pendingForms.delete(form); form.removeAttribute("aria-busy"); }
document.querySelectorAll("dialog form").forEach((form) => { if (!form.closest("[data-dialog=backup-encrypt], [data-dialog=backup-unlock]")) form.dataset.singleSubmit = "true"; });
document.addEventListener("submit", (event) => { const form = event.target; if (!form?.matches?.("form[data-single-submit]")) return; if (pendingForms.has(form)) { event.preventDefault(); event.stopImmediatePropagation(); return; } pendingForms.add(form); form.setAttribute("aria-busy", "true"); }, true);
Object.values(dialogs).forEach((dialog) => dialog.addEventListener("close", () => releasePendingForm(dialog.querySelector("form"))));
function downloadJsonFile(filename, value) { const blob = new Blob([JSON.stringify(value)], { type: "application/json" }); if (blob.size > MAX_ENCRYPTED_BACKUP_FILE_BYTES) throw new Error("This encrypted backup is larger than the 25 MB import limit. Reduce the stored data before exporting."); const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = filename; link.hidden = true; document.body.append(link); try { link.click(); } catch (error) { link.remove(); URL.revokeObjectURL(url); throw error; } window.setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 1000); }
function showBackupRestoreReview(value, encrypted) { state.backup = validateBackup(value); const data = state.backup.data; dialogs.restore.querySelector("[data-restore-summary]").textContent = `This backup contains ${data.classes.length} classes, ${data.students.length} student records, ${data.attendance.length} attendance records, ${data.assessments.length} assessments, ${data.scores.length} scores, ${data.questions.length} questions, ${data.questionOptions.length} answer choices, ${data.lessons.length} lessons, ${(data.materials || []).length} materials, ${(data.classWork || []).length} class-work items, and ${(data.workSubmissions || []).length} submission statuses. Restoring replaces your current local classroom records; it does not merge them.`; const securityNote = dialogs.restore.querySelector("[data-restore-security-note]"); securityNote.textContent = encrypted ? "This backup was authenticated and decrypted in this browser. Its contents passed the MATEVOK backup checks." : "Security warning: this older backup is unencrypted and may expose student information to anyone who can access the file."; securityNote.hidden = encrypted; dialogs.restore.querySelector("[data-restore-progress]").hidden = true; dialogs.restore.querySelector("form").elements.replace.checked = false; show("restore"); }
function backupStatus() { try { return readBackupStatus(JSON.parse(localStorage.getItem(BACKUP_STATUS_KEY) || "null")); } catch { return readBackupStatus(null); } }
function saveBackupStatus(status) { try { localStorage.setItem(BACKUP_STATUS_KEY, JSON.stringify(status)); } catch { /* Backup reminders are optional device preferences. */ } return status; }
function noteClassroomChange() { return saveBackupStatus(recordDataChange(backupStatus())); }
function noteBackupExport() { return saveBackupStatus(recordBackupDownloadStarted(backupStatus())); }
function refreshBackupReminder() { if (state.activeClass) renderClass(); else renderDashboard(); }
function backupReminder() { const status = backupStatus(), reminder = needsBackupReminder(status); return el("aside", { class: reminder ? "backup-recency is-reminder" : "backup-recency", "aria-label": "Backup status" }, [el("div", {}, [el("strong", { text: backupStatusLabel(status) }), reminder ? el("span", { text: " Classroom changes stay on this device; keep a downloaded backup somewhere safe." }) : null]), reminder ? el("div", { class: "backup-recency-actions" }, [action("Back up now", () => show("backup"), "link-button"), action("Dismiss", () => { saveBackupStatus(dismissBackupReminder(status)); refreshBackupReminder(); }, "link-button")]) : null]); }
function setWorkspaceLocation(label) {
  const safe = String(label || "My Classes"), classIsOpen = Boolean(state.activeClass);
  const navLabel = safe === "Classroom Display" ? "Classroom Mode" : safe === "My Materials" ? safe : ["Overview", "Attendance", "Class Work", "Gradebook", "Assessment Center", "Lesson Workspace", "Student Progress", "Classroom Mode", "Reports"].includes(safe) ? safe : classIsOpen && safe !== "My Classes" && safe !== "Archived classes" ? "Overview" : "My Classes";
  currentLocation.textContent = safe;
  document.title = safe === "My Classes" ? "MATEVOK" : `${safe} · MATEVOK`;
  document.body.classList.toggle("is-dashboard", safe === "My Classes" || safe === "Archived classes");
  document.querySelector("[data-sidebar]")?.toggleAttribute("data-class-open", classIsOpen);
  document.querySelector("#class-tools-hint")?.toggleAttribute("hidden", classIsOpen);
  const hasOtherActiveClass = classIsOpen && !state.activeClass.archivedAt && state.classes.some((item) => !item.archivedAt && item.id !== state.activeClass.id);
  classSwitchContext.hidden = !hasOtherActiveClass;
  if (hasOtherActiveClass) { activeClassLabel.textContent = state.activeClass.className; switchClassButton.setAttribute("aria-label", `Switch class from ${state.activeClass.className}`); }
  document.querySelectorAll("[data-nav-item]").forEach((item) => {
    const active = item.dataset.navItem === navLabel;
    item.classList.toggle("is-current", active); item.toggleAttribute("data-current", active);
    if (item instanceof HTMLButtonElement) item.disabled = false;
    if (item instanceof HTMLAnchorElement) { if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current"); }
    else if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  });
}
function show(name) { const dialog = dialogs[name]; state.dialogReturnFocus[name] = document.activeElement instanceof HTMLElement ? document.activeElement : null; if (!dialog.open) dialog.showModal(); dialog.querySelector("input:not([type=hidden]), textarea, select, button:not(.icon-button):not(.button--danger)")?.focus(); }
function hide(name) { const dialog = dialogs[name]; releasePendingForm(dialog?.querySelector("form")); dialog?.querySelector("[data-operation-error]")?.remove(); dialog?.close(); const returnFocus = state.dialogReturnFocus[name]; delete state.dialogReturnFocus[name]; requestAnimationFrame(() => { if (returnFocus?.isConnected) returnFocus.focus(); }); }
Object.entries(dialogs).forEach(([name, dialog]) => dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (name === "workspace-lock") { dialog.querySelector("[data-workspace-retry]")?.focus(); return; }
  hide(name);
}));
function classMeta(item) { return [item.gradeLevel, item.subject, item.term].filter(Boolean).join(" · ") || "Class details not added yet"; }
async function refreshClasses() { state.classes = await listClasses({ archived: state.archivedView }); }
async function refreshActiveClass() { if (!state.activeClass) return; const found = await getRecord("classes", state.activeClass.id); state.activeClass = found || null; if (!found) { state.overviewScoreCounts = new Map(); state.classWork = []; state.workSubmissions = []; return; } const [students, archivedStudents, attendanceHistory, assessments, lessons, scores, classWork, workSubmissions] = await Promise.all([listStudents(found.id), listStudents(found.id, { archived: true }), listAttendanceHistory(found.id), listAssessments(found.id), listLessons(found.id), listScoresForClass(found.id), listClassWork(found.id), listWorkSubmissionsForClass(found.id)]); state.students = students; state.archivedStudents = archivedStudents; state.attendanceHistory = attendanceHistory; state.assessments = assessments; state.lessons = lessons; state.classWork = classWork; state.workSubmissions = workSubmissions; const activeStudentIds = new Set(students.map((student) => student.id)), assessmentIds = new Set(assessments.map((assessment) => assessment.id)), counts = new Map(); scores.forEach((score) => { if (assessmentIds.has(score.assessmentId) && activeStudentIds.has(score.studentId)) counts.set(score.assessmentId, (counts.get(score.assessmentId) || 0) + 1); }); state.overviewScoreCounts = counts; }

function renderDashboard() {
  setWorkspaceLocation(state.archivedView ? "Archived classes" : "My Classes");
  root.replaceChildren();
  const utilities = el("div", { class: "dashboard-utilities", "aria-label": "Class utilities" }, [action(state.archivedView ? "Back to classes" : "View archived", async () => { state.archivedView = !state.archivedView; await refreshClasses(); renderDashboard(); }, "button button--quiet"), action("Backup & restore", () => show("backup"), "button button--quiet")]);
  root.append(el("section", { class: "page-heading dashboard-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: state.archivedView ? "Archived classes" : "My classes" }), el("h1", { text: state.archivedView ? "Classes you can restore." : "Your classes" }), el("p", { class: "intro", text: state.archivedView ? "Archived classes stay safely on this device until you restore or deliberately delete them." : state.classes.length ? "Open a class to continue with the same roster across your teaching tools." : "Create your first class, then add a reusable roster when you are ready." })]), el("div", { class: "heading-actions dashboard-actions" }, [!state.archivedView ? action(state.classes.length ? "Add class" : "Create your first class", () => prepClass()) : null, utilities]) ]));
  if (!state.archivedView) root.append(backupReminder());
  if (!state.classes.length) {
    if (!state.archivedView) { root.append(firstUseGuide()); return; }
    root.append(el("section", { class: "empty-state" }, [el("div", { class: "empty-symbol", text: "↺", "aria-hidden": "true" }), el("h2", { text: "No archived classes" }), el("p", { text: "Archive a class when a term ends. You can restore it here whenever you need it." }), action("Back to classes", async () => { state.archivedView = false; await refreshClasses(); renderDashboard(); })])); return;
  }
  const cards = el("section", { class: "class-list", "data-count": state.classes.length, "aria-label": state.archivedView ? "Archived classes" : "Your classes" });
  state.classes.forEach((item) => { const rosterState = item.studentCount ? `${item.studentCount} active student${item.studentCount === 1 ? "" : "s"}` : "Roster not added yet"; cards.append(el("article", { class: "class-card" }, [el("div", { class: "class-card-mark", text: item.className.slice(0, 1).toUpperCase(), "aria-hidden": "true" }), el("div", { class: "class-card-body" }, [el("h2", { text: item.className }), el("p", { class: "class-card-details", text: classMeta(item) }), item.schedule ? el("span", { class: "class-card-schedule", text: `Schedule · ${item.schedule}` }) : null, el("span", { class: "count-label", text: rosterState, "aria-label": item.studentCount ? null : "Roster not added yet. 0 active students." })]), action(state.archivedView ? "Restore" : "Open class", async () => { try { if (state.archivedView) { await setClassArchived(item.id, false); noteClassroomChange(); announce(`${item.className} was restored.`); await refreshClasses(); renderDashboard(); } else { state.activeClass = item; await refreshActiveClass(); renderClass(); } } catch (error) { errorMessage(error); } }, state.archivedView ? "button button--quiet" : "button button--small")] )); });
  root.append(cards);
}

function firstUseGuide() { const steps = [["1", "Create a class", "Name the class or section you teach."], ["2", "Add students once", "Paste a roster or add students one at a time."], ["3", "Choose a workspace", "Use Attendance, Class Work, Gradebook, Assessment Center, Lessons, Classroom Mode, Student Progress, or Reports when you need them."]]; return el("section", { class: "first-use-guide dashboard-empty-guide", "aria-labelledby": "first-use-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "A simple local workflow" }), el("h2", { id: "first-use-heading", text: "Set up once. Use everywhere." }), el("p", { text: "Everything stays on this device and starts with the same reusable class roster." })]), el("ol", { class: "first-use-steps" }, steps.map(([number, title, detail]) => el("li", {}, [el("span", { class: "first-use-number", text: number }), el("div", {}, [el("h3", { text: title }), el("p", { text: detail })])])))]); }

function materialLabel(kind) { return kind === "assessment" ? "Assessment" : "Lesson"; }
function materialSearchResults() {
  const host = root.querySelector("[data-material-results]"); if (!host) return;
  const query = searchQuery(state.materialSearch);
  const items = state.materials.filter((item) => (state.materialKind === "all" || item.kind === state.materialKind) && matchesSearch(query, item.title));
  host.replaceChildren();
  if (!items.length) { const returnTarget = state.materialTargetClassId && state.classes.find((entry) => !entry.archivedAt && entry.id === state.materialTargetClassId); host.append(el("section", { class: "empty-state library-empty" }, [el("h2", { text: state.materials.length ? "No matching materials" : "Your library is ready when you are" }), el("p", { text: state.materials.length ? "Try a different title or material type." : "Choose Save to My Materials on a lesson or assessment in its class workspace. You can add an independent Draft to another class later. Templates stay on this device and are included in backups." }), state.materials.length ? null : returnTarget ? null : action("Back to My Classes", () => returnFromMaterials(), "button button--quiet")])); return; }
  const list = el("section", { class: "materials-grid", "aria-label": "Saved My Materials templates" });
  items.forEach((item) => {
    const details = item.kind === "assessment" ? `${item.content.questions.length} authored question${item.content.questions.length === 1 ? "" : "s"} · ${item.content.questions.reduce((count, question) => count + question.options.length, 0)} answer choices · Assessment copy starts as Draft` : `${item.content.status === "ready" ? "Ready" : "Draft"} lesson plan · Lesson copy starts as Draft`;
    const savedDate = item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "Saved template";
    list.append(el("article", { class: "material-card" }, [el("div", { class: "material-card-heading" }, [el("span", { class: "material-kind", text: materialLabel(item.kind) }), el("small", { text: `Saved ${savedDate}` })]), el("h2", { text: item.title }), el("p", { class: "material-card-details", text: details }), el("div", { class: "material-card-actions" }, [action(state.materialTargetClassId ? `Add to ${state.classes.find((entry) => entry.id === state.materialTargetClassId)?.className || "class"}` : "Add to a class", () => beginMaterialAdd(item.id), "button button--small"), action("Delete template", () => prepDeleteMaterial(item), "button button--quiet")])]));
  });
  host.append(list);
}
async function renderMaterials() {
  state.classes = await listClasses(); setWorkspaceLocation("My Materials"); root.replaceChildren();
  const returnTarget = state.materialTargetClassId && state.classes.find((item) => !item.archivedAt && item.id === state.materialTargetClassId);
  root.append(el("section", { class: "page-heading materials-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Reusable templates" }), el("h1", { text: "My Materials" }), el("p", { class: "intro", text: "Save Lessons and authored Assessments once, then add independent Draft copies to your classes." }), el("p", { class: "form-note", text: "Materials stay on this device. Include them in your regular backups." })]), el("div", { class: "heading-actions" }, [returnTarget ? action(`Return to ${returnTarget.className}`, () => returnFromMaterials(returnTarget.id), "button button--quiet") : null, action("Backup & restore", () => show("backup"), "button button--quiet"), !state.classes.length ? action("Create a class", () => prepClass(), "button") : null]) ]));
  root.append(el("div", { class: "materials-tools" }, [el("label", { class: "field" }, [el("span", { text: "Search by title" }), el("input", { type: "search", value: state.materialSearch, placeholder: "Find a Lesson or Assessment", onInput: (event) => { state.materialSearch = event.currentTarget.value; materialSearchResults(); } })]), el("label", { class: "field" }, [el("span", { text: "Material type" }), el("select", { value: state.materialKind, onChange: (event) => { state.materialKind = event.currentTarget.value; materialSearchResults(); } }, [el("option", { value: "all", text: "All materials" }), el("option", { value: "lesson", text: "Lessons" }), el("option", { value: "assessment", text: "Assessments" })])]) ]));
  const host = el("div", { "data-material-results": "" }); root.append(host);
  try { state.materials = await listMaterials(); materialSearchResults(); } catch (error) { errorMessage(error); }
}
function visitMaterialsForClass(classId) { state.materialTargetClassId = classId || ""; requestWorkspaceNavigation("My Materials"); }
async function returnFromMaterials(classId = "") { if (!classId) { state.materialTargetClassId = ""; navigateWorkspace("My Classes"); return; } try { state.classes = await listClasses(); const target = state.classes.find((item) => item.id === classId); if (!target) throw new Error("That class is no longer active."); state.materialTargetClassId = ""; state.activeClass = target; state.archivedView = false; await refreshActiveClass(); renderClass(); } catch (error) { errorMessage(error); } }

function studentList(students = state.students) { const list = el("ol", { class: "roster-list" }); students.forEach((student, index) => list.append(el("li", {}, [el("span", { class: "roster-number", text: index + 1 }), el("strong", { text: student.fullName }), el("div", { class: "roster-actions" }, [action("Edit", () => prepStudent(student), "link-button"), action("Archive", () => archiveStudent(student), "link-button")])]))); return list; }
function updateRosterStudentResults() {
  const host = root.querySelector("[data-roster-results]"); if (!host) return;
  const query = searchQuery(state.rosterSearch), matches = state.students.filter((student) => matchesSearch(query, student.fullName));
  host.replaceChildren(matches.length ? studentList(matches) : el("p", { class: "subtle roster-search-empty", text: `No active students match “${state.rosterSearch.trim()}”.` }));
  const count = root.querySelector("[data-roster-result-count]");
  if (count) count.textContent = query ? `${matches.length} of ${state.students.length} active students` : `${state.students.length} active students`;
}
function focusRosterAfterChange() {
  const search = root.querySelector("[data-roster-search]");
  if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); return; }
  const heading = root.querySelector("#roster-heading"); heading?.scrollIntoView({ block: "center" }); heading?.focus({ preventScroll: true });
}
function rosterStudentSearch() {
  const input = el("input", { type: "search", value: state.rosterSearch, placeholder: "Type a student name", "data-roster-search": "", onInput: (event) => { state.rosterSearch = event.currentTarget.value; updateRosterStudentResults(); } });
  return el("div", { class: "roster-search" }, [el("label", { class: "field" }, [el("span", { text: "Find a student to edit or archive" }), input]), el("p", { class: "subtle", role: "status", "aria-live": "polite", "aria-atomic": "true", "data-roster-result-count": "" })]);
}
function archivedStudentList() { if (!state.archivedStudents.length) return null; const details = el("details", { class: "archived-students" }, [el("summary", { text: `${state.archivedStudents.length} archived student${state.archivedStudents.length === 1 ? "" : "s"}` })]); const list = el("ul", { class: "roster-list roster-list--archived" }); state.archivedStudents.forEach((student) => list.append(el("li", {}, [el("strong", { text: student.fullName }), action("Restore", async () => { try { await setStudentArchived(student.id, false); noteClassroomChange(); announce(`${student.fullName} was restored.`); await refreshActiveClass(); renderClass(); focusRosterAfterChange(); } catch (error) { errorMessage(error); } }, "link-button")] ))); details.append(list); return details; }

function attendanceSummary(counts) { return `Present ${counts.present} · Absent ${counts.absent} · Late ${counts.late} · Excused ${counts.excused}`; }
function attendanceRowsMatch(rows, original) { return Array.isArray(original) && rows.length === original.length && rows.every((row) => original.find((item) => item.studentId === row.studentId)?.status === row.status); }
async function openAttendance(date = getLocalDateString(), options = {}) {
  if (!state.activeClass) return;
  const request = {};
  try {
    if (!state.students.length) { state.attendance = { date, rows: [], original: null, saved: false, filter: "all", search: "", dirty: false, noStudents: true }; renderAttendance(); announce("Add an active student before taking attendance."); return; }
    state.attendance = { date, loading: true, request, focusStudentId: options.focusStudentId || null, progressReturn: options.progressReturn || null };
    renderAttendance();
    const saved = await listAttendanceForDate(state.activeClass.id, date); const savedByStudent = new Map(saved.map((entry) => [entry.studentId, entry.status]));
    if (state.attendance?.request !== request) return;
    const rows = state.students.map((student) => ({ studentId: student.id, fullName: student.fullName, status: savedByStudent.get(student.id) || "present" }));
    if (options.requireRecordedStudent && !savedByStudent.has(options.focusStudentId)) { state.attendance = null; if (options.progressReturn) await refreshProgressContext(options.progressReturn, "That attendance record is no longer available; Progress history was refreshed."); else errorMessage(new Error("That attendance record is no longer available.")); return; }
    state.attendance = { date, rows, original: saved.length ? rows.map((row) => ({ ...row })) : null, saved: saved.length > 0, filter: "all", search: "", dirty: saved.length === 0, focusStudentId: options.focusStudentId || null, progressReturn: options.progressReturn || null };
    renderAttendance();
    if (state.attendance?.focusStudentId) focusAttendanceStudent(state.attendance.focusStudentId);
  } catch (error) { if (state.attendance?.request === request) state.attendance = null; errorMessage(error); }
}
function requestAttendanceExit(next) { if (state.attendance?.dirty) { state.pendingAttendanceExit = next; show("leave-attendance"); return; } completeAttendanceExit(next); }
function completeAttendanceExit(next) { const previous = state.attendance; state.pendingAttendanceExit = null; state.attendance = null; if (next?.type === "date") openAttendance(next.date, { focusStudentId: next.focusStudentId || null, progressReturn: next.progressReturn || null, requireRecordedStudent: Boolean(next.requireRecordedStudent) }); else if (next?.type === "progress") returnToProgressContext(next.context || previous?.progressReturn); else if (next?.type === "navigate") navigateWorkspace(next.label); else if (next?.type === "action") next.run?.(); else renderClass(); }
function focusAttendanceStudent(studentId) { const row = [...root.querySelectorAll("[data-attendance-row]")].find((item) => item.getAttribute("data-attendance-row") === studentId); if (!row) return; row.scrollIntoView?.({ block: "center" }); row.focus({ preventScroll: true }); }
function updateAttendanceControls() {
  const session = state.attendance; if (!session || session.loading) return;
  const counts = attendanceCounts(session.rows);
  root.querySelectorAll("[data-attendance-row]").forEach((listItem) => {
    const row = session.rows.find((item) => item.studentId === listItem.getAttribute("data-attendance-row")); if (!row) return;
    listItem.querySelectorAll("[data-attendance-status]").forEach((button) => { const selected = button.getAttribute("data-attendance-status") === row.status; button.setAttribute("aria-checked", String(selected)); button.tabIndex = selected ? 0 : -1; button.classList.toggle("is-selected", selected); });
  });
  root.querySelectorAll("[data-attendance-count]").forEach((button) => { const status = button.getAttribute("data-attendance-count"); button.textContent = `${status[0].toUpperCase() + status.slice(1)} ${counts[status]}`; button.classList.toggle("is-active", session.filter === status); });
  root.querySelectorAll("[data-attendance-save-state]").forEach((label) => { label.textContent = session.dirty ? "Unsaved changes" : "Saved on this device"; label.classList.toggle("is-dirty", session.dirty); });
}
function setAttendanceStatus(studentId, status) { const session = state.attendance; if (!session || session.loading) return; const row = session.rows.find((item) => item.studentId === studentId); if (!row) return; row.status = status; session.dirty = !session.saved || !attendanceRowsMatch(session.rows, session.original); if (session.filter !== "all" && row.status !== session.filter) { const filter = session.filter; renderAttendance(); root.querySelector(`[data-attendance-count="${filter}"]`)?.focus(); return; } updateAttendanceControls(); }
function handleAttendanceStatusKey(event) {
  const button = event.target.closest?.("[data-attendance-status]");
  if (!button) return;
  const status = nextAttendanceStatus(button.getAttribute("data-attendance-status"), event.key, ATTENDANCE_STATUSES);
  if (!status) return;
  const row = button.closest("[data-attendance-row]"), controls = button.closest(".status-controls");
  if (!row) return;
  event.preventDefault(); setAttendanceStatus(row.getAttribute("data-attendance-row"), status);
  if (controls?.isConnected) controls.querySelector(`[data-attendance-status="${status}"]`)?.focus();
}
function markAllPresent() { const session = state.attendance; if (!session || session.loading) return; session.rows.forEach((row) => { row.status = "present"; }); session.dirty = !session.saved || !attendanceRowsMatch(session.rows, session.original); if (session.filter !== "all") { const filter = session.filter; renderAttendance(); root.querySelector(`[data-attendance-count="${filter}"]`)?.focus(); return; } updateAttendanceControls(); }
async function persistAttendance() { const session = state.attendance, activeClass = state.activeClass; if (!session || session.loading || !activeClass) return; try { const saved = await saveAttendance(activeClass.id, session.date, session.rows); noteClassroomChange(); if (state.attendance !== session) return; const statusByStudent = new Map(saved.map((entry) => [entry.studentId, entry.status])); session.rows.forEach((row) => { row.status = statusByStudent.get(row.studentId) || row.status; }); session.original = session.rows.map((row) => ({ ...row })); session.saved = true; session.dirty = false; await refreshActiveClass(); if (state.attendance !== session) return; renderAttendance(); announce(`Attendance for ${session.date} was saved on this device.`); } catch (error) { errorMessage(error); } }
function attendanceHistoryPanel() { if (!state.attendanceHistory.length) return el("p", { class: "subtle", text: "No saved attendance dates yet." }); const list = el("ol", { class: "attendance-history" }); state.attendanceHistory.forEach((entry) => list.append(el("li", {}, [el("div", {}, [el("strong", { text: entry.date }), el("span", { text: `${entry.count} recorded · ${attendanceSummary(entry.counts)}` })]), action("Reopen", () => openAttendance(entry.date), "link-button")] ))); return list; }
function attendanceOverview(current) { const today = getLocalDateString(); const todayHistory = state.attendanceHistory.find((entry) => entry.date === today); const panel = el("section", { class: "attendance-overview", "data-class-tool": "Attendance", "aria-labelledby": "attendance-overview-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Daily attendance" }), el("h2", { id: "attendance-overview-heading", text: "Attendance" }), el("p", { text: current.archivedAt ? "Saved attendance remains in this archived class." : "Mark everyone present, then change only exceptions. Attendance stores private IDs and statuses, never copied names." })]), current.archivedAt ? null : action(todayHistory ? "Reopen today" : "Take attendance", () => openAttendance(today), "button")])]);
  if (!current.archivedAt && !state.students.length) panel.append(el("div", { class: "attendance-empty" }, [el("p", { text: "Add at least one active student before taking attendance." })]));
  else if (todayHistory) panel.append(el("p", { class: "attendance-today", text: `Today · ${attendanceSummary(todayHistory.counts)}` }));
  panel.append(el("div", { class: "history-wrap" }, [el("h3", { text: "Attendance history" }), attendanceHistoryPanel()])); return panel;
}

function classroomOverview(current) { return el("section", { class: "classroom-overview", "data-class-tool": "Classroom Mode", "aria-labelledby": "classroom-overview-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Live teaching" }), el("h2", { id: "classroom-overview-heading", text: "Classroom Mode" }), el("p", { text: current.archivedAt ? "Restore this class before starting a new live classroom session." : "Pick from the active roster, make balanced random groups, run a timer, and open a projector-safe display." })]), current.archivedAt ? null : action("Open Classroom Mode", renderClassroomMode, "button")]), el("p", { class: "subtle", text: "Picker, groups, timer, and message stay in this browser session only. No grades or attendance history are used." })]); }
function renderAttendance() {
  const current = state.activeClass, session = state.attendance; if (!current || !session) { renderClass(); return; } setWorkspaceLocation("Attendance"); root.replaceChildren();
  if (session.loading) { root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action(session.progressReturn ? "← Student Progress" : `← ${current.className}`, () => completeAttendanceExit(session.progressReturn ? { type: "progress", context: session.progressReturn } : { type: "class" }), "link-button")]), el("section", { class: "attendance-screen attendance-screen--loading", role: "status" }, [el("p", { class: "eyebrow", text: "Daily attendance" }), el("h1", { text: current.className }), el("p", { class: "intro", text: `Opening attendance for ${session.date}…` })])); return; }
  const counts = attendanceCounts(session.rows);
  root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action(session.progressReturn ? "← Student Progress" : `← ${current.className}`, () => requestAttendanceExit(session.progressReturn ? { type: "progress", context: session.progressReturn } : { type: "class" }), "link-button")]));
  const saveActions = (variant) => el("div", { class: `attendance-save attendance-save--${variant}` }, [el("span", { class: session.dirty ? "save-state is-dirty" : "save-state", "data-attendance-save-state": "", text: session.dirty ? "Unsaved changes" : "Saved on this device" }), action("Save attendance", persistAttendance, "button")]);
  root.append(el("section", { class: "attendance-screen" }, [el("div", { class: "attendance-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Daily attendance" }), el("h1", { text: current.className }), el("p", { class: "intro", text: "Fast status taking for one class and one local calendar date." })]), session.noStudents ? el("span", { class: "save-state", text: "Add students to begin" }) : saveActions("top")]), el("div", { class: "attendance-tools" }, [el("label", { class: "attendance-date" }, [el("span", { text: "Date" }), el("input", { type: "date", value: session.date, onChange: (event) => { const nextDate = event.currentTarget.value; if (nextDate && nextDate !== session.date) requestAttendanceExit({ type: "date", date: nextDate, focusStudentId: session.focusStudentId, progressReturn: session.progressReturn, requireRecordedStudent: Boolean(session.progressReturn) }); } })]), action("Mark all present", markAllPresent, "button button--quiet")]), el("section", { class: "attendance-counts", "aria-label": "Attendance counts" }, ATTENDANCE_STATUSES.map((status) => { const button = action(`${status[0].toUpperCase() + status.slice(1)} ${counts[status]}`, () => { session.filter = session.filter === status ? "all" : status; renderAttendance(); }, session.filter === status ? "count-filter is-active" : "count-filter"); button.setAttribute("data-attendance-count", status); return button; })), el("p", { class: "attendance-instruction", text: "Select a status for each active student. Archived students are not added to new dates; their saved history remains preserved." })]));
  if (session.rows.length >= 12) root.append(attendanceSearchControl(session));
  const list = el("ol", { id: "attendance-student-list", class: "attendance-list", "aria-label": "Students and attendance status", "data-attendance-list": "" });
  renderAttendanceRows(session, list);
  root.append(list); if (!session.noStudents) root.append(saveActions("mobile"));
}

function visibleAttendanceRows(session) {
  const query = searchQuery(session.search);
  return session.rows.filter((row) => (session.filter === "all" || row.status === session.filter) && matchesSearch(query, row.fullName));
}
function renderAttendanceRows(session, list) {
  const shown = visibleAttendanceRows(session); list.replaceChildren();
  if (!shown.length) list.append(el("li", { class: "attendance-empty" }, [el("p", { text: session.noStudents ? "Add an active student in Overview before taking attendance." : session.search?.trim() ? `No active students match “${session.search.trim()}”.` : `No students marked ${session.filter}.` })]));
  shown.forEach((row) => {
    const controls = el("div", { class: "status-controls", role: "radiogroup", "aria-label": `Attendance status for ${row.fullName}` });
    ATTENDANCE_STATUSES.forEach((status) => {
      const selected = row.status === status;
      const button = action(status[0].toUpperCase() + status.slice(1), () => setAttendanceStatus(row.studentId, status), selected ? "status-button is-selected" : "status-button");
      button.setAttribute("role", "radio"); button.setAttribute("aria-checked", String(selected)); button.tabIndex = selected ? 0 : -1; button.setAttribute("data-attendance-status", status); controls.append(button);
    });
    list.append(el("li", { tabindex: "-1", "data-attendance-row": row.studentId }, [el("span", { class: "attendance-number", text: session.rows.indexOf(row) + 1 }), el("strong", { text: row.fullName }), controls]));
  });
}
function updateAttendanceSearchResults() {
  const session = state.attendance, list = root.querySelector("[data-attendance-list]"); if (!session || !list) return;
  renderAttendanceRows(session, list);
  const count = root.querySelector("[data-attendance-search-count]");
  if (count) count.textContent = `Showing ${visibleAttendanceRows(session).length} of ${session.rows.length} active students. Mark all present applies to everyone.`;
}
function attendanceSearchControl(session) {
  const input = el("input", { type: "search", value: session.search || "", placeholder: "Type a student name", "aria-controls": "attendance-student-list", "data-attendance-search": "", onInput: (event) => { session.search = event.currentTarget.value; updateAttendanceSearchResults(); } });
  return el("div", { class: "attendance-search-wrap" }, [el("label", { class: "field attendance-search" }, [el("span", { text: "Find a student" }), input]), el("p", { class: "subtle attendance-search-count", role: "status", "aria-live": "polite", "aria-atomic": "true", "data-attendance-search-count": "", text: `Showing ${visibleAttendanceRows(session).length} of ${session.rows.length} active students. Mark all present applies to everyone.` })]);
}

function gradebookOverview(current) {
  const panel = el("section", { class: "gradebook-overview", "data-class-tool": "Gradebook", "aria-labelledby": "gradebook-overview-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Scores & assessments" }), el("h2", { id: "gradebook-overview-heading", text: "Gradebook" }), el("p", { text: "Create shared assessments and record raw scores locally. Displayed percentages are generic mathematics, not official grades or a DepEd calculation." })]), current.archivedAt ? null : action(state.assessments.length ? "Open gradebook" : "Create assessment", renderGradebook, "button")])]);
  panel.append(el("p", { class: "policy-note", text: `${GENERIC_RAW_POLICY.name} · ${GENERIC_RAW_POLICY.rounding}` }));
  if (state.assessments.length) panel.append(el("p", { class: "gradebook-summary", text: `${state.assessments.length} assessment${state.assessments.length === 1 ? "" : "s"} saved for this class.` })); else panel.append(el("p", { class: "subtle", text: current.archivedAt ? "Saved gradebook records remain private with this archived class." : "Create an assessment when you are ready to enter scores." })); return panel;
}
function assessmentMeta(assessment) { return [assessment.category, assessment.term].filter(Boolean).join(" · ") || "No category or period"; }
function gradebookAssessmentMatches(assessment) {
  const query = searchQuery(state.gradebookSearch);
  const matchesText = matchesSearch(query, assessment.title, assessment.date, assessment.category, assessment.term, assessment.assessmentKind);
  const activeCount = state.students.length, recordedCount = state.overviewScoreCounts.get(assessment.id) || 0;
  const matchesStatus = state.gradebookScoreFilter === "all" || (state.gradebookScoreFilter === "needs" && activeCount > 0 && recordedCount < activeCount) || (state.gradebookScoreFilter === "complete" && activeCount > 0 && recordedCount >= activeCount);
  return matchesText && matchesStatus;
}
function renderGradebookAssessmentResults() {
  const host = root.querySelector("[data-gradebook-assessment-results]"); if (!host) return;
  const matches = state.assessments.filter(gradebookAssessmentMatches), activeCount = state.students.length;
  host.replaceChildren();
  const count = root.querySelector("[data-gradebook-assessment-count]");
  if (count) count.textContent = `${matches.length} of ${state.assessments.length} assessment${state.assessments.length === 1 ? "" : "s"}${state.gradebookScoreFilter === "needs" ? " need score entry" : state.gradebookScoreFilter === "complete" ? " have all active scores" : " shown"}.`;
  if (!matches.length) { host.append(el("p", { class: "subtle gradebook-empty-filter", text: "No assessments match. Try another title or score-entry filter." })); return; }
  const list = el("section", { class: "assessment-list", "aria-label": "Filtered assessments" });
  matches.forEach((assessment) => {
    const entered = state.overviewScoreCounts.get(assessment.id) || 0;
    const scoreStatus = activeCount ? `${entered} of ${activeCount} active scores entered` : "No active students · add a roster before entering scores";
    list.append(el("article", { class: "assessment-card" }, [el("div", { class: "assessment-date", text: assessment.date }), el("div", { class: "assessment-card-body" }, [el("h2", { text: assessment.title }), el("p", { text: `${assessment.maximumScore} maximum · ${assessmentMeta(assessment)}` }), el("span", { class: "count-label", text: scoreStatus })]), action("Open scores", () => openAssessment(assessment), "button button--small")]));
  });
  host.append(list);
}
function gradebookAssessmentTools() {
  return el("div", { class: "gradebook-find-tools" }, [el("label", { class: "field" }, [el("span", { text: "Find an assessment" }), el("input", { type: "search", value: state.gradebookSearch, placeholder: "Title, date, category, or period", "data-gradebook-search": "", onInput: (event) => { state.gradebookSearch = event.currentTarget.value; renderGradebookAssessmentResults(); } })]), el("label", { class: "field" }, [el("span", { text: "Score entry" }), el("select", { value: state.gradebookScoreFilter, "data-gradebook-score-filter": "", onChange: (event) => { state.gradebookScoreFilter = event.currentTarget.value; renderGradebookAssessmentResults(); } }, [el("option", { value: "all", text: "All assessments" }), el("option", { value: "needs", text: "Needs scores" }), el("option", { value: "complete", text: "All active scores entered" })])]), el("p", { class: "subtle gradebook-assessment-count", role: "status", "aria-live": "polite", "aria-atomic": "true", "data-gradebook-assessment-count": "" })]);
}
function renderGradebook() {
  const current = state.activeClass; if (!current) { renderDashboard(); return; } if (state.gradebookSearchClassId !== current.id) { state.gradebookSearchClassId = current.id; state.gradebookSearch = ""; state.gradebookScoreFilter = "all"; } setWorkspaceLocation("Gradebook"); root.replaceChildren(); root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action(`← ${current.className}`, renderClass, "link-button")]));
  root.append(el("section", { class: "gradebook-screen" }, [el("div", { class: "page-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Scores & assessments" }), el("h1", { text: "Assessments & scores" }), el("p", { class: "intro", text: "Create shared assessments and enter scores. Use Assessment Center only when you want to author questions or print copies for the same assessment." })]), current.archivedAt ? null : action("Create assessment", () => prepAssessment(), "button")]), el("aside", { class: "policy-note policy-note--wide" }, [el("strong", { text: "Policy status: " }), `Only ${GENERIC_RAW_POLICY.name.toLowerCase()} is available. No DepEd grading configuration is selected or applied.`]) ]));
  if (!state.assessments.length) { root.append(el("section", { class: "empty-state" }, [el("div", { class: "empty-symbol", text: "▥", "aria-hidden": "true" }), el("h2", { text: "No assessments yet" }), el("p", { text: current.archivedAt ? "Restore this class before changing gradebook records." : "Create an assessment, then enter scores in roster order." }), !current.archivedAt ? action("Create assessment", () => prepAssessment(), "button") : null])); return; }
  const tools = state.assessments.length >= 8 ? gradebookAssessmentTools() : null, results = el("div", { "data-gradebook-assessment-results": "" }); if (tools) root.append(tools); root.append(results); renderGradebookAssessmentResults();
}
async function openAssessment(assessment, options = {}) {
  try {
    let selectedAssessment = assessment;
    const progressReturn = options.progressReturn || null;
    if (progressReturn) {
      const { classId, student } = progressReturn;
      if (state.activeClass?.id !== classId || state.activeClass.archivedAt) return;
      const [assessments, activeStudents] = await Promise.all([listAssessments(classId), listStudents(classId)]);
      if (state.activeClass?.id !== classId) return;
      selectedAssessment = assessments.find((item) => item.id === assessment.id && item.classId === classId);
      if (!selectedAssessment) { await refreshProgressContext(progressReturn, "This assessment is no longer available; Progress history was refreshed."); return; }
      if (!activeStudents.some((item) => item.id === options.focusStudentId && item.id === student.id)) { await refreshProgressContext(progressReturn, "This student is no longer active; their history remains view-only."); return; }
    }
    const scores = await listScores(selectedAssessment.id);
    if (progressReturn) {
      if (state.activeClass?.id !== progressReturn.classId) return;
      await refreshActiveClass();
      if (state.activeClass?.id !== progressReturn.classId) return;
      selectedAssessment = state.assessments.find((item) => item.id === selectedAssessment.id && item.classId === progressReturn.classId);
      if (!selectedAssessment) { await refreshProgressContext(progressReturn, "This assessment is no longer available; Progress history was refreshed."); return; }
      if (!state.students.some((item) => item.id === options.focusStudentId)) { await refreshProgressContext(progressReturn, "This student is no longer active; their history remains view-only."); return; }
    }
    const byStudent = new Map(scores.map((score) => [score.studentId, score.rawScore])); const rows = state.students.map((student) => ({ studentId: student.id, fullName: student.fullName, rawScore: byStudent.get(student.id) || "" })); const archivedRows = state.archivedStudents.filter((student) => byStudent.has(student.id)).map((student) => ({ studentId: student.id, fullName: student.fullName, rawScore: byStudent.get(student.id) })); state.activeAssessment = selectedAssessment; state.scorePaste = null; state.scoreSession = { rows, archivedRows, original: new Map(rows.map((row) => [row.studentId, row.rawScore])), dirty: false, errors: new Map(), focusStudentId: options.focusStudentId || null, progressReturn, search: "", filter: "all" }; renderAssessment(); if (options.focusStudentId) focusProgressScoreInput(options.focusStudentId);
  } catch (error) { errorMessage(error); }
}
function focusProgressScoreInput(studentId) { const input = [...root.querySelectorAll("[data-score-input]")].find((item) => item.getAttribute("data-score-input") === studentId); if (!input) return; input.scrollIntoView?.({ block: "center" }); input.focus({ preventScroll: true }); }
function scoreSessionDirty() { const session = state.scoreSession; return session.rows.some((row) => row.rawScore !== session.original.get(row.studentId)); }
function updateScoreDraft(studentId, value, input = null) { const row = state.scoreSession.rows.find((item) => item.studentId === studentId); if (!row) return; row.rawScore = value; state.scoreSession.dirty = scoreSessionDirty(); const indicator = root.querySelector("[data-score-save-state]"); if (indicator) { indicator.textContent = state.scoreSession.dirty ? "Unsaved changes" : "Saved on this device"; indicator.className = state.scoreSession.dirty ? "save-state is-dirty" : "save-state"; } if (input) { const detail = scoreDisplay(value, state.activeAssessment.maximumScore); const result = input.closest("li")?.querySelector(".score-result"); if (result) { result.textContent = detail.label; result.className = detail.error ? "score-result has-error" : "score-result"; } } }
function validateScoreRow(row) { const result = validateScoreInput(row.rawScore, state.activeAssessment.maximumScore); if (result.error) return result.error; row.rawScore = result.rawScore; return null; }
function validateScoreSession() { const errors = new Map(); state.scoreSession.rows.forEach((row) => { const error = validateScoreRow(row); if (error) errors.set(row.studentId, error); }); state.scoreSession.errors = errors; return errors.size === 0; }
function scoreText(value) { return value == null || String(value).trim() === "" ? "Missing" : String(value); }
function renderScorePasteReview() {
  const form = dialogs["score-paste"].querySelector("form"), session = state.scoreSession, assessment = state.activeAssessment;
  if (!session || !assessment) return;
  const output = reviewPastedScores({ text: form.elements.scores.value, rows: session.rows, original: session.original, maximumScore: assessment.maximumScore });
  state.scorePaste = output;
  const summary = dialogs["score-paste"].querySelector("[data-score-paste-summary]"), target = dialogs["score-paste"].querySelector("[data-score-paste-review]"), confirm = form.elements.confirmPaste, apply = form.querySelector("[data-apply-pasted-scores]");
  const conflicts = output.review.filter((entry) => entry.replacesUnsavedEdit).length;
  const issue = output.invalid.length ? `${output.invalid.length} invalid value${output.invalid.length === 1 ? "" : "s"} must be fixed.` : output.extraLines.length ? `${output.extraLines.length} extra line${output.extraLines.length === 1 ? "" : "s"} has no active student and will not be applied.` : output.changes.length ? `${output.changes.length} score${output.changes.length === 1 ? "" : "s"} will update the unsaved draft only.` : "No nonblank score changes to apply.";
  summary.textContent = `${issue}${conflicts ? ` ${conflicts} change${conflicts === 1 ? "" : "s"} replaces an unsaved edit; review it below.` : ""} Save Scores is still required to store changes.`;
  target.replaceChildren();
  const list = el("ol", { class: "score-paste-review", "aria-label": "Pasted score review" });
  output.review.forEach((entry) => list.append(el("li", { class: `score-paste-row is-${entry.kind}` }, [el("strong", { text: `${entry.line}. ${entry.fullName}` }), el("span", { text: `Current: ${scoreText(entry.current)}` }), el("span", { text: `Pasted: ${entry.hasLine ? (entry.pasted.trim() ? entry.pasted : "Blank") : "No pasted line"}` }), el("span", { class: "score-paste-status", text: entry.result })])));
  target.append(list);
  if (output.extraLines.length) target.append(el("p", { class: "field-error", text: `Extra pasted line${output.extraLines.length === 1 ? "" : "s"}: ${output.extraLines.map((entry) => entry.line).join(", ")}. Remove them before applying so no score can be shifted to the wrong student.` }));
  confirm.checked = output.canApply ? confirm.checked : false;
  confirm.disabled = !output.canApply;
  apply.disabled = !output.canApply || !confirm.checked;
}
function prepScorePaste() { const form = dialogs["score-paste"].querySelector("form"); form.reset(); state.scorePaste = null; renderScorePasteReview(); show("score-paste"); }
function applyPastedScores() {
  const session = state.scoreSession, output = state.scorePaste;
  if (!session || !output?.canApply) return;
  const changed = output.changes.map((entry) => entry.studentId);
  output.changes.forEach((entry) => { const row = session.rows.find((candidate) => candidate.studentId === entry.studentId); if (row) row.rawScore = entry.value; });
  session.errors.clear(); session.dirty = scoreSessionDirty(); state.scorePaste = null; hide("score-paste"); renderAssessment();
  requestAnimationFrame(() => root.querySelector(`[data-score-input="${changed[0]}"]`)?.focus());
  announce(`${changed.length} reviewed score${changed.length === 1 ? " is" : "s are"} in the unsaved draft. Select Save scores to store ${changed.length === 1 ? "it" : "them"} on this device.`);
}
function focusNextScore(studentId) { const inputs = [...root.querySelectorAll("[data-score-input]")]; const index = inputs.findIndex((input) => input.dataset.scoreInput === studentId); inputs[index + 1]?.focus(); }
function advanceScoreInput(studentId, input) { const row = state.scoreSession.rows.find((item) => item.studentId === studentId); if (!row) return; updateScoreDraft(studentId, input.value, input); const error = validateScoreRow(row); if (error) { state.scoreSession.errors.set(studentId, error); renderAssessment(); requestAnimationFrame(() => root.querySelector(`[data-score-input="${studentId}"]`)?.focus()); announce("Fix the highlighted score before moving on."); return; } state.scoreSession.errors.delete(studentId); input.value = row.rawScore; updateScoreDraft(studentId, row.rawScore, input); focusNextScore(studentId); }
function hasSavedScore(value) { return value != null && String(value).trim() !== ""; }
function visibleScoreRows(session) {
  const query = searchQuery(session.search);
  return session.rows.filter((row) => {
    const saved = hasSavedScore(session.original.get(row.studentId));
    const matchesFilter = session.filter === "all" || (session.filter === "missing" && !saved) || (session.filter === "recorded" && saved);
    return matchesFilter && matchesSearch(query, row.fullName);
  });
}
function renderScoreEntryResults() {
  const session = state.scoreSession, list = root.querySelector("[data-score-entry-list]"); if (!session || !list) return;
  const shown = visibleScoreRows(session), saved = session.rows.filter((row) => hasSavedScore(session.original.get(row.studentId))).length;
  list.replaceChildren();
  const count = root.querySelector("[data-score-entry-count]");
  if (count) count.textContent = `${shown.length} of ${session.rows.length} active students shown · ${saved} saved, ${session.rows.length - saved} missing. Filters reflect saved scores; changes remain a draft until Save scores.`;
  if (!shown.length) { list.append(el("li", { class: "score-empty-result", text: session.search.trim() ? `No active students match “${session.search.trim()}”.` : session.filter === "missing" ? "No missing saved scores for this assessment." : "No recorded saved scores for this assessment." })); return; }
  shown.forEach((row) => {
    const index = session.rows.indexOf(row), error = session.errors.get(row.studentId), detail = scoreDisplay(row.rawScore, state.activeAssessment.maximumScore);
    const input = el("input", { type: "text", inputmode: "decimal", autocomplete: "off", class: "score-input", "data-score-input": row.studentId, value: row.rawScore, "aria-label": `${row.fullName} score out of ${state.activeAssessment.maximumScore}`, "aria-invalid": error ? "true" : null, "aria-describedby": error ? `score-error-${row.studentId}` : null, onInput: (event) => updateScoreDraft(row.studentId, event.currentTarget.value, event.currentTarget), onKeydown: (event) => { if (event.key === "Enter") { event.preventDefault(); advanceScoreInput(row.studentId, event.currentTarget); } } });
    const result = error ? null : el("span", { class: detail.error ? "score-result has-error" : "score-result", text: detail.label });
    list.append(el("li", { "data-score-student-row": row.studentId }, [el("span", { class: "attendance-number", text: index + 1 }), el("strong", { text: row.fullName }), el("label", { class: "score-field" }, [el("span", { class: "sr-only", text: `Score for ${row.fullName}` }), input, error ? el("span", { id: `score-error-${row.studentId}`, class: "field-error", text: error }) : null]), result]));
  });
}
function scoreEntryTools(session) {
  return el("div", { class: "score-entry-tools" }, [el("label", { class: "field" }, [el("span", { text: "Find a student" }), el("input", { type: "search", value: session.search, placeholder: "Type a student name", "data-score-search": "", "aria-controls": "score-entry-list", onInput: (event) => { session.search = event.currentTarget.value; renderScoreEntryResults(); } })]), el("label", { class: "field" }, [el("span", { text: "Saved score status" }), el("select", { value: session.filter, "data-score-filter": "", onChange: (event) => { session.filter = event.currentTarget.value; renderScoreEntryResults(); } }, [el("option", { value: "all", text: "All students" }), el("option", { value: "missing", text: "Missing saved scores" }), el("option", { value: "recorded", text: "Recorded saved scores" })])]), el("p", { class: "subtle score-entry-count", role: "status", "aria-live": "polite", "aria-atomic": "true", "data-score-entry-count": "" })]);
}
function requestScoreExit(next) { if (state.scoreSession?.dirty) { state.pendingScoreExit = next; show("leave-scores"); return; } completeScoreExit(next); }
function completeScoreExit(next) { state.pendingScoreExit = null; state.scorePaste = null; state.scoreSession = null; state.activeAssessment = null; next?.(); }
async function persistScores() { if (!validateScoreSession()) { const firstInvalid = state.scoreSession.rows.find((row) => state.scoreSession.errors.has(row.studentId)); state.scoreSession.search = ""; state.scoreSession.filter = "all"; renderAssessment(); requestAnimationFrame(() => firstInvalid && focusProgressScoreInput(firstInvalid.studentId)); announce("Fix the highlighted score before saving."); return; } try { await saveScores(state.activeAssessment.id, state.scoreSession.rows); noteClassroomChange(); state.scoreSession.original = new Map(state.scoreSession.rows.map((row) => [row.studentId, row.rawScore])); state.scoreSession.dirty = false; await refreshActiveClass(); state.activeAssessment = state.assessments.find((assessment) => assessment.id === state.activeAssessment.id) || state.activeAssessment; renderAssessment(); announce(`Scores for ${state.activeAssessment.title} were saved on this device.`); } catch (error) { errorMessage(error); } }
function renderAssessment() {
  const assessment = state.activeAssessment, session = state.scoreSession; if (!assessment || !session) { renderGradebook(); return; } setWorkspaceLocation("Gradebook"); root.replaceChildren(); root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action(session.progressReturn ? "← Student Progress" : "← Gradebook", () => requestScoreExit(session.progressReturn ? () => returnToProgressContext(session.progressReturn) : renderGradebook), "link-button")]));
  root.append(el("section", { class: "assessment-screen" }, [el("div", { class: "attendance-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Assessment scores" }), el("h1", { text: assessment.title }), el("p", { class: "intro", text: `${assessment.date} · Maximum score ${assessment.maximumScore} · ${assessmentMeta(assessment)}` })]), el("div", { class: "attendance-save" }, [el("span", { class: session.dirty ? "save-state is-dirty" : "save-state", "data-score-save-state": "", text: session.dirty ? "Unsaved changes" : "Saved on this device" }), action("Save scores", persistScores, "button")])]), el("aside", { class: "policy-note policy-note--wide" }, [el("strong", { text: "Raw percentage only. " }), "Percentages use exact decimal arithmetic and round half up to two decimal places; they are not official grades."]), el("div", { class: "assessment-actions" }, [action("Paste scores", prepScorePaste, "button button--quiet"), action("Author questions", () => requestScoreExit(() => openAuthoring(assessment)), "button button--quiet"), action("Edit assessment", () => requestScoreExit(() => prepAssessment(assessment)), "button button--quiet"), action("Delete assessment", () => requestScoreExit(() => prepDeleteAssessment(assessment)), "button button--danger")]) ]));
  if (session.rows.length >= 12) root.append(scoreEntryTools(session));
  const list = el("ol", { id: "score-entry-list", class: "score-list", "aria-label": `Scores for ${assessment.title}`, "data-score-entry-list": "" }); root.append(list); renderScoreEntryResults();
  if (session.archivedRows.length) { const history = el("details", { class: "archived-students" }, [el("summary", { text: `${session.archivedRows.length} archived student score${session.archivedRows.length === 1 ? "" : "s"} preserved` })]); const rows = el("ul", { class: "archived-score-list" }); session.archivedRows.forEach((row) => rows.append(el("li", {}, [el("strong", { text: row.fullName }), el("span", { text: scoreDisplay(row.rawScore, assessment.maximumScore).label })]))); history.append(rows); root.append(history); }
}
function assessmentCenterOverview(current) { return el("section", { class: "assessment-center-overview", "data-class-tool": "Assessment Center", "aria-labelledby": "assessment-center-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Assessment Center" }), el("h2", { id: "assessment-center-heading", text: "Teacher-authored assessments" }), el("p", { text: "Optionally add questions and print student copies or answer keys for the same assessments used in Gradebook." })]), current.archivedAt ? null : action("Open Assessment Center", renderAssessmentCenter, "button button--quiet")]), el("p", { class: "subtle", text: "Questions and answers stay on this device. Enter only materials you are entitled to use." })]); }
function renderAssessmentCenter() {
  const current = state.activeClass; if (!current) return renderDashboard(); setWorkspaceLocation("Assessment Center"); state.activeAssessment = null; root.replaceChildren();
  root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action(`← ${current.className}`, renderClass, "link-button")]));
  root.append(el("section", { class: "gradebook-screen" }, [el("div", { class: "page-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Assessment Center" }), el("h1", { text: "Author & print" }), el("p", { class: "intro", text: "Optionally author questions and print student copies or answer keys for the same shared Gradebook assessments." })]), !current.archivedAt ? action("Create assessment", () => prepAssessment(null, true), "button") : null])]));
  if (!state.assessments.length) { root.append(el("section", { class: "empty-state" }, [el("div", { class: "empty-symbol", text: "✎", "aria-hidden": "true" }), el("h2", { text: "No assessments yet" }), el("p", { text: "Create an assessment here or in Gradebook. Add questions if you want printable student copies or an answer key for that same assessment." }), !current.archivedAt ? action("Create assessment", () => prepAssessment(null, true), "button") : null])); return; }
  const list = el("section", { class: "assessment-list", "aria-label": "Assessment authoring list" });
  state.assessments.forEach((assessment) => list.append(el("article", { class: "assessment-card" }, [el("div", { class: "assessment-date", text: assessment.authoringStatus === "ready" ? "Ready" : "Draft" }), el("div", { class: "assessment-card-body" }, [el("h2", { text: assessment.title }), el("p", { text: `${assessment.assessmentKind || "quiz"} · ${assessment.maximumScore} maximum` }), el("span", { class: "count-label", text: "Uses the shared Gradebook assessment" })]), el("div", { class: "assessment-actions" }, [action("Author questions", () => openAuthoring(assessment), "button button--small"), action("Enter scores", () => openAssessment(assessment), "link-button"), action("Save to My Materials", () => beginSaveMaterial("assessment", assessment), "link-button")])])));
  root.append(list);
}
async function openAuthoring(assessment) { try { state.activeAssessment = assessment; state.authoredQuestions = await listQuestions(assessment.id); renderAuthoring(); } catch (error) { errorMessage(error); } }
function questionTypeLabel(type) { return { "multiple-choice": "Multiple choice", "true-false": "True / False", "short-answer": "Short answer", essay: "Essay" }[type] || type; }
async function refreshAuthoring() { state.authoredQuestions = await listQuestions(state.activeAssessment.id); state.activeAssessment = (await listAssessments(state.activeClass.id)).find((assessment) => assessment.id === state.activeAssessment.id) || state.activeAssessment; }
async function markAssessmentReady() { try { const saved = await updateAssessmentAuthoringStatus(state.activeAssessment.id, "ready"); noteClassroomChange(); state.activeAssessment = saved; await refreshAuthoring(); renderAuthoring(); announce("Assessment is Ready to preview and print."); } catch (error) { errorMessage(error); } }
async function moveAuthoredQuestion(question, direction) { try { await moveQuestion(question.id, direction); await refreshAuthoring(); renderAuthoring(); } catch (error) { errorMessage(error); } }
async function duplicateQuestion(question) { try { await saveAuthoredQuestion({ ...question, id: null, options: question.options.map((option) => ({ text: option.text, correct: option.id === question.correctOptionId })) }, state.activeAssessment.id); noteClassroomChange(); await refreshAuthoring(); renderAuthoring(); announce("Question duplicated in draft form."); } catch (error) { errorMessage(error); } }
async function removeQuestion(question) { if (!window.confirm(`Delete question ${state.authoredQuestions.findIndex((item) => item.id === question.id) + 1}? This cannot be undone.`)) return; try { await deleteQuestionPermanently(question.id); noteClassroomChange(); await refreshAuthoring(); renderAuthoring(); announce("Question deleted."); } catch (error) { errorMessage(error); } }
async function syncQuestionTotal(confirmScored = false) { try { const output = await syncAssessmentMaximumToQuestionTotal(state.activeAssessment.id, { confirmScored }); if (output.needsConfirmation) { dialogs["sync-maximum"].querySelector("[data-sync-copy]").textContent = `${output.scoreCount} saved score${output.scoreCount === 1 ? "" : "s"} will keep their raw values. Their generic raw percentages will recalculate against the new authored total of ${output.totalPoints}.`; show("sync-maximum"); return; } noteClassroomChange(); state.activeAssessment = output.assessment; await refreshAuthoring(); renderAuthoring(); announce(`Maximum score updated to ${output.totalPoints}.`); } catch (error) { errorMessage(error); } }
function renderAuthoring() { const assessment = state.activeAssessment, questions = state.authoredQuestions; if (!assessment) return renderAssessmentCenter(); setWorkspaceLocation("Assessment Center"); const total = questions.length ? questionTotalPoints(questions) : "0"; root.replaceChildren(); root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action("← Assessment Center", renderAssessmentCenter, "link-button")])); root.append(el("section", { class: "authoring-screen" }, [el("div", { class: "attendance-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: `Assessment Center · ${assessment.authoringStatus === "ready" ? "Ready" : "Draft"}` }), el("h1", { text: assessment.title }), el("p", { class: "intro", text: `${questions.length} question${questions.length === 1 ? "" : "s"} · ${total} authored point${total === "1" ? "" : "s"} · Gradebook maximum ${assessment.maximumScore}` })]), el("div", { class: "attendance-save" }, [assessment.authoringStatus === "ready" ? el("span", { class: "save-state", text: "Ready to print" }) : el("span", { class: "save-state is-dirty", text: "Draft" }), action("Mark Ready", markAssessmentReady, "button")])]), el("div", { class: "authoring-actions" }, [action("Add question", () => prepQuestion(), "button"), action("Preview student copy", () => renderPrintPreview("student"), "button button--quiet"), action("Preview answer key", () => renderPrintPreview("key"), "button button--quiet"), action("Enter scores", () => openAssessment(assessment), "button button--quiet"), action("Duplicate assessment", async () => { try { const duplicate = await duplicateAuthoredAssessment(assessment.id); await refreshActiveClass(); await openAuthoring(duplicate); announce("Assessment duplicated without student scores."); } catch (error) { errorMessage(error); } }, "button button--quiet"), action("Copy to another class", () => prepCopyContent("assessment", assessment), "button button--quiet")]), total !== assessment.maximumScore ? el("aside", { class: "policy-note policy-note--wide" }, [`Authored total is ${total}; Gradebook maximum is ${assessment.maximumScore}. `, action("Use authored total as maximum", () => syncQuestionTotal(), "link-button")]) : null])); if (!questions.length) { root.append(el("section", { class: "empty-state" }, [el("h2", { text: "Start authoring" }), el("p", { text: "Add questions in Draft, then mark the assessment Ready only after every required answer and point value is complete." }), action("Add first question", () => prepQuestion(), "button")])); return; } const list = el("ol", { class: "question-list", "aria-label": "Authored questions" }); questions.forEach((question, index) => { const summary = question.questionType === "multiple-choice" ? `${question.options.length} choices · ${question.correctOptionId ? "answer selected" : "no answer selected"}` : question.questionType === "true-false" ? (question.correctBoolean ? `Correct: ${question.correctBoolean}` : "No answer selected") : question.questionType === "short-answer" ? (question.referenceAnswer ? "Reference answer saved" : "No reference answer") : question.guidance ? "Guidance saved" : "No guidance"; list.append(el("li", {}, [el("div", { class: "question-card-heading" }, [el("span", { class: "question-number", text: index + 1 }), el("div", {}, [el("strong", { text: questionTypeLabel(question.questionType) }), el("span", { text: `${question.points} point${question.points === "1" ? "" : "s"} · ${summary}` })])]), el("p", { text: question.prompt }), el("div", { class: "question-actions" }, [action("Edit", () => prepQuestion(question), "link-button"), action("Duplicate", () => duplicateQuestion(question), "link-button"), action("Move up", () => moveAuthoredQuestion(question, "up"), "link-button"), action("Move down", () => moveAuthoredQuestion(question, "down"), "link-button"), action("Delete", () => removeQuestion(question), "link-button")]) ])); }); root.append(list); }
function printQuestion(question, index, mode, showPoints = false) { const heading = `${index + 1}. ${question.prompt}${mode === "student" && showPoints ? ` (${question.points} pt${question.points === "1" ? "" : "s"})` : ""}`; const section = el("section", { class: "print-question" }, [el("h2", { text: heading })]); if (mode === "student") { if (question.questionType === "multiple-choice") section.append(el("ol", { class: "print-options", type: "A" }, question.options.map((option) => el("li", { text: option.text })))); else if (question.questionType === "true-false") section.append(el("p", { text: "☐ True    ☐ False" })); else section.append(el("div", { class: question.questionType === "essay" ? "writing-space writing-space--essay" : "writing-space" })); } else { const answer = question.questionType === "multiple-choice" ? question.options.find((option) => option.id === question.correctOptionId)?.text || "No answer set" : question.questionType === "true-false" ? question.correctBoolean || "No answer set" : question.questionType === "short-answer" ? question.referenceAnswer || "No reference answer set" : question.guidance || "No teacher guidance supplied"; section.append(el("p", { class: "print-answer", text: `Answer: ${answer}` })); } return section; }
function renderPrintPreview(mode) { const assessment = state.activeAssessment, questions = state.authoredQuestions; root.replaceChildren(); const header = el("header", { class: "print-header" }, [el("p", { class: "eyebrow", text: mode === "student" ? "Student copy" : "Teacher answer key" }), el("h1", { text: assessment.title }), el("p", { text: `${state.activeClass.className}${state.activeClass.subject ? ` · ${state.activeClass.subject}` : ""}` }), mode === "student" ? el("div", { class: "student-lines" }, [el("span", { text: "Name: ______________________________" }), el("span", { text: "Date: __________________" })]) : el("p", { text: `Total points: ${questionTotalPoints(questions)}` }), assessment.instructions ? el("p", { class: "print-instructions", text: assessment.instructions }) : null]); root.append(el("div", { class: "print-controls" }, [action(`← Back to ${assessment.title}`, renderAuthoring, "button button--quiet"), action(mode === "student" ? "Print student copy" : "Print answer key", () => window.print(), "button")]), el("article", { class: `print-preview print-preview--${mode}` }, [header, ...questions.map((question, index) => printQuestion(question, index, mode, Boolean(assessment.showPoints)))])); }

function freshClassroomSession(classId) { return { classId, picker: createPickerState(), groups: null, groupCount: "", groupSize: "", groupMode: "count", message: "", timer: createTimer(), completionAnnounced: false }; }
function classroomSession() { if (!state.activeClass) return null; if (state.classroom.classId !== state.activeClass.id) state.classroom = freshClassroomSession(state.activeClass.id); return state.classroom; }
function classroomRoster() { return state.students.filter((student) => !student.archivedAt); }
function reconcileClassroomSession() { const session = classroomSession(); if (!session) return null; const eligible = new Set(classroomRoster().map((student) => student.id)); session.picker.pickedIds = session.picker.pickedIds.filter((id) => eligible.has(id)); session.picker.historyIds = session.picker.historyIds.filter((id) => eligible.has(id)); if (!eligible.has(session.picker.lastStudentId)) session.picker.lastStudentId = null; if (session.groups?.some((group) => group.some((id) => !eligible.has(id)))) session.groups = null; return session; }
function secureUnit() { return secureRandomIndex(1000000) / 1000000; }
function classroomName(id) { return classroomRoster().find((student) => student.id === id)?.fullName || null; }
function pickerResult(session) { return classroomName(session.picker.lastStudentId); }
function formatPickerProgress(session) { const active = classroomRoster().length; return session.picker.avoidRepeats ? `${session.picker.pickedIds.length} of ${active} students picked` : `${active} active student${active === 1 ? "" : "s"} eligible`; }
function timerUpdate() { const session = classroomSession(); if (!session) return; const prior = session.timer.status; session.timer = timerSnapshot(session.timer); const display = root.querySelector("[data-classroom-timer]"); if (display) { display.textContent = formatTimer(session.timer.remainingMs); display.dataset.status = session.timer.status; } const status = root.querySelector("[data-timer-status]"); if (status) status.textContent = session.timer.status === "complete" ? "Time is up" : session.timer.status === "running" ? "Running" : session.timer.status === "paused" ? "Paused" : session.timer.status === "ready" ? "Ready" : "Choose a duration"; if (prior !== "complete" && session.timer.status === "complete" && !session.completionAnnounced) { session.completionAnnounced = true; announce("Timer complete."); } }
setInterval(timerUpdate, 250);
function setTimerDuration(milliseconds) { const session = classroomSession(); if (!session) return; session.timer = createTimer(milliseconds); session.completionAnnounced = false; renderClassroomMode(); }
function startClassroomTimer() { const session = classroomSession(); if (!session) return; session.timer = startTimer(session.timer); session.completionAnnounced = false; timerUpdate(); renderClassroomMode(); }
function pauseClassroomTimer() { const session = classroomSession(); if (!session) return; session.timer = pauseTimer(session.timer); renderClassroomMode(); }
function resetClassroomTimer() { const session = classroomSession(); if (!session) return; session.timer = resetTimer(session.timer); session.completionAnnounced = false; renderClassroomMode(); }
function addClassroomMinute() { const session = classroomSession(); if (!session) return; session.timer = addTimerMinute(session.timer); session.completionAnnounced = false; renderClassroomMode(); }
function pickClassroomStudent() { const session = reconcileClassroomSession(); if (!session) return; const output = pickStudent(classroomRoster(), session.picker); session.picker = output.picker; if (output.complete) { announce("This avoid-repeats round is complete. Start a new round to continue."); } else if (output.student) announce(`${output.student.fullName} was selected.`); else announce("Add an active student before picking."); renderClassroomMode(); }
function resetClassroomRound() { const session = classroomSession(); if (!session) return; session.picker = resetPickerRound({ ...session.picker }); renderClassroomMode(); announce("Picker round reset."); }
function makeClassroomGroups() { const session = reconcileClassroomSession(); if (!session) return; try { session.groups = session.groupMode === "size" ? generateBalancedGroupsBySize(classroomRoster(), session.groupSize, secureUnit) : generateBalancedGroups(classroomRoster(), session.groupCount, secureUnit); announce(session.groupMode === "size" ? `${session.groups.length} balanced groups created, with up to ${session.groupSize} students each.` : `${session.groups.length} balanced random groups created.`); renderClassroomMode(); } catch (error) { errorMessage(error); } }
async function copyClassroomGroups() { const session = classroomSession(); if (!session?.groups) return; const text = groupsPlainText(session.groups, classroomRoster()); try { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text); else throw new Error("Clipboard API unavailable"); announce("Groups copied as plain text."); } catch { const helper = document.createElement("textarea"); helper.value = text; helper.setAttribute("readonly", ""); helper.className = "sr-only"; document.body.append(helper); helper.select(); const copied = document.execCommand?.("copy"); helper.remove(); announce(copied ? "Groups copied as plain text." : "Copy is unavailable in this browser; select the visible group names manually."); } }
async function enterDisplayMode() { const session = reconcileClassroomSession(); if (!session) return; document.body.classList.add("is-classroom-display"); renderClassroomDisplay(); }
function leaveDisplayMode() { document.body.classList.remove("is-classroom-display"); renderClassroomMode(); }
async function toggleFullscreen() { try { if (!document.fullscreenEnabled) throw new Error("Fullscreen is not supported in this browser."); if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); renderClassroomDisplay(); } catch (error) { errorMessage(error); } }
function classroomGroupCards(groups, roster = classroomRoster()) {
  const byId = new Map(roster.map((student) => [student.id, student.fullName]));
  const cards = groups.map((group, index) => el("article", { class: "classroom-group" }, [
    el("h3", { text: `Group ${index + 1} · ${group.length}` }),
    el("ol", {}, group.map((id) => el("li", { text: byId.get(id) || "Student no longer active" })))
  ]));
  return el("section", { class: "classroom-groups", "aria-label": "Generated groups" }, cards);
}
function classroomLessonReference(current) {
  const selected = selectLessonReference({ classId: current.id, lessons: state.lessons, localDate: getLocalDateString() }), lesson = selected.lesson;
  if (!lesson) return null;
  const groups = [
    ["Before", [["Learning goal", lesson.learningGoals], ["Prior knowledge", lesson.priorKnowledge], ["Materials", lesson.materials]]],
    ["During", [["Opening", lesson.before], ["Activities", lesson.during], ["Check for understanding", lesson.checkForUnderstanding]]],
    ["After", [["Assessment / evidence", lesson.assessment]]]
  ].map(([title, fields]) => {
    const content = fields.filter(([, value]) => typeof value === "string" && value.trim()).map(([label, value]) => el("div", { class: "classroom-lesson-field" }, [el("h4", { text: label }), el("p", { text: value })]));
    return content.length ? el("section", { class: "classroom-lesson-section" }, [el("h3", { text: title }), ...content]) : null;
  }).filter(Boolean);
  const status = lesson.status === "ready" ? "Ready" : "Draft";
  const dateLabel = lessonReferenceContext(selected);
  return el("details", { class: "classroom-lesson-reference" }, [
    el("summary", {}, [el("span", { text: "Lesson reference" }), el("strong", { text: lesson.title }), el("small", { text: `${status} · ${dateLabel}` })]),
    el("div", { class: "classroom-lesson-content", "aria-label": "Saved lesson plan reference" }, groups.length ? groups : el("p", { class: "subtle", text: "No lesson planning details have been saved yet." }))
  ]);
}
function renderClassroomMode() {
  document.body.classList.remove("is-classroom-display"); const current = state.activeClass; if (!current) { renderDashboard(); announce("Choose a class before using Classroom Mode."); return; } if (current.archivedAt) { renderClass(); announce("Restore this class before starting a new classroom activity."); return; } setWorkspaceLocation("Classroom Mode");
  const session = reconcileClassroomSession(), roster = classroomRoster(), selected = pickerResult(session); root.replaceChildren(); root.append(el("nav", { class: "crumb-nav classroom-crumb", "aria-label": "Breadcrumb" }, [action(`← ${current.className}`, renderClass, "link-button")]));
  root.append(el("section", { class: "classroom-hero" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Live Classroom Mode" }), el("h1", { text: current.className }), el("p", { class: "intro", text: `${roster.length} active student${roster.length === 1 ? "" : "s"} · session-only tools` })]), action("Display", enterDisplayMode, "button classroom-display-button") ]));
  if (!roster.length) { root.append(el("section", { class: "empty-state" }, [el("div", { class: "empty-symbol", text: "○", "aria-hidden": "true" }), el("h2", { text: "Add students first" }), el("p", { text: "Classroom Mode uses the active roster already entered for this class. Archived students are not included." }), action("Add students", renderClass, "button") ])); return; }
  const lessonReference = classroomLessonReference(current); if (lessonReference) root.append(lessonReference);
  const pickerHeader = el("div", { class: "classroom-tool-heading" }, [
    el("div", {}, [el("p", { class: "eyebrow", text: "Pick Student" }), el("h2", { id: "picker-heading", text: "Choose from the active roster" }), el("p", { text: "Local random selection only—no grades, attendance, or profile data are used." })]),
    el("label", { class: "check-row classroom-check" }, [el("input", { type: "checkbox", checked: session.picker.avoidRepeats, onChange: (event) => { session.picker.avoidRepeats = event.currentTarget.checked; if (!session.picker.avoidRepeats) session.picker.pickedIds = []; renderClassroomMode(); } }), el("span", { text: "Avoid repeats this round" })])
  ]);
  const pickerHistory = session.picker.historyIds.length ? el("section", { class: "picker-history", "aria-label": "Recent selections" }, [el("h3", { text: "Recent selections" }), el("ol", {}, session.picker.historyIds.map((id) => el("li", { text: classroomName(id) || "Student no longer active" })))]) : null;
  const picker = el("section", { class: "classroom-tool classroom-picker", "aria-labelledby": "picker-heading" }, [pickerHeader, el("div", { class: selected ? "picker-result is-selected" : "picker-result", role: "status", "aria-live": "polite" }, [el("span", { text: selected || "Ready to pick" }), el("small", { text: formatPickerProgress(session) })]), el("div", { class: "classroom-controls" }, [action("Pick a student", pickClassroomStudent, "button classroom-primary"), action("Reset round", resetClassroomRound, "button button--quiet")]), session.picker.avoidRepeats && session.picker.pickedIds.length === roster.length ? el("p", { class: "classroom-complete", text: "Round complete. Start a new round to pick again." }) : null, pickerHistory]);
  const groupMode = el("select", { id: "classroom-group-mode", onChange: (event) => { session.groupMode = event.currentTarget.value; renderClassroomMode(); root.querySelector("#classroom-group-mode")?.focus(); } }, [el("option", { value: "count", selected: session.groupMode === "count", text: "Number of groups" }), el("option", { value: "size", selected: session.groupMode === "size", text: "Students per group" })]);
  const groupInput = el("input", { type: "number", min: 1, max: roster.length, step: 1, inputmode: "numeric", value: session.groupMode === "size" ? session.groupSize : session.groupCount, placeholder: session.groupMode === "size" ? "e.g. 4" : "e.g. 6", "aria-label": session.groupMode === "size" ? "Maximum students per group" : "Number of groups", onInput: (event) => { if (session.groupMode === "size") session.groupSize = event.currentTarget.value; else session.groupCount = event.currentTarget.value; } });
  const groupInputLabel = session.groupMode === "size" ? "Maximum students per group" : "Number of groups";
  const groupHint = session.groupMode === "size" ? `Choose a whole-number maximum from 1 to ${roster.length}; group sizes will stay balanced without exceeding it.` : `Choose from 1 to ${roster.length} groups.`;
  const groups = el("section", { class: "classroom-tool classroom-group-maker", "aria-labelledby": "groups-heading" }, [el("div", { class: "classroom-tool-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Make Groups" }), el("h2", { id: "groups-heading", text: "Balanced random groups" }), el("p", { text: "Every active student appears once. Group sizes differ by at most one." })])]), el("label", { class: "group-mode-select" }, [el("span", { text: "Grouping method" }), groupMode]), el("div", { class: "group-input-row" }, [el("label", {}, [el("span", { text: groupInputLabel }), groupInput]), action(session.groups ? "Regenerate groups" : "Make groups", makeClassroomGroups, "button classroom-primary")]), session.groups ? el("div", {}, [el("div", { class: "classroom-controls" }, [action("Copy groups", copyClassroomGroups, "button button--quiet")]), classroomGroupCards(session.groups)]) : el("p", { class: "subtle", text: groupHint })]);
  const timer = session.timer; const timerTool = el("section", { class: "classroom-tool classroom-timer-tool", "aria-labelledby": "timer-heading" }, [el("div", { class: "classroom-tool-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Timer" }), el("h2", { id: "timer-heading", text: "Countdown" }), el("p", { text: "Uses a deadline clock so delayed browser ticks correct themselves." })])]), el("div", { class: "timer-readout", "data-classroom-timer": "", "data-status": timer.status, role: "timer", "aria-label": `Time remaining ${formatTimer(timer.remainingMs)}`, text: formatTimer(timer.remainingMs) }), el("p", { class: "timer-status", "data-timer-status": "", role: "status", text: timer.status === "complete" ? "Time is up" : timer.status === "running" ? "Running" : timer.status === "paused" ? "Paused" : timer.status === "ready" ? "Ready" : "Choose a duration" }), el("div", { class: "timer-presets" }, [[1, 3, 5, 10].map((minutes) => action(`${minutes} min`, () => setTimerDuration(minutes * 60000), "button button--quiet"))]), el("div", { class: "group-input-row" }, [el("label", {}, [el("span", { text: "Custom minutes" }), el("input", { type: "number", min: 1, max: 180, inputmode: "numeric", placeholder: "Minutes", onChange: (event) => { const minutes = Number(event.currentTarget.value); if (Number.isInteger(minutes) && minutes > 0 && minutes <= 180) setTimerDuration(minutes * 60000); else errorMessage(new Error("Enter a whole number from 1 to 180 minutes.")); } })]), action(timer.status === "running" ? "Pause" : timer.status === "paused" ? "Resume" : "Start", timer.status === "running" ? pauseClassroomTimer : startClassroomTimer, "button classroom-primary")]), el("div", { class: "classroom-controls" }, [action("+1 minute", addClassroomMinute, "button button--quiet"), action("Reset", resetClassroomTimer, "button button--quiet")])]);
  const message = el("section", { class: "classroom-tool classroom-message", "aria-labelledby": "message-heading" }, [el("div", { class: "classroom-tool-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Display" }), el("h2", { id: "message-heading", text: "Temporary classroom message" }), el("p", { text: "Shown only if you open Display Mode. It is not saved after refresh or browser close." })])]), el("label", { class: "field classroom-message-field" }, [el("span", { text: "Message" }), el("textarea", { rows: 3, maxlength: 500, value: session.message, placeholder: "Complete questions 1–5. You have 10 minutes.", onInput: (event) => { session.message = event.currentTarget.value; } })])]);
  root.append(el("div", { class: "classroom-grid" }, [picker, groups, timerTool, message]));
}
function renderClassroomDisplay() { setWorkspaceLocation("Classroom Display"); const session = reconcileClassroomSession(), selected = pickerResult(session), roster = classroomRoster(); root.replaceChildren(); root.append(el("section", { class: "classroom-display" }, [el("header", { class: "display-controls" }, [action("← Classroom Mode", leaveDisplayMode, "button button--quiet"), action(document.fullscreenElement ? "Exit fullscreen" : "Fullscreen", toggleFullscreen, "button")]), el("p", { class: "eyebrow", text: "Classroom Display" }), el("h1", { text: state.activeClass.className }), session.message ? el("p", { class: "display-message", text: session.message }) : null, selected ? el("section", { class: "display-selected", "aria-label": "Selected student" }, [el("p", { text: "Selected student" }), el("strong", { text: selected })]) : null, el("section", { class: "display-timer" }, [el("p", { text: "Timer" }), el("strong", { "data-classroom-timer": "", "data-status": session.timer.status, role: "timer", text: formatTimer(session.timer.remainingMs) }), el("span", { "data-timer-status": "", role: "status", text: session.timer.status === "complete" ? "Time is up" : session.timer.status === "running" ? "Running" : "Ready" })]), session.groups ? classroomGroupCards(session.groups, roster) : el("p", { class: "display-hint", text: "Selected student, timer, message, and groups appear here only when the teacher chooses them." })])); }
async function openStudentProgress(student) { const classId = state.activeClass?.id; if (!classId) return; try { const records = await Promise.all([listAttendanceRecords(classId), listScoresForClass(classId)]); if (state.activeClass?.id !== classId) return; state.progress = { ...deriveStudentProgress({ student, classId, attendance: records[0], assessments: state.assessments, scores: records[1], classWork: state.classWork, workSubmissions: state.workSubmissions }), classId }; renderStudentProgress(); } catch (error) { errorMessage(error); } }
function currentProgressContext(progress = state.progress) { if (!progress || !state.activeClass || progress.classId !== state.activeClass.id) return null; return { classId: progress.classId, student: progress.student }; }
async function returnToProgressContext(context) { if (!context || state.activeClass?.id !== context.classId) { renderClass(); return; } try { await refreshActiveClass(); if (state.activeClass?.id !== context.classId) { renderDashboard(); return; } const student = [...state.students, ...state.archivedStudents].find((item) => item.id === context.student.id); if (student) await openStudentProgress(student); else { state.progress = null; renderProgressWorkspace(); } } catch (error) { errorMessage(error); } }
async function refreshProgressContext(context, message) { if (!context || state.activeClass?.id !== context.classId) return; await returnToProgressContext(context); announce(message); }
async function openProgressAttendance(entry) { const progress = state.progress, context = currentProgressContext(progress), current = state.activeClass; if (!context || !current || current.archivedAt || progress.student.archivedAt) return; try { const [records, activeStudents, archivedStudents] = await Promise.all([listAttendanceForDate(context.classId, entry.date), listStudents(context.classId), listStudents(context.classId, { archived: true })]); if (state.progress !== progress || state.activeClass?.id !== context.classId) return; const student = activeStudents.find((item) => item.id === context.student.id); if (!student) { await refreshProgressContext(context, archivedStudents.some((item) => item.id === context.student.id) ? "This student is archived; their history is view-only." : "This student is no longer active; Progress history was refreshed."); return; } if (!records.some((item) => item.studentId === student.id)) { await refreshProgressContext(context, "That attendance record is no longer available; Progress history was refreshed."); return; } await refreshActiveClass(); if (state.activeClass?.id !== context.classId || !state.students.some((item) => item.id === student.id)) return; await openAttendance(entry.date, { focusStudentId: student.id, progressReturn: { classId: context.classId, student }, requireRecordedStudent: true }); } catch (error) { errorMessage(error); } }
async function openProgressScore(entry) { const progress = state.progress, context = currentProgressContext(progress), current = state.activeClass; if (!context || !current || current.archivedAt || progress.student.archivedAt) return; try { const [assessments, activeStudents, archivedStudents] = await Promise.all([listAssessments(context.classId), listStudents(context.classId), listStudents(context.classId, { archived: true })]); if (state.progress !== progress || state.activeClass?.id !== context.classId) return; const student = activeStudents.find((item) => item.id === context.student.id); if (!student) { await refreshProgressContext(context, archivedStudents.some((item) => item.id === context.student.id) ? "This student is archived; their history is view-only." : "This student is no longer active; Progress history was refreshed."); return; } const assessment = assessments.find((item) => item.id === entry.assessmentId && item.classId === context.classId); if (!assessment) { await refreshProgressContext(context, "This assessment is no longer available; Progress history was refreshed."); return; } await refreshActiveClass(); if (state.activeClass?.id !== context.classId || !state.students.some((item) => item.id === student.id)) return; const currentAssessment = state.assessments.find((item) => item.id === assessment.id && item.classId === context.classId); if (!currentAssessment) { await refreshProgressContext(context, "This assessment is no longer available; Progress history was refreshed."); return; } await openAssessment(currentAssessment, { focusStudentId: student.id, progressReturn: { classId: context.classId, student } }); } catch (error) { errorMessage(error); } }
function progressStudentList(students, archived) { const query = searchQuery(state.progressSearch), matches = students.filter((student) => matchesSearch(query, student.fullName)); if (!matches.length && query) return el("section", { class: "progress-student-list" }, [el("p", { class: "subtle progress-search-empty", role: "status", "aria-live": "polite", text: `No ${archived ? "archived" : "active"} students match “${state.progressSearch.trim()}”.` })]); return el("section", { class: "progress-student-list" }, matches.map((student) => el("article", { class: "progress-student-card" }, [el("div", {}, [el("h2", { text: student.fullName }), el("p", { text: archived ? "Archived student · historical records remain available" : "Open factual attendance and score history" })]), action("Open summary", () => openStudentProgress(student), "button button--quiet")] ))); }
function progressStudentResults() {
  const results = [];
  if (!state.students.length) results.push(el("section", { class: "empty-state progress-empty", "aria-labelledby": "progress-empty-heading" }, [el("h2", { id: "progress-empty-heading", text: "No active students yet" }), el("p", { text: "Add or restore students in this class’s roster from Overview before reviewing progress." }), action("Open class Overview", renderClass, "button button--quiet")]));
  else results.push(progressStudentList(state.students, false));
  if (state.archivedStudents.length) {
    const query = searchQuery(state.progressSearch), archivedMatches = state.archivedStudents.filter((student) => matchesSearch(query, student.fullName));
    const summary = !query ? `Archived students · ${state.archivedStudents.length}` : archivedMatches.length ? `Archived students · ${archivedMatches.length} match${archivedMatches.length === 1 ? "" : "es"}` : "Archived students · no matches";
    results.push(el("details", { class: "lesson-section", open: Boolean(query && archivedMatches.length) }, [el("summary", { text: summary }), progressStudentList(state.archivedStudents, true)]));
  }
  return results;
}
function renderProgressStudentResults() { const host = root.querySelector("[data-progress-results]"); if (host) host.replaceChildren(...progressStudentResults()); }
function renderProgressWorkspace() { const current = state.activeClass; if (!current) return renderDashboard(); setWorkspaceLocation("Student Progress"); state.progress = null; root.replaceChildren(); root.append(el("nav", { class: "crumb-nav" }, [action(`← ${current.className}`, renderClass, "link-button")]), el("h1", { text: "Student Progress" }), el("p", { class: "intro", text: "Factual attendance and recorded raw-score history. No rankings, predictions, or official grades." }), el("label", { class: "field progress-search" }, [el("span", { text: "Find a student" }), el("input", { type: "search", value: state.progressSearch, onInput: (event) => { state.progressSearch = event.currentTarget.value; renderProgressStudentResults(); } })]), el("div", { "data-progress-results": "" })); renderProgressStudentResults(); }
function renderStudentProgress() {
  const progress = state.progress; if (!progress) return renderProgressWorkspace();
  const summary = progress.scoreSummary, attendance = progress.attendanceSummary;
  const canEditHistory = !progress.student.archivedAt && !state.activeClass?.archivedAt && progress.classId === state.activeClass?.id;
  const attendanceRows = progress.attendance.map((entry) => el("li", {}, [el("span", { text: `${entry.date} — ${entry.status}` }), canEditHistory ? action("Review date", () => openProgressAttendance(entry), "button button--quiet progress-history-action") : null]));
  const scoreRows = progress.assessments.map((entry) => el("li", {}, [el("span", { text: `${entry.title} · ${entry.entered ? entry.scoreLabel : "No score entered"}` }), canEditHistory ? action("Open score entry", () => openProgressScore(entry), "button button--quiet progress-history-action") : null]));
  const workRows = progress.classWorkHistory.map((entry) => { const linkedAssessment = entry.assessmentId && progress.assessments.find((item) => item.assessmentId === entry.assessmentId), scoreFact = linkedAssessment ? ` · Gradebook: ${linkedAssessment.entered ? `${linkedAssessment.rawScore} / ${linkedAssessment.maximumScore}` : "No score entered"}` : ""; const item = state.classWork.find((record) => record.id === entry.workItemId && record.classId === progress.classId); return el("li", {}, [el("span", { text: `${entry.title}${entry.dueDate ? ` · Due ${entry.dueDate}` : ""} · ${WORK_SUBMISSION_LABELS[entry.status]}${scoreFact}` }), canEditHistory && item ? action("Review submissions", () => requestClassWorkExit(() => openClassWorkItem(item, { focusStudentId: progress.student.id })), "button button--quiet progress-history-action") : null, canEditHistory && linkedAssessment ? action("Open score entry", () => openProgressScore(linkedAssessment), "button button--quiet progress-history-action") : null]); });
  attendanceRows.forEach((row, index) => { const button = row.querySelector(".progress-history-action"); if (button) button.setAttribute("aria-label", `Review attendance for ${progress.attendance[index].date}`); });
  scoreRows.forEach((row, index) => { const button = row.querySelector(".progress-history-action"); if (button) button.setAttribute("aria-label", `Open score entry for ${progress.assessments[index].title}`); });
  const aggregate = summary.aggregate ? `Total ${summary.totalRaw} / ${summary.totalMaximum} = ${summary.aggregate.display} raw-points aggregate` : "No aggregate available.";
  root.replaceChildren(el("nav", { class: "crumb-nav" }, [action("← Student Progress", renderProgressWorkspace, "link-button")]), el("h1", { text: progress.student.fullName }), action("Print summary", () => renderProgressPrint(progress), "button"), el("section", { class: "progress-panel" }, [el("h2", { text: "Attendance" }), el("p", { text: `Present ${attendance.counts.present} · Absent ${attendance.counts.absent} · Late ${attendance.counts.late} · Excused ${attendance.counts.excused}` }), el("p", { text: attendance.recorded ? `Attendance rate ${attendance.attendanceRate}; Present and Late ÷ all recorded statuses.` : "No attendance recorded." }), el("ol", { class: "progress-detail" }, attendanceRows)]), el("section", { class: "progress-panel" }, [el("h2", { text: "Assessment history" }), el("p", { text: "Raw-score percentages are not official grades." }), el("ol", { class: "progress-detail" }, scoreRows), el("p", { class: "progress-aggregate", text: aggregate })]), progress.classWorkHistory.length ? el("section", { class: "progress-panel" }, [el("h2", { text: "Class work history" }), el("p", { text: "Submission status and Gradebook score are separate records. Not recorded does not mean Missing." }), el("ol", { class: "progress-detail" }, workRows)]) : null);
}
function renderProgressPrint(progress) { renderStudentProgress(); window.print(); }
function classWorkOverview(current) { return el("section", { class: "class-work-overview", "data-class-tool": "Class Work", "aria-labelledby": "class-work-overview-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Submission tracking" }), el("h2", { id: "class-work-overview-heading", text: "Class Work" }), el("p", { text: current.archivedAt ? "Saved submission statuses stay with this archived class." : "Track Submitted, Missing, or Excused separately from Gradebook scores." })]), action(current.archivedAt ? "View Class Work" : "Open Class Work", renderClassWorkWorkspace, "button")])]); }
function progressOverview(current) { return el("section", { class: "progress-overview", "data-class-tool": "Student Progress", "aria-labelledby": "progress-overview-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Individual factual history" }), el("h2", { id: "progress-overview-heading", text: "Student Progress" }), el("p", { text: "Review one student's recorded attendance, submission statuses, and raw scores without rankings, predictions, or official grades." })]), action("Open Student Progress", renderProgressWorkspace, "button")])]); }
function classWorkSubmissionsFor(item, draft = null) {
  const records = state.workSubmissions.filter((entry) => entry.classId === state.activeClass?.id && entry.workItemId === item.id);
  if (!draft) return records;
  const archivedIds = new Set(state.archivedStudents.map((student) => student.id));
  return [...records.filter((entry) => archivedIds.has(entry.studentId)), ...[...draft].filter(([, status]) => status).map(([studentId, status]) => ({ classId: item.classId, workItemId: item.id, studentId, status }))];
}
function classWorkSummary(item, submissions = classWorkSubmissionsFor(item)) { return deriveClassWorkSummary({ classId: state.activeClass?.id, workItemId: item.id, students: [...state.students, ...state.archivedStudents], submissions }); }
function classWorkCountsText(counts) { return `${counts.submitted} submitted · ${counts.missing} missing · ${counts.excused} excused · ${counts["not-recorded"]} not recorded`; }
function classWorkSearchResults() {
  const host = root.querySelector("[data-class-work-list]"); if (!host) return;
  const query = searchQuery(state.classWorkSearch), items = state.classWork.filter((item) => matchesSearch(query, item.title)); host.replaceChildren();
  if (!items.length) { host.append(el("section", { class: "empty-state class-work-empty" }, [el("h2", { text: state.classWork.length ? "No matching class work" : "No class work yet" }), el("p", { text: state.classWork.length ? "Try another title." : "Track whether students submitted work here. A blank status stays Not recorded; it does not mean Missing. Scores remain separate in Gradebook." }), !state.activeClass.archivedAt && !state.classWork.length ? action("Add class work", prepClassWork, "button") : null])); return; }
  const summaries = deriveClassWorkCountsByItem({ classId: state.activeClass.id, workItems: items, students: [...state.students, ...state.archivedStudents], submissions: state.workSubmissions });
  items.forEach((item) => {
    const summary = summaries.get(item.id), assessment = item.assessmentId && state.assessments.find((entry) => entry.id === item.assessmentId);
    host.append(el("article", { class: "class-work-card", "data-class-work-card": item.id }, [el("div", {}, [el("h2", { text: item.title }), el("p", { text: `${item.dueDate ? `Due ${item.dueDate}` : "No due date"}${assessment ? ` · Gradebook: ${assessment.title}` : item.assessmentId ? " · Linked assessment unavailable" : ""}` }), el("div", { class: "class-work-counts", "aria-label": "Active roster submission counts" }, ["submitted", "missing", "excused", "not-recorded"].map((status) => el("span", { "data-status": status, text: `${WORK_SUBMISSION_LABELS[status]} ${summary.activeCounts[status]}` })))]), el("div", { class: "class-work-card-actions" }, [action("Review submissions", () => requestClassWorkExit(() => openClassWorkItem(item)), "button"), !state.activeClass.archivedAt ? action("View report", () => openClassWorkStatusReport(item.id), "button button--quiet") : null])]));
  });
}
function renderClassWorkWorkspace() {
  const current = state.activeClass; if (!current) return renderDashboard();
  if (state.classWorkSession) return renderClassWorkDetail();
  setWorkspaceLocation("Class Work");
  root.replaceChildren(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action(`← ${current.className}`, renderClass, "link-button")]), el("section", { class: "class-work-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: current.archivedAt ? "Archived class history" : "Daily class record" }), el("h1", { text: "Class Work" }), el("p", { class: "intro", text: "Record whether work was Submitted, Missing, or Excused. Not recorded stays distinct from Missing. Gradebook scores are separate facts." })]), !current.archivedAt ? action("Add class work", prepClassWork, "button") : null]), el("p", { class: "class-work-notice", role: "note", text: current.archivedAt ? "This archived class is read-only. Saved submission history remains available." : "Statuses apply to the active roster when you explicitly save. Archived students remain visible as read-only history." }), el("label", { class: "field class-work-search" }, [el("span", { text: "Find class work" }), el("input", { type: "search", value: state.classWorkSearch, placeholder: "Search by title", "data-class-work-search": "", onInput: (event) => { state.classWorkSearch = event.currentTarget.value; classWorkSearchResults(); } })]), el("div", { class: "class-work-list", "data-class-work-list": "" }));
  classWorkSearchResults();
}
async function openClassWorkItem(item, { focusStudentId = null } = {}) {
  const current = state.activeClass; if (!current || !item?.id) return;
  try {
    const saved = await getRecord("classWork", item.id);
    if (!saved || saved.classId !== current.id) throw new Error("That class work item is no longer available in this class.");
    const submissions = await listWorkSubmissionsForItem(saved.id);
    if (state.activeClass?.id !== current.id) return;
    const byStudent = new Map(submissions.filter((entry) => entry.classId === current.id && entry.workItemId === saved.id).map((entry) => [entry.studentId, entry.status]));
    const original = new Map(state.students.map((student) => [student.id, byStudent.get(student.id) || ""]));
    state.classWorkSession = { item: saved, original, draft: new Map(original), saved: submissions.length > 0, dirty: false, saving: false, focusStudentId, search: "", filter: "all" };
    renderClassWorkDetail();
    if (focusStudentId) requestAnimationFrame(() => { const row = [...root.querySelectorAll("[data-class-work-student]")].find((entry) => entry.getAttribute("data-class-work-student") === focusStudentId); const control = row?.querySelector("select"); if (row) row.scrollIntoView?.({ block: "center" }); control?.focus({ preventScroll: true }); });
  } catch (error) { errorMessage(error); }
}
function classWorkDraftDirty(session) { return submissionDraftIsDirty(session.original, session.draft); }
function updateClassWorkDetailControls() {
  const session = state.classWorkSession; if (!session) return;
  session.dirty = classWorkDraftDirty(session);
  const summary = classWorkSummary(session.item, classWorkSubmissionsFor(session.item, session.draft));
  const counts = root.querySelector("[data-class-work-counts]"); if (counts) { counts.replaceChildren(...["submitted", "missing", "excused", "not-recorded"].map((status) => el("span", { "data-status": status, text: `${WORK_SUBMISSION_LABELS[status]} ${summary.activeCounts[status]}` }))); counts.setAttribute("aria-label", `Active roster: ${classWorkCountsText(summary.activeCounts)}`); }
  root.querySelectorAll("[data-class-work-save-state]").forEach((label) => { label.textContent = session.saving ? "Saving submission statuses…" : session.dirty ? "Unsaved changes" : session.saved ? "Saved on this device" : "No submission statuses recorded yet"; label.classList.toggle("is-dirty", session.dirty); });
  root.querySelectorAll("[data-class-work-save]").forEach((button) => { button.disabled = session.saving || !session.dirty || Boolean(state.activeClass?.archivedAt); });
  root.querySelectorAll("[data-class-work-mark-unrecorded]").forEach((button) => { button.disabled = session.saving || Boolean(state.activeClass?.archivedAt); });
  root.querySelectorAll("[data-work-status]").forEach((control) => { control.disabled = session.saving || Boolean(state.activeClass?.archivedAt); });
}
function setClassWorkStatus(studentId, status, control = null) { const session = state.classWorkSession; if (!session || state.activeClass?.archivedAt || !session.draft.has(studentId)) return; if (session.saving) { if (control) control.value = session.draft.get(studentId) || ""; return; } session.draft.set(studentId, status); updateClassWorkDetailControls(); }
function classWorkStatusRows() {
  const session = state.classWorkSession, host = root.querySelector("[data-class-work-roster]"); if (!session || !host) return;
  const query = searchQuery(session.search), activeRows = state.students.filter((student) => matchesSearch(query, student.fullName)).filter((student) => session.filter === "all" || (session.draft.get(student.id) || "not-recorded") === session.filter);
  host.replaceChildren();
  if (!activeRows.length) host.append(el("li", { class: "attendance-empty", role: "status", text: query || session.filter !== "all" ? "No active students match this search or status." : "Add students in Overview before recording class-work statuses." }));
  activeRows.forEach((student, index) => {
    const select = el("select", { "data-work-status": student.id, "aria-label": `Submission status for ${student.fullName}`, disabled: Boolean(state.activeClass?.archivedAt || session.saving), onChange: (event) => setClassWorkStatus(student.id, event.currentTarget.value, event.currentTarget) }, [el("option", { value: "", text: "Not recorded" }), ...WORK_SUBMISSION_STATUSES.map((status) => el("option", { value: status, text: WORK_SUBMISSION_LABELS[status] }))]);
    select.value = session.draft.get(student.id) || "";
    host.append(el("li", { "data-class-work-student": student.id }, [el("span", { class: "attendance-number", text: String(index + 1) }), el("strong", { text: student.fullName }), select]));
  });
}
function markUnrecordedSubmitted() { const session = state.classWorkSession; if (!session || session.saving || state.activeClass?.archivedAt) return; session.draft.forEach((status, studentId) => { if (!status) session.draft.set(studentId, "submitted"); }); classWorkStatusRows(); updateClassWorkDetailControls(); announce("Unrecorded active students are marked Submitted in this unsaved draft. Review exceptions, then Save submission statuses."); }
function classWorkSaveActions(variant) { const session = state.classWorkSession, save = !state.activeClass?.archivedAt ? action("Save submission statuses", saveClassWorkStatuses, "button") : null; if (save) save.setAttribute("data-class-work-save", ""); return el("div", { class: `class-work-save class-work-save--${variant}` }, [el("span", { class: session?.dirty ? "save-state is-dirty" : "save-state", role: "status", "aria-live": "polite", "data-class-work-save-state": "", text: session?.dirty ? "Unsaved changes" : session?.saved ? "Saved on this device" : "No submission statuses recorded yet" }), save]); }
function renderClassWorkDetail() {
  const session = state.classWorkSession, current = state.activeClass; if (!session || !current) return renderClassWorkWorkspace();
  setWorkspaceLocation("Class Work");
  const linkedAssessment = session.item.assessmentId && state.assessments.find((item) => item.id === session.item.assessmentId && item.classId === current.id);
  const archivedStatusByStudent = new Map(state.workSubmissions.filter((entry) => entry.classId === current.id && entry.workItemId === session.item.id).map((entry) => [entry.studentId, entry.status]));
  const workControls = [action("Edit work", () => prepClassWork(session.item), "button button--quiet"), !current.archivedAt ? action("View status report", () => openClassWorkStatusReport(session.item.id), "button button--quiet") : null, linkedAssessment ? action("Open linked Gradebook scores", () => requestClassWorkExit(() => openAssessment(linkedAssessment)), "button button--quiet") : null, !current.archivedAt ? action("Delete work", () => beginDeleteClassWork(session.item), "button button--danger") : null].filter(Boolean);
  const heading = el("section", { class: "class-work-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: current.archivedAt ? "Archived class history" : "Class Work" }), el("h1", { text: session.item.title }), el("p", { class: "intro", text: `${session.item.dueDate ? `Due ${session.item.dueDate}` : "No due date"}${linkedAssessment ? ` · Related Gradebook assessment: ${linkedAssessment.title}` : session.item.assessmentId ? " · Related assessment is unavailable" : ""}` })]), el("div", { class: "class-work-card-actions" }, workControls)]);
  const markUnrecorded = !current.archivedAt ? action("Mark unrecorded as Submitted", markUnrecordedSubmitted, "button button--quiet") : null; if (markUnrecorded) markUnrecorded.setAttribute("data-class-work-mark-unrecorded", "");
  const toolbar = el("div", { class: "class-work-tools" }, [el("label", { class: "field" }, [el("span", { text: "Find a student" }), el("input", { type: "search", value: session.search, placeholder: "Search active roster", onInput: (event) => { session.search = event.currentTarget.value; classWorkStatusRows(); } })]), el("label", { class: "field" }, [el("span", { text: "Filter by status" }), el("select", { value: session.filter, onChange: (event) => { session.filter = event.currentTarget.value; classWorkStatusRows(); } }, [el("option", { value: "all", text: "All active students" }), ...["not-recorded", ...WORK_SUBMISSION_STATUSES].map((status) => el("option", { value: status, text: WORK_SUBMISSION_LABELS[status] }))])]), markUnrecorded]);
  root.replaceChildren(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action("← Class Work", () => requestClassWorkExit(() => renderClassWorkWorkspace()), "link-button")]), heading, el("p", { class: "class-work-notice", text: "Submission status is separate from Gradebook scores. Blank means Not recorded—not Missing. Changes stay a draft until you save." }), el("div", { class: "class-work-counts", "data-class-work-counts": "", "aria-live": "polite" }), !current.archivedAt ? classWorkSaveActions("top") : null, toolbar, el("ul", { class: "class-work-roster", "data-class-work-roster": "", "aria-label": "Class work submission statuses" }), state.archivedStudents.length ? el("details", { class: "archived-students" }, [el("summary", { text: `${state.archivedStudents.length} archived student${state.archivedStudents.length === 1 ? "" : "s"} · read-only history` }), el("ul", { class: "class-work-roster roster-list--archived" }, state.archivedStudents.map((student, index) => { const status = archivedStatusByStudent.get(student.id) || "not-recorded"; return el("li", { class: "archived-work-row" }, [el("span", { class: "attendance-number", text: String(index + 1) }), el("strong", { text: student.fullName }), el("span", { class: "archived-work-status", text: WORK_SUBMISSION_LABELS[status] })]); }))]) : null, !current.archivedAt ? classWorkSaveActions("mobile") : null);
  classWorkStatusRows(); updateClassWorkDetailControls();
}
async function saveClassWorkStatuses() {
  const session = state.classWorkSession, current = state.activeClass; if (!session || session.saving || !current || !session.dirty || current.archivedAt) return;
  const persistedSnapshot = new Map(session.draft);
  session.saving = true; updateClassWorkDetailControls();
  try {
    const saved = await saveWorkSubmissions(current.id, session.item.id, [...persistedSnapshot].map(([studentId, status]) => ({ studentId, status: status || null })));
    noteClassroomChange();
    state.workSubmissions = [...state.workSubmissions.filter((entry) => entry.workItemId !== session.item.id || state.archivedStudents.some((student) => student.id === entry.studentId)), ...saved];
    commitSubmissionDraftSnapshot(session, persistedSnapshot);
    classWorkSearchResults(); announce(`Submission statuses for ${session.item.title} were saved on this device.`);
  } catch (error) { errorMessage(error); }
  finally { session.saving = false; updateClassWorkDetailControls(); }
}
async function prepClassWork(item = null) {
  if (!state.activeClass || state.activeClass.archivedAt) return;
  if (state.classWorkSession?.saving) { announce("Wait for submission statuses to finish saving before editing this work item."); return; }
  const form = dialogs["class-work"].querySelector("form"), select = form.elements.assessmentId;
  form.reset(); form.elements.workItemId.value = item?.id || ""; form.elements.title.value = item?.title || ""; form.elements.dueDate.value = item?.dueDate || "";
  select.replaceChildren(el("option", { value: "", text: "No linked assessment" }), ...state.assessments.map((assessment) => el("option", { value: assessment.id, text: `${assessment.title} · ${assessment.date} · max ${assessment.maximumScore}` })));
  select.value = item?.assessmentId || ""; dialogs["class-work"].querySelector("h2").textContent = item ? "Edit class work" : "Add class work"; form.querySelector('[type="submit"]').textContent = item ? "Save changes" : "Save class work"; show("class-work");
}
function beginDeleteClassWork(item) {
  if (state.classWorkSession?.saving) { announce("Wait for the submission status save to finish before deleting this work item."); return; }
  state.classWorkDelete = item; const dialog = dialogs["delete-class-work"];
  dialog.querySelector("[data-delete-class-work-copy]").textContent = `Permanently delete “${item.title}” and its recorded submission statuses?${state.classWorkSession?.dirty ? " This also discards the unsaved status changes on screen." : ""} This does not delete any student or Gradebook data.`;
  dialog.querySelector("[data-delete-class-work-name]").textContent = item.title; dialog.querySelector("form").reset(); show("delete-class-work");
}
async function openClassWorkStatusReport(workItemId) {
  requestClassWorkExit(async () => {
    state.classWorkSession = null;
    try { await refreshActiveClass(); await openReports(); if (state.reports && state.classWork.some((item) => item.id === workItemId)) { state.reports.view = "classWork"; state.reports.classWorkId = workItemId; renderReports(); } }
    catch (error) { errorMessage(error); }
  });
}
function reportStudents() {
  return [...state.students, ...state.archivedStudents];
}
function downloadReportCsv(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function reportFilename(kind) {
  const name = (state.activeClass?.className || "class").replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase() || "class";
  return `${name}-${kind}.csv`;
}
async function openReports() {
  if (!state.activeClass) return;
  try {
    const [attendance, scores] = await Promise.all([listAttendanceRecords(state.activeClass.id), listScoresForClass(state.activeClass.id)]);
    state.reports = { attendance, scores, view: "home", startDate: "", endDate: "", assessmentId: state.assessments[0]?.id || "" };
    renderReports();
  } catch (error) {
    errorMessage(error);
  }
}
function reportNavigation(label = "Reports") {
  return el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action(`← ${label}`, () => state.reports?.view === "home" ? renderClass() : setReportView("home"), "link-button")]);
}
function setReportView(view) {
  if (!state.reports) return openReports();
  state.reports.view = view;
  renderReports();
}
function reportHeader(title, description, controls = []) {
  return el("section", { class: "report-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Reports" }), el("h1", { text: title }), el("p", { class: "intro", text: description })]), el("div", { class: "report-actions print-controls" }, controls)]);
}
function reportPrintButton() {
  return action("Print A4", () => window.print(), "button button--quiet");
}
function renderReportsHome() {
  const cards = [
    ["Class Roster", "Active and archived student records for this class.", "roster"],
    ["Attendance Summary", "Recorded statuses, with an optional local date range.", "attendance"],
    ["Assessment Results", "Raw scores, missing scores, and descriptive statistics.", "assessment"],
    ["Class Work Status", "Submitted, Missing, Excused, or Not recorded for one work item.", "classWork-list"],
    ["Class Overview", "Factual operational counts from this class's records.", "overview"]
  ];
  root.replaceChildren(reportNavigation(state.activeClass.className), reportHeader("Reports", "Derived locally from this class's existing records. Reports are never saved as new records."));
  root.append(el("section", { class: "report-card-list", "aria-label": "Available reports" }, cards.map(([title, description, view]) => el("article", { class: "report-card" }, [el("div", {}, [el("h2", { text: title }), el("p", { text: description })]), action(`Open ${title}`, () => setReportView(view), "button")]))));
}
function reportTable(headers, rows, label, compact = false) {
  const table = el("table", { class: "report-table" });
  table.append(el("thead", {}, [el("tr", {}, headers.map((header) => el("th", { scope: "col", text: header })))]));
  table.append(el("tbody", {}, rows.length ? rows.map((row) => el("tr", {}, row.map((cell) => el("td", { text: cell })))) : [el("tr", {}, [el("td", { colspan: headers.length, text: "No records match this report." })]) ]));
  return el("div", { class: compact ? "report-table-wrap report-table-wrap--compact" : "report-table-wrap", role: "region", "aria-label": label, tabindex: "0" }, [table]);
}
function renderRosterReport() {
  const report = deriveClassRoster({ classId: state.activeClass.id, students: reportStudents() });
  root.replaceChildren(reportNavigation(), reportHeader("Class Roster", "Alphabetical roster derived from current student records. Archived students remain clearly identified.", [action("Download CSV", () => downloadReportCsv(reportFilename("roster"), rosterCsv(report)), "button button--quiet"), reportPrintButton()]));
  root.append(el("section", { class: "report-summary" }, [el("p", { text: `${report.activeCount} active · ${report.archivedCount} archived · ${report.rows.length} total` })]), reportTable(["Student", "Roster status"], report.rows.map((row) => [row.fullName, row.archived ? "Archived" : "Active"]), "Class roster", true));
}
function renderAttendanceReport(focusFilter = "") {
  const session = state.reports;
  const report = deriveAttendanceSummary({ classId: state.activeClass.id, students: reportStudents(), attendance: session.attendance, startDate: session.startDate, endDate: session.endDate });
  const filters = el("div", { class: "report-filters print-controls" }, [el("label", { class: "field" }, [el("span", { text: "From date" }), el("input", { type: "date", value: session.startDate, "data-report-filter": "start", onChange: (event) => { session.startDate = event.currentTarget.value; renderAttendanceReport("start"); } })]), el("label", { class: "field" }, [el("span", { text: "To date" }), el("input", { type: "date", value: session.endDate, "data-report-filter": "end", onChange: (event) => { session.endDate = event.currentTarget.value; renderAttendanceReport("end"); } })]), action("Clear dates", () => { session.startDate = ""; session.endDate = ""; renderAttendanceReport(); }, "button button--quiet")]);
  root.replaceChildren(reportNavigation(), reportHeader("Attendance Summary", "Only saved attendance records are included. The date range uses local calendar dates inclusively.", [action("Download CSV", () => downloadReportCsv(reportFilename("attendance"), attendanceCsv(report)), "button button--quiet"), reportPrintButton()]), filters);
  root.append(el("section", { class: "report-summary" }, [el("p", { text: `${report.recordedCount} recorded across ${report.dateCount} date${report.dateCount === 1 ? "" : "s"}` }), el("p", { text: `Present ${report.counts.present} · Absent ${report.counts.absent} · Late ${report.counts.late} · Excused ${report.counts.excused}` })]), reportTable(["Date", "Student", "Roster status", "Attendance"], report.rows.map((row) => [row.date, row.fullName, row.archived ? "Archived" : "Active", row.status]), "Attendance summary"));
  if (focusFilter) root.querySelector(`[data-report-filter="${focusFilter}"]`)?.focus();
}
function statisticsText(statistics) {
  const aggregate = statistics.aggregate ? `${statistics.aggregate.display} raw aggregate` : "No recorded scores";
  return `Recorded ${statistics.recordedCount} · Missing ${statistics.missingCount} · Lowest ${statistics.minimum ?? "—"} · Highest ${statistics.maximum ?? "—"} · Mean ${statistics.mean ?? "—"} · ${aggregate}`;
}
function renderAssessmentReport(focusFilter = false) {
  const session = state.reports;
  const output = deriveAssessmentResults({ classId: state.activeClass.id, students: reportStudents(), assessments: state.assessments, scores: session.scores, assessmentId: session.assessmentId });
  const choices = [el("option", { value: "", text: "All assessments" }), ...state.assessments.map((assessment) => el("option", { value: assessment.id, text: `${assessment.date} · ${assessment.title}` }))];
  const select = el("select", { value: session.assessmentId, "data-report-assessment-filter": "", onChange: (event) => { session.assessmentId = event.currentTarget.value; renderAssessmentReport(true); } }, choices);
  select.value = session.assessmentId;
  const scope = session.assessmentId ? "One assessment is shown. Choose All assessments to review the full history." : "All assessments are shown. Select one assessment to make a focused report.";
  root.replaceChildren(reportNavigation(), reportHeader("Assessment Results", "Raw scores and missing scores only. Percentages use the Gradebook's generic raw-score calculation, not official grades.", [reportPrintButton()]), el("div", { class: "report-filters print-controls assessment-report-filter" }, [el("label", { class: "field" }, [el("span", { text: "Assessment" }), select]), el("p", { class: "subtle", text: scope })]));
  if (focusFilter) root.querySelector("[data-report-assessment-filter]")?.focus();
  if (!output.reports.length) { root.append(el("section", { class: "empty-state" }, [el("h2", { text: "No assessments match" }), el("p", { text: "Create an assessment in Gradebook to see its locally derived results." })])); return; }
  output.reports.forEach((report) => {
    root.append(el("section", { class: "report-assessment" }, [el("div", { class: "report-assessment-heading" }, [el("div", {}, [el("h2", { text: report.assessment.title }), el("p", { text: `${report.assessment.date} · Maximum score ${report.assessment.maximumScore}` })]), el("div", { class: "print-controls" }, [action("Download CSV", () => downloadReportCsv(reportFilename("assessment-results"), assessmentCsv(report)), "button button--quiet")])]), el("p", { class: "report-statistics", text: statisticsText(report.statistics) }), reportTable(["Student", "Roster status", "Raw score", "Maximum", "Raw percentage", "Score status"], report.rows.map((row) => [row.fullName, row.archived ? "Archived" : "Active", row.entered ? row.rawScore : "—", row.maximumScore, row.percentage || "—", row.entered ? "Recorded" : "Missing"]), `${report.assessment.title} results`)]));
  });
}
function renderOverviewReport() {
  const session = state.reports;
  const overview = deriveClassOverview({ classId: state.activeClass.id, students: reportStudents(), attendance: session.attendance, assessments: state.assessments, scores: session.scores, lessons: state.lessons });
  const rows = [["Active students", overview.activeStudents], ["Archived students", overview.archivedStudents], ["Total students", overview.totalStudents], ["Saved attendance records", overview.attendanceRecords], ["Attendance dates", overview.attendanceDates], ["Assessments", overview.assessments], ["Recorded scores", overview.recordedScores], ["Missing score entries", overview.missingScores], ["Saved lessons", overview.lessons]];
  root.replaceChildren(reportNavigation(), reportHeader("Class Overview", "Operational counts derived from this class's saved records. These counts are factual, not performance labels.", [reportPrintButton()]), reportTable(["Operational count", "Value"], rows, "Class overview", true));
}
function renderClassWorkReportList() {
  root.replaceChildren(reportNavigation(), reportHeader("Class Work Status", "Review one saved work item's factual submission statuses. This report is derived from the class roster and saved records."));
  if (!state.classWork.length) { root.append(el("section", { class: "empty-state" }, [el("h2", { text: "No class work saved yet" }), el("p", { text: "Create class work in the Class Work workspace to record submission statuses." }), action("Open Class Work", renderClassWorkWorkspace, "button button--quiet")])); return; }
  const classId = state.activeClass.id, students = reportStudents(), summaries = deriveClassWorkCountsByItem({ classId, workItems: state.classWork, students, submissions: state.workSubmissions });
  root.append(el("section", { class: "report-card-list", "aria-label": "Class work items" }, state.classWork.map((item) => { const counts = summaries.get(item.id)?.activeCounts || { submitted: 0, missing: 0, excused: 0, "not-recorded": 0 }; return el("article", { class: "report-card" }, [el("div", {}, [el("h2", { text: item.title }), el("p", { text: `${item.dueDate ? `Due ${item.dueDate}` : "No due date"} · ${counts.submitted} submitted · ${counts.missing} missing · ${counts.excused} excused · ${counts["not-recorded"]} not recorded` })]), action("Open status report", () => { state.reports.view = "classWork"; state.reports.classWorkId = item.id; renderReports(); }, "button")]); })));
}
function renderClassWorkStatusReport() {
  const workItem = state.classWork.find((item) => item.id === state.reports.classWorkId && item.classId === state.activeClass.id);
  const report = deriveClassWorkStatusReport({ classId: state.activeClass.id, workItem, students: reportStudents(), submissions: state.workSubmissions, assessments: state.assessments });
  if (!report) { state.reports.view = "classWork-list"; return renderClassWorkReportList(); }
  const statusLabel = (status) => WORK_SUBMISSION_LABELS[status] || "Not recorded";
  root.replaceChildren(reportNavigation(), reportHeader("Class Work Status", `${report.workItem.title}${report.workItem.dueDate ? ` · Due ${report.workItem.dueDate}` : " · No due date"}${report.assessment ? ` · Related assessment: ${report.assessment.title}` : ""}. Submission status and score are separate facts.`, [action("Download CSV", () => downloadReportCsv(reportFilename("class-work-status"), classWorkStatusCsv(report)), "button button--quiet"), reportPrintButton()]));
  root.append(el("section", { class: "report-summary", "aria-label": "Submission status counts" }, [el("p", { text: `${report.activeCount} active · ${report.archivedCount} archived` }), el("p", { text: `Submitted ${report.activeCounts.submitted} · Missing ${report.activeCounts.missing} · Excused ${report.activeCounts.excused} · Not recorded ${report.activeCounts["not-recorded"]}` })]), el("p", { class: "class-work-report-note", text: "A score may exist independently; this report does not infer submission from Gradebook." }), reportTable(["Student", "Roster status", "Submission status"], report.rows.map((row) => [row.fullName, row.archived ? "Archived" : "Active", statusLabel(row.status)]), `${report.workItem.title} submission status`, true));
}
function renderReports() {
  if (!state.activeClass || !state.reports) return renderClass(); setWorkspaceLocation("Reports");
  if (state.reports.view === "roster") return renderRosterReport();
  if (state.reports.view === "attendance") return renderAttendanceReport();
  if (state.reports.view === "assessment") return renderAssessmentReport();
  if (state.reports.view === "classWork-list") return renderClassWorkReportList();
  if (state.reports.view === "classWork") return renderClassWorkStatusReport();
  if (state.reports.view === "overview") return renderOverviewReport();
  renderReportsHome();
}
function reportsOverview(current) { return el("section", { class: "reports-overview", "data-class-tool": "Reports", "aria-labelledby": "reports-overview-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Derived local reports" }), el("h2", { id: "reports-overview-heading", text: "Reports" }), el("p", { text: current.archivedAt ? "View roster, attendance, raw-score, and operational reports from saved class records." : "Create printable local reports from existing roster, attendance, Gradebook, and lesson records." })]), action("Open Reports", openReports, "button")]), el("p", { class: "subtle", text: "Reports are derived on demand and never create new student records, grades, rankings, or predictions." })]); }
function blankLesson() { return { id: null, title: "", date: getLocalDateString(), status: "draft", learningGoals: "", priorKnowledge: "", materials: "", before: "", during: "", checkForUnderstanding: "", assessment: "", reflection: "", nextStep: "", notes: "" }; }
function lessonDraftFromForm(form) { return Object.fromEntries(new FormData(form).entries()); }
function lessonMatches(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function lessonUpdatedAt(lesson) { return new Date(lesson.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
function lessonReferenceContext(selected) {
  const lesson = selected?.lesson;
  if (!lesson) return "";
  if (selected.scheduledToday) return "Planned for today";
  return `Recently edited ${lessonUpdatedAt(lesson)}${lesson.date ? ` · Lesson date ${lesson.date}` : " · No lesson date"}`;
}
function requestLessonExit(next = renderClass) { if (state.lesson?.dirty && !window.confirm("Leave this lesson without saving your changes?")) return; state.lesson = null; next(); }
function requestClassWorkExit(next) { if (state.classWorkSession?.saving) { announce("Wait for submission statuses to finish saving before leaving this item."); return; } if (state.classWorkSession?.dirty) { state.pendingClassWorkExit = next; show("leave-class-work"); return; } completeClassWorkExit(next); }
function completeClassWorkExit(next) { state.pendingClassWorkExit = null; state.classWorkSession = null; next?.(); }
async function openClassTool(classItem, label) {
  const selected = await getRecord("classes", classItem.id);
  if (!selected || selected.archivedAt) throw new Error("That class is no longer available. Choose an active class.");
  if (state.activeClass?.id !== selected.id) { state.classWorkSession = null; state.classWorkSearch = ""; state.classWorkStatusFilter = "all"; }
  if (state.rosterSearchClassId !== selected.id) { state.rosterSearchClassId = selected.id; state.rosterSearch = ""; }
  state.activeClass = selected; state.archivedView = false;
  await refreshActiveClass();
  if (!state.activeClass || state.activeClass.archivedAt) throw new Error("That class is no longer available. Choose an active class.");
  navigateWorkspace(label);
}
function switchClassAfterGuards(classItem, label) {
  const next = () => openClassTool(classItem, label).catch(errorMessage);
  if (state.attendance) requestAttendanceExit({ type: "action", run: next });
  else if (state.scoreSession) requestScoreExit(next);
  else if (state.classWorkSession) requestClassWorkExit(next);
  else if (state.lesson) requestLessonExit(next);
  else next();
}
function renderClassToolChoices() {
  const session = state.classTool, dialog = dialogs["class-tool"];
  if (!session) return;
  dialog.querySelector("h2").textContent = session.kind === "create" ? `Create a class for ${session.label}` : session.kind === "switch" ? "Switch class" : `Choose a class for ${session.label}`;
  dialog.querySelector("[data-class-tool-copy]").textContent = session.kind === "create" ? `Create a class first, then MATEVOK will open ${session.label}.` : session.kind === "switch" ? `Choose an active class. MATEVOK will keep you in ${session.label}; each class's records stay separate.` : `Choose the active class to open ${session.label}. Archived classes are not shown here.`;
  const choices = dialog.querySelector("[data-class-tool-choices]"); choices.replaceChildren();
  if (session.kind === "create") choices.append(action("Create a class", () => { state.dialogReturnFocus["class-tool"] = null; hide("class-tool"); state.classTool = null; prepClass(null, session.label); }, "button"));
  else session.classes.forEach((item) => {
    const choice = action(item.className, async () => {
      state.dialogReturnFocus["class-tool"] = null; hide("class-tool"); state.classTool = null;
      if (session.kind === "switch") { switchClassAfterGuards(item, session.label); return; }
      try { await openClassTool(item, session.label); } catch (error) { errorMessage(error); }
    }, "button button--quiet class-tool-choice");
    const details = [item.gradeLevel, item.subject, item.term, item.schedule, `${item.studentCount || 0} active student${item.studentCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    choice.replaceChildren(el("span", { class: "class-tool-choice-name", text: item.className }), el("span", { class: "class-tool-choice-details", text: details }));
    choices.append(choice);
  });
}
async function requestClassTool(label) {
  try {
    state.classes = await listClasses();
    const destination = resolveClassToolDestination(state.classes);
    if (destination.kind === "open") { await openClassTool(destination.classItem, label); return; }
    state.classTool = destination.kind === "choose" ? { kind: "choose", label, classes: destination.classes } : { kind: "create", label };
    renderClassToolChoices(); show("class-tool");
  } catch (error) { errorMessage(error); }
}
async function requestClassSwitch() {
  const current = state.activeClass;
  if (!current || current.archivedAt) return;
  try {
    state.classes = await listClasses();
    if (state.activeClass?.id !== current.id || state.activeClass.archivedAt) return;
    const classes = state.classes.filter((item) => item.id !== current.id);
    if (!classes.length) { classSwitchContext.hidden = true; announce("There are no other active classes to switch to."); return; }
    const label = document.querySelector("[data-nav-item][data-current]")?.dataset.navItem || "Overview";
    state.classTool = { kind: "switch", label, classes };
    renderClassToolChoices(); show("class-tool");
  } catch (error) { errorMessage(error); }
}
function navigateWorkspace(label) {
  document.body.classList.remove("is-classroom-display");
  if (label === "My Classes") { state.activeClass = null; state.archivedView = false; refreshClasses().then(renderDashboard).catch(errorMessage); return; }
  if (label === "My Materials") { state.activeClass = null; state.archivedView = false; renderMaterials().catch(errorMessage); return; }
  if (!state.activeClass) return renderDashboard();
  ({ Overview: renderClass, Attendance: () => openAttendance(), "Class Work": renderClassWorkWorkspace, Gradebook: renderGradebook, "Assessment Center": renderAssessmentCenter, "Lesson Workspace": renderLessonWorkspace, "Student Progress": renderProgressWorkspace, "Classroom Mode": renderClassroomMode, Reports: openReports }[label] || renderClass)();
}
function requestWorkspaceNavigation(label) {
  const current = document.querySelector(`[data-nav-item="${label}"]`);
  if (current?.hasAttribute("data-current")) return closeMenu();
  if (label === "My Classes" && currentLocation.textContent === "My Materials") { navigateWorkspace(label); closeMenu(); return; }
  if (label !== "My Materials" && !state.activeClass) { requestClassTool(label); closeMenu(); return; }
  const next = () => navigateWorkspace(label);
  if (state.attendance) requestAttendanceExit({ type: "navigate", label });
  else if (state.scoreSession) requestScoreExit(next);
  else if (state.classWorkSession) requestClassWorkExit(next);
  else if (state.lesson) requestLessonExit(next);
  else next();
  closeMenu();
}
function lessonField(name, label, value, placeholder, rows = 4, help = "") { return el("label", { class: "field lesson-field" }, [el("span", { text: label }), help ? el("small", { text: help }) : null, el("textarea", { name, rows, maxlength: 8000, placeholder }, [value || ""])]); }
function lessonSection(title, description, fields, open = false) { return el("details", { class: "lesson-section", open }, [el("summary", {}, [el("span", { text: title }), el("small", { text: description })]), el("div", { class: "lesson-section-fields" }, fields)]); }
function showLessonEditor(lesson = null) { const source = lesson ? { ...lesson } : blankLesson(); state.lesson = { original: { ...source }, draft: { ...source }, dirty: false, saved: Boolean(lesson?.id) }; renderLessonEditor(); }
function lessonWorkspaceResults(current) {
  const query = searchQuery(state.lessonSearch); const lessons = state.lessons.filter((lesson) => matchesSearch(query, lesson.title, lesson.date));
  if (!lessons.length) return [el("section", { class: "empty-state lesson-empty" }, [el("div", { class: "empty-symbol", text: "✦", "aria-hidden": "true" }), el("h2", { text: state.lessons.length ? "No matching lessons" : "Start with a simple plan" }), el("p", { text: state.lessons.length ? "Try a different title or date." : "Create a lesson, add a title, then fill the Before, During, and After prompts at your own pace." }), !current.archivedAt && !state.lessons.length ? action("Create lesson", () => showLessonEditor(), "button") : null])];
  const list = el("section", { class: "lesson-list", "aria-label": "Saved lessons" }); lessons.forEach((lesson) => list.append(el("article", { class: "lesson-card" }, [el("div", { class: "lesson-card-body" }, [el("div", { class: "lesson-card-title" }, [el("h2", { text: lesson.title }), el("span", { class: `lesson-status lesson-status--${lesson.status}`, text: lesson.status === "ready" ? "Ready" : "Draft" })]), el("p", { text: lesson.date ? `Lesson date · ${lesson.date}` : "No lesson date" }), el("small", { text: `Last edited ${lessonUpdatedAt(lesson)}` })]), el("div", { class: "lesson-card-actions" }, [action(current.archivedAt ? "View" : "Edit", () => showLessonEditor(lesson), "button button--quiet"), action("Save to My Materials", () => beginSaveMaterial("lesson", lesson), "button button--quiet"), current.archivedAt ? null : action("Duplicate", async () => { try { const copied = await duplicateLesson(lesson.id); noteClassroomChange(); await refreshActiveClass(); showLessonEditor(copied); announce("Lesson duplicated as a Draft. Review it before saving changes."); } catch (error) { errorMessage(error); } }, "button button--quiet"), current.archivedAt ? null : action("Copy to another class", () => prepCopyContent("lesson", lesson), "button button--quiet")])]))); return [list];
}
function renderLessonWorkspaceResults() { const current = state.activeClass, host = root.querySelector("[data-lesson-results]"); if (current && host) host.replaceChildren(...lessonWorkspaceResults(current)); }
function renderLessonWorkspace() {
  const current = state.activeClass; if (!current) { renderDashboard(); return; } setWorkspaceLocation("Lesson Workspace"); state.lesson = null; root.replaceChildren();
  root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action(`← ${current.className}`, renderClass, "link-button")]));
  root.append(el("section", { class: "lesson-workspace-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Lesson Workspace" }), el("h1", { text: current.className }), el("p", { class: "intro", text: current.archivedAt ? "Saved lesson plans remain available while this class is archived." : "Plan what students learn, what happens during the lesson, and how you will check learning." })]), current.archivedAt ? null : action("Create lesson", () => showLessonEditor(), "button") ]));
  root.append(el("div", { class: "lesson-list-tools" }, [el("label", { class: "field" }, [el("span", { text: "Find a lesson" }), el("input", { type: "search", value: state.lessonSearch, placeholder: "Title or date", onInput: (event) => { state.lessonSearch = event.currentTarget.value; renderLessonWorkspaceResults(); } })]), el("p", { class: "subtle", text: `${state.lessons.length} saved lesson${state.lessons.length === 1 ? "" : "s"} · stored only on this device` })]));
  root.append(el("div", { "data-lesson-results": "" })); renderLessonWorkspaceResults();
}
function renderLessonEditor() {
  const current = state.activeClass, session = state.lesson; if (!current || !session) { renderLessonWorkspace(); return; } setWorkspaceLocation("Lesson Workspace"); const draft = session.draft;
  root.replaceChildren(); root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action("← Lesson Workspace", () => requestLessonExit(renderLessonWorkspace), "link-button")]));
  const form = el("form", { class: "lesson-editor", "data-lesson-editor": "" });
  const heading = el("section", { class: "lesson-editor-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: draft.id ? "Edit lesson" : "New lesson" }), el("h1", { text: draft.id ? draft.title || "Untitled lesson" : "Create lesson" }), el("p", { class: "intro", text: "Plain text planning, saved only when you choose Save lesson." })]), el("div", { class: "lesson-save-controls" }, [el("span", { class: session.dirty ? "save-state is-dirty" : "save-state", role: "status", "aria-live": "polite", text: session.dirty ? "Unsaved changes" : session.saved ? "Saved on this device" : "Not saved yet" }), action("Print", () => renderLessonPrint({ ...session.draft }), "button button--quiet"), current.archivedAt ? null : action("Save lesson", () => form.requestSubmit(), "button")])]);
  const overview = el("section", { class: "lesson-overview-fields" }, [el("label", { class: "field lesson-title-field" }, [el("span", { text: "Lesson title or topic" }), el("input", { name: "title", required: "", maxlength: 160, value: draft.title, placeholder: "e.g. Comparing evidence in two texts" })]), el("label", { class: "field" }, [el("span", { text: "Lesson date (optional)" }), el("input", { name: "date", type: "date", value: draft.date })]), el("label", { class: "field" }, [el("span", { text: "Status" }), el("select", { name: "status" }, [el("option", { value: "draft", text: "Draft" }), el("option", { value: "ready", text: "Ready" })]), el("small", { text: "Ready requires a learning goal." })])]); overview.querySelector("[name=status]").value = draft.status;
  form.append(heading, overview, lessonSection("Before", "What students need before learning begins", [lessonField("learningGoals", "Learning goal", draft.learningGoals, "What should students understand or be able to do?", 4, "Required only for Ready"), lessonField("priorKnowledge", "Prior knowledge / preparation", draft.priorKnowledge, "What should already be known or prepared?"), lessonField("materials", "Materials / resources", draft.materials, "What is needed?")], true), lessonSection("During", "What will happen in the lesson", [lessonField("before", "Opening / introduction", draft.before, "How will the lesson begin?"), lessonField("during", "Teaching and learning activities", draft.during, "Describe the key activities."), lessonField("checkForUnderstanding", "Check for understanding", draft.checkForUnderstanding, "How will you notice whether students are learning?")], true), lessonSection("After", "How learning will be checked and used", [lessonField("assessment", "Assessment / evidence of learning", draft.assessment, "What evidence will show learning?"), lessonField("reflection", "Teacher reflection", draft.reflection, "What worked, or what should change?"), lessonField("nextStep", "Next step", draft.nextStep, "What should happen next?"), lessonField("notes", "Teacher notes", draft.notes, "Optional private planning notes")], false));
  if (draft.id && !current.archivedAt) form.append(el("div", { class: "lesson-delete-row" }, [action("Delete lesson", async () => { if (!window.confirm(`Permanently delete “${draft.title}”? This cannot be undone.`)) return; try { await deleteLessonPermanently(draft.id); noteClassroomChange(); await refreshActiveClass(); state.lesson = null; renderLessonWorkspace(); announce("Lesson permanently deleted."); } catch (error) { errorMessage(error); } }, "button button--danger")]));
  form.addEventListener("input", () => { session.draft = { ...session.draft, ...lessonDraftFromForm(form) }; session.dirty = !lessonMatches(session.draft, session.original); const status = form.querySelector("[role=status]"); if (status) { status.className = session.dirty ? "save-state is-dirty" : "save-state"; status.textContent = session.dirty ? "Unsaved changes" : session.saved ? "Saved on this device" : "Not saved yet"; } }); form.addEventListener("change", () => form.dispatchEvent(new Event("input")));
  submitOnce(form, async (event) => { event.preventDefault(); try { const saved = await saveLesson(lessonDraftFromForm(form), current.id, draft.id || null); noteClassroomChange(); await refreshActiveClass(); state.lesson = { original: { ...saved }, draft: { ...saved }, dirty: false, saved: true }; renderLessonEditor(); announce("Lesson saved on this device."); } catch (error) { errorMessage(error); } }); root.append(form);
}
function lessonPrintSection(title, value) { return value ? el("section", { class: "lesson-print-section" }, [el("h2", { text: title }), el("p", { text: value })]) : null; }
function renderLessonPrint(lesson) { const current = state.activeClass; if (!current || !lesson) { renderLessonWorkspace(); return; } root.replaceChildren(); const before = [lessonPrintSection("Learning goal", lesson.learningGoals), lessonPrintSection("Prior knowledge / preparation", lesson.priorKnowledge), lessonPrintSection("Materials / resources", lesson.materials)]; const during = [lessonPrintSection("Opening / introduction", lesson.before), lessonPrintSection("Teaching and learning activities", lesson.during), lessonPrintSection("Check for understanding", lesson.checkForUnderstanding)]; const after = [lessonPrintSection("Assessment / evidence of learning", lesson.assessment), lessonPrintSection("Teacher reflection", lesson.reflection), lessonPrintSection("Next step", lesson.nextStep), lessonPrintSection("Teacher notes", lesson.notes)]; root.append(el("div", { class: "print-controls lesson-print-controls" }, [action(`← ${lesson.title}`, () => { state.lesson = { original: { ...lesson }, draft: { ...lesson }, dirty: false, saved: true }; renderLessonEditor(); }, "button button--quiet"), action("Print lesson", () => window.print(), "button")]), el("article", { class: "lesson-print" }, [el("header", { class: "lesson-print-header" }, [el("p", { class: "eyebrow", text: "Lesson plan" }), el("h1", { text: lesson.title }), el("p", { text: `${current.className}${current.subject ? ` · ${current.subject}` : ""}${lesson.date ? ` · ${lesson.date}` : ""}` })]), el("section", { class: "lesson-print-group" }, [el("h2", { text: "Before" }), ...before]), el("section", { class: "lesson-print-group" }, [el("h2", { text: "During" }), ...during]), el("section", { class: "lesson-print-group" }, [el("h2", { text: "After" }), ...after]) ])); }
function lessonOverview(current) { return el("section", { class: "lesson-overview", "data-class-tool": "Lesson Workspace", "aria-labelledby": "lesson-overview-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Reusable planning" }), el("h2", { id: "lesson-overview-heading", text: "Lesson Workspace" }), el("p", { text: current.archivedAt ? "Saved lesson plans stay with this archived class." : "Plan Before, During, and After. Lessons are private, local, and reusable within this class." })]), action("Open Lesson Workspace", renderLessonWorkspace, "button")]), el("p", { class: "subtle", text: `${state.lessons.length} saved lesson${state.lessons.length === 1 ? "" : "s"} · no student names, scores, or live Classroom Mode data are copied into lesson plans` })]); }
function todayCard(label, detail, control, extraClass = "") { return el("article", { class: `today-card ${extraClass}`.trim() }, [el("h3", { text: label }), el("p", { text: detail }), control ? el("div", { class: "today-card-action" }, [control]) : null]); }
function todayAddStudentsAction() { return action("Add students", () => { const heading = root.querySelector("#roster-heading"); heading?.scrollIntoView({ block: "center" }); heading?.focus({ preventScroll: true }); }, "button"); }
function todayAttendanceCard(current) { const today = getLocalDateString(), saved = state.attendanceHistory.find((entry) => entry.date === today); if (current.archivedAt) return todayCard("Attendance", saved ? `Today · ${attendanceSummary(saved.counts)}` : "No attendance recorded for today."); if (!state.students.length) return todayCard("Attendance", "Add students before taking attendance.", todayAddStudentsAction()); return todayCard("Attendance", saved ? `Today · ${attendanceSummary(saved.counts)}` : "No attendance recorded for today.", action(saved ? "Reopen today" : "Take attendance", () => openAttendance(today), "button")); }
function todayScoresCard(current) { const activeCount = state.students.length; if (current.archivedAt) return todayCard("Scores", "Saved scores remain available while this class is archived."); if (!activeCount) return todayCard("Scores", "Add students before entering scores.", todayAddStudentsAction()); if (!state.assessments.length) return todayCard("Scores", "No assessments saved yet.", action("Open Gradebook", renderGradebook, "button button--quiet")); const assessment = state.assessments.find((item) => (state.overviewScoreCounts.get(item.id) || 0) < activeCount); if (!assessment) return todayCard("Scores", `All active scores are recorded across ${state.assessments.length} assessment${state.assessments.length === 1 ? "" : "s"}.`, action("Open Gradebook", renderGradebook, "button button--quiet")); const entered = state.overviewScoreCounts.get(assessment.id) || 0; return todayCard(`Scores · ${assessment.title}`, `${entered} of ${activeCount} active scores entered.`, action("Continue scores", () => openAssessment(assessment), "button"), "today-card--scores"); }
function todayLessonCard(current) { if (current.archivedAt) return todayCard("Lesson", state.lessons.length ? "Saved lessons remain available while this class is archived." : "No lessons saved yet."); const selected = selectLessonReference({ classId: current.id, lessons: state.lessons, localDate: getLocalDateString() }), lesson = selected.lesson; if (!lesson) return todayCard("Lesson", "No lessons saved yet.", action("Open Lesson Workspace", renderLessonWorkspace, "button button--quiet")); const status = lesson.status === "ready" ? "Ready" : "Draft"; return todayCard(lesson.title, `${status} · ${lessonReferenceContext(selected)}.`, action("Continue lesson", () => showLessonEditor(lesson), "button"), "today-card--lesson"); }
function todayClassroomCard(current) { if (current.archivedAt) return todayCard("Classroom Mode", "Restore this class before starting a classroom activity."); const count = state.students.length; return todayCard("Classroom Mode", count ? `${count} active student${count === 1 ? "" : "s"} available for local picks and groups.` : "Add active students to use picks and groups.", action("Start Classroom Mode", renderClassroomMode, "button")); }
function todayClassWorkCard(current) { if (current.archivedAt) return null; const due = deriveDueTodayClassWork({ classId: current.id, today: getLocalDateString(), workItems: state.classWork, students: state.students, submissions: state.workSubmissions }); if (!due.items.length) return null; const title = due.items.length === 1 ? due.items[0].title : `${due.items.length} class-work items due today`; const scope = due.items.length === 1 ? "For this item" : `Across ${due.items.length} due items`; return todayCard(`Class Work · ${title}`, `${scope}: ${due.counts.submitted} submitted · ${due.counts.missing} marked Missing · ${due.counts.excused} excused · ${due.counts["not-recorded"]} not recorded.`, action("Review submissions", () => due.items.length === 1 ? openClassWorkItem(due.items[0]) : renderClassWorkWorkspace(), "button button--quiet"), "today-card--class-work"); }
function todayWorkspace(current) { return el("section", { class: "today-workspace", "aria-labelledby": "today-heading" }, [el("div", { class: "today-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Class overview" }), el("h2", { id: "today-heading", text: "Today" }), el("p", { text: "Continue with the records already stored for this class." })])]), el("div", { class: "today-grid" }, [todayAttendanceCard(current), todayScoresCard(current), todayLessonCard(current), todayClassroomCard(current), todayClassWorkCard(current)].filter(Boolean)), backupReminder()]); }
function renderClass() {
  if (!state.activeClass) { renderDashboard(); return; } const current = state.activeClass; if (state.rosterSearchClassId !== current.id) { state.rosterSearchClassId = current.id; state.rosterSearch = ""; } setWorkspaceLocation(current.className); root.replaceChildren();
  root.append(el("nav", { class: "crumb-nav", "aria-label": "Breadcrumb" }, [action("← My classes", async () => { state.activeClass = null; state.archivedView = false; await refreshClasses(); renderDashboard(); }, "link-button")]));
  root.append(el("section", { class: "class-hero" }, [el("div", {}, [el("p", { class: "eyebrow", text: current.archivedAt ? "Archived class" : "Class workspace" }), el("h1", { text: current.className }), el("p", { class: "intro", text: classMeta(current) })]), el("div", { class: "heading-actions" }, [action("Edit class", () => prepClass(current), "button button--quiet"), action(current.archivedAt ? "Restore class" : "Archive class", () => prepArchive(current), "button button--quiet"), action("Delete permanently", () => prepDelete(current), "button button--danger")]) ]));
  if (current.notes || current.schedule) root.append(el("aside", { class: "detail-note" }, [current.schedule ? el("p", { text: `Schedule: ${current.schedule}` }) : null, current.notes ? el("p", { text: current.notes }) : null]));
  const canCopyRoster = !current.archivedAt && !state.students.length && !state.archivedStudents.length && state.classes.some((item) => !item.archivedAt && item.id !== current.id);
  const rosterResults = el("div", { "data-roster-results": "" });
  const rosterContents = state.students.length ? [state.students.length >= 12 ? rosterStudentSearch() : null, rosterResults] : [el("div", { class: "roster-empty" }, [el("h3", { text: "Add your reusable roster" }), el("p", { text: current.archivedAt ? "Restore this class before updating its roster." : "Add a student or paste a roster to start using class tools." }), canCopyRoster ? action("Copy roster from another class", prepRosterCopy, "button button--quiet") : null])];
  const roster = el("section", { class: "roster-panel", "aria-labelledby": "roster-heading" }, [el("div", { class: "panel-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Reusable student roster" }), el("h2", { id: "roster-heading", tabindex: "-1", text: `Students · ${state.students.length}` }), el("p", { text: "Add students once. Every class tool reuses this roster." })]), current.archivedAt ? null : el("div", { class: "heading-actions" }, [action("Paste roster", prepBulk, "button button--quiet"), action("Add student", () => prepStudent())])]), ...rosterContents, archivedStudentList()]);
  const tools = el("section", { class: "workspace-tools", "aria-labelledby": "workspace-tools-heading" }, [el("div", { class: "workspace-tools-heading" }, [el("div", {}, [el("p", { class: "eyebrow", text: "Class tools" }), el("h2", { id: "workspace-tools-heading", text: "Choose the next task" }), el("p", { text: "Everything below uses this class and roster." })]), current.archivedAt ? null : action("Add from My Materials", () => visitMaterialsForClass(current.id), "button button--quiet")])]);
  const toolGrid = el("div", { class: "workspace-tools-grid" }, [attendanceOverview(current), classWorkOverview(current), gradebookOverview(current), assessmentCenterOverview(current), lessonOverview(current), classroomOverview(current), progressOverview(current), reportsOverview(current)]);
  tools.append(toolGrid);
  root.append(todayWorkspace(current), roster, tools);
  if (state.students.length >= 12) updateRosterStudentResults();
}

function renderRosterCopyReview() {
  const form = dialogs["copy-roster"].querySelector("form"), copy = state.rosterCopy, review = dialogs["copy-roster"].querySelector("[data-copy-roster-review]");
  if (!copy) return;
  const source = copy.sources.find((item) => item.id === form.elements.sourceClass.value);
  review.replaceChildren();
  if (!source) review.append(el("p", { class: "subtle", text: "Choose a class with active students. Archived classes are read-only sources." }));
  else if (copy.loading) review.append(el("p", { class: "subtle", role: "status", text: "Checking the selected roster…" }));
  else if (!copy.sourceAvailable) review.append(el("p", { class: "subtle", text: "This source class is no longer available. Choose another class." }));
  else if (!copy.activeCount) review.append(el("p", { class: "subtle", text: "This class has no active students to copy." }));
  else review.append(el("p", { class: "copy-route", text: `Source · ${copy.sourceClassName}${copy.sourceArchived ? " (archived, read-only)" : ""} → Destination · ${copy.targetClassName}` }), el("p", { class: "subtle", text: `${copy.activeCount} active student names will be copied as new independent records. Archived students, attendance, scores, and history are not copied.` }));
  const ready = Boolean(source && copy.sourceAvailable && copy.activeCount && !copy.loading && !copy.submitting), confirm = form.elements.confirmCopy, submit = form.querySelector("[data-copy-roster-confirm]");
  form.elements.sourceClass.disabled = Boolean(copy.submitting); dialogs["copy-roster"].querySelectorAll("[data-close-dialog='copy-roster']").forEach((button) => { button.disabled = Boolean(copy.submitting); });
  confirm.disabled = !ready; if (!ready) confirm.checked = false; submit.disabled = !ready || !confirm.checked;
}
async function loadRosterCopyReview() {
  const form = dialogs["copy-roster"].querySelector("form"), copy = state.rosterCopy; if (!copy) return;
  const sourceId = form.elements.sourceClass.value, token = {}; copy.reviewRequest = token; copy.sourceAvailable = false; copy.sourceClassName = ""; copy.activeCount = 0; copy.loading = Boolean(sourceId); form.elements.confirmCopy.checked = false; renderRosterCopyReview();
  if (!sourceId) return;
  try {
    const source = await getRecord("classes", sourceId);
    const students = source ? await listStudents(sourceId) : [];
    if (state.rosterCopy !== copy || copy.reviewRequest !== token) return;
    copy.sourceAvailable = Boolean(source); copy.sourceClassName = source?.className || ""; copy.sourceArchived = Boolean(source?.archivedAt); copy.activeCount = students.length; copy.loading = false; renderRosterCopyReview();
  } catch (error) { if (state.rosterCopy === copy && copy.reviewRequest === token) { copy.loading = false; renderRosterCopyReview(); } errorMessage(error); }
}
async function prepRosterCopy() {
  const target = state.activeClass;
  if (!target || target.archivedAt || state.students.length || state.archivedStudents.length) return;
  const [activeClasses, archivedClasses] = await Promise.all([listClasses(), listClasses({ archived: true })]);
  if (state.activeClass?.id !== target.id || target.archivedAt || state.students.length || state.archivedStudents.length) return;
  const sources = [...activeClasses, ...archivedClasses].filter((item) => item.id !== target.id && item.studentCount > 0).sort((a, b) => a.className.localeCompare(b.className, undefined, { sensitivity: "base" }));
  if (!sources.length) { errorMessage(new Error("Add students to another class first; its active roster can then be copied into this empty class.")); return; }
  state.rosterCopy = { targetClassId: target.id, targetClassName: target.className, sources, sourceAvailable: false, activeCount: 0, loading: false, submitting: false };
  const form = dialogs["copy-roster"].querySelector("form"), select = form.elements.sourceClass; form.reset(); select.replaceChildren(el("option", { value: "", text: "Choose a source class" }), ...sources.map((item) => el("option", { value: item.id, text: item.archivedAt ? `${item.className} · Archived source` : item.className })));
  dialogs["copy-roster"].querySelector("h2").textContent = "Copy an active roster"; renderRosterCopyReview(); show("copy-roster");
}
async function confirmRosterCopy() {
  const copy = state.rosterCopy, form = dialogs["copy-roster"].querySelector("form"), sourceId = form.elements.sourceClass.value;
  if (!copy || copy.submitting || !form.elements.confirmCopy.checked || !copy.sourceAvailable || !copy.activeCount || !copy.sources.some((item) => item.id === sourceId)) return;
  copy.submitting = true; renderRosterCopyReview();
  try {
    const copied = await copyActiveRosterToEmptyClass(sourceId, copy.targetClassId);
    noteClassroomChange(); hide("copy-roster"); state.rosterCopy = null;
    await refreshActiveClass();
    if (state.activeClass?.id === copy.targetClassId) { renderClass(); root.querySelector("#roster-heading")?.focus(); }
    announce(`${copied.length} active students copied as independent records. Attendance, scores, and archived history were not copied.`);
  } catch (error) { if (state.rosterCopy === copy) { copy.submitting = false; renderRosterCopyReview(); } errorMessage(error); }
}
function copyKindLabel(kind) { return kind === "assessment" ? "Assessment" : "Lesson"; }
function renderCopyContentReview() {
  const form = dialogs["copy-content"].querySelector("form"), copy = state.copy, targetId = form.elements.targetClass.value, target = copy?.targets.find((entry) => entry.id === targetId), confirm = form.elements.confirmCopy, submit = form.querySelector("[data-confirm-copy]"), review = dialogs["copy-content"].querySelector("[data-copy-content-review]");
  review.replaceChildren();
  if (!copy) return;
  review.append(el("p", { class: "copy-route", text: `Source · ${copy.sourceClassName} → Destination · ${target?.className || "Choose an available class"}` }));
  const details = copy.kind === "assessment" ? `${copy.questionCount} authored question${copy.questionCount === 1 ? "" : "s"} and ${copy.optionCount} answer choice${copy.optionCount === 1 ? "" : "s"} will be copied. The new assessment starts as Draft with no scores.` : "The lesson plan fields will be copied. The new lesson starts as Draft.";
  review.append(el("p", { text: `${copyKindLabel(copy.kind)} · ${copy.sourceTitle}` }), el("p", { class: "subtle", text: `${details} No students, attendance, progress, reports, or live Classroom Mode data are included.` }));
  const ready = Boolean(target) && !copy.submitting;
  confirm.checked = ready ? confirm.checked : false; confirm.disabled = !ready; submit.disabled = !ready || !confirm.checked;
}
async function prepCopyContent(kind, source) {
  try {
    if (!source?.id || !state.activeClass) throw new Error("Open a saved item before copying it.");
    const targets = (await listClasses()).filter((entry) => entry.id !== state.activeClass.id);
    const questions = kind === "assessment" ? await listQuestions(source.id) : [];
    state.copy = { kind, sourceId: source.id, sourceTitle: source.title, sourceClassId: state.activeClass.id, sourceClassName: state.activeClass.className, targets, questionCount: questions.length, optionCount: questions.reduce((count, question) => count + (question.options?.length || 0), 0), submitting: false };
    const form = dialogs["copy-content"].querySelector("form"), select = form.elements.targetClass;
    form.reset(); select.replaceChildren();
    if (targets.length) targets.forEach((entry) => select.append(el("option", { value: entry.id, text: entry.className })));
    else select.append(el("option", { value: "", text: "No other active classes available" }));
    select.disabled = !targets.length; dialogs["copy-content"].querySelector("h2").textContent = `Copy ${copyKindLabel(kind)} to another class`;
    renderCopyContentReview(); show("copy-content");
  } catch (error) { errorMessage(error); }
}
async function confirmContentCopy() {
  const form = dialogs["copy-content"].querySelector("form"), copy = state.copy, target = copy?.targets.find((entry) => entry.id === form.elements.targetClass.value);
  if (!copy || !target || !form.elements.confirmCopy.checked || copy.submitting) return;
  copy.submitting = true; renderCopyContentReview();
  try {
    const copied = copy.kind === "assessment" ? await copyAuthoredAssessmentToClass(copy.sourceId, target.id) : await copyLessonToClass(copy.sourceId, target.id);
    noteClassroomChange(); state.copySuccess = { kind: copy.kind, item: copied, target }; state.copy = null; hide("copy-content");
    dialogs["copy-complete"].querySelector("[data-copy-complete-copy]").textContent = `${copyKindLabel(copy.kind)} “${copied.title}” was copied to ${target.className} as an independent Draft. No students, scores, attendance, or historical records were copied.`;
    dialogs["copy-complete"].querySelector("[data-open-copied]").textContent = `Open copied ${copyKindLabel(copy.kind)}`; show("copy-complete");
    announce(`${copyKindLabel(copy.kind)} copied to ${target.className} as an independent Draft.`);
  } catch (error) { copy.submitting = false; renderCopyContentReview(); errorMessage(error); }
}
async function openCopiedContent() {
  const success = state.copySuccess; if (!success) return hide("copy-complete"); hide("copy-complete"); state.copySuccess = null; state.activeClass = success.target; state.archivedView = false;
  try { await refreshActiveClass(); if (!state.activeClass) throw new Error("The destination class is no longer available."); if (success.kind === "assessment") await openAuthoring(success.item); else { state.lessonSearch = ""; showLessonEditor(success.item); } } catch (error) { errorMessage(error); }
}
async function beginSaveMaterial(kind, source) {
  if (!source?.id || !["lesson", "assessment"].includes(kind)) return;
  try {
    const existing = await listMaterials({ kind }), key = (value) => String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase(), duplicates = existing.filter((item) => key(item.title) === key(source.title));
    state.materialSave = { kind, sourceId: source.id, title: source.title, duplicates, submitting: false };
    dialogs["save-material"].querySelector("[data-save-material-copy]").textContent = `Save the currently saved ${materialLabel(kind).toLowerCase()} “${source.title}” as a separate reusable template? Unsaved editor changes are not included.`;
    const duplicateNote = dialogs["save-material"].querySelector("[data-save-material-duplicate]");
    duplicateNote.hidden = !duplicates.length; duplicateNote.textContent = duplicates.length ? `A ${materialLabel(kind).toLowerCase()} with this title is already in My Materials. Saving will create a separate template; nothing will be overwritten.` : "";
    const confirm = dialogs["save-material"].querySelector("[data-save-material-confirm]"); confirm.disabled = false; confirm.textContent = duplicates.length ? "Save another template" : "Save to My Materials";
    show("save-material");
  } catch (error) { errorMessage(error); }
}
async function confirmSaveMaterial() {
  const source = state.materialSave; if (!source || source.submitting) return; source.submitting = true;
  const submit = dialogs["save-material"].querySelector("[data-save-material-confirm]"); submit.disabled = true;
  try {
    const saved = source.kind === "lesson" ? await saveLessonToMaterials(source.sourceId) : await saveAssessmentToMaterials(source.sourceId);
    noteClassroomChange(); hide("save-material"); state.materialSave = null; announce(`${materialLabel(saved.kind)} saved to My Materials as a separate template. The class item was not changed.`);
  } catch (error) { source.submitting = false; submit.disabled = false; errorMessage(error); }
}
function renderMaterialAddReview() {
  const form = dialogs["add-material"].querySelector("form"), stateValue = state.materialAdd; if (!stateValue) return;
  const target = stateValue.targets.find((entry) => entry.id === form.elements.targetClass.value), review = dialogs["add-material"].querySelector("[data-add-material-review]"), confirm = form.elements.confirmCopy, submit = form.querySelector("[data-add-material-confirm]");
  review.replaceChildren();
  const item = stateValue.template;
  if (item) {
    review.append(el("p", { class: "copy-route", text: `${materialLabel(item.kind)} template · ${item.title}` }));
    const detail = item.kind === "assessment" ? `${item.content.questions.length} authored question${item.content.questions.length === 1 ? "" : "s"} and ${item.content.questions.reduce((count, question) => count + question.options.length, 0)} answer choices. The copy starts as Draft with no scores, dated today; the previous term/date is not carried over.` : `Lesson plan fields only. The copy starts as Draft with no lesson date.`;
    review.append(el("p", { class: "subtle", text: `${detail} ${target ? `Destination · ${target.className}.` : "Choose an active destination class."} If that class already has this title, a separate item will be added; nothing is overwritten.` }));
  }
  const ready = Boolean(item && target && !stateValue.submitting); confirm.disabled = !ready; if (!ready) confirm.checked = false; submit.disabled = !ready || !confirm.checked;
}
async function beginMaterialAdd(materialId) {
  try {
    const [materials, targets] = await Promise.all([listMaterials(), listClasses()]), template = materials.find((item) => item.id === materialId);
    if (!template) throw new Error("That My Materials template is no longer available.");
    if (!targets.length) { announce("Create an active class before adding a material."); prepClass(); return; }
    state.materials = materials; state.materialAdd = { template, targets, submitting: false };
    const form = dialogs["add-material"].querySelector("form"), select = form.elements.targetClass; form.reset(); select.replaceChildren(el("option", { value: "", text: "Choose an active class" })); targets.forEach((entry) => select.append(el("option", { value: entry.id, text: entry.className })));
    if (targets.some((entry) => entry.id === state.materialTargetClassId)) select.value = state.materialTargetClassId;
    dialogs["add-material"].querySelector("h2").textContent = `Add ${materialLabel(template.kind).toLowerCase()} to a class`; renderMaterialAddReview(); show("add-material");
  } catch (error) { errorMessage(error); }
}
async function confirmMaterialAdd() {
  const value = state.materialAdd, form = dialogs["add-material"].querySelector("form"), targetId = form.elements.targetClass.value;
  if (!value || !form.elements.confirmCopy.checked || value.submitting || !value.targets.some((item) => item.id === targetId)) return;
  value.submitting = true; renderMaterialAddReview();
  try {
    const copied = await materializeMaterialToClass(value.template.id, targetId); noteClassroomChange(); state.copySuccess = copied; state.materialAdd = null; hide("add-material");
    dialogs["copy-complete"].querySelector("[data-copy-complete-copy]").textContent = `${materialLabel(copied.kind)} “${copied.item.title}” was added to ${copied.target.className} as an independent Draft. No students, scores, attendance, or historical records were copied.`;
    dialogs["copy-complete"].querySelector("[data-open-copied]").textContent = `Open copied ${materialLabel(copied.kind)}`; show("copy-complete"); announce(`${materialLabel(copied.kind)} added to ${copied.target.className} as an independent Draft.`);
  } catch (error) { value.submitting = false; renderMaterialAddReview(); errorMessage(error); }
}
function prepDeleteMaterial(item) {
  state.materialDelete = item; const form = dialogs["delete-material"].querySelector("form"); form.reset();
  dialogs["delete-material"].querySelector("[data-delete-material-copy]").textContent = `Permanently delete the ${materialLabel(item.kind).toLowerCase()} template “${item.title}”? Class copies already created from it are not affected.`;
  dialogs["delete-material"].querySelector("[data-delete-material-name]").textContent = item.title; show("delete-material");
}
function prepClass(existing = null, openTool = "") { const form = dialogs.class.querySelector("form"); form.reset(); form.dataset.openTool = openTool; form.elements.classId.value = existing?.id || ""; ["className", "gradeLevel", "subject", "term", "schedule", "notes"].forEach((name) => { form.elements[name].value = existing?.[name] || ""; }); dialogs.class.querySelector("h2").textContent = existing ? "Edit class" : "Create a class"; show("class"); }
function prepStudent(existing = null) { const form = dialogs.student.querySelector("form"); form.reset(); form.elements.studentId.value = existing?.id || ""; form.elements.fullName.value = existing?.fullName || ""; dialogs.student.querySelector("h2").textContent = existing ? "Edit student" : "Add a student"; show("student"); }
function prepAssessment(existing = null, authorAfterSave = false) { const form = dialogs.assessment.querySelector("form"); form.reset(); form.dataset.authorAfterSave = String(authorAfterSave); form.elements.assessmentId.value = existing?.id || ""; ["title", "date", "maximumScore", "category", "term", "assessmentKind", "instructions"].forEach((name) => { form.elements[name].value = existing?.[name] || (name === "date" ? getLocalDateString() : name === "assessmentKind" ? "quiz" : ""); }); form.elements.showPoints.checked = Boolean(existing?.showPoints); dialogs.assessment.querySelector("h2").textContent = existing ? "Edit assessment" : "Create assessment"; show("assessment"); }
function questionOptionsEditor(options = []) { const list = dialogs.question.querySelector("[data-option-editor]"); list.replaceChildren(); const entries = options.length ? options : [{ text: "", correct: false }, { text: "", correct: false }]; entries.forEach((option, index) => { const row = el("div", { class: "option-row" }, [el("input", { type: "radio", name: "correctOption", value: option.id || `new-${index}`, checked: Boolean(option.correct), "aria-label": `Correct answer for choice ${index + 1}` }), el("input", { type: "hidden", name: "optionId", value: option.id || "" }), el("input", { type: "text", name: "optionText", value: option.text || "", maxlength: 1600, autocomplete: "off", placeholder: `Choice ${index + 1}`, "aria-label": `Choice ${index + 1}` }), action("Remove choice", (event) => { event.currentTarget.closest(".option-row").remove(); }, "link-button")]); list.append(row); }); }
function updateQuestionTypeFields() { const form = dialogs.question.querySelector("form"), type = form.elements.questionType.value; form.querySelectorAll("[data-question-type-fields]").forEach((section) => { section.hidden = section.dataset.questionTypeFields !== type; }); if (type === "multiple-choice" && !form.querySelector("[data-option-editor] .option-row")) questionOptionsEditor(); }
function prepQuestion(existing = null) { const form = dialogs.question.querySelector("form"); form.reset(); form.elements.prompt.required = false; form.elements.points.required = false; form.elements.questionId.value = existing?.id || ""; form.elements.questionType.value = existing?.questionType || QUESTION_TYPES[0]; form.elements.prompt.value = existing?.prompt || ""; form.elements.points.value = existing?.points || "1"; form.elements.correctBoolean.value = existing?.correctBoolean || ""; form.elements.referenceAnswer.value = existing?.referenceAnswer || ""; form.elements.guidance.value = existing?.guidance || ""; questionOptionsEditor((existing?.options || []).map((option) => ({ ...option, correct: option.id === existing?.correctOptionId }))); updateQuestionTypeFields(); dialogs.question.querySelector("h2").textContent = existing ? "Edit question" : "Add question"; show("question"); }
async function prepDeleteAssessment(assessment) { const form = dialogs["delete-assessment"].querySelector("form"); form.reset(); form.dataset.assessmentId = assessment.id; const questions = await listQuestions(assessment.id); dialogs["delete-assessment"].querySelector("[data-delete-assessment-copy]").textContent = `Permanently delete “${assessment.title}”, its ${assessment.scoreCount} related score record${assessment.scoreCount === 1 ? "" : "s"}, and its ${questions.length} authored question${questions.length === 1 ? "" : "s"}? This cannot be undone.`; dialogs["delete-assessment"].querySelector("[data-delete-assessment-name]").textContent = assessment.title; show("delete-assessment"); }
function prepBulk() { const form = dialogs.bulk.querySelector("form"); form.reset(); updateBulkPreview(); show("bulk"); }
function updateBulkPreview() { const form = dialogs.bulk.querySelector("form"), review = reviewRoster(form.elements.roster.value, state.students), include = form.elements.includeDuplicates.checked, target = dialogs.bulk.querySelector("[data-bulk-preview]"); target.replaceChildren(); if (!review.length) { target.append(el("p", { class: "subtle", text: "Paste one name per line to review the roster." })); return; } const repeats = review.filter((entry) => entry.duplicate).length; target.append(el("p", { class: "subtle", text: `${review.length} name${review.length === 1 ? "" : "s"} found. ${repeats} possible repeat${repeats === 1 ? "" : "s"}.` })); const list = el("ol", { class: "bulk-preview" }); review.forEach((entry) => list.append(el("li", { class: entry.duplicate ? "is-duplicate" : "" }, [entry.fullName, el("span", { text: entry.duplicate ? (include ? "Will add" : "Not added by default") : "Ready" })]))); target.append(list); }
function prepArchive(current) { const form = dialogs.archive.querySelector("form"); form.dataset.classId = current.id; form.dataset.restore = String(Boolean(current.archivedAt)); dialogs.archive.querySelector("[data-archive-copy]").textContent = current.archivedAt ? `Restore “${current.className}” to your active classes? Its roster stays intact.` : `Archive “${current.className}”? Its roster stays intact and you can restore it later.`; show("archive"); }
function prepDelete(current) { const form = dialogs.delete.querySelector("form"); form.reset(); form.dataset.classId = current.id; dialogs.delete.querySelector("[data-delete-copy]").textContent = `Permanently delete “${current.className}” and its related roster, attendance, assessment, and score records? This cannot be undone.`; dialogs.delete.querySelector("[data-delete-name]").textContent = current.className; show("delete"); }
async function archiveStudent(student) { try { await setStudentArchived(student.id, true); noteClassroomChange(); announce(`${student.fullName} was archived. You can restore the record below.`); await refreshActiveClass(); renderClass(); focusRosterAfterChange(); } catch (error) { errorMessage(error); } }

root.addEventListener("keydown", handleAttendanceStatusKey);
document.addEventListener("click", (event) => {
  const materialsLink = event.target.closest('[data-nav-item="My Materials"]');
  if (materialsLink) {
    event.preventDefault();
    state.materialTargetClassId = state.activeClass && !state.activeClass.archivedAt ? state.activeClass.id : "";
    requestWorkspaceNavigation("My Materials"); return;
  }
  const target = event.target.closest("[data-close-dialog]"); if (target) hide(target.dataset.closeDialog);
});
dialogs["leave-attendance"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); const next = state.pendingAttendanceExit; hide("leave-attendance"); completeAttendanceExit(next); });
dialogs["leave-scores"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); const next = state.pendingScoreExit; hide("leave-scores"); completeScoreExit(next); });
dialogs["leave-class-work"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); const next = state.pendingClassWorkExit; hide("leave-class-work"); completeClassWorkExit(next); });
submitOnce(dialogs["class-work"].querySelector("form"), async (event) => { const form = event.currentTarget, itemId = form.elements.workItemId.value; try { const saved = await saveClassWork({ title: form.elements.title.value, dueDate: form.elements.dueDate.value, assessmentId: form.elements.assessmentId.value || null }, state.activeClass.id, itemId || null); noteClassroomChange(); hide("class-work"); await refreshActiveClass(); if (itemId && state.classWorkSession?.item.id === itemId) { state.classWorkSession.item = state.classWork.find((entry) => entry.id === itemId) || saved; renderClassWorkDetail(); announce("Class work details were saved. Submission statuses are unchanged."); } else { state.classWorkSearch = ""; await openClassWorkItem(saved); announce(`${saved.title} was saved. Record submission statuses when ready.`); } } catch (error) { errorMessage(error); } });
submitOnce(dialogs["delete-class-work"].querySelector("form"), async (event) => { const form = event.currentTarget, item = state.classWorkDelete; if (!item || form.elements.confirmName.value !== item.title) { errorMessage(new Error("Type the class-work title exactly before deleting it.")); return; } await deleteClassWorkPermanently(item.id); noteClassroomChange(); hide("delete-class-work"); state.classWorkDelete = null; state.classWorkSession = null; await refreshActiveClass(); renderClassWorkWorkspace(); announce("Class work and its submission statuses were permanently deleted. Students and scores were not changed."); });
dialogs["score-paste"].querySelector("form").elements.scores.addEventListener("input", renderScorePasteReview);
dialogs["score-paste"].querySelector("form").elements.confirmPaste.addEventListener("change", renderScorePasteReview);
dialogs["score-paste"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); if (event.currentTarget.elements.confirmPaste.checked) applyPastedScores(); });
dialogs["copy-content"].querySelector("form").elements.targetClass.addEventListener("change", renderCopyContentReview);
dialogs["copy-content"].querySelector("form").elements.confirmCopy.addEventListener("change", renderCopyContentReview);
dialogs["copy-content"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); confirmContentCopy(); });
dialogs["copy-roster"].querySelector("form").elements.sourceClass.addEventListener("change", loadRosterCopyReview);
dialogs["copy-roster"].querySelector("form").elements.confirmCopy.addEventListener("change", renderRosterCopyReview);
dialogs["copy-roster"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); confirmRosterCopy(); });
dialogs["copy-roster"].addEventListener("cancel", (event) => { if (state.rosterCopy?.submitting) event.preventDefault(); });
dialogs["copy-roster"].addEventListener("close", () => { state.rosterCopy = null; dialogs["copy-roster"].querySelector("form").reset(); });
dialogs["copy-complete"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); openCopiedContent(); });
dialogs["save-material"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); confirmSaveMaterial(); });
dialogs["add-material"].querySelector("form").elements.targetClass.addEventListener("change", (event) => { event.currentTarget.form.elements.confirmCopy.checked = false; renderMaterialAddReview(); });
dialogs["add-material"].querySelector("form").elements.confirmCopy.addEventListener("change", renderMaterialAddReview);
dialogs["add-material"].querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); confirmMaterialAdd(); });
dialogs["delete-material"].querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget, item = state.materialDelete; if (!item || form.elements.confirmName.value !== item.title) { errorMessage(new Error("Type the template title exactly before deleting it.")); return; } try { await deleteMaterialPermanently(item.id); noteClassroomChange(); hide("delete-material"); state.materialDelete = null; state.materials = await listMaterials(); materialSearchResults(); announce("My Materials template deleted. Existing class copies are unchanged."); } catch (error) { errorMessage(error); } });
dialogs.class.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget, openTool = form.dataset.openTool || ""; try { const saved = await saveClass(Object.fromEntries(new FormData(form)), form.elements.classId.value || null); form.dataset.openTool = ""; noteClassroomChange(); hide("class"); state.activeClass = saved; await Promise.all([refreshClasses(), refreshActiveClass()]); if (state.activeClass) { if (openTool) navigateWorkspace(openTool); else renderClass(); } else renderDashboard(); announce(`${saved.className} was saved on this device.`); } catch (error) { errorMessage(error); } });
dialogs.student.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { const saved = await saveStudent({ fullName: form.elements.fullName.value }, state.activeClass.id, form.elements.studentId.value || null); noteClassroomChange(); hide("student"); await refreshActiveClass(); renderClass(); focusRosterAfterChange(); announce(`${saved.fullName} was saved.`); } catch (error) { errorMessage(error); } });
dialogs.assessment.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { const values = Object.fromEntries(new FormData(form)); values.showPoints = form.elements.showPoints.checked; const saved = await saveAssessment(values, state.activeClass.id, form.elements.assessmentId.value || null); noteClassroomChange(); hide("assessment"); await refreshActiveClass(); if (form.dataset.authorAfterSave === "true") { await openAuthoring(saved); announce(`${saved.title} was saved. Add questions when ready.`); } else { await openAssessment(saved); announce(`${saved.title} was saved. Enter scores when ready.`); } } catch (error) { errorMessage(error); } });
dialogs.question.querySelector("form").elements.questionType.addEventListener("change", updateQuestionTypeFields);
dialogs.question.querySelector("[data-add-option]").addEventListener("click", () => { const rows = [...dialogs.question.querySelectorAll("[data-option-editor] .option-row")]; questionOptionsEditor(rows.map((row) => ({ id: row.querySelector("[name=optionId]").value, text: row.querySelector("[name=optionText]").value, correct: row.querySelector("[name=correctOption]").checked })).concat({ text: "", correct: false })); });
dialogs.question.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget, type = form.elements.questionType.value; const options = [...form.querySelectorAll("[data-option-editor] .option-row")].map((row) => ({ id: row.querySelector("[name=optionId]").value || null, text: row.querySelector("[name=optionText]").value, correct: row.querySelector("[name=correctOption]").checked })); try { await saveAuthoredQuestion({ questionType: type, prompt: form.elements.prompt.value, points: form.elements.points.value, correctBoolean: form.elements.correctBoolean.value || null, referenceAnswer: form.elements.referenceAnswer.value, guidance: form.elements.guidance.value, options }, state.activeAssessment.id, form.elements.questionId.value || null); noteClassroomChange(); hide("question"); await refreshAuthoring(); renderAuthoring(); announce("Question saved in this assessment draft."); } catch (error) { errorMessage(error); } });
dialogs["sync-maximum"].querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); hide("sync-maximum"); await syncQuestionTotal(true); });
dialogs["delete-assessment"].querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; if (form.elements.confirmName.value !== state.activeAssessment.title) { errorMessage(new Error("Type the assessment title exactly before deleting it.")); return; } try { const removed = await deleteAssessmentPermanently(form.dataset.assessmentId); noteClassroomChange(); hide("delete-assessment"); state.activeAssessment = null; state.scoreSession = null; await refreshActiveClass(); renderGradebook(); announce(`Assessment deleted with ${removed.deletedScoreCount} related score record${removed.deletedScoreCount === 1 ? "" : "s"}.`); } catch (error) { errorMessage(error); } });
dialogs.bulk.querySelector("form").elements.roster.addEventListener("input", updateBulkPreview); dialogs.bulk.querySelector("form").elements.includeDuplicates.addEventListener("change", updateBulkPreview);
dialogs.bulk.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget, reviewed = reviewRoster(form.elements.roster.value, state.students), entries = reviewed.filter((entry) => form.elements.includeDuplicates.checked || !entry.duplicate); try { if (!entries.length) throw new Error("Paste at least one new student name, or choose to include possible repeats."); await saveStudents(entries.map((entry) => ({ fullName: entry.fullName })), state.activeClass.id); noteClassroomChange(); hide("bulk"); await refreshActiveClass(); renderClass(); announce(`${entries.length} student${entries.length === 1 ? " was" : "s were"} added to the roster.`); } catch (error) { errorMessage(error); } });
dialogs.archive.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { const restore = form.dataset.restore === "true"; await setClassArchived(form.dataset.classId, !restore); noteClassroomChange(); hide("archive"); state.activeClass = null; state.archivedView = false; await refreshClasses(); renderDashboard(); announce(restore ? "Class restored." : "Class archived. Its roster remains safely stored."); } catch (error) { errorMessage(error); } });
dialogs.delete.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; if (form.elements.confirmName.value !== state.activeClass.className) { errorMessage(new Error("Type the class name exactly before permanently deleting it.")); return; } try { await deleteClassPermanently(form.dataset.classId); noteClassroomChange(); hide("delete"); state.activeClass = null; state.archivedView = false; await refreshClasses(); renderDashboard(); announce("The class and its related local records were permanently deleted."); } catch (error) { errorMessage(error); } });
dialogs.backup.querySelector("[data-export]").addEventListener("click", () => { dialogs["backup-encrypt"].querySelector("form").reset(); show("backup-encrypt"); });
dialogs["backup-encrypt"].querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget, passphrase = form.elements.passphrase.value, submit = form.querySelector('[type="submit"]'); if (!form.elements.understandPassphrase.checked) { errorMessage(new Error("Confirm that you will keep the backup passphrase.")); return; } if (passphrase !== form.elements.confirmPassphrase.value) { errorMessage(new Error("The passphrases do not match.")); form.elements.confirmPassphrase.focus(); return; } submit.disabled = true; try { const backup = await createBackup(); const encrypted = await encryptBackup(backup, passphrase); downloadJsonFile(`matevok-encrypted-backup-${new Date().toISOString().slice(0, 10)}.json`, encrypted); noteBackupExport(); refreshBackupReminder(); hide("backup-encrypt"); announce("Encrypted backup download started. Check your Downloads folder and keep the passphrase separately."); } catch (error) { errorMessage(error); } finally { submit.disabled = false; form.reset(); } });
dialogs.backup.querySelector("[data-import]").addEventListener("click", () => dialogs.backup.querySelector('input[type="file"]').click());
dialogs.backup.querySelector('input[type="file"]').addEventListener("change", async (event) => { const input = event.currentTarget, file = input.files?.[0]; state.backup = null; state.encryptedBackupEnvelope = null; try { if (!file || file.size > MAX_ENCRYPTED_BACKUP_FILE_BYTES) throw new Error("Choose a backup file smaller than 25 MB."); const parsed = JSON.parse(await file.text()); if (isEncryptedBackup(parsed)) { state.encryptedBackupEnvelope = validateEncryptedBackupEnvelope(parsed); dialogs["backup-unlock"].querySelector("form").reset(); show("backup-unlock"); } else showBackupRestoreReview(parsed, false); } catch (error) { errorMessage(error); } finally { input.value = ""; } });
dialogs["backup-unlock"].querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget, passphrase = form.elements.passphrase.value, submit = form.querySelector('[type="submit"]'); if (!state.encryptedBackupEnvelope) { errorMessage(new Error("Choose an encrypted backup file first.")); return; } submit.disabled = true; try { const decrypted = await decryptBackup(state.encryptedBackupEnvelope, passphrase); dialogs["backup-unlock"].close(); delete state.dialogReturnFocus["backup-unlock"]; showBackupRestoreReview(decrypted, true); } catch (error) { errorMessage(error); } finally { submit.disabled = false; form.elements.passphrase.value = ""; } });
dialogs["backup-unlock"].addEventListener("close", () => { state.encryptedBackupEnvelope = null; dialogs["backup-unlock"].querySelector("form").reset(); });
dialogs.restore.addEventListener("close", () => { state.backup = null; });
dialogs.restore.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; if (!form.elements.replace.checked) { errorMessage(new Error("Confirm that restoring will replace your current local records.")); return; } if (!state.backup) { errorMessage(new Error("Choose and review a backup file before restoring.")); return; } const buttons = [...form.querySelectorAll("button")], wasDisabled = buttons.map((button) => button.disabled), progress = form.querySelector("[data-restore-progress]"); buttons.forEach((button) => { button.disabled = true; }); progress.textContent = "Restoring this backup… Keep this window open. Larger backups may take a little while."; progress.hidden = false; try { const restored = await replaceWithBackup(state.backup); noteClassroomChange(); hide("restore"); hide("backup"); state.backup = null; state.activeClass = null; state.archivedView = false; await refreshClasses(); renderDashboard(); announce(`Backup restored: ${restored.classCount} classes, ${restored.studentCount} student records, ${restored.attendanceCount} attendance records, ${restored.assessmentCount} assessments, ${restored.scoreCount} scores, ${restored.questionCount} questions, ${restored.optionCount} answer choices, ${restored.lessonCount} lessons, ${restored.materialCount} materials, ${restored.classWorkCount} class-work items, and ${restored.workSubmissionCount} submission statuses.`); } catch (error) { progress.hidden = true; errorMessage(error); } finally { buttons.forEach((button, index) => { if (button.isConnected) button.disabled = wasDisabled[index]; }); } });
dialogs.restore.addEventListener("cancel", (event) => { if (pendingForms.has(dialogs.restore.querySelector("form"))) { event.preventDefault(); announce("Backup restore is in progress. Keep this window open until it finishes."); } });

const installButton = document.querySelector("[data-install]"); let installPrompt; window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); installPrompt = event; installButton.hidden = false; }); installButton.addEventListener("click", async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installButton.hidden = true; }); window.addEventListener("appinstalled", () => { installButton.hidden = true; });
const menu = document.querySelector("[data-menu-button]"), sidebar = document.querySelector("[data-sidebar]"), scrim = document.querySelector("[data-sidebar-scrim]"); const closeMenu = () => { sidebar.dataset.open = "false"; menu.setAttribute("aria-expanded", "false"); }; menu.addEventListener("click", () => { const open = sidebar.dataset.open !== "true"; sidebar.dataset.open = String(open); menu.setAttribute("aria-expanded", String(open)); }); scrim.addEventListener("click", closeMenu); document.querySelector('[data-nav-item="My Classes"]')?.addEventListener("click", (event) => { if (!state.activeClass && !state.archivedView && currentLocation.textContent !== "My Materials") return; event.preventDefault(); requestWorkspaceNavigation("My Classes"); }); document.querySelectorAll(".nav-item--available[data-nav-item]").forEach((item) => item.addEventListener("click", () => requestWorkspaceNavigation(item.dataset.navItem))); document.addEventListener("keydown", (event) => { if (event.key !== "Escape") return; if (dialogs["workspace-lock"].open) { event.preventDefault(); event.stopPropagation(); dialogs["workspace-lock"].querySelector("[data-workspace-retry]")?.focus(); return; } if (sidebar.dataset.open === "true") { closeMenu(); menu.focus(); } }, true);
dialogs["workspace-lock"].querySelector("[data-workspace-retry]").addEventListener("click", async (event) => { const button = event.currentTarget; button.disabled = true; try { await init(); } finally { button.disabled = false; } });
window.addEventListener("pagehide", () => workspaceLock?.release());
window.addEventListener("pageshow", (event) => { if (event.persisted) { workspaceLock = null; init(); } });
async function init() {
  if (!workspaceLock) {
    const lock = await acquireWorkspaceLock();
    if (lock.status === "busy") { if (!dialogs["workspace-lock"].open) dialogs["workspace-lock"].showModal(); dialogs["workspace-lock"].querySelector("[data-workspace-retry]").focus(); return; }
    workspaceLock = lock;
    if (dialogs["workspace-lock"].open) dialogs["workspace-lock"].close();
  }
  try { const health = await getLocalStoreHealth(); const warning = workspaceLock.status !== "acquired"; document.querySelector("[data-storage-message]").textContent = `Private device storage is ready · workspace format ${health.schemaVersion}${warning ? " · keep one MATEVOK tab open to avoid stale edits" : ""}`; document.querySelector("[data-storage-dot]").dataset.state = warning ? "warning" : "ready"; await refreshClasses(); renderDashboard(); }
  catch (error) { document.querySelector("[data-storage-message]").textContent = "Private device storage needs attention. Your information has not been changed."; document.querySelector("[data-storage-dot]").dataset.state = "error"; root.replaceChildren(el("section", { class: "empty-state" }, [el("h1", { text: "Private storage needs attention" }), el("p", { text: error.message }), action("Try again", () => { if (workspaceLock?.status !== "acquired") { workspaceLock?.release(); workspaceLock = null; } return init(); })])); }
}
init();
