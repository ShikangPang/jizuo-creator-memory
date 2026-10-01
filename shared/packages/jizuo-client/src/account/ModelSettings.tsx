import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useState, type FormEvent } from "react";

export interface HostedModel {
  id: string;
  displayName: string;
  enabled: boolean;
}

export interface ByokSettings {
  endpoint: string;
  model: string;
  credentialRef: string;
}

export interface ModelSettingsRemote {
  getSettings(): Promise<{
    selectedHostedModelId: string | null;
    byok: ByokSettings | null;
  }>;
  selectHostedModel(modelId: string): Promise<void>;
  describeCredential(credentialRef: string): Promise<{ configured: boolean; [key: string]: unknown }>;
  setCredential(credentialRef: string, value: string): Promise<unknown>;
  deleteCredential(credentialRef: string): Promise<unknown>;
  saveByok(settings: ByokSettings): Promise<void>;
}

const DEFAULT_CREDENTIAL_REF = "cred_byok_default";

export function validateByokEndpoint(rawEndpoint: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error("模型地址无效");
  }
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback.has(endpoint.hostname)))
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.hash !== ""
  ) {
    throw new Error("远程模型必须使用 HTTPS；HTTP 仅允许本机回环地址");
  }
  return endpoint.href.replace(/\/$/, "");
}

export function ModelSettings({
  remote,
  hostedModels,
}: {
  remote: ModelSettingsRemote;
  hostedModels: HostedModel[];
}) {
  const enabledModels = hostedModels.filter((model) => model.enabled);
  const [hostedModelId, setHostedModelId] = useState("");
  const [endpoint, setEndpoint] = useState("https://");
  const [model, setModel] = useState("");
  const [credentialRef, setCredentialRef] = useState(DEFAULT_CREDENTIAL_REF);
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    remote.getSettings().then(async (settings) => {
      const nextCredentialRef = settings.byok?.credentialRef ?? DEFAULT_CREDENTIAL_REF;
      const description = await remote.describeCredential(nextCredentialRef);
      if (!active) return;
      setHostedModelId(settings.selectedHostedModelId ?? enabledModels[0]?.id ?? "");
      setEndpoint(settings.byok?.endpoint ?? "https://");
      setModel(settings.byok?.model ?? "");
      setCredentialRef(nextCredentialRef);
      setConfigured(description.configured === true);
      setApiKey("");
    }).catch((error: unknown) => {
      if (active) setMessage(userErrorMessage(error, "模型设置加载失败", { operation: "ModelSettings", effect: "read" }));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [remote]);

  const saveHosted = async () => {
    if (hostedModelId === "") return;
    setBusy(true);
    setMessage(null);
    try {
      await remote.selectHostedModel(hostedModelId);
      setMessage("托管模型已选择");
    } catch (error) {
      setMessage(userErrorMessage(error, "托管模型保存失败", { operation: "ModelSettings" }));
    } finally {
      setBusy(false);
    }
  };

  const saveByok = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const next = {
        endpoint: validateByokEndpoint(endpoint.trim()),
        model: model.trim(),
        credentialRef,
      };
      if (next.model === "") throw new Error("请填写模型名称");
      if (apiKey !== "") {
        await remote.setCredential(credentialRef, apiKey);
        setConfigured(true);
      } else if (!configured) {
        throw new Error("请填写 API Key");
      }
      await remote.saveByok(next);
      setEndpoint(next.endpoint);
      setApiKey("");
      setMessage("自有模型已保存，密钥保存在系统凭据库");
    } catch (error) {
      setMessage(userErrorMessage(error, "自有模型保存失败", { operation: "ModelSettings" }));
    } finally {
      setBusy(false);
    }
  };

  const removeCredential = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await remote.deleteCredential(credentialRef);
      setConfigured(false);
      setApiKey("");
      setMessage("API Key 已从系统凭据库删除");
    } catch (error) {
      setMessage(userErrorMessage(error, "删除密钥失败", { operation: "ModelSettings" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="jz-model-settings" aria-label="模型设置" aria-busy={loading}>
      <div className="jz-model-block">
        <div>
          <h3>NSPOX 托管模型</h3>
          <p>仅显示当前账号已获得权限的模型。</p>
        </div>
        <div className="jz-model-row">
          <label>
            <span>托管模型</span>
            <select
              aria-label="托管模型"
              value={hostedModelId}
              disabled={loading || enabledModels.length === 0}
              onChange={(event) => { setHostedModelId(event.target.value); }}
            >
              {enabledModels.length === 0 && <option value="">没有可用模型</option>}
              {enabledModels.map((hosted) => (
                <option key={hosted.id} value={hosted.id}>{hosted.displayName}</option>
              ))}
            </select>
          </label>
          <IconButton icon="settings" label={"选择托管模型"} type="button" disabled={busy || hostedModelId === ""} onClick={() => { void saveHosted(); }} />
        </div>
      </div>

      <form className="jz-model-block" onSubmit={saveByok}>
        <div>
          <h3>自有 OpenAI-compatible 模型</h3>
          <p>密钥只写入系统凭据库，界面不会读取或回填明文。</p>
        </div>
        <label>
          <span>API 地址</span>
          <input
            aria-label="API 地址"
            value={endpoint}
            onChange={(event) => { setEndpoint(event.target.value); }}
            autoComplete="url"
          />
        </label>
        <label>
          <span>模型名称</span>
          <input
            aria-label="模型名称"
            value={model}
            onChange={(event) => { setModel(event.target.value); }}
            autoComplete="off"
          />
        </label>
        <label>
          <span>API Key</span>
          <input
            aria-label="API Key"
            type="password"
            value={apiKey}
            placeholder={configured ? "已安全保存，留空保持不变" : "输入后保存到系统凭据库"}
            onChange={(event) => { setApiKey(event.target.value); }}
            autoComplete="new-password"
          />
        </label>
        <div className="jz-model-actions">
          <IconButton icon="save" label={"保存自有模型"} type="submit" disabled={loading || busy} />
          {configured && (
            <IconButton icon="delete" label={"删除已存 API Key"} type="button" disabled={busy} onClick={() => { void removeCredential(); }} />
          )}
        </div>
      </form>
      {message !== null && <p className="jz-account-message" role="status">{message}</p>}
    </section>
  );
}
