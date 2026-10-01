import type { AccountPanelState, AccountRemote, ByokSettings } from "@jizuo/client";

export interface RemoteAnswer<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}

interface BrowserLoginStart {
  authorizationUrl: string;
  expiresAt: number;
}

interface ModelSettingsState {
  selectedHostedModelId: string | null;
  byok: ByokSettings | null;
}

export interface AccountHostRemote {
  accountGetState(request: Record<string, never>): Promise<RemoteAnswer<AccountPanelState>>;
  accountBeginBrowserLogin(request: Record<string, never>): Promise<RemoteAnswer<BrowserLoginStart>>;
  accountLogout(request: Record<string, never>): Promise<RemoteAnswer<{ signedOut: true }>>;
  getModelSettings(request: Record<string, never>): Promise<RemoteAnswer<ModelSettingsState>>;
  selectHostedModel(request: { modelId: string }): Promise<RemoteAnswer<{ saved: true }>>;
  saveByok(request: ByokSettings): Promise<RemoteAnswer<{ saved: true }>>;
}

export interface AccountPlatform {
  currentUrl(): string;
  openExternal(url: string): Promise<void>;
  describeCredential(credentialRef: string, controlToken: string): Promise<{ configured: boolean }>;
  setCredential(credentialRef: string, value: string, controlToken: string): Promise<unknown>;
  deleteCredential(credentialRef: string, controlToken: string): Promise<unknown>;
}

function unwrap<T>(answer: RemoteAnswer<T>, fallback: string): T {
  if (!answer.ok || answer.value === undefined) {
    const error = new Error(answer.error?.message ?? fallback) as Error & { code?: string };
    if (answer.error?.code !== undefined) error.code = answer.error.code;
    throw error;
  }
  return answer.value;
}

export function desktopControlToken(rawUrl: string): string {
  const token = new URL(rawUrl).searchParams.get("jizuo_token") ?? "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) throw new Error("桌面启动令牌无效，请重新启动即作");
  return token;
}

export function createAccountRemote(
  host: AccountHostRemote,
  platform: AccountPlatform,
): AccountRemote {
  const controlToken = () => desktopControlToken(platform.currentUrl());

  return {
    getState: async () => unwrap(await host.accountGetState({}), "账号状态加载失败"),
    beginBrowserLogin: async () => {
      const started = unwrap(
        await host.accountBeginBrowserLogin({}),
        "浏览器登录启动失败",
      );
      return { authorizationUrl: started.authorizationUrl };
    },
    openExternal: platform.openExternal,
    logout: async () => {
      unwrap(await host.accountLogout({}), "退出账号失败");
    },
    modelSettings: {
      getSettings: async () => unwrap(await host.getModelSettings({}), "模型设置加载失败"),
      selectHostedModel: async (modelId) => {
        unwrap(await host.selectHostedModel({ modelId }), "托管模型保存失败");
      },
      describeCredential: async (credentialRef) => (
        platform.describeCredential(credentialRef, controlToken())
      ),
      setCredential: async (credentialRef, value) => (
        platform.setCredential(credentialRef, value, controlToken())
      ),
      deleteCredential: async (credentialRef) => (
        platform.deleteCredential(credentialRef, controlToken())
      ),
      saveByok: async (settings) => {
        unwrap(await host.saveByok(settings), "自有模型保存失败");
      },
    },
  };
}
