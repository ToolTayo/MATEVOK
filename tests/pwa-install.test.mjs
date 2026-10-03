import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { INSTALL_DISMISSAL_DAYS, INSTALL_DISMISSAL_KEY, installExperienceState, isIOSSafari, isStandaloneMode, readInstallDismissedUntil, recordInstallDismissal } from "../dist/pwa-install.js";

const day = 24 * 60 * 60 * 1000;
const makeWindow = ({ userAgent = "Chrome/130.0", platform = "Win32", maxTouchPoints = 0, standalone = false, displayStandalone = false } = {}) => ({
  navigator: { userAgent, platform, maxTouchPoints, standalone },
  matchMedia: (query) => ({ matches: query === "(display-mode: standalone)" && displayStandalone })
});

test("install availability distinguishes native prompt, iOS Safari help, unsupported browsers, and standalone mode", () => {
  const chromium = makeWindow();
  const iphoneSafari = makeWindow({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", platform: "iPhone" });
  const ipadSafari = makeWindow({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 });
  const chromeOnIOS = makeWindow({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", platform: "iPhone" });

  assert.equal(installExperienceState({ windowObject: chromium }), "unavailable");
  assert.equal(installExperienceState({ windowObject: chromium, nativePromptAvailable: true }), "native");
  assert.equal(isIOSSafari(iphoneSafari), true);
  assert.equal(installExperienceState({ windowObject: iphoneSafari }), "ios-safari");
  assert.equal(isIOSSafari(ipadSafari), true, "iPadOS desktop user-agent mode is recognized through touch hardware");
  assert.equal(isIOSSafari(chromeOnIOS), false, "iOS browsers other than Safari do not receive Safari-only directions");
  assert.equal(installExperienceState({ windowObject: chromeOnIOS }), "unavailable");
  assert.equal(isStandaloneMode(makeWindow({ displayStandalone: true })), true);
  assert.equal(isStandaloneMode(makeWindow({ standalone: true })), true);
  assert.equal(installExperienceState({ windowObject: iphoneSafari, nativePromptAvailable: true, dismissedUntil: Date.now() + day }), "dismissed");
  assert.equal(installExperienceState({ windowObject: chromium, nativePromptAvailable: true, now: 20, dismissedUntil: 10 }), "native");
  assert.equal(installExperienceState({ windowObject: makeWindow({ displayStandalone: true }), nativePromptAvailable: true }), "standalone");
});

test("install dismissal is device-local, expires after thirty days, and fails open if storage is unavailable", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const now = 1_800_000_000_000;
  const until = recordInstallDismissal(storage, now);
  assert.equal(until, now + INSTALL_DISMISSAL_DAYS * day);
  assert.equal(INSTALL_DISMISSAL_KEY, "matevok-install-dismissed-until-v1");
  assert.equal(readInstallDismissedUntil(storage, now), until);
  assert.equal(readInstallDismissedUntil(storage, until), 0);
  assert.equal(installExperienceState({ windowObject: makeWindow(), dismissedUntil: until - 1, now }), "dismissed");

  const blockedStorage = { getItem() { throw new Error("storage denied"); }, setItem() { throw new Error("storage denied"); } };
  assert.equal(readInstallDismissedUntil(blockedStorage, now), 0);
  assert.ok(recordInstallDismissal(blockedStorage, now) > now, "a local preference write failure must not block the install flow");
});

test("manifest is explicitly scoped for standalone launch and keeps its matching MATEVOK mark", async () => {
  const manifest = JSON.parse(await readFile(new URL("../dist/manifest.webmanifest", import.meta.url), "utf8"));
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const mark = await readFile(new URL("../dist/favicon.svg", import.meta.url), "utf8");
  assert.equal(manifest.name, "MATEVOK");
  assert.equal(manifest.short_name, "MATEVOK");
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(manifest.icons.some((icon) => icon.src === "favicon.svg" && icon.sizes.includes("192x192") && icon.sizes.includes("512x512") && icon.purpose.includes("maskable")));
  assert.match(mark, /width="512" height="512"/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-title" content="MATEVOK/);
});

test("service-worker update UI consults the canonical dirty flags before applying or reloading", async () => {
  const app = await readFile(new URL("../dist/app.js", import.meta.url), "utf8");
  assert.match(app, /function hasUnsavedPageWork\(\)[\s\S]*?state\.classWorkSession\?\.dirty \|\| state\.lesson\?\.dirty/);
  const clickHandler = app.match(/applyUpdateButton\?\.addEventListener\("click", \(\) => \{([\s\S]*?)\n\}\);/)?.[1] || "";
  assert.match(clickHandler, /if \(hasUnsavedPageWork\(\)\)[\s\S]*?return;/);
  assert.match(clickHandler, /type: "MATEVOK_APPLY_UPDATE"/);
  const controllerHandler = app.match(/navigator\.serviceWorker\?\.addEventListener\("controllerchange", \(\) => \{([\s\S]*?)\n\}\);/)?.[1] || "";
  assert.match(controllerHandler, /if \(hasUnsavedPageWork\(\)\)[\s\S]*?return;/);
});
