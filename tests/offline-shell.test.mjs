import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  keys: async () => ["teacher-workspace-shell-v13", "teacher-workspace-shell-v14", "teacher-workspace-shell-v15", "old-shell", "teacher-workspace-shell-v16"],
  delete: async (key) => { deleted.push(key); return true; },
  match: async (request) => cached.get(typeof request === "string" ? request : request.url)
};
globalThis.fetch = async () => { throw new Error("offline"); };

await import(new URL("../dist/sw.js?test=offline-shell", import.meta.url));

test("precache covers every local static dependency of the cold-start scripts", async () => {
  const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
  const html = await readFile(join(distDirectory, "index.html"), "utf8");
  const sw = await readFile(join(distDirectory, "sw.js"), "utf8");
  const shellSource = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/)?.[1];
  assert.ok(shellSource, "service worker must define its shell asset list");
  const shellPaths = new Set([...shellSource.matchAll(/["']([^"']+)["']/g)].map(([, value]) => new URL(value, "https://matevok.test/dist/").pathname.replace(/^\/dist\//, "")));
  const entryScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(([, value]) => new URL(value, "https://matevok.test/dist/").pathname.replace(/^\/dist\//, ""));
  const requiredScripts = new Set();
  const pending = entryScripts.filter((script) => script.endsWith(".js"));

  while (pending.length) {
    const relativePath = pending.pop();
    if (requiredScripts.has(relativePath)) continue;
    requiredScripts.add(relativePath);
    const source = await readFile(join(distDirectory, relativePath), "utf8");
    const staticImports = [...source.matchAll(/^\s*import\s+(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["'];?/gm)];
    for (const [, specifier] of staticImports) {
      if (/^(?:[a-z]+:|\/\/)/i.test(specifier)) continue;
      const importedPath = new URL(specifier, `https://matevok.test/dist/${relativePath}`).pathname.replace(/^\/dist\//, "");
      pending.push(importedPath);
    }
  }

  for (const script of requiredScripts) {
    assert.ok(shellPaths.has(script), `cold-start script or static dependency is missing from APP_SHELL: ${script}`);
  }
});

test("offline shell installs the encrypted-backup module and removes stale application caches", async () => {
  let installWork;
  events.get("install")({ waitUntil: (work) => { installWork = work; } });
  await installWork;
  assert.equal(cached.has("./index.html"), true);
  assert.equal(cached.has("./startup.js?v=16"), true);
  assert.equal(cached.has("./app.js?v=16"), true);
  assert.equal(cached.has("./storage.js"), true);
  assert.equal(cached.has("./backup-status.js"), true);
  assert.equal(cached.has("./backup-crypto.js"), true);
  assert.equal(cached.has("./gradebook.js"), true);
  assert.equal(cached.has("./score-paste.js"), true);
  assert.equal(cached.has("./class-tool-navigation.js"), true);
  assert.equal(cached.has("./classroom.js"), true);
  assert.equal(cached.has("./reports.js"), true);
  assert.equal([...cached.keys()].some((key) => /^\.\/(?:students|attendance|scores)(?:\/|$)/i.test(key)), false);

  let activateWork;
  events.get("activate")({ waitUntil: (work) => { activateWork = work; } });
  await activateWork;
  assert.deepEqual(deleted, ["teacher-workspace-shell-v13", "teacher-workspace-shell-v14", "teacher-workspace-shell-v15", "old-shell"]);
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
