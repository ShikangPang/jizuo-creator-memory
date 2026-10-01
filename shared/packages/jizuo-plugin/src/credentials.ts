import { JizuoError } from "@jizuo/contracts";

export interface CredentialDescription {
  credentialRef: string;
  configured: boolean;
}

export interface LaunchCapability {
  token: string;
  requestId: string;
  expiresAt: number;
}

export interface NativeCredentialBackend {
  describe(credentialRef: string): Promise<{ configured: boolean; [key: string]: unknown }>;
  resolve(credentialRef: string): Promise<string | undefined>;
}

interface CapabilityRecord extends LaunchCapability {
  credentialRef: string;
}

const MAX_CAPABILITY_AGE_MS = 60_000;

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new JizuoError("validation_error", `${label}无效`);
  }
}

export class CredentialResolver {
  private readonly backend: NativeCredentialBackend;
  private readonly now: () => number;
  private readonly randomBytes: () => Uint8Array;
  private readonly capabilityAgeMs: number;
  private readonly capabilities = new Map<string, CapabilityRecord>();

  constructor(options: {
    backend: NativeCredentialBackend;
    now?: () => number;
    randomBytes?: () => Uint8Array;
    capabilityAgeMs?: number;
  }) {
    this.backend = options.backend;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes
      ?? (() => globalThis.crypto.getRandomValues(new Uint8Array(32)));
    this.capabilityAgeMs = options.capabilityAgeMs ?? MAX_CAPABILITY_AGE_MS;
    if (
      !Number.isSafeInteger(this.capabilityAgeMs)
      || this.capabilityAgeMs <= 0
      || this.capabilityAgeMs > MAX_CAPABILITY_AGE_MS
    ) {
      throw new JizuoError("validation_error", "凭据能力有效期必须在 60 秒以内");
    }
  }

  async describe(credentialRef: string): Promise<CredentialDescription> {
    validateIdentifier(credentialRef, "凭据标识");
    const description = await this.backend.describe(credentialRef);
    return { credentialRef, configured: description.configured === true };
  }

  issueLaunchCapability(credentialRef: string, requestId: string): LaunchCapability {
    validateIdentifier(credentialRef, "凭据标识");
    validateIdentifier(requestId, "请求标识");
    const token = Buffer.from(this.randomBytes()).toString("base64url");
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
      throw new JizuoError("internal_error", "无法生成安全的凭据能力");
    }
    const record: CapabilityRecord = {
      token,
      requestId,
      credentialRef,
      expiresAt: this.now() + this.capabilityAgeMs,
    };
    this.capabilities.set(token, record);
    return { token, requestId, expiresAt: record.expiresAt };
  }

  async resolveForRequest(
    credentialRef: string,
    capability: LaunchCapability,
  ): Promise<string> {
    validateIdentifier(credentialRef, "凭据标识");
    const record = this.capabilities.get(capability.token);
    if (record !== undefined) this.capabilities.delete(capability.token);
    if (
      record === undefined
      || record.credentialRef !== credentialRef
      || record.requestId !== capability.requestId
      || record.expiresAt !== capability.expiresAt
      || record.expiresAt <= this.now()
    ) {
      throw new JizuoError("denied", "凭据能力无效、已过期或已使用");
    }
    const value = await this.backend.resolve(credentialRef);
    if (value === undefined || value.length === 0) {
      throw new JizuoError("credential_required", "该模型凭据尚未配置");
    }
    if (value.length > 16 * 1024) {
      throw new JizuoError("validation_error", "系统凭据内容无效");
    }
    return value;
  }
}
