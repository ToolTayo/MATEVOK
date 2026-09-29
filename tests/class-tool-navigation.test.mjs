import assert from "node:assert/strict";
import test from "node:test";
import { resolveClassToolDestination } from "../dist/class-tool-navigation.js";

test("class tool navigation asks a new teacher to create a class when none are active", () => {
  assert.deepEqual(resolveClassToolDestination([]), { kind: "create" });
  assert.deepEqual(resolveClassToolDestination([{ id: "archived", archivedAt: "2026-01-01T00:00:00.000Z" }]), { kind: "create" });
});

test("class tool navigation opens the sole active class directly", () => {
  const onlyClass = { id: "only", className: "Grade 7" };
  assert.deepEqual(resolveClassToolDestination([onlyClass]), { kind: "open", classItem: onlyClass });
});

test("class tool navigation offers only active classes when several are available", () => {
  const first = { id: "first", className: "Science" }, second = { id: "second", className: "Math" };
  const result = resolveClassToolDestination([first, { id: "archived", archivedAt: "2026-01-01T00:00:00.000Z" }, second]);
  assert.equal(result.kind, "choose");
  assert.deepEqual(result.classes, [first, second]);
});
