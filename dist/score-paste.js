import { validateScoreInput } from "./gradebook.js";

function pastedLines(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

function normalizedScore(value, maximumScore) {
  const result = validateScoreInput(value, maximumScore);
  return result.error || !result.entered ? null : result.rawScore;
}

/**
 * Creates a non-persistent, roster-ordered review of pasted score values.
 * Blank or missing lines never become score updates; only a confirmed UI action
 * may apply the returned `shouldApply` entries to the in-memory score draft.
 */
export function reviewPastedScores({ text, rows, original = new Map(), maximumScore }) {
  const lines = pastedLines(text);
  const review = rows.map((row, index) => {
    const hasLine = index < lines.length;
    const pasted = hasLine ? lines[index] : "";
    const current = String(row.rawScore ?? "");
    const currentNormalized = normalizedScore(current, maximumScore);
    const originalNormalized = normalizedScore(original.get(row.studentId) ?? "", maximumScore);
    const line = index + 1;

    if (!hasLine || pasted.trim() === "") return { studentId: row.studentId, fullName: row.fullName, line, hasLine, current, pasted, kind: "blank", result: "Blank ignored", shouldApply: false };

    const validation = validateScoreInput(pasted, maximumScore);
    if (validation.error) return { studentId: row.studentId, fullName: row.fullName, line, hasLine, current, pasted, kind: "invalid", result: `Invalid · ${validation.error}`, error: validation.error, shouldApply: false };

    const value = validation.rawScore;
    if (currentNormalized === value) return { studentId: row.studentId, fullName: row.fullName, line, hasLine, current, pasted, value, kind: "unchanged", result: "Unchanged", shouldApply: false };
    const replacesUnsavedEdit = current !== String(original.get(row.studentId) ?? "") && currentNormalized !== originalNormalized;
    if (currentNormalized == null || current === "") return { studentId: row.studentId, fullName: row.fullName, line, hasLine, current, pasted, value, kind: "new", result: "New", shouldApply: true };
    return { studentId: row.studentId, fullName: row.fullName, line, hasLine, current, pasted, value, kind: "changed", result: replacesUnsavedEdit ? "Changed · replaces unsaved edit" : "Changed", replacesUnsavedEdit, shouldApply: true };
  });
  const extraLines = lines.slice(rows.length).map((value, offset) => ({ line: rows.length + offset + 1, value }));
  const invalid = review.filter((entry) => entry.kind === "invalid");
  const changes = review.filter((entry) => entry.shouldApply);
  return Object.freeze({ lines, review, extraLines, invalid, changes, canApply: Boolean(changes.length) && !invalid.length && !extraLines.length });
}
