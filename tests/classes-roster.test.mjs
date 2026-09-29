import assert from "node:assert/strict";
import test from "node:test";
import { GENERIC_RAW_POLICY, genericRawPercentage, normalizeDecimalInput, scoreDisplay, validateScoreInput } from "../dist/gradebook.js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  LOCAL_SCHEMA_VERSION,
  attendanceCounts,
  createBackup,
  deleteAssessmentPermanently,
  deleteQuestionPermanently,
  deleteLessonPermanently,
  deleteClassPermanently,
  getAllRecords,
  listClasses,
  listAssessments,
  listAttendanceForDate,
  listAttendanceHistory,
  listLessons,
  listScores,
  listStudents,
  prepareClass,
  prepareAssessment,
  prepareScore,
  prepareStudent,
  prepareLesson,
  replaceWithBackup,
  reviewRoster,
  saveAttendance,
  saveAuthoredQuestion,
  saveAssessment,
  saveClass,
  saveLesson,
  saveScores,
  saveStudent,
  saveStudents,
  setClassArchived,
  setStudentArchived,
  syncAssessmentMaximumToQuestionTotal,
  questionTotalPoints,
  listQuestions,
  copyAuthoredAssessmentToClass,
  copyLessonToClass,
  duplicateAuthoredAssessment,
  duplicateLesson,
  updateAssessmentAuthoringStatus,
  moveQuestion,
  validateBackup
} from "../dist/storage.js";

class MemoryStore {
  constructor(name) { this.name = name; this.records = new Map(); this.indexes = []; this.indexNames = { contains: (value) => this.indexes.some((index) => index.name === value) }; }
  createIndex(name, keyPath, options) { this.indexes.push({ name, keyPath, options }); }
  put(value) { this.records.set(value.id ?? value.key, structuredClone(value)); }
  get(key) { return request(this.records.get(key)); }
  getAll() { return request([...this.records.values()].map((value) => structuredClone(value))); }
  getAllKeys() { return request([...this.records.keys()]); }
  delete(key) { this.records.delete(key); }
}
class MemoryTransaction {
  constructor(db) { this.db = db; this._complete = null; }
  objectStore(name) { return this.db.stores.get(name); }
  abort() { this._aborted = true; }
  set oncomplete(callback) { this._complete = callback; queueMicrotask(() => { if (!this._aborted) callback?.(); }); }
  set onerror(callback) { this._error = callback; }
  set onabort(callback) { this._abort = callback; }
}
class MemoryDatabase {
  constructor() { this.version = 0; this.stores = new Map(); this.objectStoreNames = { contains: (name) => this.stores.has(name) }; }
  createObjectStore(name) { const store = new MemoryStore(name); this.stores.set(name, store); return store; }
  transaction() { return new MemoryTransaction(this); }
  close() { this.closed = true; }
}
class MemoryIndexedDb {
  constructor() { this.db = new MemoryDatabase(); }
  open(name, version) {
    const requestObject = { result: this.db, oldVersion: this.db.version, transaction: new MemoryTransaction(this.db) };
    queueMicrotask(() => {
      if (this.db.version < version) { requestObject.onupgradeneeded?.(); this.db.version = version; }
      requestObject.onsuccess?.();
    });
    return requestObject;
  }
}
function request(value) { const valueRequest = {}; queueMicrotask(() => { valueRequest.result = value; valueRequest.onsuccess?.(); }); return valueRequest; }

test("class and student records keep stable opaque IDs through edits and archiving", async () => {
  const idb = new MemoryIndexedDb();
  const created = await saveClass({ className: "  Grade 7 – Mabini  ", subject: "Science" }, null, idb);
  const student = await saveStudent({ fullName: "  Juan   Dela Cruz " }, created.id, null, idb);
  const edited = await saveClass({ className: "Grade 7 – Mabini", subject: "Integrated Science" }, created.id, idb);
  const editedStudent = await saveStudent({ fullName: "Juan Dela Cruz, Jr." }, created.id, student.id, idb);
  assert.equal(created.id, edited.id);
  assert.equal(student.id, editedStudent.id);
  assert.equal(edited.className, "Grade 7 – Mabini");
  assert.equal(editedStudent.fullName, "Juan Dela Cruz, Jr.");
  await setClassArchived(created.id, true, idb);
  assert.equal((await listClasses({ archived: true }, idb))[0].id, created.id);
  await setClassArchived(created.id, false, idb);
  await setStudentArchived(student.id, true, idb);
  assert.equal((await listStudents(created.id, { archived: true }, idb))[0].id, student.id);
  await setStudentArchived(student.id, false, idb);
  assert.equal((await listStudents(created.id, {}, idb))[0].id, student.id);
});

