import { createHash } from "node:crypto";
import { z } from "zod";
import type { AccountTokenVault } from "@jizuo/account-domain";
import type { MediaCredits, MediaSettingsView } from "../../../contracts/src/media-settings.ts";

export const NSPOX_MEDIA_REF_PREFIX = "nspox_media_";
export type HostedMediaConnection = NonNullable<MediaSettingsView["connections"]>[number];
export interface HostedMediaDirectory { list(): Promise<HostedMediaConnection[]>; getCredits?(): Promise<MediaCredits | undefined> }
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const Catalog = z.object({ object: z.literal("list"), data: z.array(z.object({
  id: z.string().trim().min(1).max(512), modality: z.enum(["image", "video"]),
  billing: z.object({ type: z.string(), unit: z.string(), credits_per_unit: z.number().nonnegative() }).optional(),
})).max(1000) });

/** Account-scoped references let frozen jobs use refreshed tokens without crossing accounts. */
export class NspoxMediaClient implements HostedMediaDirectory {
  private readonly referenceCache = new Map<string, { id: string; url: string; expires_at: number }>();
  private readonly uploads = new Map<string, Promise<string>>();
  private identity: { token: string; ref: string; checkedAt: number } | undefined;
  constructor(private readonly vault: Pick<AccountTokenVault, "get">, private readonly fetcher: typeof fetch = fetch) {}

