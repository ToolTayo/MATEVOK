import assert from "node:assert/strict";
import test from "node:test";
import { acquireWorkspaceLock, createSingleFlight, createWorkspaceEditorLease, WORKSPACE_OWNER_KEY } from "../dist/workspace-lock.js";

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

test("an explicit takeover token invalidates the previous editor without touching classroom data", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  const first = createWorkspaceEditorLease(storage, "first-editor"), second = createWorkspaceEditorLease(storage, "second-editor");
  assert.equal(first.canCoordinate(), true);
  assert.equal(first.claim(), true);
  assert.equal(first.isOwner(), true);
  assert.equal(second.claim(), true);
  assert.equal(first.isOwner(), false, "a suspended old document must synchronously detect a different owner token");
  first.release();
  assert.equal(second.isOwner(), true, "closing the old document must not remove the new editor token");
  assert.equal(values.get(WORKSPACE_OWNER_KEY), "second-editor");
  second.release();
  assert.equal(values.has(WORKSPACE_OWNER_KEY), false);
});

test("a browser-revoked lock notifies its holder and releases the pending request", async () => {
  let revoke;
  let requestedOptions;
  const locks = { request: (_name, options, callback) => {
    requestedOptions = options;
    const callbackWork = Promise.resolve(callback({ name: "matevok-workspace-editor" }));
    return new Promise((resolve, reject) => { revoke = reject; callbackWork.then(resolve, reject); });
  } };
  let lostCount = 0;
  const owner = await acquireWorkspaceLock(locks, undefined, { onLost: () => { lostCount += 1; } });
  assert.equal(owner.status, "acquired");
  assert.deepEqual(requestedOptions, { mode: "exclusive", ifAvailable: true }, "normal ownership must never forcibly steal an active writer");
  revoke(new DOMException("Synthetic browser revocation", "AbortError"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lostCount, 1);
  assert.equal(owner.status, "lost", "a caller must not mistake a revoked lifetime lock for active write permission");
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

test("application gates writes on lock ownership and makes takeover/recovery explicit", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../dist/app.js", import.meta.url), "utf8");
  const storage = await readFile(new URL("../dist/storage.js", import.meta.url), "utf8");
  const startup = app.slice(app.indexOf("async function init("));
  assert.ok(startup.indexOf("await acquireWorkspaceLock(") < startup.indexOf("await getLocalStoreHealth()"), "lock must be acquired before the first storage read");
  assert.match(startup, /lock\.status === "busy"[\s\S]*showWorkspaceBusy\(recoveringLostWindow\)[\s\S]*return/);
  assert.match(app, /data-workspace-retry/);
  assert.match(app, /data-workspace-takeover/);
  assert.match(app, /acquireWorkspaceLock\(undefined, WORKSPACE_RECOVERY_LOCK\)/, "takeover confirmation must be serialized independently from editor ownership");
  assert.match(app, /Another window is already recovering the workspace/);
  assert.match(startup, /onLost:/);
  assert.ok(startup.includes("lostBeforeStartupResumed = true"), "a lock revoked during startup must not be ignored before the lock object is assigned");
  assert.match(app, /window\.addEventListener\("pagehide", \(\) => \{[\s\S]*workspaceLock\?\.release\(\)/);
  assert.match(app, /setLocalWritePermission\(hasEditorAccess\)/);
  assert.match(app, /MATEVOK_RELOAD_PEERS_FOR_TAKEOVER/);
  assert.match(app, /workspaceLease\.isOwner\(\)/);
  assert.match(storage, /function writeTransaction\(db, stores\) \{ if \(!writePermission\(\)\) throw new LocalStorageError/);
  assert.equal((storage.match(/db\.transaction\([^;]*"readwrite"/g) || []).length, 1, "all writes must go through the guarded transaction helper");
  assert.match(app, /document\.addEventListener\("submit"[\s\S]*stopImmediatePropagation\(\)/, "repeat form submissions must be stopped while the original operation is pending");
  assert.match(app, /role: "alert", "data-operation-error"/, "persistence errors must be visible in the active dialog or workspace");
});
