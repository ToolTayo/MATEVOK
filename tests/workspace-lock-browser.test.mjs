import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import { extname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dist = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const browserPath = process.env.MATEVOK_CHROME_PATH || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].find((path) => process.platform === "win32" && existsSync(path));
const mime = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".svg", "image/svg+xml"], [".webmanifest", "application/manifest+json; charset=utf-8"]]);
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

function cdp(url) {
  const socket = new WebSocket(url), pending = new Map(), listeners = new Map(); let nextId = 0;
  const ready = new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)); if (message.id) { const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); return; } for (const listener of listeners.get(message.method) || []) listener(message.params); });
  return { ready, call(method, params = {}) { const id = ++nextId; return new Promise((resolveCall, reject) => { pending.set(id, { resolve: resolveCall, reject }); socket.send(JSON.stringify({ id, method, params })); }); }, on(method, listener) { const group = listeners.get(method) || []; group.push(listener); listeners.set(method, group); }, close() { socket.close(); } };
}

test("Edge recovers a frozen/legacy peer through the service worker without opening two editors", { skip: !browserPath && "No installed Chrome/Edge executable was found." }, async (t) => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "matevok-lock-edge-")), profile = join(tempRoot, "profile");
  let server, browserProcess, browser, first, second, third, firstTargetId, secondTargetId, thirdTargetId;
  const pageLoadCounts = new WeakMap();
  try {
    server = createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      let target = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
      if (target !== dist && !target.startsWith(`${dist}${sep}`)) { response.writeHead(403).end(); return; }
      if (target === dist || (await stat(target).catch(() => null))?.isDirectory()) target = join(dist, "index.html");
      let body = await readFile(target).catch(() => null);
      if (!body && (request.headers.accept || "").includes("text/html")) { target = join(dist, "index.html"); body = await readFile(target); }
      if (!body) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": mime.get(extname(target)) || "application/octet-stream", "Cache-Control": "public, max-age=0, must-revalidate", "X-Content-Type-Options": "nosniff", "Service-Worker-Allowed": "/" }).end(body);
    });
    await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
    const portServer = createNetServer(); await new Promise((resolveListen, reject) => portServer.listen(0, "127.0.0.1", resolveListen).once("error", reject));
    const debugPort = portServer.address().port; await new Promise((resolveClose) => portServer.close(resolveClose));
    const debugUrl = `http://127.0.0.1:${debugPort}`; const origin = `http://127.0.0.1:${server.address().port}`;
    browserProcess = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-background-networking", "--disable-extensions", "--remote-allow-origins=*", `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, "about:blank"], { stdio: "ignore", windowsHide: true });
    browserProcess.unref();
    let version;
    for (let attempt = 0; attempt < 150; attempt++) { try { version = await (await fetch(`${debugUrl}/json/version`)).json(); break; } catch { await pause(100); } }
    assert.ok(version?.webSocketDebuggerUrl, "Edge debugging endpoint did not start");
    browser = cdp(version.webSocketDebuggerUrl); await browser.ready;
    const createTab = async (url) => {
      const { targetId } = await browser.call("Target.createTarget", { url });
      const deadline = Date.now() + 10000; let target;
      while (Date.now() < deadline) { target = (await (await fetch(`${debugUrl}/json/list`)).json()).find((item) => item.id === targetId); if (target?.webSocketDebuggerUrl) break; await pause(50); }
      assert.ok(target?.webSocketDebuggerUrl, "Edge page target did not appear");
      const page = cdp(target.webSocketDebuggerUrl); await page.ready; pageLoadCounts.set(page, 0); page.on("Page.loadEventFired", () => pageLoadCounts.set(page, pageLoadCounts.get(page) + 1)); await Promise.all([page.call("Page.enable"), page.call("Runtime.enable")]);
      return { page, targetId };
    };
    const evaluate = async (page, expression) => {
      const result = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const wait = async (page, expression, label, timeout = 12000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { try { if (await evaluate(page, expression)) return; } catch {} await pause(75); }
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(await evaluate(page, "({url:location.href,status:document.querySelector('[data-storage-message]')?.textContent,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.dataset.dialog),classes:document.querySelector('[data-app]')?.innerText?.slice(0,400)})").catch((error) => String(error)))}`);
    };
    const reloadPage = async (page, label) => {
      const previous = pageLoadCounts.get(page) || 0;
      await page.call("Page.reload");
      const deadline = Date.now() + 15000;
      while ((pageLoadCounts.get(page) || 0) <= previous && Date.now() < deadline) await pause(50);
      assert.ok((pageLoadCounts.get(page) || 0) > previous, `Chromium did not complete ${label}`);
    };

    ({ page: first, targetId: firstTargetId } = await createTab(origin));
    await wait(first, "document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "first editor startup");
    const synthetic = await evaluate(first, "import('./storage.js').then(s=>s.saveClass({className:'Synthetic lock preservation'}))");
    assert.equal(synthetic.className, "Synthetic lock preservation");
    ({ page: second, targetId: secondTargetId } = await createTab(`${origin}/?recovery-test=1`));
    await wait(second, "document.querySelector('[data-dialog=workspace-lock]')?.open", "busy second editor");
    assert.equal(await evaluate(second, "document.querySelector('[data-workspace-takeover]')?.textContent.trim()"), "Take over workspace…");
    ({ page: third, targetId: thirdTargetId } = await createTab(`${origin}/?recovery-contender=1`));
    await wait(third, "document.querySelector('[data-dialog=workspace-lock]')?.open", "busy third editor");
    const recoveryAttempts = await Promise.all([second, third].map((page) => evaluate(page, "import('./workspace-lock.js').then(async m=>{const lock=await m.acquireWorkspaceLock(navigator.locks,m.WORKSPACE_RECOVERY_LOCK);window.__testRecoveryLock=lock;return lock.status})")));
    assert.deepEqual([...recoveryAttempts].sort(), ["acquired", "busy"], "simultaneous takeover attempts must be serialized by the browser lock manager");
    for (const page of [second, third]) await evaluate(page, "window.__testRecoveryLock?.release();window.__testRecoveryLock=null;true");
    await browser.call("Target.closeTarget", { targetId: thirdTargetId });
    await browser.call("Target.activateTarget", { targetId: secondTargetId });

    await first.call("Page.setWebLifecycleState", { state: "frozen" });
    await evaluate(second, "document.querySelector('[data-workspace-takeover]')?.click();true");
    await wait(second, "document.querySelector('[data-dialog=workspace-takeover]')?.open", "takeover confirmation");
    const warning = await evaluate(second, "document.querySelector('[data-workspace-takeover-copy]')?.textContent");
    assert.match(warning, /read-only[\s\S]*unsaved edits[\s\S]*saved records/);
    await evaluate(second, "document.querySelector('[data-confirm-workspace-takeover]')?.click();true");
    await wait(second, "document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "editor recovery from frozen peer", 18000);
    await wait(first, "location.search.includes('workspace-locked=1')&&document.querySelector('[data-dialog=workspace-lock]')?.open", "frozen peer reloaded into safe state", 18000);

    const ownerState = await evaluate(second, "({status:document.querySelector('[data-storage-message]')?.textContent,classes:[...document.querySelectorAll('.class-card h2')].map(x=>x.textContent)})");
    assert.match(ownerState.status, /ready/i);
    assert.ok(ownerState.classes.includes("Synthetic lock preservation"), "saved synthetic records must survive takeover");
    const heldLocks = await evaluate(second, "navigator.locks.query().then(x=>x.held.map(l=>l.name))");
    assert.deepEqual(heldLocks, ["matevok-workspace-editor"], "exactly the recovered editor should hold the lock");
    const staleWrite = await evaluate(first, "import('./storage.js').then(async s=>{try{await s.saveClass({className:'Blocked stale editor write'});return 'unexpected'}catch(e){return e.message}})");
    assert.match(staleWrite, /no longer has editing access/);

    await second.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(second, "document.querySelector('[data-menu-button]')?.click();true");
    await wait(second, "document.querySelector('[data-sidebar]')?.dataset.open==='true'", "mobile recovery navigation drawer");
    await pause(250);
    const pointerTarget = await evaluate(second, "(()=>{const e=document.querySelector('[data-nav-item=\\\"My Materials\\\"]'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,height:r.height,overflow:document.documentElement.scrollWidth>innerWidth}})()");
    assert.ok(pointerTarget.height >= 44);
    assert.equal(pointerTarget.overflow, false);
    assert.ok(pointerTarget.x >= 0 && pointerTarget.x <= 390, `nav target should be visible after the drawer opens: ${JSON.stringify(pointerTarget)}`);
    await second.call("Input.dispatchMouseEvent", { type: "mousePressed", x: pointerTarget.x, y: pointerTarget.y, button: "left", clickCount: 1 });
    await second.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: pointerTarget.x, y: pointerTarget.y, button: "left", clickCount: 1 });
    await wait(second, "document.querySelector('[data-app] h1')?.textContent==='My Materials'", "My Materials pointer navigation after recovery");
    const pointerState = await evaluate(second, "({title:document.querySelector('[data-app] h1')?.textContent,open:document.querySelector('[data-sidebar]')?.dataset.open,expanded:document.querySelector('[data-menu-button]')?.getAttribute('aria-expanded'),hit:(document.elementFromPoint(" + pointerTarget.x + "," + pointerTarget.y + ")?.closest('[data-nav-item]')?.dataset.navItem||document.elementFromPoint(" + pointerTarget.x + "," + pointerTarget.y + ")?.outerHTML?.slice(0,100)),dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.dataset.dialog)})");
    assert.equal(pointerState.title, "My Materials", `real pointer input must work after the recovery overlay closes: ${JSON.stringify(pointerState)}`);

    await browser.call("Target.closeTarget", { targetId: firstTargetId });
    await evaluate(second, "document.querySelector('[data-menu-button]')?.click();true");
    await evaluate(second, "document.querySelector('[data-nav-item=\\\"My Classes\\\"]')?.click();true");
    await wait(second, "document.querySelector('[data-app] h1')?.textContent==='Your classes'", "normal navigation after peer close");
    await reloadPage(second, "refresh after recovery");
    await wait(second, "document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "refresh after recovery");
    assert.ok((await evaluate(second, "[...document.querySelectorAll('.class-card h2')].map(x=>x.textContent)")).includes("Synthetic lock preservation"));
    assert.equal(await evaluate(second, "document.documentElement.scrollWidth>innerWidth"), false);
    t.diagnostic(`Browser used: ${browserPath.includes("msedge") ? "Microsoft Edge" : "Chrome"}. Frozen-client recovery, single lock ownership, stale-write denial, pointer recovery, and refresh persistence verified with a synthetic class.`);
  } finally {
    try { if (first) first.close(); } catch {}
    try { if (second) second.close(); } catch {}
    try { if (third) third.close(); } catch {}
    try { if (browser) await browser.call("Browser.close"); } catch {}
    if (browserProcess?.pid) { try { if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(browserProcess.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); else browserProcess.kill(); } catch {} }
    if (server) { server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); }
    await pause(500);
    for (let attempt = 0; attempt < 20; attempt++) { try { await rm(tempRoot, { recursive: true, force: true }); break; } catch { if (attempt === 19) t.diagnostic("Temporary Edge profile cleanup did not complete."); await pause(250); } }
  }
});
