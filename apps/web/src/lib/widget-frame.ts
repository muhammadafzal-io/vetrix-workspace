// Which websites may show a clinic's booking widget in a frame. Read from the
// clinic database and cached for a minute per organization.
import "server-only";
import { logger } from "./logger";
import { tenancy } from "./tenancy";

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const g = globalThis as unknown as { vetrixWidgetFrames?: Map<string, { origins: string[]; until: number }> };
const cache = (g.vetrixWidgetFrames ??= new Map());

export async function widgetFrameOrigins(org: string): Promise<string[]> {
  const hit = cache.get(org);
  if (hit && hit.until > Date.now()) return hit.origins;
  let origins: string[] = [];
  try {
    const { pool } = await tenancy().clinicPool(org);
    const { rows } = await pool.query<{ origins: string[] }>(
      `SELECT coalesce(array_agg(DISTINCT o), '{}') AS origins FROM locations, unnest(widget_origins) AS o WHERE widget_enabled`,
    );
    origins = (rows[0]?.origins ?? []).filter((o) => ORIGIN.test(o));
  } catch (error) {
    logger.warn("widget frame origins unavailable", { error: (error as Error).name });
  }
  if (cache.size > 1000) cache.clear();
  cache.set(org, { origins, until: Date.now() + 60_000 });
  return origins;
}

/** Saving settings shows the change straight away on this server. */
export function forgetWidgetFrameOrigins(org: string): void {
  cache.delete(org);
}
