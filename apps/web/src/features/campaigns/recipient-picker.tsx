"use client";

// Step 4: who it is actually sent to. Everyone the rules match (as before),
// or only the clients staff tick. Ticked clients must still match the rules
// when sending starts, and consent, do-not-contact and the 7-day limit are
// still checked per message (validateChosenRecipients / limitToChosen in
// @vetrix/domain). Ticks are kept in this browser until "Save recipients".
import { useEffect, useRef, useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Search, UserCheck } from "lucide-react";
import { SKIP_REASON_LABEL, type CampaignChannel } from "@vetrix/domain";
import type { AudiencePreview } from "@vetrix/db/runtime";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { recipientChoicesAction, saveRecipientsAction } from "./actions";

/** Rows per page (matches the server action). */
const PICK_PAGE = 25;
const CHANNEL_LABEL: Record<CampaignChannel, string> = { sms: "Text", email: "Email" };

export function RecipientPicker({
  campaignId,
  savedIds,
  channels,
  locked,
}: {
  campaignId: string;
  /** null = everyone who matches. */
  savedIds: string[] | null;
  channels: CampaignChannel[];
  locked: boolean;
}) {
  const [mode, setMode] = useState<"all" | "chosen">(savedIds ? "chosen" : "all");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(savedIds ?? []));
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AudiencePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, startLoad] = useTransition();
  const [saving, startSave] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setOffset(0), [search]);

  // The list is only needed when picking.
  useEffect(() => {
    if (mode !== "chosen") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      startLoad(async () => {
        const r = await recipientChoicesAction(campaignId, search, offset);
        if (r.ok) {
          setPage(r.preview);
          setProblem(null);
        } else setProblem(r.error);
      });
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [campaignId, mode, search, offset]);

  const change = (fn: () => void) => {
    fn();
    setDirty(true);
    setResult(null);
  };
  const toggle = (id: string) =>
    change(() =>
      setChosen((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    );
  const pageIds = page?.sample.map((s) => s.clientId) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => chosen.has(id));

  const save = () =>
    startSave(async () => {
      const r = await saveRecipientsAction(campaignId, mode, [...chosen]);
      setResult(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
      if (r.ok) setDirty(false);
    });

  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <p className="flex items-center gap-2 text-small font-semibold">
        <UserCheck className="size-4 text-primary" aria-hidden /> Recipients
      </p>

      <fieldset disabled={locked} className="grid gap-2">
        <legend className="sr-only">Who receives this campaign</legend>
        {(
          [
            ["all", "Everyone who matches the rules", "All clients from step 2 who can receive it."],
            ["chosen", "Only clients I choose", "Tick clients below. They must still match the rules when it sends."],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/50", mode === value && "border-primary bg-primary/5")}>
            <input
              type="radio"
              name={`recipients-${campaignId}`}
              value={value}
              checked={mode === value}
              onChange={() => change(() => setMode(value))}
              className="mt-0.5 size-4 accent-[var(--primary)]"
            />
            <span className="grid gap-0.5">
              <span className="text-small font-medium">
                {label}
                {value === "chosen" && mode === "chosen" ? ` · ${chosen.size} chosen` : ""}
              </span>
              <span className="text-caption text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === "chosen" && (
        <div className="grid gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <label htmlFor={`pick-search-${campaignId}`} className="sr-only">
                Search clients or pets
              </label>
              <Input id={`pick-search-${campaignId}`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client or pet name" className="pl-9" />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked || pageIds.length === 0}
                onClick={() =>
                  change(() =>
                    setChosen((s) => {
                      const n = new Set(s);
                      for (const id of pageIds) {
                        if (allOnPage) n.delete(id);
                        else n.add(id);
                      }
                      return n;
                    }),
                  )
                }
              >
                {allOnPage ? "Untick this page" : "Tick this page"}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={locked || chosen.size === 0} onClick={() => change(() => setChosen(new Set()))}>
                Clear all
              </Button>
            </div>
          </div>

          {problem && <p className="text-caption text-destructive">{problem}</p>}
          {page && page.sample.length === 0 && !loading && (
            <p className="text-small text-muted-foreground">{search ? "No matching client has that name." : "No client matches the rules in step 2."}</p>
          )}
          <ul className={cn("grid", loading && "opacity-60")} aria-busy={loading}>
            {page?.sample.map((s) => {
              const reachable = channels.filter((ch) => !s.channels[ch]);
              return (
                <li key={s.clientId} className="border-t">
                  <label className="flex cursor-pointer items-start gap-3 py-2 hover:bg-muted/40">
                    <input
                      type="checkbox"
                      checked={chosen.has(s.clientId)}
                      disabled={locked}
                      onChange={() => toggle(s.clientId)}
                      className="mt-0.5 size-4 cursor-pointer accent-[var(--primary)]"
                    />
                    <span className="grid flex-1 gap-0.5">
                      <span className="text-small">
                        {s.clientName} <span className="text-muted-foreground">· {s.petNames}</span>
                      </span>
                      <span className={cn("text-caption", reachable.length ? "text-muted-foreground" : "text-warning-text")}>
                        {channels.map((ch) => `${CHANNEL_LABEL[ch]}: ${s.channels[ch] ? SKIP_REASON_LABEL[s.channels[ch]!].toLowerCase() : "yes"}`).join(" · ")}
                        {reachable.length === 0 ? " (won't receive it)" : ""}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {page && page.sampleTotal > PICK_PAGE && (
            <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
              <span aria-live="polite">
                {page.sampleOffset + 1}–{Math.min(page.sampleOffset + PICK_PAGE, page.sampleTotal)} of {page.sampleTotal}
              </span>
              <span className="flex gap-1">
                <Button type="button" variant="outline" size="sm" aria-label="Previous clients" disabled={loading || page.sampleOffset === 0} onClick={() => setOffset((o) => Math.max(0, o - PICK_PAGE))}>
                  <ChevronLeft aria-hidden />
                </Button>
                <Button type="button" variant="outline" size="sm" aria-label="Next clients" disabled={loading || page.sampleOffset + PICK_PAGE >= page.sampleTotal} onClick={() => setOffset((o) => o + PICK_PAGE)}>
                  <ChevronRight aria-hidden />
                </Button>
              </span>
            </div>
          )}
        </div>
      )}

      {!locked && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant={dirty ? "default" : "outline"} size="sm" disabled={saving || !dirty || (mode === "chosen" && chosen.size === 0)} onClick={save}>
            {saving && <Loader2 className="animate-spin" aria-hidden />} Save recipients
          </Button>
          {dirty && <span className="text-caption text-muted-foreground">Not saved yet: sending uses the saved choice.</span>}
        </div>
      )}
      {result && (
        <Alert variant={result.ok ? "success" : "error"}>
          {result.ok ? <CheckCircle2 aria-hidden /> : <AlertCircle aria-hidden />}
          <p>{result.text}</p>
        </Alert>
      )}
    </div>
  );
}
