import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { localFileStore } from "./file-store";
import { processVisitPhoto } from "./photo-processing";

/** A phone-like photo: EXIF with a GPS position and a "rotate 90°" orientation flag. */
async function phonePhoto(width = 3000, height = 2000) {
  return sharp({ create: { width, height, channels: 3, background: "#c0392b" } })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: "PhoneCo" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "31/1 30/1 0/1" } })
    .jpeg()
    .toBuffer();
}

describe("processVisitPhoto", () => {
  it("removes all metadata (including GPS), turns the photo upright and limits its size", async () => {
    const input = await phonePhoto();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);

    const out = await processVisitPhoto(new Uint8Array(input));
    const meta = await sharp(out.original).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("jpeg");
    // Orientation 6 means the camera was turned: the stored photo is portrait.
    expect(out.height).toBeGreaterThan(out.width);
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(2400);
    const thumb = await sharp(out.thumb).metadata();
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(400);
    expect(thumb.exif).toBeUndefined();
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("turns PNG (with transparency) into JPEG and does not enlarge small photos", async () => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await processVisitPhoto(new Uint8Array(png));
    expect((await sharp(out.original).metadata()).format).toBe("jpeg");
    expect([out.width, out.height]).toEqual([300, 200]);
  });

  it("refuses a file that only looks like an image", async () => {
    const fake = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
    await expect(processVisitPhoto(fake)).rejects.toThrow(/could not be read/);
  });
});

describe("local file store", () => {
  it("stores, reads and removes files, and never overwrites one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vetrix-files-"));
    try {
      const store = localFileStore(root);
      await store.put("orgs/a/b.jpg", Buffer.from("one"), "image/jpeg");
      expect((await store.get("orgs/a/b.jpg"))?.toString()).toBe("one");
      await expect(store.put("orgs/a/b.jpg", Buffer.from("two"), "image/jpeg")).rejects.toThrow();
      await store.remove("orgs/a/b.jpg");
      expect(await store.get("orgs/a/b.jpg")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses keys that try to leave the storage folder", async () => {
    const store = localFileStore(path.join(tmpdir(), "vetrix-never-created"));
    for (const key of ["../secret.jpg", "/etc/passwd.jpg", "orgs/../../x.jpg", "orgs//x.jpg", "no-extension"]) {
      await expect(store.get(key)).rejects.toThrow(/Bad storage key/);
    }
  });
});
