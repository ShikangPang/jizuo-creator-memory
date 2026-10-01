import { credentialKey, credentialRef, isCredentialKeySegment, isCredentialRefName, type CredentialProvider } from "@deepseek-ai/dsh-credentials";
import type { LlmRuntime, LlmConfigurableProvider } from "@deepseek-ai/dsh-llm";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
import type { NativeMediaProvider } from "./media-library.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const at = (value: unknown, path: readonly string[]) => path.reduce<unknown>((current, key) => record(current)[key], value);
const origins: Record<string, { preset: "openai" | "ark" | "dashscope"; baseUrl: string }> = {
  "https://api.openai.com": { preset: "openai", baseUrl: "https://api.openai.com/v1" },
  "https://ark.cn-beijing.volces.com": { preset: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  "https://dashscope.aliyuncs.com": { preset: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/api/v1" },
  "https://dashscope-intl.aliyuncs.com": { preset: "dashscope", baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1" },
};

/** Share only configured API-key routes whose media endpoint is known. Text protocol compatibility alone is insufficient. */
export class HarnessNativeMediaProviders {
  constructor(private readonly llm: Pick<LlmRuntime, "listConfigurableProviders">,
    private readonly settings: Pick<SettingsForms, "describe">,
    private readonly credentials: Pick<CredentialProvider, "resolve" | "readRecord">) {}

  private candidates() {
    const documents = this.settings.describe();
    return this.llm.listConfigurableProviders().flatMap(route => {
      if (route.settingsNs !== "llm-pi-ai") return [];
      const profile = record(at(documents.find(item => item.ns === route.settingsNs)?.value, route.settingsPath));
      const raw = profile.baseURL ?? (route.provider === "openai" && route.declared === false ? "https://api.openai.com/v1" : undefined);
      if (typeof raw !== "string") return [];
      let url: URL; try { url = new URL(raw); } catch { return []; }
      const preset = origins[url.origin];
      if (!preset || url.username || url.password || url.search || url.hash) return [];
      return [{route, profile, preset}];
    });
  }
  private async key(route: LlmConfigurableProvider, profile: Record<string, unknown>): Promise<string | undefined> {
    if (typeof profile.apiKeyEnv === "string") {
      if (!isCredentialRefName(profile.apiKeyEnv)) return undefined;
      return (await this.credentials.resolve(credentialRef(profile.apiKeyEnv)))?.value;
    }
    if (!isCredentialKeySegment(route.provider)) return undefined;
    const stored = await this.credentials.readRecord(credentialKey("llm-pi-ai", route.provider));
    return stored?.kind === "api-key" && typeof stored.key === "string" && stored.key.trim() ? stored.key : undefined;
  }
  async list(): Promise<NativeMediaProvider[]> {
    const candidates = this.candidates();
    const rows = await Promise.all(candidates.map(async ({route, profile, preset}) => {
      const key = await this.key(route, profile);
      if (!key && Object.keys(profile).length === 0) return undefined;
      return {id:`text:${route.provider}`,name:route.displayName,preset:preset.preset,protocol:preset.preset,baseUrl:preset.baseUrl,keyConfigured:Boolean(key)};
    }));
    return rows.filter((row): row is NonNullable<typeof row> => row !== undefined);
  }
  async resolve(id: string): Promise<string | undefined> {
    const candidate = this.candidates().find(item => `text:${item.route.provider}` === id);
    return candidate ? this.key(candidate.route, candidate.profile) : undefined;
  }
}
