import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { JizuoError } from "@jizuo/contracts";
import { z } from "zod";

import {
  AccountSummary,
  type AccountTokenVault,
  type AccountTokens,
  type BrowserLoginStart,
} from "./types.ts";

const PRODUCTION_ORIGIN = "https://www.nspox.com";
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const CALLBACK_MAX_BODY_BYTES = 64 * 1024;
const LOGIN_TTL_MS = 3 * 60 * 1_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const NspoxUser = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  email: z.string().email().max(320),
  avatarUrl: z.union([z.literal(""), z.string().url()]).optional(),
  provider: z.string().trim().min(1).max(80),
// The profile API adds fields independently of desktop releases (e.g. media_credits).
// Strip unused fields while continuing to validate the account fields we consume.
}).strip();

const NspoxModels = z.object({
  object: z.literal("list"),
  data: z.array(z.object({
    id: z.string().trim().min(1).max(160),
    object: z.literal("model"),
    created: z.number().int().nonnegative(),
    owned_by: z.literal("nspox"),
    requestMultiplier: z.number().int().positive(),
    trialEnabled: z.boolean(),
  }).strict()).max(1_000),
}).strict();

const NspoxBilling = z.object({
  subscription: z.object({
    productPriceId: z.string().trim().min(1).max(160),
    planName: z.string().trim().min(1).max(160),
    periodEndAt: z.number().int().positive(),
    concurrency: z.number().int().positive().max(1_000),
  }).strict().nullable(),
  trial: z.object({
    available: z.number().int().nonnegative(),
    usable: z.boolean(),
  }).passthrough().nullable(),
  weekly: z.object({
    available: z.number().int().nonnegative(),
  }).passthrough(),
  addons: z.object({
    available: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

class MemoryTokenVault implements AccountTokenVault {
  private tokens: AccountTokens | undefined;

  async get(): Promise<AccountTokens | undefined> {
    return this.tokens === undefined ? undefined : { ...this.tokens };
  }

  async set(tokens: AccountTokens): Promise<void> {
    this.tokens = { ...tokens };
  }

  async clear(): Promise<void> {
    this.tokens = undefined;
  }
}

interface PendingLogin {
  state: string;
  callbackUrl: string;
  expiresAt: number;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  consumed: boolean;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function validateProductionUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new JizuoError("validation_error", "平台返回了无效地址");
  }
  if (
    url.origin !== PRODUCTION_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    throw new JizuoError("denied", "平台请求越过了允许的生产域名");
  }
  return url;
}

function callbackPage(succeeded: boolean): string {
  const title = succeeded ? "登录成功" : "登录失败";
  const detail = succeeded
    ? "授权结果已经安全发送给即作，可以关闭本页面并返回应用。"
    : "授权未完成，请关闭本页面并在即作中重新发起登录。";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"></head>`
    + `<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:48px;text-align:center">`
    + `<h1>${title}</h1><p>${detail}</p></body></html>`;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > CALLBACK_MAX_BODY_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    size += chunk.byteLength;
    if (size > CALLBACK_MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export class AccountGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly randomBytes: () => Uint8Array;
  private readonly maxResponseBytes: number;
  private readonly vault: AccountTokenVault;
  private pendingLogin: PendingLogin | undefined;

  constructor(options: {
    fetch?: typeof fetch;
    now?: () => number;
    randomBytes?: () => Uint8Array;
    maxResponseBytes?: number;
    vault?: AccountTokenVault;
  } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes
      ?? (() => globalThis.crypto.getRandomValues(new Uint8Array(32)));
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.vault = options.vault ?? new MemoryTokenVault();
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 128) {
      throw new JizuoError("validation_error", "平台响应大小上限无效");
    }
  }

  async beginBrowserLogin(): Promise<BrowserLoginStart> {
    this.closePendingLogin();
    const state = base64Url(this.randomBytes());
    if (!/^[A-Za-z0-9_-]{32,}$/.test(state)) {
      throw new JizuoError("internal_error", "无法生成安全的登录状态");
    }
    const expiresAt = this.now() + LOGIN_TTL_MS;
    const server = createServer((request, response) => {
      void this.handleCallback(server, request, response).catch(() => {
        if (!response.headersSent) sendHtml(response, 500, callbackPage(false));
        else response.end();
      });
    });
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    }).catch(() => {
      throw new JizuoError("runtime_unavailable", "无法启动 NSPOX 登录回调服务");
    });
    server.unref();
    const address = server.address() as AddressInfo | null;
    if (address === null || address.family === undefined || address.port <= 0) {
      server.close();
      throw new JizuoError("runtime_unavailable", "无法读取 NSPOX 登录回调地址");
    }
    const callbackUrl = new URL(`http://127.0.0.1:${address.port}/api/auth/callback`);
    callbackUrl.searchParams.set("state", state);
    callbackUrl.searchParams.set("return_url", `${PRODUCTION_ORIGIN}/`);
    const timer = setTimeout(() => {
      if (this.pendingLogin?.server === server) this.closePendingLogin();
    }, LOGIN_TTL_MS);
    timer.unref();
    this.pendingLogin = {
      state,
      callbackUrl: callbackUrl.href,
      expiresAt,
      server,
      timer,
      consumed: false,
    };

    const authorizationUrl = new URL("/authorization", PRODUCTION_ORIGIN);
    authorizationUrl.searchParams.set("login_version", "1");
    authorizationUrl.searchParams.set("auth_from", "nspox");
    authorizationUrl.searchParams.set("login_channel", "native_app");
    authorizationUrl.searchParams.set("auth_type", "local");
    authorizationUrl.searchParams.set("redirect", "0");
    authorizationUrl.searchParams.set("auth_callback_url", callbackUrl.href);
    return {
      authorizationUrl: authorizationUrl.href,
      callbackUrl: callbackUrl.href,
      state,
      expiresAt,
    };
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const accessToken = await this.requireAccessToken();
    const rawUser = await this.requestJson("/v1/me", { accessToken });
    const rawModels = await this.requestJson("/v1/models", { accessToken });
    const rawBilling = await this.requestJson("/api/billing/me/summary", { accessToken });
    const user = NspoxUser.safeParse(rawUser);
    const models = NspoxModels.safeParse(rawModels);
    const billing = NspoxBilling.safeParse(rawBilling);
    if (!user.success || !models.success || !billing.success) {
      throw new JizuoError("validation_error", "NSPOX 账号或模型响应格式无效");
    }
    const modelIds = new Set<string>();
    const modelEntitlements = models.data.data.flatMap((model) => {
      if (modelIds.has(model.id)) return [];
      modelIds.add(model.id);
      return [{ id: model.id, displayName: model.id, enabled: true }];
    });
    const quota = billing.data.subscription === null
      ? (billing.data.trial?.usable === true ? billing.data.trial.available : 0) + billing.data.addons.available
      : billing.data.weekly.available + billing.data.addons.available;
    const summary = {
      user: {
        id: user.data.id,
        displayName: user.data.name,
        email: user.data.email,
      },
      subscription: billing.data.subscription === null ? null : {
        plan: billing.data.subscription.planName,
        expiresAt: billing.data.subscription.periodEndAt * 1_000,
        concurrency: billing.data.subscription.concurrency,
      },
      remainingQuota: quota,
      modelEntitlements,
    };
    const parsed = AccountSummary.safeParse(summary);
    if (!parsed.success) throw new JizuoError("validation_error", "NSPOX 账号摘要格式无效");
    return parsed.data;
  }

  async logout(): Promise<void> {
    this.closePendingLogin();
    await this.vault.clear();
  }

  private async handleCallback(
    server: Server,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pending = this.pendingLogin;
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/api/auth/callback") {
      sendHtml(response, 404, callbackPage(false));
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendHtml(response, 405, callbackPage(false));
      return;
    }
    const contentType = (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      sendHtml(response, 415, callbackPage(false));
      return;
    }
    if (
      pending === undefined
      || pending.server !== server
      || pending.consumed
      || pending.expiresAt <= this.now()
    ) {
      sendHtml(response, 403, callbackPage(false));
      return;
    }
    const form = await readFormBody(request);
    if (form === undefined) {
      sendHtml(response, 413, callbackPage(false));
      return;
    }
    const stateValues = form.getAll("state");
    const accessValues = form.getAll("access_token");
    const refreshValues = form.getAll("refresh_token");
    const accessToken = accessValues[0]?.trim() ?? "";
    const refreshToken = refreshValues[0]?.trim() ?? "";
    if (
      stateValues.length !== 1
      || stateValues[0] !== pending.state
      || accessValues.length !== 1
      || accessToken.length < 1
      || accessToken.length > 16_384
      || refreshValues.length > 1
      || refreshToken.length > 16_384
    ) {
      sendHtml(response, 403, callbackPage(false));
      return;
    }
    pending.consumed = true;
    const tokens: AccountTokens = {
      accessToken,
      expiresAt: this.now() + SESSION_TTL_MS,
      ...(refreshToken === "" ? {} : { refreshToken }),
    };
    try {
      await this.vault.set(tokens);
    } catch {
      pending.consumed = false;
      sendHtml(response, 500, callbackPage(false));
      return;
    }
    sendHtml(response, 200, callbackPage(true));
    clearTimeout(pending.timer);
    this.pendingLogin = undefined;
    server.close();
  }

  private closePendingLogin(): void {
    const pending = this.pendingLogin;
    this.pendingLogin = undefined;
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pending.server.close();
  }

  private async requireAccessToken(): Promise<string> {
    const tokens = await this.vault.get();
    if (tokens === undefined || tokens.expiresAt <= this.now()) {
      await this.vault.clear();
      throw new JizuoError("credential_required", "请先通过浏览器登录 NSPOX 账号");
    }
    return tokens.accessToken;
  }

  private async requestJson(
    path: string,
    options: { accessToken: string },
  ): Promise<unknown> {
    const url = validateProductionUrl(new URL(path, PRODUCTION_ORIGIN).href);
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${options.accessToken}`,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers, redirect: "manual" });
    } catch {
      throw new JizuoError("runtime_unavailable", "无法连接 NSPOX 账号服务");
    }
    if (response.url !== "") validateProductionUrl(response.url);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location !== null) validateProductionUrl(new URL(location, url).href);
      throw new JizuoError("denied", "平台响应发生了未允许的重定向");
    }
    if (response.status === 401) {
      await this.vault.clear();
      throw new JizuoError("credential_required", "NSPOX 登录状态已失效");
    }
    if (!response.ok) {
      throw new JizuoError("runtime_unavailable", "NSPOX 账号服务暂时不可用", {
        status: response.status,
      });
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > this.maxResponseBytes) {
      throw new JizuoError("validation_error", "平台响应超过安全大小限制");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > this.maxResponseBytes) {
      throw new JizuoError("validation_error", "平台响应超过安全大小限制");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new JizuoError("validation_error", "平台响应不是有效 JSON");
    }
  }
}
