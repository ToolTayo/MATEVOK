import assert from "node:assert/strict";
import test from "node:test";
import { reviewPastedScores } from "../dist/score-paste.js";

const rows = [
  { studentId: "student-1", fullName: "Ava", rawScore: "" },
  { studentId: "student-2", fullName: "Ben", rawScore: "4" },
  { studentId: "student-3", fullName: "Cara", rawScore: "5" }
];

test("pasted scores preserve zero, decimals, blanks, roster order, and existing draft edits", () => {
  const draft = rows.map((row) => ({ ...row }));
  draft[2].rawScore = "6";
  const review = reviewPastedScores({ text: "0\n4\n\n", rows: draft, original: new Map([["student-1", ""], ["student-2", "4"], ["student-3", "5"]]), maximumScore: "10" });

  assert.equal(review.review[0].value, "0");
  assert.equal(review.review[0].kind, "new");
  assert.equal(review.review[1].kind, "unchanged");
  assert.equal(review.review[2].kind, "blank");
  assert.equal(review.review[2].result, "Blank ignored");
  assert.equal(review.review[2].shouldApply, false);
  assert.equal(review.changes.length, 1);
  assert.equal(review.canApply, true);
});

test("pasted scores flag invalid and extra lines before anything can be applied", () => {
  const invalid = reviewPastedScores({ text: "8\n-1\n10.0001", rows, maximumScore: "10" });
  assert.equal(invalid.invalid.length, 2);
  assert.match(invalid.review[1].result, /Score cannot be negative/);
  assert.equal(invalid.review[2].line, 3);
  assert.equal(invalid.canApply, false);

  const extra = reviewPastedScores({ text: "8\n7\n6\n5", rows, maximumScore: "10" });
  assert.deepEqual(extra.extraLines, [{ line: 4, value: "5" }]);
  assert.equal(extra.canApply, false);
});

test("pasted scores make fewer lines safe and identify conflicts with unsaved edits", () => {
  const draft = rows.map((row) => ({ ...row }));
  draft[1].rawScore = "7";
  const review = reviewPastedScores({ text: "8.5\n6", rows: draft, original: new Map([["student-1", ""], ["student-2", "4"], ["student-3", "5"]]), maximumScore: "10" });

  assert.equal(review.review[0].value, "8.5");
  assert.equal(review.review[1].replacesUnsavedEdit, true);
  assert.match(review.review[1].result, /replaces unsaved edit/);
  assert.equal(review.review[2].kind, "blank");
  assert.equal(review.review[2].hasLine, false);
  assert.equal(review.canApply, true);
});

test("pasted score review remains practical for a realistic active roster", () => {
  const roster = Array.from({ length: 40 }, (_, index) => ({ studentId: `student-${index}`, fullName: `Student ${index + 1}`, rawScore: "" }));
  const started = performance.now();
  const review = reviewPastedScores({ text: Array.from({ length: 40 }, (_, index) => String(index % 11)).join("\n"), rows: roster, maximumScore: "10" });
  assert.equal(review.changes.length, 40);
  assert.equal(review.canApply, true);
  assert.ok(performance.now() - started < 100);
});
