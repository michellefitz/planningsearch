import { afterEach, describe, expect, it, vi } from "vitest";
import { magicLinkEmail, sendEmail } from "../../api/_accounts/email.mjs";

describe("magicLinkEmail", () => {
  it("contains the link and expiry note in both bodies", () => {
    const { subject, html, text } = magicLinkEmail("https://x.test/api/auth/verify?token=t1");
    expect(subject).toBe("Sign in to PlanView");
    expect(text).toContain("https://x.test/api/auth/verify?token=t1");
    expect(text).toContain("15 minutes");
    expect(html).toContain("https://x.test/api/auth/verify?token=t1");
    expect(html).toContain("Sign in");
  });
});

describe("sendEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  it("throws without RESEND_API_KEY", async () => {
    await expect(sendEmail({ to: "a@b.c", subject: "s", html: "h", text: "t" }))
      .rejects.toThrow("RESEND_API_KEY not set");
  });

  it("POSTs to Resend with bearer auth and the EMAIL_FROM sender", async () => {
    process.env.RESEND_API_KEY = "re_key";
    process.env.EMAIL_FROM = "PlanView <alerts@planview.example>";
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail({ to: "a@b.c", subject: "s", html: "<p>h</p>", text: "t" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_key");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      from: "PlanView <alerts@planview.example>",
      to: "a@b.c", subject: "s", html: "<p>h</p>", text: "t",
    });
  });
});
