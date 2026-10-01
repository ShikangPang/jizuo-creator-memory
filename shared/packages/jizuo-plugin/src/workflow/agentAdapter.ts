import { MEDIA_PROMPT_RULES } from "../../../contracts/src/media-prompt-rules.generated.ts";
import { createHash } from "node:crypto";

import type { Agent, AgentRegistry } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type { SubagentRun, SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import {
  ChapterCandidateOutputSchema,
  ChapterMemoryOutputSchema,
  ChapterMemoryOutputSchemaV2,
  ChapterPlanOutputSchema,
  ChapterReviewOutputSchemaV1,
  createReviewIssueFingerprint,
  defaultWorkflowRegistry,
  validateAgentRunnerRequest,
  type AgentRunnerPort,
  type AgentRunnerRequest,
  type AgentRunnerResult,
  type WorkflowRegistry,
} from "@jizuo/workflow-runtime";
import { z } from "zod";

import {
  type HarnessAgentWorkerRegistry,
  type RegisteredWorkflowWorker,
  createHarnessAgentWorkerRegistry,
} from "./agentRegistry.ts";
import { type FrozenWorkflowWorkerContext, buildFrozenPromptBlocks, freezeWorkflowWorkerContext } from "./contextBuilder.ts";
import { groundMemoryEvidence, groundTypedMemoryEvidence, MemoryExtractionEvidenceInvalid } from "./memoryEvidence.ts";
import {
  type RecoveredChapterWrite,
  type WorkflowChapterWriteCapabilityBroker,
  type WorkflowChapterWriteGrant,
} from "./writeCapability.ts";

const ArtifactHandleSchema = z.object({
  artifactRef: z.string().trim().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().nonnegative(),
}).strict();

export interface HarnessWorkerContext {
  readonly agents: Pick<AgentRegistry, "get">;
  readonly subagents: Pick<SubagentRuntime, "start">;
}

export interface WorkflowAgentConversationStream {
  /** Public text only; typed reasoning and tool/control payloads never enter here. */
  appendText(text: string): void;
  /** Settle one child answer without ending the multi-step worker stream. */
  finishText?(text?: string, interrupted?: boolean): void;
  appendTool(activity: Readonly<{
    callId: string;
    name: string;
    arguments: string;
    content: readonly ContentBlock[];
    isError: boolean;
    error?: Readonly<{ name: string; code: string }>;
    meta?: JsonValue;
  }>): void;
  complete(text: string): void;
  abort(): void;
}

export interface WorkflowAgentConversationPort {
  start(input: Readonly<{ runId: string; nodeId: string; label: string; parent: Agent }>): WorkflowAgentConversationStream;
}

const silentConversation: WorkflowAgentConversationPort = Object.freeze({
  start: () => Object.freeze({ appendText: () => {}, appendTool: () => {}, complete: () => {}, abort: () => {} }),
});

export abstract class WorkflowAgentError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** Recovery boundary: the supervisor parks the run until this exact parent session returns. */
export class ParentAgentUnavailable extends WorkflowAgentError {
  readonly code = "parent_agent_unavailable" as const;
}

export class UnregisteredWorkflowWorker extends WorkflowAgentError {
  readonly code = "unregistered_worker" as const;
}

export class WorkerModelError extends WorkflowAgentError {
  readonly code = "worker_model_error" as const;
}

export class WorkerCancelled extends WorkflowAgentError {
  readonly code = "worker_cancelled" as const;
}

/** Persistence failure must never trigger another model call. */
export class WorkerArtifactPersistenceError extends WorkflowAgentError {
  readonly code = "worker_artifact_persistence" as const;
}

export class WorkerResourceIntegrityError extends WorkflowAgentError {
  readonly code = "worker_resource_integrity" as const;
}

export class WorkflowWriteRequired extends WorkflowAgentError {
  readonly code = "workflow_write_required" as const;
}

export class WorkflowWriteRuntimeUnavailable extends WorkflowAgentError {
  readonly code = "workflow_write_runtime_unavailable" as const;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedCandidate(context: FrozenWorkflowWorkerContext) {
  const parsed = ChapterCandidateOutputSchema.safeParse(context.candidate);
  return parsed.success ? parsed.data : undefined;
}

function bounded(value: string, maximum = 4_000): string {
  const text = value.trim();
  return text.length <= maximum ? text : text.slice(0, maximum);
}

function outputText(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function firstHeadingOffset(text: string, pattern: RegExp): number | undefined {
  for (const match of text.matchAll(/^#{1,6}\s+.+$/gm)) {
    if (pattern.test(match[0])) return match.index;
  }
  return undefined;
}

function stripTrailingWorkerNotes(text: string): string {
  const marker = /\n\n---\n\n(?=(?:以上为|Here is\b|The draft\b|This is\b|本轮为))/i.exec(text);
  if (marker?.index !== undefined) return text.slice(0, marker.index).trim();
  return text.trim();
}

function finalReviewSection(text: string): string | undefined {
  const matches = [...text.matchAll(/^.*$/gm)].filter((line) =>
    reviewVerdict(line[0]) !== undefined);
  const last = matches.at(-1);
  if (last?.index === undefined) return undefined;
  return text.slice(last.index).trim();
}

function reviewControlText(text: string): string {
  return text.replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)、])[ \t]+/gm, "").replace(/\*\*|__/g, "").trim();
}

