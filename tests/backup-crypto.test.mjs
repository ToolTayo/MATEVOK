import assert from "node:assert/strict";
import test from "node:test";
import { BACKUP_PASSPHRASE_MIN_LENGTH, MAX_ENCRYPTED_BACKUP_FILE_BYTES, decryptBackup, encryptBackup, isEncryptedBackup, validateEncryptedBackupEnvelope } from "../dist/backup-crypto.js";
import { BACKUP_FORMAT, BACKUP_VERSION, LOCAL_SCHEMA_VERSION, prepareAssessment, prepareAttendance, prepareClass, prepareClassWork, prepareLesson, prepareMaterial, prepareQuestion, prepareQuestionOption, prepareScore, prepareStudent, prepareWorkSubmission, validateBackup } from "../dist/storage.js";

const sampleBackup = { format: "teacher-workspace-backup", backupVersion: 1, data: { classes: [{ id: "class-1", className: "Sensitive class" }] } };
const passphrase = "correct horse battery staple";

test("encrypted backups round-trip without exposing cleartext and use fresh cryptographic parameters", async () => {
  const first = await encryptBackup(sampleBackup, passphrase);
  const second = await encryptBackup(sampleBackup, passphrase);
  assert.equal(isEncryptedBackup(first), true);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(first).includes("Sensitive class"), false);
  assert.deepEqual(await decryptBackup(first, passphrase), sampleBackup);
});

