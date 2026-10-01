import { JizuoError, MediaLibraryModel, type MediaLibraryProvider, type DiscoverMediaModelsResult } from "@jizuo/contracts";
import { normalizeDashScopeModel } from "./dashscope-models.ts";

function invalid(message: string): never { throw new JizuoError("validation_error", message); }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function endpoint(provider: MediaLibraryProvider): URL {
  const base = new URL(provider.baseUrl);
  if (base.hostname === "dashscope.aliyuncs.com") {
    if (!provider.workspaceId) invalid("请先在管理服务商中填写百炼业务空间 ID，用于获取北京地域的模型列表。");
    return new URL(`https://${provider.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/models`);
  }
  // International / Hong Kong and workspace-specific endpoints already encode their region.
  // Custom compatible services keep their configured origin; never forward their keys to Alibaba.
  return new URL(`${provider.baseUrl.replace(/\/$/, "")}/models`);
}

/** Official API: https://help.aliyun.com/zh/model-studio/list-models */
export async function discoverDashScopeModels(provider: MediaLibraryProvider, key: string, fetcher: typeof fetch, known: MediaLibraryModel[]): Promise<DiscoverMediaModelsResult> {
  const base = endpoint(provider);
  const signal = AbortSignal.timeout(30_000);
  const models = new Map<string, MediaLibraryModel>();
  let bytesRead = 0;
  for (const [kind, capability] of [["image", "IG"], ["video", "VG"]] as const) {
    const seenPages = new Set<string>();
    let pagination: { total: number; size: number } | undefined;
    for (let page = 1; ; page++) {
      if (page > 100) invalid("模型目录分页过多，请缩小服务商目录后重试。");
      const url = new URL(base);
      url.search = new URLSearchParams({ capabilities: capability, page_no: String(page), page_size: "100", language: "zh-CN" }).toString();
      let payload: Record<string, unknown>;
      try {
        const response = await fetcher(url.toString(), { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, redirect: "error", signal });
        if (!response.ok) {
          await response.body?.cancel();
          invalid("百炼模型列表获取失败，请检查业务空间 ID、地域和 API Key。");
        }
        const reader = response.body?.getReader();
        if (!reader) invalid("百炼未返回模型列表。");
        const chunks: Uint8Array[] = [];
        let pageBytes = 0;
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            pageBytes += result.value.byteLength; bytesRead += result.value.byteLength;
            if (pageBytes > 2_000_000 || bytesRead > 8_000_000) { await reader.cancel(); invalid("模型列表响应过大"); }
            chunks.push(result.value);
          }
        } finally { reader.releaseLock(); }
        payload = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        if (error instanceof JizuoError) throw error;
        invalid("百炼模型列表获取失败或响应无效，请检查连接后重试。");
      }
      if (payload.success === false || payload.code) invalid("百炼模型列表获取失败，请检查业务空间 ID、地域和 API Key。");
      const output = record(payload.output);
      const rows = output.models;
      if (!Array.isArray(rows) || !Number.isInteger(output.total) || Number(output.total) < 0 || Number(output.total) > 10000 || output.page_no !== page || !Number.isInteger(output.page_size) || Number(output.page_size) < 1 || rows.length > Number(output.page_size)) invalid("百炼模型列表或分页格式不受支持。");
      const total = Number(output.total), size = Number(output.page_size);
      if (pagination && (pagination.total !== total || pagination.size !== size)) invalid("百炼模型目录在查询时发生变化，请重试。");
      pagination = { total, size };
      if (rows.length !== Math.min(size, Math.max(0, total - (page - 1) * size))) invalid("百炼模型列表分页不完整，请重试。");
      const fingerprint = JSON.stringify(rows.map(row => record(row).model));
      if (rows.length && seenPages.has(fingerprint)) invalid("百炼重复返回同一页模型，请重试。");
      seenPages.add(fingerprint);
      for (const row of rows) {
        const entry = record(row);
        const metadata = record(entry.inference_metadata);
        // Output modality is also documented and present in responses that omit capabilities.
        const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
        const modalities = Array.isArray(metadata.response_modality) ? metadata.response_modality : [];
        if (!capabilities.includes(capability) && !modalities.includes(kind === "image" ? "Image" : "Video")) continue;
        const parsed = MediaLibraryModel.safeParse({ id: entry.model, name: entry.name || entry.model, kind });
        if (!parsed.success) invalid("百炼返回了无效的模型标识，请重试。");
        const model = parsed.data;
        const configured = [...known].reverse().find(item => item.id === model.id && item.kind === kind);
        models.set(`${kind}:${model.id}`, normalizeDashScopeModel(configured ? { ...configured, name: model.name } : model));
        if (models.size > 500) invalid("媒体模型超过当前目录的 500 个上限，未导入不完整列表。");
      }
      if (page * Number(output.page_size) >= Number(output.total)) break;
    }
  }
  const imageCount = [...models.values()].filter(model => model.kind === "image").length;
  return { models: [...models.values()], source: "remote", notice: `已从百炼获取 ${imageCount} 个图片相关模型、${models.size - imageCount} 个视频模型，请保存列表。兼容模型已自动匹配接口，检测、试衣等专用模型默认收起；生成权限以账号和地域为准。` };
}
