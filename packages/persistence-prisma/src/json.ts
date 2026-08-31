import type { Prisma } from "./generated/prisma/client";

/** Structured domain values are stored as plain JSON columns. */
export const toJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
