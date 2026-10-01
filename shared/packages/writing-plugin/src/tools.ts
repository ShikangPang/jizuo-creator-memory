import { createHash } from "node:crypto";
import { MEDIA_PROMPT_RULES } from "../../contracts/src/media-prompt-rules.generated.ts";
import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  ApplyImportInput,
  ApplyProposalInput,
  ChapterTarget,
  ControlChapterWorkflowInput,
  CreateProposalInput,
  CreateChapterRequest,
  CreateVolumeInput,
  CreateWorkInput,
  ExportWorkInput,
  JizuoError,
  PreviewImportInput,
  ReplaceChapterInput,
  StartChapterWorkflowInput,
  VolumeTarget,
  type WorkflowRunDetailProjection,
} from "@jizuo/contracts";
import type { WorkDomainService } from "@jizuo/work-domain";
import {
  MemoryEpisodeCandidate,
  MemoryQuery,
  type EpisodeCommitResult,
  type MemoryEpisodeCandidate as MemoryEpisodeCandidateInput,
  type MemoryGraph,
  type MemoryQueryInput,
} from "@jizuo/memory-domain";
import type { z } from "zod";

export interface ToolsContext {
  tools: { register: (definition: ToolDefinition) => void };
}

type JizuoToolService = WorkDomainService & {
  saveChapterMemory?: (input: {
    volumeId: string;
    candidate: MemoryEpisodeCandidateInput;
  }) => Promise<EpisodeCommitResult>;
  queryMemory?: (input: MemoryQueryInput) => Promise<MemoryGraph>;
  /** The bounded model-facing start and recovery surface for durable workflows. */
  workflowRuns?: {
    start(input: unknown, sessionId: string, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
    control?(input: unknown, sessionId: string, signal?: AbortSignal): Promise<WorkflowRunDetailProjection>;
    resumeMemory?(sessionId: string, userRequest: string, target?: import("@jizuo/contracts").ChapterTarget, signal?: AbortSignal): Promise<WorkflowRunDetailProjection | undefined>;
  };
};

export interface WorkflowChapterWriteToolPort {
  execute(sessionId: string, args: unknown): Promise<Readonly<{ status: "written" }>>;
}

const JSON_VALUE = { type: "json" } as const;
const GENERIC_REPAIR_MESSAGE = "工具参数不完整或无效，请补全目标后重试";
const WORKFLOW_TARGET_REPAIR_MESSAGE = "章节工作流目标必须是对象：create_next 需包含 mode、workId、volumeId、afterChapterId、title";
const WORKFLOW_CONTROL_REPAIR_MESSAGE = "工作流操作只能是 inspect、extend_review、resume、reconcile_apply 或 cancel；cancel 仅在用户明确要求时传 confirmCancel: true";
const CHAPTER_WORKFLOW_TARGET = {
  description: MEDIA_PROMPT_RULES["novel-tool-1"],
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      description: MEDIA_PROMPT_RULES["novel-tool-2"],
      properties: {
        mode: { type: "string", const: "modify", required: true, description: MEDIA_PROMPT_RULES["novel-tool-3"] },
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-4"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-5"] },
        chapterId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-6"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      description: MEDIA_PROMPT_RULES["novel-tool-7"],
      properties: {
        mode: { type: "string", const: "create_explicit", required: true, description: MEDIA_PROMPT_RULES["novel-tool-8"] },
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-9"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-10"] },
        title: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-11"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      description: MEDIA_PROMPT_RULES["novel-tool-12"],
      properties: {
        mode: { type: "string", const: "create_next", required: true, description: MEDIA_PROMPT_RULES["novel-tool-13"] },
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-14"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-15"] },
        afterChapterId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-16"] },
        title: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-17"] },
      },
    },
  ],
} as const;
const WorkTarget = CreateVolumeInput.pick({ workId: true });
const MEMORY_KINDS = [
  "character",
  "rule",
  "organization",
  "worldbuilding",
  "clue",
  "location",
  "object",
  "event",
  "style",
] as const;

const MEMORY_IDENTITIES = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-18"] },
      name: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-19"] },
      kind: { type: "string", required: true, enum: MEMORY_KINDS, description: MEDIA_PROMPT_RULES["novel-tool-20"] },
      aliases: { type: "array", items: { type: "string" }, description: MEDIA_PROMPT_RULES["novel-tool-21"] },
      evidenceIds: { type: "array", required: true, items: { type: "string" }, description: MEDIA_PROMPT_RULES["novel-tool-22"] },
    },
  },
} as const;

