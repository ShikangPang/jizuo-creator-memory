import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { JizuoError } from "@jizuo/contracts";
import { z } from "zod";

const CredentialRef = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

const ByokSettings = z.object({
  endpoint: z.string().url().superRefine((raw, context) => {
    const endpoint = new URL(raw);
    const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
    if (
      (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback.has(endpoint.hostname)))
      || endpoint.username !== ""
      || endpoint.password !== ""
      || endpoint.hash !== ""
    ) {
      context.addIssue({ code: "custom", message: "远程模型必须使用 HTTPS" });
    }
  }),
  model: z.string().trim().min(1).max(240),
  credentialRef: CredentialRef,
}).strict();

export const ModelSettings = z.object({
  selectedHostedModelId: z.string().trim().min(1).max(160).nullable(),
  byok: ByokSettings.nullable(),
}).strict();

export type ModelSettings = z.infer<typeof ModelSettings>;
export type ByokSettings = z.infer<typeof ByokSettings>;

const DEFAULT_SETTINGS: ModelSettings = {
  selectedHostedModelId: null,
  byok: null,
};

export class ModelSettingsRepository {
  private readonly settingsRoot: string;

  constructor(settingsRoot: string) {
    this.settingsRoot = settingsRoot;
  }

  async read(): Promise<ModelSettings> {
    try {
      const parsed = ModelSettings.safeParse(JSON.parse(
        await readFile(join(this.settingsRoot, "model-settings.json"), "utf8"),
      ));
      if (!parsed.success) throw new JizuoError("validation_error", "模型设置文件格式无效");
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
      if (error instanceof JizuoError) throw error;
      throw new JizuoError("internal_error", "模型设置读取失败");
    }
  }

  async write(settings: ModelSettings): Promise<void> {
    const parsed = ModelSettings.safeParse(settings);
    if (!parsed.success) throw new JizuoError("validation_error", "模型设置无效");
    await mkdir(this.settingsRoot, { recursive: true, mode: 0o700 });
    const destination = join(this.settingsRoot, "model-settings.json");
    const temporary = join(this.settingsRoot, `.model-settings.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, destination);
    } catch {
      throw new JizuoError("internal_error", "模型设置保存失败");
    }
  }
}
