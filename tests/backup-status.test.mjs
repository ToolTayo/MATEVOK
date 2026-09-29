import assert from "node:assert/strict";
import test from "node:test";
import { backupStatusLabel, dismissBackupReminder, needsBackupReminder, readBackupStatus, recordBackupDownloadStarted, recordDataChange } from "../dist/backup-status.js";

const DAY = 24 * 60 * 60 * 1000;
const today = Date.UTC(2026, 8, 29, 9);

test("backup recency is device-only metadata and never treats a data change as an export", () => {
  const empty = readBackupStatus(null);
  assert.deepEqual(empty, { lastDownloadStartedAt: null, lastDataChangeAt: null, dismissedChangeAt: null });
  assert.equal(backupStatusLabel(empty, today), "No backup download recorded on this device.");
  const changed = recordDataChange(empty, today);
  assert.equal(needsBackupReminder(changed), true);
  assert.equal(changed.lastDownloadStartedAt, null);
  const started = recordBackupDownloadStarted(changed, today + 1);
  assert.equal(backupStatusLabel(started, today + 1), "Backup download started: Today");
  assert.equal(needsBackupReminder(started), false);
});

test("backup reminder is dismissible for current changes and returns for later changes", () => {
  const started = recordBackupDownloadStarted(null, today - 8 * DAY);
  const changed = recordDataChange(started, today);
  assert.equal(backupStatusLabel(changed, today), "Backup download started: 8 days ago");
  assert.equal(needsBackupReminder(changed), true);
  const dismissed = dismissBackupReminder(changed);
  assert.equal(needsBackupReminder(dismissed), false);
  assert.equal(needsBackupReminder(recordDataChange(dismissed, today + 1)), true);
});

test("older device-local export timestamps remain readable but are described as download starts", () => {
  const legacy = readBackupStatus({ lastExportedAt: today, lastDataChangeAt: today - 1, dismissedChangeAt: null });
  assert.equal(legacy.lastDownloadStartedAt, today);
  assert.equal(backupStatusLabel(legacy, today), "Backup download started: Today");
});