const MEMORY_STATES = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-23"] },
      identityId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-24"] },
      chapterNumber: { type: "integer", required: true, description: MEDIA_PROMPT_RULES["novel-tool-25"] },
      key: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-26"] },
      value: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-27"] },
      confirmed: { type: "boolean", required: true, description: MEDIA_PROMPT_RULES["novel-tool-28"] },
      evidenceIds: { type: "array", required: true, items: { type: "string" }, description: MEDIA_PROMPT_RULES["novel-tool-29"] },
    },
  },
} as const;

const MEMORY_EDGES = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-30"] },
      from: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-31"] },
      to: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-32"] },
      type: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-33"] },
      chapterNumber: { type: "integer", required: true, description: MEDIA_PROMPT_RULES["novel-tool-34"] },
      evidenceId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-35"] },
      confirmed: { type: "boolean", required: true, description: MEDIA_PROMPT_RULES["novel-tool-36"] },
    },
  },
} as const;

const MEMORY_EVIDENCE = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-37"] },
      chapterId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-38"] },
      chapterNumber: { type: "integer", required: true, description: MEDIA_PROMPT_RULES["novel-tool-39"] },
      excerpt: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-40"] },
      contentHash: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-41"] },
    },
  },
} as const;

function asJson(value: unknown): never {
  return JSON.parse(JSON.stringify(value)) as never;
}

function present(title: string) {
  return {
    schema: JSON_VALUE,
    render: (_args: unknown, value: unknown) => [{
      type: "text" as const,
      text: `${title}: ${JSON.stringify(value)}`,
    }],
  };
}

const WORKFLOW_WRITE_OUTPUT = {
  schema: JSON_VALUE,
  render: () => [{ type: "text" as const, text: "章节已写入" }],
};

function parseOrRepair<T>(
  schema: z.ZodType<T>,
  value: unknown,
  required: string[],
  message = GENERIC_REPAIR_MESSAGE,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new JizuoError(
    "model_repair",
    message,
    { required, cause: parsed.error.flatten() },
  );
}

function withRepairableArgs(
  definition: ToolDefinition,
  required: string[],
  message = GENERIC_REPAIR_MESSAGE,
): ToolDefinition {
  return {
    ...definition,
    async execute(args, exec) {
      try {
        return await definition.execute(args, exec);
      } catch (error) {
        if (error instanceof ToolArgsError) {
          throw new JizuoError(
            "model_repair",
            message,
            { required, cause: error.violations },
          );
        }
        throw error;
      }
    },
  };
}

const ROOT_ONLY_WRITE_TOOLS = new Set([
  "jizuo_create_work",
  "jizuo_create_volume",
  "jizuo_create_chapter",
  "jizuo_save_chapter",
  "jizuo_propose_chapter_change",
  "jizuo_apply_chapter_change",
  "jizuo_apply_import",
  "jizuo_export_work",
  "jizuo_save_chapter_memory",
  "jizuo_start_chapter_workflow",
  "jizuo_control_chapter_workflow",
]);

function workflowControlResult(run: WorkflowRunDetailProjection) {
  return {
    status: run.status,
    currentGroup: run.currentGroup,
    totalGroups: run.totalGroups,
    revision: run.revision,
    availableActions: run.availableActions ?? [],
    ...(run.draftRetained === true ? { draftRetained: true } : {}),
    steps: run.steps.map((step) => ({
      key: step.key,
      label: step.label,
      status: step.status,
      attempt: step.attempt,
      ...(step.warning === true ? { warning: true } : {}),
      ...(step.summary === undefined ? {} : { summary: step.summary }),
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
    })),
  };
}

function delegationDepth(exec: Parameters<ToolDefinition["execute"]>[1]): number {
  const agent = exec.agent;
  if (agent === undefined) return 0;

  const runtimeDepth = (agent.options as { subagentDepth?: unknown }).subagentDepth;
  const header = agent.session.header as {
    origin?: unknown;
    delegationDepth?: unknown;
  };
  const depths = [runtimeDepth, header.delegationDepth]
    .filter((value): value is number => Number.isSafeInteger(value) && Number(value) >= 0);

  if (header.origin === "subagent" && depths.length === 0) return 1;
  return depths.length === 0 ? 0 : Math.max(...depths);
}