function reviewVerdict(line: string): "pass" | "revise" | undefined {
  const value = reviewControlText(line).match(/^(?:审查结论|结论|decision)\s*[:：]\s*(通过|需要修订|不通过|pass|revise)\s*[。.!！;；]?\s*$/i)?.[1];
  return value === undefined ? undefined : /^(通过|pass)$/i.test(value) ? "pass" : "revise";
}

function finalChapterText(rawText: string): string {
  const text = rawText.trim();
  const headings: RegExpMatchArray[] = [];
  let fence: string | undefined;
  for (const line of text.matchAll(/^.*$/gm)) {
    const delimiter = line[0].match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      const marker = delimiter[1]!;
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line[0].slice(delimiter[0].length).trim() === "") fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const heading = line[0].match(/^(#{1,6})[ \t]+(.+)$/);
    if (heading) { heading.index = line.index; headings.push(heading); }
  }
  const first = headings.find((heading) => /(?:第.{0,16}章|章节)/.test(heading[2]!));
  if (!first) return stripTrailingWorkerNotes(text);
  // A repeated chapter title marks a replacement draft, not an additional
  // chapter. Ignore quoted examples and empty trailing titles; keep ordinary
  // subheadings and the full last nonempty version intact.
  const repeated = headings.filter((heading) => heading[1] === first[1] && heading[2]!.trim() === first[2]!.trim());
  for (let index = repeated.length - 1; index >= 0; index -= 1) {
    const heading = repeated[index]!;
    const end = repeated[index + 1]?.index ?? text.length;
    const draft = stripTrailingWorkerNotes(text.slice(heading.index, end));
    if (draft.slice(heading[0].length).trim() !== "") return draft;
  }
  return stripTrailingWorkerNotes(text);
}

/** Normalize graph data only; public chat retains the typed public answer. */
function workflowResultText(worker: RegisteredWorkflowWorker, rawText: string): string {
  if (worker.outputSchema.id === "chapter-review.v1") return finalReviewSection(rawText) ?? rawText.trim();
  if (worker.outputSchema.id === "chapter-candidate.v1") return finalChapterText(rawText);
  if (worker.outputSchema.id === "chapter-plan.v1") {
    const start = firstHeadingOffset(rawText, /(?:策划|方案|章节)/);
    return stripTrailingWorkerNotes(start === undefined ? rawText : rawText.slice(start));
  }
  return rawText.trim();
}

function recoverableMaxTokenReview(worker: RegisteredWorkflowWorker, text: string): boolean {
  text = reviewControlText(text);
  return worker.outputSchema.id === "chapter-review.v1"
    && reviewVerdict(text.split(/\r?\n/, 1)[0]!) !== undefined
    && /^(?:评分|score)\s*[:：]\s*\d+/im.test(text)
    && /(?:原文证据|修改要求|已检查|已核对)/.test(text);
}

function planFromText(text: string) {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
  const firstLine = text.split(/\r?\n/, 1)[0]?.replace(/^\s*#{1,6}\s*/, "").trim();
  return ChapterPlanOutputSchema.parse({
    title: bounded(firstLine || "章节策划"),
    intent: bounded(text),
    beats: chunks.slice(0, 64).map((summary, index) => ({ order: index + 1, summary: bounded(summary) })),
    constraints: [],
  });
}

function reviewScore(text: string, pass: boolean): number {
  const matched = text.match(/(?:评分|score)\s*[:：]\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(100|10|1))?/i);
  if (!matched) return pass ? 1 : 0.5;
  const value = Number(matched[1]);
  const scale = Number(matched[2] ?? (value > 10 ? 100 : value > 1 ? 10 : 1));
  return Math.max(0, Math.min(1, value / scale));
}

function reviewFromText(worker: RegisteredWorkflowWorker, context: FrozenWorkflowWorkerContext, text: string) {
  const reviewKind = worker.reviewKind;
  const candidate = expectedCandidate(context);
  if (!reviewKind || !candidate) throw new Error("Review worker is missing its runtime-owned candidate binding");
  const controlText = reviewControlText(text);
  // The final explicit verdict owns the decision. Phrases such as "没有需要
  // 修订的问题" in the explanation must not turn a passing review into a veto.
  const pass = reviewVerdict(controlText.split(/\r?\n/, 1)[0]!) === "pass";
  const quotedEvidence = text.match(/(?:原文证据|证据|evidence)\s*[:：]\s*[“"]?([^\n”"]+)[”"]?/i)?.[1]?.trim();
  const evidence = quotedEvidence && candidate.content.includes(quotedEvidence)
    ? quotedEvidence
    : candidate.content.trim().slice(0, 500);
  const ruleId = reviewKind === "continuity"
    ? "continuity.world-consistency"
    : reviewKind === "style"
      ? "style.readability"
      : "ai-trace.synthetic-pattern";
  const issue = {
    issueId: `${reviewKind}-001`,
    ruleId,
    severity: "major" as const,
    evidence,
    requirement: bounded(text),
    blocking: true,
  };
  return ChapterReviewOutputSchemaV1.parse({
    reviewKind,
    candidateHash: candidate.candidateHash,
    decision: pass ? "pass" : "revise",
    score: reviewScore(controlText, pass),
    issues: pass ? [] : [{ ...issue, fingerprint: createReviewIssueFingerprint(reviewKind, issue) }],
  });
}

function memoryFromText(text: string) {
  const facts = text.split(/\r?\n/).flatMap((line) => {
    const columns = line.replace(/^\s*[-*]\s*/, "").split(/[|｜]/).map((value) => bounded(value));
    if (columns.length < 4 || columns.some((value) => value === "")) return [];
    if (/^(主体|subject)$/i.test(columns[0]!) || /^[-:：\s]+$/.test(columns.join(""))) return [];
    return [{ subject: columns[0]!, predicate: columns[1]!, object: columns[2]!, evidence: columns.slice(3).join("｜") }];
  });
  return ChapterMemoryOutputSchema.parse({ facts: facts.slice(0, 256) });
}

const memoryKindAliases = Object.freeze({
  character: "character", "人物": "character",
  rule: "rule", "规则": "rule",
  organization: "organization", "组织": "organization",
  worldbuilding: "worldbuilding", "世界观": "worldbuilding", "设定": "worldbuilding",
  clue: "clue", "线索": "clue",
  location: "location", "地点": "location",
  object: "object", "物件": "object", "物品": "object",
  event: "event", "事件": "event",
  style: "style", "文风": "style",
} as const);

function typedMemoryKind(value: string) {
  return memoryKindAliases[value.trim().toLowerCase() as keyof typeof memoryKindAliases];
}

function typedMemoryFromText(text: string) {
  const facts: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const columns = line.replace(/^\s*[-*]\s*/, "").split(/[|｜]/).map((value) => bounded(value));
    const factKind = columns[0]?.toLowerCase();
    if (factKind === "状态" || factKind === "state") {
      const kind = typedMemoryKind(columns[2] ?? "");
      if (!kind || columns.length < 6 || columns.slice(1, 5).some((value) => value === "")) continue;
      facts.push({
        factKind: "state" as const,
        subject: { name: columns[1]!, kind, aliases: [] },
        predicate: columns[3]!,
        value: columns[4]!,
        evidence: columns.slice(5).join("｜"),
      });
      continue;
    }
    if (factKind === "关系" || factKind === "relation") {
      const subjectKind = typedMemoryKind(columns[2] ?? "");
      const objectKind = typedMemoryKind(columns[5] ?? "");
      if (!subjectKind || !objectKind || columns.length < 7 || columns.slice(1, 6).some((value) => value === "")) continue;
      facts.push({
        factKind: "relation" as const,
        subject: { name: columns[1]!, kind: subjectKind, aliases: [] },
        predicate: columns[3]!,
        object: { name: columns[4]!, kind: objectKind, aliases: [] },
        evidence: columns.slice(6).join("｜"),
      });
    }
  }
  return ChapterMemoryOutputSchemaV2.parse({ facts: facts.slice(0, 256) });
}

function normalizeWorkerOutput(
  worker: RegisteredWorkflowWorker,
  context: FrozenWorkflowWorkerContext,
  text: string,
): unknown {
  if (worker.outputSchema.id === "chapter-plan.v1") return planFromText(text);
  if (worker.outputSchema.id === "chapter-candidate.v1") {
    return ChapterCandidateOutputSchema.parse({ candidateHash: hash(text), content: text });
  }
  if (worker.outputSchema.id === "chapter-review.v1") return reviewFromText(worker, context, text);
  if (worker.outputSchema.id === "chapter-memory.v1") return memoryFromText(text);
  if (worker.outputSchema.id === "chapter-memory.v2") return typedMemoryFromText(text);
  throw new Error(`Unsupported workflow worker output: ${worker.outputSchema.id}`);
}

function validateStructuredWorkerOutput(
  worker: RegisteredWorkflowWorker,
  context: FrozenWorkflowWorkerContext,
  raw: unknown,
): unknown {
  const structured = worker.outputSchema.parse(raw);
  if (worker.outputSchema.id === "chapter-candidate.v1") {
    const candidate = ChapterCandidateOutputSchema.parse(structured);
    if (hash(candidate.content) !== candidate.candidateHash) {
      throw new WorkerModelError("Harness worker returned a candidate whose content hash does not match");
    }
    return candidate;
  }
  if (worker.outputSchema.id === "chapter-plan.v1") return ChapterPlanOutputSchema.parse(structured);
  if (worker.outputSchema.id === "chapter-memory.v1") return ChapterMemoryOutputSchema.parse(structured);
  if (worker.outputSchema.id === "chapter-memory.v2") return ChapterMemoryOutputSchemaV2.parse(structured);
  if (worker.outputSchema.id === "chapter-review.v1") {
    const review = ChapterReviewOutputSchemaV1.parse(structured);
    const candidate = expectedCandidate(context);
    if (!worker.reviewKind || !candidate || review.reviewKind !== worker.reviewKind || review.candidateHash !== candidate.candidateHash) {
      throw new WorkerModelError("Harness review result does not match its frozen worker and candidate binding");
    }
    return review;
  }
  throw new WorkerModelError(`Unsupported structured workflow worker output: ${worker.outputSchema.id}`);
}

function resultFailure(result: Awaited<SubagentRun["result"]>): WorkerModelError {
  const diagnostic = typeof result.diagnostic === "string" ? `: ${result.diagnostic.slice(0, 240)}` : "";
  return new WorkerModelError(`Harness worker did not complete (${result.stopReason})${diagnostic}`);
}

function asSessionId(id: string): Parameters<AgentRegistry["get"]>[0] {
  return id as Parameters<AgentRegistry["get"]>[0];
}

function freezePrompt(blocks: readonly ContentBlock[]): ContentBlock[] {
  return Object.freeze([...blocks.map((block) => Object.freeze({ ...block }))]) as unknown as ContentBlock[];
}

const WORKFLOW_WRITE_TOOL = "jizuo_workflow_write_chapter";

type WorkflowChapterWritesPort = Pick<WorkflowChapterWriteCapabilityBroker, "grant" | "revoke" | "execute" | "takeResult" | "saveLiveDraft">;

function workflowWriteGrant(value: unknown): Omit<WorkflowChapterWriteGrant, "artifacts"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowWriteRuntimeUnavailable("Direct workflow writer has no valid internal write grant");
  }
  return value as Omit<WorkflowChapterWriteGrant, "artifacts">;
}

