"use client";

// The public booking widget: book a routine visit, chat with the AI front
// desk (typed, or out loud in the browser: features/front-desk/browser-voice.ts),
// or call. Runs as a page (/w/<org>) and inside a frame on the clinic's
// website (?embed=1). Clinic branding only, in its own colour scheme
// (.clinic-widget in globals.css; a clinic can pass its own colour).
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bird,
  CalendarCheck2,
  CalendarPlus,
  Cat,
  Check,
  Clock,
  Dog,
  Loader2,
  MapPin,
  MessageSquareText,
  Mic,
  PawPrint,
  Plus,
  Rabbit,
  Send,
  Sparkles,
  Stethoscope,
  UserRound,
  Phone,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";
import { BrandBackdrop } from "@/components/vetrix/brand-backdrop";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { browserVoiceSupport, useSpokenTurns } from "@/features/front-desk/browser-voice";
import { AssistantAvatar, statusText, type AssistantStatus } from "./avatar";
import { CallView, OnCallBar, useCallClock, type CallPhase } from "@/features/front-desk/call-view";
import {
  addPetAction,
  bookAction,
  chatEndAction,
  chatSendAction,
  chatStartAction,
  registerAction,
  sendCodeAction,
  servicesAction,
  timesAction,
  verifyCodeAction,
  type BookResult,
  type PetForm,
  type TimesResult,
} from "./actions";
import type { BookedVisit, WidgetMe, WidgetPet, WidgetService } from "@vetrix/db/runtime";
import type { ChatChoice } from "@vetrix/domain";

export interface WidgetClinicProps {
  org: string;
  locationId: string;
  name: string;
  address: string | null;
  timezone: string;
  aiName: string;
  open: boolean;
  phone: { href: string; text: string } | null;
  er: { name: string; phone: { href: string; text: string }; address: string } | null;
}

/** What the visitor came for: book, chat by typing, or talk out loud. */
type Intent = "book" | "chat" | "talk";
type Booked = Extract<BookResult, { ok: true }>;
type Step =
  | { name: "home" }
  | { name: "phone"; intent: Intent }
  | { name: "code"; intent: Intent; mobile: string; display: string; sandboxCode: string | null }
  | { name: "new" }
  | { name: "pets" }
  | { name: "add_pet" }
  | { name: "service"; pet: WidgetPet }
  | { name: "time"; pet: WidgetPet; service: WidgetService }
  | { name: "done"; pet: WidgetPet; service: WidgetService; booked: Booked }
  /** `first`: a message typed on the home screen, sent as soon as the chat opens. */
  | { name: "chat"; voice?: boolean; first?: string };

const SPECIES_LABEL: Record<string, string> = { dog: "Dog", cat: "Cat", rabbit: "Rabbit", bird: "Bird", reptile: "Reptile", other: "Other" };
const SPECIES_ICON: Record<string, LucideIcon> = { dog: Dog, cat: Cat, rabbit: Rabbit, bird: Bird };
const AGES = [
  { value: "under_6m", label: "Under 6 mo" },
  { value: "6m_2y", label: "6 mo – 2 yr" },
  { value: "2y_7y", label: "2 – 7 yr" },
  { value: "7y_plus", label: "7 yr +" },
  { value: "not_sure", label: "Not sure" },
];

/** Where each step sits in the booking journey (for the progress bar). */
const PROGRESS: Partial<Record<Step["name"], number>> = { phone: 1, code: 1, new: 2, pets: 2, add_pet: 2, service: 3, time: 4 };
const STEP_TITLE: Record<Step["name"], string> = {
  home: "",
  phone: "Your number",
  code: "Confirm it's you",
  new: "About you",
  pets: "Choose a pet",
  add_pet: "Add a pet",
  service: "Choose a visit",
  time: "Pick a time",
  done: "Booked",
  chat: "Chat",
};

const fmt = (tz: string, o: Intl.DateTimeFormatOptions) => (t: number) => new Intl.DateTimeFormat("en-US", { ...o, timeZone: tz }).format(t);

