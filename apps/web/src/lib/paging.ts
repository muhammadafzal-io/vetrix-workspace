// Paging for list pages, from the address bar: ?page=3&size=50. Pure, so the
// rules are tested on their own (paging.test.ts) and every list behaves alike.

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface Paging {
  page: number;
  pageSize: number;
  offset: number;
}

/**
 * Reads the page and page size. Anything odd (0, -1, "abc", 7) falls back to
 * page 1 and the list's default size; sizes are limited to PAGE_SIZES so a
 * crafted address cannot ask for 100,000 rows.
 */
export function readPaging(
  sp: Record<string, string | string[] | undefined>,
  options: { defaultSize: PageSize; pageParam?: string; sizeParam?: string },
): Paging {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const rawPage = Number(one(options.pageParam ?? "page"));
  const rawSize = Number(one(options.sizeParam ?? "size"));
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 100_000 ? rawPage : 1;
  const pageSize = (PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : options.defaultSize;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** The last page that exists, when the address asks for one past the end (null: the page is fine). */
export function outOfRange(page: number, total: number, pageSize: number): number | null {
  const last = pageCount(total, pageSize);
  return total > 0 && page > last ? last : null;
}

/**
 * The page numbers to show: always the first and last, the current one and
 * its neighbours, with "…" for gaps. 1 … 4 5 6 … 20
 */
export function pageWindow(page: number, pages: number, around = 1): (number | "gap")[] {
  const wanted = new Set([1, pages]);
  for (let p = page - around; p <= page + around; p++) if (p >= 1 && p <= pages) wanted.add(p);
  // A gap of one page is shown as that page, not "…".
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  for (const p of sorted) {
    const prev = out.length ? (out[out.length - 1] as number) : null;
    if (prev !== null && p - prev === 2) out.push(prev + 1);
    else if (prev !== null && p - prev > 2) out.push("gap");
    out.push(p);
  }
  return out;
}

/** A slice of an in-memory list (lists the page builds itself, e.g. reminders). */
export function slicePage<T>(items: readonly T[], paging: Paging): T[] {
  return items.slice(paging.offset, paging.offset + paging.pageSize);
}

/** The same address with another page (used to send a page past the end to the last one). */
export function pageUrl(basePath: string, sp: Record<string, string | string[] | undefined>, page: number, pageParam = "page"): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (one && k !== pageParam) q.set(k, one);
  }
  if (page > 1) q.set(pageParam, String(page));
  const s = q.toString();
  return s ? `${basePath}?${s}` : basePath;
}
