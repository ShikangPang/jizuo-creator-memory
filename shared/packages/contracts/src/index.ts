export * from "./error-feedback.ts";
export * from "./errors.ts";
export * from "./redaction.ts";
export * from "./work.ts";
export * from "./workflow.ts";
import { z } from "zod";

const TokenCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ModelIdentity = z.string().trim().min(1).max(512);

export const SaveModelOutputLimit = z.object({
  provider: ModelIdentity,
  model: ModelIdentity,
  maxTokens: TokenCount.nullable(),
}).strict();
export type SaveModelOutputLimit = z.infer<typeof SaveModelOutputLimit>;

/** Public settings facts only; provider profiles and credentials never cross this boundary. */
export const ModelOutputLimit = z.object({
  provider: ModelIdentity,
  providerName: z.string(),
  model: ModelIdentity,
  modelName: z.string(),
  contextWindow: TokenCount.nullable(),
  maxTokens: TokenCount.nullable(),
  defaultMaxTokens: TokenCount.nullable(),
  configuredMaxTokens: TokenCount.nullable(),
  writable: z.boolean(),
}).strict();
export type ModelOutputLimit = z.infer<typeof ModelOutputLimit>;
export * from "./video.ts";

export * from "./media.ts";
export * from "./media-input-capabilities.ts";
export * from "./media-settings.ts";

export * from "./video-authoring.ts";

export * from "./media-operations.ts";
export * from "./asset-operations.ts";

export * from "./video-editing.ts";
export * from "./video-speech.ts";

export * from "./video-production.ts";

export * from "./media-library.ts";

export * from "./video-designs.ts";

export * from "./visual-style.ts";
export * from "./video-queries.ts";

export * from "./chat-media.ts";