function formatMobile(raw: string): string {
  const d = raw.replace(/\D/g, "").replace(/^1(?=\d{10})/, "").slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function BookingWidget({ clinic, embed }: { clinic: WidgetClinicProps; embed: boolean }) {
  const [step, setStep] = useState<Step>({ name: "home" });
  const [history, setHistory] = useState<Step[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<WidgetMe | null>(null);
  const [species, setSpecies] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // A message typed on the home screen waits through the phone check, then is sent.
  const [firstMessage, setFirstMessage] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [step]);

  const go = (next: Step) => {
    setHistory((h) => [...h, step]);
    setNotice(null);
    setStep(next);
  };
  const back = () => {
    setNotice(null);
    setHistory((h) => {
      const prev = h.at(-1);
      if (prev) setStep(prev);
      return h.slice(0, -1);
    });
  };
  const restart = () => {
    setHistory(me ? [{ name: "home" }] : []);
    setNotice(null);
    setStep(me ? { name: "pets" } : { name: "home" });
  };
  /** The session ran out: ask for the number again. */
  const expired = (intent: Intent = "book") => {
    setToken(null);
    setMe(null);
    setHistory([{ name: "home" }]);
    setNotice("For your security, please confirm your number again.");
    setStep({ name: "phone", intent });
  };
  const start = (intent: Intent, first?: string) => {
    setFirstMessage(first ?? null);
    if (token) go(intent !== "book" ? { name: "chat", voice: intent === "talk", first } : me ? { name: "pets" } : { name: "new" });
    else go({ name: "phone", intent });
  };
  const close = () => window.parent?.postMessage({ type: "booking-widget:close" }, "*");
  const ctx = { org: clinic.org, loc: clinic.locationId };
  const progress = PROGRESS[step.name];
  const isHome = step.name === "home";

  return (
    <div
      className={cn(
        "clinic-widget flex h-dvh flex-col overflow-hidden bg-background text-foreground",
        !embed && "sm:h-[min(760px,calc(100dvh-5rem))] sm:rounded-2xl sm:shadow-2xl",
      )}
    >
      {!isHome && step.name !== "chat" && (
        <header className="relative z-10 border-b bg-card">
          <div className="flex h-14 items-center gap-1 px-2">
            {step.name !== "done" && history.length > 0 ? (
              <IconButton label="Back" onClick={back}>
                <ArrowLeft className="size-5" aria-hidden />
              </IconButton>
            ) : (
              <span className="w-2" aria-hidden />
            )}
            <AssistantAvatar size="sm" className="mr-1" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold leading-tight">{STEP_TITLE[step.name]}</p>
              <p className="truncate text-caption text-muted-foreground">
                {clinic.aiName} · {clinic.name}
              </p>
            </div>
            {embed && (
              <IconButton label="Close" onClick={close}>
                <X className="size-5" aria-hidden />
              </IconButton>
            )}
          </div>
          {progress !== undefined && (
            <div className="absolute inset-x-0 bottom-0 h-0.5 translate-y-full" role="progressbar" aria-label={`Step ${progress} of 4`} aria-valuemin={1} aria-valuemax={4} aria-valuenow={progress}>
              <span className="block h-full bg-primary transition-[width] duration-300" style={{ width: `${(progress / 4) * 100}%` }} />
            </div>
          )}
        </header>
      )}

      <div ref={scroller} className="flex flex-1 flex-col overflow-y-auto overscroll-contain">
        <main
          key={step.name}
          className={cn("cw-in relative flex-1", step.name === "chat" || isHome ? "flex flex-col" : "grid content-start gap-5 px-4 py-5")}
        >
          {notice && <Alert variant="warning">{notice}</Alert>}

          {step.name === "home" && (
            <AssistantHome clinic={clinic} embed={embed} onClose={close} onBook={() => start("book")} onChat={(first) => start("chat", first)} onTalk={() => start("talk")} />
          )}

          {step.name === "phone" && (
            <PhoneStep {...ctx} intent={step.intent} onSent={(mobile, display, sandboxCode) => go({ name: "code", intent: step.intent, mobile, display, sandboxCode })} />
          )}

          {step.name === "code" && (
            <CodeStep
              {...ctx}
              mobile={step.mobile}
              display={step.display}
              sandboxCode={step.sandboxCode}
              onVerified={(t, m, sp) => {
                setToken(t);
                setMe(m);
                setSpecies(sp);
                setHistory([{ name: "home" }]);
                setNotice(null);
                setStep(step.intent !== "book" ? { name: "chat", voice: step.intent === "talk", first: firstMessage ?? undefined } : m ? { name: "pets" } : { name: "new" });
                setFirstMessage(null);
              }}
            />
          )}

          {(step.name === "new" || step.name === "add_pet") && token && (
            <PetDetails
              species={species}
              newClient={step.name === "new"}
              onSubmit={async (form) => {
                const r =
                  step.name === "new"
                    ? await registerAction(ctx.org, ctx.loc, token, form as PetForm & { firstName: string; lastName: string; email: string; smsConsent: boolean })
                    : await addPetAction(ctx.org, ctx.loc, token, form);
                if (!r.ok) {
                  if (r.reason === "session") expired();
                  return r.error;
                }
                setMe(r.me);
                const pet = r.me.pets.find((p) => p.id === r.patientId);
                setHistory([{ name: "home" }, { name: "pets" }]);
                setStep(pet ? { name: "service", pet } : { name: "pets" });
                return null;
              }}
              onChat={() => go({ name: "chat" })}
            />
          )}

          {step.name === "pets" && me && <Pets me={me} clinic={clinic} onPick={(pet) => go({ name: "service", pet })} onAdd={() => go({ name: "add_pet" })} onChat={() => go({ name: "chat" })} />}

          {step.name === "service" && token && (
            <ServiceStep {...ctx} token={token} pet={step.pet} onExpired={() => expired()} onPick={(service) => go({ name: "time", pet: step.pet, service })} onChat={() => go({ name: "chat" })} />
          )}

          {step.name === "time" && token && (
            <TimeStep
              {...ctx}
              token={token}
              clinic={clinic}
              pet={step.pet}
              service={step.service}
              onExpired={() => expired()}
              onBooked={(booked) => {
                setMe((m) => (m ? { ...m, pets: m.pets.map((p) => (p.id === step.pet.id ? { ...p, upcoming: { start: new Date(booked.start), serviceName: booked.serviceName } } : p)) } : m));
                go({ name: "done", pet: step.pet, service: step.service, booked });
              }}
            />
          )}

          {step.name === "done" && <Done clinic={clinic} service={step.service} booked={step.booked} onAnother={restart} />}

          {step.name === "chat" && token && (
            <Chat
              {...ctx}
              token={token}
              aiName={clinic.aiName}
              clinic={clinic}
              voice={Boolean(step.voice)}
              first={step.first}
              onExpired={() => expired(step.voice ? "talk" : "chat")}
              onBack={history.length > 0 ? back : undefined}
              onClose={embed ? close : undefined}
            />
          )}
        </main>
      </div>


    </div>
  );
}

// ---------- Frame ----------

function IconButton({ label, onClick, children, className }: { label: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={cn("flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", className)}>
      {children}
    </button>
  );
}

/** Where to call in an emergency: the clinic, or the emergency clinic when closed. */
function emergencyTarget(clinic: WidgetClinicProps) {
  const er = !clinic.open ? clinic.er : null;
  return { er, call: er ? er.phone : clinic.phone, name: er ? er.name : clinic.name };
}

/** The quiet link on the home screen. */
function EmergencyLink({ clinic }: { clinic: WidgetClinicProps }) {
  const { call } = emergencyTarget(clinic);
  if (!call) return null;
  return (
    <a href={call.href} className="whitespace-nowrap font-semibold text-destructive underline-offset-2 hover:underline">
      Emergency? Call {call.text}
    </a>
  );
}

/**
 * Shown in the chat as soon as the AI's triage says emergency (it never goes
 * back down): call the clinic now, or the emergency clinic after hours.
 */
function EmergencyCard({ clinic }: { clinic: WidgetClinicProps }) {
  const { er, call, name } = emergencyTarget(clinic);
  return (
    <div role="alert" className="cw-in sticky top-[4.5rem] z-10 grid gap-3 rounded-2xl border-2 border-destructive bg-danger-soft p-4 shadow-card">
      <p className="flex items-center gap-2 font-semibold text-destructive">
        <AlertTriangle className="size-5 shrink-0" aria-hidden /> This could be an emergency
      </p>
      <p className="text-small text-foreground">
        {er ? `We're closed right now. Please call ${er.name} now${er.address ? `, or go to ${er.address}` : ""}.` : "Please call us now so a vet can help right away. Don't wait for an online booking."}
      </p>
      {call ? (
        <a href={call.href} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-destructive text-body font-semibold text-white shadow-sm hover:bg-destructive/90">
          <Phone className="size-5" aria-hidden /> Call {name} · {call.text}
        </a>
      ) : (
        <p className="font-semibold text-destructive">Go to your nearest emergency vet now.</p>
      )}
    </div>
  );
}

function StepHeading({ title, body }: { title: string; body?: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <h1 className="text-h3 font-semibold tracking-tight">{title}</h1>
      {body && <p className="text-small text-muted-foreground">{body}</p>}
    </div>
  );
}

/** A tappable card row, as in the staff app: round icon badge, title, detail, arrow. */
function Row({
  icon: Icon,
  iconClass,
  title,
  detail,
  badge,
  onClick,
  dashed,
}: {
  icon: LucideIcon;
  iconClass?: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  badge?: React.ReactNode;
  onClick: () => void;
  dashed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border bg-card p-3.5 text-left shadow-card transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        dashed && "border-dashed shadow-none",
      )}
    >
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-primary", iconClass)}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium leading-snug">
          {title}
          {badge}
        </span>
        {detail && <span className="text-small text-muted-foreground">{detail}</span>}
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

function Pill({ children, tone = "primary" }: { children: React.ReactNode; tone?: "primary" | "warning" }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4",
        tone === "primary" && "bg-secondary text-secondary-foreground",
        tone === "warning" && "bg-warning-soft text-warning-text",
      )}
    >
      {children}
    </span>
  );
}

