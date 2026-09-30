import assert from "node:assert/strict";
import test from "node:test";
import { nextAttendanceStatus } from "../dist/attendance-keyboard.js";

const statuses = ["present", "absent", "late", "excused"];

test("attendance arrow keys cycle factual status choices in stable order", () => {
  assert.equal(nextAttendanceStatus("present", "ArrowRight", statuses), "absent");
  assert.equal(nextAttendanceStatus("present", "ArrowDown", statuses), "absent");
  assert.equal(nextAttendanceStatus("excused", "ArrowRight", statuses), "present");
  assert.equal(nextAttendanceStatus("present", "ArrowLeft", statuses), "excused");
  assert.equal(nextAttendanceStatus("present", "ArrowUp", statuses), "excused");
});

test("attendance status cycling ignores unrelated keys and invalid states", () => {
  assert.equal(nextAttendanceStatus("present", "Tab", statuses), null);
  assert.equal(nextAttendanceStatus("unknown", "ArrowRight", statuses), null);
  assert.equal(nextAttendanceStatus("present", "ArrowRight", ["present"]), null);
  assert.equal(nextAttendanceStatus("present", "ArrowRight", []), null);
});
