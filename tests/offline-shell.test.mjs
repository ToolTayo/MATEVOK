import assert from "node:assert/strict";
import test from "node:test";

const events = new Map();
const cached = new Map();
const deleted = [];
const cache = {
  async addAll(resources) {
    for (const resource of resources) cached.set(resource, new Response(`cached:${resource}`));
  },
  async put(request, response) {
    cached.set(typeof request === "string" ? request : request.url, response);
  }
};

globalThis.self = {
  location: { origin: "https://teacher-workspace.test" },
  addEventListener: (name, handler) => events.set(name, handler),
  skipWaiting: async () => undefined,
  clients: { claim: async () => undefined }
};
globalThis.caches = {
  open: async () => cache,
  keys: async () => ["teacher-workspace-shell-v13", "old-shell", "teacher-workspace-shell-v14"],
  delete: async (key) => { deleted.push(key); return true; },
  match: async (request) => cached.get(typeof request === "string" ? request : request.url)
};
globalThis.fetch = async () => { throw new Error("offline"); };

await import(new URL("../dist/sw.js?test=offline-shell", import.meta.url));

test("offline shell installs only public application assets and removes stale v13 caches", async () => {
  let installWork;
  events.get("install")({ waitUntil: (work) => { installWork = work; } });
  await installWork;
  assert.equal(cached.has("./index.html"), true);
  assert.equal(cached.has("./startup.js?v=14"), true);
  assert.equal(cached.has("./app.js?v=14"), true);
  assert.equal(cached.has("./storage.js"), true);
  assert.equal(cached.has("./gradebook.js"), true);
  assert.equal(cached.has("./score-paste.js"), true);
  assert.equal(cached.has("./class-tool-navigation.js"), true);
  assert.equal(cached.has("./classroom.js"), true);
  assert.equal(cached.has("./reports.js"), true);
  assert.equal([...cached.keys()].some((key) => /^\.\/(?:students|attendance|scores)(?:\/|$)/i.test(key)), false);

  let activateWork;
  events.get("activate")({ waitUntil: (work) => { activateWork = work; } });
  await activateWork;
  assert.deepEqual(deleted, ["teacher-workspace-shell-v13", "old-shell"]);
});

test("offline navigation falls back to the cached application shell", async () => {
  let responseWork;
  events.get("fetch")({
    request: { method: "GET", url: "https://teacher-workspace.test/a-future-route", mode: "navigate" },
    respondWith: (work) => { responseWork = work; }
  });
  const response = await responseWork;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "cached:./index.html");
});
