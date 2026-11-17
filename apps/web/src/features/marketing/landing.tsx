// The public website at "/" for people who are not signed in. It describes
// only what Vetrix does today (no invented numbers, logos or quotes), and the
// "Try it live" buttons open the real booking widget for the sample clinic
// (always Sandbox: nothing is texted).
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  BellRing,
  CalendarCheck2,
  ClipboardCheck,
  Database,
  HeartPulse,
  Hourglass,
  MessageSquareText,
  MoonStar,
  PhoneCall,
  PhoneIncoming,
  ShieldCheck,
  Siren,
  Sparkles,
  Stethoscope,
  Syringe,
} from "lucide-react";
import { BrandBackdrop, Highlight, LogoOnDark } from "@/components/vetrix/brand-backdrop";
import { Logo } from "@/components/vetrix/logo";
import { BookingScene } from "@/features/auth/booking-scene";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "#features", label: "Features" },
  { href: "#how", label: "How it works" },
  { href: "#safety", label: "Safety" },
  { href: "#faq", label: "FAQ" },
];

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: PhoneIncoming,
    title: "Every call and text answered",
    body: "Riley, your AI front desk, picks up day and night, knows each caller and their pets, and books, moves or cancels visits while they're on the line.",
  },
  {
    icon: Siren,
    title: "Triage that escalates, never guesses",
    body: "Urgent symptoms are recognised by meaning, not keywords. In hours, Riley transfers to your team; after hours, owners get your emergency hospital's details at once.",
  },
  {
    icon: CalendarCheck2,
    title: "Booking that respects your rules",
    body: "The right doctor, room and equipment for each visit, with species, age and prerequisites checked, buffers kept, and no double-booking.",
  },
  {
    icon: BellRing,
    title: "Reminders that bring pets back",
    body: "Vaccines, wellness, senior checks, rechecks and missed visits: one text per household, with a personal link that books the right visit in a tap.",
  },
  {
    icon: Hourglass,
    title: "Cancellations refilled",
    body: "When a slot opens inside 72 hours, the waitlist is offered it by text, then by call. The first to say yes gets the time.",
  },
  {
    icon: Sparkles,
    title: "Online booking on your website",
    body: "One line of code adds a booking button to your site. Owners confirm their number, choose a pet and a time, and they're done.",
  },
];

const STEPS: { title: string; body: string }[] = [
  { title: "Bring your clinic in", body: "Import clients, pets, vaccines and visits from your practice system's exports, then set hours, doctors, rooms and services." },
  { title: "Point your phone line", body: "Forward calls and texts to your Vetrix number. Riley answers with your clinic's name, hours and policies." },
  { title: "Run the day from one screen", body: "Calls, transcripts, tasks, the schedule and reminders sit side by side. Your team steps in only where a person is needed." },
];

const SAFETY: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: HeartPulse, title: "A triage level never goes down", body: "Once a call sounds urgent, it stays urgent for the rest of the conversation. When unsure, Riley escalates." },
  { icon: Stethoscope, title: "Staff judgement stays with staff", body: "Visits that need a check first are never booked online. Owners are asked to call, and a task is created." },
  { icon: Syringe, title: "Pre-op care, followed up", body: "Fasting reminders go out at 7 PM the evening before surgery or dental work. No reply means a check at drop-off." },
  { icon: MoonStar, title: "Gentle with hard moments", body: "Booking a euthanasia pauses that pet's reminders, and a pet is only marked deceased once the details are confirmed." },
];

const FAQ: { q: string; a: string }[] = [
  { q: "Does Vetrix replace our practice management system?", a: "No. Vetrix sits in front of it as your front desk: it answers, books and reminds. Your records and billing stay where they are." },
  { q: "What happens when a caller describes an emergency?", a: "During opening hours Riley transfers the call to your team. After hours the owner gets your emergency hospital's name, phone and address straight away, by voice and by text, and your staff see an urgent task." },
  { q: "Can owners book online?", a: "Yes. Reminder texts carry a personal booking link, and the booking widget on your website lets any owner book after confirming their mobile with a texted code. Only visits you mark as bookable online are offered." },
  { q: "What about clients who don't want texts?", a: "Replying STOP turns texting off for that client. They still get confirmations by email or a call, and your team can see their preference." },
  { q: "Where is our data kept?", a: "Each clinic organization has its own database. Staff sign in with their own accounts, and what each person can see and do depends on their role at each location." },
];

