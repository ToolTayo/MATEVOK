export const ENCRYPTED_BACKUP_FORMAT = "teacher-workspace-encrypted-backup";
export const ENCRYPTED_BACKUP_VERSION = 1;
export const BACKUP_PASSPHRASE_MIN_LENGTH = 12;
const KDF_ITERATIONS = 600_000;
export const MAX_ENCRYPTED_BACKUP_FILE_BYTES = 36_000_000;
const MAX_CIPHERTEXT_BYTES = 24 * 1024 * 1024;

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64DecodedLength(value) {
  if (typeof value !== "string" || !value.length || value.length % 4 !== 0) return -1;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const alphaNumeric = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (!alphaNumeric && code !== 43 && code !== 47) return -1;
  }
  for (let index = contentLength; index < value.length; index += 1) if (value.charCodeAt(index) !== 61) return -1;
  return value.length / 4 * 3 - padding;
}

function base64ToBytes(value) {
  if (base64DecodedLength(value) < 0) throw new Error("This encrypted backup is not valid.");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function cryptoApi(cryptoProvider) {
  if (!cryptoProvider?.subtle || !cryptoProvider?.getRandomValues) {
    throw new Error("Secure backup encryption is unavailable in this browser. Open MATEVOK using HTTPS or localhost, then try again.");
  }
  return cryptoProvider;
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    throw new Error(`Use a backup passphrase with at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters.`);
  }
}

async function deriveKey(passphrase, salt, cryptoProvider, usage) {
  const material = await cryptoProvider.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return cryptoProvider.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

export function isEncryptedBackup(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.format === ENCRYPTED_BACKUP_FORMAT);
}

export function validateEncryptedBackupEnvelope(value) {
  if (!isEncryptedBackup(value) || value.backupVersion !== ENCRYPTED_BACKUP_VERSION || value.encryption !== "AES-256-GCM" || value.keyDerivation !== "PBKDF2-SHA-256" || value.iterations !== KDF_ITERATIONS) {
    throw new Error("This encrypted backup format is not supported or is invalid.");
  }
  const salt = base64ToBytes(value.salt);
  const iv = base64ToBytes(value.iv);
  const ciphertextLength = base64DecodedLength(value.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertextLength < 16 || ciphertextLength > MAX_CIPHERTEXT_BYTES) {
    throw new Error("This encrypted backup is not valid or is too large.");
  }
  return { format: ENCRYPTED_BACKUP_FORMAT, backupVersion: ENCRYPTED_BACKUP_VERSION, encryption: "AES-256-GCM", keyDerivation: "PBKDF2-SHA-256", iterations: KDF_ITERATIONS, salt: value.salt, iv: value.iv, ciphertext: value.ciphertext };
}

export async function encryptBackup(backup, passphrase, cryptoProvider = globalThis.crypto) {
  validatePassphrase(passphrase);
  const api = cryptoApi(cryptoProvider);
  const salt = api.getRandomValues(new Uint8Array(16));
  const iv = api.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, api, "encrypt");
  const cleartext = new TextEncoder().encode(JSON.stringify(backup));
  const encrypted = await api.subtle.encrypt({ name: "AES-GCM", iv }, key, cleartext);
  const ciphertext = new Uint8Array(encrypted);
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) throw new Error("This backup is too large to encrypt.");
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    backupVersion: ENCRYPTED_BACKUP_VERSION,
    encryption: "AES-256-GCM",
    keyDerivation: "PBKDF2-SHA-256",
    iterations: KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext)
  };
}

export async function decryptBackup(value, passphrase, cryptoProvider = globalThis.crypto) {
  validatePassphrase(passphrase);
  const envelope = validateEncryptedBackupEnvelope(value);
  const api = cryptoApi(cryptoProvider);
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    const key = await deriveKey(passphrase, salt, api, "decrypt");
    const cleartext = await api.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(cleartext));
  } catch {
    throw new Error("Could not unlock this backup. Check the passphrase or choose an undamaged backup file.");
  }
}
