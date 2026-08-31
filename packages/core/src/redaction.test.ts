import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveKey, redactHeaders, redactText, redactValue } from "./redaction.js";

describe("secret redaction", () => {
  it("masks sensitive request headers while keeping harmless ones", () => {
    const headers = redactHeaders({
      Authorization: "Bearer abcdefghijklmnop",
      Cookie: "session=7ab3c9d1e5",
      "Set-Cookie": "session=7ab3c9d1e5; HttpOnly",
      "X-Api-Key": "key-123456",
      "Content-Type": "application/json"
    });

    expect(headers.Authorization).toBe(REDACTED);
    expect(headers.Cookie).toBe(REDACTED);
    expect(headers["Set-Cookie"]).toBe(REDACTED);
    expect(headers["X-Api-Key"]).toBe(REDACTED);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("masks secrets embedded in free text without destroying the surrounding message", () => {
    const output = redactText(
      'Request failed: authorization: Bearer eyJhbGciOi.J9payload.signature01 password="hunter2-secret" status=500'
    );

    expect(output).toContain("Request failed");
    expect(output).toContain("status=500");
    expect(output).not.toContain("hunter2-secret");
    expect(output).not.toContain("eyJhbGciOi");
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("masks the credential that follows an authentication scheme", () => {
    expect(redactText("authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redactText("Cookie: sid=abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redactText("x-api-key=abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  });

  it("masks provider tokens that appear without a key name", () => {
    expect(redactText("token ghp_0123456789abcdefghij leaked")).toBe(`token ${REDACTED} leaked`);
    expect(redactText("using sk-0123456789abcdefghij here")).toBe(`using ${REDACTED} here`);
  });

  it("redacts nested structures by key and by value", () => {
    const redacted = redactValue({
      request: {
        url: "https://api.example.com/orders",
        headers: { authorization: "Bearer abcdefghijklmnop", accept: "application/json" }
      },
      response: { body: { user: "ana", accessToken: "abc123", note: "cookie: sid=abc123def456" } },
      durationMs: 120
    }) as {
      request: { url: string; headers: Record<string, string> };
      response: { body: Record<string, string> };
      durationMs: number;
    };

    expect(redacted.request.url).toBe("https://api.example.com/orders");
    expect(redacted.request.headers.authorization).toBe(REDACTED);
    expect(redacted.request.headers.accept).toBe("application/json");
    expect(redacted.response.body.accessToken).toBe(REDACTED);
    expect(redacted.response.body.user).toBe("ana");
    expect(redacted.response.body.note).not.toContain("sid=abc123def456");
    expect(redacted.durationMs).toBe(120);
  });

  it("recognises sensitive key names independently of casing and separators", () => {
    expect(isSensitiveKey("Set-Cookie")).toBe(true);
    expect(isSensitiveKey("refresh_token")).toBe(true);
    expect(isSensitiveKey("durationMs")).toBe(false);
  });
});