test("encrypted backup unlock rejects wrong passphrases and tampered ciphertext", async () => {
  const encrypted = await encryptBackup(sampleBackup, passphrase);
  await assert.rejects(decryptBackup(encrypted, "incorrect horse battery staple"), /Could not unlock/);
  const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -4)}AAAA` };
  await assert.rejects(decryptBackup(tampered, passphrase), /Could not unlock/);
});

test("encrypted backup envelope rejects unsupported parameters and weak passphrases", async () => {
  const encrypted = await encryptBackup(sampleBackup, passphrase);
  assert.throws(() => validateEncryptedBackupEnvelope({ ...encrypted, iterations: encrypted.iterations - 1 }), /not supported or is invalid/);
  assert.throws(() => validateEncryptedBackupEnvelope({ ...encrypted, iv: "AA==" }), /not valid/);
  assert.equal(isEncryptedBackup(sampleBackup), false);
  await assert.rejects(encryptBackup(sampleBackup, "too-short"), new RegExp(`at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters`));
});

test("encrypted backup file cap accommodates school-year exports without changing the envelope", () => {
  assert.equal(MAX_ENCRYPTED_BACKUP_FILE_BYTES, 36_000_000);
});

test("ciphertext size validation accepts the exact limit and rejects one byte above it", () => {
  const encrypted = { format: "teacher-workspace-encrypted-backup", backupVersion: 1, encryption: "AES-256-GCM", keyDerivation: "PBKDF2-SHA-256", iterations: 600_000, salt: "AAAAAAAAAAAAAAAAAAAAAA==", iv: "AAAAAAAAAAAAAAAA", ciphertext: "" };
  const maxBytes = 24 * 1024 * 1024;
  const base64Length = maxBytes / 3 * 4;
  const exact = "A".repeat(base64Length);
  const below = `${"A".repeat(base64Length - 1)}=`;
  const above = `${"A".repeat(base64Length + 2)}==`;
  assert.equal(validateEncryptedBackupEnvelope({ ...encrypted, ciphertext: below }).ciphertext.length, base64Length);
  assert.equal(validateEncryptedBackupEnvelope({ ...encrypted, ciphertext: exact }).ciphertext.length, base64Length);
  assert.throws(() => validateEncryptedBackupEnvelope({ ...encrypted, ciphertext: above }), /too large/);
});

test("encrypted backup round-trips an eight-class, 50-student school year", async () => {
  const now = "2025-08-01T09:00:00.000Z";
  const data = { classes: [], students: [], attendance: [], assessments: [], scores: [], questions: [], questionOptions: [], lessons: [], materials: [], classWork: [], workSubmissions: [] };
  for (let classIndex = 0; classIndex < 8; classIndex += 1) {
    const classId = `scale-class-${classIndex}`;
    data.classes.push(prepareClass({ id: classId, className: `Scale School Year ${String(classIndex + 1).padStart(2, "0")}`, gradeLevel: "Grade 7", subject: "Science", term: "2025-2026" }, null, now));
    const studentIds = [];
    for (let studentIndex = 0; studentIndex < 50; studentIndex += 1) {
      const studentId = `scale-student-${classIndex}-${studentIndex}`;
      studentIds.push(studentId);
      data.students.push(prepareStudent({ id: studentId, fullName: `Scale ${String(classIndex + 1).padStart(2, "0")} Student ${String(studentIndex + 1).padStart(2, "0")}`, archivedAt: classIndex === 0 && studentIndex === 49 ? now : null }, classId, null, now));
    }
    const assessmentIds = [];
    for (let assessmentIndex = 0; assessmentIndex < 8; assessmentIndex += 1) {
      const assessmentId = `scale-assessment-${classIndex}-${assessmentIndex}`;
      const date = new Date(Date.UTC(2025, 1, assessmentIndex + 1)).toISOString().slice(0, 10);
      assessmentIds.push(assessmentId);
      data.assessments.push(prepareAssessment({ id: assessmentId, classId, title: `Scale check ${assessmentIndex + 1}`, date, maximumScore: "20", category: "Quiz", term: "2025-2026", assessmentKind: "quiz", authoringStatus: "draft" }, null, now));
      const questionId = `scale-question-${classIndex}-${assessmentIndex}`;
      const correctOptionId = `scale-option-correct-${classIndex}-${assessmentIndex}`;
      data.questions.push(prepareQuestion({ id: questionId, assessmentId, classId, questionType: "multiple-choice", prompt: `Which answer belongs to scale check ${assessmentIndex + 1}?`, points: "2", position: 0, correctOptionId }, null, now));
      data.questionOptions.push(prepareQuestionOption({ id: correctOptionId, questionId, assessmentId, classId, text: "Correct synthetic choice", position: 0 }, null, now));
      data.questionOptions.push(prepareQuestionOption({ id: `scale-option-other-${classIndex}-${assessmentIndex}`, questionId, assessmentId, classId, text: "Other synthetic choice", position: 1 }, null, now));
      for (let studentIndex = 0; studentIndex < 50; studentIndex += 1) if (studentIndex % 8 !== 0) {
        data.scores.push(prepareScore({ id: `scale-score-${classIndex}-${assessmentIndex}-${studentIndex}`, assessmentId, classId, studentId: studentIds[studentIndex], rawScore: String((studentIndex + assessmentIndex) % 21) }, null, now));
      }
    }
    for (let lessonIndex = 0; lessonIndex < 12; lessonIndex += 1) data.lessons.push(prepareLesson({ id: `scale-lesson-${classIndex}-${lessonIndex}`, classId, title: `Scale lesson ${lessonIndex + 1}`, date: "", status: "draft" }, null, now));
    for (let workIndex = 0; workIndex < 12; workIndex += 1) {
      const workItemId = `scale-work-${classIndex}-${workIndex}`;
      data.classWork.push(prepareClassWork({ id: workItemId, classId, title: `Scale work ${workIndex + 1}`, dueDate: "", assessmentId: assessmentIds[workIndex % assessmentIds.length] }, null, now));
      for (let studentIndex = 0; studentIndex < 50; studentIndex += 1) if (studentIndex % 5 !== 0) {
        const status = ["submitted", "missing", "excused"][(studentIndex + workIndex) % 3];
        data.workSubmissions.push(prepareWorkSubmission({ id: `scale-submission-${classIndex}-${workIndex}-${studentIndex}`, classId, workItemId, studentId: studentIds[studentIndex], status }, null, now));
      }
    }
    for (let day = 0; day < 180; day += 1) {
      const date = new Date(Date.UTC(2025, 0, day + 1)).toISOString().slice(0, 10);
      for (let studentIndex = 0; studentIndex < 50; studentIndex += 1) {
        const status = studentIndex % 17 === day % 17 ? "absent" : studentIndex % 19 === day % 19 ? "late" : "present";
        data.attendance.push(prepareAttendance({ id: `scale-attendance-${classIndex}-${day}-${studentIndex}`, classId, studentId: studentIds[studentIndex], date, status }, null, now));
      }
    }
  }
  data.materials.push(prepareMaterial({ id: "scale-material-lesson", kind: "lesson", title: "Reusable year lesson", content: { title: "Reusable year lesson", status: "draft", learningGoals: "A synthetic reusable learning goal" } }, null, now));
  data.materials.push(prepareMaterial({ id: "scale-material-assessment", kind: "assessment", title: "Reusable year check", content: { title: "Reusable year check", date: "2025-02-01", maximumScore: "20", assessmentKind: "quiz", authoringStatus: "draft", questions: [{ id: "scale-material-question", questionType: "multiple-choice", prompt: "Which choice is correct?", points: "2", position: 0, correctOptionId: "scale-material-option-correct", options: [{ id: "scale-material-option-correct", text: "Correct", position: 0 }, { id: "scale-material-option-other", text: "Other", position: 1 }] }] } }, null, now));
  const backup = validateBackup({ format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, exportedAt: now, appSchemaVersion: LOCAL_SCHEMA_VERSION, data });
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(backup)).length;
  assert.equal(backup.data.classes.length, 8);
  assert.equal(backup.data.students.length, 400);
  assert.equal(backup.data.students.filter((student) => student.archivedAt).length, 1);
  assert.equal(backup.data.attendance.length, 72_000);
  const encrypted = await encryptBackup(backup, passphrase);
  const encryptedText = JSON.stringify(encrypted);
  assert.ok(new TextEncoder().encode(encryptedText).length < MAX_ENCRYPTED_BACKUP_FILE_BYTES);
  assert.equal(encryptedText.includes("Scale School Year"), false);
  assert.equal(validateEncryptedBackupEnvelope(encrypted).backupVersion, 1);
  const restored = validateBackup(await decryptBackup(encrypted, passphrase));
  assert.equal(restored.data.classes.length, 8);
  assert.equal(restored.data.students.length, 400);
  assert.equal(restored.data.attendance.length, 72_000);
  assert.equal(restored.data.assessments.length, 64);
  assert.equal(restored.data.scores.length, 2_752);
  assert.equal(restored.data.scores.some((score) => score.rawScore === "0"), true, "real zero scores must remain present in the backup");
  assert.equal(restored.data.scores.some((score) => score.assessmentId === "scale-assessment-0-0" && score.studentId === "scale-student-0-0"), false, "a missing score must not be materialized as zero");
  assert.equal(restored.data.questions.length, 64);
  assert.equal(restored.data.questionOptions.length, 128);
  assert.equal(restored.data.lessons.length, 96);
  assert.equal(restored.data.materials.length, 2);
  assert.equal(restored.data.materials.some((material) => material.kind === "assessment" && material.content.questions[0].correctOptionId === "scale-material-option-correct"), true);
  assert.equal(restored.data.classWork.length, 96);
  assert.equal(restored.data.workSubmissions.length, 3_840);
  assert.ok(plaintextBytes > 20 * 1024 * 1024, "the fixture must remain representative of the previously failing export size");
});

test("empty, malformed, oversized, and authenticated-but-invalid backup files fail closed", async () => {
  const encrypted = await encryptBackup(sampleBackup, passphrase);
  const overCipherCap = "A".repeat(Math.ceil((24 * 1024 * 1024 + 1) / 3) * 4);
  for (const malformed of [null, {}, { ...encrypted, ciphertext: "" }, { ...encrypted, salt: "not base64!" }, { ...encrypted, ciphertext: overCipherCap }]) {
    assert.throws(() => validateEncryptedBackupEnvelope(malformed));
  }

  const authenticatedInvalid = await encryptBackup({ format: "not-a-backup", backupVersion: 99, data: null }, passphrase);
  const decrypted = await decryptBackup(authenticatedInvalid, passphrase);
  assert.throws(() => validateBackup(decrypted), /not a MATEVOK backup/);
});
