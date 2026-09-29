/** Device-local backup recency metadata only; no classroom records are stored here. */
export const BACKUP_STATUS_KEY = "matevok.backup-status.v1";
const DAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function readBackupStatus(raw) {
  if (!raw || typeof raw !== "object") return { lastDownloadStartedAt: null, lastDataChangeAt: null, dismissedChangeAt: null };
  // Accept the earlier device-local field so this wording fix preserves existing recency state.
  return { lastDownloadStartedAt: timestamp(raw.lastDownloadStartedAt ?? raw.lastExportedAt), lastDataChangeAt: timestamp(raw.lastDataChangeAt), dismissedChangeAt: timestamp(raw.dismissedChangeAt) };
}

export function recordBackupDownloadStarted(status, now = Date.now()) {
  return { ...readBackupStatus(status), lastDownloadStartedAt: timestamp(now), dismissedChangeAt: null };
}

export function recordDataChange(status, now = Date.now()) {
  return { ...readBackupStatus(status), lastDataChangeAt: timestamp(now) };
}

export function dismissBackupReminder(status) {
  const current = readBackupStatus(status);
  return { ...current, dismissedChangeAt: current.lastDataChangeAt };
}

export function backupStatusLabel(status, now = Date.now()) {
  const downloadStartedAt = readBackupStatus(status).lastDownloadStartedAt;
  if (!downloadStartedAt) return "No backup download recorded on this device.";
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const downloadStartedDay = new Date(downloadStartedAt); downloadStartedDay.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.floor((today - downloadStartedDay) / DAY_MS));
  if (days === 0) return "Backup download started: Today";
  if (days === 1) return "Backup download started: Yesterday";
  return `Backup download started: ${days} days ago`;
}

export function needsBackupReminder(status) {
  const current = readBackupStatus(status);
  return Boolean(current.lastDataChangeAt && (!current.lastDownloadStartedAt || current.lastDataChangeAt > current.lastDownloadStartedAt) && current.dismissedChangeAt !== current.lastDataChangeAt);
}
