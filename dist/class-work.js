/** Factual class-work submission derivations. A missing status record is never inferred as Missing. */
export const WORK_SUBMISSION_STATUSES = Object.freeze(["submitted", "missing", "excused"]);
export const WORK_SUBMISSION_LABELS = Object.freeze({ submitted: "Submitted", missing: "Missing", excused: "Excused", "not-recorded": "Not recorded" });

export function deriveClassWorkSummary({ classId, workItemId, students = [], submissions = [] }) {
  const roster = students.filter((student) => student.classId === classId).slice().sort((a, b) => String(a.fullName).localeCompare(String(b.fullName), undefined, { sensitivity: "base" }));
  const ids = new Set(roster.map((student) => student.id)), statusByStudent = new Map();
  submissions.filter((entry) => entry.classId === classId && entry.workItemId === workItemId && ids.has(entry.studentId) && WORK_SUBMISSION_STATUSES.includes(entry.status)).forEach((entry) => {
    if (!statusByStudent.has(entry.studentId)) statusByStudent.set(entry.studentId, entry.status);
  });
  const rows = roster.map((student) => Object.freeze({ studentId: student.id, fullName: student.fullName, archived: Boolean(student.archivedAt), status: statusByStudent.get(student.id) || "not-recorded" }));
  const countRows = (source) => Object.freeze(Object.fromEntries(["submitted", "missing", "excused", "not-recorded"].map((status) => [status, source.filter((row) => row.status === status).length])));
  const activeRows = rows.filter((row) => !row.archived);
  return Object.freeze({ rows: Object.freeze(rows), counts: countRows(rows), activeCounts: countRows(activeRows), activeCount: activeRows.length, archivedCount: rows.length - activeRows.length });
}

/** Count several work items in one pass instead of rescanning the class history per card. */
export function deriveClassWorkCountsByItem({ classId, workItems = [], students = [], submissions = [] }) {
  const roster = students.filter((student) => student.classId === classId), studentsById = new Map(roster.map((student) => [student.id, Boolean(student.archivedAt)]));
  const zeroCounts = () => ({ submitted: 0, missing: 0, excused: 0, "not-recorded": 0 });
  const summaries = new Map();
  workItems.forEach((item) => {
    if (item.classId === classId && item.id) summaries.set(item.id, { counts: zeroCounts(), activeCounts: zeroCounts(), activeCount: 0, archivedCount: 0, seen: new Set() });
  });
  let activeCount = 0, archivedCount = 0;
  studentsById.forEach((archived) => { if (archived) archivedCount += 1; else activeCount += 1; });
  summaries.forEach((summary) => { summary.activeCount = activeCount; summary.archivedCount = archivedCount; });
  submissions.forEach((entry) => {
    if (entry.classId !== classId || !WORK_SUBMISSION_STATUSES.includes(entry.status) || !studentsById.has(entry.studentId)) return;
    const summary = summaries.get(entry.workItemId);
    if (!summary || summary.seen.has(entry.studentId)) return;
    summary.seen.add(entry.studentId);
    summary.counts[entry.status] += 1;
    if (!studentsById.get(entry.studentId)) summary.activeCounts[entry.status] += 1;
  });
  summaries.forEach((summary) => {
    summary.counts["not-recorded"] = roster.length - summary.seen.size;
    summary.activeCounts["not-recorded"] = summary.activeCount - Object.values(summary.activeCounts).reduce((total, count) => total + count, 0);
    delete summary.seen;
    Object.freeze(summary.counts); Object.freeze(summary.activeCounts); Object.freeze(summary);
  });
  return summaries;
}

export function submissionDraftIsDirty(original, draft) {
  return [...draft].some(([studentId, status]) => original.get(studentId) !== status);
}

/** Commit only the snapshot that actually reached storage; later draft edits stay dirty. */
export function commitSubmissionDraftSnapshot(session, persistedSnapshot) {
  session.original = new Map(persistedSnapshot);
  session.saved = true;
  session.dirty = submissionDraftIsDirty(session.original, session.draft);
  return session.dirty;
}

export function deriveStudentWorkHistory({ classId, student, workItems = [], submissions = [] }) {
  if (!student?.id) return Object.freeze([]);
  const statusByItem = new Map(submissions.filter((entry) => entry.classId === classId && entry.studentId === student.id && WORK_SUBMISSION_STATUSES.includes(entry.status)).map((entry) => [entry.workItemId, entry.status]));
  return Object.freeze(workItems.filter((item) => item.classId === classId).slice().sort((a, b) => (b.dueDate || b.updatedAt || "").localeCompare(a.dueDate || a.updatedAt || "") || a.title.localeCompare(b.title, undefined, { sensitivity: "base" })).map((item) => Object.freeze({ workItemId: item.id, title: item.title, dueDate: item.dueDate || "", assessmentId: item.assessmentId || null, status: statusByItem.get(item.id) || "not-recorded" })));
}

export function deriveDueTodayClassWork({ classId, today, workItems = [], students = [], submissions = [] }) {
  const due = workItems.filter((item) => item.classId === classId && item.dueDate === today);
  const counts = { submitted: 0, missing: 0, excused: 0, "not-recorded": 0 };
  const summaries = deriveClassWorkCountsByItem({ classId, workItems: due, students, submissions });
  due.forEach((item) => {
    const summary = summaries.get(item.id);
    Object.keys(counts).forEach((status) => { counts[status] += summary.activeCounts[status]; });
  });
  return Object.freeze({ items: Object.freeze(due), counts: Object.freeze(counts) });
}