function toolsForRun(worker: RegisteredWorkflowWorker, direct: boolean): readonly string[] {
  if (direct) {
    if (!worker.canWrite || worker.agentId !== "novel-writer") {
      throw new WorkflowWriteRuntimeUnavailable("Direct workflow writer resource is not authorized for host persistence");
    }
  }
  return worker.tools.filter((tool) => tool !== WORKFLOW_WRITE_TOOL);
}

function hostWriteArgs(context: FrozenWorkflowWorkerContext, content: string): Readonly<{
  content: string;
  plan: string;
  detailedOutline: string;
}> {
  const parsed = ChapterPlanOutputSchema.safeParse(context.plan);
  if (!parsed.success) return Object.freeze({ content, plan: "", detailedOutline: "" });
  const plan = `# ${parsed.data.title}\n\n${parsed.data.intent}`;
  const detailedOutline = [
    ...parsed.data.beats.map((beat) => `${beat.order}. ${beat.summary}`),
    ...parsed.data.constraints.map((constraint) => `- ${constraint}`),
  ].join("\n");
  return Object.freeze({ content, plan, detailedOutline });
}

function directCandidate(write: RecoveredChapterWrite): Readonly<{ candidateHash: string; content: string }> {
  const candidate = ChapterCandidateOutputSchema.parse({ candidateHash: write.candidateHash, content: write.args.content });
  if (hash(candidate.content) !== candidate.candidateHash || write.receipt.contentHash !== candidate.candidateHash) {
    throw new WorkflowWriteRequired("Workflow write receipt does not match its completed candidate");
  }
  return candidate;
}

