/** Publicly safe workflow lifecycle failures. Cause details never cross this boundary. */
export class WorkflowRunError extends Error {
  public constructor(
    readonly code: "not_found" | "invalid_state" | "parent_unavailable" | "authorization_failed" | "cancelled" | "execution_failed",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRunError";
  }
}

export function publicWorkflowError(error: unknown): WorkflowRunError {
  if (error instanceof WorkflowRunError) return error;
  return new WorkflowRunError("execution_failed", publicFailureSummary(error).summary);
}

export interface WorkflowFailureExplanation {
  readonly category: string;
  readonly code: string;
  readonly summary: string;
}

// Only fixed, actionable explanations cross the public boundary. Raw exception
// messages may contain model prompts, credentials, chapter text and local paths.
const failures: Readonly<Record<string, readonly [string, string]>> = {
  EPERM: ["storage", "存储操作被系统拒绝，请检查目录权限、文件占用或安全软件拦截。"],
  EACCES: ["storage", "无法访问存储目录，请检查目录权限。"],
  ENOSPC: ["storage", "磁盘空间不足，请释放空间后重试。"],
  EROFS: ["storage", "存储位置为只读，请改用可写目录。"],
  ENOENT: ["storage", "所需文件或目录不存在，请检查作品存储位置和运行时安装是否完整。"],
  EIO: ["storage", "磁盘读写失败，请检查磁盘及外接存储连接。"],
  EMFILE: ["storage", "打开的文件过多，请关闭其他任务后重试。"],
  ENFILE: ["storage", "系统打开的文件过多，请关闭其他程序后重试。"],
  SQLITE_BUSY: ["storage", "工作流数据库正忙，请关闭重复运行的应用后稍后重试。"],
  SQLITE_LOCKED: ["storage", "工作流数据库被占用，请关闭重复运行的应用后稍后重试。"],
  SQLITE_CORRUPT: ["storage", "工作流数据库校验失败，请保留现有数据并联系支持排查。"],
  ETIMEDOUT: ["network", "连接超时，请检查网络或模型服务状态后重试。"],
  UND_ERR_CONNECT_TIMEOUT: ["network", "连接超时，请检查网络或模型服务状态后重试。"],
  ECONNREFUSED: ["network", "服务连接失败，请检查网络、代理和服务地址。"],
  ECONNRESET: ["network", "服务连接中断，请检查网络后重试。"],
  ENOTFOUND: ["network", "无法解析服务地址，请检查网络和服务地址。"],
  EAI_AGAIN: ["network", "服务地址解析暂时失败，请检查网络后稍后重试。"],
  HTTP_401: ["model", "模型服务认证失败，请检查登录状态或 API 密钥。"],
  HTTP_403: ["model", "无权访问模型服务，请检查账号权限和模型配置。"],
  HTTP_429: ["model", "模型请求过于频繁或额度不足，请稍后重试并检查可用额度。"],
  HTTP_5XX: ["model", "模型服务暂时不可用，请稍后重试。"],
  parent_agent_unavailable: ["parent", "发起任务的对话会话暂不可用；请回到原对话，恢复会话后继续。"],
  structured_output_invalid: ["schema", "模型回复格式不符合工作流要求，请重试当前任务或检查模型配置。"],
  worker_resource_integrity: ["execution", "章节工作模型资源校验失败，请检查运行时安装是否完整。"],
  unregistered_worker: ["execution", "所需工作模型未注册或版本不匹配，请检查运行时安装是否完整。"],
  worker_artifact_persistence: ["storage", "模型结果已生成但未能安全保存，请检查目录权限和磁盘空间。"],
  worker_model_error: ["model", "模型调用未完成，请检查模型配置、账号额度和网络连接。"],
  target_conflict: ["conflict", "目标章节或章节目录已变化，请核对当前作品和章节后重新发起任务。"],
  proposal_conflict: ["conflict", "待写入内容与当前章节版本冲突，请先核对正文。"],
  revision_conflict: ["conflict", "章节正文版本已变化，请先核对当前正文再继续。"],
  verification_failed: ["domain", "写入后的正文回读校验未通过，请先检查章节正文，避免重复写入。"],
  memory_evidence_invalid: ["domain", "记忆保存依据校验失败，请先核对章节正文，再继续记忆保存。"],
  memory_revision_conflict: ["conflict", "章节版本与记忆保存依据不一致，请先核对正文。"],
  workflow_write_required: ["execution", "写作模型未完成要求的正文保存，请核对章节后继续任务。"],
  workflow_write_runtime_unavailable: ["execution", "章节写入能力暂不可用，请检查运行时状态后继续任务。"],
};

/** Bounded and cycle-safe: inspect nested causes without exposing raw values. */
export function publicFailureSummary(error: unknown): WorkflowFailureExplanation {
  const seen = new Set<unknown>();
  let cursor = error;
  let fallback: string | undefined;
  const explain = (code: string): WorkflowFailureExplanation => {
    const [category, message] = failures[code]!;
    // Internal symbolic codes stay in persistence; public diagnostics use a
    // stable label that cannot be mistaken for an artifact or prompt payload.
    const label = /^[A-Z0-9_]+$/.test(code) ? code : `WF-${category.toUpperCase()}`;
    return { category, code, summary: `${message}（${label}）` };
  };
  for (let depth = 0; depth < 8 && typeof cursor === "object" && cursor !== null && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    const value = cursor as { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown; name?: unknown };
    const code = typeof value.code === "string" ? value.code : "";
    if (Object.hasOwn(failures, code)) {
      if (/^[A-Z0-9_]+$/.test(code)) return explain(code);
      fallback ??= code;
    }
    const status = value.status ?? value.statusCode;
    if ([401, 403, 429].includes(Number(status))) return explain(`HTTP_${status}`);
    if (typeof status === "number" && status >= 500 && status <= 599) return explain("HTTP_5XX");
    if (value.name === "TimeoutError") return explain("ETIMEDOUT");
    cursor = value.cause;
  }
  return fallback ? explain(fallback) : {
    category: "execution", code: "node_failed",
    summary: "工作流遇到未识别异常，当前步骤未完成。请保留任务记录，核对章节后重试；若重复出现，请提供失败步骤和应用版本以便排查。（WF-UNKNOWN）",
  };
}

/** Internal scheduler signal: apply committed, so cancellation may only leave a memory tail. */
export class WorkflowMemoryPending extends Error {
  public constructor() {
    super("Applied chapter still requires memory finalization");
    this.name = "WorkflowMemoryPending";
  }
}

/** Internal scheduler signal: a durable pause intent was observed at a node boundary. */
export class WorkflowPauseRequested extends Error {
  public constructor() {
    super("Workflow pause requested");
    this.name = "WorkflowPauseRequested";
  }
}
