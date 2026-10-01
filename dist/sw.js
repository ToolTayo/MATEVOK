const CACHE_NAME = "teacher-workspace-shell-v33";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./startup.js?v=33",
  "./app.js?v=33",
  "./workspace-lock.js",
  "./storage.js",
  "./backup-status.js",
  "./backup-crypto.js",
  "./gradebook.js",
  "./score-paste.js",
  "./class-tool-navigation.js",
  "./attendance-keyboard.js",
  "./classroom.js",
  "./progress.js",
  "./reports.js",
  "./class-work.js",
  "./lesson-reference.js",
  "./manifest.webmanifest",
  "./favicon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "MATEVOK_RELOAD_PEERS_FOR_TAKEOVER") return;
  const sourceId = event.source?.id;
  const responsePort = event.ports?.[0];
  event.waitUntil((async () => {
    const scope = new URL(self.registration.scope);
    if (!sourceId) { responsePort?.postMessage({ ok: false, count: 0 }); return; }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const peers = windows.filter((client) => {
      if (client.id === sourceId) return false;
      try { const url = new URL(client.url); return url.origin === scope.origin && url.pathname.startsWith(scope.pathname); }
      catch { return false; }
    });
    const recoveryUrl = new URL(scope.href);
    recoveryUrl.searchParams.set("workspace-locked", "1");
    const results = await Promise.all(peers.map(async (client) => {
      try { return Boolean(await client.navigate(recoveryUrl.href)); } catch { return false; }
    }));
    responsePort?.postMessage({ ok: results.every(Boolean), count: peers.length, failed: results.filter((success) => !success).length });
  })());
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === "GET") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") return caches.match("./index.html");
    return new Response("Offline resource unavailable", { status: 503, statusText: "Offline" });
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request));
});
