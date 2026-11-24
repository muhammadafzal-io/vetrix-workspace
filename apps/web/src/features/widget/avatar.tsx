// The AI assistant's face in the booking widget: a friendly round avatar in
// the clinic's colour, with a headset, and a ring that shows what the
// assistant is doing (online, thinking, speaking, listening). Pure SVG and
// CSS: no image to load, and it takes the clinic's brand colour (--primary).
import { cn } from "@/lib/utils";

export type AssistantStatus = "online" | "thinking" | "speaking" | "listening";

const SIZE = { sm: "size-8", md: "size-11", lg: "size-16" } as const;

export function AssistantAvatar({ status = "online", size = "md", className }: { status?: AssistantStatus; size?: keyof typeof SIZE; className?: string }) {
  return (
    <span className={cn("relative inline-flex shrink-0", SIZE[size], className)} aria-hidden>
      {/* Listening: a ring that grows outwards. Speaking: a soft glow that breathes. */}
      {status === "listening" && <span className="cw-ping absolute inset-0 rounded-full bg-primary/40" />}
      {status === "speaking" && <span className="cw-breathe absolute -inset-1 rounded-full bg-primary/25" />}
      <svg viewBox="0 0 64 64" className="relative size-full drop-shadow-sm">
        <defs>
          <linearGradient id="cw-av-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.85" />
            <stop offset="1" stopColor="var(--primary-dark, var(--primary))" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="32" fill="url(#cw-av-bg)" />
        {/* Face */}
        <circle cx="32" cy="34" r="17" fill="#fff" />
        <rect x="24.5" y="29" width="4" height="6.5" rx="2" fill="var(--primary-dark, var(--primary))" className={status === "thinking" ? "cw-blink" : undefined} />
        <rect x="35.5" y="29" width="4" height="6.5" rx="2" fill="var(--primary-dark, var(--primary))" className={status === "thinking" ? "cw-blink" : undefined} />
        {status === "speaking" ? (
          <ellipse cx="32" cy="41.5" rx="4" ry="2.6" fill="var(--primary-dark, var(--primary))" className="cw-talk" />
        ) : (
          <path d="M26.5 40.5c1.6 2.2 3.4 3.2 5.5 3.2s3.9-1 5.5-3.2" fill="none" stroke="var(--primary-dark, var(--primary))" strokeWidth="2.4" strokeLinecap="round" />
        )}
        {/* Headset: band, ear pads and the mic arm */}
        <path d="M13.5 34a18.5 18.5 0 0 1 37 0" fill="none" stroke="#fff" strokeOpacity="0.9" strokeWidth="3" strokeLinecap="round" />
        <rect x="10.5" y="31" width="6" height="10" rx="3" fill="#fff" />
        <rect x="47.5" y="31" width="6" height="10" rx="3" fill="#fff" />
        <path d="M50.5 41c0 5-4 8-9.5 8.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="40.5" cy="49.5" r="2.2" fill="#fff" />
      </svg>
      {/* Online dot (green) or a busy dot while it thinks */}
      <span
        className={cn(
          "absolute bottom-0 right-0 rounded-full border-2 border-card",
          size === "lg" ? "size-4" : "size-3",
          status === "thinking" ? "cw-blink bg-amber-400" : "bg-emerald-500",
        )}
      />
    </span>
  );
}

/** Words for the status, shown under the assistant's name. */
export function statusText(status: AssistantStatus, open: boolean): string {
  switch (status) {
    case "thinking":
      return "Typing…";
    case "speaking":
      return "Speaking…";
    case "listening":
      return "Listening…";
    default:
      return open ? "Online · replies instantly" : "Online · the clinic is closed now";
  }
}
