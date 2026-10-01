import { z } from "zod";
import { MediaProviderConfig, MediaExecutionMode } from "./media.ts";
import { StoredMediaLibrary, MediaProtocol } from "./media-library.ts";

export const SavedMediaConnection = z.object({
  id: z.string().min(1).max(128), kind: z.enum(["image", "video"]), config: MediaProviderConfig,
}).strict();

export const MediaSettings = z.object({
  revision: z.number().int().nonnegative(),
  library: StoredMediaLibrary.optional(),
  connections: z.array(SavedMediaConnection).optional(),
  image: MediaProviderConfig.nullable(),
  video: MediaProviderConfig.nullable(),
}).strict();
export type MediaSettings = z.infer<typeof MediaSettings>;
export const MediaCredits = z.object({
  available: z.number().nonnegative(), reserved: z.number().nonnegative(),
  credentialRef: z.string().min(1).max(128),
}).strict();
export type MediaCredits = z.infer<typeof MediaCredits>;
export const MediaSettingsView = z.object({
  settings: MediaSettings,
  mediaCredits: MediaCredits.optional(),
  hostedNotice: z.string().optional(),
  connections: z.array(SavedMediaConnection.extend({ isDefault: z.boolean(), keyConfigured: z.boolean(), billing: z.object({ creditsPerUnit: z.number().nonnegative(), unit: z.string() }).optional() })).optional(),
  keyConfigured: z.object({ image: z.boolean(), video: z.boolean() }).strict(),
}).strict();
export type MediaSettingsView = z.infer<typeof MediaSettingsView>;
export const SaveMediaSettingsInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  image: MediaProviderConfig.nullable(),
  video: MediaProviderConfig.nullable(),
  apiKeys: z.object({ image: z.string().max(16_384).optional(), video: z.string().max(16_384).optional() }).strict().optional(),
}).strict();
export type SaveMediaSettingsInput = z.infer<typeof SaveMediaSettingsInput>;

export const SaveMediaConnectionInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  kind: z.enum(["image", "video"]),
  connectionId: z.string().min(1).max(128).optional(),
  create: z.boolean().optional(),
  connection: z.object({
    baseUrl: z.string().trim().url().max(2048),
    model: z.string().trim().min(1).max(512),
    protocol: z.union([z.literal("auto"), MediaProtocol]).optional(),
    executionMode: MediaExecutionMode.optional(),
    options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }).strict().nullable(),
  apiKey: z.string().max(16384).optional(),
}).strict().refine(value => !(value.create && value.connectionId) && (!(value.create || value.connectionId) || value.connection !== null), { message: "新增或编辑模型需要提供连接配置，且不能同时指定新增和模型 ID。" });
export type SaveMediaConnectionInput = z.infer<typeof SaveMediaConnectionInput>;

export const ManageMediaConnectionInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  id: z.string().min(1).max(128),
  action: z.enum(["set-default", "remove"]),
}).strict();
export type ManageMediaConnectionInput = z.infer<typeof ManageMediaConnectionInput>;