test("bulk roster review normalizes harmless formatting and warns about repeats without blocking legitimate names", () => {
  const existing = [prepareStudent({ id: "student-existing", fullName: "Maria Santos" }, "class-1")];
  const review = reviewRoster("\r\n Juan Dela Cruz \r\n\r\nMaria   Santos\nMaria Santos\n", existing);
  assert.deepEqual(review.map(({ fullName, duplicate }) => [fullName, duplicate]), [["Juan Dela Cruz", false], ["Maria Santos", true], ["Maria Santos", true]]);
  assert.notEqual(prepareStudent({ fullName: "Maria Santos" }, "class-1").id, prepareStudent({ fullName: "Maria Santos" }, "class-1").id);
});

test("permanent class deletion only cleans up records related to that class", async () => {
  const idb = new MemoryIndexedDb();
  const a = await saveClass({ className: "Class A" }, null, idb);
  const b = await saveClass({ className: "Class B" }, null, idb);
  await saveStudents([{ fullName: "A Student" }, { fullName: "Another A Student" }], a.id, idb);
  await saveStudent({ fullName: "B Student" }, b.id, null, idb);
  await deleteClassPermanently(a.id, idb);
  assert.deepEqual((await listClasses({}, idb)).map((entry) => entry.id), [b.id]);
  assert.equal((await listStudents(a.id, {}, idb)).length, 0);
  assert.equal((await listStudents(b.id, {}, idb)).length, 1);
});

test("backup round trip preserves IDs and hostile-looking text as ordinary data", async () => {
  const source = new MemoryIndexedDb();
  const classroom = await saveClass({ className: "<Grade 8> & \"A\"", notes: "<img src=x onerror=alert(1)>" }, null, source);
  const student = await saveStudent({ fullName: "<script>not code</script> & 'Student'" }, classroom.id, null, source);
  const backup = await createBackup(source);
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.backupVersion, BACKUP_VERSION);
  const restored = new MemoryIndexedDb();
  const output = await replaceWithBackup(JSON.parse(JSON.stringify(backup)), restored);
  assert.deepEqual(output, { classCount: 1, studentCount: 1, attendanceCount: 0, assessmentCount: 0, scoreCount: 0, questionCount: 0, optionCount: 0, lessonCount: 0 });
  const classes = await getAllRecords("classes", restored);
  const students = await getAllRecords("students", restored);
  assert.equal(classes[0].id, classroom.id);
  assert.equal(classes[0].className, "<Grade 8> & \"A\"");
  assert.equal(students[0].id, student.id);
  assert.equal(students[0].fullName, "<script>not code</script> & 'Student'");
  assert.equal(students[0].classId, classroom.id);
});

test("backup validation rejects malformed, unsupported, duplicate, and orphaned records safely", () => {
  assert.throws(() => validateBackup({}), /not a MATEVOK backup/);
  assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: 9, data: { classes: [], students: [] } }), /not supported/);
  const classRecord = prepareClass({ id: "class-1", className: "One" });
  const duplicate = { format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: [classRecord], students: [{ ...prepareStudent({ id: "class-1", fullName: "One" }, "class-1") }] } };
  assert.throws(() => validateBackup(duplicate), /duplicate record identifiers/);
  const orphan = { format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: [], students: [prepareStudent({ id: "student-1", fullName: "One" }, "missing-class")] } };
  assert.throws(() => validateBackup(orphan), /without a matching class/);
});

test("schema version remains migration-compatible and class store receives archive support", async () => {
  const idb = new MemoryIndexedDb();
  await saveClass({ className: "Migration check" }, null, idb);
  assert.equal(idb.db.version, LOCAL_SCHEMA_VERSION);
  assert.equal(idb.db.stores.get("classes").indexNames.contains("archivedAt"), true);
});

