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

// ---------- Microphone permission ----------

export type MicAccess = "granted" | "denied" | "no-device" | "unsupported";

/** Shown when the browser blocks the microphone: what to click, not just "blocked". */
export const MIC_BLOCKED_HELP =
  "The microphone is blocked for this site. Click the icon at the left of the address bar, set Microphone to Allow, then tap Try again. Or use Chat to type.";
export const MIC_MISSING_HELP = "No microphone was found. Connect one and tap Try again, or use Chat to type.";

/**
 * Asks for the microphone. Call it straight from a click: browsers only show
 * their "Allow microphone?" prompt for a request the person just made, and
 * speech recognition started later (after Riley's greeting) can be refused
 * silently. The stream is closed at once; recognition opens its own.
 */
export async function ensureMicrophone(): Promise<MicAccess> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return "unsupported";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "granted";
  } catch (error) {
    const name = (error as DOMException).name;
    return name === "NotFoundError" || name === "OverconstrainedError" ? "no-device" : "denied";
  }
}

/** The help text for a failed microphone request, or null when it worked. */
export function micProblem(access: MicAccess): string | null {
  return access === "denied" ? MIC_BLOCKED_HELP : access === "no-device" ? MIC_MISSING_HELP : null;
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
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    // Chrome sometimes never fires "end" (long text, a voice that fails to
    // load): never wait longer than the words could take, or the call sticks.
    const words = queue.join(" ").split(/\s+/).length;
    const guard = setTimeout(finish, 3000 + words * 450);
    for (const line of queue) {
      const u = new SpeechSynthesisUtterance(line);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? "en-US";
      u.rate = 1.02;
      u.onend = u.onerror = () => {
        left -= 1;
        if (left === 0) finish();
      };
      synth.speak(u);
    }
  });
}

export function stopSpeaking(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

export interface Listener {
  /** Stop and keep what was heard (it is sent). */
  stop(): void;
  /** Stop and drop what was heard (mute). */
  abort(): void;
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
        ? MIC_BLOCKED_HELP
        : e.error === "audio-capture"
          ? MIC_MISSING_HELP
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
      // Stopping keeps what was heard so far (it is sent); abort drops it.
      rec.stop();
    },
    abort() {
      finalText = "";
      done = true;
      rec.abort();
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
  /** False while muted: replies are still read aloud, but nothing is heard. */
  autoListen?: boolean;
  /**
   * On a call: keep listening through silence for as long as the call is
   * live (a person on a call may think for a while). Otherwise listening
   * stops after three silent turns and waits for the mic button.
   */
  keepListening?: boolean;
}) {
  const { active, replies, busy, ended } = options;
  const autoListen = useRef(options.autoListen ?? true);
  autoListen.current = options.autoListen ?? true;
  const keepListening = useRef(options.keepListening ?? false);
  keepListening.current = options.keepListening ?? false;
  // Turns that ended almost at once (the browser refusing to listen): stop
  // after a few so a broken microphone never loops.
  const quickEnds = useRef(0);
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
    const startedAt = Date.now();
    listener.current = listenOnce({
      onInterim: setInterim,
      onFinal: (text) => {
        listener.current = null;
        setInterim("");
        if (!live.current) return setState("idle");
        if (text) {
          silentTurns.current = 0;
          quickEnds.current = 0;
          setState("idle");
          heard.current(text);
          return;
        }
        quickEnds.current = Date.now() - startedAt < 1500 ? quickEnds.current + 1 : 0;
        const keepGoing = keepListening.current ? quickEnds.current < 3 : ++silentTurns.current < 3;
        if (keepGoing && autoListen.current) listen();
        else setState("idle");
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
      if (ended || !autoListen.current) setState("idle");
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
    /** Mute: stop listening and drop what was heard; replies are still read aloud. */
    cancelListening() {
      listener.current?.abort();
      listener.current = null;
      setInterim("");
      setState((st) => (st === "listening" ? "idle" : st));
    },
    /** Voice turned on mid-conversation: what was already said is not read out again. */
    skipExisting() {
      spokenUpTo.current = Math.max(spokenUpTo.current, ...replies.map((r) => r.id));
    },
    /** "Try again" after a blocked microphone: ask again (from the click), then listen. */
    async retryMicrophone() {
      setError(null);
      const problem = micProblem(await ensureMicrophone());
      if (problem) return setError(problem);
      live.current = true;
      silentTurns.current = 0;
      listen();
    },
    /** True when the last problem was the microphone (so "Try again" is offered). */
    micBlocked: error === MIC_BLOCKED_HELP || error === MIC_MISSING_HELP,
    /** Listen right away, even in the same click that turns voice on. */
    listenNow() {
      live.current = true;
      silentTurns.current = 0;
      quickEnds.current = 0;
      listen();
    },
    /** The mic button: done speaking (send what was heard), or speak now (interrupts the AI). */
    mic() {
      if (state === "listening") listener.current?.stop();
      else {
        silentTurns.current = 0;
        quickEnds.current = 0;
        listen();
      }
    },
  };
}

/**
 * A short ringback ("calling…") tone made in the browser: the US ring of
 * 440 Hz + 480 Hz, twice. Returns a function that stops it early. Silent
 * when the browser blocks audio.
 */
export function playRingback(): () => void {
  if (typeof window === "undefined") return () => {};
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return () => {};
  }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  for (const f of [440, 480]) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(gain);
    o.start();
    o.stop(ctx.currentTime + 3.2);
  }
  // Two rings: 1 s on, 0.6 s off, at a gentle volume.
  for (const start of [0, 1.6]) {
    gain.gain.setValueAtTime(0.06, ctx.currentTime + start);
    gain.gain.setValueAtTime(0, ctx.currentTime + start + 1);
  }
  const stop = () => {
    void ctx.close().catch(() => undefined);
  };
  setTimeout(stop, 3300);
  return stop;
}