const btnLight =
  "inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 font-semibold text-navy-900 shadow-lg transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:hover:translate-y-0";
const btnGhostDark =
  "inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/25 px-6 font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

export function Landing({ tryIt, contactEmail, signedIn }: { tryIt: boolean; contactEmail: string | null; signedIn: boolean }) {
  const app = signedIn ? { href: "/overview", label: "Open Vetrix" } : { href: "/sign-in", label: "Sign in" };
  const TryButton = ({ className, children }: { className: string; children: React.ReactNode }) =>
    tryIt ? (
      <button type="button" data-booking-widget className={className}>
        {children}
      </button>
    ) : (
      <Link href="/sign-in" className={className}>
        {children}
      </Link>
    );

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* Header + hero */}
      <div className="relative overflow-hidden text-white">
        <BrandBackdrop waves="26%" />
        <header className="relative">
          <nav aria-label="Main" className="mx-auto flex h-20 max-w-6xl items-center gap-6 px-5 sm:px-8">
            <Link href="/" aria-label="Vetrix home" className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <LogoOnDark />
            </Link>
            <ul className="ml-6 hidden items-center gap-1 md:flex">
              {NAV.map((n) => (
                <li key={n.href}>
                  <a href={n.href} className="rounded-full px-3 py-2 text-small font-medium text-white/75 transition-colors hover:bg-white/10 hover:text-white">
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="ml-auto flex items-center gap-2">
              <Link href={app.href} className="rounded-full px-4 py-2 text-small font-semibold text-white/85 transition-colors hover:bg-white/10 hover:text-white">
                {app.label}
              </Link>
              <TryButton className="hidden h-10 items-center gap-2 rounded-full bg-white px-4 text-small font-semibold text-navy-900 shadow-md transition-transform hover:-translate-y-0.5 sm:inline-flex">
                Try it live
              </TryButton>
            </div>
          </nav>
        </header>

        <section className="relative mx-auto grid max-w-6xl items-center gap-10 px-5 pb-20 pt-8 sm:px-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:pb-28 lg:pt-14">
          <div className="grid gap-6">
            <p className="vx-fade-up inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-caption font-medium text-white/80">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden /> The AI front desk for veterinary clinics
            </p>
            <h1 className="vx-fade-up text-[40px] font-semibold leading-[1.1] tracking-tight sm:text-[56px]" style={{ animationDelay: "0.1s" }}>
              Every call answered.
              <br />
              <Highlight delay={0.9}>Every pet brought back.</Highlight>
            </h1>
            <p className="vx-fade-up max-w-xl text-h3 font-normal text-white/75" style={{ animationDelay: "0.25s" }}>
              Vetrix answers your phones and texts, triages safely, books the right doctor, room and equipment, and reminds owners when their pets are due. Your team gets their time back.
            </p>
            <div className="vx-fade-up flex flex-wrap items-center gap-3" style={{ animationDelay: "0.4s" }}>
              <TryButton className={btnLight}>
                <CalendarCheck2 className="size-5" aria-hidden /> Try it live
              </TryButton>
              {contactEmail ? (
                <a href={`mailto:${contactEmail}`} className={btnGhostDark}>
                  Talk to us <ArrowRight className="size-4" aria-hidden />
                </a>
              ) : (
                <a href="#how" className={btnGhostDark}>
                  See how it works <ArrowRight className="size-4" aria-hidden />
                </a>
              )}
            </div>
            {tryIt && <p className="text-caption text-white/55">Try it live opens a sample clinic: book, chat with Riley or call. Nothing is sent.</p>}
          </div>
          <div className="relative hidden justify-center lg:flex">
            <BookingScene className="origin-center scale-100 xl:scale-110" />
          </div>
        </section>
      </div>

      {/* Highlights strip */}
      <section aria-label="At a glance" className="border-b bg-card">
        <ul className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-5 py-6 sm:px-8 lg:grid-cols-4">
          {[
            { icon: PhoneCall, label: "Answers day and night" },
            { icon: Siren, label: "Emergency triage built in" },
            { icon: ClipboardCheck, label: "Books by your clinic's rules" },
            { icon: Database, label: "A separate database per clinic" },
          ].map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-3 px-2 py-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-primary">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="text-small font-medium">{label}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-8 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <SectionHead eyebrow="Features" title="A front desk that never misses a beat" body="Everything that keeps a clinic's day moving, from the first ring to the next annual visit." />
          <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="group grid content-start gap-3 rounded-xl border bg-card p-6 shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md motion-reduce:hover:translate-y-0">
                <span className="flex size-11 items-center justify-center rounded-xl bg-secondary text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="text-h3">{title}</h3>
                <p className="text-muted-foreground">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Conversation peek */}
      <section aria-labelledby="peek" className="bg-card py-20 sm:py-24">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-2">
          <div className="grid gap-5">
            <p className="text-small font-semibold uppercase tracking-wide text-primary">Meet Riley</p>
            <h2 id="peek" className="text-[32px] font-semibold leading-tight tracking-tight sm:text-[40px]">
              Sounds like your best receptionist, on every line at once
            </h2>
            <p className="text-h3 font-normal text-muted-foreground">
              Riley recognises returning clients by their number, confirms with a pet&apos;s name, and speaks in your clinic&apos;s voice. Everything said is written down for your team, with a summary and any follow-up task.
            </p>
            <ul className="grid gap-3">
              {["Knows each pet's history and what they're due for", "Offers real times from your live schedule", "Texts a confirmation, and handles C, R and YES replies"].map((t) => (
                <li key={t} className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <ClipboardCheck className="size-3" aria-hidden />
                  </span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <ChatPeek />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-8 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <SectionHead eyebrow="How it works" title="Up and running in three steps" />
          <ol className="mt-12 grid gap-4 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative grid content-start gap-3 rounded-xl border bg-card p-6 shadow-card">
                <span className="flex size-10 items-center justify-center rounded-full bg-navy-900 text-body font-semibold text-white">{i + 1}</span>
                <h3 className="text-h3">{s.title}</h3>
                <p className="text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Safety */}
      <section id="safety" className="relative scroll-mt-8 overflow-hidden py-20 text-white sm:py-24">
        <BrandBackdrop waves="30%" />
        <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
          <div className="grid max-w-2xl gap-3">
            <p className="text-small font-semibold uppercase tracking-wide text-accent">Built for veterinary care</p>
            <h2 className="text-[32px] font-semibold leading-tight tracking-tight sm:text-[40px]">
              Safe by design, <Highlight>not by luck</Highlight>
            </h2>
            <p className="text-h3 font-normal text-white/70">Clinical rules come from a versioned veterinary rule pack, so every clinic gets the same careful behaviour.</p>
          </div>
          <ul className="mt-12 grid gap-4 sm:grid-cols-2">
            {SAFETY.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-sm">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/10 text-accent">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="grid gap-1.5">
                  <h3 className="text-h3">{title}</h3>
                  <p className="text-white/70">{body}</p>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-8 py-20 sm:py-24">
        <div className="mx-auto max-w-3xl px-5 sm:px-8">
          <SectionHead eyebrow="FAQ" title="Questions clinics ask" />
          <div className="mt-10 divide-y rounded-xl border bg-card shadow-card">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {f.q}
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-primary transition-transform group-open:rotate-45" aria-hidden>
                    +
                  </span>
                </summary>
                <p className="mt-3 text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final call to action */}
      <section className="px-5 pb-20 sm:px-8">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-2xl px-6 py-14 text-center text-white shadow-xl sm:px-12">
          <BrandBackdrop waves="40%" />
          <div className="relative mx-auto grid max-w-2xl justify-items-center gap-5">
            <ShieldCheck className="size-10 text-accent" aria-hidden />
            <h2 className="text-[30px] font-semibold leading-tight tracking-tight sm:text-[38px]">Give your front desk its time back</h2>
            <p className="text-h3 font-normal text-white/75">See how owners book and how Riley answers, in under a minute.</p>
            <div className="flex flex-wrap justify-center gap-3">
              <TryButton className={btnLight}>
                <CalendarCheck2 className="size-5" aria-hidden /> Try it live
              </TryButton>
              <Link href={app.href} className={btnGhostDark}>
                {app.label} <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-8 text-small text-muted-foreground sm:px-8">
          <Logo className="text-foreground" />
          <span>The AI front desk for veterinary clinics.</span>
          <span className="ml-auto flex gap-5">
            {contactEmail && (
              <a href={`mailto:${contactEmail}`} className="hover:text-foreground">
                Contact
              </a>
            )}
            <Link href="/sign-in" className="hover:text-foreground">
              Staff sign in
            </Link>
            <span>© {new Date().getFullYear()} Vetrix</span>
          </span>
        </div>
      </footer>
    </div>
  );
}

function SectionHead({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <div className="mx-auto grid max-w-2xl gap-3 text-center">
      <p className="text-small font-semibold uppercase tracking-wide text-primary">{eyebrow}</p>
      <h2 className="text-[32px] font-semibold leading-tight tracking-tight sm:text-[40px]">{title}</h2>
      {body && <p className="text-h3 font-normal text-muted-foreground">{body}</p>}
    </div>
  );
}

/** An illustration of a text conversation with Riley (not a real client). */
function ChatPeek() {
  const lines: { who: "owner" | "ai"; text: string }[] = [
    { who: "owner", text: "Hi, Bella's due for her shots. Anything Thursday afternoon?" },
    { who: "ai", text: "Hi Sam! Bella is due for her DAPP and rabies boosters. Thursday I have 2:15 PM or 3:40 PM with Dr. Marsh. Which suits you?" },
    { who: "owner", text: "2:15 please" },
    { who: "ai", text: "Done: Bella is booked for vaccines on Thursday at 2:15 PM with Dr. Marsh. I've texted you a confirmation." },
  ];
  return (
    <figure aria-label="Example text conversation with Riley" className="relative mx-auto w-full max-w-md">
      <div className="absolute -inset-6 -z-0 rounded-[32px] bg-secondary" aria-hidden />
      <div className="relative overflow-hidden rounded-2xl border bg-background shadow-xl">
        <div className="flex items-center gap-3 border-b bg-card px-4 py-3">
          <span className="flex size-9 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground" aria-hidden>
            R
          </span>
          <span className="grid">
            <span className="text-small font-semibold">Riley · Main Street Vet</span>
            <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <MessageSquareText className="size-3" aria-hidden /> Text conversation
            </span>
          </span>
        </div>
        <div className="grid gap-2.5 p-4">
          {lines.map((l, i) => (
            <p
              key={i}
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2 text-small shadow-sm",
                l.who === "owner" ? "justify-self-end rounded-br-md bg-primary text-primary-foreground" : "justify-self-start rounded-bl-md border bg-card",
              )}
            >
              {l.text}
            </p>
          ))}
          <p className="mt-1 flex items-center justify-center gap-1.5 text-caption text-muted-foreground">
            <CalendarCheck2 className="size-3.5 text-primary" aria-hidden /> Booked · Thu 2:15 PM · Dr. Marsh · Exam 1
          </p>
        </div>
      </div>
      <figcaption className="sr-only">An illustration, not a real client conversation.</figcaption>
    </figure>
  );
}
