import Link from "next/link";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { PAGE_SIZES, pageCount, pageWindow } from "@/lib/paging";
import { cn } from "@/lib/utils";

/**
 * "Showing 26–50 of 312", page numbers (1 … 4 5 6 … 13) with first, previous,
 * next and last, and a rows-per-page choice. Plain links that keep the other
 * filters in the address, so it works without JavaScript and pages can be
 * bookmarked. Two lists on one page use their own `pageParam`/`sizeParam`.
 */
export function Pagination({
  page,
  pageSize,
  total,
  basePath,
  params,
  pageParam = "page",
  sizeParam = "size",
  defaultSize,
  showSizes = true,
  label = "Pages",
  anchor,
  noun = "",
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  params: Record<string, string | undefined>;
  pageParam?: string;
  sizeParam?: string;
  /** The list's default size: left out of the address when chosen. */
  defaultSize?: number;
  showSizes?: boolean;
  label?: string;
  /** Keeps the reader at this list after a click (e.g. "recipients"). */
  anchor?: string;
  /** "clients", "pets"… for the summary. */
  noun?: string;
}) {
  if (total === 0) return null;
  const pages = pageCount(total, pageSize);
  const href = (p: number, size = pageSize) => {
    const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]) && e[0] !== pageParam && e[0] !== sizeParam));
    if (p > 1) q.set(pageParam, String(p));
    if (size !== (defaultSize ?? size)) q.set(sizeParam, String(size));
    const s = q.toString();
    return `${basePath}${s ? `?${s}` : ""}${anchor ? `#${anchor}` : ""}`;
  };
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const nav = (p: number, disabled: boolean, children: React.ReactNode, aria: string) =>
    disabled ? (
      <span aria-disabled className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none size-9 px-0 opacity-40")}>
        {children}
      </span>
    ) : (
      <Link href={href(p)} aria-label={aria} scroll={!anchor} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "size-9 px-0")}>
        {children}
      </Link>
    );
  const fmt = (n: number) => n.toLocaleString("en-US");

  return (
    <nav aria-label={label} className="flex flex-col gap-3 pt-3 text-small text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span aria-live="polite">
        Showing {fmt(from)}–{fmt(to)} of {fmt(total)}{noun ? ` ${noun}` : ""}
      </span>
      {pages > 1 && (
        <span className="flex flex-wrap items-center gap-1">
          {nav(1, page <= 1, <ChevronsLeft aria-hidden />, "First page")}
          {nav(page - 1, page <= 1, <ChevronLeft aria-hidden />, "Previous page")}
          {pageWindow(page, pages).map((p, i) =>
            p === "gap" ? (
              <span key={`gap-${i}`} aria-hidden className="px-1.5">
                …
              </span>
            ) : p === page ? (
              <span key={p} aria-current="page" className={cn(buttonVariants({ size: "sm" }), "h-9 min-w-9 px-2.5 tabular-nums")}>
                {p}
              </span>
            ) : (
              <Link key={p} href={href(p)} aria-label={`Page ${p}`} scroll={!anchor} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-9 min-w-9 px-2.5 tabular-nums")}>
                {p}
              </Link>
            ),
          )}
          {nav(page + 1, page >= pages, <ChevronRight aria-hidden />, "Next page")}
          {nav(pages, page >= pages, <ChevronsRight aria-hidden />, "Last page")}
        </span>
      )}
      {showSizes && total > PAGE_SIZES[0] && (
        <span className="flex items-center gap-1.5">
          <span>Rows</span>
          {PAGE_SIZES.map((s) =>
            s === pageSize ? (
              <span key={s} aria-current="true" className="rounded-md bg-muted px-2 py-1 font-medium text-foreground tabular-nums">
                {s}
              </span>
            ) : (
              // A new size starts again at page 1.
              <Link key={s} href={href(1, s)} scroll={!anchor} aria-label={`${s} rows per page`} className="rounded-md px-2 py-1 tabular-nums hover:bg-muted hover:text-foreground">
                {s}
              </Link>
            ),
          )}
        </span>
      )}
    </nav>
  );
}
