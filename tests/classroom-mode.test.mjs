import assert from "node:assert/strict";
import test from "node:test";
import { addTimerMinute, createPickerState, createTimer, eligibleStudents, formatTimer, generateBalancedGroups, generateBalancedGroupsBySize, groupsPlainText, pauseTimer, pickStudent, resetPickerRound, resetTimer, shuffled, startTimer, timerSnapshot } from "../dist/classroom.js";

const roster = (count, archived = []) => Array.from({ length: count }, (_, index) => ({ id: `student-${index + 1}`, fullName: index === 0 ? "<script>alert(1)</script> & \"Student\"" : `Student ${index + 1}`, archivedAt: archived.includes(index + 1) ? "2026-09-28T00:00:00.000Z" : null }));
const sequenceRng = (...values) => { let index = 0; return () => values[index++ % values.length]; };
const firstIndex = () => 0;

test("eligible roster selection excludes archived students and picker state stays ID-only", () => {
  const students = roster(3, [2]); const eligible = eligibleStudents(students); assert.deepEqual(eligible.map((student) => student.id), ["student-1", "student-3"]);
  const result = pickStudent(students, createPickerState(), firstIndex); assert.equal(result.student.id, "student-1"); assert.deepEqual(result.picker.historyIds, ["student-1"]); assert.equal(JSON.stringify(result.picker).includes("alert(1)"), false);
});

test("avoid-repeat picker completes only after each active student and reset starts a new round", () => {
  const students = roster(3); let picker = createPickerState({ avoidRepeats: true }); const picked = [];
  for (let index = 0; index < 3; index += 1) { const result = pickStudent(students, picker, firstIndex); picker = result.picker; picked.push(result.student.id); }
  assert.deepEqual(picked, ["student-1", "student-2", "student-3"]); const complete = pickStudent(students, picker, firstIndex); assert.equal(complete.complete, true); assert.equal(complete.student, null); picker = resetPickerRound(picker); assert.deepEqual(picker.pickedIds, []); assert.deepEqual(picker.historyIds, []); assert.equal(pickStudent(roster(1), createPickerState({ avoidRepeats: true }), firstIndex).student.id, "student-1");
});

test("balanced groups are deterministic with injected RNG, complete, unique, and reject awkward counts", () => {
  const students = roster(5, [5]); const groups = generateBalancedGroups(students, 2, sequenceRng(.1, .8, .2, .7)); const ids = groups.flat(); assert.equal(new Set(ids).size, 4); assert.deepEqual(new Set(ids), new Set(["student-1", "student-2", "student-3", "student-4"])); assert.deepEqual(groups.map((group) => group.length).sort(), [2, 2]);
  const uneven = generateBalancedGroups(roster(41), 6, () => 0); assert.deepEqual(uneven.map((group) => group.length).sort((a, b) => a - b), [6, 7, 7, 7, 7, 7]); assert.equal(generateBalancedGroups(roster(42), 7, () => 0).every((group) => group.length === 6), true);
  assert.throws(() => generateBalancedGroups(roster(3), 5), /no more groups/); assert.throws(() => generateBalancedGroups(roster(3), 0), /at least one/); assert.throws(() => generateBalancedGroups([], 1), /active student/); assert.match(groupsPlainText(groups, students), /Group 1/); assert.match(groupsPlainText(groups, students), /<script>alert\(1\)<\/script>/);
});

test("students-per-group mode balances awkward rosters without exceeding the requested maximum", () => {
  const students = roster(39, [39]);
  const groups38 = generateBalancedGroupsBySize(students, 4, () => 0);
  const sizes38 = groups38.map((group) => group.length).sort((a, b) => a - b);
  const ids38 = groups38.flat();
  assert.equal(groups38.length, 10);
  assert.deepEqual(sizes38, [3, 3, 4, 4, 4, 4, 4, 4, 4, 4]);
  assert.equal(sizes38.at(-1) - sizes38[0] <= 1, true);
  assert.equal(new Set(ids38).size, 38);
  assert.deepEqual(new Set(ids38), new Set(students.slice(0, 38).map((student) => student.id)));
  assert.equal(groups38.every((group) => group.length > 0 && group.length <= 4), true);
  assert.deepEqual(generateBalancedGroupsBySize(students, "4", () => 0), groups38, "injected RNG preserves deterministic shuffle behavior");

  const groups5 = generateBalancedGroupsBySize(roster(5), 2, () => 0);
  assert.deepEqual(groups5.map((group) => group.length).sort(), [1, 2, 2]);
  assert.equal(new Set(groups5.flat()).size, 5);
  assert.deepEqual(generateBalancedGroupsBySize(roster(1), 1, () => 0), [["student-1"]]);
  assert.deepEqual(generateBalancedGroupsBySize(roster(2), 2, () => 0).map((group) => group.length), [2]);
});

