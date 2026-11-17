// Sign-in emails: password reset and email verification.
//
// These are platform emails to staff, not messages to clinic clients, so
// MESSAGING_MODE does not apply: without them nobody could sign in. They go
// through Resend or SendGrid whenever one is configured. In development without SendGrid
// the link is printed to the dev server terminal instead. On a staging site
// (APP_STAGE=staging) without SendGrid they fail with a clear message: links
// are never printed there, because hosted logs are shared.
import type { Env } from "./env";
import type { Logger } from "./logger";
import { mailProvider, sendMail } from "./mail";

export interface AuthEmail {
  to: string;
  subject: string;
  text: string;
  /** Printed in development when SendGrid is not configured. */
  link: string;
}

export type AuthEmailSender = (email: AuthEmail) => Promise<void>;

export function createAuthEmailSender(
  env: Pick<Env, "NODE_ENV" | "SENDGRID_API_KEY" | "EMAIL_FROM"> & Partial<Pick<Env, "APP_STAGE" | "RESEND_API_KEY">>,
  log: Logger,
  fetchImpl: typeof fetch = fetch,
): AuthEmailSender {
  const provider = mailProvider(env);
  const from = env.EMAIL_FROM;
  if (provider && from) {
    return async (email) => {
      const res = await sendMail({ provider, from, fromName: "Vetrix" }, { to: email.to, subject: email.subject, text: email.text }, fetchImpl);
      if (!res.ok) {
        log.error("sign-in email failed", { status: res.status, provider: provider.kind, subject: email.subject });
        throw new Error("Could not send the email. Please try again.");
      }
      log.info("sign-in email sent", { subject: email.subject });
    };
  }
  if (env.NODE_ENV === "production" && env.APP_STAGE === "staging") {
    return async (email) => {
      log.warn("sign-in email not sent: email is not set up on this staging site", { subject: email.subject });
      throw new Error("Email isn't set up on this site yet. Ask an administrator to reset your password.");
    };
  }
  if (env.NODE_ENV === "production") {
    // env.ts already refuses this, but never fall through to printing links.
    throw new Error("RESEND_API_KEY (or SENDGRID_API_KEY) and EMAIL_FROM are required in production");
  }
  return async (email) => {
    // Development only: the person running the dev server is the recipient.
    console.info(`\n[sign-in email, not sent] ${email.subject}\n  ${email.link}\n`);
  };
}
