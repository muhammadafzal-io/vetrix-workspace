"use client";

// The screen of a spoken conversation with the AI front desk, made to feel
// like a real call: "Calling…" with a ringback tone, then a running timer,
// the assistant's live status, sound bars and live captions, and Mute /
// Chat / End call. Used by the booking widget and the staff test console;
// the conversation itself (and the voice) is run by the parent.
import { useEffect, useState } from "react";
import { MessageSquareText, Mic, MicOff, Phone, PhoneOff, RotateCcw } from "lucide-react";
import { BrandBackdrop } from "@/components/vetrix/brand-backdrop";
import { AssistantAvatar, type AssistantStatus } from "@/features/widget/avatar";
import { cn } from "@/lib/utils";
import { playRingback } from "./browser-voice";
import { splitChoices, TimePicker } from "./time-picker";

export type CallPhase = "connecting" | "live" | "ended";

/** 75 → "01:15" */
export function callClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Seconds since the call connected, ticking once a second (stops when it ends). */
export function useCallClock(connectedAt: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!connectedAt || !running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [connectedAt, running]);
  return connectedAt ? Math.max(0, Math.round((now - connectedAt) / 1000)) : 0;
}

const STATUS_WORDS: Record<AssistantStatus, (name: string) => string> = {
  online: () => "Connected",
  thinking: (n) => `${n} is thinking…`,
  speaking: (n) => `${n} is speaking`,
  listening: () => "Listening… go ahead",
};

