/**
 * Domain rule: no secret provided by a repository, a test run or an API response
 * may ever reach the database, an artifact, a log line or an HTTP response.
 *
 * The redaction is intentionally conservative: when a value looks like a secret it
 * is replaced, even at the cost of masking something harmless.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|password|passwd|pwd|secret|client[-_]?secret|credential|credentials|private[-_]?key|session[-_]?id|set[-_]?cookie)$/i;

/**
 * The value may carry an authentication scheme ("Bearer abc"), so the scheme and the
 * credential that follows it are consumed together; matching only the first token
 * would mask the word "Bearer" and leave the credential in place.
 */
const KEYED_VALUE_PATTERN =
  /\b(authorization|proxy-authorization|set-cookie|cookie|x-api-key|x-auth-token|x-access-token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|password|passwd|pwd|secret|client[-_]?secret|credential|private[-_]?key|session[-_]?id)\b(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic|Digest|Token)\s+[^\s,;)"'\r\n]+|[^\s,;)"'\r\n]+)/gi;

const STANDALONE_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g
];

const MAXIMUM_DEPTH = 12;

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY_PATTERN.test(key.trim());

export const redactText = (value: string): string => {
  // Standalone secrets are masked first: once a keyed value is replaced, a credential
  // that trails its key would no longer be recognisable on its own.
  let redacted = value;
  for (const pattern of STANDALONE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted.replace(
    KEYED_VALUE_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
  );
};

export const redactHeaders = (headers: Record<string, unknown>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSensitiveKey(key)
      ? REDACTED
      : redactText(typeof value === "string" ? value : JSON.stringify(value ?? null));
  }
  return result;
};

const redactUnknown = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAXIMUM_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactUnknown(entry, depth + 1);
  }
  return result;
};

/** Deep copy of `value` with every sensitive key and secret-looking string removed. */
export const redactValue = (value: unknown): unknown => redactUnknown(value, 0);