  private async json(path: string, token: string, body?: FormData): Promise<unknown> {
    const assetRequest = path.startsWith("/v1/media/assets");
    try {
      const response = await this.fetcher(`https://www.nspox.com${path}`, {
        ...(body ? { method: "POST", body } : {}),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        if (path.startsWith("/v1/media/assets")) throw new Error([404, 501, 503].includes(response.status)
          ? "NSPOX 平台参考图上传尚未可用，请启用平台素材存储后重试，或切换支持本地参考图的模型。"
          : response.status === 401 ? "NSPOX 登录已失效，请重新登录后上传参考图。"
          : `NSPOX 参考图上传或链接刷新失败（HTTP ${response.status}），请检查图片大小和平台存储状态。`);
        throw new Error();
      }
      if (assetRequest && response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
        await response.body?.cancel();
        throw new Error("NSPOX 参考图上传接口返回了网页，请检查平台上传路由是否已启用；尚未提交图片或视频生成。");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error(assetRequest ? "NSPOX 参考图接口返回空响应，请检查平台素材服务。" : undefined);
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 1_048_576) throw new Error(assetRequest ? "NSPOX 参考图接口响应过大，请检查平台素材服务。" : undefined);
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const text = Buffer.concat(chunks).toString("utf8");
      try { return JSON.parse(text); }
      catch {
        if (assetRequest) throw new Error(/^\s*</.test(text)
          ? "NSPOX 参考图上传接口返回了网页，请检查平台上传路由是否已启用；尚未提交图片或视频生成。"
          : "NSPOX 参考图接口响应不是有效 JSON，请检查平台素材服务；尚未提交图片或视频生成。");
        throw new Error();
      }
    } catch (cause) {
      if (assetRequest) throw new Error(cause instanceof Error && cause.message.startsWith("NSPOX") ? cause.message
        : cause instanceof Error && cause.name === "TimeoutError" ? "NSPOX 参考图上传超时，请检查网络或缩小图片后重试；尚未提交图片或视频生成。"
        : "NSPOX 参考图上传连接失败，请检查网络后重试；尚未提交图片或视频生成。");
      throw new Error("NSPOX 媒体模型暂时无法加载，请检查网络或重新登录后刷新。");
    }
  }

  private async session() {
    const tokens = await this.vault.get();
    if (!tokens || tokens.expiresAt <= Date.now()) { this.identity = undefined; return undefined; }
    const token = tokens.accessToken;
    if (!this.identity || this.identity.token !== token || Date.now() - this.identity.checkedAt > 60_000) {
      this.identity = undefined;
      const user = z.object({ id: z.string().min(1).max(160) }).safeParse(await this.json("/v1/me", token));
      if (!user.success) throw new Error("NSPOX 账号信息无效，请重新登录。");
      this.identity = { token, ref: `${NSPOX_MEDIA_REF_PREFIX}${digest(user.data.id)}`, checkedAt: Date.now() };
    }
    const ref = this.identity.ref;
    // Logout or account switching during the request must not expose the previous session.
    const current = await this.vault.get();
    if (current?.accessToken !== token || current.expiresAt <= Date.now()) return undefined;
    return { token, ref };
  }

  async resolveCredential(ref: string): Promise<string | undefined> {
    if (!ref.startsWith(NSPOX_MEDIA_REF_PREFIX)) return undefined;
    const session = await this.session();
    return session?.ref === ref ? session.token : undefined;
  }

  async getCredits(): Promise<MediaCredits | undefined> {
    const session = await this.session();
    if (!session) return undefined;
    const profile = z.object({ id: z.string().min(1).max(160), mediaCredits: z.unknown().optional(), media_credits: z.unknown().optional() }).safeParse(await this.json("/v1/me", session.token));
    if (!profile.success || `${NSPOX_MEDIA_REF_PREFIX}${digest(profile.data.id)}` !== session.ref) return undefined;
    const parsed = z.object({ available: z.number().nonnegative(), reserved: z.number().nonnegative() }).safeParse(profile.data.mediaCredits ?? profile.data.media_credits);
    const current = await this.vault.get();
    if (!parsed.success || current?.accessToken !== session.token || current.expiresAt <= Date.now()) return undefined;
    return { ...parsed.data, credentialRef: session.ref };
  }

  /** Upload only on explicit generation; cached URLs belong to the signed-in account. */
  async uploadReference(ref: string, bytes: Uint8Array, mimeType: string): Promise<string> {
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType) || !bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("NSPOX 参考图需要不超过 10 MB 的 PNG、JPEG 或 WebP 图片。");
    const session = await this.session();
    if (!session || session.ref !== ref) throw new Error("请登录选择该模型时使用的 NSPOX 账号后上传参考图。");
    const key = `${ref}:${createHash("sha256").update(bytes).digest("hex")}`;
    const pending = this.uploads.get(key); if (pending) return pending;
    const operation = (async () => {
      const cached = this.referenceCache.get(key);
      if (cached && cached.expires_at * 1000 > Date.now() + 120_000) return cached.url;
      let response: unknown;
      if (cached) {
        try { response = await this.json(`/v1/media/assets/${encodeURIComponent(cached.id)}`, session.token); }
        catch (cause) { this.referenceCache.delete(key); throw cause; }
      } else {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), `reference.${mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]}`);
        response = await this.json("/v1/media/assets", session.token, form);
      }
      const parsed = z.object({ data: z.object({ id: z.string().min(1).max(160), url: z.string().url().max(8192).refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }), expires_at: z.number().int().positive() }) }).safeParse(response);
      if (!parsed.success || parsed.data.data.expires_at * 1000 <= Date.now() + 120_000) throw new Error("NSPOX 参考图链接格式无效或即将过期，请重试上传。");
      const current = await this.vault.get();
      if (current?.accessToken !== session.token || current.expiresAt <= Date.now()) throw new Error("NSPOX 账号已切换，请在当前账号下重新生成。");
      this.referenceCache.set(key, parsed.data.data); return parsed.data.data.url;
    })();
    this.uploads.set(key, operation);
    try { return await operation; } finally { this.uploads.delete(key); }
  }

  async list(): Promise<HostedMediaConnection[]> {
    const session = await this.session();
    if (!session) return [];
    const parsed = Catalog.safeParse(await this.json("/api/router/v1/media/models", session.token));
    if (!parsed.success) throw new Error("NSPOX 媒体模型目录格式无效，请稍后刷新。");
    const current = await this.vault.get();
    if (current?.accessToken !== session.token || current.expiresAt <= Date.now()) return [];
    const seen = new Set<string>();
    return parsed.data.data.flatMap(model => {
      const id = `nspox-${digest(`${session.ref}:${model.modality}:${model.id}`)}`;
      if (seen.has(id)) return []; seen.add(id);
      return [{ id, kind: model.modality, config: { protocol: "nspox" as const, baseUrl: "https://www.nspox.com/v1", model: model.id, credentialRef: session.ref, executionMode: "async" as const },
        isDefault: false, keyConfigured: true,
        ...(model.billing?.type === "media_credits" ? { billing: { creditsPerUnit: model.billing.credits_per_unit, unit: model.billing.unit } } : {}),
      }];
    });
  }
}
