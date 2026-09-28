/** Pure, session-only Classroom Mode logic. No roster names or activity history are persisted. */
export function eligibleStudents(students = []) { return students.filter((student) => student && student.id && student.fullName && !student.archivedAt); }

export function secureRandomIndex(length, cryptoObject = globalThis.crypto, fallback = Math.random) {
  if (!Number.isInteger(length) || length < 1) throw new RangeError("Choose from at least one active student.");
  if (cryptoObject?.getRandomValues) {
    const range = 0x100000000, limit = range - (range % length), values = new Uint32Array(1); let value;
    do { cryptoObject.getRandomValues(values); value = values[0]; } while (value >= limit);
    return value % length;
  }
  return Math.min(length - 1, Math.floor(fallback() * length));
}

export function createPickerState({ avoidRepeats = false } = {}) { return { avoidRepeats: Boolean(avoidRepeats), pickedIds: [], historyIds: [], lastStudentId: null }; }
export function resetPickerRound(picker = createPickerState()) { return { ...picker, pickedIds: [], historyIds: [], lastStudentId: null }; }
export function pickStudent(students, picker = createPickerState(), indexPicker = secureRandomIndex) {
  const eligible = eligibleStudents(students); if (!eligible.length) return { picker: { ...picker, lastStudentId: null }, student: null, complete: false, eligibleCount: 0 };
  const picked = new Set(picker.pickedIds.filter((id) => eligible.some((student) => student.id === id)));
  const choices = picker.avoidRepeats ? eligible.filter((student) => !picked.has(student.id)) : eligible;
  if (!choices.length) return { picker: { ...picker, pickedIds: [...picked], lastStudentId: null }, student: null, complete: true, eligibleCount: eligible.length };
  const student = choices[indexPicker(choices.length)]; const nextPicked = picker.avoidRepeats ? [...picked, student.id] : [...picked];
  return { picker: { ...picker, pickedIds: nextPicked, historyIds: [student.id, ...picker.historyIds.filter((id) => id !== student.id)].slice(0, 8), lastStudentId: student.id }, student, complete: false, eligibleCount: eligible.length };
}

function randomUnit(rng) { const value = Number(rng()); if (!(value >= 0 && value < 1)) throw new RangeError("Random source must return a value from zero up to one."); return value; }
export function shuffled(items, rng = Math.random) { const output = [...items]; for (let index = output.length - 1; index > 0; index -= 1) { const target = Math.floor(randomUnit(rng) * (index + 1)); [output[index], output[target]] = [output[target], output[index]]; } return output; }
export function generateBalancedGroups(students, requestedCount, rng = Math.random) {
  const eligible = eligibleStudents(students), count = Number(requestedCount);
  if (!Number.isInteger(count) || count < 1) throw new RangeError("Enter at least one group.");
  if (!eligible.length) throw new RangeError("Add an active student before making groups.");
  if (count > eligible.length) throw new RangeError("Choose no more groups than active students.");
  const shuffledStudents = shuffled(eligible, rng), base = Math.floor(eligible.length / count), remainder = eligible.length % count, groups = []; let cursor = 0;
  for (let group = 0; group < count; group += 1) { const size = base + (group < remainder ? 1 : 0); groups.push(shuffledStudents.slice(cursor, cursor + size).map((student) => student.id)); cursor += size; }
  return groups;
}
export function groupsPlainText(groups, students) { const byId = new Map(eligibleStudents(students).map((student) => [student.id, student.fullName])); return groups.map((group, index) => `Group ${index + 1}\n${group.map((id) => `- ${byId.get(id) || "Student no longer active"}`).join("\n")}`).join("\n\n"); }

export function createTimer(durationMs = 0) { const duration = Math.max(0, Math.floor(Number(durationMs) || 0)); return { durationMs: duration, remainingMs: duration, deadlineMs: null, status: duration ? "ready" : "idle" }; }
export function timerSnapshot(timer = createTimer(), now = performance.now()) { if (timer.status !== "running" || timer.deadlineMs == null) return { ...timer, remainingMs: Math.max(0, timer.remainingMs) }; const remainingMs = Math.max(0, timer.deadlineMs - now); return remainingMs === 0 ? { ...timer, remainingMs: 0, deadlineMs: null, status: "complete" } : { ...timer, remainingMs }; }
export function startTimer(timer, now = performance.now()) { const current = timerSnapshot(timer, now); if (current.remainingMs <= 0) return { ...current, status: "complete", deadlineMs: null }; return { ...current, deadlineMs: now + current.remainingMs, status: "running" }; }
export function pauseTimer(timer, now = performance.now()) { const current = timerSnapshot(timer, now); return current.status === "running" ? { ...current, deadlineMs: null, status: "paused" } : current; }
export function resetTimer(timer) { return createTimer(timer?.durationMs || 0); }
export function addTimerMinute(timer, now = performance.now()) { const current = timerSnapshot(timer, now), remainingMs = current.remainingMs + 60000; return current.status === "running" ? { ...current, remainingMs, deadlineMs: now + remainingMs } : { ...current, remainingMs, durationMs: Math.max(current.durationMs, remainingMs), status: "ready" }; }
export function formatTimer(milliseconds) { const seconds = Math.ceil(Math.max(0, milliseconds) / 1000), minutes = Math.floor(seconds / 60); return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
