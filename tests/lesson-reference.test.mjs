import assert from "node:assert/strict";
import test from "node:test";
import { selectLessonReference } from "../dist/lesson-reference.js";

const lesson = (id, classId, date, updatedAt, title = id) => ({ id, classId, date, updatedAt, title });

test("today prefers an exactly dated class lesson over a more recently edited plan", () => {
  const current = lesson("today", "class-a", "2026-09-30", "2026-09-20T08:00:00.000Z");
  const later = lesson("later", "class-a", "2026-10-01", "2026-09-30T08:00:00.000Z");
  const result = selectLessonReference({ classId: "class-a", lessons: [later, current], localDate: "2026-09-30" });

  assert.equal(result.lesson, current);
  assert.equal(result.scheduledToday, true);
});

test("multiple same-day lessons resolve deterministically to the most recently updated one", () => {
  const first = lesson("first", "class-a", "2026-09-30", "2026-09-28T08:00:00.000Z");
  const second = lesson("second", "class-a", "2026-09-30", "2026-09-29T08:00:00.000Z");
  const result = selectLessonReference({ classId: "class-a", lessons: [first, second], localDate: "2026-09-30" });

  assert.equal(result.lesson, second);
  assert.equal(result.scheduledToday, true);
});

test("when no lesson is dated today the class's most recently edited lesson is the fallback", () => {
  const older = lesson("older", "class-a", "2026-09-25", "2026-09-27T08:00:00.000Z");
  const newer = lesson("newer", "class-a", "", "2026-09-29T08:00:00.000Z");
  const result = selectLessonReference({ classId: "class-a", lessons: [older, newer], localDate: "2026-09-30" });

  assert.equal(result.lesson, newer);
  assert.equal(result.scheduledToday, false);
});

test("an older-dated lesson edited today wins the fallback without being presented as today's scheduled plan", () => {
  const olderDateEditedToday = lesson("edited-today", "class-a", "2026-09-24", "2026-09-30T09:00:00.000Z");
  const futureDraft = lesson("future", "class-a", "2026-10-02", "2026-09-29T09:00:00.000Z");
  const result = selectLessonReference({ classId: "class-a", lessons: [futureDraft, olderDateEditedToday], localDate: "2026-09-30" });

  assert.equal(result.lesson, olderDateEditedToday);
  assert.equal(result.scheduledToday, false);
});

test("lesson reference selection stays class-scoped, handles empty input, and does not reorder records", () => {
  const local = lesson("local", "class-a", "2026-09-29", "2026-09-28T08:00:00.000Z");
  const foreign = lesson("foreign", "class-b", "2026-09-30", "2026-09-30T08:00:00.000Z");
  const records = [foreign, local];

  assert.equal(selectLessonReference({ classId: "class-a", lessons: records, localDate: "2026-09-30" }).lesson, local);
  assert.deepEqual(records, [foreign, local]);
  assert.deepEqual(selectLessonReference({ classId: "class-a", lessons: [], localDate: "2026-09-30" }), { lesson: null, scheduledToday: false });
  assert.deepEqual(selectLessonReference({ classId: "class-a", lessons: null, localDate: "2026-09-30" }), { lesson: null, scheduledToday: false });
  assert.deepEqual(selectLessonReference({ classId: "", lessons: [local], localDate: "2026-09-30" }), { lesson: null, scheduledToday: false });
});
