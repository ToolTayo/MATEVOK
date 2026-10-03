export const INSTALL_DISMISSAL_KEY = "matevok-install-dismissed-until-v1";
export const INSTALL_DISMISSAL_DAYS = 30;

export function isStandaloneMode(windowObject = globalThis.window) {
  try {
    return windowObject?.navigator?.standalone === true ||
      Boolean(windowObject?.matchMedia?.("(display-mode: standalone)")?.matches);
  } catch {
    return false;
  }
}

export function isIOSSafari(windowObject = globalThis.window) {
  const navigatorObject = windowObject?.navigator;
  const userAgent = String(navigatorObject?.userAgent || "");
  const iosDevice = /iPhone|iPad|iPod/i.test(userAgent) ||
    (navigatorObject?.platform === "MacIntel" && Number(navigatorObject?.maxTouchPoints) > 1);
  return iosDevice && /Safari\//i.test(userAgent) && !/(?:CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(userAgent);
}

export function installExperienceState({ windowObject = globalThis.window, nativePromptAvailable = false, dismissedUntil = 0, now = Date.now() } = {}) {
  if (isStandaloneMode(windowObject)) return "standalone";
  if (Number(dismissedUntil) > now) return "dismissed";
  if (nativePromptAvailable) return "native";
  if (isIOSSafari(windowObject)) return "ios-safari";
  return "unavailable";
}

export function readInstallDismissedUntil(storage, now = Date.now()) {
  try {
    const value = Number((storage ?? globalThis.localStorage).getItem(INSTALL_DISMISSAL_KEY));
    return Number.isFinite(value) && value > now ? value : 0;
  } catch {
    return 0;
  }
}

export function recordInstallDismissal(storage, now = Date.now()) {
  const dismissedUntil = now + INSTALL_DISMISSAL_DAYS * 24 * 60 * 60 * 1000;
  try {
    (storage ?? globalThis.localStorage).setItem(INSTALL_DISMISSAL_KEY, String(dismissedUntil));
  } catch {
    // Install guidance is optional local UI state; it must never block use.
  }
  return dismissedUntil;
}
