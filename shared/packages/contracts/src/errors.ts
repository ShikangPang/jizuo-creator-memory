export const JIZUO_ERROR_CODES = [
  "validation_error",
  "model_repair",
  "denied",
  "revision_conflict",
  "credential_required",
  "subscription_required",
  "quota_exceeded",
  "runtime_unavailable",
  "transaction_recovery_required",
  "internal_error",
] as const;

export type JizuoErrorCode = (typeof JIZUO_ERROR_CODES)[number];

export interface JizuoErrorJson {
  code: JizuoErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class JizuoError extends Error {
  readonly name = "JizuoError";

  constructor(
    readonly code: JizuoErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  toJSON(): JizuoErrorJson {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}
