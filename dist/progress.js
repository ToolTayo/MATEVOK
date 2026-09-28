/** Deterministic, factual student-progress derivation. No records are persisted here. */
import { genericRawPercentage, scoreDisplay, sumDecimalStrings } from "./gradebook.js";

export const ATTENDANCE_STATUSES = Object.freeze(["present", "absent", "late", "excused"]);
export function attendanceSummary(entries = []) {
  const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0]));
  entries.forEach((entry) => { if (ATTENDANCE_STATUSES.includes(entry?.status)) counts[entry.status] += 1; });
  const recorded = entries.length, rateDenominator = counts.present + counts.late;
  return Object.freeze({ counts, recorded, rateDenominator, attendanceRate: rateDenominator ? `${genericRawPercentage(String(rateDenominator), String(recorded)).display}` : null });
}
export function deriveStudentProgress({ student, classId, attendance = [], assessments = [], scores = [] }) {
  const attendanceEntries = attendance.filter((entry) => entry.classId === classId && entry.studentId === student.id).sort((a, b) => b.date.localeCompare(a.date));
  const scoreByAssessment = new Map(scores.filter((score) => score.classId === classId && score.studentId === student.id).map((score) => [score.assessmentId, score]));
  const assessmentHistory = assessments.filter((assessment) => assessment.classId === classId).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)).map((assessment) => { const score = scoreByAssessment.get(assessment.id); const display = score ? scoreDisplay(score.rawScore, assessment.maximumScore) : null; return Object.freeze({ assessmentId: assessment.id, title: assessment.title, date: assessment.date, maximumScore: assessment.maximumScore, entered: Boolean(score), rawScore: score?.rawScore ?? null, percentage: display?.percentage ?? null, scoreLabel: display?.label ?? "No score entered" }); });
  const recorded = assessmentHistory.filter((entry) => entry.entered); const totalRaw = recorded.length ? sumDecimalStrings(recorded.map((entry) => entry.rawScore)) : null; const totalMaximum = recorded.length ? sumDecimalStrings(recorded.map((entry) => entry.maximumScore)) : null;
  return Object.freeze({ student, attendance: attendanceEntries, attendanceSummary: attendanceSummary(attendanceEntries), assessments: assessmentHistory, scoreSummary: Object.freeze({ recordedCount: recorded.length, missingCount: assessmentHistory.length - recorded.length, totalRaw, totalMaximum, aggregate: recorded.length && recorded.every((entry) => entry.percentage) ? genericRawPercentage(totalRaw, totalMaximum) : null }) });
}
