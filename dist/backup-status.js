/** Device-local backup recency metadata only; no classroom records are stored here. */
export const BACKUP_STATUS_KEY = "matevok.backup-status.v1";
const DAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export function readBackupStatus(raw) {
  if (!raw || typeof raw !== "object") return { lastExportedAt: null, lastDataChangeAt: null, dismissedChangeAt: null };
  return { lastExportedAt: timestamp(raw.lastExportedAt), lastDataChangeAt: timestamp(raw.lastDataChangeAt), dismissedChangeAt: timestamp(raw.dismissedChangeAt) };
}

export function recordBackupExport(status, now = Date.now()) {
  return { ...readBackupStatus(status), lastExportedAt: timestamp(now), dismissedChangeAt: null };
}

export function recordDataChange(status, now = Date.now()) {
  return { ...readBackupStatus(status), lastDataChangeAt: timestamp(now) };
}

export function dismissBackupReminder(status) {
  const current = readBackupStatus(status);
  return { ...current, dismissedChangeAt: current.lastDataChangeAt };
}

export function backupStatusLabel(status, now = Date.now()) {
  const exportedAt = readBackupStatus(status).lastExportedAt;
  if (!exportedAt) return "No backup recorded on this device.";
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const exportedDay = new Date(exportedAt); exportedDay.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.floor((today - exportedDay) / DAY_MS));
  if (days === 0) return "Last backup: Today";
  if (days === 1) return "Last backup: Yesterday";
  return `Last backup: ${days} days ago`;
}

export function needsBackupReminder(status) {
  const current = readBackupStatus(status);
  return Boolean(current.lastDataChangeAt && (!current.lastExportedAt || current.lastDataChangeAt > current.lastExportedAt) && current.dismissedChangeAt !== current.lastDataChangeAt);
}