function createLiveDraftMirror(save: (content: string) => Promise<void>): Readonly<{
  update(content: string): void;
  settle(content: string): void;
  dispose(): void;
}> {
  let candidate = "";
  let flushed = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (candidate === "" || candidate === flushed) return;
    flushed = candidate;
    void save(candidate);
  };
  const update = (content: string) => {
    if (content.trim() === "" || content.length < candidate.length) return;
    candidate = content;
    if (flushed === "") {
      flush();
      return;
    }
    if (timer === undefined) timer = setTimeout(flush, 300);
  };
  return Object.freeze({
    update,
    settle: (content: string) => { update(content); flush(); },
    dispose: () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; },
  });
}

function mirrorChildConversation(
  agent: Agent,
  stream: WorkflowAgentConversationStream,
  signal: AbortSignal,
  liveDraft?: Readonly<{ update(content: string): void; settle(content: string): void }>,
): () => void {
  const calls = new Map<string, Readonly<{ name: string; arguments: string }>>();
  const seen = new Set<number>();
  const steps = new Map<string, { delivered: string; blocks: Map<number, { type: string; text: string; ended: boolean }> }>();
  const observe = (session: Agent["session"], event: SessionEvent | {type:"assistant/chunk";seq:number;data:{turn:number;step:number;chunk:import("@deepseek-ai/dsh-llm").StreamChunk}}): void => {
    if (signal.aborted || session.id !== agent.session.id || seen.has(event.seq)) return;
    seen.add(event.seq);
    if (event.type === "assistant/chunk") {
      const chunk = event.data.chunk;
      if (!("index" in chunk)) return;
      const key = `${event.data.turn}:${event.data.step}`;
      const step = steps.get(key) ?? { delivered: "", blocks: new Map() };
      steps.set(key, step);
      const previous = step.blocks.get(chunk.index);
      if (chunk.type === "block-start") step.blocks.set(chunk.index, { type: chunk.blockType, text: "", ended: false });
      if (chunk.type === "text-delta" && (previous === undefined || previous.type === "text")) {
        step.blocks.set(chunk.index, { type: "text", text: (previous?.text ?? "") + chunk.text, ended: false });
      }
      if (chunk.type === "block-end" && chunk.block.type === "text" && (previous === undefined || previous.type === "text")) {
        step.blocks.set(chunk.index, { type: "text", text: chunk.block.text, ended: true });
      }
      // Preserve Harness' public block order and separators. Later interleaved
      // blocks wait until the earlier block closes, so delivered prose is never
      // reordered or duplicated when the final message is assembled.
      const parts: string[] = [];
      for (const [, block] of [...step.blocks.entries()].sort(([a], [b]) => a - b)) {
        if (block.type !== "text") continue;
        parts.push(block.text);
        if (!block.ended) break;
      }
      const text = parts.join("\n");
      if (text.length > step.delivered.length && text.startsWith(step.delivered)) {
        stream.appendText(text.slice(step.delivered.length));
        step.delivered = text;
        liveDraft?.update(text);
      }
      return;
    }
    if (event.type === "assistant/message") {
      // Harness separates reasoning blocks from public text. Never inspect
      // prose prefixes to guess a private channel, or forward structured data.
      const text = outputText(event.data.message.content);
      stream.finishText?.(text, event.data.interrupted === true);
      if (text !== "") liveDraft?.settle(text);
      return;
    }
    if (event.type === "tool/call") {
      calls.set(String(event.data.callId), Object.freeze({ name: event.data.name, arguments: event.data.arguments }));
      return;
    }
    if (event.type !== "tool/result") return;
    const callId = String(event.data.message.source.callId);
    const call = calls.get(callId);
    const result = event.data.message;
    if (!call) return;
    stream.appendTool({
      callId,
      name: call.name,
      arguments: call.arguments,
      content: result.content,
      isError: result.isError === true,
      ...(event.data.error === undefined ? {} : { error: event.data.error }),
      ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
    });
    calls.delete(callId);
  };
  const dispose = agent.ctx.on("session/event", observe);
  const attempts = new Map<string, {turn:number;step:number}>();
  const disposeStream = agent.ctx.on("agent/assistant-stream", ({agent: source, frame}) => {
    if(source.session.id !== agent.session.id) return;
    if(frame.type === "start") attempts.set(frame.attemptId,{turn:frame.turn,step:frame.step});
    if(frame.type === "chunk") {
      const position=attempts.get(frame.attemptId);
      if(position) observe(agent.session,{type:"assistant/chunk",seq:-frame.revision,data:{...position,chunk:frame.chunk}});
    }
    if(frame.type === "end") attempts.delete(frame.attemptId);
  });
  const firstLiveSeq = Number.isSafeInteger(agent.session.firstLiveSeq) ? agent.session.firstLiveSeq : 0;
  for (const event of agent.session.snapshotEvents()) {
    if (event.seq >= firstLiveSeq) observe(agent.session, event);
  }
  return () => {dispose();disposeStream();};
}

