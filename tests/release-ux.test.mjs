import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../dist/styles.css", import.meta.url), "utf8");
const headers = readFileSync(new URL("../dist/_headers", import.meta.url), "utf8");

test("first-use guidance explains the reusable local teacher workflow without sample records", () => {
  assert.match(app, /function firstUseGuide\(\)/);
  assert.match(app, /Create a class/);
  assert.match(app, /Add students once/);
  assert.match(app, /Attendance, Gradebook, Assessments, Lessons, Classroom Mode, Progress, or Reports/);
  assert.doesNotMatch(app, /Sample class|Demo class|Sample student|Demo student/);
  assert.doesNotMatch(app, /Your workspace is ready/);
});

test("workspace context, dialog return focus, and small-screen dialog scrolling remain available", () => {
  assert.match(html, /data-current-location>My Classes/);
  assert.match(app, /function setWorkspaceLocation\(label\)/);
  assert.match(app, /dialogReturnFocus: \{\}/);
  assert.match(app, /state\.dialogReturnFocus\[name\]/);
  assert.match(app, /delete state\.dialogReturnFocus\[name\]/);
  assert.match(app, /button:not\(\.icon-button\):not\(\.button--danger\)/);
  assert.match(css, /dialog \{[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/);
  assert.match(css, /@media \(max-width: 700px\) \{ \.first-use-steps \{ grid-template-columns: 1fr;/);
  assert.match(css, /@media \(max-width: 700px\) \{ \.status-button, \.attendance-date input, \.score-input/);
});

test("strict same-origin CSP does not block startup recovery or the cached shell", () => {
  assert.match(headers, /script-src 'self'/);
  assert.match(html, /<script src="startup\.js\?v=14"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(app, /serviceWorker\.register/);
});
