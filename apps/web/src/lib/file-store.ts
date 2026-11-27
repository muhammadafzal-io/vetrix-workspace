// Private file storage for visit photos. Files are never public: they are
// read back only through a route that checks the person's permission
// (app/api/visit-photos/[id]/route.ts). Two drivers behind one interface:
//   local: apps/web/.storage on this machine (development; gitignored)
//   gcs:   a private Google Cloud Storage bucket (staging and production)
import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RuleViolationError } from "@vetrix/domain";
import { getEnv } from "./env";

export interface FileStore {
  readonly driver: "local" | "gcs";
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** null when the file is missing. */
  get(key: string): Promise<Buffer | null>;
  /** Used only to undo an upload whose database row was not saved. */
  remove(key: string): Promise<void>;
}

/** Keys come from visitPhotoKeys (ids only); this refuses anything else. */
function checkKey(key: string): string {
  if (!/^[a-z0-9][a-z0-9/_-]*\.[a-z0-9]+$/i.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error("Bad storage key");
  }
  return key;
}

/** Exported for tests; the app uses fileStore(). */
export function localFileStore(root = path.resolve(process.cwd(), ".storage")): FileStore {
  const full = (key: string) => {
    const p = path.resolve(root, checkKey(key));
    if (!p.startsWith(root + path.sep)) throw new Error("Bad storage key");
    return p;
  };
  return {
    driver: "local",
    async put(key, bytes) {
      const p = full(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, bytes, { flag: "wx" });
    },
    async get(key) {
      try {
        return await readFile(full(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(key) {
      await rm(full(key), { force: true });
    },
  };
}

async function gcsStore(bucketName: string, credentialsBase64: string | undefined): Promise<FileStore> {
  const { Storage } = await import("@google-cloud/storage");
  const storage = new Storage(
    credentialsBase64 ? { credentials: JSON.parse(Buffer.from(credentialsBase64, "base64").toString("utf8")) } : {},
  );
  const bucket = storage.bucket(bucketName);
  return {
    driver: "gcs",
    async put(key, bytes, contentType) {
      // ifGenerationMatch 0: never overwrite an existing file.
      await bucket.file(checkKey(key)).save(bytes, { contentType, resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    },
    async get(key) {
      try {
        const [bytes] = await bucket.file(checkKey(key)).download();
        return bytes;
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
        throw error;
      }
    },
    async remove(key) {
      await bucket.file(checkKey(key)).delete({ ignoreNotFound: true });
    },
  };
}

let cached: Promise<FileStore> | undefined;

/** The configured store. Throws a message staff can read when none is set up. */
export function fileStore(): Promise<FileStore> {
  const env = getEnv();
  const driver = env.FILE_STORAGE ?? (env.NODE_ENV === "production" ? undefined : "local");
  if (!driver) {
    return Promise.reject(new RuleViolationError("files.not_configured", "Photo storage is not set up yet, so photos can't be uploaded. Notes and prescriptions still work."));
  }
  cached ??= driver === "gcs" ? gcsStore(env.GCS_BUCKET!, env.GCS_CREDENTIALS_BASE64) : Promise.resolve(localFileStore());
  cached.catch(() => (cached = undefined));
  return cached;
}
