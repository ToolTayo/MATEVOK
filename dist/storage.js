/** Private browser-local data boundary. UI code never accesses IndexedDB directly. */
import { GENERIC_RAW_POLICY, compareDecimal, normalizeDecimalInput, sumDecimalStrings } from "./gradebook.js";
export const DATABASE_NAME = "teacher-workspace";
export const LOCAL_SCHEMA_VERSION = 9;
export const META_STORE = "meta";
export const BACKUP_FORMAT = "teacher-workspace-backup";
export const BACKUP_VERSION = 3;
export const LEGACY_BACKUP_VERSION = 1;
export const PREVIOUS_BACKUP_VERSION = 2;

export const STORE_DEFINITIONS = Object.freeze([
  { name: "workspaces", indexes: [] },
  { name: "classes", indexes: [["workspaceId", "workspaceId"], ["archivedAt", "archivedAt"]] },
  { name: "students", indexes: [["classId", "classId"], ["archivedAt", "archivedAt"]] },
  { name: "attendance", indexes: [["classId", "classId"], ["studentId", "studentId"], ["classDate", "classDate"]] },
  { name: "assessments", indexes: [["classId", "classId"], ["classDate", "classDate"]] },
  { name: "scores", indexes: [["assessmentId", "assessmentId"], ["studentId", "studentId"], ["classId", "classId"], ["assessmentStudent", "assessmentStudent"]] },
  { name: "questions", indexes: [["assessmentId", "assessmentId"], ["classId", "classId"]] },
  { name: "questionOptions", indexes: [["questionId", "questionId"], ["assessmentId", "assessmentId"], ["classId", "classId"]] },
  { name: "assignments", indexes: [["classId", "classId"]] },
  { name: "lessons", indexes: [["classId", "classId"]] },
  { name: "classWork", indexes: [["classId", "classId"], ["classDueDate", ["classId", "dueDate"]], ["assessmentId", "assessmentId"]] },
  { name: "workSubmissions", indexes: [["classId", "classId"], ["workItemId", "workItemId"], ["studentId", "studentId"], ["classStudent", ["classId", "studentId"]]] },
  { name: "classroomState", indexes: [["classId", "classId"]] },
  { name: "progress", indexes: [["classId", "classId"], ["studentId", "studentId"]] },
  { name: "reports", indexes: [["classId", "classId"]] },
  { name: "materials", indexes: [["kind", "kind"], ["title", "title"]] }
]);
export const BACKUP_STORES = Object.freeze(["classes", "students", "attendance", "assessments", "scores", "questions", "questionOptions", "lessons", "materials", "classWork", "workSubmissions"]);
const PREVIOUS_BACKUP_STORES = Object.freeze(BACKUP_STORES.slice(0, -2));
export const ATTENDANCE_STATUSES = Object.freeze(["present", "absent", "late", "excused"]);
export const QUESTION_TYPES = Object.freeze(["multiple-choice", "true-false", "short-answer", "essay"]);
export const LESSON_STATUSES = Object.freeze(["draft", "ready"]);
export const WORK_SUBMISSION_STATUSES = Object.freeze(["submitted", "missing", "excused"]);
const DATA_STORES = new Set(STORE_DEFINITIONS.map(({ name }) => name));
const CLASS_RELATED_STORES = STORE_DEFINITIONS.map(({ name }) => name).filter((name) => !["workspaces", "materials"].includes(name));

export class LocalStorageError extends Error { constructor(message, cause) { super(message); this.name = "LocalStorageError"; this.cause = cause; } }
let writePermission = () => true;
export function setLocalWritePermission(check) { writePermission = typeof check === "function" ? check : () => true; }
function writeTransaction(db, stores) { if (!writePermission()) throw new LocalStorageError("This window no longer has editing access. Reopen it after the other MATEVOK window is closed; saved records are unchanged."); return db.transaction(stores, "readwrite"); }
const contains = (names, value) => typeof names.contains === "function" ? names.contains(value) : names.includes(value);
const hasStore = (db, name) => contains(db.objectStoreNames, name);

