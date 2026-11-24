"use client";

// Step 2: who the campaign goes to. One level of rules, matched ALL (and) or
// ANY (or), with a live count of who can receive it on each channel. Rules
// are checked again on the server (validateAudience) when saved and at send.
import { useEffect, useRef, useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus, Trash2, Users } from "lucide-react";
import { AUDIENCE_CONDITION_LABEL, MAX_AUDIENCE_CONDITIONS, SKIP_REASON_LABEL, type Audience, type AudienceCondition, type CampaignChannel, type SkipReason } from "@vetrix/domain";
import type { AudiencePreview } from "@vetrix/db/runtime";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { previewAudienceAction, saveAudienceAction } from "./actions";

/** One rule as the form holds it: numbers stay text until the server checks them. */
type Row = {
  key: number;
  type: AudienceCondition["type"];
  values?: string[];
  minYears?: string;
  maxYears?: string;
  op?: string;
  months?: string;
  state?: string;
  days?: string;
  service?: string;
};

const CHANNEL_LABEL: Record<CampaignChannel, string> = { sms: "Text", email: "Email" };

const blank = (type: Row["type"], key: number): Row =>
  type === "species" ? { key, type, values: [] }
  : type === "pet_age" ? { key, type, minYears: "", maxYears: "" }
  : type === "last_visit" ? { key, type, op: "more_than", months: "12" }
  : type === "vaccine" ? { key, type, state: "overdue", days: "30" }
  : { key, type, service: "", months: "12" };

const toRows = (a: Audience): Row[] => a.conditions.map((c, key) => ({ key, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? v : String(v)])) }) as Row);
const toRaw = (match: string, rows: Row[]) => ({
  match,
  conditions: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "key"))),
});

