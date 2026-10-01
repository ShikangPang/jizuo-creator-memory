const REDACTED = "[REDACTED]" as const;
const MAX_DEPTH = 20;
const MAX_ITEMS = 1_000;

const SENSITIVE_KEYS = new Set([
  "authorization", "apikey", "accesskey", "accesstoken", "refreshtoken",
  "bearertoken", "controltoken", "password", "cookie", "setcookie",
  "credential", "credentialvalue", "secret", "worktext", "content",
  "prompt", "prose", "excerpt", "evidence",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function secretShaped(value: string): boolean {
  return /\bBearer\s+\S+/i.test(value) || /\bsk-[A-Za-z0-9_-]{3,}/i.test(value);
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return secretShaped(value) ? REDACTED : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
    result[key] = SENSITIVE_KEYS.has(normalizedKey(key))
      ? REDACTED
      : redact(item, depth + 1, seen);
  }
  return result;
}

export function redactDiagnostic(value: unknown): unknown {
  return redact(value, 0, new WeakSet());
}