/** Additive only: no migration deletes or renames a teacher's data. */
export function applySchemaUpgrade(db, oldVersion, transaction) {
  if (!hasStore(db, META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
  for (const definition of STORE_DEFINITIONS) {
    const store = hasStore(db, definition.name) ? transaction.objectStore(definition.name) : db.createObjectStore(definition.name, { keyPath: "id" });
    for (const [indexName, keyPath] of definition.indexes) if (!contains(store.indexNames, indexName)) store.createIndex(indexName, keyPath, { unique: false });
  }
  transaction.objectStore(META_STORE).put({ key: "schemaVersion", value: LOCAL_SCHEMA_VERSION, updatedAt: new Date().toISOString() });
}

export function createLocalId(prefix = "record") { const safe = String(prefix).replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "record"; return globalThis.crypto?.randomUUID ? `${safe}_${globalThis.crypto.randomUUID()}` : `${safe}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
export function normalizeText(value, maxLength = 280) { return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxLength) : ""; }
export function normalizeName(value) { return normalizeText(value, 120).toLocaleLowerCase(); }
export function getLocalDateString(date = new Date()) { if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new LocalStorageError("Choose a valid attendance date."); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
export function normalizeAttendanceDate(value) { const date = normalizeText(value, 10); const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date); if (!match) throw new LocalStorageError("Choose a valid attendance date."); const [, year, month, day] = match; const parsed = new Date(Number(year), Number(month) - 1, Number(day)); if (parsed.getFullYear() !== Number(year) || parsed.getMonth() !== Number(month) - 1 || parsed.getDate() !== Number(day)) throw new LocalStorageError("Choose a valid attendance date."); return date; }
export function attendanceRecordId(classId, date, studentId) { return `attendance_${normalizeText(classId, 36)}_${normalizeAttendanceDate(date)}_${normalizeText(studentId, 36)}`; }

function safeRecord(storeName, value, now = new Date().toISOString()) {
  if (!DATA_STORES.has(storeName)) throw new LocalStorageError("That storage area is not available.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalStorageError("The information could not be saved safely.");
  const record = Object.create(null);
  for (const [key, item] of Object.entries(value)) if (!["__proto__", "constructor", "prototype"].includes(key)) record[key] = item;
  record.id = normalizeText(record.id, 120) || createLocalId(storeName.endsWith("s") ? storeName.slice(0, -1) : storeName);
  record.createdAt = normalizeText(record.createdAt, 40) || now;
  record.updatedAt = now;
  return record;
}
export const prepareRecord = safeRecord;

export function prepareClass(value, existing = null, now = new Date().toISOString()) {
  const className = normalizeText(value.className, 100); if (!className) throw new LocalStorageError("Add a class or section name.");
  return safeRecord("classes", { id: existing?.id ?? value.id, className, gradeLevel: normalizeText(value.gradeLevel, 60), subject: normalizeText(value.subject, 80), term: normalizeText(value.term, 80), schedule: normalizeText(value.schedule, 160), notes: normalizeText(value.notes, 500), archivedAt: existing?.archivedAt ?? value.archivedAt ?? null, type: "class", createdAt: existing?.createdAt ?? value.createdAt }, now);
}
export function prepareStudent(value, classId, existing = null, now = new Date().toISOString()) {
  const fullName = normalizeText(value.fullName, 120); if (!fullName) throw new LocalStorageError("Add the student's name.");
  const safeClassId = normalizeText(classId ?? existing?.classId, 120); if (!safeClassId) throw new LocalStorageError("Choose a class before adding a student.");
  return safeRecord("students", { id: existing?.id ?? value.id, classId: safeClassId, fullName, normalizedName: normalizeName(fullName), archivedAt: existing?.archivedAt ?? value.archivedAt ?? null, type: "student", createdAt: existing?.createdAt ?? value.createdAt }, now);
}
export function prepareAttendance(value, existing = null, now = new Date().toISOString()) {
  const classId = normalizeText(value?.classId ?? existing?.classId, 120); const studentId = normalizeText(value?.studentId ?? existing?.studentId, 120); const date = normalizeAttendanceDate(value?.date ?? existing?.date); const status = normalizeText(value?.status ?? existing?.status, 20).toLowerCase();
  if (!classId || !studentId) throw new LocalStorageError("Attendance must belong to one class and student.");
  if (!ATTENDANCE_STATUSES.includes(status)) throw new LocalStorageError("Choose Present, Absent, Late, or Excused.");
  return safeRecord("attendance", { id: existing?.id ?? value?.id ?? attendanceRecordId(classId, date, studentId), classId, studentId, date, classDate: `${classId}::${date}`, status, type: "attendance", createdAt: existing?.createdAt ?? value?.createdAt }, now);
}
function scoreNumber(value, label) { try { return normalizeDecimalInput(value, label); } catch (error) { throw new LocalStorageError(error.message, error); } }
export function prepareAssessment(value, existing = null, now = new Date().toISOString()) {
  const classId = normalizeText(value?.classId ?? existing?.classId, 120); const title = normalizeText(value?.title ?? existing?.title, 160); const date = normalizeAttendanceDate(value?.date ?? existing?.date); const maximumScore = scoreNumber(value?.maximumScore ?? existing?.maximumScore, "Maximum score"); const policyId = normalizeText(value?.policyId ?? existing?.policyId ?? GENERIC_RAW_POLICY.id, 80); const authoringStatus = normalizeText(value?.authoringStatus ?? existing?.authoringStatus ?? "draft", 20).toLowerCase(); const assessmentKind = normalizeText(value?.assessmentKind ?? existing?.assessmentKind ?? "quiz", 30).toLowerCase();
  if (!classId) throw new LocalStorageError("Choose a class before creating an assessment.");
  if (!title) throw new LocalStorageError("Add an assessment title.");
  if (compareDecimal(maximumScore, "0") <= 0) throw new LocalStorageError("Maximum score must be greater than zero.");
  if (policyId !== GENERIC_RAW_POLICY.id) throw new LocalStorageError("This grading policy is not available on this device.");
  if (!["draft", "ready"].includes(authoringStatus)) throw new LocalStorageError("Assessment status must be Draft or Ready.");
  if (!["quiz", "test", "worksheet", "practice"].includes(assessmentKind)) throw new LocalStorageError("Choose a supported assessment use.");
  return safeRecord("assessments", { id: existing?.id ?? value?.id, classId, title, date, classDate: `${classId}::${date}`, maximumScore, category: normalizeText(value?.category ?? existing?.category, 80), term: normalizeText(value?.term ?? existing?.term, 80), policyId, instructions: normalizeText(value?.instructions ?? existing?.instructions, 1200), assessmentKind, authoringStatus, showPoints: Boolean(value?.showPoints ?? existing?.showPoints), type: "assessment", createdAt: existing?.createdAt ?? value?.createdAt }, now);
}
export function scoreRecordId(assessmentId, studentId) { return `score_${normalizeText(assessmentId, 48)}_${normalizeText(studentId, 48)}`; }
export function prepareScore(value, existing = null, now = new Date().toISOString()) {
  const assessmentId = normalizeText(value?.assessmentId ?? existing?.assessmentId, 120); const classId = normalizeText(value?.classId ?? existing?.classId, 120); const studentId = normalizeText(value?.studentId ?? existing?.studentId, 120); const rawScore = scoreNumber(value?.rawScore ?? existing?.rawScore, "Score");
  if (!assessmentId || !classId || !studentId) throw new LocalStorageError("A score must belong to an assessment, class, and student.");
  if (compareDecimal(rawScore, "0") < 0) throw new LocalStorageError("Score cannot be negative.");
  return safeRecord("scores", { id: existing?.id ?? value?.id ?? scoreRecordId(assessmentId, studentId), assessmentId, classId, studentId, assessmentStudent: `${assessmentId}::${studentId}`, rawScore, type: "score", createdAt: existing?.createdAt ?? value?.createdAt }, now);
}
export function prepareQuestion(value, existing = null, now = new Date().toISOString()) {
  const assessmentId = normalizeText(value?.assessmentId ?? existing?.assessmentId, 120); const classId = normalizeText(value?.classId ?? existing?.classId, 120); const questionType = normalizeText(value?.questionType ?? existing?.questionType, 30).toLowerCase(); const prompt = normalizeText(value?.prompt ?? existing?.prompt, 4000); const rawPoints = value?.points ?? existing?.points; const points = rawPoints == null || String(rawPoints).trim() === "" ? "0" : scoreNumber(rawPoints, "Points"); const position = Number(value?.position ?? existing?.position);
  if (!assessmentId || !classId) throw new LocalStorageError("A question must belong to an assessment and class."); if (!QUESTION_TYPES.includes(questionType)) throw new LocalStorageError("Choose a supported question type."); if (compareDecimal(points, "0") < 0) throw new LocalStorageError("Points cannot be negative."); if (!Number.isInteger(position) || position < 0 || position > 100000) throw new LocalStorageError("Question position is not valid.");
  const correctBoolean = value?.correctBoolean ?? existing?.correctBoolean ?? null; const referenceAnswer = normalizeText(value?.referenceAnswer ?? existing?.referenceAnswer, 1600);
  return safeRecord("questions", { id: existing?.id ?? value?.id, assessmentId, classId, questionType, prompt, points, position, correctOptionId: questionType === "multiple-choice" ? normalizeText(value?.correctOptionId ?? existing?.correctOptionId, 120) || null : null, correctBoolean: questionType === "true-false" ? correctBoolean : null, referenceAnswer: questionType === "short-answer" ? referenceAnswer : null, guidance: questionType === "essay" ? normalizeText(value?.guidance ?? existing?.guidance, 2400) : "", type: "question", createdAt: existing?.createdAt ?? value?.createdAt }, now);
}
export function prepareQuestionOption(value, existing = null, now = new Date().toISOString()) {
  const questionId = normalizeText(value?.questionId ?? existing?.questionId, 120); const assessmentId = normalizeText(value?.assessmentId ?? existing?.assessmentId, 120); const classId = normalizeText(value?.classId ?? existing?.classId, 120); const text = normalizeText(value?.text ?? existing?.text, 1600); const position = Number(value?.position ?? existing?.position);
  if (!questionId || !assessmentId || !classId || !text) throw new LocalStorageError("Each answer choice needs text and a question."); if (!Number.isInteger(position) || position < 0 || position > 100000) throw new LocalStorageError("Answer choice position is not valid.");
  return safeRecord("questionOptions", { id: existing?.id ?? value?.id, questionId, assessmentId, classId, text, position, type: "question-option", createdAt: existing?.createdAt ?? value?.createdAt }, now);
}
function normalizeLessonText(value, label, maxLength = 8000) {
  if (value == null) return "";
  if (typeof value !== "string") throw new LocalStorageError(`${label} must be text.`);
  const text = value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
  if (text.length > maxLength) throw new LocalStorageError(`${label} is too long. Keep it under ${maxLength} characters.`);
  return text;
}
function normalizeLessonTitle(value) {
  const title = normalizeLessonText(value, "Lesson title", 160).replace(/\s+/g, " ").trim();
  if (!title) throw new LocalStorageError("Add a lesson title or topic.");
  return title;
}
export function prepareLesson(value, existing = null, now = new Date().toISOString()) {
  const classId = normalizeText(value?.classId ?? existing?.classId, 120);
  const title = normalizeLessonTitle(value?.title ?? existing?.title);
  const rawDate = value?.date ?? existing?.date ?? "";
  const date = rawDate == null || String(rawDate).trim() === "" ? "" : normalizeAttendanceDate(rawDate);
  const status = normalizeText(value?.status ?? existing?.status ?? "draft", 20).toLowerCase();
  if (!classId) throw new LocalStorageError("A lesson must belong to a class.");
  if (!LESSON_STATUSES.includes(status)) throw new LocalStorageError("Lesson status must be Draft or Ready.");
  const learningGoals = normalizeLessonText(value?.learningGoals ?? existing?.learningGoals, "Learning goals");
  if (status === "ready" && !learningGoals) throw new LocalStorageError("Add at least one learning goal before marking a lesson Ready.");
  return safeRecord("lessons", {
    id: existing?.id ?? value?.id,
    classId,
    title,
    date,
    status,
    learningGoals,
    priorKnowledge: normalizeLessonText(value?.priorKnowledge ?? existing?.priorKnowledge, "Prior knowledge"),
    materials: normalizeLessonText(value?.materials ?? existing?.materials, "Materials"),
    before: normalizeLessonText(value?.before ?? existing?.before, "Opening or introduction"),
    during: normalizeLessonText(value?.during ?? existing?.during, "Teaching and learning activities"),
    checkForUnderstanding: normalizeLessonText(value?.checkForUnderstanding ?? existing?.checkForUnderstanding, "Check for understanding"),
    assessment: normalizeLessonText(value?.assessment ?? existing?.assessment, "Assessment"),
    reflection: normalizeLessonText(value?.reflection ?? existing?.reflection, "Reflection"),
    nextStep: normalizeLessonText(value?.nextStep ?? existing?.nextStep, "Next step"),
    notes: normalizeLessonText(value?.notes ?? existing?.notes, "Teacher notes"),
    type: "lesson",
    createdAt: existing?.createdAt ?? value?.createdAt
  }, now);
}
export function prepareClassWork(value, existing = null, now = new Date().toISOString()) {
  const classId = normalizeText(value?.classId ?? existing?.classId, 120);
  const title = normalizeText(value?.title ?? existing?.title, 160);
  const rawDueDate = value?.dueDate ?? existing?.dueDate ?? "";
  const dueDate = rawDueDate == null || String(rawDueDate).trim() === "" ? "" : normalizeAttendanceDate(rawDueDate);
  const assessmentId = normalizeText(value?.assessmentId ?? existing?.assessmentId, 120) || null;
  if (!classId) throw new LocalStorageError("Class work must belong to a class.");
  if (!title) throw new LocalStorageError("Add a title for this class work.");
  return safeRecord("classWork", { id: existing?.id ?? value?.id, classId, title, dueDate, assessmentId, type: "class-work", createdAt: existing?.createdAt ?? value?.createdAt }, now);
}
export function prepareWorkSubmission(value, existing = null, now = new Date().toISOString()) {
  const classId = normalizeText(value?.classId ?? existing?.classId, 120);
  const workItemId = normalizeText(value?.workItemId ?? existing?.workItemId, 120);
  const studentId = normalizeText(value?.studentId ?? existing?.studentId, 120);
  const status = normalizeText(value?.status ?? existing?.status, 20).toLowerCase();
  if (!classId || !workItemId || !studentId) throw new LocalStorageError("A submission status must belong to class work and one student.");
  if (!WORK_SUBMISSION_STATUSES.includes(status)) throw new LocalStorageError("Choose Submitted, Missing, or Excused. Leave unrecorded students blank.");
  return safeRecord("workSubmissions", { id: existing?.id ?? value?.id, classId, workItemId, studentId, status, type: "work-submission", createdAt: existing?.createdAt ?? value?.createdAt }, now);
}
const LESSON_MATERIAL_FIELDS = Object.freeze(["learningGoals", "priorKnowledge", "materials", "before", "during", "checkForUnderstanding", "assessment", "reflection", "nextStep", "notes"]);
function materialLessonContent(value) {
  const lesson = prepareLesson({ ...value, classId: "material-validation", date: "" });
  return { title: lesson.title, status: lesson.status, ...Object.fromEntries(LESSON_MATERIAL_FIELDS.map((field) => [field, lesson[field]])) };
}
function materialAssessmentContent(value, title) {
  if (!Array.isArray(value?.questions)) throw new LocalStorageError("The assessment template questions are not valid.");
  const assessment = prepareAssessment({ ...value, title, classId: "material-validation", date: value.date || getLocalDateString(), term: "" });
  const childIds = new Set(), questionPositions = new Set();
  const questions = value.questions.map((entry, position) => {
    const id = normalizeText(entry?.id, 120) || createLocalId("material-question");
    if (childIds.has(id)) throw new LocalStorageError("The assessment template has duplicate question identifiers.");
    childIds.add(id);
    const questionPosition = Number(entry.position ?? position); if (questionPositions.has(questionPosition)) throw new LocalStorageError("The assessment template has duplicate question positions."); questionPositions.add(questionPosition);
    if (!Array.isArray(entry?.options)) throw new LocalStorageError("An assessment template question has invalid answer choices.");
    if (normalizeText(entry?.questionType, 30).toLowerCase() !== "multiple-choice" && entry.options.length) throw new LocalStorageError("Only multiple-choice template questions can contain answer choices.");
    const optionPositions = new Set();
    const options = entry.options.map((option, optionPosition) => {
      const optionId = normalizeText(option?.id, 120) || createLocalId("material-option");
      if (childIds.has(optionId)) throw new LocalStorageError("The assessment template has duplicate question or answer-choice identifiers.");
      childIds.add(optionId);
      const prepared = prepareQuestionOption({ ...option, id: optionId, questionId: id, assessmentId: "material-validation", classId: "material-validation", position: option.position ?? optionPosition });
      if (optionPositions.has(prepared.position)) throw new LocalStorageError("An assessment template question has duplicate answer-choice positions."); optionPositions.add(prepared.position);
      return { id: prepared.id, text: prepared.text, position: prepared.position };
    });
    const prepared = prepareQuestion({ ...entry, id, assessmentId: "material-validation", classId: "material-validation", position: entry.position ?? position });
    if (prepared.questionType === "multiple-choice" && prepared.correctOptionId && !options.some((option) => option.id === prepared.correctOptionId)) throw new LocalStorageError("An assessment template answer refers to a choice outside its question.");
    const complete = { ...prepared, options };
    if (assessment.authoringStatus === "ready") validateQuestionReady(complete);
    const { assessmentId, classId, createdAt, updatedAt, type, ...questionContent } = prepared;
    return { ...questionContent, options };
  });
  const { id, classId, classDate, date, term, createdAt, updatedAt, type, ...assessmentContent } = assessment;
  return { ...assessmentContent, questions };
}
export function prepareMaterial(value, existing = null, now = new Date().toISOString()) {
  const kind = normalizeText(value?.kind ?? existing?.kind, 24).toLowerCase();
  const title = normalizeText(value?.title ?? existing?.title, 160);
  if (!title) throw new LocalStorageError("Add a title for this material.");
  if (kind !== "lesson" && kind !== "assessment") throw new LocalStorageError("Choose a Lesson or Assessment template.");
  const content = kind === "lesson" ? materialLessonContent(value?.content ?? existing?.content) : materialAssessmentContent(value?.content ?? existing?.content, title);
  return safeRecord("materials", { id: existing?.id ?? value?.id, kind, title, content, type: "material", createdAt: existing?.createdAt ?? value?.createdAt }, now);
}
export function attendanceCounts(entries = []) { const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0])); entries.forEach((entry) => { if (ATTENDANCE_STATUSES.includes(entry?.status)) counts[entry.status] += 1; }); return counts; }
export function parseRoster(text) { return typeof text === "string" ? text.split(/\r?\n/).map((line, index) => ({ line: index + 1, fullName: normalizeText(line, 120) })).filter(({ fullName }) => fullName) : []; }
export function reviewRoster(text, existingStudents = []) { const known = new Set(existingStudents.filter((student) => !student.archivedAt).map((student) => student.normalizedName || normalizeName(student.fullName))); const seen = new Set(); return parseRoster(text).map((item) => { const normalizedName = normalizeName(item.fullName); const duplicate = known.has(normalizedName) || seen.has(normalizedName); seen.add(normalizedName); return { ...item, normalizedName, duplicate }; }); }

export function openTeacherWorkspaceDb(indexedDb = globalThis.indexedDB) {
  if (!indexedDb?.open) return Promise.reject(new LocalStorageError("This browser does not support private device storage."));
  return new Promise((resolve, reject) => { let request, settled = false; const fail = (message, cause) => { if (settled) return; settled = true; reject(new LocalStorageError(message, cause)); }; try { request = indexedDb.open(DATABASE_NAME, LOCAL_SCHEMA_VERSION); } catch (error) { fail("Private device storage could not be opened.", error); return; }
    request.onupgradeneeded = () => { try { applySchemaUpgrade(request.result, request.oldVersion, request.transaction); } catch (error) { request.transaction?.abort(); fail("Private device storage could not be prepared.", error); } };
    request.onerror = () => fail("Private device storage is unavailable.", request.error); request.onblocked = () => fail("Close other MATEVOK tabs, then try again."); request.onsuccess = () => { const db = request.result; if (settled) { db.close(); return; } settled = true; db.onversionchange = () => db.close(); resolve(db); };
  });
}
const result = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const done = (transaction) => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
async function completeOrAbort(transaction, operation) {
  try {
    const value = await operation();
    await done(transaction);
    return value;
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have committed or aborted. */ }
    throw error;
  }
}
async function withDatabase(work, indexedDb) { const db = await openTeacherWorkspaceDb(indexedDb); try { return await work(db); } catch (error) { throw error instanceof LocalStorageError ? error : new LocalStorageError("Your classroom information was not changed.", error); } finally { db.close(); } }

export async function getLocalStoreHealth(indexedDb = globalThis.indexedDB) { return withDatabase(async (db) => { const schema = await result(db.transaction(META_STORE, "readonly").objectStore(META_STORE).get("schemaVersion")); return { ready: true, schemaVersion: schema?.value ?? null, databaseVersion: db.version }; }, indexedDb); }
export async function getAllRecords(storeName, indexedDb = globalThis.indexedDB) { if (!DATA_STORES.has(storeName)) throw new LocalStorageError("That storage area is not available."); return withDatabase((db) => result(db.transaction(storeName, "readonly").objectStore(storeName).getAll()).then((entries) => entries || []), indexedDb); }
async function getAllByIndex(storeName, indexName, key, indexedDb = globalThis.indexedDB) {
  if (!DATA_STORES.has(storeName)) throw new LocalStorageError("That storage area is not available.");
  return withDatabase(async (db) => {
    const store = db.transaction(storeName, "readonly").objectStore(storeName);
    const indexed = store.indexNames && contains(store.indexNames, indexName);
    const entries = indexed ? await result(store.index(indexName).getAll(key)) : await result(store.getAll());
    // Keep the ownership check even on indexed reads; it also makes the fallback safe.
    return (entries || []).filter((entry) => entry[indexName] === key);
  }, indexedDb);
}
export async function getRecord(storeName, id, indexedDb = globalThis.indexedDB) { const safeId = normalizeText(id, 120); if (!safeId || !DATA_STORES.has(storeName)) return null; return withDatabase((db) => result(db.transaction(storeName, "readonly").objectStore(storeName).get(safeId)), indexedDb); }
export async function saveLocalRecord(storeName, value, indexedDb = globalThis.indexedDB) { const record = safeRecord(storeName, value); return withDatabase(async (db) => { const tx = writeTransaction(db, storeName); tx.objectStore(storeName).put(record); await done(tx); return record; }, indexedDb); }

export async function listClasses({ archived = false } = {}, indexedDb = globalThis.indexedDB) {
  const classes = (await getAllRecords("classes", indexedDb)).filter((entry) => Boolean(entry.archivedAt) === archived).sort((a, b) => a.className.localeCompare(b.className, undefined, { sensitivity: "base" }));
  if (!classes.length) return [];
  const counts = await withDatabase(async (db) => {
    const store = db.transaction("students", "readonly").objectStore("students"), byClass = new Map();
    if (store.indexNames && contains(store.indexNames, "classId")) {
      const index = store.index("classId");
      const studentsByClass = await Promise.all(classes.map((entry) => result(index.getAll(entry.id))));
      studentsByClass.forEach((students, index) => byClass.set(classes[index].id, students.filter((student) => !student.archivedAt).length));
    } else {
      const students = await result(store.getAll());
      students.filter((student) => !student.archivedAt).forEach((student) => byClass.set(student.classId, (byClass.get(student.classId) || 0) + 1));
    }
    return byClass;
  }, indexedDb);
  return classes.map((entry) => ({ ...entry, studentCount: counts.get(entry.id) || 0 }));
}
export async function saveClass(value, id = null, indexedDb = globalThis.indexedDB) { const existing = id ? await getRecord("classes", id, indexedDb) : null; if (id && !existing) throw new LocalStorageError("That class could not be found."); return saveLocalRecord("classes", prepareClass(value, existing), indexedDb); }
export async function setClassArchived(id, archived, indexedDb = globalThis.indexedDB) { const existing = await getRecord("classes", id, indexedDb); if (!existing) throw new LocalStorageError("That class could not be found."); return saveLocalRecord("classes", { ...existing, archivedAt: archived ? new Date().toISOString() : null }, indexedDb); }
export async function listStudents(classId, { archived = false } = {}, indexedDb = globalThis.indexedDB) { const safeId = normalizeText(classId, 120); return (await getAllByIndex("students", "classId", safeId, indexedDb)).filter((student) => Boolean(student.archivedAt) === archived).sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" })); }
export async function saveStudent(value, classId, id = null, indexedDb = globalThis.indexedDB) { const existing = id ? await getRecord("students", id, indexedDb) : null; if (id && !existing) throw new LocalStorageError("That student could not be found."); return saveLocalRecord("students", prepareStudent(value, classId, existing), indexedDb); }
export async function saveStudents(values, classId, indexedDb = globalThis.indexedDB) { const records = values.map((value) => prepareStudent(value, classId)); return withDatabase(async (db) => { const tx = writeTransaction(db, "students"); return completeOrAbort(tx, () => { records.forEach((record) => tx.objectStore("students").put(record)); return records; }); }, indexedDb); }
export async function copyActiveRosterToEmptyClass(sourceClassId, targetClassId, indexedDb = globalThis.indexedDB) {
  const sourceId = normalizeText(sourceClassId, 120), targetId = normalizeText(targetClassId, 120);
  if (!sourceId || !targetId) throw new LocalStorageError("Choose a source and destination class.");
  if (sourceId === targetId) throw new LocalStorageError("Choose a different class for the source and destination.");
  return withDatabase(async (db) => {
    const tx = writeTransaction(db, ["classes", "students"]), classes = tx.objectStore("classes"), students = tx.objectStore("students");
    const indexedStudents = (classId) => students.indexNames && contains(students.indexNames, "classId") ? result(students.index("classId").getAll(classId)) : result(students.getAll()).then((entries) => entries.filter((entry) => entry.classId === classId));
    return completeOrAbort(tx, async () => {
      const [source, target, sourceStudents, targetStudents] = await Promise.all([result(classes.get(sourceId)), result(classes.get(targetId)), indexedStudents(sourceId), indexedStudents(targetId)]);
      if (!source) throw new LocalStorageError("The source class could not be found.");
      if (!target) throw new LocalStorageError("The destination class could not be found.");
      if (target.archivedAt) throw new LocalStorageError("Restore the destination class before copying students into it.");
      if (targetStudents.length) throw new LocalStorageError("The destination already has a student roster. Copying is only available for an empty class; no existing students were changed.");
      const activeStudents = sourceStudents.filter((student) => !student.archivedAt);
      if (!activeStudents.length) throw new LocalStorageError("The source class has no active students to copy.");
      const copied = activeStudents.map((student) => prepareStudent({ fullName: student.fullName }, targetId));
      copied.forEach((student) => students.put(student));
      return copied;
    });
  }, indexedDb);
}
export async function setStudentArchived(id, archived, indexedDb = globalThis.indexedDB) { const existing = await getRecord("students", id, indexedDb); if (!existing) throw new LocalStorageError("That student could not be found."); return saveLocalRecord("students", { ...existing, archivedAt: archived ? new Date().toISOString() : null }, indexedDb); }
export async function listAttendanceRecords(classId, indexedDb = globalThis.indexedDB) { const safeClassId = normalizeText(classId, 120); return getAllByIndex("attendance", "classId", safeClassId, indexedDb); }
export async function listAttendanceForDate(classId, date, indexedDb = globalThis.indexedDB) { const safeClassId = normalizeText(classId, 120); const safeDate = normalizeAttendanceDate(date); return (await getAllByIndex("attendance", "classDate", `${safeClassId}::${safeDate}`, indexedDb)).sort((a, b) => a.studentId.localeCompare(b.studentId)); }
export async function listAttendanceHistory(classId, indexedDb = globalThis.indexedDB) { const grouped = new Map(); (await listAttendanceRecords(classId, indexedDb)).forEach((entry) => { const item = grouped.get(entry.date) || { date: entry.date, entries: [] }; item.entries.push(entry); grouped.set(entry.date, item); }); return [...grouped.values()].map((item) => ({ date: item.date, count: item.entries.length, counts: attendanceCounts(item.entries) })).sort((a, b) => b.date.localeCompare(a.date)); }
export async function saveAttendance(classId, date, entries, indexedDb = globalThis.indexedDB) {
  const safeClassId = normalizeText(classId, 120); const safeDate = normalizeAttendanceDate(date); if (!Array.isArray(entries)) throw new LocalStorageError("Attendance entries are not valid.");
  const [classRecord, students, existingEntries] = await Promise.all([getRecord("classes", safeClassId, indexedDb), getAllByIndex("students", "classId", safeClassId, indexedDb), listAttendanceForDate(safeClassId, safeDate, indexedDb)]);
  if (!classRecord) throw new LocalStorageError("That class could not be found.");
  const studentsById = new Map(students.filter((student) => student.classId === safeClassId).map((student) => [student.id, student])); const existingByStudentId = new Map(existingEntries.map((entry) => [entry.studentId, entry])); const seen = new Set();
  const records = entries.map((entry) => { const studentId = normalizeText(entry?.studentId, 120); if (!studentsById.has(studentId)) throw new LocalStorageError("Attendance includes a student outside this class."); if (seen.has(studentId)) throw new LocalStorageError("Each student can have only one attendance status per date."); seen.add(studentId); return prepareAttendance({ ...entry, classId: safeClassId, studentId, date: safeDate }, existingByStudentId.get(studentId)); });
  return withDatabase(async (db) => { const tx = writeTransaction(db, "attendance"); return completeOrAbort(tx, () => { records.forEach((record) => tx.objectStore("attendance").put(record)); return records; }); }, indexedDb);
}
export async function listAssessments(classId, indexedDb = globalThis.indexedDB) { const safeClassId = normalizeText(classId, 120); const [assessments, scores] = await Promise.all([getAllByIndex("assessments", "classId", safeClassId, indexedDb), getAllByIndex("scores", "classId", safeClassId, indexedDb)]); const counts = new Map(); scores.forEach((score) => counts.set(score.assessmentId, (counts.get(score.assessmentId) || 0) + 1)); return assessments.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" })).map((assessment) => ({ ...assessment, scoreCount: counts.get(assessment.id) || 0 })); }
export async function saveAssessment(value, classId, id = null, indexedDb = globalThis.indexedDB) { const existing = id ? await getRecord("assessments", id, indexedDb) : null; if (id && !existing) throw new LocalStorageError("That assessment could not be found."); const safeClassId = normalizeText(classId ?? existing?.classId, 120); if (!await getRecord("classes", safeClassId, indexedDb)) throw new LocalStorageError("That class could not be found."); return saveLocalRecord("assessments", prepareAssessment({ ...value, classId: safeClassId }, existing), indexedDb); }
export async function listLessons(classId, indexedDb = globalThis.indexedDB) {
  const safeClassId = normalizeText(classId, 120);
  return (await getAllByIndex("lessons", "classId", safeClassId, indexedDb)).sort((a, b) => (b.date || "0000-00-00").localeCompare(a.date || "0000-00-00") || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}
export async function saveLesson(value, classId, id = null, indexedDb = globalThis.indexedDB) {
  const existing = id ? await getRecord("lessons", id, indexedDb) : null;
  if (id && !existing) throw new LocalStorageError("That lesson could not be found.");
  const safeClassId = normalizeText(classId ?? existing?.classId, 120);
  if (existing && existing.classId !== safeClassId) throw new LocalStorageError("That lesson belongs to another class.");
  if (!await getRecord("classes", safeClassId, indexedDb)) throw new LocalStorageError("That class could not be found.");
  return saveLocalRecord("lessons", prepareLesson({ ...value, classId: safeClassId }, existing), indexedDb);
}
export async function listClassWork(classId, indexedDb = globalThis.indexedDB) {
  const safeClassId = normalizeText(classId, 120);
  return (await getAllByIndex("classWork", "classId", safeClassId, indexedDb)).sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}
export async function listWorkSubmissionsForClass(classId, indexedDb = globalThis.indexedDB) { return getAllByIndex("workSubmissions", "classId", normalizeText(classId, 120), indexedDb); }
export async function listWorkSubmissionsForItem(workItemId, indexedDb = globalThis.indexedDB) { return getAllByIndex("workSubmissions", "workItemId", normalizeText(workItemId, 120), indexedDb); }
export async function listWorkSubmissionsForStudent(classId, studentId, indexedDb = globalThis.indexedDB) {
  const safeClassId = normalizeText(classId, 120), safeStudentId = normalizeText(studentId, 120);
  return withDatabase(async (db) => {
    const store = db.transaction("workSubmissions", "readonly").objectStore("workSubmissions");
    const indexed = store.indexNames && contains(store.indexNames, "classStudent");
    const entries = indexed ? await result(store.index("classStudent").getAll([safeClassId, safeStudentId])) : await result(store.getAll());
    return (entries || []).filter((entry) => entry.classId === safeClassId && entry.studentId === safeStudentId);
  }, indexedDb);
}
export async function saveClassWork(value, classId, id = null, indexedDb = globalThis.indexedDB) {
  const existing = id ? await getRecord("classWork", id, indexedDb) : null;
  if (id && !existing) throw new LocalStorageError("That class work item could not be found.");
  const safeClassId = normalizeText(classId ?? existing?.classId, 120);
  if (existing && existing.classId !== safeClassId) throw new LocalStorageError("That class work item belongs to another class.");
  const record = prepareClassWork({ ...value, classId: safeClassId }, existing);
  return withDatabase(async (db) => {
    const tx = writeTransaction(db, ["classes", "assessments", "classWork"]), classes = tx.objectStore("classes"), assessments = tx.objectStore("assessments"), items = tx.objectStore("classWork");
    const [classRecord, current] = await Promise.all([result(classes.get(safeClassId)), id ? result(items.get(id)) : Promise.resolve(null)]);
    if (!classRecord) throw new LocalStorageError("That class could not be found.");
    if (classRecord.archivedAt) throw new LocalStorageError("Restore this class before changing its class work.");
    if (id && (!current || current.classId !== safeClassId)) throw new LocalStorageError("That class work item is no longer available in this class.");
    if (record.assessmentId) {
      const assessment = await result(assessments.get(record.assessmentId));
      if (!assessment || assessment.classId !== safeClassId) throw new LocalStorageError("Choose an assessment from this class, or leave the link blank.");
    }
    items.put({ ...record, createdAt: current?.createdAt || record.createdAt });
    await done(tx);
    return { ...record, createdAt: current?.createdAt || record.createdAt };
  }, indexedDb);
}
export async function saveWorkSubmissions(classId, workItemId, entries, indexedDb = globalThis.indexedDB) {
  const safeClassId = normalizeText(classId, 120), safeWorkItemId = normalizeText(workItemId, 120);
  if (!Array.isArray(entries)) throw new LocalStorageError("Submission status entries are not valid.");
  return withDatabase(async (db) => {
    const tx = writeTransaction(db, ["classes", "students", "classWork", "workSubmissions"]);
    const classes = tx.objectStore("classes"), students = tx.objectStore("students"), items = tx.objectStore("classWork"), submissions = tx.objectStore("workSubmissions");
    const studentsRequest = students.indexNames && contains(students.indexNames, "classId") ? students.index("classId").getAll(safeClassId) : students.getAll();
    const submissionsRequest = submissions.indexNames && contains(submissions.indexNames, "workItemId") ? submissions.index("workItemId").getAll(safeWorkItemId) : submissions.getAll();
    const [classRecord, item, allStudents, currentRecords] = await Promise.all([result(classes.get(safeClassId)), result(items.get(safeWorkItemId)), result(studentsRequest), result(submissionsRequest)]);
    if (!classRecord) throw new LocalStorageError("That class could not be found.");
    if (classRecord.archivedAt) throw new LocalStorageError("Restore this class before changing submission statuses.");
    if (!item || item.classId !== safeClassId) throw new LocalStorageError("That class work item is no longer available in this class.");
    const active = (allStudents || []).filter((student) => student.classId === safeClassId && !student.archivedAt), activeById = new Map(active.map((student) => [student.id, student]));
    const seen = new Set(), entryByStudent = new Map();
    entries.forEach((entry) => {
      const studentId = normalizeText(entry?.studentId, 120), rawStatus = entry?.status == null ? "" : normalizeText(entry.status, 20).toLowerCase();
      if (!activeById.has(studentId)) throw new LocalStorageError("Submission statuses can only be changed for active students in this class.");
      if (seen.has(studentId)) throw new LocalStorageError("Each student can have only one submission status per work item.");
      if (rawStatus && !WORK_SUBMISSION_STATUSES.includes(rawStatus)) throw new LocalStorageError("Choose Submitted, Missing, Excused, or Not recorded.");
      seen.add(studentId); entryByStudent.set(studentId, rawStatus);
    });
    if (seen.size !== activeById.size || [...activeById.keys()].some((studentId) => !seen.has(studentId))) throw new LocalStorageError("The class roster changed. Reopen this item to review the current active students; no statuses were changed.");
    const currentByStudent = new Map();
    (currentRecords || []).filter((record) => record.classId === safeClassId && record.workItemId === safeWorkItemId).forEach((record) => {
      if (currentByStudent.has(record.studentId)) throw new LocalStorageError("This work item has duplicate saved submission statuses. No changes were made.");
      currentByStudent.set(record.studentId, record);
    });
    const saved = [], mutations = [];
    for (const student of active) {
      const existing = currentByStudent.get(student.id), status = entryByStudent.get(student.id);
      if (!status) { if (existing) mutations.push({ kind: "delete", id: existing.id }); continue; }
      const record = prepareWorkSubmission({ classId: safeClassId, workItemId: safeWorkItemId, studentId: student.id, status }, existing);
      mutations.push({ kind: "put", record }); saved.push(record);
    }
    try { mutations.forEach((mutation) => mutation.kind === "delete" ? submissions.delete(mutation.id) : submissions.put(mutation.record)); }
    catch (error) { try { tx.abort(); } catch {} throw error; }
    await done(tx);
    return saved;
  }, indexedDb);
}
export async function deleteClassWorkPermanently(id, indexedDb = globalThis.indexedDB) {
  const workItemId = normalizeText(id, 120);
  return withDatabase(async (db) => {
    const tx = writeTransaction(db, ["classes", "classWork", "workSubmissions"]), classes = tx.objectStore("classes"), items = tx.objectStore("classWork"), submissions = tx.objectStore("workSubmissions");
    const item = await result(items.get(workItemId));
    if (!item) throw new LocalStorageError("That class work item could not be found.");
    const classRecord = await result(classes.get(item.classId));
    if (!classRecord) throw new LocalStorageError("That class could not be found.");
    if (classRecord.archivedAt) throw new LocalStorageError("Restore this class before deleting its class work.");
    const records = submissions.indexNames && contains(submissions.indexNames, "workItemId") ? await result(submissions.index("workItemId").getAll(workItemId)) : await result(submissions.getAll());
    try {
      items.delete(item.id);
      (records || []).filter((record) => record.workItemId === item.id && record.classId === item.classId).forEach((record) => submissions.delete(record.id));
    } catch (error) { try { tx.abort(); } catch {} throw error; }
    await done(tx);
    return { deletedWorkItemId: item.id };
  }, indexedDb);
}
export async function listMaterials({ kind = null } = {}, indexedDb = globalThis.indexedDB) {
  const safeKind = kind ? normalizeText(kind, 24).toLowerCase() : null;
  if (safeKind && !["lesson", "assessment"].includes(safeKind)) throw new LocalStorageError("Choose a Lesson or Assessment template.");
  return (await getAllRecords("materials", indexedDb)).filter((item) => !safeKind || item.kind === safeKind).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || b.updatedAt.localeCompare(a.updatedAt));
}
export async function saveLessonToMaterials(id, indexedDb = globalThis.indexedDB) {
  const source = await getRecord("lessons", id, indexedDb);
  if (!source) throw new LocalStorageError("That saved lesson could not be found.");
  return saveLocalRecord("materials", prepareMaterial({ kind: "lesson", title: source.title, content: source }), indexedDb);
}
export async function saveAssessmentToMaterials(id, indexedDb = globalThis.indexedDB) {
  const source = await getRecord("assessments", id, indexedDb);
  if (!source) throw new LocalStorageError("That saved assessment could not be found.");
  const questions = await listQuestions(source.id, indexedDb);
  if (source.authoringStatus === "ready") questions.forEach(validateQuestionReady);
  return saveLocalRecord("materials", prepareMaterial({ kind: "assessment", title: source.title, content: { ...source, questions } }), indexedDb);
}
export async function deleteMaterialPermanently(id, indexedDb = globalThis.indexedDB) {
  const material = await getRecord("materials", id, indexedDb);
  if (!material) throw new LocalStorageError("That material could not be found.");
  return withDatabase(async (db) => { const tx = writeTransaction(db, "materials"); tx.objectStore("materials").delete(material.id); await done(tx); return { deletedMaterialId: material.id, kind: material.kind }; }, indexedDb);
}
export async function duplicateLesson(id, indexedDb = globalThis.indexedDB) {
  const source = await getRecord("lessons", id, indexedDb);
  if (!source) throw new LocalStorageError("That lesson could not be found.");
  return saveLocalRecord("lessons", prepareLesson({ ...source, id: createLocalId("lesson"), title: `${source.title} copy`, status: "draft" }), indexedDb);
}
async function activeCopyTarget(sourceClassId, targetClassId, indexedDb) {
  const target = await getRecord("classes", targetClassId, indexedDb);
  if (!target) throw new LocalStorageError("Choose an available destination class.");
  if (target.id === sourceClassId) throw new LocalStorageError("Choose another class; Duplicate is available within this class.");
  if (target.archivedAt) throw new LocalStorageError("Restore the destination class before copying content to it.");
  return target;
}
function freshContent(record, overrides = {}) { const { id, createdAt, updatedAt, ...content } = record; return { ...content, ...overrides }; }
export async function copyLessonToClass(id, targetClassId, indexedDb = globalThis.indexedDB) {
  const source = await getRecord("lessons", id, indexedDb);
  if (!source) throw new LocalStorageError("That lesson could not be found.");
  const target = await activeCopyTarget(source.classId, targetClassId, indexedDb);
  return saveLocalRecord("lessons", prepareLesson(freshContent(source, { id: createLocalId("lesson"), classId: target.id, status: "draft" })), indexedDb);
}
export async function deleteLessonPermanently(id, indexedDb = globalThis.indexedDB) {
  const lesson = await getRecord("lessons", id, indexedDb);
  if (!lesson) throw new LocalStorageError("That lesson could not be found.");
  return withDatabase(async (db) => { const tx = writeTransaction(db, "lessons"); tx.objectStore("lessons").delete(lesson.id); await done(tx); return { deletedLessonId: lesson.id }; }, indexedDb);
}
export async function listScores(assessmentId, indexedDb = globalThis.indexedDB) { const safeId = normalizeText(assessmentId, 120); return (await getAllByIndex("scores", "assessmentId", safeId, indexedDb)).sort((a, b) => a.studentId.localeCompare(b.studentId)); }
export async function listScoresForClass(classId, indexedDb = globalThis.indexedDB) { const safeClassId = normalizeText(classId, 120); return getAllByIndex("scores", "classId", safeClassId, indexedDb); }
export async function saveScores(assessmentId, entries, indexedDb = globalThis.indexedDB) {
  const safeAssessmentId = normalizeText(assessmentId, 120); if (!Array.isArray(entries)) throw new LocalStorageError("Score entries are not valid.");
  const assessment = await getRecord("assessments", safeAssessmentId, indexedDb);
  if (!assessment) throw new LocalStorageError("That assessment could not be found.");
  const [students, existingScores] = await Promise.all([getAllByIndex("students", "classId", assessment.classId, indexedDb), listScores(safeAssessmentId, indexedDb)]);
  const studentsById = new Map(students.map((student) => [student.id, student])); const existingByStudent = new Map(existingScores.map((score) => [score.studentId, score])); const seen = new Set(); const records = []; const deleteIds = [];
  entries.forEach((entry) => { const studentId = normalizeText(entry?.studentId, 120); if (!studentsById.has(studentId)) throw new LocalStorageError("A score includes a student outside this assessment's class."); if (seen.has(studentId)) throw new LocalStorageError("Each student can have only one score per assessment."); seen.add(studentId); const rawInput = entry?.rawScore; if (rawInput == null || String(rawInput).trim() === "") { if (existingByStudent.has(studentId)) deleteIds.push(existingByStudent.get(studentId).id); return; } const score = prepareScore({ assessmentId: safeAssessmentId, classId: assessment.classId, studentId, rawScore: rawInput }, existingByStudent.get(studentId)); if (compareDecimal(score.rawScore, assessment.maximumScore) > 0) throw new LocalStorageError("Score cannot be greater than the maximum score."); records.push(score); });
  return withDatabase(async (db) => { const tx = writeTransaction(db, "scores"); const store = tx.objectStore("scores"); return completeOrAbort(tx, () => { deleteIds.forEach((id) => store.delete(id)); records.forEach((record) => store.put(record)); return records; }); }, indexedDb);
}
export async function deleteAssessmentPermanently(id, indexedDb = globalThis.indexedDB) { const assessmentId = normalizeText(id, 120); const assessment = await getRecord("assessments", assessmentId, indexedDb); if (!assessment) throw new LocalStorageError("That assessment could not be found."); const [scores, questions, options] = await Promise.all([listScores(assessmentId, indexedDb), listQuestions(assessmentId, indexedDb), getAllByIndex("questionOptions", "assessmentId", assessmentId, indexedDb)]); return withDatabase(async (db) => { const tx = writeTransaction(db, ["assessments", "scores", "questions", "questionOptions", "classWork"]); const scoreStore = tx.objectStore("scores"), questionStore = tx.objectStore("questions"), optionStore = tx.objectStore("questionOptions"), workStore = tx.objectStore("classWork"); return completeOrAbort(tx, async () => { tx.objectStore("assessments").delete(assessmentId); scores.forEach((score) => scoreStore.delete(score.id)); questions.forEach((question) => questionStore.delete(question.id)); options.forEach((option) => optionStore.delete(option.id)); const linkedWork = workStore.indexNames && contains(workStore.indexNames, "assessmentId") ? await result(workStore.index("assessmentId").getAll(assessmentId)) : await result(workStore.getAll()); const matchingWork = (linkedWork || []).filter((item) => item.assessmentId === assessmentId && item.classId === assessment.classId); matchingWork.forEach((item) => workStore.put({ ...item, assessmentId: null, updatedAt: new Date().toISOString() })); return { deletedAssessmentId: assessmentId, deletedScoreCount: scores.length, deletedQuestionCount: questions.length, unlinkedWorkCount: matchingWork.length }; }); }, indexedDb); }
export async function listQuestions(assessmentId, indexedDb = globalThis.indexedDB) { const safeAssessmentId = normalizeText(assessmentId, 120); const [questions, options] = await Promise.all([getAllByIndex("questions", "assessmentId", safeAssessmentId, indexedDb), getAllByIndex("questionOptions", "assessmentId", safeAssessmentId, indexedDb)]); const optionsByQuestion = new Map(); options.forEach((option) => { const entries = optionsByQuestion.get(option.questionId) || []; entries.push(option); optionsByQuestion.set(option.questionId, entries); }); return questions.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)).map((question) => ({ ...question, options: (optionsByQuestion.get(question.id) || []).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt)) })); }
export function questionTotalPoints(questions = []) { return sumDecimalStrings(questions.map((question) => question.points)); }
function validateQuestionReady(question) { if (!question.prompt || compareDecimal(question.points, "0") <= 0) throw new LocalStorageError("Every question needs a prompt and points."); if (question.questionType === "multiple-choice") { if (question.options.length < 2) throw new LocalStorageError("Multiple choice needs at least two answer choices."); if (!question.options.some((option) => option.id === question.correctOptionId)) throw new LocalStorageError("Multiple choice needs one valid correct answer."); } if (question.questionType === "true-false" && !["true", "false"].includes(question.correctBoolean)) throw new LocalStorageError("True or False needs a correct answer."); if (question.questionType === "short-answer" && !question.referenceAnswer) throw new LocalStorageError("Short answer needs a reference answer."); }
export async function validateAssessmentReady(assessmentId, indexedDb = globalThis.indexedDB) { const assessment = await getRecord("assessments", assessmentId, indexedDb); if (!assessment) throw new LocalStorageError("That assessment could not be found."); const questions = await listQuestions(assessment.id, indexedDb); if (!questions.length) throw new LocalStorageError("Add at least one complete question before marking an assessment Ready."); questions.forEach(validateQuestionReady); return { assessment, questions, totalPoints: questionTotalPoints(questions) }; }
export async function saveAuthoredQuestion(value, assessmentId, id = null, indexedDb = globalThis.indexedDB) {
  const safeAssessmentId = normalizeText(assessmentId, 120); const assessment = await getRecord("assessments", safeAssessmentId, indexedDb); if (!assessment) throw new LocalStorageError("That assessment could not be found."); const allQuestions = await getAllByIndex("questions", "assessmentId", safeAssessmentId, indexedDb); const existing = id ? allQuestions.find((question) => question.id === id) : null; if (id && (!existing || existing.assessmentId !== safeAssessmentId)) throw new LocalStorageError("That question could not be found."); const existingOptions = existing ? await getAllByIndex("questionOptions", "questionId", existing.id, indexedDb) : []; const position = existing?.position ?? Math.max(-1, ...allQuestions.map((question) => question.position)) + 1;
  const suppliedOptions = Array.isArray(value?.options) ? value.options.filter((option) => normalizeText(option?.text, 1600)) : []; const questionId = existing?.id ?? (normalizeText(value?.id, 120) || createLocalId("question")); let options = [];
  if (normalizeText(value?.questionType, 30).toLowerCase() === "multiple-choice") { options = suppliedOptions.map((option, index) => prepareQuestionOption({ id: existingOptions.find((current) => current.id === option.id)?.id ?? option.id ?? createLocalId("option"), questionId, assessmentId: safeAssessmentId, classId: assessment.classId, text: option.text, position: index }, existingOptions.find((current) => current.id === option.id))); const selected = suppliedOptions.filter((option) => option.correct); if (selected.length > 1) throw new LocalStorageError("Choose no more than one correct answer choice."); if (selected.length === 1) { const selectedIndex = suppliedOptions.indexOf(selected[0]); value = { ...value, correctOptionId: options[selectedIndex].id }; } else value = { ...value, correctOptionId: null }; }
  const question = prepareQuestion({ ...value, id: questionId, assessmentId: safeAssessmentId, classId: assessment.classId, position }, existing); if (question.questionType === "multiple-choice" && question.correctOptionId && !options.some((option) => option.id === question.correctOptionId)) throw new LocalStorageError("Choose a valid correct answer choice."); const deletedOptionIds = existingOptions.filter((option) => !options.some((next) => next.id === option.id)).map((option) => option.id);
  return withDatabase(async (db) => { const tx = writeTransaction(db, ["questions", "questionOptions"]); const optionStore = tx.objectStore("questionOptions"); return completeOrAbort(tx, () => { tx.objectStore("questions").put(question); deletedOptionIds.forEach((optionId) => optionStore.delete(optionId)); options.forEach((option) => optionStore.put(option)); return { ...question, options }; }); }, indexedDb);
}
export async function deleteQuestionPermanently(id, indexedDb = globalThis.indexedDB) { const question = await getRecord("questions", id, indexedDb); if (!question) throw new LocalStorageError("That question could not be found."); const options = await getAllByIndex("questionOptions", "questionId", question.id, indexedDb); return withDatabase(async (db) => { const tx = writeTransaction(db, ["questions", "questionOptions"]); const optionStore = tx.objectStore("questionOptions"); return completeOrAbort(tx, () => { tx.objectStore("questions").delete(question.id); options.forEach((option) => optionStore.delete(option.id)); return { deletedQuestionId: question.id }; }); }, indexedDb); }
export async function moveQuestion(id, direction, indexedDb = globalThis.indexedDB) { const question = await getRecord("questions", id, indexedDb); if (!question) throw new LocalStorageError("That question could not be found."); const questions = await listQuestions(question.assessmentId, indexedDb); const index = questions.findIndex((entry) => entry.id === question.id); const targetIndex = direction === "up" ? index - 1 : index + 1; if (targetIndex < 0 || targetIndex >= questions.length) return questions; const target = questions[targetIndex]; const now = new Date().toISOString(); return withDatabase(async (db) => { const tx = writeTransaction(db, "questions"); const store = tx.objectStore("questions"); return completeOrAbort(tx, () => { store.put({ ...question, position: target.position, updatedAt: now }); store.put({ ...target, position: question.position, updatedAt: now }); }); }, indexedDb).then(() => listQuestions(question.assessmentId, indexedDb)); }
async function writeAssessmentCopy(source, target, questions, { title = source.title, date = source.date, term = source.term } = {}, indexedDb = globalThis.indexedDB) {
  const duplicate = prepareAssessment(freshContent(source, { id: createLocalId("assessment"), classId: target.id, title, date, term, authoringStatus: "draft" })); const questionMap = new Map(); const optionMap = new Map(); const copies = questions.map((question) => { const newId = createLocalId("question"); questionMap.set(question.id, newId); return { question, newId }; }); const optionCopies = [];
  copies.forEach(({ question, newId }) => question.options.forEach((option) => { const newOptionId = createLocalId("option"); optionMap.set(option.id, newOptionId); optionCopies.push(prepareQuestionOption(freshContent(option, { id: newOptionId, questionId: newId, assessmentId: duplicate.id, classId: duplicate.classId }))); }));
  const questionCopies = copies.map(({ question, newId }) => prepareQuestion(freshContent(question, { id: newId, assessmentId: duplicate.id, classId: duplicate.classId, correctOptionId: question.correctOptionId ? optionMap.get(question.correctOptionId) : null })));
  return withDatabase(async (db) => { const tx = writeTransaction(db, ["assessments", "questions", "questionOptions"]); return completeOrAbort(tx, () => { tx.objectStore("assessments").put(duplicate); questionCopies.forEach((question) => tx.objectStore("questions").put(question)); optionCopies.forEach((option) => tx.objectStore("questionOptions").put(option)); return duplicate; }); }, indexedDb);
}
async function copyAssessmentContent(id, targetClassId, { sameClass = false } = {}, indexedDb = globalThis.indexedDB) {
  const source = await getRecord("assessments", id, indexedDb); if (!source) throw new LocalStorageError("That assessment could not be found.");
  const target = sameClass ? { id: source.classId } : await activeCopyTarget(source.classId, targetClassId, indexedDb);
  const questions = await listQuestions(source.id, indexedDb); const title = sameClass ? `${source.title} copy` : source.title;
  return writeAssessmentCopy(source, target, questions, { title }, indexedDb);
}
export async function materializeMaterialToClass(materialId, targetClassId, indexedDb = globalThis.indexedDB) {
  const template = await getRecord("materials", materialId, indexedDb);
  if (!template) throw new LocalStorageError("That My Materials template could not be found.");
  const target = await getRecord("classes", targetClassId, indexedDb);
  if (!target || target.archivedAt) throw new LocalStorageError("Choose an active destination class. Archived classes are not available here.");
  if (template.kind === "lesson") {
    const lesson = prepareLesson({ ...template.content, id: createLocalId("lesson"), classId: target.id, date: "", status: "draft" });
    return { kind: "lesson", item: await saveLocalRecord("lessons", lesson, indexedDb), target };
  }
  const source = { title: template.title, ...template.content };
  const assessment = { ...source, title: template.title, date: getLocalDateString(), term: "", authoringStatus: "draft" };
  const item = await writeAssessmentCopy(assessment, target, template.content.questions, { title: template.title, date: assessment.date, term: "" }, indexedDb);
  return { kind: "assessment", item, target };
}
export async function duplicateAuthoredAssessment(id, indexedDb = globalThis.indexedDB) { const source = await getRecord("assessments", id, indexedDb); if (!source) throw new LocalStorageError("That assessment could not be found."); return copyAssessmentContent(id, source.classId, { sameClass: true }, indexedDb); }
export async function copyAuthoredAssessmentToClass(id, targetClassId, indexedDb = globalThis.indexedDB) { return copyAssessmentContent(id, targetClassId, {}, indexedDb); }
export async function updateAssessmentAuthoringStatus(id, status, indexedDb = globalThis.indexedDB) { const assessment = await getRecord("assessments", id, indexedDb); if (!assessment) throw new LocalStorageError("That assessment could not be found."); if (status === "ready") await validateAssessmentReady(assessment.id, indexedDb); return saveLocalRecord("assessments", prepareAssessment({ ...assessment, authoringStatus: status }, assessment), indexedDb); }
export async function syncAssessmentMaximumToQuestionTotal(id, { confirmScored = false } = {}, indexedDb = globalThis.indexedDB) { const { assessment, questions, totalPoints } = await validateAssessmentReady(id, indexedDb); const scores = await listScores(assessment.id, indexedDb); if (scores.length && !confirmScored) return { updated: false, needsConfirmation: true, totalPoints, scoreCount: scores.length }; const updated = await saveAssessment({ ...assessment, maximumScore: totalPoints }, assessment.classId, assessment.id, indexedDb); return { updated: true, needsConfirmation: false, assessment: updated, totalPoints, scoreCount: scores.length, questionCount: questions.length }; }
export async function deleteClassPermanently(id, indexedDb = globalThis.indexedDB) {
  const classId = normalizeText(id, 120);
  if (!classId) throw new LocalStorageError("That class could not be found.");
  return withDatabase(async (db) => {
    const tx = writeTransaction(db, CLASS_RELATED_STORES);
    try {
      const target = await result(tx.objectStore("classes").get(classId));
      if (!target) throw new LocalStorageError("That class could not be found.");
      for (const name of CLASS_RELATED_STORES) {
        const store = tx.objectStore(name);
        if (name === "classes") {
          store.delete(classId);
          continue;
        }
        const indexed = store.indexNames && contains(store.indexNames, "classId");
        const entries = await result(indexed ? store.index("classId").getAll(classId) : store.getAll());
        (entries || []).filter((entry) => entry.classId === classId).forEach((entry) => store.delete(entry.id));
      }
      await done(tx);
      return { deletedClassId: classId };
    } catch (error) {
      try { tx.abort(); } catch { /* The transaction may already have committed or aborted. */ }
      throw error;
    }
  }, indexedDb);
}

function validateMaterialBackupRecord(record) {
  const only = (value, allowed) => Object.keys(value).every((key) => allowed.has(key));
  if (!["id", "kind", "title", "content", "type", "createdAt", "updatedAt"].every((key) => key in record) || !only(record, new Set(["id", "kind", "title", "content", "type", "createdAt", "updatedAt"]))) throw new LocalStorageError("The backup contains an invalid My Materials record.");
  const content = record.content;
  if (!content || typeof content !== "object" || Array.isArray(content) || "classId" in content || "studentId" in content || "scores" in content || "attendance" in content) throw new LocalStorageError("A My Materials template contains class or student records.");
  if (record.kind === "lesson") {
    if (!only(content, new Set(["title", "status", ...LESSON_MATERIAL_FIELDS]))) throw new LocalStorageError("The backup contains an invalid lesson template shape.");
  } else if (record.kind === "assessment") {
    if (!only(content, new Set(["title", "maximumScore", "category", "policyId", "instructions", "assessmentKind", "authoringStatus", "showPoints", "questions"])) || !Array.isArray(content.questions)) throw new LocalStorageError("The backup contains an invalid assessment template shape.");
    content.questions.forEach((question) => {
      if (!question?.id || !Array.isArray(question.options) || question.options.some((option) => !option?.id)) throw new LocalStorageError("An assessment template has a question or answer choice without an identifier.");
    });
  } else throw new LocalStorageError("The backup contains an unsupported My Materials type.");
}
function validateBackupRecord(storeName, record, ids, classIds) { if (!record || typeof record !== "object" || Array.isArray(record)) throw new LocalStorageError("The backup contains an invalid record."); if (storeName === "materials") validateMaterialBackupRecord(record); const now = record.updatedAt || new Date().toISOString(); const safe = storeName === "classes" ? prepareClass(record, null, now) : storeName === "students" ? prepareStudent(record, record.classId, null, now) : storeName === "attendance" ? prepareAttendance(record, null, now) : storeName === "assessments" ? prepareAssessment(record, null, now) : storeName === "scores" ? prepareScore(record, null, now) : storeName === "questions" ? prepareQuestion(record, null, now) : storeName === "questionOptions" ? prepareQuestionOption(record, null, now) : storeName === "lessons" ? prepareLesson(record, null, now) : storeName === "classWork" ? prepareClassWork(record, null, now) : storeName === "workSubmissions" ? prepareWorkSubmission(record, null, now) : prepareMaterial(record, null, now); if (ids.has(safe.id)) throw new LocalStorageError("The backup contains duplicate record identifiers."); ids.add(safe.id); if (storeName === "classes") classIds.add(safe.id); return safe; }
export function validateBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalStorageError("Choose a MATEVOK backup file."); if (value.format !== BACKUP_FORMAT) throw new LocalStorageError("This file is not a MATEVOK backup."); if (![LEGACY_BACKUP_VERSION, PREVIOUS_BACKUP_VERSION, BACKUP_VERSION].includes(value.backupVersion)) throw new LocalStorageError("This backup format is not supported by this version of MATEVOK.");
  if (!value.data || typeof value.data !== "object" || !Array.isArray(value.data.classes) || !Array.isArray(value.data.students) || BACKUP_STORES.slice(2).some((name) => value.data[name] != null && !Array.isArray(value.data[name])) || value.data.classes.length > 10000 || value.data.students.length > 100000 || (value.data.attendance?.length || 0) > 500000 || (value.data.assessments?.length || 0) > 100000 || (value.data.scores?.length || 0) > 1000000 || (value.data.questions?.length || 0) > 1000000 || (value.data.questionOptions?.length || 0) > 4000000 || (value.data.lessons?.length || 0) > 100000 || (value.data.materials?.length || 0) > 100000 || (value.data.classWork?.length || 0) > 100000 || (value.data.workSubmissions?.length || 0) > 5000000) throw new LocalStorageError("The backup has an unsupported data shape.");
  if (value.backupVersion === PREVIOUS_BACKUP_VERSION && PREVIOUS_BACKUP_STORES.some((name) => !Array.isArray(value.data[name]))) throw new LocalStorageError("The backup has an unsupported data shape.");
  const ids = new Set(), classIds = new Set(); const classes = value.data.classes.map((entry) => validateBackupRecord("classes", entry, ids, classIds)); const students = value.data.students.map((entry) => validateBackupRecord("students", entry, ids, classIds)); const attendance = (value.data.attendance || []).map((entry) => validateBackupRecord("attendance", entry, ids, classIds)); const assessments = (value.data.assessments || []).map((entry) => validateBackupRecord("assessments", entry, ids, classIds)); const scores = (value.data.scores || []).map((entry) => validateBackupRecord("scores", entry, ids, classIds)); const questions = (value.data.questions || []).map((entry) => validateBackupRecord("questions", entry, ids, classIds)); const questionOptions = (value.data.questionOptions || []).map((entry) => validateBackupRecord("questionOptions", entry, ids, classIds)); const lessons = (value.data.lessons || []).map((entry) => validateBackupRecord("lessons", entry, ids, classIds)); const materials = (value.data.materials || []).map((entry) => validateBackupRecord("materials", entry, ids, classIds)); const classWork = (value.data.classWork || []).map((entry) => validateBackupRecord("classWork", entry, ids, classIds)); const workSubmissions = (value.data.workSubmissions || []).map((entry) => validateBackupRecord("workSubmissions", entry, ids, classIds));
  const studentsById = new Map(students.map((student) => [student.id, student])); const assessmentsById = new Map(assessments.map((assessment) => [assessment.id, assessment])); const classWorkById = new Map(classWork.map((item) => [item.id, item])); const questionsById = new Map(questions.map((question) => [question.id, question])); if (students.some((entry) => !classIds.has(entry.classId))) throw new LocalStorageError("The backup includes a student without a matching class."); if (attendance.some((entry) => !classIds.has(entry.classId) || !studentsById.has(entry.studentId) || studentsById.get(entry.studentId).classId !== entry.classId)) throw new LocalStorageError("The backup includes attendance without matching class and student records."); if (assessments.some((entry) => !classIds.has(entry.classId))) throw new LocalStorageError("The backup includes an assessment without a matching class."); if (scores.some((entry) => !assessmentsById.has(entry.assessmentId) || !studentsById.has(entry.studentId) || assessmentsById.get(entry.assessmentId).classId !== entry.classId || studentsById.get(entry.studentId).classId !== entry.classId || compareDecimal(entry.rawScore, assessmentsById.get(entry.assessmentId).maximumScore) > 0)) throw new LocalStorageError("The backup includes scores without matching class, assessment, student, or maximum score."); if (questions.some((entry) => !assessmentsById.has(entry.assessmentId) || assessmentsById.get(entry.assessmentId).classId !== entry.classId)) throw new LocalStorageError("The backup includes a question without a matching assessment and class."); if (questionOptions.some((entry) => !questionsById.has(entry.questionId) || questionsById.get(entry.questionId).assessmentId !== entry.assessmentId || questionsById.get(entry.questionId).classId !== entry.classId)) throw new LocalStorageError("The backup includes an answer choice without a matching question."); if (lessons.some((entry) => !classIds.has(entry.classId))) throw new LocalStorageError("The backup includes a lesson without a matching class."); if (classWork.some((item) => !classIds.has(item.classId) || (item.assessmentId && (!assessmentsById.has(item.assessmentId) || assessmentsById.get(item.assessmentId).classId !== item.classId)))) throw new LocalStorageError("The backup includes class work without a matching class or same-class assessment."); if (workSubmissions.some((entry) => !classWorkById.has(entry.workItemId) || !studentsById.has(entry.studentId) || classWorkById.get(entry.workItemId).classId !== entry.classId || studentsById.get(entry.studentId).classId !== entry.classId)) throw new LocalStorageError("The backup includes a submission status without matching class work, class, and student records.");
  const attendanceKeys = new Set(); attendance.forEach((entry) => { const key = `${entry.classId}::${entry.date}::${entry.studentId}`; if (attendanceKeys.has(key)) throw new LocalStorageError("The backup includes duplicate attendance statuses for one student and date."); attendanceKeys.add(key); }); const scoreKeys = new Set(); scores.forEach((entry) => { const key = `${entry.assessmentId}::${entry.studentId}`; if (scoreKeys.has(key)) throw new LocalStorageError("The backup includes duplicate scores for one student and assessment."); scoreKeys.add(key); }); const positions = new Set(); questions.forEach((entry) => { const key = `${entry.assessmentId}::${entry.position}`; if (positions.has(key)) throw new LocalStorageError("The backup includes duplicate question positions."); positions.add(key); }); const optionsByQuestion = new Map(); questionOptions.forEach((option) => { const entries = optionsByQuestion.get(option.questionId) || []; entries.push(option); optionsByQuestion.set(option.questionId, entries); }); questions.filter((question) => assessmentsById.get(question.assessmentId)?.authoringStatus === "ready").forEach((question) => validateQuestionReady({ ...question, options: optionsByQuestion.get(question.id) || [] }));
  const workStatusKeys = new Set(); workSubmissions.forEach((entry) => { const key = `${entry.workItemId}::${entry.studentId}`; if (workStatusKeys.has(key)) throw new LocalStorageError("The backup contains duplicate submission statuses for one student and work item."); workStatusKeys.add(key); });
  if (value.backupVersion === BACKUP_VERSION && BACKUP_STORES.some((name) => !Array.isArray(value.data[name]))) throw new LocalStorageError("The backup has an unsupported data shape.");
  return { format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, exportedAt: normalizeText(value.exportedAt, 40), data: { classes, students, attendance, assessments, scores, questions, questionOptions, lessons, materials, classWork, workSubmissions } };
}
export async function createBackup(indexedDb = globalThis.indexedDB) { return withDatabase(async (db) => { const tx = db.transaction(BACKUP_STORES, "readonly"); const collections = await Promise.all(BACKUP_STORES.map((name) => result(tx.objectStore(name).getAll()))); const data = Object.fromEntries(BACKUP_STORES.map((name, index) => [name, collections[index] || []])); return { format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, exportedAt: new Date().toISOString(), appSchemaVersion: LOCAL_SCHEMA_VERSION, data }; }, indexedDb); }
/** Replacement only. The UI must give a summary and deliberate confirmation first. */
export async function replaceWithBackup(backup, indexedDb = globalThis.indexedDB) {
  const safe = validateBackup(backup);
  return withDatabase(async (db) => {
    const tx = writeTransaction(db, BACKUP_STORES);
    try {
      for (const name of BACKUP_STORES) {
        const store = tx.objectStore(name);
        store.clear();
        safe.data[name].forEach((entry) => store.put(entry));
      }
      await done(tx);
      return { classCount: safe.data.classes.length, studentCount: safe.data.students.length, attendanceCount: safe.data.attendance.length, assessmentCount: safe.data.assessments.length, scoreCount: safe.data.scores.length, questionCount: safe.data.questions.length, optionCount: safe.data.questionOptions.length, lessonCount: safe.data.lessons.length, materialCount: safe.data.materials.length, classWorkCount: safe.data.classWork.length, workSubmissionCount: safe.data.workSubmissions.length };
    } catch (error) {
      try { tx.abort(); } catch { /* The transaction may already have committed or aborted. */ }
      throw error;
    }
  }, indexedDb);
}
