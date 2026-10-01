import { z } from "zod";

const Timestamp = z.number().int().nonnegative();

export const AccountSummary = z.object({
  user: z.object({
    id: z.string().trim().min(1).max(160),
    displayName: z.string().trim().min(1).max(160),
    email: z.string().email().max(320),
  }).strict(),
  subscription: z.object({
    plan: z.string().trim().min(1).max(120),
    expiresAt: Timestamp,
    concurrency: z.number().int().positive().max(1_000),
  }).strict().nullable(),
  remainingQuota: z.number().int().nonnegative(),
  modelEntitlements: z.array(z.object({
    id: z.string().trim().min(1).max(160),
    displayName: z.string().trim().min(1).max(160),
    enabled: z.boolean(),
  }).strict()).max(1_000),
}).strict();

export type AccountSummary = z.infer<typeof AccountSummary>;

export interface BrowserLoginStart {
  authorizationUrl: string;
  callbackUrl: string;
  state: string;
  expiresAt: number;
}

export interface AccountTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface AccountTokenVault {
  get(): Promise<AccountTokens | undefined>;
  set(tokens: AccountTokens): Promise<void>;
  clear(): Promise<void>;
}
