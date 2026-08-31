import { describe, expect, it } from "vitest";
import { evaluatePaymentLimit } from "../../src/payment/limit.js";

describe("payment limit", () => {
  it("@critical blocks a payment that exceeds the remaining daily allowance", () => {
    const decision = evaluatePaymentLimit({
      amountCents: 40_000,
      dailySpentCents: 180_000,
      tier: "STANDARD"
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("DAILY_CEILING_REACHED");
    expect(decision.remainingCents).toBe(20_000);
  });

  it("@critical rejects a single payment above the per-payment ceiling", () => {
    const decision = evaluatePaymentLimit({
      amountCents: 60_000,
      dailySpentCents: 0,
      tier: "STANDARD"
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("SINGLE_PAYMENT_TOO_LARGE");
  });

  it("approves a payment inside both ceilings and reports what is left", () => {
    const decision = evaluatePaymentLimit({
      amountCents: 30_000,
      dailySpentCents: 50_000,
      tier: "STANDARD"
    });

    expect(decision.allowed).toBe(true);
    expect(decision.remainingCents).toBe(120_000);
  });

  it("gives a premium customer the higher ceilings", () => {
    const decision = evaluatePaymentLimit({
      amountCents: 250_000,
      dailySpentCents: 100_000,
      tier: "PREMIUM"
    });

    expect(decision.allowed).toBe(true);
  });

  it("rejects a non-integer or non-positive amount", () => {
    expect(evaluatePaymentLimit({ amountCents: 0, dailySpentCents: 0, tier: "STANDARD" }).reason).toBe(
      "INVALID_AMOUNT"
    );
    expect(
      evaluatePaymentLimit({ amountCents: 10.5, dailySpentCents: 0, tier: "STANDARD" }).reason
    ).toBe("INVALID_AMOUNT");
  });
});
