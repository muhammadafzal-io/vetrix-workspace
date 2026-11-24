import { describe, expect, it } from "vitest";
import { mayReallySend, messagingAllowlist, providerTestSender } from "./allowlist";

const dev = { NODE_ENV: "development" as const, APP_STAGE: "production" as const };

describe("testing real messages with an allowlist", () => {
  it("lets everyone through when no list is set", () => {
    expect(mayReallySend({ email: "anyone@example.com" }, { ...dev, MESSAGING_ALLOWLIST: undefined })).toBe(true);
  });

  it("sends only to listed emails and mobiles (any format)", () => {
    const env = { ...dev, MESSAGING_ALLOWLIST: "Me@Work.com, +1 (555) 010-9999" };
    expect(mayReallySend({ email: "me@work.com" }, env)).toBe(true);
    expect(mayReallySend({ email: "client@example.com" }, env)).toBe(false);
    expect(mayReallySend({ phone: "+15550109999" }, env)).toBe(true);
    expect(mayReallySend({ phone: "5550109999" }, env)).toBe(true);
    expect(mayReallySend({ phone: "+15550101234" }, env)).toBe(false);
  });

  it("is ignored in production, but works on staging", () => {
    expect(messagingAllowlist({ NODE_ENV: "production", APP_STAGE: "production", MESSAGING_ALLOWLIST: "me@work.com" })).toBeNull();
    expect(messagingAllowlist({ NODE_ENV: "production", APP_STAGE: "staging", MESSAGING_ALLOWLIST: "me@work.com" })?.emails.has("me@work.com")).toBe(true);
    expect(providerTestSender({ NODE_ENV: "production", APP_STAGE: "production" })).toBeNull();
    expect(providerTestSender(dev)).toBe("onboarding@resend.dev");
  });
});
