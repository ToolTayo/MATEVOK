import assert from "node:assert/strict";
import test from "node:test";
import { backupStatusLabel, dismissBackupReminder, needsBackupReminder, readBackupStatus, recordBackupExport, recordDataChange } from "../dist/backup-status.js";

const DAY = 24 * 60 * 60 * 1000;
const today = Date.UTC(2026, 8, 29, 9);

test("backup recency is device-only metadata and never treats a data change as an export", () => {
  const empty = readBackupStatus(null);
  assert.deepEqual(empty, { lastExportedAt: null, lastDataChangeAt: null, dismissedChangeAt: null });
  assert.equal(backupStatusLabel(empty, today), "No backup recorded on this device.");
  const changed = recordDataChange(empty, today);
  assert.equal(needsBackupReminder(changed), true);
  assert.equal(changed.lastExportedAt, null);
  const exported = recordBackupExport(changed, today + 1);
  assert.equal(backupStatusLabel(exported, today + 1), "Last backup: Today");
  assert.equal(needsBackupReminder(exported), false);
});

test("backup reminder is dismissible for current changes and returns for later changes", () => {
  const exported = recordBackupExport(null, today - 8 * DAY);
  const changed = recordDataChange(exported, today);
  assert.equal(backupStatusLabel(changed, today), "Last backup: 8 days ago");
  assert.equal(needsBackupReminder(changed), true);
  const dismissed = dismissBackupReminder(changed);
  assert.equal(needsBackupReminder(dismissed), false);
  assert.equal(needsBackupReminder(recordDataChange(dismissed, today + 1)), true);
});
