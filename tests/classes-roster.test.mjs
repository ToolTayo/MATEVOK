import assert from "node:assert/strict";
import test from "node:test";
import { GENERIC_RAW_POLICY, genericRawPercentage, normalizeDecimalInput, scoreDisplay, validateScoreInput } from "../dist/gradebook.js";
import { deriveStudentProgress } from "../dist/progress.js";
import { deriveAssessmentResults, deriveAttendanceSummary } from "../dist/reports.js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  LEGACY_BACKUP_VERSION,
  LOCAL_SCHEMA_VERSION,
  attendanceCounts,
  copyActiveRosterToEmptyClass,
  createBackup,
  deleteAssessmentPermanently,
  deleteQuestionPermanently,
  deleteLessonPermanently,
  deleteClassPermanently,
  deleteMaterialPermanently,
  getAllRecords,
  listClasses,
  listAssessments,
  listAttendanceRecords,
  listAttendanceForDate,
  listAttendanceHistory,
  listLessons,
  listMaterials,
  listScores,
  listScoresForClass,
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
  materializeMaterialToClass,
  duplicateAuthoredAssessment,
  duplicateLesson,
  updateAssessmentAuthoringStatus,
  moveQuestion,
  validateBackup,
  saveLessonToMaterials,
  saveAssessmentToMaterials
} from "../dist/storage.js";

