import { createHash } from "node:crypto";

import {
  CompiledWorkflowExecutionPort,
  WorkflowRunService,
  openWorkflowDatabase,
  type FrozenWorkflowStartConfig,
  type WorkflowRunServiceOptions,
  type WorkflowParentSessionPort,
  type WorkflowRuntimeRegistries,
  type WorkflowTranscriptPort,
} from "@jizuo/workflow-runtime";

import type { JizuoService } from "../service.ts";
import { WorkflowChapterWriteReceipt } from "@jizuo/contracts";
import { DomainNodeError, JizuoDomainNodeAdapter, LockedChapterTargetSchema, type JizuoWorkflowDomainService } from "./domainAdapter.ts";
import { WorkflowChapterWriteCapabilityBroker } from "./writeCapability.ts";

export interface JizuoWorkflowRuntimeHostOptions {
  readonly databasePath: string;
  readonly artifactRoot?: string;
  readonly service: Pick<JizuoService, "authorizeProposal" | "rejectAnyProposal"> & JizuoWorkflowDomainService;
  /** Closed code-owned node registry; callers cannot inject a second scheduler. */
  readonly registries?: WorkflowRuntimeRegistries;
  readonly createRegistries?: (input: Readonly<{
    artifacts: ReturnType<typeof openWorkflowDatabase>["artifacts"];
    repository: ReturnType<typeof openWorkflowDatabase>["repository"];
    workflowChapterWrites: WorkflowChapterWriteCapabilityBroker;
  }>) => WorkflowRuntimeRegistries;
  readonly frozen: FrozenWorkflowStartConfig;
  readonly definitionProvider?: WorkflowRunServiceOptions["definitionProvider"];
  readonly transcript?: WorkflowTranscriptPort;
  readonly parents: WorkflowParentSessionPort & {
    onAgentCreated?(listener: (sessionId: string) => void): (() => void) | void;
  };
}

export interface JizuoWorkflowRuntimeHostInternals {
  readonly openDatabase?: typeof openWorkflowDatabase;
}

/**
 * Plugin-lifetime composition root. The host deliberately receives a closed
 * execution port: it has no filesystem, raw SQL, or model-tool escape hatch.
 */
