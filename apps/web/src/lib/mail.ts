// One way to send an email, whichever provider is configured: Resend
// (preferred, RESEND_API_KEY) or SendGrid (SENDGRID_API_KEY). Plain text only.
// Used for staff sign-in emails (auth-email.ts) and client email (email.ts).
import type { Env } from "./env";

export interface MailProvider {
  kind: "resend" | "sendgrid";
  apiKey: string;
}

export interface MailResult {
  ok: boolean;
  id: string | null;
  status: number;
}

/** The configured provider, Resend first; null when neither key is set. */
export function mailProvider(env: Partial<Pick<Env, "RESEND_API_KEY" | "SENDGRID_API_KEY">>): MailProvider | null {
  if (env.RESEND_API_KEY) return { kind: "resend", apiKey: env.RESEND_API_KEY };
  if (env.SENDGRID_API_KEY) return { kind: "sendgrid", apiKey: env.SENDGRID_API_KEY };
  return null;
}

export async function sendMail(
  config: { provider: MailProvider; from: string; fromName: string },
  input: { to: string; subject: string; text: string; replyTo?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<MailResult> {
  const { provider } = config;
  if (provider.kind === "resend") {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: `${config.fromName.replace(/[<>"]/g, "")} <${config.from}>`,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: res.ok, id: body.id ?? null, status: res.status };
  }
  const res = await fetchImpl("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      personalizations: [{ to: [{ email: input.to }] }],
      from: { email: config.from, name: config.fromName },
      ...(input.replyTo ? { reply_to: { email: input.replyTo } } : {}),
      subject: input.subject,
      content: [{ type: "text/plain", value: input.text }],
      // Links in emails must not be rewritten by click tracking.
      tracking_settings: { click_tracking: { enable: false, enable_text: false } },
    }),
  });
  return { ok: res.ok, id: res.headers.get("x-message-id"), status: res.status };
}
