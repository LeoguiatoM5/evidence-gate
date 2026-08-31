import { describe, expect, it } from "vitest";
import { handleQuote } from "../../src/api/quote-handler.js";

describe("POST /quote", () => {
  it("@critical returns 422 with a reason when the payment is refused", () => {
    const response = handleQuote({
      body: { amountCents: 60_000, dailySpentCents: 0, tier: "STANDARD" }
    });

    expect(response.status).toBe(422);
    expect(response.body.allowed).toBe(false);
    expect(response.body.reason).toBe("SINGLE_PAYMENT_TOO_LARGE");
  });

  it("returns 200 and the remaining allowance when the payment is accepted", () => {
    const response = handleQuote({
      body: { amountCents: 20_000, dailySpentCents: 30_000, tier: "STANDARD" }
    });

    expect(response.status).toBe(200);
    expect(response.body.remainingCents).toBe(150_000);
  });

  it("rejects an unknown tier instead of falling back to a default", () => {
    const response = handleQuote({
      body: { amountCents: 100, dailySpentCents: 0, tier: "GOLD" }
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("UNKNOWN_TIER");
  });

  it("rejects a body that is not an object", () => {
    expect(handleQuote({ body: "nope" }).status).toBe(400);
  });
});