test("class list and roster operations remain practical with realistic and larger synthetic rosters", async () => {
  const idb = new MemoryIndexedDb();
  const classes = [];
  for (let classNumber = 0; classNumber < 6; classNumber += 1) {
    const classroom = await saveClass({ className: `Class ${String(classNumber + 1).padStart(2, "0")}` }, null, idb);
    classes.push(classroom);
    await saveStudents(Array.from({ length: 60 }, (_, index) => ({ fullName: `Student ${classNumber}-${String(index).padStart(2, "0")}` })), classroom.id, idb);
  }
  const started = performance.now();
  const listed = await listClasses({}, idb);
  const roster = await listStudents(classes[0].id, {}, idb);
  const elapsed = performance.now() - started;
  assert.equal(listed.length, 6);
  assert.deepEqual(listed.map((entry) => entry.studentCount), [60, 60, 60, 60, 60, 60]);
  assert.equal(roster.length, 60);
  assert.ok(elapsed < 500, `synthetic list operations took ${elapsed}ms`);
});

test("attendance is normalized to IDs, defaults to present, and reopens one class/date session", async () => {
  const idb = new MemoryIndexedDb();
  const classroom = await saveClass({ className: "Attendance class" }, null, idb);
  const [first, second] = await saveStudents([{ fullName: "Ada Lovelace" }, { fullName: "Grace Hopper" }], classroom.id, idb);
  const firstSave = await saveAttendance(classroom.id, "2026-09-28", [{ studentId: first.id, status: "present" }, { studentId: second.id, status: "late" }], idb);
  const revised = await saveAttendance(classroom.id, "2026-09-28", [{ studentId: first.id, status: "absent" }, { studentId: second.id, status: "late" }], idb);
  assert.equal(firstSave.length, 2);
  assert.equal(revised[0].classId, classroom.id);
  assert.equal("fullName" in revised[0], false);
  const saved = await listAttendanceForDate(classroom.id, "2026-09-28", idb);
  assert.equal(saved.length, 2);
  assert.equal(saved.find((entry) => entry.studentId === first.id).status, "absent");
  assert.deepEqual(attendanceCounts(saved), { present: 0, absent: 1, late: 1, excused: 0 });
  const history = await listAttendanceHistory(classroom.id, idb);
  assert.equal(history.length, 1);
  assert.equal(history[0].date, "2026-09-28");
});

test("attendance validates dates, statuses, class boundaries, archives safely, and is removed with its class", async () => {
  const idb = new MemoryIndexedDb();
  const a = await saveClass({ className: "A" }, null, idb);
  const b = await saveClass({ className: "B" }, null, idb);
  const studentA = await saveStudent({ fullName: "Student A" }, a.id, null, idb);
  const studentB = await saveStudent({ fullName: "Student B" }, b.id, null, idb);
  await assert.rejects(() => saveAttendance(a.id, "2026-02-30", [{ studentId: studentA.id, status: "present" }], idb), /valid attendance date/);
  await assert.rejects(() => saveAttendance(a.id, "2026-09-28", [{ studentId: studentA.id, status: "away" }], idb), /Present, Absent/);
  await assert.rejects(() => saveAttendance(a.id, "2026-09-28", [{ studentId: studentB.id, status: "present" }], idb), /outside this class/);
  await assert.rejects(() => saveAttendance(a.id, "2026-09-28", [{ studentId: studentA.id, status: "present" }, { studentId: studentA.id, status: "late" }], idb), /only one attendance status/);
  await saveAttendance(a.id, "2026-09-28", [{ studentId: studentA.id, status: "excused" }], idb);
  await saveAttendance(b.id, "2026-09-28", [{ studentId: studentB.id, status: "present" }], idb);
  await setStudentArchived(studentA.id, true, idb);
  assert.equal((await listAttendanceForDate(a.id, "2026-09-28", idb)).length, 1);
  await setClassArchived(a.id, true, idb);
  assert.equal((await listAttendanceHistory(a.id, idb)).length, 1);
  await deleteClassPermanently(a.id, idb);
  assert.equal((await getAllRecords("attendance", idb)).length, 1);
  assert.equal((await listAttendanceForDate(b.id, "2026-09-28", idb)).length, 1);
});

