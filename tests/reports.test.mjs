import assert from "node:assert/strict";
import test from "node:test";
import { assessmentCsv, attendanceCsv, csvEscape, deriveAssessmentResults, deriveAttendanceSummary, deriveClassOverview, deriveClassRoster, rosterCsv } from "../dist/reports.js";

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