function withRootOnlyWriteAccess(definition: ToolDefinition): ToolDefinition {
  if (!ROOT_ONLY_WRITE_TOOLS.has(definition.name)) return definition;

  return {
    ...definition,
    async execute(args, exec) {
      const depth = delegationDepth(exec);
      if (depth > 0) {
        throw new JizuoError(
          "denied",
          "子代理只能读取或提出修改建议，正文写入必须由主代理执行",
          { tool: definition.name, delegationDepth: depth },
        );
      }
      return definition.execute(args, exec);
    },
  };
}

async function assertWorkflowTargetReadable(
  service: Pick<JizuoToolService, "listVolumes" | "listChapters" | "readChapter">,
  target: ReturnType<typeof StartChapterWorkflowInput.parse>["target"],
): Promise<void> {
  const volumes = await service.listVolumes(target.workId);
  if (!volumes.some((volume) => volume.id === target.volumeId)) {
    throw new JizuoError("validation_error", "目标分卷不存在", { volumeId: target.volumeId });
  }
  if (target.mode === "modify") {
    await service.readChapter(target);
    return;
  }
  if (target.mode === "create_next") {
    const chapters = await service.listChapters({ workId: target.workId, volumeId: target.volumeId });
    if (chapters.at(-1)?.id !== target.afterChapterId) {
      throw new JizuoError("revision_conflict", "追加章节的锚点已变化，请重新选择最后一章", {
        afterChapterId: target.afterChapterId,
      });
    }
  }
}

function parentSessionId(exec: Parameters<ToolDefinition["execute"]>[1]): string {
  const sessionId = (exec.agent?.session as { id?: unknown } | undefined)?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new JizuoError("runtime_unavailable", "章节工作流只能从当前主会话启动");
  }
  return sessionId;
}

function childSessionId(exec: Parameters<ToolDefinition["execute"]>[1]): string {
  const sessionId = (exec.agent?.session as { id?: unknown } | undefined)?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0 || delegationDepth(exec) < 1) {
    throw new JizuoError("denied", "工作流章节写入工具只能由当前受权写作子代理调用");
  }
  return sessionId;
}

