import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const events = new Map();
const cached = new Map();
const deleted = [];
const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const serviceWorkerSource = await readFile(join(distDirectory, "sw.js"), "utf8");
const applicationSource = await readFile(join(distDirectory, "app.js"), "utf8");
const currentShellVersion = Number(serviceWorkerSource.match(/^const CACHE_NAME = "teacher-workspace-shell-v(\d+)";$/m)?.[1]);
assert.ok(Number.isInteger(currentShellVersion), "service worker must declare one numeric shell version");
const currentCacheName = `teacher-workspace-shell-v${currentShellVersion}`;
const staleCacheNames = ["old-shell", ...Array.from({ length: Math.max(0, currentShellVersion - 13) }, (_, index) => `teacher-workspace-shell-v${index + 13}`)];
const openedCaches = [];
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
  registration: { scope: "https://teacher-workspace.test/dist/" },
  addEventListener: (name, handler) => events.set(name, handler),
  skipWaiting: async () => undefined,
  clients: { claim: async () => undefined, matchAll: async () => [] }
};
globalThis.caches = {
  open: async (name) => { openedCaches.push(name); return cache; },
  keys: async () => staleCacheNames,
  delete: async (key) => { deleted.push(key); return true; },
  match: async (request) => cached.get(typeof request === "string" ? request : request.url)
};
globalThis.fetch = async () => { throw new Error("offline"); };

await import(new URL("../dist/sw.js?test=offline-shell", import.meta.url));

test("precache covers every local static dependency of the cold-start scripts", async () => {
  const html = await readFile(join(distDirectory, "index.html"), "utf8");
  const startup = await readFile(join(distDirectory, "startup.js"), "utf8");
  const shellSource = serviceWorkerSource.match(/const APP_SHELL = \[([\s\S]*?)\];/)?.[1];
  assert.ok(shellSource, "service worker must define its shell asset list");
  const htmlScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(([, value]) => value);
  assert.ok(htmlScripts.includes(`startup.js?v=${currentShellVersion}`), "HTML startup script must match the active service-worker version");
  assert.ok(htmlScripts.includes(`app.js?v=${currentShellVersion}`), "HTML application script must match the active service-worker version");
  assert.ok(startup.includes(`./sw.js?v=${currentShellVersion}`), "service-worker registration must match the active shell version");
  const takeoverProtocol = applicationSource.match(/async function reloadPeerWindowsForTakeover\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(takeoverProtocol, /navigator\.serviceWorker\?\.controller/);
  assert.match(takeoverProtocol, /MATEVOK_RELOAD_PEERS_FOR_TAKEOVER/);
  assert.doesNotMatch(takeoverProtocol, /scriptURL|searchParams|["']v["']/,
    "takeover support is verified by the worker's protocol response, not a duplicated shell-version constant");
  assert.ok(shellSource.includes(`./startup.js?v=${currentShellVersion}`), "precache startup URL must match the active shell version");
  assert.ok(shellSource.includes(`./app.js?v=${currentShellVersion}`), "precache app URL must match the active shell version");
  assert.equal((serviceWorkerSource.match(/teacher-workspace-shell-v\d+/g) || []).length, 1, "only CACHE_NAME should define the current shell version");
  const shellPaths = new Set([...shellSource.matchAll(/["']([^"']+)["']/g)].map(([, value]) => new URL(value, "https://matevok.test/dist/").pathname.replace(/^\/dist\//, "")));
  const entryScripts = htmlScripts.map((value) => new URL(value, "https://matevok.test/dist/").pathname.replace(/^\/dist\//, ""));
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

test("PWA manifest declares Chromium install icon sizes using the existing scalable mark", async () => {
  const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
  const manifest = JSON.parse(await readFile(join(distDirectory, "manifest.webmanifest"), "utf8"));
  const svg = await readFile(join(distDirectory, "favicon.svg"), "utf8");
  const declaredSizes = new Set(manifest.icons.flatMap((icon) => icon.sizes.split(/\s+/)));

  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.display, "standalone");
  assert.ok(declaredSizes.has("192x192"));
  assert.ok(declaredSizes.has("512x512"));
  assert.equal(manifest.icons.every((icon) => icon.src === "favicon.svg" && icon.type === "image/svg+xml"), true);
  assert.match(svg, /width="512" height="512"/);
});

test("offline shell installs startup modules and removes stale application caches", async () => {
  let installWork;
  events.get("install")({ waitUntil: (work) => { installWork = work; } });
  await installWork;
  assert.deepEqual(openedCaches, [currentCacheName]);
  assert.equal(cached.has("./index.html"), true);
  assert.equal(cached.has(`./startup.js?v=${currentShellVersion}`), true);
  assert.equal(cached.has(`./app.js?v=${currentShellVersion}`), true);
  assert.equal(cached.has("./workspace-lock.js"), true);
  assert.equal(cached.has("./storage.js"), true);
  assert.equal(cached.has("./backup-status.js"), true);
  assert.equal(cached.has("./backup-crypto.js"), true);
  assert.equal(cached.has("./gradebook.js"), true);
  assert.equal(cached.has("./score-paste.js"), true);
  assert.equal(cached.has("./class-tool-navigation.js"), true);
  assert.equal(cached.has("./attendance-keyboard.js"), true);
  assert.equal(cached.has("./classroom.js"), true);
  assert.equal(cached.has("./reports.js"), true);
  assert.equal(cached.has("./class-work.js"), true);
  assert.equal(cached.has("./lesson-reference.js"), true);
  assert.equal([...cached.keys()].some((key) => /^\.\/(?:students|attendance|scores)(?:\/|$)/i.test(key)), false);

  let activateWork;
  events.get("activate")({ waitUntil: (work) => { activateWork = work; } });
  await activateWork;
  assert.deepEqual(deleted, staleCacheNames);
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

test("confirmed editor recovery reloads peer windows into a blocked state without exposing records", async () => {
  const navigated = [];
  self.clients.matchAll = async (options) => {
    assert.deepEqual(options, { type: "window", includeUncontrolled: true });
    return [
      { id: "requesting-window", url: "https://teacher-workspace.test/dist/", navigate: async () => { throw new Error("must not reload the requester"); } },
      { id: "stale-window", url: "https://teacher-workspace.test/dist/?tab=old", navigate: async (url) => { navigated.push(url); return { id: "stale-window" }; } },
      { id: "outside-scope", url: "https://teacher-workspace.test/other/index.html", navigate: async () => { throw new Error("outside-scope window must not reload"); } },
      { id: "external-origin", url: "https://other.test/dist/", navigate: async () => { throw new Error("external origin must not reload"); } }
    ];
  };
  let work;
  let response;
  events.get("message")({
    data: { type: "MATEVOK_RELOAD_PEERS_FOR_TAKEOVER" },
    source: { id: "requesting-window" },
    ports: [{ postMessage: (value) => { response = value; } }],
    waitUntil: (promise) => { work = promise; }
  });
  await work;
  assert.deepEqual(response, { ok: true, count: 1, failed: 0 });
  assert.equal(navigated.length, 1);
  assert.equal(navigated[0], "https://teacher-workspace.test/dist/?workspace-locked=1");
  assert.equal(/student|score|attendance|passphrase/i.test(navigated[0]), false, "recovery navigation must not contain teacher data");
});