export function createJizuoWorkflowRuntimeHost(
  options: JizuoWorkflowRuntimeHostOptions,
  internals: JizuoWorkflowRuntimeHostInternals = {},
) {
  const opened = (internals.openDatabase ?? openWorkflowDatabase)(
    options.databasePath,
    options.artifactRoot === undefined ? {} : { artifactRoot: options.artifactRoot },
  );
  let runs: WorkflowRunService | undefined;
  let detach: (() => void) | void;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    let cleanupError: unknown;
    const cleanup = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        cleanupError ??= error;
      }
    };
    if (typeof detach === "function") cleanup(detach);
    if (runs) cleanup(() => runs!.dispose());
    cleanup(() => opened.close());
    if (cleanupError !== undefined) throw cleanupError;
  };

  try {
    const domain = new JizuoDomainNodeAdapter(options.service);
    const workflowChapterWrites = new WorkflowChapterWriteCapabilityBroker({ domain, repository: opened.repository });
    const registries = options.createRegistries?.({
      artifacts: opened.artifacts,
      repository: opened.repository,
      workflowChapterWrites,
    }) ?? options.registries;
    if (!registries) throw new Error("Jizuo workflow runtime requires closed node registries");
    const execution = new CompiledWorkflowExecutionPort({
      registries,
      checkpointer: opened.checkpointer,
      repository: opened.repository,
      artifacts: opened.artifacts,
      validateRestartedChapter: async (state) => {
        const reference = state.chapterWriteArtifact!;
        const bytes = await opened.artifacts.read(reference.artifactRef);
        if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error("Chapter receipt integrity mismatch");
        const receipt = WorkflowChapterWriteReceipt.parse(JSON.parse(bytes.toString("utf8")));
        if (receipt.workId !== state.target.workId || receipt.volumeId !== state.target.volumeId
          || receipt.contentHash !== state.chapterWriteRevision || receipt.contentHash !== state.candidate?.sha256) throw new Error("Chapter receipt identity mismatch");
        await domain.verifyAppliedChapter({
          proposalId: state.runId, workId: receipt.workId, volumeId: receipt.volumeId, chapterId: receipt.chapterId,
          chapterNumber: receipt.chapterNumber, appliedRevision: receipt.revision, contentHash: receipt.contentHash,
        });
      },
      recoverChapterWrite: async ({ state, nodeId, revisionRound, lease, assertActive }) => {
        const readReference = async (reference: typeof state.targetLock) => {
          if (!reference) throw new Error("Direct chapter write recovery evidence is missing");
          const bytes = await opened.artifacts.read(reference.artifactRef);
          if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error("Direct chapter write recovery evidence does not match its checkpoint");
          return JSON.parse(bytes.toString("utf8"));
        };
        const lock = LockedChapterTargetSchema.parse(await readReference(state.targetLock));
        if (JSON.stringify(lock.target) !== JSON.stringify(state.target)) throw new Error("Direct chapter write recovery target mismatch");
        const previous = nodeId !== "write" ? WorkflowChapterWriteReceipt.parse(await readReference(state.chapterWriteArtifact)) : undefined;
        const previousEffect = (() => {
          if (nodeId === "write") return undefined;
          if (nodeId === "revise") return { nodeId: revisionRound === 1 ? "write" as const : "revise" as const, revisionRound: revisionRound - 1 };
          if (revisionRound > 1) return { nodeId, revisionRound: revisionRound - 1 };
          const stage = nodeId.replace(/-revise$/, "") as "continuity" | "style" | "ai-trace";
          const stages = ["continuity", "style", "ai-trace"] as const;
          for (const prior of stages.slice(0, stages.indexOf(stage)).reverse()) {
            const priorRound = state.reviewStageStates?.[prior]?.revisionRound ?? 0;
            if (priorRound > 0) return { nodeId: `${prior}-revise` as const, revisionRound: priorRound };
          }
          return { nodeId: "write" as const, revisionRound: 0 };
        })();
        const recovered = await workflowChapterWrites.recover({
          runId: state.runId, nodeId, revisionRound, lock,
          operation: {
            effectId: nodeId,
            operation: nodeId === "write" ? "write" : "revise",
            ...(nodeId.endsWith("-revise") && nodeId !== "revise" ? { stage: nodeId.replace(/-revise$/, "") as "continuity" | "style" | "ai-trace" } : {}),
            revisionRound,
          },
          ...(previousEffect === undefined ? {} : { previousEffect }),
          ...(state.chapterInitialized === undefined ? {} : { chapterInitialized: state.chapterInitialized }),
          ...(previous === undefined ? {} : { previous }), artifacts: opened.artifacts, lease,
        }, assertActive);
        if (!recovered) throw new Error("Direct chapter write recovery claim is missing");
        const current = await options.service.inspectWorkflowChapterWrite({
          runId: state.runId,
          target: { workId: recovered.receipt.workId, volumeId: recovered.receipt.volumeId, chapterId: recovered.receipt.chapterId },
          workflowTargetKind: lock.kind === "chapter" ? "existing" : "created",
        });
        assertActive();
        if (!current || current.id !== recovered.receipt.chapterId
          || current.workId !== recovered.receipt.workId || current.volumeId !== recovered.receipt.volumeId
          || current.revisionToken !== recovered.receipt.revision
          || current.content !== recovered.args.content || current.plan !== recovered.args.plan
          || current.detailedOutline !== recovered.args.detailedOutline) {
          throw new Error("Direct chapter write receipt no longer matches the retained draft");
        }
        // Tool artifacts also contain plan/outline. Rebuild the strict candidate
        // envelope consumed by reviewers without putting prose in checkpoints.
        const candidate = await opened.artifacts.write({ runId: state.runId, kind: "candidate", contents: JSON.stringify({ content: recovered.args.content, candidateHash: recovered.candidateHash }) });
        return {
          candidate: { artifactRef: candidate.artifactRef, sha256: recovered.candidateHash },
          chapterWriteArtifact: { artifactRef: recovered.receiptArtifact.artifactRef, sha256: recovered.receiptArtifact.sha256 },
          chapterWriteRevision: recovered.receipt.contentHash,
        };
      },
      ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
    });
    const runService = new WorkflowRunService({
      repository: opened.repository,
      projections: opened.projections,
      artifacts: opened.artifacts,
      execution,
      frozen: options.frozen,
      ...(options.definitionProvider === undefined ? {} : { definitionProvider: options.definitionProvider }),
      authorization: {
        authorizeProposal: (proposalId) => options.service.authorizeProposal(proposalId),
        rejectProposal: async (proposalId) => { await options.service.rejectAnyProposal(proposalId); },
      },
      parents: options.parents,
      applyReconciliation: {
        reconcile: async (run) => {
          const context = await execution.readApplyReconciliationContext(run);
          try {
            const applied = await domain.reconcileAppliedProposal(context);
            return { status: "applied" as const, candidateHash: context.candidateHash, ...applied };
          } catch (error) {
            return {
              status: "conflict" as const,
              proposalId: context.proposalId,
              candidateHash: context.candidateHash,
              conflictCode: error instanceof DomainNodeError ? error.code : "domain_evidence_unavailable",
            };
          }
        },
      },
    });
    runs = runService;
    detach = options.parents.onAgentCreated?.((sessionId) => { runService.resumeParentSession(sessionId); });
    runService.recoverNonterminal();
    return Object.freeze({
      runs: runService,
      workflowChapterWrites,
      recoverNonterminal: () => runService.recoverNonterminal(),
      reconcileApply: (runId: string) => runService.reconcileIndeterminateApply(runId),
      close,
    });
  } catch (error) {
    try {
      close();
    } catch {
      // Preserve the construction failure while still attempting every cleanup.
    }
    throw error;
  }
}
