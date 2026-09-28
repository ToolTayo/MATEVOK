/**
 * Local, read-only report derivations. These functions deliberately receive
 * canonical records and return display/export data only; nothing is saved.
 */
import { compareDecimal, genericRawPercentage, normalizeDecimalInput, scoreDisplay, sumDecimalStrings } from "./gradebook.js";

const statuses = Object.freeze(["present", "absent", "late", "excused"]);
const byName = (left, right) => String(left.fullName).localeCompare(String(right.fullName), undefined, { sensitivity: "base" });
const classStudents = (classId, students) => students.filter((student) => student.classId === classId).slice().sort(byName);
const inRange = (date, startDate, endDate) => (!startDate || date >= startDate) && (!endDate || date <= endDate);

export function deriveClassRoster({ classId, students = [] }) {
  const rows = classStudents(classId, students).map((student) => Object.freeze({ studentId: student.id, fullName: student.fullName, archived: Boolean(student.archivedAt) }));
  return Object.freeze({ rows, activeCount: rows.filter((row) => !row.archived).length, archivedCount: rows.filter((row) => row.archived).length });
}

export function deriveAttendanceSummary({ classId, students = [], attendance = [], startDate = "", endDate = "" }) {
  const roster = deriveClassRoster({ classId, students });
  const names = new Map(roster.rows.map((student) => [student.studentId, student]));
  const rows = attendance
    .filter((entry) => entry.classId === classId && names.has(entry.studentId) && statuses.includes(entry.status) && inRange(entry.date, startDate, endDate))
    .map((entry) => Object.freeze({ date: entry.date, studentId: entry.studentId, fullName: names.get(entry.studentId).fullName, archived: names.get(entry.studentId).archived, status: entry.status }))
    .sort((left, right) => right.date.localeCompare(left.date) || left.fullName.localeCompare(right.fullName, undefined, { sensitivity: "base" }));
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
  rows.forEach((row) => { counts[row.status] += 1; });
  const dates = new Set(rows.map((row) => row.date));
  return Object.freeze({ rows, counts: Object.freeze(counts), recordedCount: rows.length, dateCount: dates.size, startDate, endDate, roster });
}

function averageDecimal(values) {
  if (!values.length) return null;
  const normalized = values.map((value) => normalizeDecimalInput(value, "Score"));
  const scale = Math.max(...normalized.map((value) => (value.split(".")[1] || "").length));
  const total = normalized.reduce((sum, value) => {
    const [whole, fraction = ""] = value.split(".");
    return sum + BigInt(`${whole}${fraction}`) * (10n ** BigInt(scale - fraction.length));
  }, 0n);
  const divisor = BigInt(values.length);
  const rounded = (total + divisor / 2n) / divisor;
  const text = rounded.toString().padStart(scale + 1, "0");
  return scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1") : text;
}

export function deriveAssessmentResults({ classId, students = [], assessments = [], scores = [], assessmentId = "" }) {
  const roster = deriveClassRoster({ classId, students });
  const studentById = new Map(roster.rows.map((student) => [student.studentId, student]));
  const selected = assessments.filter((assessment) => assessment.classId === classId && (!assessmentId || assessment.id === assessmentId));
  const scoreByKey = new Map(scores.filter((score) => score.classId === classId && studentById.has(score.studentId)).map((score) => [`${score.assessmentId}::${score.studentId}`, score]));
  const reports = selected.map((assessment) => {
    const rows = roster.rows.map((student) => {
      const score = scoreByKey.get(`${assessment.id}::${student.studentId}`);
      const display = scoreDisplay(score?.rawScore, assessment.maximumScore);
      return Object.freeze({ studentId: student.studentId, fullName: student.fullName, archived: student.archived, entered: display.entered, rawScore: display.entered ? score.rawScore : null, maximumScore: assessment.maximumScore, percentage: display.percentage?.display || null, valid: !display.error });
    });
    const recorded = rows.filter((row) => row.entered && row.valid);
    const rawScores = recorded.map((row) => row.rawScore);
    const totalRaw = rawScores.length ? sumDecimalStrings(rawScores) : "0";
    const totalMaximum = rawScores.length ? sumDecimalStrings(recorded.map(() => assessment.maximumScore)) : "0";
    const minimum = rawScores.length ? rawScores.reduce((minimumScore, value) => compareDecimal(value, minimumScore) < 0 ? value : minimumScore) : null;
    const maximum = rawScores.length ? rawScores.reduce((maximumScore, value) => compareDecimal(value, maximumScore) > 0 ? value : maximumScore) : null;
    return Object.freeze({ assessment, rows, statistics: Object.freeze({ totalStudents: rows.length, recordedCount: recorded.length, missingCount: rows.length - recorded.length, minimum, maximum, mean: averageDecimal(rawScores), totalRaw, totalMaximum, aggregate: rawScores.length ? genericRawPercentage(totalRaw, totalMaximum) : null }) });
  });
  return Object.freeze({ reports: Object.freeze(reports), roster });
}

export function deriveClassOverview({ classId, students = [], attendance = [], assessments = [], scores = [], lessons = [] }) {
  const roster = deriveClassRoster({ classId, students });
  const studentIds = new Set(roster.rows.map((student) => student.studentId));
  const classAssessments = assessments.filter((assessment) => assessment.classId === classId);
  const assessmentIds = new Set(classAssessments.map((assessment) => assessment.id));
  const attendanceCount = attendance.filter((entry) => entry.classId === classId && studentIds.has(entry.studentId) && statuses.includes(entry.status)).length;
  const scoreCount = scores.filter((score) => score.classId === classId && studentIds.has(score.studentId) && assessmentIds.has(score.assessmentId)).length;
  return Object.freeze({ activeStudents: roster.activeCount, archivedStudents: roster.archivedCount, totalStudents: roster.rows.length, attendanceRecords: attendanceCount, attendanceDates: new Set(attendance.filter((entry) => entry.classId === classId && studentIds.has(entry.studentId)).map((entry) => entry.date)).size, assessments: classAssessments.length, recordedScores: scoreCount, missingScores: Math.max(0, classAssessments.length * roster.rows.length - scoreCount), lessons: lessons.filter((lesson) => lesson.classId === classId).length });
}

export function csvEscape(value) {
  let text = value == null ? "" : String(value);
  if (/^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

export function rosterCsv(report) {
  return toCsv(["Student name", "Roster status"], report.rows.map((row) => [row.fullName, row.archived ? "Archived" : "Active"]));
}

export function attendanceCsv(report) {
  return toCsv(["Date", "Student name", "Roster status", "Attendance status"], report.rows.map((row) => [row.date, row.fullName, row.archived ? "Archived" : "Active", row.status]));
}

export function assessmentCsv(report) {
  return toCsv(["Assessment", "Date", "Student name", "Roster status", "Raw score", "Maximum score", "Raw percentage", "Score status"], report.rows.map((row) => [report.assessment.title, report.assessment.date, row.fullName, row.archived ? "Archived" : "Active", row.entered ? row.rawScore : "", row.maximumScore, row.percentage || "", row.entered ? "Recorded" : "Missing"]));
}
