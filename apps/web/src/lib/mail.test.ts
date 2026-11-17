import { describe, expect, it, vi } from "vitest";
import { createAuthEmailSender } from "./auth-email";
import { createLogger } from "./logger";
import { mailProvider, sendMail } from "./mail";

const quiet = createLogger({ level: "error", write: () => {} });
const okJson = (body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe("email provider", () => {
  it("prefers Resend, falls back to SendGrid, and is null without a key", () => {
    expect(mailProvider({ RESEND_API_KEY: "re_x", SENDGRID_API_KEY: "SG.x" })?.kind).toBe("resend");
    expect(mailProvider({ SENDGRID_API_KEY: "SG.x" })?.kind).toBe("sendgrid");
    expect(mailProvider({})).toBeNull();
  });

  it("sends plain text through Resend with the sender name and reply-to", async () => {
    const fetchImpl = okJson({ id: "email_123" });
    const r = await sendMail(
      { provider: { kind: "resend", apiKey: "re_x" }, from: "desk@updates.example.com", fromName: "Main <Vet>" },
      { to: "owner@example.com", subject: "Hi", text: "Body", replyTo: "front@example.com" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(r).toEqual({ ok: true, id: "email_123", status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_x");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Main Vet <desk@updates.example.com>",
      to: ["owner@example.com"],
      subject: "Hi",
      text: "Body",
      reply_to: "front@example.com",
    });
  });

  it("sends sign-in emails through Resend when its key is set", async () => {
    const fetchImpl = okJson({ id: "email_456" });
    const send = createAuthEmailSender(
      { NODE_ENV: "production", RESEND_API_KEY: "re_x", SENDGRID_API_KEY: undefined, EMAIL_FROM: "desk@updates.example.com" },
      quiet,
      fetchImpl as unknown as typeof fetch,
    );
    await send({ to: "staff@example.com", subject: "Reset your password", text: "Link", link: "https://x" });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.resend.com/emails");
  });
});
