import assert from "node:assert/strict";
import test from "node:test";
import { assessmentCsv, attendanceCsv, classWorkStatusCsv, csvEscape, deriveAssessmentResults, deriveAttendanceSummary, deriveClassOverview, deriveClassRoster, deriveClassWorkStatusReport, rosterCsv } from "../dist/reports.js";
import { commitSubmissionDraftSnapshot, deriveClassWorkCountsByItem, deriveClassWorkSummary, deriveDueTodayClassWork, submissionDraftIsDirty } from "../dist/class-work.js";

const students = [
  { id: "a", classId: "one", fullName: "Ada, \"A\"" },
  { id: "b", classId: "one", fullName: "=Formula", archivedAt: "2026-09-03" },
  { id: "c", classId: "two", fullName: "Other class" }
];
const assessments = [{ id: "quiz", classId: "one", title: "Quiz, 1", date: "2026-09-02", maximumScore: "2.5" }, { id: "other", classId: "two", title: "Other", date: "2026-09-02", maximumScore: "10" }];
const scores = [{ classId: "one", assessmentId: "quiz", studentId: "a", rawScore: "0" }, { classId: "two", assessmentId: "other", studentId: "c", rawScore: "10" }];

test("reports derive only the active class and retain archived students and zero scores", () => {
  const roster = deriveClassRoster({ classId: "one", students });
  assert.equal(roster.rows.length, 2);
  assert.equal(roster.activeCount, 1);
  assert.equal(roster.archivedCount, 1);

  const results = deriveAssessmentResults({ classId: "one", students, assessments, scores });
  assert.equal(results.reports.length, 1);
  const result = results.reports[0];
  assert.equal(result.rows.find((row) => row.studentId === "a").entered, true);
  assert.equal(result.rows.find((row) => row.studentId === "a").rawScore, "0");
  assert.equal(result.rows.find((row) => row.studentId === "b").entered, false);
  assert.equal(result.statistics.recordedCount, 1);
  assert.equal(result.statistics.missingCount, 1);
  assert.equal(result.statistics.minimum, "0");
  assert.equal(result.statistics.maximum, "0");
  assert.equal(result.statistics.mean, "0");
  assert.equal(result.statistics.aggregate.display, "0%");
});

test("attendance report filters local ISO dates inclusively and excludes cross-class records", () => {
  const report = deriveAttendanceSummary({ classId: "one", students, startDate: "2026-09-02", endDate: "2026-09-02", attendance: [
    { classId: "one", studentId: "a", date: "2026-09-01", status: "present" },
    { classId: "one", studentId: "a", date: "2026-09-02", status: "late" },
    { classId: "one", studentId: "b", date: "2026-09-02", status: "absent" },
    { classId: "two", studentId: "c", date: "2026-09-02", status: "present" }
  ] });
  assert.equal(report.recordedCount, 2);
  assert.equal(report.dateCount, 1);
  assert.deepEqual(report.counts, { present: 0, absent: 1, late: 1, excused: 0 });
  assert.equal(report.rows.find((row) => row.studentId === "b").archived, true);
});

test("assessment statistics retain decimal precision and do not count missing values as zero", () => {
  const report = deriveAssessmentResults({ classId: "one", students: [{ id: "a", classId: "one", fullName: "Ada" }, { id: "b", classId: "one", fullName: "Bea" }, { id: "d", classId: "one", fullName: "Dee" }], assessments, scores: [{ classId: "one", assessmentId: "quiz", studentId: "a", rawScore: "1.125" }, { classId: "one", assessmentId: "quiz", studentId: "b", rawScore: "2.5" }] }).reports[0];
  assert.equal(report.statistics.mean, "1.813");
  assert.equal(report.statistics.totalRaw, "3.625");
  assert.equal(report.statistics.aggregate.display, "72.5%");
  assert.equal(report.statistics.missingCount, 1);
});

test("overview is factual and class-scoped", () => {
  const overview = deriveClassOverview({ classId: "one", students, assessments, scores, lessons: [{ classId: "one" }, { classId: "two" }], attendance: [{ classId: "one", studentId: "a", date: "2026-09-01", status: "present" }, { classId: "two", studentId: "c", date: "2026-09-01", status: "present" }] });
  assert.deepEqual(overview, { activeStudents: 1, archivedStudents: 1, totalStudents: 2, attendanceRecords: 1, attendanceDates: 1, assessments: 1, recordedScores: 1, missingScores: 1, lessons: 1 });
});

