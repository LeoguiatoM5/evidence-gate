import { evaluatePaymentLimit, type CustomerTier } from "../payment/limit.js";

export interface QuoteRequest {
  body: unknown;
}

export interface QuoteResponse {
  status: number;
  body: Record<string, unknown>;
}

const TIERS: CustomerTier[] = ["STANDARD", "PREMIUM"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Request/response contract of POST /quote, independent of any HTTP framework. */
export const handleQuote = (request: QuoteRequest): QuoteResponse => {
  if (!isRecord(request.body)) {
    return { status: 400, body: { error: "INVALID_BODY" } };
  }

  const { amountCents, dailySpentCents, tier } = request.body;
  if (typeof amountCents !== "number" || typeof dailySpentCents !== "number") {
    return { status: 400, body: { error: "AMOUNT_REQUIRED" } };
  }
  if (typeof tier !== "string" || !TIERS.includes(tier as CustomerTier)) {
    return { status: 400, body: { error: "UNKNOWN_TIER" } };
  }

  const decision = evaluatePaymentLimit({
    amountCents,
    dailySpentCents,
    tier: tier as CustomerTier
  });

  return {
    status: decision.allowed ? 200 : 422,
    body: {
      allowed: decision.allowed,
      reason: decision.reason,
      remainingCents: decision.remainingCents
    }
  };
};
