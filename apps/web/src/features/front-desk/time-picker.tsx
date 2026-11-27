"use client";

// Every free time Riley found, for tapping: one day at a time, any doctor or
// one doctor. A tapped time sends its exact words, which the engine books as
// is (that doctor, rooms and equipment re-checked when booking).
import { useMemo, useState } from "react";
import type { ChatChoice } from "@vetrix/domain";
import { cn } from "@/lib/utils";

type TimeChoice = ChatChoice & { time: NonNullable<ChatChoice["time"]> };

export function splitChoices(choices: ChatChoice[]): { quick: ChatChoice[]; times: TimeChoice[] } {
  return {
    quick: choices.filter((c) => !c.time),
    times: choices.filter((c): c is TimeChoice => Boolean(c.time)),
  };
}

export function TimePicker({ times, onPick, tone = "light" }: { times: TimeChoice[]; onPick: (value: string, label: string) => void; tone?: "light" | "dark" }) {
  const days = useMemo(() => [...new Map(times.map((t) => [t.time.date, t.time.day])).entries()], [times]);
  const doctors = useMemo(() => [...new Set(times.map((t) => t.time.doctor).filter((d): d is string => Boolean(d)))].sort(), [times]);
  const [day, setDay] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<string | null>(null);
  const activeDay = day && days.some(([d]) => d === day) ? day : days[0]?.[0];

  const shown = useMemo(() => {
    const onDay = times.filter((t) => t.time.date === activeDay && (!doctor || t.time.doctor === doctor));
    if (doctor) return onDay;
    // Any doctor: one button per time, naming who is free then.
    const byTime = new Map<string, { first: TimeChoice; names: string[] }>();
    for (const t of onDay) {
      const e = byTime.get(t.label);
      if (e) e.names.push(t.time.doctor ?? "");
      else byTime.set(t.label, { first: t, names: [t.time.doctor ?? ""] });
    }
    return [...byTime.values()].map((e) => ({ ...e.first, others: e.names.length - 1 }));
  }, [times, activeDay, doctor]);

  if (times.length === 0) return null;
  const dark = tone === "dark";
  const chip = (on: boolean) =>
    cn(
      "shrink-0 rounded-full border px-3 py-1.5 text-small font-semibold transition-colors",
      dark
        ? on ? "border-white bg-white text-primary-dark" : "border-white/40 bg-white/10 text-white hover:bg-white/20"
        : on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:border-primary",
    );

  return (
    <div className={cn("w-full space-y-2", dark ? "text-white" : "")} role="group" aria-label="All free times">
      <p className={cn("text-caption font-semibold uppercase tracking-wide", dark ? "text-white/70" : "text-muted-foreground")}>All free times</p>
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Day">
        {days.map(([d, label]) => (
          <button key={d} type="button" role="tab" aria-selected={d === activeDay} onClick={() => setDay(d)} className={chip(d === activeDay)}>
            {label}
          </button>
        ))}
      </div>
      {doctors.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Doctor">
          <button type="button" aria-pressed={!doctor} onClick={() => setDoctor(null)} className={chip(!doctor)}>
            Any doctor
          </button>
          {doctors.map((d) => (
            <button key={d} type="button" aria-pressed={doctor === d} onClick={() => setDoctor(d)} className={chip(doctor === d)}>
              {d}
            </button>
          ))}
        </div>
      )}
      <div className="grid max-h-48 grid-cols-3 gap-1.5 overflow-y-auto pr-1">
        {shown.length === 0 && <p className={cn("col-span-3 text-small", dark ? "text-white/70" : "text-muted-foreground")}>No free times with {doctor} this day.</p>}
        {shown.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => onPick(t.value, t.value)}
            className={cn(
              "rounded-lg border px-1.5 py-1.5 text-center leading-tight transition-colors",
              dark ? "border-white/40 bg-white/10 hover:bg-white hover:text-primary-dark" : "border-primary/40 bg-card text-primary hover:bg-primary hover:text-primary-foreground",
            )}
          >
            <span className="block text-small font-semibold">{t.label}</span>
            {!doctor && t.time.doctor && (
              <span className="block truncate text-caption opacity-80">
                {t.time.doctor}
                {"others" in t && (t as { others: number }).others > 0 ? ` +${(t as { others: number }).others}` : ""}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
