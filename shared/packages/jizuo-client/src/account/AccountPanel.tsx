import { ErrorText } from "../ui/ErrorText.tsx";
import { userErrorMessage } from "@jizuo/contracts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import { useEffect, useState } from "react";

import type { ModelSettingsRemote } from "./ModelSettings.tsx";
import "./account.css";

export interface AccountSummaryView {
  user: { id: string; displayName: string; email: string };
  subscription: { plan: string; expiresAt: number; concurrency: number } | null;
  remainingQuota: number;
  modelEntitlements: Array<{ id: string; displayName: string; enabled: boolean }>;
}

export type AccountPanelState =
  | { kind: "signed-out" }
  | { kind: "authorizing" }
  | { kind: "signed-in"; summary: AccountSummaryView }
  | { kind: "expired" }
  | { kind: "offline"; summary?: AccountSummaryView }
  | { kind: "error"; message: string; code?: string };

export interface AccountRemote {
  getState(): Promise<AccountPanelState>;
  beginBrowserLogin(): Promise<{ authorizationUrl: string }>;
  openExternal(url: string): Promise<void>;
  logout(): Promise<void>;
  modelSettings?: ModelSettingsRemote;
}

function authorizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.origin !== "https://www.nspox.com") throw new Error("登录地址未通过安全校验");
  return url.href;
}

function SubscriptionLink({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href="https://www.nspox.com/account/subscription"
      target="_blank"
      rel="noreferrer"
      className="jz-account-subscription-link"
      title={compact ? "开通订阅" : "管理订阅"}
      aria-label={compact ? "前往 NSPOX 订阅" : "前往 NSPOX 查看订阅"}
    >
      <ActionIcon name="settings" />
      <span>{compact ? "开通订阅" : "管理订阅"}</span>
    </a>
  );
}

function formatSubscriptionExpiry(expiresAt: number | undefined): string {
  if (expiresAt === undefined) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(expiresAt);
}

export function AccountPanel({ remote }: { remote: AccountRemote }) {
  const [state, setState] = useState<AccountPanelState>({ kind: "signed-out" });
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    remote.getState().then((next) => {
      if (active) setState(next);
    }).catch((error: unknown) => {
      if (active) setState({ kind: "error", message: userErrorMessage(error, "账号信息暂时无法加载，请重试", { operation: "accountGetState", effect: "read" }) });
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [remote, retry]);

  useEffect(() => {
    if (state.kind !== "authorizing") return;
    let active = true;
    let checking = false;
    const timer = globalThis.setInterval(() => {
      if (checking) return;
      checking = true;
      remote.getState().then((next) => {
        if (active && next.kind !== "signed-out" && next.kind !== "authorizing") setState(next);
      }).catch((error: unknown) => {
        if (active) {
          setState({
            kind: "error",
            message: userErrorMessage(error, "浏览器登录确认失败", { operation: "AccountPanel" }),
          });
        }
      }).finally(() => { checking = false; });
    }, 500);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
    };
  }, [remote, state.kind]);

  const beginLogin = async () => {
    setState({ kind: "authorizing" });
    try {
      const login = await remote.beginBrowserLogin();
      await remote.openExternal(authorizeUrl(login.authorizationUrl));
    } catch (error) {
      setState({ kind: "error", message: userErrorMessage(error, "无法打开浏览器登录", { operation: "AccountPanel" }) });
    }
  };

  const logout = async () => {
    try {
      await remote.logout();
      setState({ kind: "signed-out" });
    } catch (error) {
      setState({ kind: "error", message: userErrorMessage(error, "退出账号失败", { operation: "AccountPanel" }) });
    }
  };

  const summary = "summary" in state ? state.summary : undefined;
  const availableModels = summary?.modelEntitlements.filter((model) => model.enabled) ?? [];
  const avatarText = Array.from(summary?.user.displayName.trim() || "即作").slice(0, 2).join("").toLocaleUpperCase();

  return (
    <section className="jz-account-panel" aria-label="账号设置" aria-busy={loading}>
      <header>
        <div>
          <h2>账号</h2>
          <p>管理登录、订阅和可用额度</p>
        </div>
        <span className={`jz-account-state is-${state.kind}`}>
          {loading ? "正在读取" : {
            "signed-out": "未登录",
            authorizing: "等待浏览器确认",
            "signed-in": "已登录",
            expired: "登录已过期",
            offline: "离线",
            error: "需要处理",
          }[state.kind]}
        </span>
      </header>

      {(state.kind === "signed-out" || state.kind === "expired" || state.kind === "authorizing") && (
        <div className="jz-account-login">
          <p>账号与订阅由 NSPOX 网站管理。即作只通过系统浏览器完成一次性授权。</p>
          <button type="button" disabled={loading || state.kind === "authorizing"} onClick={() => { void beginLogin(); }}><ActionIcon name="login" /><span>{state.kind === "authorizing" ? "等待浏览器确认" : "使用浏览器登录"}</span></button>
        </div>
      )}

      {summary !== undefined && (
        <div className="jz-account-summary" role="region" aria-label="账号概览">
          <div className="jz-account-profile">
            <div className="jz-account-avatar" aria-hidden="true">{avatarText}</div>
            <div className="jz-account-identity">
              <strong>{summary.user.displayName}</strong>
              <span>{summary.user.email}</span>
            </div>
            <div className="jz-account-plan">
              <span>当前订阅</span>
              <strong>{summary.subscription?.plan ?? "未订阅"}</strong>
            </div>
          </div>
          <dl className="jz-account-metrics">
            <div><dt>剩余额度</dt><dd>{summary.remainingQuota.toLocaleString("en-US")}</dd></div>
            <div><dt>可用模型</dt><dd>{availableModels.length}</dd></div>
            <div><dt>有效期至</dt><dd>{formatSubscriptionExpiry(summary.subscription?.expiresAt)}</dd></div>
          </dl>
          <section className="jz-account-models" aria-label="可用模型">
            <div className="jz-account-section-heading">
              <h3>创作模型</h3>
              <p>当前账号可用的模型，可在对话中选择使用。</p>
            </div>
            {availableModels.length > 0 ? (
              <ul>{availableModels.map((model) => <li key={model.id}><span>{model.displayName}</span><span className="jz-account-model-status">可用</span></li>)}</ul>
            ) : <p className="jz-account-empty">暂无可用模型，可前往订阅页面查看账号权益。</p>}
          </section>
          <div className="jz-account-links" role="group" aria-label="账号操作">
            <p>订阅与额度由 NSPOX 管理</p>
            <SubscriptionLink />
            {state.kind === "signed-in" && (
              <button type="button" onClick={() => { void logout(); }}><ActionIcon name="logout" /><span>退出账号</span></button>
            )}
          </div>
        </div>
      )}

      {state.kind === "offline" && <p className="jz-account-notice">当前离线，展示上次同步的只读账号状态。</p>}
      {state.kind === "error" && (
        <div className="jz-account-error" role="alert">
          <p><ErrorText error={state} operation="accountGetState" effect="read" /></p>
          <button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>重试</button>
          {state.code === "subscription_required" && <SubscriptionLink compact />}
        </div>
      )}
    </section>
  );
}