/**
 * Bounded bridge to Harness one-shot subagents. It owns no scheduling and is
 * deliberately not a model-callable tool.
 */
export class HarnessAgentAdapter implements AgentRunnerPort {
  constructor(
    private readonly ctx: HarnessWorkerContext,
    private readonly workers: HarnessAgentWorkerRegistry,
    private readonly workflow: WorkflowRegistry = defaultWorkflowRegistry,
    private readonly conversation: WorkflowAgentConversationPort = silentConversation,
    private readonly chapterWrites?: WorkflowChapterWritesPort,
  ) {}

  async run(input: AgentRunnerRequest, signal: AbortSignal): Promise<AgentRunnerResult> {
    try {
      validateAgentRunnerRequest(input, this.workflow);
    } catch {
      throw new UnregisteredWorkflowWorker("Workflow requested an unregistered or stale worker/persona/schema binding");
    }
    let worker: RegisteredWorkflowWorker | undefined;
    try {
      worker = await this.workers.resolve(input.binding);
    } catch {
      throw new WorkerResourceIntegrityError("Workflow worker resource integrity verification failed");
    }
    if (!worker) throw new UnregisteredWorkflowWorker("Workflow worker resources do not match the frozen binding");
    const parent = this.ctx.agents.get(asSessionId(input.parentSessionId));
    if (!parent) throw new ParentAgentUnavailable("The initiating Harness session is not currently available");
    const context = freezeWorkflowWorkerContext(input.frozenContext);
    const direct = context.writeMode === "direct";
    const hasGrant = input.chapterWriteGrant !== undefined;
    if (direct !== hasGrant) {
      throw new WorkflowWriteRuntimeUnavailable(direct
        ? "Direct workflow writer has no internal write grant"
        : "Candidate-only workflow writer must not receive a direct write grant");
    }

    // Evidence repair is bounded separately from model/IO failures. It keeps
    // the same frozen chapter and read-only worker tools, never a write grant.
    if (worker.outputSchema.id === "chapter-memory.v1" || worker.outputSchema.id === "chapter-memory.v2") {
      const candidate = expectedCandidate(context);
      if (!candidate || hash(candidate.content) !== candidate.candidateHash) {
        throw new WorkerModelError("Memory extraction requires a verified frozen chapter");
      }
      let extractionContext = context;
      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) throw new WorkerCancelled("Memory extraction was cancelled");
        const completion = await this.runOnce({ worker, parent, context: extractionContext, signal, request: input });
        if (signal.aborted) throw new WorkerCancelled("Memory extraction was cancelled");
        if (completion.structured === undefined && completion.text === "") throw new WorkerModelError("Harness worker completed without a visible assistant response");
        const extracted = completion.structured ?? (worker.outputSchema.id === "chapter-memory.v2"
          ? typedMemoryFromText(completion.text)
          : memoryFromText(completion.text));
        let grounded;
        try {
          grounded = worker.outputSchema.id === "chapter-memory.v2"
            ? groundTypedMemoryEvidence(candidate.content, extracted)
            : groundMemoryEvidence(candidate.content, extracted);
        } catch (error) {
          if (!(error instanceof MemoryExtractionEvidenceInvalid) || attempt >= 2) throw error;
          extractionContext = freezeWorkflowWorkerContext({ ...context, reviewFeedback: [{
            instruction: MEDIA_PROMPT_RULES["workflow-memory-repair"],
            invalidFactNumbers: error.factNumbers,
            previousExtraction: extracted,
          }] });
          continue;
        }
        return this.persistValidatedOutput(input, worker, grounded, attempt);
      }
    }
    const completion = await this.runOnce({ worker, parent, context, signal, request: input });
    if (completion.chapterWrite) {
      const candidate = directCandidate(completion.chapterWrite);
      const persisted = await this.persistValidatedOutput(input, worker, candidate, 0);
      return Object.freeze({
        ...persisted,
        chapterWrite: Object.freeze({
          receipt: Object.freeze({ ...completion.chapterWrite.receipt }),
          receiptArtifact: Object.freeze({ ...completion.chapterWrite.receiptArtifact }),
        }),
      });
    }
    if (completion.structured !== undefined) {
      return this.persistValidatedOutput(input, worker, completion.structured, 0);
    }
    const text = completion.text;
    if (text === "") throw new WorkerModelError("Harness worker completed without a visible assistant response");
    const normalized = normalizeWorkerOutput(worker, context, text);
    return this.persistValidatedOutput(input, worker, normalized, 0);
  }

  private async persistValidatedOutput(
    input: AgentRunnerRequest,
    worker: RegisteredWorkflowWorker,
    structured: unknown,
    repairAttempts: number,
  ): Promise<AgentRunnerResult> {
    const contents = JSON.stringify(structured);
    try {
      const artifact = ArtifactHandleSchema.parse(await input.artifacts.store({
        runId: input.runId,
        kind: worker.artifactKind,
        contents,
      }));
      if (artifact.sha256 !== hash(contents) || artifact.byteSize !== Buffer.byteLength(contents, "utf8")) {
        throw new Error("Workflow worker artifact integrity mismatch");
      }
      return Object.freeze({
        agentId: worker.agentId,
        outputSchemaId: worker.outputSchema.id,
        schemaVersion: worker.outputSchema.version,
        artifact: Object.freeze(artifact),
        repairAttempts,
      });
    } catch (error) {
      if (error instanceof WorkerArtifactPersistenceError) throw error;
      throw new WorkerArtifactPersistenceError("Unable to persist a validated workflow worker result", { cause: error });
    }
  }

  private async runOnce(input: Readonly<{
    worker: RegisteredWorkflowWorker;
    parent: Agent;
    context: FrozenWorkflowWorkerContext;
    signal: AbortSignal;
    request: AgentRunnerRequest;
  }>): Promise<Readonly<{ text: string; structured?: unknown; chapterWrite?: RecoveredChapterWrite }>> {
    let run: SubagentRun | undefined;
    let stopMirroring: (() => void) | undefined;
    let grantedSessionId: string | undefined;
    let liveDraft: ReturnType<typeof createLiveDraftMirror> | undefined;
    const direct = input.context.writeMode === "direct";
    const stream = this.conversation.start({
      runId: input.request.runId,
      nodeId: input.request.nodeId,
      label: input.worker.publicLabel,
      parent: input.parent,
    });
    const abortStream = () => {
      stopMirroring?.(); stopMirroring = undefined; stream.abort();
    };
    input.signal.addEventListener("abort", abortStream, { once: true });
    try {
      run = await this.ctx.subagents.start("spawn", {
        label: input.worker.publicLabel,
        prompt: freezePrompt(buildFrozenPromptBlocks(input.context)),
        parent: input.parent,
        signal: input.signal,
        persona: input.worker.persona.text,
        toolFilter: { allow: [...toolsForRun(input.worker, direct)] },
        maxDepth: 1,
      });
      if (direct) {
        if (!run.localAgent || !this.chapterWrites) {
          throw new WorkflowWriteRuntimeUnavailable("Direct workflow writer requires a local child runtime and chapter write broker");
        }
        const sessionId = String(run.localAgent.session.id);
        const grant = workflowWriteGrant(input.request.chapterWriteGrant);
        this.chapterWrites.grant(sessionId, {
          ...grant,
          artifacts: {
            write: ({ contents, ...artifactInput }) => input.request.artifacts.store({
              ...artifactInput,
              contents: typeof contents === "string" ? contents : Buffer.from(contents).toString("utf8"),
            }),
            read: (artifactRef) => input.request.artifacts.read(artifactRef),
          },
        }, input.signal);
        grantedSessionId = sessionId;
        if (grant.chapterInitialized && grant.nodeId === "write" && grant.revisionRound === 0) {
          liveDraft = createLiveDraftMirror((content) => this.chapterWrites!.saveLiveDraft(
            sessionId,
            workflowResultText(input.worker, content),
          ));
        }
      }
      if (run.localAgent) stopMirroring = mirrorChildConversation(run.localAgent, stream, input.signal, liveDraft);
      let result: Awaited<SubagentRun["result"]>;
      try {
        result = await run.result;
      } catch (error) {
        const completedWrite = grantedSessionId === undefined ? undefined : this.chapterWrites?.takeResult(grantedSessionId);
        if (completedWrite) {
          const candidate = directCandidate(completedWrite);
          stream.complete(candidate.content);
          return { text: candidate.content, chapterWrite: completedWrite };
        }
        throw error;
      }
      let completedWrite = grantedSessionId === undefined ? undefined : this.chapterWrites?.takeResult(grantedSessionId);
      if (completedWrite) {
        const candidate = directCandidate(completedWrite);
        stream.complete(candidate.content);
        return { text: candidate.content, chapterWrite: completedWrite };
      }
      if (input.signal.aborted) throw new WorkerCancelled("Harness workflow worker was cancelled");
      if (direct) {
        if (result.stopReason !== "completed") throw resultFailure(result);
        if (grantedSessionId === undefined || !this.chapterWrites) {
          throw new WorkflowWriteRuntimeUnavailable("Direct workflow writer lost its host persistence grant");
        }
        const rawText = outputText(result.output);
        const structured = result.structured === undefined
          ? undefined
          : validateStructuredWorkerOutput(input.worker, input.context, result.structured);
        const structuredCandidate = ChapterCandidateOutputSchema.safeParse(structured);
        const content = rawText === "" && structuredCandidate.success
          ? structuredCandidate.data.content
          : workflowResultText(input.worker, rawText);
        if (content === "") throw new WorkerModelError("Harness worker completed without a visible assistant response");
        liveDraft?.settle(content);
        try {
          await this.chapterWrites.execute(grantedSessionId, hostWriteArgs(input.context, content));
        } catch (error) {
          completedWrite = this.chapterWrites.takeResult(grantedSessionId);
          if (!completedWrite) throw error;
        }
        completedWrite ??= this.chapterWrites.takeResult(grantedSessionId);
        if (!completedWrite) {
          throw new WorkflowWriteRequired("正文已生成，但宿主没有取得可验证的章节写入回执。");
        }
        const candidate = directCandidate(completedWrite);
        stream.complete(rawText === "" ? candidate.content : rawText);
        return { text: candidate.content, chapterWrite: completedWrite };
      }
      const rawText = outputText(result.output);
      const text = workflowResultText(input.worker, rawText);
      if (result.stopReason !== "completed" && !(result.stopReason === "max-tokens" && recoverableMaxTokenReview(input.worker, text))) {
        throw resultFailure(result);
      }
      const structured = result.structured === undefined
        ? undefined
        : validateStructuredWorkerOutput(input.worker, input.context, result.structured);
      const structuredCandidate = ChapterCandidateOutputSchema.safeParse(structured);
      const publicText = rawText === "" && input.worker.outputSchema.id === "chapter-candidate.v1" && structuredCandidate.success
        ? structuredCandidate.data.content
        : rawText;
      // Settle the same raw public answer already mirrored from the Session.
      // A cleaned graph result is not a second answer. Direct tool-written
      // candidates take the separate authoritative-content branches above.
      stream.complete(publicText);
      return { text: rawText === "" ? publicText : text, ...(structured === undefined ? {} : { structured }) };
    } catch (error) {
      stream.abort();
      if (error instanceof WorkflowAgentError) throw error;
      if (input.signal.aborted) throw new WorkerCancelled("Harness workflow worker was cancelled");
      const detail = error instanceof Error
        ? error.message.replace(/\s+/g, " ").trim().slice(0, 240)
        : String(error).replace(/\s+/g, " ").trim().slice(0, 240);
      throw new WorkerModelError(`工作 Agent 启动或执行失败${detail ? `：${detail}` : ""}`, { cause: error });
    } finally {
      if (grantedSessionId !== undefined) this.chapterWrites?.revoke(grantedSessionId);
      liveDraft?.dispose();
      input.signal.removeEventListener("abort", abortStream);
      stopMirroring?.();
      if (run) await run.dispose();
    }
  }
}

export { createHarnessAgentWorkerRegistry } from "./agentRegistry.ts";
