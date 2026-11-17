// Client email (plain text) through the configured provider: Resend or
// SendGrid (mail.ts). Sign-in emails use auth-email.ts.
import "server-only";

export { mailProvider, sendMail as sendEmail, type MailProvider, type MailResult as EmailResult } from "./mail";