// ---------- Steps ----------

const partOfDay = (timezone: string) => {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).format(Date.now()));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

/** One message from the assistant, with its face beside the first of a group. */
function AssistantBubble({ children, avatar, status = "online" }: { children: React.ReactNode; avatar: boolean; status?: AssistantStatus }) {
  return (
    <div className="cw-in flex items-end gap-2">
      {avatar ? <AssistantAvatar size="sm" status={status} /> : <span className="w-8 shrink-0" aria-hidden />}
      <div className="max-w-[82%] whitespace-pre-line rounded-2xl rounded-bl-md border bg-card px-3.5 py-2.5 text-body shadow-sm">{children}</div>
    </div>
  );
}

/** Talking out loud needs a browser that can listen and speak (not Firefox). */
function useCanTalk() {
  const [can, setCan] = useState(false);
  useEffect(() => {
    const v = browserVoiceSupport();
    setCan(v.listen && v.speak);
  }, []);
  return can;
}

/**
 * The first screen: the assistant greets the visitor like a chat, with quick
 * replies and a message box (typing starts a chat after the phone check; the
 * mic starts a spoken one). The emergency line stays visible.
 */
function AssistantHome({
  clinic,
  embed,
  onClose,
  onBook,
  onChat,
  onTalk,
}: {
  clinic: WidgetClinicProps;
  embed: boolean;
  onClose: () => void;
  onBook: () => void;
  onChat: (first?: string) => void;
  onTalk: () => void;
}) {
  const canTalk = useCanTalk();
  const [draft, setDraft] = useState("");
  const chip = "rounded-full border border-primary/30 bg-card px-3.5 py-2 text-small font-medium text-foreground shadow-sm transition-colors hover:border-primary hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="flex flex-1 flex-col">
      <header className="relative shrink-0 overflow-hidden px-5 pb-6 pt-5 text-white">
        <BrandBackdrop waves="40%" />
        <div className="relative flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3.5">
            <AssistantAvatar size="lg" />
            <div className="grid min-w-0">
              <p className="truncate text-h3 font-semibold leading-tight">{clinic.aiName}</p>
              <p className="truncate text-small text-white/80">AI assistant · {clinic.name}</p>
              <p className="mt-1 flex items-center gap-1.5 text-caption text-white/75">
                <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
                {statusText("online", clinic.open)}
              </p>
            </div>
          </div>
          {embed && (
            <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-2 text-white/70 hover:bg-white/10 hover:text-white">
              <X className="size-5" aria-hidden />
            </IconButton>
          )}
        </div>
      </header>

      <div className="grid flex-1 content-start gap-2 px-4 py-5" aria-live="polite">
        <AssistantBubble avatar>
          {partOfDay(clinic.timezone)}! I&apos;m {clinic.aiName}, the AI assistant for {clinic.name}.
        </AssistantBubble>
        <AssistantBubble avatar={false}>I can book a visit, answer your questions, or help if your pet isn&apos;t feeling well. What can I do for you?</AssistantBubble>
        <div className="cw-in flex flex-wrap gap-2 pl-10 pt-2">
          <button type="button" className={chip} onClick={onBook}>
            <CalendarCheck2 className="mr-1.5 inline size-4 text-primary" aria-hidden />
            Book a visit
          </button>
          <button type="button" className={chip} onClick={() => onChat("My pet seems unwell")}>
            <Stethoscope className="mr-1.5 inline size-4 text-destructive" aria-hidden />
            My pet seems unwell
          </button>
          <button type="button" className={chip} onClick={() => onChat()}>
            <MessageSquareText className="mr-1.5 inline size-4 text-primary" aria-hidden />
            Ask a question
          </button>
          {canTalk && (
            <button type="button" className={chip} onClick={onTalk}>
              <Mic className="mr-1.5 inline size-4 text-primary" aria-hidden />
              Talk out loud
            </button>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 grid gap-2 border-t bg-card px-3 pb-3 pt-2.5">
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => draft.trim() && onChat(draft.trim())}
          placeholder={`Message ${clinic.aiName}…`}
          mic={canTalk ? { listening: false, onClick: onTalk } : null}
        />
        <p className="text-center text-[11px] text-muted-foreground">
          We confirm your mobile number with a code first. {clinic.aiName} is an AI; staff see every conversation. <EmergencyLink clinic={clinic} />
        </p>
      </div>
    </div>
  );
}

/** The message box: text, an optional mic (talk out loud) and send. */
function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  disabled,
  mic,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  disabled?: boolean;
  mic: { listening: boolean; onClick: () => void; disabled?: boolean } | null;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
      className={cn("flex items-center gap-1.5 rounded-full border bg-background py-1 pl-4 pr-1 shadow-sm transition-colors focus-within:border-primary", mic?.listening && "border-primary")}
    >
      <label htmlFor="w-compose" className="sr-only">
        Message
      </label>
      <input
        id="w-compose"
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={500}
        autoComplete="off"
        disabled={disabled}
        readOnly={mic?.listening}
        className="h-10 min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
      {mic && (
        <button
          type="button"
          onClick={mic.onClick}
          disabled={mic.disabled}
          aria-label={mic.listening ? "Done speaking" : "Talk out loud"}
          aria-pressed={mic.listening}
          className={cn(
            "relative flex size-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50",
            mic.listening ? "bg-destructive text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {mic.listening && <span className="cw-ping absolute inset-0 rounded-full bg-destructive/40" aria-hidden />}
          <Mic className="relative size-5" aria-hidden />
        </button>
      )}
      <button
        type="submit"
        disabled={disabled || !value.trim() || mic?.listening}
        aria-label="Send"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
      >
        <Send className="size-[18px]" aria-hidden />
      </button>
    </form>
  );
}

