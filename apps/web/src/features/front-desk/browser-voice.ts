"use client";

// Talking to Riley in the browser (staff test console only). The browser
// turns the caller's speech into text (Web Speech API: SpeechRecognition)
// and reads Riley's replies aloud (speechSynthesis). Riley itself is the same
// server-side front desk as a real call: only the ears and mouth are the
// browser's. Chrome, Edge and Safari support it; Firefox has no speech
// recognition, so the console falls back to typing there.
import { useEffect, useRef, useState } from "react";

/** The parts of SpeechRecognition used here (not in TypeScript's DOM types everywhere). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether this browser can listen and speak. */
export function browserVoiceSupport(): { listen: boolean; speak: boolean } {
  return { listen: recognitionClass() !== null, speak: typeof window !== "undefined" && "speechSynthesis" in window };
}

/** A clear US English voice, preferring natural-sounding ones the browser offers. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  const preferred = ["Google US English", "Samantha", "Microsoft Aria Online (Natural)", "Microsoft Jenny Online (Natural)", "Ava", "Allison"];
  for (const name of preferred) {
    const v = voices.find((x) => x.name.includes(name));
    if (v) return v;
  }
  return voices.find((v) => v.lang === "en-US") ?? voices[0] ?? null;
}

/** Reads the lines aloud one after another; resolves when done or cancelled. */
export function speak(lines: string[]): Promise<void> {
  const synth = window.speechSynthesis;
  return new Promise((resolve) => {
    // A link is on screen; reading it out letter by letter helps no one.
    const queue = lines.map((l) => l.replace(/\bhttps?:\/\/\S+/gi, "the link on your screen").trim()).filter(Boolean);
    if (queue.length === 0) return resolve();
    const voice = pickVoice();
    let left = queue.length;
    for (const line of queue) {
      const u = new SpeechSynthesisUtterance(line);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? "en-US";
      u.rate = 1.02;
      u.onend = u.onerror = () => {
        left -= 1;
        if (left === 0) resolve();
      };
      synth.speak(u);
    }
  });
}

export function stopSpeaking(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

export interface Listener {
  stop(): void;
}

/**
 * Listens for one turn: `onInterim` shows words as they are heard, `onFinal`
 * gets the finished sentence ("" when nothing was said), `onError` a reason
 * a person can act on (e.g. the microphone is blocked).
 */
export function listenOnce(handlers: { onInterim: (text: string) => void; onFinal: (text: string) => void; onError: (message: string) => void }): Listener | null {
  const Ctor = recognitionClass();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = "";
  let done = false;
  const finish = (text: string) => {
    if (done) return;
    done = true;
    handlers.onFinal(text.trim());
  };
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onInterim((finalText + interim).trim());
  };
  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return; // onend follows
    done = true;
    handlers.onError(
      e.error === "not-allowed" || e.error === "service-not-allowed"
        ? "The microphone is blocked. Allow it in the browser's address bar, or type instead."
        : e.error === "audio-capture"
          ? "No microphone was found. Connect one, or type instead."
          : "The browser could not hear you. Try again, or type instead.",
    );
  };
  rec.onend = () => finish(finalText);
  try {
    rec.start();
  } catch {
    handlers.onError("The microphone could not start. Try again, or type instead.");
    return null;
  }
  return {
    stop() {
      // Stopping keeps what was heard so far (it is sent); abort would drop it.
      rec.stop();
    },
  };
}

// ---------- Turn-taking, shared by the staff console and the booking widget ----------

export type VoiceState = "idle" | "speaking" | "listening";

/**
 * A spoken conversation on top of a text one: new AI lines are read aloud,
 * then the browser listens and hands what it heard to `onHeard` (which sends
 * it like a typed message). Tapping the mic while the AI speaks interrupts
 * it; after three silent turns it waits for the mic button.
 *
 * `replies` are the AI's lines with increasing ids; `busy` is true while a
 * reply is on its way; `ended` stops listening after the last reply.
 */
export function useSpokenTurns(options: {
  active: boolean;
  replies: { id: number; text: string }[];
  busy: boolean;
  ended: boolean;
  onHeard: (text: string) => void;
}) {
  const { active, replies, busy, ended } = options;
  const [state, setState] = useState<VoiceState>("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listener = useRef<Listener | null>(null);
  const spokenUpTo = useRef(0);
  const silentTurns = useRef(0);
  const turn = useRef(0); // an interrupted turn must not start listening again
  const live = useRef(active);
  live.current = active;
  const heard = useRef(options.onHeard);
  heard.current = options.onHeard;

  function stop() {
    turn.current += 1;
    listener.current?.stop();
    listener.current = null;
    stopSpeaking();
    setState("idle");
    setInterim("");
  }

  function listen() {
    if (!live.current) return;
    turn.current += 1;
    stopSpeaking();
    setError(null);
    setState("listening");
    setInterim("");
    listener.current = listenOnce({
      onInterim: setInterim,
      onFinal: (text) => {
        listener.current = null;
        setInterim("");
        if (!live.current) return setState("idle");
        if (text) {
          silentTurns.current = 0;
          setState("idle");
          heard.current(text);
        } else if (++silentTurns.current < 3) {
          listen();
        } else {
          setState("idle");
        }
      },
      onError: (message) => {
        listener.current = null;
        setState("idle");
        setError(message);
      },
    });
    if (!listener.current) setState("idle");
  }

  // New AI lines: read them aloud, then listen (or stop after the last one).
  useEffect(() => {
    if (!active || busy) return;
    const fresh = replies.filter((r) => r.id > spokenUpTo.current);
    if (fresh.length === 0) return;
    spokenUpTo.current = Math.max(...fresh.map((r) => r.id));
    setState("speaking");
    const mine = ++turn.current;
    void speak(fresh.map((r) => r.text)).then(() => {
      if (!live.current || turn.current !== mine) return;
      if (ended) setState("idle");
      else listen();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listen() works through refs
  }, [active, replies, busy, ended]);

  // Turning voice off, or leaving the page, stops speaking and listening.
  useEffect(() => {
    if (!active) stop();
  }, [active]);
  useEffect(
    () => () => {
      live.current = false;
      listener.current?.stop();
      stopSpeaking();
    },
    [],
  );

  return {
    state,
    interim,
    error,
    /** Start over for a new conversation (nothing read yet). */
    reset() {
      stop();
      spokenUpTo.current = 0;
      silentTurns.current = 0;
      setError(null);
    },
    stop,
    /** Voice turned on mid-conversation: what was already said is not read out again. */
    skipExisting() {
      spokenUpTo.current = Math.max(spokenUpTo.current, ...replies.map((r) => r.id));
    },
    /** Listen right away, even in the same click that turns voice on. */
    listenNow() {
      live.current = true;
      silentTurns.current = 0;
      listen();
    },
    /** The mic button: done speaking (send what was heard), or speak now (interrupts the AI). */
    mic() {
      if (state === "listening") listener.current?.stop();
      else {
        silentTurns.current = 0;
        listen();
      }
    },
  };
}
