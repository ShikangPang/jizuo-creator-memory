import { MediaProviderConfig, type SaveMediaConnectionInput } from "@jizuo/contracts";
import { normalizeDashScopeModel } from "./dashscope-models.ts";
import { resolveMediaExecution } from "./media-execution.ts";

/** The supplied endpoint determines the protocol; model names on compatible proxies are opaque. */
export function resolveMediaConnection(input: SaveMediaConnectionInput, previous: MediaProviderConfig | null): MediaProviderConfig | null {
  if (!input.connection) return null;
  const connection = input.connection;
  MediaProviderConfig.parse({ protocol: "openai", baseUrl: connection.baseUrl, model: connection.model, credentialRef: "validation", ...(previous?.allowInsecureLoopback && previous.baseUrl === connection.baseUrl ? { allowInsecureLoopback: true } : {}) });
  const url = new URL(connection.baseUrl);
  const suppliedImageEndpoint = /\/services\/aigc\/(image-generation\/generation|multimodal-generation\/generation|text2image\/image-synthesis)\/?$/.exec(url.pathname)?.[1];
  // Accept common full generation URLs as well as base URLs, without appending an endpoint twice.
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:images\/generations|videos|contents\/generations\/tasks|services\/aigc\/(?:(?:multimodal-generation|image-generation)\/generation|text2image\/image-synthesis|video-generation\/video-synthesis))$/, "");
  const baseUrl = url.toString().replace(/\/$/, "");
  const sameAddress = previous?.baseUrl.replace(/\/$/, "") === baseUrl;
  const inferred = sameAddress ? previous.protocol
    : url.pathname.includes("/compatible-mode/") ? "openai"
    : /^(?:dashscope(?:-intl)?|cn-hongkong\.dashscope)\.aliyuncs\.com$/.test(url.hostname) || /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(url.hostname) ? "dashscope"
    : url.hostname === "ark.cn-beijing.volces.com" ? "ark"
    : ["aiart.tencentcloudapi.com", "vclm.tencentcloudapi.com"].includes(url.hostname) ? "tencent"
    : ["api-beijing.klingai.com", "api.klingai.com", "api-singapore.klingai.com"].includes(url.hostname) ? "kuaishou" : "openai";
  const protocol = connection.protocol && connection.protocol !== "auto" ? connection.protocol : inferred;
  let options = connection.options ?? {};
  // A URL edit should not require clearing invisible parameters inherited from a different adapter.
  if (previous && protocol !== previous.protocol && JSON.stringify(options) === JSON.stringify(previous.options ?? {})) options = {};
  if (protocol === "dashscope") options = { ...options, ...normalizeDashScopeModel({ id: connection.model, name: connection.model, kind: input.kind }).options };
  if (protocol === "openai" && input.kind === "video" && url.hostname === "api.openai.com") options = { videoTransport: "multipart", ...options };
  if (protocol === "kuaishou") options = { ...options, modelName: connection.model };
  const executionMode = connection.executionMode && connection.executionMode !== "auto" ? connection.executionMode
    : protocol === "dashscope" && input.kind === "image" && suppliedImageEndpoint ? (suppliedImageEndpoint === "multimodal-generation/generation" ? "sync" : "async") : connection.executionMode;
  const config = MediaProviderConfig.parse({ protocol, baseUrl, model: connection.model, credentialRef: "validation", ...(executionMode ? { executionMode } : {}), ...(Object.keys(options).length ? { options } : {}), ...(previous?.allowInsecureLoopback && sameAddress ? { allowInsecureLoopback: true } : {}) });
  resolveMediaExecution(config, input.kind);
  return config;
}