function PhoneStep({ org, loc, intent, onSent }: { org: string; loc: string; intent: Intent; onSent: (mobile: string, display: string, sandboxCode: string | null) => void }) {
  const [mobile, setMobile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const digits = mobile.replace(/\D/g, "");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await sendCodeAction(org, loc, mobile);
      if (!r.ok) return setError(r.error);
      onSent(mobile, r.display, r.sandboxCode);
    });
  };
  return (
    <form onSubmit={submit} className="grid gap-5">
      <StepHeading
        title={intent !== "book" ? "First, your mobile number" : "Let's get you booked"}
        body="We'll text you a 6-digit code to confirm it's you. New to us? That's fine too."
      />
      <div className="grid gap-2">
        <Label htmlFor="w-mobile">Mobile number</Label>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center border-r pr-3 text-body font-medium text-muted-foreground">+1</span>
          <Input
            id="w-mobile"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="(512) 555-0142"
            value={mobile}
            onChange={(e) => {
              setMobile(formatMobile(e.target.value));
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            className="h-12 rounded-xl pl-14 text-h3 tracking-wide sm:h-12"
            autoFocus
            required
          />
        </div>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      <Button type="submit" size="lg" className="h-12 rounded-xl" disabled={pending || digits.length < 10}>
        {pending && <Loader2 className="animate-spin" aria-hidden />} Text me a code
      </Button>
      <p className="text-center text-caption text-muted-foreground">Message and data rates may apply. We only use your number for your pet&apos;s care.</p>
    </form>
  );
}

function CodeStep({
  org,
  loc,
  mobile,
  display,
  sandboxCode,
  onVerified,
}: {
  org: string;
  loc: string;
  mobile: string;
  display: string;
  sandboxCode: string | null;
  onVerified: (token: string, me: WidgetMe | null, species: string[]) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [wait, setWait] = useState(30);
  const [shownCode, setShownCode] = useState(sandboxCode);
  const [focused, setFocused] = useState(true);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const verify = (value: string) =>
    start(async () => {
      setInfo(null);
      const r = await verifyCodeAction(org, loc, mobile, value);
      if (!r.ok) {
        setError(r.error);
        setCode("");
        ref.current?.focus();
        return;
      }
      onVerified(r.token, r.me, r.species);
    });

  const resend = () =>
    start(async () => {
      const r = await sendCodeAction(org, loc, mobile);
      setError(r.ok ? null : r.error);
      if (r.ok) {
        setShownCode(r.sandboxCode);
        setInfo("We sent a new code.");
        setWait(r.resendIn);
      }
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) verify(code);
      }}
      className="grid gap-5"
    >
      <StepHeading
        title="Enter your code"
        body={
          <>
            We texted a 6-digit code to <span className="font-medium text-foreground">{display}</span>.
          </>
        }
      />
      {shownCode && (
        <Alert variant="info">
          <p>
            <span className="font-semibold">Sandbox:</span> no text was sent. Your code is <span className="font-mono font-semibold tracking-widest">{shownCode}</span>.
          </p>
        </Alert>
      )}
      <div className="relative">
        <label htmlFor="w-code" className="sr-only">
          6-digit code
        </label>
        <input
          ref={ref}
          id="w-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          autoFocus
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(v);
            setError(null);
            if (v.length === 6) verify(v);
          }}
          className="absolute inset-0 z-10 w-full cursor-text opacity-0"
          aria-invalid={error ? true : undefined}
        />
        <div className="grid grid-cols-6 gap-2" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={cn(
                "flex h-14 items-center justify-center rounded-xl border-2 bg-card text-h2 font-semibold tabular-nums transition-colors",
                code[i] ? "border-primary/40" : "border-border",
                focused && i === Math.min(code.length, 5) && !pending && "border-primary ring-4 ring-primary/15",
                error && "border-destructive/60",
              )}
            >
              {pending && i === 5 && code.length === 6 ? <Loader2 className="size-5 animate-spin text-primary" /> : (code[i] ?? "")}
            </span>
          ))}
        </div>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      {info && <Alert variant="info">{info}</Alert>}
      <Button type="submit" size="lg" className="h-12 rounded-xl" disabled={pending || code.length < 6}>
        {pending && <Loader2 className="animate-spin" aria-hidden />} Continue
      </Button>
      <button type="button" onClick={resend} disabled={pending || wait > 0} className="text-small font-medium text-primary disabled:text-muted-foreground">
        {wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
      </button>
    </form>
  );
}