class MemoryStore {
  constructor(name) { this.name = name; this.records = new Map(); this.indexes = []; this.getAllCalls = 0; this.indexReads = []; this.indexNames = { contains: (value) => this.indexes.some((index) => index.name === value) }; }
  createIndex(name, keyPath, options) { this.indexes.push({ name, keyPath, options }); }
  put(value) { this.records.set(value.id ?? value.key, structuredClone(value)); }
  get(key) { return request(this.records.get(key)); }
  getAll() { this.getAllCalls += 1; return request([...this.records.values()].map((value) => structuredClone(value))); }
  index(name) { const definition = this.indexes.find((item) => item.name === name); if (!definition) throw new Error(`Missing index ${name}`); return { getAll: (key) => { this.indexReads.push({ name, key }); return request([...this.records.values()].filter((record) => record[definition.keyPath] === key).map((value) => structuredClone(value))); } }; }
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
  constructor() { this.version = 0; this.stores = new Map(); this.transactions = []; this.objectStoreNames = { contains: (name) => this.stores.has(name) }; }
  createObjectStore(name) { const store = new MemoryStore(name); this.stores.set(name, store); return store; }
  transaction(names, mode) { this.transactions.push({ names, mode }); return new MemoryTransaction(this); }
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

test("copying a roster creates fresh class-owned records without copying history and uses the classId index", async () => {
  const idb = new MemoryIndexedDb();
  const source = await saveClass({ className: "Science · Section A" }, null, idb);
  const target = await saveClass({ className: "Math · Section A" }, null, idb);
  const sourceStudents = await saveStudents(Array.from({ length: 48 }, (_, index) => ({ fullName: index === 0 ? "<img src=x onerror=alert(1)> Student" : `Student ${String(index + 1).padStart(2, "0")}` })), source.id, idb);
  await setStudentArchived(sourceStudents[47].id, true, idb);
  const activeSource = await listStudents(source.id, {}, idb);
  const assessment = await saveAssessment({ title: "Source-only check", date: "2026-09-29", maximumScore: "10" }, source.id, null, idb);
  await saveScores(assessment.id, [{ studentId: activeSource[0].id, rawScore: "0" }, { studentId: activeSource[1].id, rawScore: "8.5" }], idb);
  await saveAttendance(source.id, "2026-09-29", activeSource.map((student) => ({ studentId: student.id, status: "present" })), idb);
  for (const store of idb.db.stores.values()) { store.getAllCalls = 0; store.indexReads = []; }

  const copied = await copyActiveRosterToEmptyClass(source.id, target.id, idb);
  const targetStudents = await listStudents(target.id, {}, idb);
  assert.equal(copied.length, 47);
  assert.equal(targetStudents.length, 47);
  assert.ok(copied.every((student) => student.classId === target.id && !student.archivedAt));
  assert.equal(new Set(copied.map((student) => student.id)).size, copied.length);
  assert.equal(copied.some((student) => sourceStudents.some((sourceStudent) => sourceStudent.id === student.id)), false);
  assert.deepEqual(targetStudents.map((student) => student.fullName).sort(), activeSource.map((student) => student.fullName).sort());
  assert.ok(targetStudents.some((student) => student.fullName === "<img src=x onerror=alert(1)> Student"), "hostile-looking names remain plain text data");
  assert.equal((await listAttendanceRecords(target.id, idb)).length, 0);
  assert.equal((await listScoresForClass(target.id, idb)).length, 0);
  assert.equal((await listScoresForClass(source.id, idb)).length, 2);
  const studentStore = idb.db.stores.get("students");
  assert.equal(studentStore.getAllCalls, 0, "roster copying must not scan all student records");
  assert.deepEqual(studentStore.indexReads, [{ name: "classId", key: source.id }, { name: "classId", key: target.id }, { name: "classId", key: target.id }]);

  const backup = await createBackup(idb), restored = new MemoryIndexedDb();
  await replaceWithBackup(backup, restored);
  assert.equal((await listStudents(target.id, {}, restored)).length, 47, "existing backup format includes copied students normally");
  await deleteClassPermanently(source.id, idb);
  assert.equal((await listStudents(target.id, {}, idb)).length, 47, "the destination roster is independent of its source class");
});

test("roster copying refuses same, archived or occupied destinations, and empty sources without changing records", async () => {
  const idb = new MemoryIndexedDb();
  const source = await saveClass({ className: "Source" }, null, idb);
  const empty = await saveClass({ className: "Empty" }, null, idb);
  const occupied = await saveClass({ className: "Occupied" }, null, idb);
  const archivedTarget = await saveClass({ className: "Archived target" }, null, idb);
  const archivedRosterTarget = await saveClass({ className: "Archived roster target" }, null, idb);
  await saveStudents([{ fullName: "Source student" }], source.id, idb);
  const existing = await saveStudent({ fullName: "Existing student" }, occupied.id, null, idb);
  const archivedOnly = await saveStudent({ fullName: "Archived target student" }, archivedTarget.id, null, idb);
  await setStudentArchived(archivedOnly.id, true, idb);
  const archivedInActiveClass = await saveStudent({ fullName: "Archived roster student" }, archivedRosterTarget.id, null, idb);
  await setStudentArchived(archivedInActiveClass.id, true, idb);
  await setClassArchived(archivedTarget.id, true, idb);

  await assert.rejects(() => copyActiveRosterToEmptyClass(source.id, source.id, idb), /different class/);
  await assert.rejects(() => copyActiveRosterToEmptyClass(source.id, occupied.id, idb), /already has a student roster/);
  await assert.rejects(() => copyActiveRosterToEmptyClass(source.id, archivedTarget.id, idb), /Restore the destination class/);
  await assert.rejects(() => copyActiveRosterToEmptyClass(source.id, archivedRosterTarget.id, idb), /already has a student roster/);
  await assert.rejects(() => copyActiveRosterToEmptyClass(empty.id, occupied.id, idb), /already has a student roster/);
  const studentless = await saveClass({ className: "Studentless source" }, null, idb);
  await assert.rejects(() => copyActiveRosterToEmptyClass(studentless.id, empty.id, idb), /no active students/);
  assert.deepEqual((await listStudents(occupied.id, {}, idb)).map((student) => student.id), [existing.id]);
  assert.equal((await listStudents(empty.id, {}, idb)).length, 0);
  assert.equal((await listStudents(archivedTarget.id, { archived: true }, idb)).length, 1);
});

test("an archived term class is a read-only source for a fresh independent roster", async () => {
  const idb = new MemoryIndexedDb();
  const source = await saveClass({ className: "Science · Term 1" }, null, idb);
  const target = await saveClass({ className: "Science · Term 2" }, null, idb);
  const students = await saveStudents([{ fullName: "A Student" }, { fullName: "B Student" }, { fullName: "C Student" }], source.id, idb);
  await setStudentArchived(students[2].id, true, idb);
  const activeStudents = await listStudents(source.id, {}, idb);
  const assessment = await saveAssessment({ title: "Term 1 check", date: "2026-09-29", maximumScore: "10" }, source.id, null, idb);
  await saveScores(assessment.id, [{ studentId: activeStudents[0].id, rawScore: "0" }], idb);
  await saveAttendance(source.id, "2026-09-29", activeStudents.map((student) => ({ studentId: student.id, status: "absent" })), idb);
  await setClassArchived(source.id, true, idb);

  const copied = await copyActiveRosterToEmptyClass(source.id, target.id, idb);
  const targetStudents = await listStudents(target.id, {}, idb);
  assert.equal(copied.length, 2);
  assert.deepEqual(targetStudents.map((student) => student.fullName), ["A Student", "B Student"]);
  assert.ok(targetStudents.every((student) => student.classId === target.id));
  assert.ok(targetStudents.every((student) => !students.some((sourceStudent) => sourceStudent.id === student.id)));
  assert.equal((await listAttendanceRecords(target.id, idb)).length, 0);
  assert.equal((await listScoresForClass(target.id, idb)).length, 0);
  assert.equal((await listAttendanceRecords(source.id, idb)).length, 2);
  assert.equal((await listScoresForClass(source.id, idb))[0].rawScore, "0");
  assert.equal((await listClasses({ archived: true }, idb)).some((item) => item.id === source.id), true);
});

test("permanent class deletion only cleans up records related to that class", async () => {
  const idb = new MemoryIndexedDb();
  const a = await saveClass({ className: "Class A" }, null, idb);
  const b = await saveClass({ className: "Class B" }, null, idb);
  const studentsA = await saveStudents([{ fullName: "A Student" }, { fullName: "Another A Student" }], a.id, idb);
  const studentB = await saveStudent({ fullName: "B Student" }, b.id, null, idb);
  const assessmentA = await saveAssessment({ title: "A check", date: "2026-09-29", maximumScore: "10" }, a.id, null, idb);
  const assessmentB = await saveAssessment({ title: "B check", date: "2026-09-29", maximumScore: "10" }, b.id, null, idb);
  await saveScores(assessmentA.id, [{ studentId: studentsA[0].id, rawScore: "0" }], idb);
  await saveScores(assessmentB.id, [{ studentId: studentB.id, rawScore: "8" }], idb);
  await saveAttendance(a.id, "2026-09-29", studentsA.map((student) => ({ studentId: student.id, status: "present" })), idb);
  await saveAttendance(b.id, "2026-09-29", [{ studentId: studentB.id, status: "late" }], idb);
  await saveLesson({ title: "A lesson", learningGoal: "Practice" }, a.id, null, idb);
  await saveLesson({ title: "B lesson", learningGoal: "Review" }, b.id, null, idb);
  await saveAuthoredQuestion({ questionType: "multiple-choice", prompt: "A question", points: "1", options: [{ text: "A1" }, { text: "A2" }] }, assessmentA.id, null, idb);
  for (const store of idb.db.stores.values()) { store.getAllCalls = 0; store.indexReads = []; }
  await deleteClassPermanently(a.id, idb);
  for (const name of ["students", "attendance", "assessments", "scores", "questions", "questionOptions", "lessons"]) {
    const store = idb.db.stores.get(name);
    assert.equal(store.getAllCalls, 0, `${name} deletion should not scan unrelated class records`);
    assert.ok(store.indexReads.some((read) => read.name === "classId" && read.key === a.id), `${name} deletion should use the classId index`);
  }
  assert.deepEqual((await listClasses({}, idb)).map((entry) => entry.id), [b.id]);
  assert.equal((await listStudents(a.id, {}, idb)).length, 0);
  assert.equal((await listStudents(b.id, {}, idb)).length, 1);
  assert.equal((await listAttendanceRecords(a.id, idb)).length, 0);
  assert.equal((await listAttendanceRecords(b.id, idb)).length, 1);
  assert.equal((await listAssessments(a.id, idb)).length, 0);
  assert.equal((await listScoresForClass(a.id, idb)).length, 0);
  assert.equal((await listScoresForClass(b.id, idb)).length, 1);
  assert.equal((await listLessons(a.id, idb)).length, 0);
  assert.equal((await listLessons(b.id, idb)).length, 1);
});

test("backup round trip preserves IDs and hostile-looking text as ordinary data", async () => {
  const source = new MemoryIndexedDb();
  const classroom = await saveClass({ className: "<Grade 8> & \"A\"", notes: "<img src=x onerror=alert(1)>" }, null, source);
  const student = await saveStudent({ fullName: "<script>not code</script> & 'Student'" }, classroom.id, null, source);
  const backup = await createBackup(source);
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.backupVersion, BACKUP_VERSION);
  const backupRead = source.db.transactions.at(-1);
  assert.equal(backupRead.mode, "readonly");
  assert.deepEqual(backupRead.names, ["classes", "students", "attendance", "assessments", "scores", "questions", "questionOptions", "lessons", "materials"]);
  const restored = new MemoryIndexedDb();
  const output = await replaceWithBackup(JSON.parse(JSON.stringify(backup)), restored);
  assert.deepEqual(output, { classCount: 1, studentCount: 1, attendanceCount: 0, assessmentCount: 0, scoreCount: 0, questionCount: 0, optionCount: 0, lessonCount: 0, materialCount: 0 });
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

test("current backups require every collection while legacy backups keep their historical optional collections", () => {
  const stores = ["classes", "students", "attendance", "assessments", "scores", "questions", "questionOptions", "lessons", "materials"];
  const complete = { format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: Object.fromEntries(stores.map((store) => [store, []])) };
  assert.equal(validateBackup(complete).data.materials.length, 0);
  for (const store of stores) {
    const truncated = structuredClone(complete);
    delete truncated.data[store];
    assert.throws(() => validateBackup(truncated), /unsupported data shape/, `missing ${store} must not be treated as an empty collection`);
  }
  const legacy = { format: BACKUP_FORMAT, backupVersion: LEGACY_BACKUP_VERSION, data: { classes: [], students: [] } };
  assert.equal(validateBackup(legacy).data.attendance.length, 0);
});

test("invalid restore payloads are rejected before any database transaction can modify existing records", async () => {
  const idb = new MemoryIndexedDb();
  const existing = await saveClass({ className: "Keep this class" }, null, idb);
  await saveStudent({ fullName: "Keep this student" }, existing.id, null, idb);
  const before = Object.fromEntries([...idb.db.stores].map(([name, store]) => [name, structuredClone([...store.records.entries()])]));
  const transactionsBefore = idb.db.transactions.length;
  const invalidPayloads = [
    null,
    "",
    { format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: "not-an-array", students: [] } },
    { format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: [], students: [{ id: "orphan", fullName: "Orphan", classId: "missing" }] } }
  ];

  for (const payload of invalidPayloads) await assert.rejects(replaceWithBackup(payload, idb));

  assert.equal(idb.db.transactions.length, transactionsBefore, "rejected payloads must fail before opening even a read/write transaction");
  assert.deepEqual(Object.fromEntries([...idb.db.stores].map(([name, store]) => [name, [...store.records.entries()]])), before);
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

test("multi-class class lists count hundreds of students through the classId index without scanning the student store", async () => {
  const idb = new MemoryIndexedDb(), classes = [];
  for (let classNumber = 0; classNumber < 11; classNumber += 1) {
    const classroom = await saveClass({ className: `${classNumber < 8 ? "Active" : "Archived"} ${String(classNumber).padStart(2, "0")}` }, null, idb);
    classes.push(classroom);
    const students = await saveStudents(Array.from({ length: 40 }, (_, index) => ({ fullName: `Student ${classNumber}-${String(index + 1).padStart(2, "0")}` })), classroom.id, idb);
    if (classNumber === 0 || classNumber === 8) await setStudentArchived(students[39].id, true, idb);
    if (classNumber >= 8) await setClassArchived(classroom.id, true, idb);
  }
  const studentStore = idb.db.stores.get("students"); studentStore.getAllCalls = 0; studentStore.indexReads = [];
  const activeClasses = await listClasses({}, idb);
  assert.equal(activeClasses.length, 8);
  assert.deepEqual(activeClasses.map((entry) => entry.studentCount), [39, 40, 40, 40, 40, 40, 40, 40]);
  assert.equal(studentStore.getAllCalls, 0);
  assert.deepEqual(studentStore.indexReads.map((read) => read.key), classes.slice(0, 8).map((entry) => entry.id));

  studentStore.indexReads = [];
  const archivedClasses = await listClasses({ archived: true }, idb);
  assert.equal(archivedClasses.length, 3);
  assert.deepEqual(archivedClasses.map((entry) => entry.studentCount), [39, 40, 40]);
  assert.equal(studentStore.getAllCalls, 0);
  assert.deepEqual(studentStore.indexReads.map((read) => read.key), classes.slice(8).map((entry) => entry.id));
});

test("multi-class teacher workflow keeps attendance, score history, reusable materials, and reports scoped across 320 students", async () => {
  const idb = new MemoryIndexedDb(), classes = [], rosters = [], assessments = [];
  for (let classNumber = 0; classNumber < 8; classNumber += 1) {
    const classroom = await saveClass({ className: `Subject ${classNumber + 1}` }, null, idb);
    classes.push(classroom);
    rosters.push(await saveStudents(Array.from({ length: 40 }, (_, index) => ({ fullName: `Student ${String(index + 1).padStart(2, "0")}` })), classroom.id, idb));
    assessments.push(await saveAssessment({ title: "Weekly check", date: "2026-09-29", maximumScore: "20" }, classroom.id, null, idb));
    if (classNumber === 0) await saveScores(assessments[classNumber].id, [{ studentId: rosters[classNumber][0].id, rawScore: "0" }, { studentId: rosters[classNumber][1].id, rawScore: "15.5" }], idb);
    else await saveScores(assessments[classNumber].id, rosters[classNumber].map((student) => ({ studentId: student.id, rawScore: "12" })), idb);
  }
  const primary = await listStudents(classes[0].id, {}, idb);
  await saveAttendance(classes[0].id, "2026-09-28", primary.map((student, index) => ({ studentId: student.id, status: index === 0 ? "absent" : "present" })), idb);
  await saveAttendance(classes[0].id, "2026-09-29", primary.map((student, index) => ({ studentId: student.id, status: index === 0 ? "late" : "present" })), idb);
  const corrected = await listAttendanceForDate(classes[0].id, "2026-09-29", idb);
  await saveAttendance(classes[0].id, "2026-09-29", corrected.map((entry) => ({ studentId: entry.studentId, status: entry.studentId === primary[0].id ? "present" : entry.status })), idb);
  await setStudentArchived(primary[39].id, true, idb);

  const question = await saveAuthoredQuestion({ questionType: "multiple-choice", prompt: "Which answer is supported?", points: "2", options: [{ text: "A", correct: true }, { text: "B" }] }, assessments[0].id, null, idb);
  const lesson = await saveLesson({ title: "Use evidence", learningGoals: "Support a claim with evidence" }, classes[0].id, null, idb);
  const assessmentTemplate = await saveAssessmentToMaterials(assessments[0].id, idb);
  const lessonTemplate = await saveLessonToMaterials(lesson.id, idb);
  const assessmentCopy = await materializeMaterialToClass(assessmentTemplate.id, classes[1].id, idb);
  const lessonCopy = await materializeMaterialToClass(lessonTemplate.id, classes[1].id, idb);
  assert.notEqual(assessmentCopy.item.id, assessments[0].id);
  assert.notEqual(lessonCopy.item.id, lesson.id);
  assert.equal((await listScores(assessmentCopy.item.id, idb)).length, 0);
  assert.notEqual((await listQuestions(assessmentCopy.item.id, idb))[0].id, question.id);
  assert.equal((await listStudents(classes[1].id, {}, idb)).length, 40);

  const attendance = await listAttendanceRecords(classes[0].id, idb), scores = await listScoresForClass(classes[0].id, idb);
  const progress = deriveStudentProgress({ student: primary[0], classId: classes[0].id, attendance, assessments: await listAssessments(classes[0].id, idb), scores });
  assert.equal(progress.attendance.length, 2);
  assert.equal(progress.attendance.find((entry) => entry.date === "2026-09-29").status, "present");
  assert.equal(progress.assessments[0].rawScore, "0");
  assert.equal(progress.assessments[0].entered, true);
  const missing = deriveStudentProgress({ student: primary[2], classId: classes[0].id, attendance, assessments: await listAssessments(classes[0].id, idb), scores });
  assert.equal(missing.assessments[0].entered, false);
  const allStudents = [...(await listStudents(classes[0].id, {}, idb)), ...(await listStudents(classes[0].id, { archived: true }, idb))];
  const report = deriveAssessmentResults({ classId: classes[0].id, students: allStudents, assessments: await listAssessments(classes[0].id, idb), scores }).reports[0];
  assert.equal(report.statistics.recordedCount, 2);
  assert.equal(report.statistics.missingCount, 38);
  assert.equal(report.rows.find((row) => row.studentId === primary[39].id).archived, true);
  assert.equal(deriveAttendanceSummary({ classId: classes[0].id, students: allStudents, attendance }).recordedCount, 80);
  assert.equal((await listScoresForClass(classes[1].id, idb)).length, 40, "neighboring class scores stay out of the source-class Progress/Reports query");

  const nextTerm = await saveClass({ className: "Subject 1 · Term 2" }, null, idb);
  await setClassArchived(classes[0].id, true, idb);
  const copiedRoster = await copyActiveRosterToEmptyClass(classes[0].id, nextTerm.id, idb);
  assert.equal(copiedRoster.length, 39);
  assert.equal((await listAttendanceRecords(classes[0].id, idb)).length, 80, "archiving and roster reuse preserve old-term history");
});

test("class workspace reads use existing IndexedDB indexes instead of scanning other classes", async () => {
  const idb = new MemoryIndexedDb();
  const classA = await saveClass({ className: "Class A" }, null, idb);
  const classB = await saveClass({ className: "Class B" }, null, idb);
  const rosterA = await saveStudents(Array.from({ length: 40 }, (_, index) => ({ fullName: `A Student ${index + 1}` })), classA.id, idb);
  const rosterB = await saveStudents(Array.from({ length: 40 }, (_, index) => ({ fullName: `B Student ${index + 1}` })), classB.id, idb);
  const assessmentA = await saveAssessment({ title: "Assessment A", date: "2026-09-29", maximumScore: "20" }, classA.id, null, idb);
  const assessmentB = await saveAssessment({ title: "Assessment B", date: "2026-09-29", maximumScore: "20" }, classB.id, null, idb);
  await saveScores(assessmentA.id, rosterA.map((student) => ({ studentId: student.id, rawScore: "0" })), idb);
  await saveScores(assessmentB.id, rosterB.map((student) => ({ studentId: student.id, rawScore: "18" })), idb);
  await saveAttendance(classA.id, "2026-09-29", rosterA.map((student) => ({ studentId: student.id, status: "present" })), idb);
  await saveAttendance(classB.id, "2026-09-29", rosterB.map((student) => ({ studentId: student.id, status: "absent" })), idb);
  const lessonA = await saveLesson({ title: "Class A lesson", learningGoal: "Practice" }, classA.id, null, idb);
  await saveLesson({ title: "Class B lesson", learningGoal: "Review" }, classB.id, null, idb);
  await saveAuthoredQuestion({ questionType: "multiple-choice", prompt: "Question A", points: "1", options: [{ text: "A1" }, { text: "A2" }] }, assessmentA.id, null, idb);
  await saveAuthoredQuestion({ questionType: "multiple-choice", prompt: "Question B", points: "1", options: [{ text: "B1" }, { text: "B2" }] }, assessmentB.id, null, idb);

  const stores = idb.db.stores;
  for (const store of stores.values()) { store.getAllCalls = 0; store.indexReads = []; }
  const [students, attendance, datedAttendance, history, assessments, lessons, scores, questions] = await Promise.all([
    listStudents(classA.id, {}, idb),
    listAttendanceRecords(classA.id, idb),
    listAttendanceForDate(classA.id, "2026-09-29", idb),
    listAttendanceHistory(classA.id, idb),
    listAssessments(classA.id, idb),
    listLessons(classA.id, idb),
    listScoresForClass(classA.id, idb),
    listQuestions(assessmentA.id, idb)
  ]);

  assert.equal(students.length, 40);
  assert.equal(attendance.length, 40);
  assert.equal(datedAttendance.length, 40);
  assert.equal(history.length, 1);
  assert.equal(assessments.length, 1);
  assert.equal(assessments[0].scoreCount, 40);
  assert.deepEqual(lessons.map((lesson) => lesson.id), [lessonA.id]);
  assert.equal(scores.length, 40);
  assert.ok(scores.every((score) => score.classId === classA.id));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].options.length, 2);
  for (const name of ["students", "attendance", "assessments", "scores", "lessons", "questions", "questionOptions"]) {
    const store = stores.get(name);
    assert.equal(store.getAllCalls, 0, `${name} should be read through its existing index for a class workspace`);
    assert.ok(store.indexReads.length > 0, `${name} should use an IndexedDB index`);
  }
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

test("attendance saves and reopens a realistic 48-student roster without changing status semantics", async () => {
  const idb = new MemoryIndexedDb();
  const classroom = await saveClass({ className: "Large attendance class" }, null, idb);
  const students = await saveStudents(Array.from({ length: 48 }, (_, index) => ({ fullName: `Student ${String(index + 1).padStart(2, "0")}` })), classroom.id, idb);
  const initialRows = students.map((student) => ({ studentId: student.id, status: "present" }));
  assert.equal(initialRows.length, 48);
  assert.deepEqual(attendanceCounts(initialRows), { present: 48, absent: 0, late: 0, excused: 0 });

  const changedRows = initialRows.map((row, index) => ({ ...row, status: index % 11 === 0 ? "absent" : index % 13 === 0 ? "late" : index % 17 === 0 ? "excused" : row.status }));
  const saved = await saveAttendance(classroom.id, "2026-09-29", changedRows, idb);
  const reopened = await listAttendanceForDate(classroom.id, "2026-09-29", idb);
  assert.equal(saved.length, 48);
  assert.deepEqual(attendanceCounts(reopened), attendanceCounts(changedRows));
  const expectedByStudent = new Map(changedRows.map((row) => [row.studentId, row.status]));
  reopened.forEach((row) => assert.equal(row.status, expectedByStudent.get(row.studentId)));
  assert.equal(reopened.find((row) => row.studentId === students[0].id).status, "absent");
  assert.equal(reopened.find((row) => row.studentId === students[1].id).status, "present");
  assert.equal(reopened.some((row) => row.status === "late"), true);
  assert.equal(reopened.some((row) => row.status === "excused"), true);
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
  const legacy = validateBackup({ format: BACKUP_FORMAT, backupVersion: LEGACY_BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students } });
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
  const legacy = validateBackup({ format: BACKUP_FORMAT, backupVersion: LEGACY_BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, attendance: [] } }); assert.deepEqual(legacy.data.assessments, []); assert.deepEqual(legacy.data.scores, []);
  const wrongPolicy = { ...backup.data.assessments[0], id: "assessment-policy", policyId: "unverified-policy" }; assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, attendance: [], assessments: [wrongPolicy], scores: [] } }), /policy is not available/);
  const impossible = { ...backup.data.scores[0], id: "score-impossible", rawScore: "26" }; assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, attendance: [], assessments: backup.data.assessments, scores: [impossible] } }), /maximum score/);
});

