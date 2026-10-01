import type { AccountTokenVault, AccountTokens } from "@jizuo/account-domain";
import { nspoxReasoningEfforts, type NspoxReasoningEfforts } from "./nspox-reasoning.ts";

export const NSPOX_ACCESS_TOKEN_REF = "JIZUO_NSPOX_ACCESS_TOKEN";
export const NSPOX_REFRESH_TOKEN_REF = "JIZUO_NSPOX_REFRESH_TOKEN";
export const NSPOX_EXPIRES_AT_REF = "JIZUO_NSPOX_EXPIRES_AT";
const PI_AI_SETTINGS_NAMESPACE = "llm-pi-ai";

interface CredentialStore {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

interface SettingsStore {
  get?(namespace: string): unknown;
  snapshot?(namespace: string): { value: unknown; revision: number } | undefined;
  mutate(
    namespace: string,
    operations: Array<
      | { op: "set"; path: readonly string[]; value: unknown }
      | { op: "unset"; path: readonly string[] }
    >,
    expectedRevision?: number,
  ): Promise<void>;
}

interface AgentDefaultModelStore {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string };
  saveSelection(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>;
}

export interface HostedModel {
  id: string;
  displayName: string;
  enabled: boolean;
}

export interface HostedModelRuntime {
  sync(models: HostedModel[]): Promise<void>;
  select(modelId: string): Promise<void>;
  clear(): Promise<void>;
}

export class HarnessAccountTokenVault implements AccountTokenVault {
  constructor(private readonly credentials: CredentialStore) {}

  async get(): Promise<AccountTokens | undefined> {
    const [access, refresh, expiry] = await Promise.all([
      this.credentials.resolve(NSPOX_ACCESS_TOKEN_REF),
      this.credentials.resolve(NSPOX_REFRESH_TOKEN_REF),
      this.credentials.resolve(NSPOX_EXPIRES_AT_REF),
    ]);
    if (access === undefined && expiry === undefined) return undefined;
    const expiresAt = Number(expiry?.value);
    if (
      access === undefined
      || access.value.trim() === ""
      || !Number.isSafeInteger(expiresAt)
      || expiresAt <= 0
    ) {
      await this.clear();
      return undefined;
    }
    return {
      accessToken: access.value,
      expiresAt,
      ...(refresh === undefined || refresh.value.trim() === ""
        ? {}
        : { refreshToken: refresh.value }),
    };
  }

  async set(tokens: AccountTokens): Promise<void> {
    await this.credentials.set(NSPOX_ACCESS_TOKEN_REF, tokens.accessToken);
    if (tokens.refreshToken === undefined || tokens.refreshToken === "") {
      await this.credentials.unset(NSPOX_REFRESH_TOKEN_REF);
    } else {
      await this.credentials.set(NSPOX_REFRESH_TOKEN_REF, tokens.refreshToken);
    }
    await this.credentials.set(NSPOX_EXPIRES_AT_REF, String(tokens.expiresAt));
  }

  async clear(): Promise<void> {
    await Promise.all([
      this.credentials.unset(NSPOX_ACCESS_TOKEN_REF),
      this.credentials.unset(NSPOX_REFRESH_TOKEN_REF),
      this.credentials.unset(NSPOX_EXPIRES_AT_REF),
    ]);
  }
}

function uniqueEnabledModels(models: HostedModel[]): HostedModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.enabled || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

export class HarnessHostedModelRuntime implements HostedModelRuntime {
  private availableModelIds = new Set<string>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly agentDefaultModel: AgentDefaultModelStore,
  ) {}

  async sync(models: HostedModel[]): Promise<void> {
    const enabled = uniqueEnabledModels(models);
    this.availableModelIds = new Set(enabled.map((model) => model.id));
    if (enabled.length === 0) {
      await this.clear();
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = this.settings.snapshot?.(PI_AI_SETTINGS_NAMESPACE);
      const current = (snapshot?.value ?? this.settings.get?.(PI_AI_SETTINGS_NAMESPACE)) as {
        providers?: { nspox?: { models?: Array<{ id: string; maxTokens?: number; reasoningEfforts?: NspoxReasoningEfforts }> } };
      } | undefined;
      const savedModels = new Map((current?.providers?.nspox?.models ?? []).map((model) => [model.id, model]));
      const operations = [{
        op: "set" as const,
        path: ["providers", "nspox"],
        value: {
          displayName: "NSPOX",
          apiKeyEnv: NSPOX_ACCESS_TOKEN_REF,
          api: "openai-completions",
          baseURL: "https://www.nspox.com/v1",
          models: enabled.map((model) => {
            const saved = savedModels.get(model.id);
            const maxTokens = saved?.maxTokens;
            const reasoningEfforts = saved?.reasoningEfforts ?? nspoxReasoningEfforts(model.id);
            return { id: model.id, name: model.displayName,
              ...(typeof maxTokens === "number" && Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
              ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
            };
          }),
        },
      }];
      try {
        if (snapshot) await this.settings.mutate(PI_AI_SETTINGS_NAMESPACE, operations, snapshot.revision);
        else await this.settings.mutate(PI_AI_SETTINGS_NAMESPACE, operations);
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "SETTINGS_CONFLICT" || attempt === 2) throw error;
      }
    }
    const selected = this.agentDefaultModel.currentSelection();
    if (selected.provider !== "nspox" || !this.availableModelIds.has(selected.model)) {
      await this.agentDefaultModel.saveSelection({
        provider: "nspox",
        model: enabled[0]!.id,
      });
    }
  }

  async select(modelId: string): Promise<void> {
    if (!this.availableModelIds.has(modelId)) {
      throw new Error("当前 NSPOX 模型目录中不存在该模型");
    }
    const current = this.agentDefaultModel.currentSelection();
    await this.agentDefaultModel.saveSelection({ provider: "nspox", model: modelId,
      ...(current.provider === "nspox" && current.model === modelId && current.reasoningEffort !== undefined
        ? { reasoningEffort: current.reasoningEffort } : {}),
    });
  }

  async clear(): Promise<void> {
    this.availableModelIds.clear();
    await this.settings.mutate(PI_AI_SETTINGS_NAMESPACE, [{
      op: "unset",
      path: ["providers", "nspox"],
    }]);
  }
}