test("CSV quotes hostile text and protects spreadsheet formulas", () => {
  const roster = deriveClassRoster({ classId: "one", students });
  const csv = rosterCsv(roster);
  assert.match(csv, /"Ada, ""A"""/);
  assert.match(csv, /'=Formula/);
  assert.equal(csvEscape("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(csvEscape("\t=SUM(A1:A2)"), "'\t=SUM(A1:A2)");
  assert.equal(csvEscape("  -42"), "'  -42");
  const attendance = deriveAttendanceSummary({ classId: "one", students, attendance: [{ classId: "one", studentId: "a", date: "2026-09-02", status: "present" }] });
  assert.match(attendanceCsv(attendance), /Attendance status/);
  const results = deriveAssessmentResults({ classId: "one", students, assessments, scores }).reports[0];
  assert.match(assessmentCsv(results), /Raw percentage/);
});

test("class-work report keeps submission state separate from scores and includes read-only archived history", () => {
  const workItem = { id: "work-one", classId: "one", title: "=Worksheet, 1", dueDate: "2026-09-02", assessmentId: "quiz" };
  const reportStudents = [...students, { id: "d", classId: "one", fullName: "Cora" }];
  const report = deriveClassWorkStatusReport({ classId: "one", workItem, students: reportStudents, assessments, submissions: [
    { id: "s-a", classId: "one", workItemId: "work-one", studentId: "a", status: "submitted" },
    { id: "s-b", classId: "one", workItemId: "work-one", studentId: "b", status: "excused" },
    { id: "other-class", classId: "two", workItemId: "work-one", studentId: "c", status: "missing" }
  ] });
  assert.equal(report.assessment.title, "Quiz, 1");
  assert.deepEqual(report.activeCounts, { submitted: 1, missing: 0, excused: 0, "not-recorded": 1 });
  assert.deepEqual(report.counts, { submitted: 1, missing: 0, excused: 1, "not-recorded": 1 });
  assert.equal(report.rows.find((row) => row.studentId === "a").status, "submitted", "a recorded zero score does not alter submission state");
  assert.equal(report.rows.find((row) => row.studentId === "b").status, "excused");
  assert.equal(report.rows.length, 3, "cross-class statuses cannot leak into the report");
  assert.equal(deriveClassWorkStatusReport({ classId: "two", workItem, students, submissions: [] }), null);
  const csv = classWorkStatusCsv(report);
  assert.match(csv, /'=Worksheet, 1/);
  assert.match(csv, /Not recorded/);
  assert.match(csv, /Archived/);
});

test("multi-item Class Work counts match individual summaries and remain fast for a school-year list", () => {
  const roster = [...Array.from({ length: 50 }, (_, index) => ({ id: `s${index}`, classId: "one", fullName: `Student ${index}` })), ...Array.from({ length: 4 }, (_, index) => ({ id: `arch${index}`, classId: "one", fullName: `Archived ${index}`, archivedAt: "2026-01-01" }))];
  const workItems = Array.from({ length: 240 }, (_, index) => ({ id: `w${index}`, classId: "one", title: `Work ${index}`, dueDate: index < 3 ? "2026-09-30" : "" }));
  const statuses = ["submitted", "missing", "excused"];
  const submissions = workItems.flatMap((item, itemIndex) => roster.filter((_, studentIndex) => (studentIndex + itemIndex) % 7 !== 0).map((student, studentIndex) => ({ id: `${item.id}-${student.id}`, classId: "one", workItemId: item.id, studentId: student.id, status: statuses[(studentIndex + itemIndex) % statuses.length] })));
  submissions.push({ id: "cross-class", classId: "two", workItemId: workItems[0].id, studentId: roster[0].id, status: "missing" });
  const started = performance.now();
  const counts = deriveClassWorkCountsByItem({ classId: "one", workItems, students: roster, submissions });
  const elapsed = performance.now() - started;
  assert.equal(counts.size, 240);
  assert.ok(elapsed < 250, `240 item summaries should be calculated in one pass, not by repeatedly filtering ${submissions.length} statuses (${elapsed.toFixed(1)}ms)`);
  for (const index of [0, 1, 119, 239]) {
    const expected = deriveClassWorkSummary({ classId: "one", workItemId: workItems[index].id, students: roster, submissions });
    assert.deepEqual(counts.get(workItems[index].id).counts, expected.counts);
    assert.deepEqual(counts.get(workItems[index].id).activeCounts, expected.activeCounts);
    assert.equal(counts.get(workItems[index].id).archivedCount, expected.archivedCount);
  }
  const due = deriveDueTodayClassWork({ classId: "one", today: "2026-09-30", workItems, students: roster.filter((student) => !student.archivedAt), submissions });
  assert.equal(due.items.length, 3);
  assert.equal(due.counts.submitted + due.counts.missing + due.counts.excused + due.counts["not-recorded"], 150);
});

test("a status edit made after a write snapshot stays dirty instead of being mislabeled saved", () => {
  const original = new Map([["a", ""], ["b", "missing"]]);
  const session = { original, draft: new Map([["a", "submitted"], ["b", "missing"]]), saved: false, dirty: true };
  const persistedSnapshot = new Map(session.draft);
  session.draft.set("a", "");
  commitSubmissionDraftSnapshot(session, persistedSnapshot);
  assert.equal(session.original.get("a"), "submitted", "only the exact persisted snapshot becomes the baseline");
  assert.equal(session.draft.get("a"), "");
  assert.equal(session.saved, true);
  assert.equal(session.dirty, true);
  assert.equal(submissionDraftIsDirty(session.original, session.draft), true);
});

test("report derivation remains responsive for a realistic local class", () => {
  const roster = Array.from({ length: 120 }, (_, index) => ({ id: `s${index}`, classId: "one", fullName: `Student ${index}` }));
  const manyAssessments = Array.from({ length: 40 }, (_, index) => ({ id: `a${index}`, classId: "one", title: `Assessment ${index}`, date: "2026-09-01", maximumScore: "20" }));
  const manyScores = manyAssessments.flatMap((assessment) => roster.map((student, index) => ({ classId: "one", assessmentId: assessment.id, studentId: student.id, rawScore: String(index % 21) })));
  const started = performance.now();
  const output = deriveAssessmentResults({ classId: "one", students: roster, assessments: manyAssessments, scores: manyScores });
  assert.equal(output.reports.length, 40);
  assert.equal(output.reports[0].statistics.recordedCount, 120);
  assert.ok(performance.now() - started < 500, "reports should remain responsive for ordinary class history");
});