test("larger generic gradebook operations stay practical for 60 students and 40 assessments", async () => {
  const idb = new MemoryIndexedDb(); const classroom = await saveClass({ className: "Performance" }, null, idb); const students = await saveStudents(Array.from({ length: 60 }, (_, index) => ({ fullName: `Student ${String(index + 1).padStart(2, "0")}` })), classroom.id, idb); const started = performance.now();
  for (let index = 0; index < 40; index += 1) { const assessment = await saveAssessment({ title: `Quiz ${index + 1}`, date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`, maximumScore: "20" }, classroom.id, null, idb); await saveScores(assessment.id, students.map((student, studentIndex) => ({ studentId: student.id, rawScore: String(studentIndex % 21) })), idb); }
  const assessments = await listAssessments(classroom.id, idb); const scores = await listScores(assessments[0].id, idb); const elapsed = performance.now() - started; assert.equal(assessments.length, 40); assert.equal(scores.length, 60); assert.ok(elapsed < 1500, `synthetic gradebook operations took ${elapsed}ms`);
});

test("school-year attendance across eight 40-student classes remains class-scoped and index-driven", async () => {
  const idb = new MemoryIndexedDb(), classes = [], rosters = [];
  for (let classIndex = 0; classIndex < 8; classIndex += 1) {
    const classroom = await saveClass({ className: `Section ${classIndex + 1}` }, null, idb);
    const roster = await saveStudents(Array.from({ length: 40 }, (_, index) => ({ fullName: `Student ${String(index + 1).padStart(2, "0")}` })), classroom.id, idb);
    classes.push(classroom); rosters.push(roster);
  }
  const started = performance.now();
  for (let day = 0; day < 180; day += 1) {
    const date = new Date(2025, 0, day + 1);
    const dateText = String(date.getFullYear()) + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    for (let classIndex = 0; classIndex < classes.length; classIndex += 1) {
      await saveAttendance(classes[classIndex].id, dateText, rosters[classIndex].map((student, index) => ({ studentId: student.id, status: index % 17 === day % 17 ? "absent" : index % 19 === day % 19 ? "late" : "present" })), idb);
    }
  }
  const dateText = "2025-06-29";
  const classDay = await listAttendanceForDate(classes[0].id, dateText, idb);
  const history = await listAttendanceRecords(classes[0].id, idb);
  const unrelated = await listAttendanceForDate(classes[7].id, dateText, idb);
  const store = idb.db.stores.get("attendance"), elapsed = performance.now() - started;
  assert.equal(store.records.size, 8 * 180 * 40);
  assert.equal(classDay.length, 40);
  assert.equal(history.length, 180 * 40);
  assert.equal(unrelated.length, 40);
  assert.equal(store.getAllCalls, 0, "school-year reads should use classId/classDate indexes, not full-store getAll");
  assert.ok(store.indexReads.some((read) => read.name === "classDate" && read.key === classes[0].id + "::" + dateText));
  assert.ok(store.indexReads.some((read) => read.name === "classId" && read.key === classes[0].id));
  assert.ok(elapsed < 20000, `school-year synthetic attendance path took ${elapsed}ms in the in-memory IndexedDB harness`);
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

test("My Materials keeps saved lesson templates independent through source-class deletion and template removal", async () => {
  const idb = new MemoryIndexedDb();
  const source = await saveClass({ className: "Old term" }, null, idb), target = await saveClass({ className: "New term" }, null, idb);
  const lesson = await saveLesson({ title: "Evidence lesson", date: "2026-08-02", status: "ready", learningGoals: "Compare evidence", during: "Use <strong>primary sources</strong>", notes: "Teacher-only note" }, source.id, null, idb);
  const template = await saveLessonToMaterials(lesson.id, idb), sameTitle = await saveLessonToMaterials(lesson.id, idb);
  assert.notEqual(template.id, sameTitle.id, "saving a duplicate title creates a separate template instead of overwriting");
  assert.equal(template.classId, undefined); assert.equal(template.content.classId, undefined); assert.equal(template.content.date, undefined);
  assert.equal(template.content.during, "Use <strong>primary sources</strong>");
  await setClassArchived(source.id, true, idb); await deleteClassPermanently(source.id, idb);
  assert.equal((await listMaterials({}, idb)).length, 2, "library entries survive source class archive and permanent deletion");
  const copy = await materializeMaterialToClass(template.id, target.id, idb);
  assert.equal(copy.kind, "lesson"); assert.notEqual(copy.item.id, lesson.id); assert.equal(copy.item.classId, target.id); assert.equal(copy.item.status, "draft"); assert.equal(copy.item.date, "");
  assert.equal(copy.item.during, lesson.during); assert.equal(copy.item.notes, lesson.notes);
  await saveLesson({ ...copy.item, during: "Target-only edit" }, target.id, copy.item.id, idb);
  assert.equal((await listMaterials({}, idb)).find((item) => item.id === template.id).content.during, lesson.during, "editing a class copy cannot mutate its template");
  await deleteMaterialPermanently(template.id, idb);
  assert.equal((await listLessons(target.id, idb)).find((item) => item.id === copy.item.id).during, "Target-only edit", "deleting a template leaves class copies intact");
});

test("My Materials assessment snapshots remap complex question graphs, exclude scores, and survive restore", async () => {
  const idb = new MemoryIndexedDb();
  const source = await saveClass({ className: "Source class" }, null, idb), target = await saveClass({ className: "Target class" }, null, idb), archived = await saveClass({ className: "Archived target" }, null, idb);
  const student = await saveStudent({ fullName: "Student, private" }, source.id, null, idb);
  const assessment = await saveAssessment({ title: "<img src=x onerror=alert(1)>", date: "2026-08-15", maximumScore: "12.5", category: "Quiz", term: "Old school year", assessmentKind: "worksheet", instructions: "<script>not executable</script>", showPoints: true }, source.id, null, idb);
  await saveAuthoredQuestion({ questionType: "multiple-choice", prompt: "Which answer? <b>" , points: "2.5", options: [{ text: "Wrong", correct: false }, { text: "Correct <img>", correct: true }] }, assessment.id, null, idb);
  await saveAuthoredQuestion({ questionType: "true-false", prompt: "A factual statement", points: "1", correctBoolean: "false" }, assessment.id, null, idb);
  await saveAuthoredQuestion({ questionType: "short-answer", prompt: "Explain briefly", points: "3", referenceAnswer: "Reference <answer>" }, assessment.id, null, idb);
  await saveAuthoredQuestion({ questionType: "essay", prompt: "Write a response", points: "6", guidance: "Use a clear rubric." }, assessment.id, null, idb);
  await updateAssessmentAuthoringStatus(assessment.id, "ready", idb);
  await saveScores(assessment.id, [{ studentId: student.id, rawScore: "0" }], idb);
  const template = await saveAssessmentToMaterials(assessment.id, idb), duplicate = await saveAssessmentToMaterials(assessment.id, idb);
  assert.notEqual(template.id, duplicate.id, "same-title templates are distinct and no existing item is overwritten");
  assert.equal(template.classId, undefined); assert.equal(template.content.classId, undefined); assert.equal(template.content.date, undefined); assert.equal(template.content.term, undefined);
  assert.equal(template.content.authoringStatus, "ready"); assert.equal(template.content.questions.length, 4); assert.equal("scores" in template.content, false);
  assert.equal(template.content.questions[2].referenceAnswer, "Reference <answer>"); assert.equal(template.content.questions[3].guidance, "Use a clear rubric.");
  assert.equal(JSON.stringify(template).includes(student.id), false, "student identifiers and scores are not stored in a template");
  await setClassArchived(archived.id, true, idb);
  await assert.rejects(() => materializeMaterialToClass(template.id, archived.id, idb), /active destination class/);
  await deleteClassPermanently(source.id, idb);
  const copied = await materializeMaterialToClass(template.id, target.id, idb), copiedQuestions = await listQuestions(copied.item.id, idb), templateQuestions = template.content.questions;
  assert.equal(copied.kind, "assessment"); assert.notEqual(copied.item.id, assessment.id); assert.equal(copied.item.classId, target.id); assert.equal(copied.item.authoringStatus, "draft"); assert.equal(copied.item.term, "");
  assert.equal((await listScores(copied.item.id, idb)).length, 0); assert.equal(copiedQuestions.length, templateQuestions.length);
  const templateQuestionIds = new Set(templateQuestions.map((question) => question.id)), templateOptionIds = new Set(templateQuestions.flatMap((question) => question.options.map((option) => option.id)));
  copiedQuestions.forEach((question, index) => { const original = templateQuestions[index]; assert.equal(templateQuestionIds.has(question.id), false); assert.equal(question.prompt, original.prompt); assert.equal(question.classId, target.id); assert.equal(question.assessmentId, copied.item.id); assert.equal(question.options.length, original.options.length); question.options.forEach((option) => assert.equal(templateOptionIds.has(option.id), false)); });
  const mc = copiedQuestions[0]; assert.equal(mc.options.find((option) => option.text === "Correct <img>").id, mc.correctOptionId, "correct option references are rewritten to the copied option ID");
  assert.equal(copiedQuestions[1].correctBoolean, "false"); assert.equal(copiedQuestions[2].referenceAnswer, "Reference <answer>"); assert.equal(copiedQuestions[3].guidance, "Use a clear rubric.");
  const backup = await createBackup(idb); assert.equal(backup.backupVersion, BACKUP_VERSION); assert.equal(backup.data.materials.length, 2);
  const malformed = structuredClone(backup); malformed.data.materials[0].content.questions[0].correctOptionId = "not-a-choice"; assert.throws(() => validateBackup(malformed), /answer refers/);
  const missingQuestionId = structuredClone(backup); delete missingQuestionId.data.materials[0].content.questions[0].id; assert.throws(() => validateBackup(missingQuestionId), /without an identifier/);
  const missingOptionId = structuredClone(backup); delete missingOptionId.data.materials[0].content.questions[0].options[0].id; assert.throws(() => validateBackup(missingOptionId), /without an identifier/);
  const classLinkedMaterial = structuredClone(backup); classLinkedMaterial.data.materials[0].content.classId = source.id; assert.throws(() => validateBackup(classLinkedMaterial), /class or student records/);
  const restored = new MemoryIndexedDb(); await replaceWithBackup(backup, restored); assert.equal((await listMaterials({}, restored)).length, 2); assert.equal((await listScores(copied.item.id, restored)).length, 0);
  const legacy = { ...backup, backupVersion: LEGACY_BACKUP_VERSION, data: { ...backup.data, materials: undefined } }; const legacyTarget = new MemoryIndexedDb();
  await replaceWithBackup(legacy, legacyTarget); assert.equal((await listMaterials({}, legacyTarget)).length, 0, "legacy replacement restores with an empty library");
  await saveAssessment({ ...copied.item, title: "Edited copy" }, target.id, copied.item.id, idb);
  assert.equal((await listMaterials({}, idb)).find((item) => item.id === template.id).title, assessment.title, "class assessment edits cannot mutate template");
  await deleteMaterialPermanently(template.id, idb); assert.equal((await getAllRecords("assessments", idb)).some((item) => item.id === copied.item.id), true);
  await deleteClassPermanently(target.id, idb); assert.equal((await listMaterials({}, idb)).some((item) => item.id === duplicate.id), true, "target deletion also leaves the separate library intact");
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
  const legacy = validateBackup({ format: BACKUP_FORMAT, backupVersion: LEGACY_BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students } }); assert.deepEqual(legacy.data.lessons, []);
  const orphan = prepareLesson({ ...edited, id: "orphan-lesson", classId: "missing-class" }); assert.throws(() => validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, data: { classes: backup.data.classes, students: backup.data.students, lessons: [orphan] } }), /lesson without a matching class/);
  await deleteLessonPermanently(copy.id, source); assert.equal((await listLessons(first.id, source)).length, 1); await setClassArchived(first.id, true, source); assert.equal((await listLessons(first.id, source)).length, 1); await setClassArchived(first.id, false, source); assert.equal((await listLessons(first.id, source)).length, 1); await deleteClassPermanently(first.id, source); assert.equal((await getAllRecords("lessons", source)).length, 0);
  const started = performance.now(); for (let index = 0; index < 100; index += 1) await saveLesson({ title: `Plan ${index}`, date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}` }, second.id, null, source); assert.equal((await listLessons(second.id, source)).length, 100); assert.ok(performance.now() - started < 1000, "100 local lesson saves should remain responsive");
});
