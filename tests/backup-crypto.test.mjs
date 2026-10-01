import assert from "node:assert/strict";
import test from "node:test";
import { BACKUP_PASSPHRASE_MIN_LENGTH, MAX_ENCRYPTED_BACKUP_FILE_BYTES, decryptBackup, encryptBackup, isEncryptedBackup, validateEncryptedBackupEnvelope } from "../dist/backup-crypto.js";
import { validateBackup } from "../dist/storage.js";

const sampleBackup = { format: "teacher-workspace-backup", backupVersion: 1, data: { classes: [{ id: "class-1", className: "Sensitive class" }] } };
const passphrase = "correct horse battery staple";

test("encrypted backups round-trip without exposing cleartext and use fresh cryptographic parameters", async () => {
  const first = await encryptBackup(sampleBackup, passphrase);
  const second = await encryptBackup(sampleBackup, passphrase);
  assert.equal(isEncryptedBackup(first), true);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(first).includes("Sensitive class"), false);
  assert.deepEqual(await decryptBackup(first, passphrase), sampleBackup);
});

test("encrypted backup unlock rejects wrong passphrases and tampered ciphertext", async () => {
  const encrypted = await encryptBackup(sampleBackup, passphrase);
  await assert.rejects(decryptBackup(encrypted, "incorrect horse battery staple"), /Could not unlock/);
  const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -4)}AAAA` };
  await assert.rejects(decryptBackup(tampered, passphrase), /Could not unlock/);
});

test("encrypted backup envelope rejects unsupported parameters and weak passphrases", async () => {
  const encrypted = await encryptBackup(sampleBackup, passphrase);
  assert.throws(() => validateEncryptedBackupEnvelope({ ...encrypted, iterations: encrypted.iterations - 1 }), /not supported or is invalid/);
  assert.throws(() => validateEncryptedBackupEnvelope({ ...encrypted, iv: "AA==" }), /not valid/);
  assert.equal(isEncryptedBackup(sampleBackup), false);
  await assert.rejects(encryptBackup(sampleBackup, "too-short"), new RegExp(`at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters`));
});

test("encrypted backup file cap accommodates school-year exports without changing the envelope", () => {
  assert.equal(MAX_ENCRYPTED_BACKUP_FILE_BYTES, 25 * 1024 * 1024);
});

test("empty, malformed, oversized, and authenticated-but-invalid backup files fail closed", async () => {
  const encrypted = await encryptBackup(sampleBackup, passphrase);
  for (const malformed of [null, {}, { ...encrypted, ciphertext: "" }, { ...encrypted, salt: "not base64!" }, { ...encrypted, ciphertext: "A".repeat(25 * 1024 * 1024) }]) {
    assert.throws(() => validateEncryptedBackupEnvelope(malformed));
  }

  const authenticatedInvalid = await encryptBackup({ format: "not-a-backup", backupVersion: 99, data: null }, passphrase);
  const decrypted = await decryptBackup(authenticatedInvalid, passphrase);
  assert.throws(() => validateBackup(decrypted), /not a MATEVOK backup/);
});
