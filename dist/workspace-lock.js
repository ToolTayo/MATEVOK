/** Coordinates one local editor tab without sending data outside this device. */
export async function acquireWorkspaceLock(lockManager = globalThis.navigator?.locks, name = "matevok-workspace-editor", { onAcquired = () => {}, onLost = () => {} } = {}) {
  if (!lockManager?.request) return { status: "unsupported", release() {} };
  let resolveHold;
  const hold = new Promise((resolve) => { resolveHold = resolve; });
  let resolveResult;
  let settled = false;
  let granted = false;
  let releaseCurrent = () => {};
  let acquiredResult = null;
  const settle = (value) => { if (settled) return; settled = true; resolveResult(value); };
  const result = new Promise((resolve) => { resolveResult = resolve; });
  try {
    Promise.resolve(lockManager.request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
      if (!lock) { settle({ status: "busy", release() {} }); return undefined; }
      granted = true;
      let released = false;
      releaseCurrent = () => { if (released) return; released = true; resolveHold(); };
      try { onAcquired(); } catch { releaseCurrent(); settle({ status: "unavailable", release() {} }); return undefined; }
      acquiredResult = { status: "acquired", release: releaseCurrent };
      settle(acquiredResult);
      return hold;
    })).catch(() => {
      if (granted) { if (acquiredResult) acquiredResult.status = "lost"; try { onLost(); } catch { /* A revoked lock must still be released locally. */ } releaseCurrent(); return; }
      settle({ status: "unavailable", release() {} });
    });
  } catch {
    settle({ status: "unavailable", release() {} });
  }
  return result;
}

/** A small shared token lets a resumed/frozen document synchronously detect takeover. */
export const WORKSPACE_OWNER_KEY = "matevok-workspace-editor-owner-v1";
export const WORKSPACE_RECOVERY_LOCK = "matevok-workspace-recovery";
export function createWorkspaceEditorLease(storage, ownerId = globalThis.crypto?.randomUUID?.() || `editor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  return Object.freeze({
    ownerId,
    canCoordinate() {
      if (!storage?.setItem || !storage?.getItem || !storage?.removeItem) return false;
      const probe = `${WORKSPACE_OWNER_KEY}-probe-${ownerId}`;
      try { storage.setItem(probe, "1"); storage.removeItem(probe); return true; } catch { return false; }
    },
    claim() {
      try { storage.setItem(WORKSPACE_OWNER_KEY, ownerId); return storage.getItem(WORKSPACE_OWNER_KEY) === ownerId; } catch { return false; }
    },
    isOwner() {
      try { return storage.getItem(WORKSPACE_OWNER_KEY) === ownerId; } catch { return null; }
    },
    release() {
      try { if (storage.getItem(WORKSPACE_OWNER_KEY) === ownerId) storage.removeItem(WORKSPACE_OWNER_KEY); } catch { /* The browser lock still releases with its document. */ }
    }
  });
}

/** Prevents overlapping UI writes while still allowing an explicit retry after failure. */
export function createSingleFlight() {
  let pending = false;
  return (work) => {
    if (pending) return null;
    pending = true;
    let result;
    try { result = work(); } catch (error) { pending = false; throw error; }
    return Promise.resolve(result).finally(() => { pending = false; });
  };
}