test("attendance backup round-trips and legacy Phase 2 backups without attendance remain valid", async () => {
  const source = new MemoryIndexedDb();
  const classroom = await saveClass({ className: "Backup attendance" }, null, source);
  const student = await saveStudent({ fullName: "Student" }, classroom.id, null, source);
  await saveAttendance(classroom.id, "2026-09-28", [{ studentId: student.id, status: "present" }], source);
  const backup = await createBackup(source);
  assert.equal(backup.data.attendance.length, 1);
  const restored = new MemoryIndexedDb();
  const output = await replaceWithBackup(backup, restored);
  assert.equal(output.attendanceCount, 1);
  assert.equal((await listAttendanceForDate(classroom.id, "2026-09-28", restored))[0].studentId, student.id);
  const legacy = validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students } });
  assert.deepEqual(legacy.data.attendance, []);
  assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, attendance: [{ id: "bad", classId: classroom.id, studentId: "missing", date: "2026-09-28", status: "present" }] } }), /attendance without matching/);
  const duplicateAttendance = backup.data.attendance.map((entry, index) => ({ ...entry, id: `${entry.id}-${index}` })); duplicateAttendance.push({ ...backup.data.attendance[0], id: "attendance-extra" });
  assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, attendance: duplicateAttendance } }), /duplicate attendance statuses/);
});

test("generic gradebook keeps normalized assessment and score relationships, including zero and missing scores", async () => {
  const idb = new MemoryIndexedDb(); const classroom = await saveClass({ className: "Gradebook class" }, null, idb); const [zero, decimal, missing] = await saveStudents([{ fullName: "Zero" }, { fullName: "Decimal" }, { fullName: "Missing" }], classroom.id, idb);
  const assessment = await saveAssessment({ title: "Quiz <1> & \"A\"", date: "2026-09-28", maximumScore: "20.000", category: "Quiz", term: "Period A" }, classroom.id, null, idb);
  assert.equal(assessment.maximumScore, "20"); assert.equal(assessment.policyId, GENERIC_RAW_POLICY.id);
  await saveScores(assessment.id, [{ studentId: zero.id, rawScore: "0" }, { studentId: decimal.id, rawScore: "18.5" }, { studentId: missing.id, rawScore: "" }], idb);
  const scores = await listScores(assessment.id, idb); assert.equal(scores.length, 2); assert.equal(scores.find((score) => score.studentId === zero.id).rawScore, "0"); assert.equal(scores.some((score) => score.studentId === missing.id), false); assert.equal(scores[0].classId, classroom.id); assert.equal("fullName" in scores[0], false);
  const listed = await listAssessments(classroom.id, idb); assert.equal(listed[0].scoreCount, 2); assert.equal(listed[0].title, "Quiz <1> & \"A\"");
  await saveScores(assessment.id, [{ studentId: decimal.id, rawScore: "19" }, { studentId: zero.id, rawScore: "" }], idb);
  const revised = await listScores(assessment.id, idb); assert.equal(revised.length, 1); assert.equal(revised[0].rawScore, "19");
});

