// tenant_databases.database_ref says where a clinic database's connection
// string lives. The registry never stores it in plain text.
//   env:NAME          read from an environment variable (local development)
//   enc:v1:DATA       the connection string itself, encrypted with AES-256-GCM
//                     using DATABASE_SECRETS_KEY (clinics added from the app)
//   gcp-secret:NAME   GCP Secret Manager (not supported yet)
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class DatabaseRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRefError";
  }
}

export function resolveDatabaseRef(
  ref: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const [kind, name] = ref.split(":", 2);
  if (kind === "enc") {
    const url = decryptDatabaseUrl(ref, env.DATABASE_SECRETS_KEY);
    assertPostgresUrl(url, "encrypted database_ref");
    return url;
  }
  if (kind === "env" && name) {
    const url = env[name];
    if (!url) throw new DatabaseRefError(`Environment variable ${name} (from database_ref "${ref}") is not set`);
    assertPostgresUrl(url, name);
    return url;
  }
  if (kind === "gcp-secret") {
    throw new DatabaseRefError(`database_ref "${ref}": GCP Secret Manager refs are not supported yet`);
  }
  throw new DatabaseRefError(`database_ref "${ref.slice(0, 12)}…" must look like env:NAME, enc:v1:… or gcp-secret:NAME`);
}

export function assertPostgresUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseRefError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new DatabaseRefError(`${label} must be a postgresql:// URL`);
  }
}

/** "ep-x-pooler.c-15.us-east-1.aws.neon.tech" -> "aws-us-east-1". */
export function neonRegionFromUrl(url: string): string {
  const host = new URL(url).hostname;
  const match = host.match(/\.([a-z]{2}-[a-z]+-\d)\.(aws|azure)\.neon\.tech$/);
  return match ? `${match[2]}-${match[1]}` : "unknown";
}

/** host/database only, safe for logs. */
export function describeUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.pathname}`;
}

// ---------- Encrypted references ----------
//
// AES-256-GCM: the 12-byte IV is random per value and the 16-byte tag proves
// the value was not changed. Stored as enc:v1:<base64url(iv | tag | ciphertext)>.
// "v1" leaves room to rotate to a new key later. Losing DATABASE_SECRETS_KEY
// means these connection strings cannot be read back: keep a backup of it.

const ENC_PREFIX = "enc:v1:";

function secretsKey(keyText: string | undefined): Buffer {
  if (!keyText) throw new DatabaseRefError("DATABASE_SECRETS_KEY is not set; it is needed for encrypted database references");
  const key = Buffer.from(keyText, "base64");
  if (key.length !== 32) throw new DatabaseRefError("DATABASE_SECRETS_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)");
  return key;
}

/** Encrypts a clinic database connection string for tenant_databases.database_ref. */
export function encryptDatabaseUrl(url: string, keyText: string | undefined): string {
  assertPostgresUrl(url, "connection string");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretsKey(keyText), iv);
  const data = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export function decryptDatabaseUrl(ref: string, keyText: string | undefined): string {
  if (!ref.startsWith(ENC_PREFIX)) throw new DatabaseRefError("encrypted database_ref must start with enc:v1:");
  const raw = Buffer.from(ref.slice(ENC_PREFIX.length), "base64url");
  if (raw.length < 29) throw new DatabaseRefError("encrypted database_ref is too short");
  try {
    const decipher = createDecipheriv("aes-256-gcm", secretsKey(keyText), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof DatabaseRefError) throw error;
    // Wrong key or a changed value. Never include the value in the message.
    throw new DatabaseRefError("encrypted database_ref could not be decrypted (wrong DATABASE_SECRETS_KEY?)");
  }
}