export function AudienceBuilder({
  campaignId,
  saved,
  channels,
  options,
  locked,
}: {
  campaignId: string;
  saved: Audience;
  channels: CampaignChannel[];
  options: { species: string[]; services: { id: string; name: string }[] };
  locked: boolean;
}) {
  const [match, setMatch] = useState<"all" | "any">(saved.match);
  const [rows, setRows] = useState<Row[]>(() => (saved.conditions.length ? toRows(saved) : [blank("species", 0)]));
  const [nextKey, setNextKey] = useState(rows.length);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, startCheck] = useTransition();
  const [saving, startSave] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Count again shortly after each change.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      startCheck(async () => {
        const r = await previewAudienceAction(campaignId, toRaw(match, rows), channels);
        if (r.ok) {
          setPreview(r.preview);
          setProblem(null);
        } else {
          setPreview(null);
          setProblem(r.error);
        }
      });
    }, 500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [campaignId, match, rows, channels]);

  const update = (key: number, change: Partial<Row>) => {
    setSaveState(null);
    setRows((rs) => rs.map((r) => (r.key === key ? ({ ...r, ...change } as Row) : r)));
  };

  return (
    <div className="grid gap-4">
      <fieldset disabled={locked} className="grid gap-3">
        <legend className="sr-only">Audience rules</legend>
        <label className="flex flex-wrap items-center gap-2 text-small">
          Clients whose pets match
          <Select className="h-9 w-24 sm:h-9" value={match} onChange={(e) => { setMatch(e.currentTarget.value as "all" | "any"); setSaveState(null); }} aria-label="Match all or any">
            <option value="all">all</option>
            <option value="any">any</option>
          </Select>
          of these rules:
        </label>
        {rows.map((r, i) => (
          <div key={r.key} className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 p-3">
            <label className="grid min-w-44 gap-1 text-caption font-medium">
              Rule {i + 1}
              <Select
                value={r.type}
                onChange={(e) => {
                  // Read the value now: the state updater runs after the event is gone.
                  const type = e.currentTarget.value as Row["type"];
                  setSaveState(null);
                  setRows((rs) => rs.map((x) => (x.key === r.key ? blank(type, r.key) : x)));
                }}
              >
                {(Object.keys(AUDIENCE_CONDITION_LABEL) as Row["type"][]).map((t) => (
                  <option key={t} value={t}>{AUDIENCE_CONDITION_LABEL[t]}</option>
                ))}
              </Select>
            </label>
            {r.type === "species" && (
              <div className="flex flex-wrap gap-3 pb-2" role="group" aria-label="Species">
                {options.species.map((sp) => (
                  <label key={sp} className="flex items-center gap-1.5 text-small capitalize">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={(r.values as string[]).includes(sp)}
                      onChange={(e) => { const on = e.currentTarget.checked; update(r.key, { values: on ? [...(r.values as string[]), sp] : (r.values as string[]).filter((v) => v !== sp) }); }}
                    />
                    {`${sp}s`}
                  </label>
                ))}
              </div>
            )}
            {r.type === "pet_age" && (
              <>
                <label className="grid w-24 gap-1 text-caption font-medium">From (years)<Input type="number" min={0} max={40} value={r.minYears as string} onChange={(e) => update(r.key, { minYears: e.currentTarget.value })} /></label>
                <label className="grid w-24 gap-1 text-caption font-medium">To (years)<Input type="number" min={0} max={40} value={r.maxYears as string} onChange={(e) => update(r.key, { maxYears: e.currentTarget.value })} /></label>
              </>
            )}
            {r.type === "last_visit" && (
              <>
                <label className="grid min-w-36 gap-1 text-caption font-medium">
                  Last visit
                  <Select value={r.op as string} onChange={(e) => update(r.key, { op: e.currentTarget.value })}>
                    <option value="more_than">more than (or never)</option>
                    <option value="within">within the last</option>
                  </Select>
                </label>
                <label className="grid w-24 gap-1 text-caption font-medium">Months<Input type="number" min={1} max={120} value={r.months as string} onChange={(e) => update(r.key, { months: e.currentTarget.value })} /></label>
              </>
            )}
            {r.type === "vaccine" && (
              <>
                <label className="grid min-w-40 gap-1 text-caption font-medium">
                  A vaccine is
                  <Select value={r.state as string} onChange={(e) => update(r.key, { state: e.currentTarget.value })}>
                    <option value="overdue">overdue</option>
                    <option value="due_within">due within</option>
                  </Select>
                </label>
                {r.state === "due_within" && <label className="grid w-24 gap-1 text-caption font-medium">Days<Input type="number" min={1} max={180} value={r.days as string} onChange={(e) => update(r.key, { days: e.currentTarget.value })} /></label>}
              </>
            )}
            {r.type === "service_gap" && (
              <>
                <label className="grid min-w-48 flex-1 gap-1 text-caption font-medium">
                  Service
                  <Select value={r.service as string} onChange={(e) => update(r.key, { service: e.currentTarget.value })}>
                    <option value="">Choose a service</option>
                    {options.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </label>
                <label className="grid w-28 gap-1 text-caption font-medium">Not in (months)<Input type="number" min={1} max={120} value={r.months as string} onChange={(e) => update(r.key, { months: e.currentTarget.value })} /></label>
              </>
            )}
            <Button type="button" variant="ghost" size="sm" className="ml-auto" aria-label={`Remove rule ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" disabled={rows.length >= MAX_AUDIENCE_CONDITIONS} onClick={() => { setRows((rs) => [...rs, blank("last_visit", nextKey)]); setNextKey((k) => k + 1); }}>
            <Plus aria-hidden /> Add rule
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || Boolean(problem)}
            onClick={() => startSave(async () => {
              const r = await saveAudienceAction(campaignId, toRaw(match, rows));
              setSaveState(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
            })}
          >
            {saving && <Loader2 className="animate-spin" aria-hidden />} Save audience
          </Button>
        </div>
      </fieldset>

      {saveState && (
        <Alert variant={saveState.ok ? "success" : "error"}>
          {saveState.ok ? <CheckCircle2 aria-hidden /> : <AlertCircle aria-hidden />}
          <p>{saveState.text}</p>
        </Alert>
      )}

      <div className="grid gap-3 rounded-lg border p-4" aria-live="polite">
        <p className="flex items-center gap-2 text-small font-semibold">
          {checking ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Users className="size-4" aria-hidden />}
          {problem ? "Finish the rules to see who is included" : preview ? `${preview.clients} client${preview.clients === 1 ? "" : "s"} (${preview.pets} pet${preview.pets === 1 ? "" : "s"}) match today` : "Counting…"}
        </p>
        {problem && <p className="text-caption text-muted-foreground">{problem}</p>}
        {preview && !problem && (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {channels.map((ch) => {
                const p = preview.perChannel[ch];
                if (!p) return null;
                return (
                  <div key={ch} className="rounded-md bg-muted/40 px-3 py-2">
                    <p className="text-small font-medium">{CHANNEL_LABEL[ch]}: {p.send} can receive it</p>
                    {Object.entries(p.skipped).map(([reason, n]) => (
                      <p key={reason} className="text-caption text-muted-foreground">{n} skipped · {SKIP_REASON_LABEL[reason as SkipReason]}</p>
                    ))}
                  </div>
                );
              })}
            </div>
            {preview.sample.length > 0 && (
              <details className="text-small">
                <summary className="cursor-pointer font-medium text-primary">See who is included{preview.clients > preview.sample.length ? ` (first ${preview.sample.length})` : ""}</summary>
                <ul className="mt-2 grid gap-1">
                  {preview.sample.map((s, i) => (
                    <li key={i} className="flex flex-wrap justify-between gap-x-3 border-t py-1.5">
                      <span>{s.clientName} <span className="text-muted-foreground">· {s.petNames}</span></span>
                      <span className="text-caption text-muted-foreground">
                        {channels.map((ch) => `${CHANNEL_LABEL[ch]}: ${s.channels[ch] ? SKIP_REASON_LABEL[s.channels[ch]!].toLowerCase() : "yes"}`).join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-caption text-muted-foreground">Checked again when it sends: consent, do-not-contact and the 7-day limit can change by then.</p>
          </>
        )}
      </div>
    </div>
  );
}