test("gradebook validates exact decimal scores, maximum changes, archive history, and scoped deletion", async () => {
  const idb = new MemoryIndexedDb(); const a = await saveClass({ className: "A" }, null, idb); const b = await saveClass({ className: "B" }, null, idb); const studentA = await saveStudent({ fullName: "A student" }, a.id, null, idb); const studentB = await saveStudent({ fullName: "B student" }, b.id, null, idb);
  await assert.rejects(() => saveAssessment({ title: "Bad", date: "2026-09-28", maximumScore: "0" }, a.id, null, idb), /greater than zero/);
  const assessmentA = await saveAssessment({ title: "Same name", date: "2026-09-28", maximumScore: "10" }, a.id, null, idb); const assessmentB = await saveAssessment({ title: "Same name", date: "2026-09-28", maximumScore: "10" }, b.id, null, idb);
  await assert.rejects(() => saveScores(assessmentA.id, [{ studentId: studentA.id, rawScore: "10.001" }], idb), /greater than the maximum/);
  await assert.rejects(() => saveScores(assessmentA.id, [{ studentId: studentA.id, rawScore: "-1" }], idb), /cannot be negative/);
  await assert.rejects(() => saveScores(assessmentA.id, [{ studentId: studentB.id, rawScore: "5" }], idb), /outside this assessment/);
  await assert.rejects(() => saveScores(assessmentA.id, [{ studentId: studentA.id, rawScore: "3" }, { studentId: studentA.id, rawScore: "4" }], idb), /only one score/);
  await saveScores(assessmentA.id, [{ studentId: studentA.id, rawScore: "10" }], idb); await saveScores(assessmentB.id, [{ studentId: studentB.id, rawScore: "5" }], idb);
  await setStudentArchived(studentA.id, true, idb); assert.equal((await listScores(assessmentA.id, idb)).length, 1); await setStudentArchived(studentA.id, false, idb); assert.equal((await listStudents(a.id, {}, idb)).length, 1);
  const lowered = await saveAssessment({ title: "Same name", date: "2026-09-28", maximumScore: "8" }, a.id, assessmentA.id, idb); assert.equal(lowered.maximumScore, "8"); assert.equal((await listScores(assessmentA.id, idb))[0].rawScore, "10");
  await deleteAssessmentPermanently(assessmentA.id, idb); assert.equal((await listScores(assessmentA.id, idb)).length, 0); assert.equal((await listScores(assessmentB.id, idb)).length, 1);
  await deleteClassPermanently(b.id, idb); assert.equal((await getAllRecords("assessments", idb)).length, 0); assert.equal((await getAllRecords("scores", idb)).length, 0);
});

test("generic percentage arithmetic is explicit, deterministic, and policy-safe", () => {
  assert.equal(normalizeDecimalInput("000.500"), "0.5"); assert.equal(genericRawPercentage("18", "20").display, "90%"); assert.equal(genericRawPercentage("1", "6").display, "16.67%"); assert.equal(genericRawPercentage("1", "800").display, "0.13%"); assert.equal(genericRawPercentage("2.675", "10").display, "26.75%"); assert.equal(genericRawPercentage("0.3", "1").display, "30%"); assert.equal(genericRawPercentage("0", "20").display, "0%"); assert.equal(scoreDisplay("", "20").label, "Not entered");
  assert.throws(() => genericRawPercentage("1.0001", "10"), /three decimal/); assert.throws(() => genericRawPercentage("11", "10"), /greater than/); assert.equal(GENERIC_RAW_POLICY.official, false);
});

test("score-entry validation accepts blanks, zero, decimals, and maximum scores without treating them alike", () => {
  assert.deepEqual(validateScoreInput("", "10"), { entered: false, rawScore: "", error: null });
  assert.deepEqual(validateScoreInput("0", "10"), { entered: true, rawScore: "0", error: null });
  assert.deepEqual(validateScoreInput("8.500", "10"), { entered: true, rawScore: "8.5", error: null });
  assert.deepEqual(validateScoreInput("10", "10"), { entered: true, rawScore: "10", error: null });
  assert.match(validateScoreInput("10.001", "10").error, /greater than/);
  assert.match(validateScoreInput("not a score", "10").error, /number/);
});

test("gradebook backup restores exact score strings and accepts earlier backups without gradebook stores", async () => {
  const source = new MemoryIndexedDb(); const classroom = await saveClass({ className: "Backup <class>" }, null, source); const student = await saveStudent({ fullName: "Score & student" }, classroom.id, null, source); const assessment = await saveAssessment({ title: "Test <script>", date: "2026-09-28", maximumScore: "25" }, classroom.id, null, source); await saveScores(assessment.id, [{ studentId: student.id, rawScore: "12.345" }], source);
  const backup = await createBackup(source); assert.equal(backup.data.assessments.length, 1); assert.equal(backup.data.scores[0].rawScore, "12.345"); const restored = new MemoryIndexedDb(); const result = await replaceWithBackup(backup, restored); assert.equal(result.scoreCount, 1); assert.equal((await listScores(assessment.id, restored))[0].rawScore, "12.345");
  const legacy = validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, attendance: [] } }); assert.deepEqual(legacy.data.assessments, []); assert.deepEqual(legacy.data.scores, []);
  const wrongPolicy = { ...backup.data.assessments[0], id: "assessment-policy", policyId: "unverified-policy" }; assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, attendance: [], assessments: [wrongPolicy], scores: [] } }), /policy is not available/);
  const impossible = { ...backup.data.scores[0], id: "score-impossible", rawScore: "26" }; assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, attendance: [], assessments: backup.data.assessments, scores: [impossible] } }), /maximum score/);
});