test("students-per-group mode rejects invalid sizes and excludes archived students", () => {
  const active = roster(5, [2]);
  assert.throws(() => generateBalancedGroupsBySize(active, 0), /whole-number maximum group size/);
  assert.throws(() => generateBalancedGroupsBySize(active, -1), /whole-number maximum group size/);
  assert.throws(() => generateBalancedGroupsBySize(active, 2.5), /whole-number maximum group size/);
  assert.throws(() => generateBalancedGroupsBySize(active, "2.5"), /whole-number maximum group size/);
  assert.throws(() => generateBalancedGroupsBySize(active, 5), /cannot exceed the 4 active students/);
  assert.throws(() => generateBalancedGroupsBySize([], 1), /active student/);
  const groups = generateBalancedGroupsBySize(active, 2, () => 0);
  const ids = groups.flat();
  assert.equal(new Set(ids).size, 4);
  assert.equal(ids.includes("student-2"), false);
  assert.equal(groups.every((group) => group.length <= 2), true);
});

test("shuffle is deterministic with an injected RNG and rejects an invalid random source", () => {
  assert.deepEqual(shuffled(["a", "b", "c"], sequenceRng(0, 0)), ["b", "c", "a"]); assert.throws(() => shuffled(["a", "b"], () => 1), /zero up to one/);
});

test("deadline timer corrects delayed ticks, pauses, resumes, resets, and never goes negative", () => {
  let timer = createTimer(60000); assert.equal(formatTimer(timer.remainingMs), "01:00"); timer = startTimer(timer, 1000); assert.equal(timer.status, "running"); assert.equal(timerSnapshot(timer, 16000).remainingMs, 45000);
  timer = pauseTimer(timer, 21000); assert.deepEqual({ status: timer.status, remainingMs: timer.remainingMs }, { status: "paused", remainingMs: 40000 }); assert.equal(timerSnapshot(timer, 1000000).remainingMs, 40000);
  timer = startTimer(timer, 30000); assert.equal(timerSnapshot(timer, 70001).status, "complete"); assert.equal(timerSnapshot(timer, 70001).remainingMs, 0); assert.equal(formatTimer(-5), "00:00");
  timer = resetTimer({ ...timer, durationMs: 60000 }); assert.deepEqual({ status: timer.status, remainingMs: timer.remainingMs }, { status: "ready", remainingMs: 60000 }); assert.equal(addTimerMinute(createTimer(), 0).remainingMs, 60000); assert.equal(startTimer(createTimer(), 0).status, "complete");
});

test("class-sized random operations stay practical for 1, 3, 40, 60, and 100 students", () => {
  const started = performance.now(); for (const count of [1, 3, 40, 60, 100]) { const students = roster(count); const groups = generateBalancedGroups(students, Math.min(count, 7), () => .499); assert.equal(groups.flat().length, count); let picker = createPickerState({ avoidRepeats: true }); for (let index = 0; index < count; index += 1) picker = pickStudent(students, picker, firstIndex).picker; assert.equal(picker.pickedIds.length, count); }
  assert.ok(performance.now() - started < 200, "classroom session operations should feel instantaneous");
});

test("independent classroom sessions never mix roster identifiers", () => {
  const classA = roster(3); const classB = roster(3).map((student) => ({ ...student, id: `other-${student.id}` })); const groupsA = generateBalancedGroups(classA, 2, () => 0); const groupsB = generateBalancedGroups(classB, 2, () => 0);
  assert.equal(groupsA.flat().every((id) => id.startsWith("student-")), true); assert.equal(groupsB.flat().every((id) => id.startsWith("other-student-")), true);
  const pickerA = pickStudent(classA, createPickerState({ avoidRepeats: true }), firstIndex).picker; const pickerB = pickStudent(classB, createPickerState({ avoidRepeats: true }), firstIndex).picker; assert.deepEqual(pickerA.pickedIds, ["student-1"]); assert.deepEqual(pickerB.pickedIds, ["other-student-1"]);
});
