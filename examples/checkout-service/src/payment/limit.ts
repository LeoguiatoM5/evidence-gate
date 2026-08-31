export type CustomerTier = "STANDARD" | "PREMIUM";

export interface PaymentRequest {
  amountCents: number;
  dailySpentCents: number;
  tier: CustomerTier;
}

export interface LimitDecision {
  allowed: boolean;
  reason: "WITHIN_LIMIT" | "DAILY_CEILING_REACHED" | "SINGLE_PAYMENT_TOO_LARGE" | "INVALID_AMOUNT";
  remainingCents: number;
}

const DAILY_CEILING_CENTS: Record<CustomerTier, number> = {
  STANDARD: 200_000,
  PREMIUM: 1_000_000
};

const SINGLE_PAYMENT_CEILING_CENTS: Record<CustomerTier, number> = {
  STANDARD: 50_000,
  PREMIUM: 300_000
};

export const evaluatePaymentLimit = (request: PaymentRequest): LimitDecision => {
  const dailyCeiling = DAILY_CEILING_CENTS[request.tier];
  const remainingCents = Math.max(0, dailyCeiling - request.dailySpentCents);

  if (!Number.isInteger(request.amountCents) || request.amountCents <= 0) {
    return { allowed: false, reason: "INVALID_AMOUNT", remainingCents };
  }
  if (request.amountCents > SINGLE_PAYMENT_CEILING_CENTS[request.tier]) {
    return { allowed: false, reason: "SINGLE_PAYMENT_TOO_LARGE", remainingCents };
  }
  if (request.amountCents > remainingCents) {
    return { allowed: false, reason: "DAILY_CEILING_REACHED", remainingCents };
  }

  return { allowed: true, reason: "WITHIN_LIMIT", remainingCents: remainingCents - request.amountCents };
};