test("larger generic gradebook operations stay practical for 60 students and 40 assessments", async () => {
  const idb = new MemoryIndexedDb(); const classroom = await saveClass({ className: "Performance" }, null, idb); const students = await saveStudents(Array.from({ length: 60 }, (_, index) => ({ fullName: `Student ${String(index + 1).padStart(2, "0")}` })), classroom.id, idb); const started = performance.now();
  for (let index = 0; index < 40; index += 1) { const assessment = await saveAssessment({ title: `Quiz ${index + 1}`, date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`, maximumScore: "20" }, classroom.id, null, idb); await saveScores(assessment.id, students.map((student, studentIndex) => ({ studentId: student.id, rawScore: String(studentIndex % 21) })), idb); }
  const assessments = await listAssessments(classroom.id, idb); const scores = await listScores(assessments[0].id, idb); const elapsed = performance.now() - started; assert.equal(assessments.length, 40); assert.equal(scores.length, 60); assert.ok(elapsed < 1500, `synthetic gradebook operations took ${elapsed}ms`);
});

test("Assessment Center keeps authored questions normalized, ready-safe, duplicable, and backup-safe", async () => {
  const idb = new MemoryIndexedDb(); const classroom = await saveClass({ className: "Assessment Center" }, null, idb); const student = await saveStudent({ fullName: "Student" }, classroom.id, null, idb); const assessment = await saveAssessment({ title: "Original quiz", date: "2026-09-28", maximumScore: "25", assessmentKind: "quiz", instructions: "Use your own words.", showPoints: true }, classroom.id, null, idb);
  const partialDraft = await saveAuthoredQuestion({ questionType: "essay", prompt: "", points: "", guidance: "" }, assessment.id, null, idb); assert.equal(partialDraft.points, "0"); await assert.rejects(() => updateAssessmentAuthoringStatus(assessment.id, "ready", idb), /prompt and points/); await deleteQuestionPermanently(partialDraft.id, idb);
  const multipleChoice = await saveAuthoredQuestion({ questionType: "multiple-choice", prompt: "Which value is prime?", points: "1.5", options: [{ text: "4", correct: false }, { text: "5", correct: true }, { text: "6", correct: false }] }, assessment.id, null, idb);
  const shortAnswer = await saveAuthoredQuestion({ questionType: "short-answer", prompt: "Explain your reasoning.", points: "2.25", referenceAnswer: "A teacher reference only." }, assessment.id, null, idb);
  assert.equal(multipleChoice.options.length, 3); assert.ok(multipleChoice.correctOptionId); assert.equal(questionTotalPoints(await listQuestions(assessment.id, idb)), "3.75");
  await moveQuestion(shortAnswer.id, "up", idb); assert.equal((await listQuestions(assessment.id, idb))[0].id, shortAnswer.id);
  await updateAssessmentAuthoringStatus(assessment.id, "ready", idb);
  const changed = await syncAssessmentMaximumToQuestionTotal(assessment.id, {}, idb); assert.equal(changed.assessment.maximumScore, "3.75");
  await saveScores(assessment.id, [{ studentId: student.id, rawScore: "3" }], idb);
  await saveAuthoredQuestion({ ...shortAnswer, points: "3", options: [] }, assessment.id, shortAnswer.id, idb);
  const confirmation = await syncAssessmentMaximumToQuestionTotal(assessment.id, {}, idb); assert.equal(confirmation.needsConfirmation, true); assert.equal((await listScores(assessment.id, idb))[0].rawScore, "3");
  const copied = await duplicateAuthoredAssessment(assessment.id, idb); const copiedQuestions = await listQuestions(copied.id, idb); assert.equal(copied.authoringStatus, "draft"); assert.equal(copiedQuestions.length, 2); assert.notEqual(copiedQuestions[0].id, (await listQuestions(assessment.id, idb))[0].id); assert.equal((await listScores(copied.id, idb)).length, 0);
  const backup = await createBackup(idb); assert.equal(backup.data.questions.length, 4); assert.equal(backup.data.questionOptions.length, 6); const restored = new MemoryIndexedDb(); const result = await replaceWithBackup(backup, restored); assert.equal(result.assessmentCount, 2); assert.equal((await listQuestions(assessment.id, restored)).length, 2);
  await deleteAssessmentPermanently(assessment.id, idb); assert.equal((await listQuestions(assessment.id, idb)).length, 0); assert.equal((await listQuestions(copied.id, idb)).length, 2);
});

test("cross-class copies create independent Draft lessons and authored assessments without classroom history", async () => {
  const idb = new MemoryIndexedDb(); const source = await saveClass({ className: "Source <class>" }, null, idb); const target = await saveClass({ className: "Target & class" }, null, idb); const archived = await saveClass({ className: "Archived target" }, null, idb);
  const sourceStudent = await saveStudent({ fullName: "Source student" }, source.id, null, idb); const targetStudent = await saveStudent({ fullName: "Target student" }, target.id, null, idb);
  const assessment = await saveAssessment({ title: "Quiz <script>", date: "2026-09-28", maximumScore: "5", assessmentKind: "worksheet", instructions: "Read <carefully>", showPoints: true }, source.id, null, idb);
  const choice = await saveAuthoredQuestion({ questionType: "multiple-choice", prompt: "Choose <one>", points: "2", options: [{ text: "A & B", correct: false }, { text: "C", correct: true }] }, assessment.id, null, idb);
  const short = await saveAuthoredQuestion({ questionType: "short-answer", prompt: "Explain why", points: "3", referenceAnswer: "Because evidence." }, assessment.id, null, idb);
  await updateAssessmentAuthoringStatus(assessment.id, "ready", idb); await saveScores(assessment.id, [{ studentId: sourceStudent.id, rawScore: "0" }], idb);
  const lesson = await saveLesson({ title: "<Lesson & plan>", date: "2026-09-28", status: "ready", learningGoals: "Use evidence.", during: "Discuss <claims>", notes: "Private & local" }, source.id, null, idb);
  await setClassArchived(archived.id, true, idb);
  await assert.rejects(() => copyAuthoredAssessmentToClass(assessment.id, source.id, idb), /another class/);
  await assert.rejects(() => copyLessonToClass(lesson.id, archived.id, idb), /Restore the destination class/);

  const assessmentCopy = await copyAuthoredAssessmentToClass(assessment.id, target.id, idb); const copiedQuestions = await listQuestions(assessmentCopy.id, idb); const sourceQuestions = await listQuestions(assessment.id, idb);
  assert.notEqual(assessmentCopy.id, assessment.id); assert.equal(assessmentCopy.classId, target.id); assert.equal(assessmentCopy.authoringStatus, "draft"); assert.equal((await listScores(assessmentCopy.id, idb)).length, 0); assert.equal(copiedQuestions.length, 2);
  assert.notEqual(copiedQuestions[0].id, sourceQuestions[0].id); assert.equal(copiedQuestions.find((question) => question.questionType === "short-answer").referenceAnswer, "Because evidence.");
  const copiedChoice = copiedQuestions.find((question) => question.questionType === "multiple-choice"); assert.equal(copiedChoice.options.length, 2); assert.ok(copiedChoice.options.some((option) => option.id === copiedChoice.correctOptionId && option.text === "C")); assert.ok(copiedChoice.options.every((option) => !choice.options.some((sourceOption) => sourceOption.id === option.id)));
  const lessonCopy = await copyLessonToClass(lesson.id, target.id, idb); assert.notEqual(lessonCopy.id, lesson.id); assert.equal(lessonCopy.classId, target.id); assert.equal(lessonCopy.status, "draft"); assert.equal(lessonCopy.during, lesson.during); assert.equal(lessonCopy.notes, lesson.notes);
  const backup = await createBackup(idb); const restored = new MemoryIndexedDb(); const restoredResult = await replaceWithBackup(backup, restored); assert.equal(restoredResult.assessmentCount, 2); assert.equal(restoredResult.lessonCount, 2); assert.equal((await listScores(assessmentCopy.id, restored)).length, 0); assert.equal((await listQuestions(assessmentCopy.id, restored)).length, 2);
  await deleteAssessmentPermanently(assessment.id, idb); await deleteLessonPermanently(lesson.id, idb); assert.equal((await listQuestions(assessmentCopy.id, idb)).length, 2); assert.equal((await listLessons(target.id, idb)).length, 1);
  await deleteAssessmentPermanently(assessmentCopy.id, idb); await deleteLessonPermanently(lessonCopy.id, idb); assert.equal((await listAssessments(target.id, idb)).length, 0); assert.equal((await listLessons(target.id, idb)).length, 0); assert.equal((await listStudents(target.id, {}, idb))[0].id, targetStudent.id);
  assert.equal((await listClasses({}, restored)).length, 2); assert.equal((await listClasses({ archived: true }, restored)).length, 1);
});

test("Lesson Workspace keeps class-scoped plain-text plans editable, duplicable, backup-safe, and bounded", async () => {
  const source = new MemoryIndexedDb();
  const first = await saveClass({ className: "Lesson class" }, null, source); const second = await saveClass({ className: "Other class" }, null, source);
  const original = await saveLesson({ title: "<script>alert(1)</script> & lesson", date: "2026-09-28", learningGoals: "Compare \"claims\".\nExplain evidence.", priorKnowledge: "Vocabulary", materials: "Paper & pencils", before: "Welcome", during: "Read < > & \" '", checkForUnderstanding: "Exit prompt", assessment: "One sentence", reflection: "Try pairs", nextStep: "Review", notes: "Private note", status: "draft" }, first.id, null, source);
  assert.match(original.id, /^lesson_/); assert.equal(original.during, "Read < > & \" '"); assert.equal(original.learningGoals.includes("\n"), true);
  const edited = await saveLesson({ ...original, title: "Edited lesson", status: "ready" }, first.id, original.id, source);
  assert.equal(edited.id, original.id); assert.equal(edited.status, "ready"); assert.equal((await listLessons(first.id, source))[0].title, "Edited lesson");
  await assert.rejects(() => saveLesson({ title: "No goal", status: "ready" }, first.id, null, source), /learning goal/);
  await assert.rejects(() => saveLesson({ ...edited, title: "Wrong class" }, second.id, edited.id, source), /another class/);
  await assert.rejects(() => saveLesson({ title: "Too long", learningGoals: "x".repeat(8001) }, first.id, null, source), /too long/);
  const copy = await duplicateLesson(edited.id, source); assert.notEqual(copy.id, edited.id); assert.equal(copy.classId, first.id); assert.equal(copy.status, "draft"); assert.equal(copy.during, edited.during); assert.equal(copy.assessment, edited.assessment);
  const backup = await createBackup(source); assert.equal(backup.data.lessons.length, 2); const restored = new MemoryIndexedDb(); const result = await replaceWithBackup(backup, restored); assert.equal(result.lessonCount, 2); assert.deepEqual((await listLessons(first.id, restored)).map((lesson) => lesson.id).sort(), [edited.id, copy.id].sort());
  const legacy = validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students } }); assert.deepEqual(legacy.data.lessons, []);
  const orphan = prepareLesson({ ...edited, id: "orphan-lesson", classId: "missing-class" }); assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, lessons: [orphan] } }), /lesson without a matching class/);
  await deleteLessonPermanently(copy.id, source); assert.equal((await listLessons(first.id, source)).length, 1); await setClassArchived(first.id, true, source); assert.equal((await listLessons(first.id, source)).length, 1); await setClassArchived(first.id, false, source); assert.equal((await listLessons(first.id, source)).length, 1); await deleteClassPermanently(first.id, source); assert.equal((await getAllRecords("lessons", source)).length, 0);
  const started = performance.now(); for (let index = 0; index < 100; index += 1) await saveLesson({ title: `Plan ${index}`, date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}` }, second.id, null, source); assert.equal((await listLessons(second.id, source)).length, 100); assert.ok(performance.now() - started < 1000, "100 local lesson saves should remain responsive");
});
