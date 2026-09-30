/** Coordinates one local editor tab without sending data outside this device. */
export async function acquireWorkspaceLock(lockManager = globalThis.navigator?.locks, name = "matevok-workspace-editor") {
  if (!lockManager?.request) return { status: "unsupported", release() {} };
  let resolveHold;
  const hold = new Promise((resolve) => { resolveHold = resolve; });
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  try {
    Promise.resolve(lockManager.request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
      if (!lock) { resolveResult({ status: "busy", release() {} }); return undefined; }
      resolveResult({ status: "acquired", release: resolveHold });
      return hold;
    })).catch(() => resolveResult({ status: "unavailable", release() {} }));
  } catch {
    resolveResult({ status: "unavailable", release() {} });
  }
  return result;
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
