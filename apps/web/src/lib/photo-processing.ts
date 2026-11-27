// Turns an uploaded photo into what is stored: re-encoded as JPEG (so only
// plain pixels are kept, nothing the browser could run), turned upright,
// resized, and with all metadata removed. Phone photos carry the GPS
// location where they were taken in EXIF; sharp drops it unless asked to keep it.
import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ValidationError, VISIT_PHOTO_LIMITS } from "@vetrix/domain";

export interface ProcessedPhoto {
  original: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  /** Of the uploaded bytes: the same photo uploaded twice is stored once. */
  sha256: string;
}

export async function processVisitPhoto(upload: Uint8Array): Promise<ProcessedPhoto> {
  const input = Buffer.from(upload);
  // limitInputPixels refuses "decompression bombs" (small files that decode to huge images).
  const image = () => sharp(input, { limitInputPixels: VISIT_PHOTO_LIMITS.maxPixels, failOn: "error" }).rotate();
  try {
    const { data: original, info } = await image()
      .resize({ width: VISIT_PHOTO_LIMITS.maxEdge, height: VISIT_PHOTO_LIMITS.maxEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const thumb = await image()
      .resize({ width: VISIT_PHOTO_LIMITS.thumbEdge, height: VISIT_PHOTO_LIMITS.thumbEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 75 })
      .toBuffer();
    return { original, thumb, width: info.width, height: info.height, sha256: createHash("sha256").update(input).digest("hex") };
  } catch {
    throw new ValidationError("This photo could not be read. Try another one, or export it as JPEG.", { field: "photo" });
  }
}
