"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowLeft, CalendarCheck2, CheckCircle2, Loader2, PawPrint, Phone } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { bookLinkAction, linkTimesAction, type BookResult, type TimesResult } from "./actions";

export interface FlowPet {
  patientId: string;
  name: string;
  serviceName: string | null;
  booked: { start: number; serviceName: string } | null;
  unavailable: string | null;
}

type Time = { start: number; providerId: string; providerName: string };
type Booked = Extract<BookResult, { status: "booked" }>;

const fmt = (tz: string, o: Intl.DateTimeFormatOptions) => (t: number) => new Intl.DateTimeFormat("en-US", { ...o, timeZone: tz }).format(t);

export function BookingFlow({
  org,
  token,
  firstName,
  clinicName,
  clinicPhone,
  timezone,
  pets: initialPets,
}: {
  org: string;
  token: string;
  firstName: string;
  clinicName: string;
  clinicPhone: { text: string; href: string } | null;
  timezone: string;
  pets: FlowPet[];
}) {
  const [pets, setPets] = useState(initialPets);
  const open = pets.filter((p) => !p.booked && !p.unavailable);
  const [petId, setPetId] = useState<string | null>(open.length === 1 && pets.length === 1 ? open[0]!.patientId : null);
  const [done, setDone] = useState<Booked | null>(null);
  const pet = pets.find((p) => p.patientId === petId) ?? null;

  const longDate = fmt(timezone, { weekday: "long", month: "long", day: "numeric" });
  const time = fmt(timezone, { hour: "numeric", minute: "2-digit" });

  if (done) {
    const others = pets.filter((p) => p.patientId !== petId && !p.booked && !p.unavailable);
    return (
      <section className="grid gap-5 rounded-xl border bg-card p-6 text-center shadow-card">
        <CheckCircle2 className="mx-auto size-12 text-success" aria-hidden />
        <div className="grid gap-1">
          <h1 className="text-h2 font-semibold">{done.petName} is booked</h1>
          <p className="text-muted-foreground">{done.serviceName}</p>
        </div>
        <div className="mx-auto grid gap-0.5 rounded-lg bg-muted/50 px-5 py-3">
          <p className="font-semibold">{longDate(done.start)}</p>
          <p>
            {time(done.start)} with {done.providerName}
          </p>
        </div>
        <p className="text-small text-muted-foreground">
          {done.confirmation === "sms"
            ? "We've sent you a confirmation text. Reply C to confirm or R to reschedule."
            : done.confirmation === "email"
              ? "We've emailed you a confirmation."
              : `Need to change it? Call ${clinicName}${clinicPhone ? ` at ${clinicPhone.text}` : ""}.`}
        </p>
        {others.length > 0 && (
          <Button
            variant="outline"
            className="mx-auto"
            onClick={() => {
              setPets((all) => all.map((p) => (p.patientId === petId ? { ...p, booked: { start: done.start, serviceName: done.serviceName } } : p)));
              setDone(null);
              setPetId(null);
            }}
          >
            <PawPrint aria-hidden /> Book for {others.map((o) => o.name).join(" and ")}
          </Button>
        )}
      </section>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-h2 font-semibold">Hi {firstName}</h1>
        <p className="text-muted-foreground">{pet ? `Choose a time for ${pet.name}.` : "Who are we seeing?"}</p>
      </div>

      {!pet ? (
        <ul className="grid gap-3">
          {pets.map((p) => (
            <li key={p.patientId}>
              <PetCard pet={p} longDate={longDate} time={time} clinicPhone={clinicPhone} onChoose={() => setPetId(p.patientId)} />
            </li>
          ))}
        </ul>
      ) : (
        <Times
          org={org}
          token={token}
          pet={pet}
          timezone={timezone}
          clinicPhone={clinicPhone}
          onBack={pets.length > 1 ? () => setPetId(null) : undefined}
          onBooked={setDone}
        />
      )}
    </div>
  );
}

function PetCard({
  pet,
  longDate,
  time,
  clinicPhone,
  onChoose,
}: {
  pet: FlowPet;
  longDate: (t: number) => string;
  time: (t: number) => string;
  clinicPhone: { text: string; href: string } | null;
  onChoose: () => void;
}) {
  const ready = !pet.booked && !pet.unavailable;
  return (
    <div className={cn("flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4 shadow-card", ready && "hover:border-primary/40")}>
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
        <PawPrint className="size-5" aria-hidden />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="font-semibold">{pet.name}</p>
        {pet.booked ? (
          <p className="flex items-center gap-1.5 text-small text-success-text">
            <CalendarCheck2 className="size-4" aria-hidden /> {pet.booked.serviceName}: {longDate(pet.booked.start)} at {time(pet.booked.start)}
          </p>
        ) : (
          <p className="text-small text-muted-foreground">{pet.unavailable ?? pet.serviceName}</p>
        )}
      </div>
      {ready ? (
        <Button onClick={onChoose}>Choose a time</Button>
      ) : pet.unavailable && clinicPhone ? (
        <Button asChild variant="outline">
          <a href={clinicPhone.href}>
            <Phone aria-hidden /> Call
          </a>
        </Button>
      ) : null}
    </div>
  );
}

function Times({
  org,
  token,
  pet,
  timezone,
  clinicPhone,
  onBack,
  onBooked,
}: {
  org: string;
  token: string;
  pet: FlowPet;
  timezone: string;
  clinicPhone: { text: string; href: string } | null;
  onBack?: () => void;
  onBooked: (b: Booked) => void;
}) {
  const [result, setResult] = useState<TimesResult | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Time | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [booking, startBooking] = useTransition();

  const load = (message?: string) =>
    startLoading(async () => {
      const r = await linkTimesAction(org, token, pet.patientId);
      setResult(r);
      setChosen(null);
      setNotice(message ?? null);
      if (r.status === "ok") setDay((d) => (d && r.days.some((x) => x.date === d) ? d : (r.days[0]?.date ?? null)));
    });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.patientId]);

  const dayLabel = (date: string) => {
    const t = Date.parse(`${date}T12:00:00Z`);
    return {
      weekday: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(t),
      day: new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" }).format(t),
      month: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(t),
    };
  };
  const time = fmt(timezone, { hour: "numeric", minute: "2-digit" });
  const longDate = fmt(timezone, { weekday: "long", month: "long", day: "numeric" });
  const callLine = clinicPhone ? (
    <a href={clinicPhone.href} className="font-medium text-primary underline-offset-4 hover:underline">
      {clinicPhone.text}
    </a>
  ) : (
    "the clinic"
  );

  const book = () => {
    if (!chosen) return;
    startBooking(async () => {
      const r = await bookLinkAction(org, token, pet.patientId, chosen.start, chosen.providerId);
      if (r.status === "booked") return onBooked(r);
      if (r.status === "taken") return load("Sorry, that time was just taken. Here are the times still free.");
      setNotice(
        r.status === "already_booked"
          ? `${pet.name} already has this visit booked.`
          : r.status === "busy"
            ? "Too many tries. Please wait a few minutes and try again."
            : r.status === "blocked"
              ? (r.message ?? "Please call us to book this visit.")
              : r.status === "expired"
                ? "This link has expired. Please call us to book."
                : "Something went wrong and nothing was booked. Please try again.",
      );
    });
  };

  const current = result?.status === "ok" ? result.days.find((d) => d.date === day) : undefined;

  return (
    <section className="grid gap-5 rounded-xl border bg-card p-4 shadow-card sm:p-6">
      <div className="flex items-center gap-3">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Choose another pet">
            <ArrowLeft aria-hidden />
          </Button>
        )}
        <div className="grid gap-0.5">
          <p className="font-semibold">{pet.name}</p>
          <p className="text-small text-muted-foreground">{pet.serviceName}</p>
        </div>
      </div>

      {notice && <Alert variant="warning">{notice}</Alert>}

      {loading || !result ? (
        <p className="flex items-center gap-2 py-8 text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Finding free times…
        </p>
      ) : result.status === "ok" && result.days.length === 0 ? (
        <Alert variant="info">No online times in the next three weeks. Please call {callLine} and we&apos;ll fit you in.</Alert>
      ) : result.status === "ok" ? (
        <>
          <div className="grid gap-2">
            <p className="text-small font-medium">Day</p>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="Day">
              {result.days.map((d) => {
                const l = dayLabel(d.date);
                const on = d.date === day;
                return (
                  <button
                    key={d.date}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      setDay(d.date);
                      setChosen(null);
                    }}
                    className={cn(
                      "grid w-16 shrink-0 justify-items-center gap-0.5 rounded-lg border px-2 py-2 transition-colors",
                      on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
                    )}
                  >
                    <span className="text-caption">{l.weekday}</span>
                    <span className="text-h3 font-semibold leading-none">{l.day}</span>
                    <span className="text-caption">{l.month}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {current && (
            <div className="grid gap-2">
              <p className="text-small font-medium">Time</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Time">
                {current.times.map((t) => {
                  const on = chosen?.start === t.start;
                  return (
                    <button
                      key={t.start}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setChosen(t)}
                      className={cn(
                        "grid gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                        on ? "border-primary bg-primary/10 ring-1 ring-primary" : "hover:bg-muted",
                      )}
                    >
                      <span className="font-semibold">{time(t.start)}</span>
                      <span className="truncate text-caption text-muted-foreground">{t.providerName}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-3 border-t pt-4 sm:flex sm:items-center sm:justify-between">
            <p className="text-small text-muted-foreground">
              {chosen ? (
                <>
                  <span className="font-medium text-foreground">
                    {longDate(chosen.start)} at {time(chosen.start)}
                  </span>{" "}
                  with {chosen.providerName}
                </>
              ) : (
                "Pick a time above."
              )}
            </p>
            <Button onClick={book} disabled={!chosen || booking} className="sm:min-w-40">
              {booking && <Loader2 className="animate-spin" aria-hidden />}
              {booking ? "Booking…" : "Book this time"}
            </Button>
          </div>
        </>
      ) : result.status === "blocked" ? (
        <Alert variant="info">
          {result.message} {clinicPhone && <>Call {callLine}.</>}
        </Alert>
      ) : (
        <Alert variant="warning">
          {result.status === "busy"
            ? "Too many tries. Please wait a few minutes and try again."
            : result.status === "expired"
              ? "This link has expired. Please call us to book."
              : result.status === "booked"
                ? `${pet.name} is already booked.`
                : <>We couldn&apos;t load times. Please try again or call {callLine}.</>}
        </Alert>
      )}
    </section>
  );
}