export function registerJizuoTools(
  ctx: ToolsContext,
  service: JizuoToolService,
  workflowChapterWrites?: WorkflowChapterWriteToolPort,
  scope: "all" | "writing" | "memory" = "all",
): void {
  const definitions: ToolDefinition[] = [
    defineTool({
      name: "jizuo_create_work",
      description: MEDIA_PROMPT_RULES["novel-tool-42"],
      parameters: {
        title: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-43"] },
      },
      output: present("作品已创建"),
      execute: async (args) => asJson(await service.createWork(parseOrRepair(CreateWorkInput, args, ["title"]))),
    }),
    defineTool({
      name: "jizuo_list_works",
      description: MEDIA_PROMPT_RULES["novel-tool-44"],
      parameters: {},
      output: present("作品列表"),
      isConcurrencySafe: () => true,
      execute: async () => asJson({ works: await service.listWorks() }),
    }),
    defineTool({
      name: "jizuo_create_volume",
      description: MEDIA_PROMPT_RULES["novel-tool-45"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-46"] },
        title: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-47"] },
      },
      output: present("分卷已创建"),
      execute: async (args) => asJson(await service.createVolume(parseOrRepair(
        CreateVolumeInput,
        args,
        ["workId", "title"],
      ))),
    }),
    defineTool({
      name: "jizuo_list_volumes",
      description: MEDIA_PROMPT_RULES["novel-tool-48"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-49"] },
      },
      output: present("分卷列表"),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const { workId } = parseOrRepair(WorkTarget, args, ["workId"]);
        return asJson({ volumes: await service.listVolumes(workId) });
      },
    }),
    defineTool({
      name: "jizuo_list_chapters",
      description: MEDIA_PROMPT_RULES["novel-tool-50"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-51"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-52"] },
      },
      output: present("章节列表"),
      isConcurrencySafe: () => true,
      execute: async (args) => asJson({
        chapters: await service.listChapters(parseOrRepair(VolumeTarget, args, ["workId", "volumeId"])),
      }),
    }),
    defineTool({
      name: "jizuo_read_chapter",
      description: MEDIA_PROMPT_RULES["novel-tool-53"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-54"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-55"] },
        chapterId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-56"] },
      },
      output: present("章节内容"),
      isConcurrencySafe: () => true,
      execute: async (args) => asJson(await service.readChapter(parseOrRepair(
        ChapterTarget,
        args,
        ["workId", "volumeId", "chapterId"],
      ))),
    }),
    defineTool({
      name: "jizuo_create_chapter",
      description: MEDIA_PROMPT_RULES["novel-tool-57"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-58"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-59"] },
        title: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-60"] },
        content: { type: "string", description: MEDIA_PROMPT_RULES["novel-tool-61"] },
        plan: { type: "string", description: MEDIA_PROMPT_RULES["novel-tool-62"] },
        detailedOutline: { type: "string", description: MEDIA_PROMPT_RULES["novel-tool-63"] },
        mode: { type: "string", description: MEDIA_PROMPT_RULES["novel-tool-64"] },
        afterChapterId: { type: "string", description: MEDIA_PROMPT_RULES["novel-tool-65"] },
      },
      output: present("章节已创建"),
      execute: async (args) => asJson(await service.createChapter(parseOrRepair(
        CreateChapterRequest,
        args,
        ["workId", "volumeId", "title"],
      ))),
    }),
    defineTool({
      name: "jizuo_save_chapter",
      description: MEDIA_PROMPT_RULES["novel-tool-110"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-111"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-112"] },
        chapterId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-113"] },
        content: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-114"] },
        expectedRevision: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-115"] },
      },
      output: present("章节正文已保存"),
      execute: async (args, exec) => {
        const sessionId = parentSessionId(exec);
        const input = parseOrRepair(ReplaceChapterInput.omit({ editSessionId: true }).strict(), args, ["workId", "volumeId", "chapterId", "content", "expectedRevision"]);
        exec.signal.throwIfAborted();
        const current = await service.readChapter(input);
        // A lost response may be retried after the same content was committed.
        if (current.content === input.content) return asJson(current);
        exec.signal.throwIfAborted();
        const editSessionId = `edit_${createHash("sha256").update(JSON.stringify([sessionId, exec.callId, input.chapterId, input.expectedRevision])).digest("hex")}`;
        await service.replaceChapter({ ...input, editSessionId });
        const saved = await service.readChapter(input);
        if (saved.content !== input.content) throw new JizuoError("revision_conflict", "保存后章节已有新修改，请重新读取，不要重复覆盖");
        return asJson(saved);
      },
    }),
    defineTool({
      name: "jizuo_list_chapter_proposals",
      description: MEDIA_PROMPT_RULES["novel-tool-116"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-111"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-112"] },
        chapterId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-113"] },
      },
      output: present("已保存的章节提案"),
      isConcurrencySafe: () => true,
      execute: async (args) => asJson({ proposals: await service.listProposals(parseOrRepair(ChapterTarget, args, ["workId", "volumeId", "chapterId"])) }),
    }),
    defineTool({
      name: "jizuo_propose_chapter_change",
      description: MEDIA_PROMPT_RULES["novel-tool-66"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-67"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-68"] },
        chapterId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-69"] },
        nextContent: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-70"] },
        expectedRevision: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-71"] },
      },
      output: present("章节改写提案"),
      execute: async (args) => asJson(await service.createProposal(parseOrRepair(
        CreateProposalInput,
        args,
        ["workId", "volumeId", "chapterId", "expectedRevision"],
      ))),
    }),
    defineTool({
      name: "jizuo_apply_chapter_change",
      description: MEDIA_PROMPT_RULES["novel-tool-72"],
      parameters: {
        proposalId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-73"] },
        token: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-74"] },
      },
      output: present("章节提案已应用"),
      execute: async (args) => asJson(await service.applyProposal(parseOrRepair(
        ApplyProposalInput,
        args,
        ["proposalId", "token"],
      ))),
    }),
    defineTool({
      name: "jizuo_preview_import",
      description: MEDIA_PROMPT_RULES["novel-tool-75"],
      parameters: {
        sourcePath: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-76"] },
        format: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-77"] },
      },
      output: present("导入预览"),
      isConcurrencySafe: () => true,
      execute: async (args) => asJson(await service.previewImport(parseOrRepair(
        PreviewImportInput,
        args,
        ["sourcePath", "format"],
      ))),
    }),
    defineTool({
      name: "jizuo_apply_import",
      description: MEDIA_PROMPT_RULES["novel-tool-78"],
      parameters: {
        sourcePath: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-79"] },
        format: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-80"] },
        previewHash: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-81"] },
        workTitle: { type: "string", description: MEDIA_PROMPT_RULES["novel-tool-82"] },
      },
      output: present("作品已导入"),
      execute: async (args) => asJson(await service.applyImport(parseOrRepair(
        ApplyImportInput,
        args,
        ["sourcePath", "format", "previewHash"],
      ))),
    }),
    defineTool({
      name: "jizuo_export_work",
      description: MEDIA_PROMPT_RULES["novel-tool-83"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-84"] },
        format: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-85"] },
        destination: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-86"] },
      },
      output: present("作品已导出"),
      execute: async (args) => asJson(await service.exportWork(parseOrRepair(
        ExportWorkInput,
        args,
        ["workId", "format", "destination"],
      ))),
    }),
    defineTool({
      name: "jizuo_save_chapter_memory",
      description: MEDIA_PROMPT_RULES["novel-tool-87"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-88"] },
        volumeId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-89"] },
        chapterId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-90"] },
        chapterNumber: { type: "integer", required: true, description: MEDIA_PROMPT_RULES["novel-tool-91"] },
        contentHash: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-92"] },
        confirmation: { type: "string", required: true, enum: ["confirmed", "suggested"], description: MEDIA_PROMPT_RULES["novel-tool-93"] },
        identities: { ...MEMORY_IDENTITIES, required: true },
        states: { ...MEMORY_STATES, required: true },
        edges: { ...MEMORY_EDGES, required: true },
        evidence: { ...MEMORY_EVIDENCE, required: true },
      },
      output: { schema: JSON_VALUE, render: (_args, value) => [{ type: "text", text:
        value && typeof value === "object" && "status" in value && value.status === "workflow_resumed"
          ? "原任务记忆步骤已恢复，正文不会重写；保存结果请查看原任务进度。"
          : `章节记忆已保存: ${JSON.stringify(value)}`,
      }] },
      execute: async (args, exec) => {
        if (service.workflowRuns?.resumeMemory && exec.agent) {
          exec.signal.throwIfAborted();
          const target = parseOrRepair(ChapterTarget, { workId: args.workId, volumeId: args.volumeId, chapterId: args.chapterId }, ["workId", "volumeId", "chapterId"]);
          const resumed = await service.workflowRuns.resumeMemory(parentSessionId(exec), "继续保存记忆", target, exec.signal);
          if (resumed) return asJson({ status: "workflow_resumed", runId: resumed.runId });
        }
        if (service.saveChapterMemory === undefined) {
          throw new JizuoError("runtime_unavailable", "记忆写入服务尚未连接");
        }
        const candidate = parseOrRepair(MemoryEpisodeCandidate, {
          workId: args.workId,
          chapterId: args.chapterId,
          chapterNumber: args.chapterNumber,
          contentHash: args.contentHash,
          source: "chapter",
          confirmation: args.confirmation,
          identities: args.identities,
          states: args.states,
          edges: args.edges,
          evidence: args.evidence,
        }, ["workId", "volumeId", "chapterId", "chapterNumber", "contentHash", "confirmation", "evidence"]);
        return asJson(await service.saveChapterMemory({ volumeId: args.volumeId, candidate }));
      },
    }),
    defineTool({
      name: "jizuo_query_memory",
      description: MEDIA_PROMPT_RULES["novel-tool-94"],
      parameters: {
        workId: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-95"] },
        mode: {
          type: "string",
          required: true,
          enum: ["chapter", "range_strict", "range_with_prior", "current", "entity_timeline", "multi_entity_relationships"],
          description: MEDIA_PROMPT_RULES["novel-tool-96"],
        },
        chapter: { type: "integer", description: MEDIA_PROMPT_RULES["novel-tool-97"] },
        from: { type: "integer", description: MEDIA_PROMPT_RULES["novel-tool-98"] },
        to: { type: "integer", description: MEDIA_PROMPT_RULES["novel-tool-99"] },
        identities: { type: "array", items: { type: "string" }, description: MEDIA_PROMPT_RULES["novel-tool-100"] },
      },
      output: present("记忆宫殿查询结果"),
      isConcurrencySafe: () => true,
      execute: async (args) => {
        if (service.queryMemory === undefined) {
          throw new JizuoError("runtime_unavailable", "记忆服务尚未连接");
        }
        return asJson(await service.queryMemory(parseOrRepair(MemoryQuery, args, ["workId", "mode"])));
      },
    }),
  ];

  if (service.workflowRuns !== undefined) {
    definitions.push(defineTool({
      name: "jizuo_start_chapter_workflow",
      description: MEDIA_PROMPT_RULES["novel-tool-101"],
      parameters: {
        target: { ...CHAPTER_WORKFLOW_TARGET, required: true },
        userRequest: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-102"] },
      },
      output: present("章节工作流已启动"),
      execute: async (args, exec) => {
        const request = parseOrRepair(
          StartChapterWorkflowInput,
          args,
          ["target", "userRequest"],
          WORKFLOW_TARGET_REPAIR_MESSAGE,
        );
        exec.signal.throwIfAborted();
        await assertWorkflowTargetReadable(service, request.target);
        exec.signal.throwIfAborted();
        return asJson(await service.workflowRuns!.start(request, parentSessionId(exec), exec.signal));
      },
    }));
    if (service.workflowRuns.control !== undefined) {
      definitions.push(defineTool({
        name: "jizuo_control_chapter_workflow",
        description: MEDIA_PROMPT_RULES["novel-tool-103"],
        parameters: {
          action: {
            type: "string",
            required: true,
            enum: ["inspect", "extend_review", "resume", "reconcile_apply", "cancel"],
            description: MEDIA_PROMPT_RULES["novel-tool-104"],
          },
          confirmCancel: {
            type: "boolean",
            description: MEDIA_PROMPT_RULES["novel-tool-105"],
          },
        },
        output: present("章节工作流"),
        execute: async (args, exec) => {
          const request = parseOrRepair(
            ControlChapterWorkflowInput,
            args,
            ["action"],
            WORKFLOW_CONTROL_REPAIR_MESSAGE,
          );
          exec.signal.throwIfAborted();
          const result = await service.workflowRuns!.control!(request, parentSessionId(exec), exec.signal);
          return asJson(workflowControlResult(result));
        },
      }));
    }
  }

  if (workflowChapterWrites !== undefined) {
    definitions.push(defineTool({
      name: "jizuo_workflow_write_chapter",
      description: MEDIA_PROMPT_RULES["novel-tool-106"],
      parameters: {
        content: { type: "string", required: true, description: MEDIA_PROMPT_RULES["novel-tool-107"] },
        plan: { type: "string", description: MEDIA_PROMPT_RULES["novel-tool-108"] },
        detailedOutline: { type: "string", description: MEDIA_PROMPT_RULES["novel-tool-109"] },
      },
      output: WORKFLOW_WRITE_OUTPUT,
      execute: async (args, exec) => asJson(await workflowChapterWrites.execute(childSessionId(exec), args)),
    }));
  }

  const requiredByTool: Record<string, string[]> = {
    jizuo_create_work: ["title"],
    jizuo_list_works: [],
    jizuo_create_volume: ["workId", "title"],
    jizuo_list_volumes: ["workId"],
    jizuo_list_chapters: ["workId", "volumeId"],
    jizuo_read_chapter: ["workId", "volumeId", "chapterId"],
    jizuo_create_chapter: ["workId", "volumeId", "title"],
    jizuo_list_chapter_proposals: ["workId", "volumeId", "chapterId"],
    jizuo_save_chapter: ["workId", "volumeId", "chapterId", "content", "expectedRevision"],
    jizuo_propose_chapter_change: ["workId", "volumeId", "chapterId", "expectedRevision"],
    jizuo_apply_chapter_change: ["proposalId", "token"],
    jizuo_preview_import: ["sourcePath", "format"],
    jizuo_apply_import: ["sourcePath", "format", "previewHash"],
    jizuo_export_work: ["workId", "format", "destination"],
    jizuo_save_chapter_memory: ["workId", "volumeId", "chapterId", "chapterNumber", "contentHash", "confirmation", "identities", "states", "edges", "evidence"],
    jizuo_query_memory: ["workId", "mode"],
    jizuo_start_chapter_workflow: ["target", "userRequest"],
    jizuo_control_chapter_workflow: ["action"],
    jizuo_workflow_write_chapter: ["content"],
  };

  definitions.forEach((definition) => {
    const memory = definition.name === "jizuo_query_memory" || definition.name === "jizuo_save_chapter_memory";
    if (scope !== "all" && (scope === "memory") !== memory) return;
    ctx.tools.register(withRepairableArgs(
      withRootOnlyWriteAccess(definition),
      requiredByTool[definition.name] ?? [],
      definition.name === "jizuo_start_chapter_workflow"
        ? WORKFLOW_TARGET_REPAIR_MESSAGE
        : definition.name === "jizuo_control_chapter_workflow"
          ? WORKFLOW_CONTROL_REPAIR_MESSAGE
          : undefined,
    ));
  });
}
