import assert from "node:assert/strict";
import test from "node:test";
import { acquireWorkspaceLock, createSingleFlight } from "../dist/workspace-lock.js";

test("workspace lock clearly distinguishes unsupported and unavailable browser APIs", async () => {
  assert.equal((await acquireWorkspaceLock(null)).status, "unsupported");
  assert.equal((await acquireWorkspaceLock({ request: async () => { throw new Error("denied"); } })).status, "unavailable");
});

test("only one tab can acquire the workspace lock, and a closed tab releases it", async () => {
  let held = false;
  const locks = { request: (_name, _options, callback) => {
    if (held) return Promise.resolve(callback(null));
    held = true;
    return Promise.resolve(callback({ name: "matevok-workspace-editor" })).finally(() => { held = false; });
  } };
  const first = await acquireWorkspaceLock(locks);
  assert.equal(first.status, "acquired");
  assert.equal((await acquireWorkspaceLock(locks)).status, "busy");
  first.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await acquireWorkspaceLock(locks)).status, "acquired");
});

test("single-flight ignores a repeated submit while a write is pending and unlocks on failure", async () => {
  const runOnce = createSingleFlight();
  let finish;
  let writes = 0;
  const first = runOnce(() => { writes += 1; return new Promise((resolve) => { finish = resolve; }); });
  assert.equal(runOnce(() => { writes += 1; }), null);
  assert.equal(writes, 1);
  finish("saved");
  assert.equal(await first, "saved");
  assert.throws(() => runOnce(() => { writes += 1; throw new Error("storage failure"); }), /storage failure/);
  assert.equal(await runOnce(() => { writes += 1; return "retried"; }), "retried");
  assert.equal(writes, 3);
});

test("application acquires one workspace writer lock before opening IndexedDB and retries after the first tab closes", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../dist/app.js", import.meta.url), "utf8");
  const startup = app.slice(app.indexOf("async function init()"));
  assert.ok(startup.indexOf("await acquireWorkspaceLock()") < startup.indexOf("await getLocalStoreHealth()"), "lock must be acquired before the first storage read");
  assert.match(startup, /lock\.status === "busy"[\s\S]*showModal\(\)[\s\S]*return/);
  assert.match(startup, /data-workspace-retry/);
  assert.match(app, /window\.addEventListener\("pagehide", \(\) => workspaceLock\?\.release\(\)\)/);
  assert.match(app, /keep one MATEVOK tab open to avoid stale edits/);
  assert.match(app, /document\.addEventListener\("submit"[\s\S]*stopImmediatePropagation\(\)/, "repeat form submissions must be stopped while the original operation is pending");
  assert.match(app, /role: "alert", "data-operation-error"/, "persistence errors must be visible in the active dialog or workspace");
});
