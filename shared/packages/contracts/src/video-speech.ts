import { z } from "zod";
import { StableId } from "./work.ts";

export const SpeechProviderConfig = z.object({
  baseUrl: z.string().url().max(2048).refine((value) => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  }, "语音 API 地址必须为不含凭据、查询参数和片段的 HTTPS 地址"),
  model: z.string().trim().min(1).max(512), voice: z.string().trim().min(1).max(256),
  speed: z.number().finite().min(0.25).max(4).optional(),
  credentialRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
}).strict();
export type SpeechProviderConfig = z.infer<typeof SpeechProviderConfig>;
export const SpeechSettings = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), speech: SpeechProviderConfig.nullable() }).strict();
export type SpeechSettings = z.infer<typeof SpeechSettings>;
export const SpeechSettingsView = z.object({ settings: SpeechSettings, keyConfigured: z.boolean() }).strict();
export type SpeechSettingsView = z.infer<typeof SpeechSettingsView>;
export const SaveSpeechSettingsInput = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), speech: SpeechProviderConfig.nullable(), apiKey: z.string().max(16_384).optional(),
}).strict();
export type SaveSpeechSettingsInput = z.infer<typeof SaveSpeechSettingsInput>;
export const SpeechText = z.string().trim().min(1, "配音文本不能为空").max(4096, "单次配音最多 4096 个字符，请手动缩短或分段生成");
export const GenerateSpeechInput = z.object({
  workId: StableId, episodeId: StableId, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  text: SpeechText.optional(), voice: z.string().trim().min(1).max(256).optional(),
}).strict();
export type GenerateSpeechInput = z.infer<typeof GenerateSpeechInput>;