export function CallView({
  aiName,
  subtitle,
  phase,
  status,
  seconds,
  caption,
  muted,
  error,
  onToggleMute,
  onShowChat,
  onEnd,
  onCallAgain,
  onRetryMic,
  choices = [],
  onChoose,
  onTalk,
  emergency = null,
}: {
  aiName: string;
  /** e.g. "Main Veterinary Clinic · AI assistant" */
  subtitle: string;
  phase: CallPhase;
  status: AssistantStatus;
  seconds: number;
  /** What is being said right now: the assistant's last line, or the caller's words as they are heard. */
  caption: { who: "ai" | "me"; text: string } | null;
  muted: boolean;
  error?: string | null;
  onToggleMute: () => void;
  onShowChat: () => void;
  onEnd: () => void;
  onCallAgain: () => void;
  /** Shown with a microphone problem: ask for the microphone again. */
  onRetryMic?: () => void;
  /** Answers the AI is waiting for (times, yes/no, pet): tap instead of saying it. */
  choices?: { label: string; value: string }[];
  onChoose?: (value: string, label: string) => void;
  /** Start listening when the call is quiet (nobody speaking or listening). */
  onTalk?: () => void;
  /** The AI's triage says emergency: the screen turns red with a button to call a person now. */
  emergency?: { name: string; call: { href: string; text: string } | null; detail: string } | null;
}) {
  // The ringback plays once while the call connects.
  useEffect(() => {
    if (phase !== "connecting") return;
    return playRingback();
  }, [phase]);

  const live = phase === "live";
  const sound = live && (status === "speaking" || status === "listening");
  // With answers, an error or the emergency card on screen, the face shrinks so the call buttons stay visible.
  const compact = Boolean(error || emergency || (live && choices.length > 0));

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden text-white">
      <BrandBackdrop waves="30%" />
      {emergency && <div className="absolute inset-0 bg-gradient-to-b from-red-700/80 via-red-900/60 to-transparent" aria-hidden />}

      <div className={cn("relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-6 text-center", compact ? "pt-4" : "pt-8")}>
        <p className="text-caption font-medium uppercase tracking-wider text-white/60">{phase === "ended" ? "Call ended" : emergency ? "Possible emergency" : "Voice call"}</p>
        <p className="mt-1 text-small text-white/70">{subtitle}</p>

        {/* The face, with rings: ringing while connecting, breathing while it speaks. */}
        <div className={cn("relative flex items-center justify-center", compact ? "-my-2 scale-75" : "my-8")}>
          {phase === "connecting" && (
            <>
              <span className="cw-ring absolute size-28 rounded-full border-2 border-white/40" aria-hidden />
              <span className="cw-ring absolute size-28 rounded-full border-2 border-white/30 [animation-delay:0.6s]" aria-hidden />
              <span className="cw-ring absolute size-28 rounded-full border-2 border-white/20 [animation-delay:1.2s]" aria-hidden />
            </>
          )}
          <span className={cn("rounded-full ring-4 ring-white/15 transition-transform", status === "speaking" && live && "scale-105")}>
            <AssistantAvatar size="xl" status={live ? status : "online"} offline={phase === "ended"} />
          </span>
        </div>

        <h2 className="text-h2 font-semibold">{aiName}</h2>
        <p className="mt-1 flex items-center gap-2 text-small text-white/80" aria-live="polite">
          {phase === "connecting" ? (
            <span className="cw-dots">Calling</span>
          ) : phase === "ended" ? (
            <span>{callClock(seconds)}</span>
          ) : (
            <>
              <span className="tabular-nums">{callClock(seconds)}</span>
              <span aria-hidden>·</span>
              <span>{muted && status !== "speaking" ? "You're muted" : STATUS_WORDS[status](aiName)}</span>
            </>
          )}
        </p>

        {/* Sound bars: moving while someone is talking, flat when quiet. */}
        <div className={cn("flex h-8 items-center gap-1", compact ? "mt-2" : "mt-5")} aria-hidden>
          {Array.from({ length: 13 }, (_, i) => (
            <span
              key={i}
              className={cn("w-1 rounded-full bg-white/70", sound ? "cw-bar" : "h-1 opacity-40")}
              style={sound ? { animationDelay: `${(i % 5) * 90 + (i % 3) * 40}ms`, animationDuration: `${620 + (i % 4) * 110}ms` } : undefined}
            />
          ))}
        </div>

        {/* Live captions */}
        <div className="mt-5 min-h-[4.5rem] w-full max-w-sm" aria-live="polite">
          {caption && phase !== "connecting" && (
            <p className={cn("line-clamp-3 rounded-2xl px-4 py-2.5 text-small leading-relaxed", caption.who === "ai" ? "bg-white/10 text-white" : "bg-white text-foreground")}>
              <span className="sr-only">{caption.who === "ai" ? `${aiName}: ` : "You: "}</span>
              {caption.text}
            </p>
          )}
          {error && (
            <div role="alert" className="mt-2 grid gap-2 rounded-xl bg-destructive/90 px-3 py-2 text-caption text-white">
              <p>{error}</p>
              {onRetryMic && phase !== "ended" && (
                <button type="button" onClick={onRetryMic} className="justify-self-center rounded-full bg-white px-4 py-1.5 text-caption font-semibold text-destructive hover:bg-white/90">
                  Try again
                </button>
              )}
            </div>
          )}
        </div>

        {emergency && (
          <div role="alert" className="mt-4 grid w-full max-w-sm gap-2 rounded-2xl bg-white p-3 text-left text-foreground shadow-lg">
            <p className="text-small font-semibold text-destructive">{emergency.detail}</p>
            {emergency.call ? (
              <a href={emergency.call.href} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-red-600 font-semibold text-white hover:bg-red-700">
                <Phone className="size-5" aria-hidden /> Call {emergency.name} · {emergency.call.text}
              </a>
            ) : (
              <p className="text-small font-semibold">Go to your nearest emergency vet now.</p>
            )}
          </div>
        )}

        {live && onTalk && status === "online" && !muted && !error && (
          <button
            type="button"
            onClick={onTalk}
            className="mt-4 flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-small font-semibold text-primary-dark shadow-lg hover:bg-white/90"
          >
            <Mic className="size-4" aria-hidden /> Tap to talk
          </button>
        )}

        {live && choices.length > 0 && onChoose && (
          <div className="mt-4 flex max-w-sm flex-wrap justify-center gap-2" role="group" aria-label="Say it, or tap an answer">
            {splitChoices(choices).quick.map((c) => (
              <button
                key={c.value + c.label}
                type="button"
                onClick={() => onChoose(c.value, c.label)}
                className="rounded-full border border-white/40 bg-white/10 px-3.5 py-2 text-small font-semibold text-white hover:bg-white hover:text-primary-dark"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {live && onChoose && splitChoices(choices).times.length > 0 && (
          <div className="mt-3 w-full max-w-sm">
            <TimePicker times={splitChoices(choices).times} onPick={onChoose} tone="dark" />
          </div>
        )}

        <div className="mt-auto w-full">
          {phase === "ended" ? (
            <div className="grid grid-cols-2 gap-3 pt-6">
              <button type="button" onClick={onCallAgain} className="flex h-12 items-center justify-center gap-2 rounded-full bg-emerald-500 font-semibold text-white shadow-lg hover:bg-emerald-600">
                <Phone className="size-5" aria-hidden /> Call again
              </button>
              <button type="button" onClick={onShowChat} className="flex h-12 items-center justify-center gap-2 rounded-full bg-white/15 font-semibold text-white hover:bg-white/25">
                <RotateCcw className="size-5" aria-hidden /> See transcript
              </button>
            </div>
          ) : (
            <div className={cn("flex items-start justify-center gap-7", compact ? "pt-4" : "pt-6")}>
              <CallButton label={muted ? "Unmute" : "Mute"} onClick={onToggleMute} disabled={!live} active={muted}>
                {muted ? <MicOff className="size-6" aria-hidden /> : <Mic className="size-6" aria-hidden />}
              </CallButton>
              <CallButton label="End call" onClick={onEnd} danger>
                <PhoneOff className="size-7" aria-hidden />
              </CallButton>
              <CallButton label="Chat" onClick={onShowChat} disabled={!live}>
                <MessageSquareText className="size-6" aria-hidden />
              </CallButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CallButton({
  label,
  onClick,
  children,
  danger,
  active,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <span className="grid justify-items-center gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "flex items-center justify-center rounded-full shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/40 disabled:opacity-40",
          danger ? "size-16 bg-red-500 text-white hover:bg-red-600" : "size-14",
          !danger && (active ? "bg-white text-foreground" : "bg-white/15 text-white hover:bg-white/25"),
        )}
      >
        {children}
      </button>
      <span className="text-caption text-white/70">{label}</span>
    </span>
  );
}

/** "On call with Riley · 01:23 — tap to return", shown on the chat while a call is live. */
export function OnCallBar({ aiName, seconds, onReturn }: { aiName: string; seconds: number; onReturn: () => void }) {
  return (
    <button type="button" onClick={onReturn} className="flex w-full items-center justify-center gap-2 bg-emerald-500 px-4 py-1.5 text-caption font-semibold text-white hover:bg-emerald-600">
      <span className="size-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none" aria-hidden />
      On call with {aiName} · <span className="tabular-nums">{callClock(seconds)}</span> — tap to return
    </button>
  );
}
