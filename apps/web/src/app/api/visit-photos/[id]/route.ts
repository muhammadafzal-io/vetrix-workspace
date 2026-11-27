// Serves one visit photo (or its thumbnail with ?size=thumb) to signed-in
// staff with records.view at the active location. Photos have no public
// link: the bucket is private and every view passes this check. Anyone else
// gets 404, so the route does not even confirm a photo exists.
import { NextResponse, type NextRequest } from "next/server";
import { visitPhotoFile } from "@vetrix/db/runtime";
import { fileStore } from "@/lib/file-store";
import { logger } from "@/lib/logger";
import { requireShell } from "@/lib/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NextResponse("Not found", { status: 404 });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const shell = await requireShell();
  if (!shell.permissions.has("records.view")) return notFound();
  const photo = await visitPhotoFile(shell.clinic, shell.location.id, id);
  if (!photo) return notFound();
  try {
    const bytes = await (await fileStore()).get(request.nextUrl.searchParams.get("size") === "thumb" ? photo.thumbKey : photo.storageKey);
    if (!bytes) return notFound();
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        // Private: kept by this browser only, never by shared caches.
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    logger.error("could not read a visit photo", { error, photoId: id });
    return new NextResponse("Could not load the photo", { status: 503 });
  }
}