function PetDetails({
  species,
  newClient,
  onSubmit,
  onChat,
}: {
  species: string[];
  newClient: boolean;
  onSubmit: (form: PetForm & Partial<{ firstName: string; lastName: string; email: string; smsConsent: boolean }>) => Promise<string | null>;
  onChat: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [kind, setKind] = useState(species[0] ?? "dog");
  const [sex, setSex] = useState<string>("");
  const [age, setAge] = useState("not_sure");

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    start(async () => {
      setError(
        await onSubmit({
          firstName: String(f.get("firstName") ?? ""),
          lastName: String(f.get("lastName") ?? ""),
          email: String(f.get("email") ?? ""),
          smsConsent: f.get("smsConsent") === "on",
          petName: String(f.get("petName") ?? ""),
          species: kind,
          ageBand: age,
          sex,
        }),
      );
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-5">
      <StepHeading
        title={newClient ? "Welcome! Tell us about you" : "Add a pet"}
        body={newClient ? "We'll book a first visit so the doctor can meet your pet." : "We'll book their first visit with us."}
      />
      {newClient && (
        <Section icon={UserRound} title="You">
          <div className="grid grid-cols-2 gap-3">
            <Field id="w-first" label="First name">
              <Input id="w-first" name="firstName" autoComplete="given-name" required />
            </Field>
            <Field id="w-last" label="Last name">
              <Input id="w-last" name="lastName" autoComplete="family-name" required />
            </Field>
          </div>
          <Field id="w-email" label="Email" hint="optional">
            <Input id="w-email" name="email" type="email" autoComplete="email" placeholder="For confirmations" />
          </Field>
          <CheckboxField name="smsConsent" defaultChecked label="Text me about appointments" hint="Confirmations and reminders. Reply STOP anytime." />
        </Section>
      )}
      <Section icon={PawPrint} title="Your pet">
        <Field id="w-pet" label="Pet's name">
          <Input id="w-pet" name="petName" required />
        </Field>
        <div className="grid gap-2">
          <span className="text-small font-medium">Species</span>
          {species.length === 0 ? (
            <Alert variant="info">We can&apos;t book first visits online right now. Please call us.</Alert>
          ) : (
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Species">
              {species.map((s) => {
                const Icon = SPECIES_ICON[s] ?? PawPrint;
                const on = kind === s;
                return (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setKind(s)}
                    className={cn("flex items-center justify-center gap-2 rounded-xl border-2 py-2.5 font-medium transition-colors", on ? "border-primary bg-secondary text-primary" : "border-border bg-card hover:bg-muted")}
                  >
                    <Icon className="size-5" aria-hidden /> {SPECIES_LABEL[s] ?? s}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="grid gap-2">
          <span className="text-small font-medium">Age</span>
          <Chips value={age} onChange={setAge} options={AGES} label="Age" />
        </div>
        <div className="grid gap-2">
          <span className="text-small font-medium">Boy or girl?</span>
          <Chips
            value={sex}
            onChange={setSex}
            options={[
              { value: "male", label: "Boy" },
              { value: "female", label: "Girl" },
              { value: "", label: "Not sure" },
            ]}
            label="Sex"
          />
        </div>
      </Section>
      {error && <Alert variant="error">{error}</Alert>}
      <Button type="submit" size="lg" className="h-12 rounded-xl" disabled={pending || species.length === 0}>
        {pending && <Loader2 className="animate-spin" aria-hidden />} Continue
      </Button>
      <button type="button" onClick={onChat} className="text-small text-muted-foreground underline underline-offset-4 hover:text-foreground">
        Is your pet sick or hurt? Chat with us instead
      </button>
    </form>
  );
}

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-3">
      <legend className="sr-only">{title}</legend>
      <p className="flex items-center gap-2 text-caption font-medium uppercase tracking-wide text-muted-foreground" aria-hidden>
        <Icon className="size-3.5" /> {title}
      </p>
      {children}
    </fieldset>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label} {hint && <span className="font-normal text-muted-foreground">({hint})</span>}
      </Label>
      {children}
    </div>
  );
}

function Chips({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value || "none"}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("rounded-full border px-3.5 py-1.5 text-small font-medium transition-colors", value === o.value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Pets({ me, clinic, onPick, onAdd, onChat }: { me: WidgetMe; clinic: WidgetClinicProps; onPick: (p: WidgetPet) => void; onAdd: () => void; onChat: () => void }) {
  const date = fmt(clinic.timezone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const dueDate = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(Date.parse(`${iso}T12:00:00Z`));
  return (
    <div className="grid gap-4">
      <StepHeading title={`Welcome back, ${me.firstName}`} body="Who are we seeing?" />
      <ul className="grid gap-2.5">
        {me.pets.map((p) => (
          <li key={p.id}>
            <Row
              icon={SPECIES_ICON[p.species] ?? PawPrint}
              title={p.name}
              badge={p.upcoming ? <Pill>Booked</Pill> : p.due ? <Pill tone={p.due.overdue ? "warning" : "primary"}>{p.due.overdue ? "Overdue" : "Due"}</Pill> : undefined}
              detail={
                p.upcoming
                  ? `${p.upcoming.serviceName} · ${date(new Date(p.upcoming.start).getTime())}`
                  : p.due
                    ? `${p.due.label} · ${dueDate(p.due.dueAt)}`
                    : [SPECIES_LABEL[p.species] ?? p.species, p.ageText].filter(Boolean).join(" · ")
              }
              onClick={() => onPick(p)}
            />
          </li>
        ))}
      </ul>
      {me.pets.length === 0 && <Alert variant="info">We don&apos;t have an active pet on file for you. Add one below.</Alert>}
      <Button variant="outline" className="h-11 rounded-xl border-dashed" onClick={onAdd}>
        <Plus aria-hidden /> Add another pet
      </Button>
      <Row icon={Stethoscope} iconClass="bg-danger-soft text-destructive" title="Something's wrong?" detail={`Sick, hurt or not themselves: chat with ${clinic.aiName} so we can check first.`} onClick={onChat} dashed />
    </div>
  );
}

function ServiceStep({
  org,
  loc,
  token,
  pet,
  onPick,
  onExpired,
  onChat,
}: {
  org: string;
  loc: string;
  token: string;
  pet: WidgetPet;
  onPick: (s: WidgetService) => void;
  onExpired: () => void;
  onChat: () => void;
}) {
  const [services, setServices] = useState<WidgetService[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    servicesAction(org, loc, token, pet.id).then((r) => {
      if (!live) return;
      if (!r.ok) {
        if (r.reason === "session") return onExpired();
        return setError(r.error);
      }
      // The visit the clinic says is due goes first.
      const due = pet.due?.serviceId;
      setServices(due ? [...r.services].sort((a, b) => Number(b.id === due) - Number(a.id === due)) : r.services);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.id]);

  const price = (s: WidgetService) =>
    s.priceLow === null ? null : !s.priceLow && !s.priceHigh ? "No charge" : s.priceHigh && s.priceHigh !== s.priceLow ? `$${s.priceLow}–$${s.priceHigh}` : `$${s.priceLow}`;

  return (
    <div className="grid gap-4">
      <StepHeading title={`What does ${pet.name} need?`} body="Routine visits you can book online." />
      {error && <Alert variant="error">{error}</Alert>}
      {!services && !error && <Skeleton rows={4} />}
      {services && services.length === 0 && <Alert variant="info">There&apos;s nothing to book online for {pet.name} right now. Please call us.</Alert>}
      {services && (
        <ul className="grid gap-2.5">
          {services.map((s) => {
            const due = pet.due?.serviceId === s.id;
            return (
              <li key={s.id}>
                <Row
                  icon={due ? Sparkles : CalendarCheck2}
                  iconClass={due ? "bg-primary text-primary-foreground" : undefined}
                  title={s.name}
                  badge={due ? <Pill>Recommended</Pill> : undefined}
                  detail={`${s.durationMin} min${price(s) ? ` · ${price(s)}` : ""}`}
                  onClick={() => onPick(s)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <Row icon={Stethoscope} iconClass="bg-danger-soft text-destructive" title={`${pet.name} is sick or hurt`} detail="Chat with us so we can check how soon they should be seen." onClick={onChat} dashed />
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="grid gap-2.5" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl border bg-card p-3">
          <span className="size-11 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
          <span className="grid flex-1 gap-2">
            <span className="h-3.5 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="h-3 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </span>
        </div>
      ))}
    </div>
  );
}

type Time = { start: number; providerId: string; providerName: string };

function TimeStep({
  org,
  loc,
  token,
  clinic,
  pet,
  service,
  onBooked,
  onExpired,
}: {
  org: string;
  loc: string;
  token: string;
  clinic: WidgetClinicProps;
  pet: WidgetPet;
  service: WidgetService;
  onBooked: (b: Booked) => void;
  onExpired: () => void;
}) {
  const [result, setResult] = useState<TimesResult | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Time | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [booking, startBooking] = useTransition();
  const time = fmt(clinic.timezone, { hour: "numeric", minute: "2-digit" });
  const hour = (t: number) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: clinic.timezone }).format(t));
  const longDate = fmt(clinic.timezone, { weekday: "long", month: "long", day: "numeric" });
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: clinic.timezone, timeZoneName: "short" }).formatToParts(Date.now()).find((p) => p.type === "timeZoneName")?.value;
  const PetIcon = SPECIES_ICON[pet.species] ?? PawPrint;

  const load = (message?: string) =>
    startLoading(async () => {
      const r = await timesAction(org, loc, token, pet.id, service.id);
      if (!r.ok && r.reason === "session") return onExpired();
      setResult(r);
      setChosen(null);
      setNotice(message ?? null);
      if (r.ok) setDay((d) => (d && r.days.some((x) => x.date === d) ? d : (r.days[0]?.date ?? null)));
    });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.id]);

  const book = () => {
    if (!chosen) return;
    startBooking(async () => {
      const r = await bookAction(org, loc, token, pet.id, service.id, chosen.start, chosen.providerId);
      if (r.ok) return onBooked(r);
      if (r.reason === "session") return onExpired();
      if (r.reason === "taken") return load(r.error);
      setNotice(r.error);
    });
  };

  const dayLabel = (date: string) => {
    const t = Date.parse(`${date}T12:00:00Z`);
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }).format(t);
    return { weekday: f({ weekday: "short" }), day: f({ day: "numeric" }), month: f({ month: "short" }) };
  };
  const current = result?.ok ? result.days.find((d) => d.date === day) : undefined;
  const groups = current
    ? [
        { label: "Morning", times: current.times.filter((t) => hour(t.start) < 12) },
        { label: "Afternoon", times: current.times.filter((t) => hour(t.start) >= 12 && hour(t.start) < 17) },
        { label: "Evening", times: current.times.filter((t) => hour(t.start) >= 17) },
      ].filter((g) => g.times.length)
    : [];

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3 rounded-2xl border bg-card p-3 shadow-card">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary">
          <PetIcon className="size-5" aria-hidden />
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate font-semibold">
            {pet.name} · {service.name}
          </span>
          <span className="text-caption text-muted-foreground">
            {service.durationMin} min{zone ? ` · clinic time (${zone})` : ""}
          </span>
        </span>
      </div>
      {notice && <Alert variant="warning">{notice}</Alert>}
      {loading || !result ? (
        <div className="grid gap-3" role="status" aria-label="Finding free times">
          <div className="flex gap-2 overflow-hidden">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className="h-[4.5rem] w-14 shrink-0 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className="h-14 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
            ))}
          </div>
        </div>
      ) : !result.ok ? (
        <Alert variant={result.reason === "blocked" ? "info" : "warning"}>
          <p>
            {result.error}{" "}
            {clinic.phone && (
              <a href={clinic.phone.href} className="font-medium text-primary underline underline-offset-4">
                Call {clinic.phone.text}
              </a>
            )}
          </p>
        </Alert>
      ) : result.days.length === 0 ? (
        <Alert variant="info">No online times in the next three weeks. Please call us and we&apos;ll fit you in.</Alert>
      ) : (
        <>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" role="radiogroup" aria-label="Day">
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
                    "grid w-14 shrink-0 justify-items-center gap-0.5 rounded-2xl border px-1 py-2.5 transition-all",
                    on ? "border-primary bg-primary text-primary-foreground shadow-md" : "bg-card hover:border-primary/40",
                  )}
                >
                  <span className={cn("text-[11px] font-medium uppercase tracking-wide", on ? "text-primary-foreground/80" : "text-muted-foreground")}>{l.weekday}</span>
                  <span className="text-h3 font-semibold leading-none">{l.day}</span>
                  <span className={cn("text-[11px]", on ? "text-primary-foreground/80" : "text-muted-foreground")}>{l.month}</span>
                </button>
              );
            })}
          </div>
          {groups.map((g) => (
            <div key={g.label} className="grid gap-2">
              <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</p>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={`${g.label} times`}>
                {g.times.map((t) => {
                  const on = chosen?.start === t.start;
                  return (
                    <button
                      key={t.start}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setChosen(t)}
                      className={cn("grid gap-0.5 rounded-xl border px-2 py-2 text-center transition-all", on ? "border-primary bg-primary text-primary-foreground shadow-md" : "bg-card hover:border-primary/40")}
                    >
                      <span className="text-small font-semibold">{time(t.start)}</span>
                      <span className={cn("truncate text-[11px]", on ? "text-primary-foreground/80" : "text-muted-foreground")}>{t.providerName}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="sticky bottom-0 -mx-4 -mb-5 mt-2 grid gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur">
            <p className="min-h-5 text-small text-muted-foreground">
              {chosen ? (
                <>
                  <span className="font-semibold text-foreground">
                    {longDate(chosen.start)}, {time(chosen.start)}
                  </span>{" "}
                  with {chosen.providerName}
                </>
              ) : (
                "Pick a time above."
              )}
            </p>
            <Button size="lg" className="h-12 rounded-xl" onClick={book} disabled={!chosen || booking}>
              {booking && <Loader2 className="animate-spin" aria-hidden />} {booking ? "Booking…" : "Book this time"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Saves a visit as a calendar file (.ics) the phone or computer opens in its calendar. */
function downloadIcs(v: { start: number; minutes: number; title: string; location: string | null; description: string; file: string }) {
  const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//clinic//booking//EN",
    "BEGIN:VEVENT",
    `UID:${v.start}-${v.file.replace(/\W/g, "")}@booking`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(v.start)}`,
    `DTEND:${stamp(v.start + Math.max(15, v.minutes) * 60_000)}`,
    `SUMMARY:${esc(v.title)}`,
    v.location ? `LOCATION:${esc(v.location)}` : "",
    `DESCRIPTION:${esc(v.description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = v.file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Done({ clinic, service, booked, onAnother }: { clinic: WidgetClinicProps; service: WidgetService; booked: Booked; onAnother: () => void }) {
  const longDate = fmt(clinic.timezone, { weekday: "long", month: "long", day: "numeric" });
  const time = fmt(clinic.timezone, { hour: "numeric", minute: "2-digit" });
  const ics = () =>
    downloadIcs({
      start: booked.start,
      minutes: service.durationMin,
      title: `${booked.petName}: ${booked.serviceName} at ${clinic.name}`,
      location: clinic.address,
      description: `With ${booked.providerName}.${clinic.phone ? ` Questions? Call ${clinic.phone.text}.` : ""}`,
      file: `${booked.petName}-appointment.ics`,
    });
  const rows: { icon: LucideIcon; text: string }[] = [
    { icon: CalendarCheck2, text: longDate(booked.start) },
    { icon: Clock, text: `${time(booked.start)} · ${service.durationMin} min` },
    { icon: UserRound, text: booked.providerName },
    ...(clinic.address ? [{ icon: MapPin, text: clinic.address }] : []),
  ];
  return (
    <div className="grid gap-5 pt-2">
      <div className="grid justify-items-center gap-3 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-secondary">
          <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
            <Check className="size-6" strokeWidth={3} aria-hidden />
          </span>
        </span>
        <div className="grid gap-1">
          <h1 className="text-h2 font-semibold">You&apos;re all set!</h1>
          <p className="text-muted-foreground">
            {booked.petName} is booked for {booked.serviceName.toLowerCase()}.
          </p>
        </div>
      </div>
      <ul className="grid gap-3 rounded-2xl border bg-card p-4 shadow-card">
        {rows.map((r) => (
          <li key={r.text} className="flex items-center gap-3 text-small">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
              <r.icon className="size-4" aria-hidden />
            </span>
            <span className="font-medium">{r.text}</span>
          </li>
        ))}
      </ul>
      <p className="text-center text-small text-muted-foreground">
        {booked.confirmation === "sms"
          ? "We've texted you a confirmation. Reply C to confirm or R to reschedule."
          : booked.confirmation === "email"
            ? "We've emailed you a confirmation."
            : `Need to change it? Call us${clinic.phone ? ` at ${clinic.phone.text}` : ""}.`}
      </p>
      <div className="grid gap-2">
        <Button size="lg" className="h-12 rounded-xl" onClick={ics}>
          <CalendarPlus aria-hidden /> Add to calendar
        </Button>
        <Button variant="ghost" className="h-11 rounded-xl" onClick={onAnother}>
          <PawPrint aria-hidden /> Book another visit
        </Button>
      </div>
    </div>
  );
}

type ChatLine = { id: number; who: "ai" | "me"; text: string } | { id: number; who: "booked"; visit: BookedVisit };

/** The confirmation card in the chat when Riley books a visit. */
function BookedCard({ visit, clinic }: { visit: BookedVisit; clinic: WidgetClinicProps }) {
  const day = fmt(clinic.timezone, { weekday: "long", month: "long", day: "numeric" })(visit.start);
  const time = fmt(clinic.timezone, { hour: "numeric", minute: "2-digit" })(visit.start);
  const what = visit.what.replace(/^(a|an|the) /i, "");
  return (
    <div className="cw-in ml-10 grid gap-3 overflow-hidden rounded-2xl border border-emerald-500/40 bg-card shadow-card">
      <div className="flex items-center gap-2 bg-emerald-500 px-4 py-2 text-small font-semibold text-white">
        <Check className="size-4" aria-hidden /> Booked
      </div>
      <div className="grid gap-1.5 px-4 text-small">
        <p className="text-body font-semibold">
          {visit.petName} · {what.charAt(0).toUpperCase() + what.slice(1)}
        </p>
        <p className="flex items-center gap-2">
          <CalendarCheck2 className="size-4 text-primary" aria-hidden /> {day}
        </p>
        <p className="flex items-center gap-2">
          <Clock className="size-4 text-primary" aria-hidden /> {time}
          {visit.providerName ? ` · ${visit.providerName}` : ""}
        </p>
        {clinic.address && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <MapPin className="size-4" aria-hidden /> {clinic.address}
          </p>
        )}
      </div>
      <div className="px-4 pb-4">
        <Button
          variant="outline"
          className="h-10 w-full rounded-xl"
          onClick={() =>
            downloadIcs({
              start: visit.start,
              minutes: 30,
              title: `${visit.petName}: ${what} at ${clinic.name}`,
              location: clinic.address,
              description: visit.providerName ? `With ${visit.providerName}.` : `At ${clinic.name}.`,
              file: `${visit.petName}-appointment.ics`,
            })
          }
        >
          <CalendarPlus aria-hidden /> Add to calendar
        </Button>
      </div>
    </div>
  );
}

const STARTERS = ["My pet seems sick", "Book a checkup", "Question about my pet's meds"];

/**
 * The conversation with the AI assistant, typed or out loud. The mic sits in
 * the message box; the speaker button turns the assistant's voice on or off.
 * Every reply comes from the same front desk as phone calls and texts.
 */
function Chat({
  org,
  loc,
  token,
  aiName,
  clinic,
  voice: startTalking,
  first,
  onExpired,
  onBack,
  onClose,
}: {
  org: string;
  loc: string;
  token: string;
  aiName: string;
  clinic: WidgetClinicProps;
  /** Start with the voice on (the visitor chose "Talk out loud"). */
  voice: boolean;
  /** A message typed on the home screen, sent as soon as the chat opens. */
  first?: string;
  onExpired: () => void;
  onBack?: () => void;
  /** Inside the clinic's website: close the widget. */
  onClose?: () => void;
}) {
  const [callId, setCallId] = useState<string | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  // Tappable answers for what Riley is waiting for, and the emergency card (it never goes away once shown).
  const [choices, setChoices] = useState<ChatChoice[]>([]);
  const [emergency, setEmergency] = useState(false);
  const [text, setText] = useState("");
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  const idRef = useRef<string | null>(null);
  const lineId = useRef(0);
  const sentFirst = useRef(false);
  const nextLine = (who: "ai" | "me", t: string): ChatLine => ({ id: ++lineId.current, who, text: t });
  const bookedLine = (visit: BookedVisit): ChatLine => ({ id: ++lineId.current, who: "booked", visit });
  const canTalk = useCanTalk();
  const [talking, setTalking] = useState(startTalking);
  // The call screen (spoken conversations) or the chat; a call can move between them.
  const [view, setView] = useState<"call" | "chat">(startTalking ? "call" : "chat");
  const [muted, setMuted] = useState(false);
  // "Calling…" rings for a moment, then the call connects and the clock starts.
  const ringStart = useRef(Date.now());
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  /** Sends one message and shows the replies. */
  const send = async (id: string, body: string) => {
    const r = await chatSendAction(org, loc, token, id, body);
    if (!r.ok) {
      if (r.reason === "session" && r.error.startsWith("For your security")) return onExpired();
      return setError(r.error);
    }
    setLines((l) => [...l, ...r.replies.map((t) => nextLine("ai", t)), ...r.bookedNow.map(bookedLine)]);
    setChoices(r.choices);
    if (r.triageLevel === "emergency") setEmergency(true);
    if (r.ended) {
      setEnded(true);
      idRef.current = null;
    }
  };

  const begin = () =>
    start(async () => {
      setError(null);
      setEnded(false);
      spoken.reset();
      const r = await chatStartAction(org, loc, token);
      if (!r.ok) {
        if (r.reason === "session") return onExpired();
        return setError(r.error);
      }
      idRef.current = r.callId;
      setCallId(r.callId);
      setEmergency(false);
      setChoices(r.choices);
      setLines(r.replies.map((t) => nextLine("ai", t)));
      // The message typed on the home screen goes first.
      if (first && !sentFirst.current) {
        sentFirst.current = true;
        setLines((l) => [...l, nextLine("me", first)]);
        await send(r.callId, first);
      }
    });

  // Start once per screen. React's development mode mounts twice to catch
  // bugs; the conversation must not start twice or end in between, so it
  // ends only when the screen is really gone (checked a moment later).
  const started = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      begin();
    }
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current && idRef.current) void chatEndAction(org, loc, token, idRef.current);
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines.length, pending]);

  /** Sends a message; a tapped button shows its label but sends its value. */
  const say = (body: string, shown?: string) => {
    const id = idRef.current;
    if (!body || !id) return;
    setText("");
    setError(null);
    setChoices([]);
    setLines((l) => [...l, nextLine("me", shown ?? body)]);
    start(async () => {
      await send(id, body);
    });
  };
  const sayRef = useRef(say);
  sayRef.current = say;

  useEffect(() => {
    if (!callId || connectedAt !== null || view !== "call") return;
    const t = setTimeout(() => setConnectedAt(Date.now()), Math.max(0, 1800 - (Date.now() - ringStart.current)));
    return () => clearTimeout(t);
  }, [callId, connectedAt, view]);

  const spoken = useSpokenTurns({
    // On the call screen the voice starts once the call has connected.
    active: talking && Boolean(callId) && (view === "chat" || connectedAt !== null),
    autoListen: !muted,
    replies: useMemo(() => lines.flatMap((l) => (l.who === "ai" ? [{ id: l.id, text: l.text }] : [])), [lines]),
    busy: pending,
    ended,
    onHeard: (heard) => sayRef.current(heard),
  });

  const status: AssistantStatus = pending ? "thinking" : spoken.state === "speaking" ? "speaking" : spoken.state === "listening" ? "listening" : "online";

  const phase: CallPhase = ended ? "ended" : connectedAt === null ? "connecting" : "live";
  const seconds = useCallClock(connectedAt, phase === "live");
  const onCall = talking && connectedAt !== null && !ended;

  /** Hang up: the conversation ends (kept under Calls as a web chat). */
  const hangUp = () => {
    spoken.stop();
    setTalking(false);
    if (idRef.current) void chatEndAction(org, loc, token, idRef.current);
    idRef.current = null;
    setEnded(true);
  };
  const callAgain = () => {
    ringStart.current = Date.now();
    setConnectedAt(null);
    setMuted(false);
    setTalking(true);
    setView("call");
    begin();
  };
  /** From the chat: start a call in this same conversation (it connects at once). */
  const callFromChat = () => {
    spoken.skipExisting();
    setMuted(false);
    setTalking(true);
    setConnectedAt(Date.now());
    setView("call");
    spoken.listenNow();
  };
  const toggleMute = () => {
    if (!muted) spoken.cancelListening();
    else if (spoken.state === "idle" && !pending) spoken.listenNow();
    setMuted((m) => !m);
  };

  if (view === "call") {
    const last = [...lines].reverse().find((l): l is Extract<ChatLine, { text: string }> => l.who !== "booked");
    const caption =
      spoken.state === "listening" && spoken.interim
        ? { who: "me" as const, text: spoken.interim }
        : last
          ? { who: last.who, text: last.text }
          : null;
    const er = emergencyTarget(clinic);
    return (
      <CallView
        aiName={aiName}
        subtitle={`${clinic.name} · AI assistant`}
        phase={phase}
        status={status}
        seconds={seconds}
        caption={caption}
        muted={muted}
        error={error ?? spoken.error}
        onToggleMute={toggleMute}
        onShowChat={() => setView("chat")}
        onEnd={hangUp}
        onCallAgain={callAgain}
        emergency={emergency ? { name: er.name, call: er.call, detail: er.er ? `We're closed. Call ${er.er.name} now.` : "Please call the clinic now so a vet can help right away." } : null}
      />
    );
  }

  const mic = () => {
    if (!talking) {
      // Turning the voice on: earlier messages are not read out again.
      spoken.skipExisting();
      setTalking(true);
      spoken.listenNow();
    } else spoken.mic();
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="sticky top-0 z-20 flex h-[3.75rem] items-center gap-2.5 border-b bg-card py-2 pl-2 pr-3">
        {onBack ? (
          <IconButton label="Back" onClick={onBack}>
            <ArrowLeft className="size-5" aria-hidden />
          </IconButton>
        ) : (
          <span className="w-1.5" aria-hidden />
        )}
        <AssistantAvatar size="md" status={status} />
        <div className="grid min-w-0 flex-1" aria-live="polite">
          <span className="truncate text-small font-semibold">
            {aiName} <span className="font-normal text-muted-foreground">· {clinic.name}</span>
          </span>
          <span className={cn("truncate text-caption", status === "online" ? "text-muted-foreground" : "font-medium text-primary")}>{statusText(status, clinic.open)}</span>
        </div>
        {canTalk && callId && !ended && !onCall && (
          <IconButton label={`Call ${aiName}`} onClick={callFromChat}>
            <Phone className="size-5 text-primary" aria-hidden />
          </IconButton>
        )}
        {canTalk && !onCall && (
          <IconButton label={talking ? `Mute ${aiName}'s voice` : `Hear ${aiName}'s replies`} onClick={() => (talking ? setTalking(false) : (spoken.skipExisting(), setTalking(true)))}>
            {talking ? <Volume2 className="size-5 text-primary" aria-hidden /> : <VolumeX className="size-5" aria-hidden />}
          </IconButton>
        )}
        {onClose && (
          <IconButton label="Close" onClick={onClose}>
            <X className="size-5" aria-hidden />
          </IconButton>
        )}
      </div>
      {onCall && <OnCallBar aiName={aiName} seconds={seconds} onReturn={() => setView("call")} />}

      <div className="grid flex-1 content-start gap-2 p-4" aria-live="polite">
        {emergency && <EmergencyCard clinic={clinic} />}
        {lines.map((l, i) =>
          l.who === "booked" ? (
            <BookedCard key={l.id} visit={l.visit} clinic={clinic} />
          ) : l.who === "ai" ? (
            <AssistantBubble key={l.id} avatar={lines[i - 1]?.who !== "ai"}>
              {l.text}
            </AssistantBubble>
          ) : (
            <div key={l.id} className="cw-in max-w-[80%] justify-self-end whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-body text-primary-foreground shadow-sm">
              {l.text}
            </div>
          ),
        )}
        {pending && (
          <div className="flex items-end gap-2" role="status" aria-label={`${aiName} is typing`}>
            <AssistantAvatar size="sm" status="thinking" />
            <span className="flex gap-1 rounded-2xl rounded-bl-md border bg-card px-3.5 py-3">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 motion-reduce:animate-none" style={{ animationDelay: `${i * 120}ms` }} />
              ))}
            </span>
          </div>
        )}
        {choices.length > 0 && !pending && !ended && (
          <div className="cw-in flex flex-wrap gap-2 pl-10 pt-1" role="group" aria-label="Quick answers">
            {choices.map((c) => (
              <button
                key={c.value + c.label}
                type="button"
                onClick={() => say(c.value, c.label)}
                className="rounded-full border border-primary/40 bg-card px-3.5 py-2 text-small font-semibold text-primary shadow-sm transition-colors hover:bg-primary hover:text-primary-foreground"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {callId && lines.length <= 1 && choices.length === 0 && !pending && !first && (
          <div className="flex flex-wrap gap-2 pl-10 pt-1">
            {STARTERS.map((st) => (
              <button key={st} type="button" onClick={() => say(st)} className="rounded-full border border-primary/30 bg-card px-3 py-1.5 text-small font-medium shadow-sm hover:border-primary hover:bg-secondary">
                {st}
              </button>
            ))}
          </div>
        )}
        {error && <Alert variant="error">{error}</Alert>}
        {spoken.error && <Alert variant="error">{spoken.error}</Alert>}
        <div ref={end} />
      </div>

      <div className="sticky bottom-0 border-t bg-card px-3 py-3">
        {ended ? (
          <Button variant="outline" className="h-11 w-full rounded-full" onClick={begin}>
            <MessageSquareText aria-hidden /> Start a new conversation
          </Button>
        ) : (
          <Composer
            value={spoken.state === "listening" ? spoken.interim : text}
            onChange={setText}
            onSend={() => say(text.trim())}
            placeholder={spoken.state === "listening" ? "Listening… go ahead" : spoken.state === "speaking" ? `${aiName} is speaking… tap the mic to talk` : `Message ${aiName}…`}
            disabled={!callId}
            mic={canTalk ? { listening: spoken.state === "listening", onClick: mic, disabled: pending || !callId } : null}
          />
        )}
      </div>
    </div>
  );
}
