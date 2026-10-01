import type { MemoryEpisodeCandidate, MemoryGraph, MemoryQueryInput } from "@jizuo/memory-domain";

import {
  JizuoDomainNodeAdapter,
  type AppliedChapter,
  type ChapterProposalReference,
  type LockedChapterTarget,
} from "./domainAdapter.ts";

export type DomainNodeHandlerId =
  | "jizuo.lockChapterTarget"
  | "jizuo.initializeWorkflowChapter"
  | "jizuo.queryMemory"
  | "jizuo.writeWorkflowChapter"
  | "jizuo.reconcileWorkflowChapterWrite"
  | "jizuo.createChapterProposal"
  | "jizuo.applyChapterProposal"
  | "jizuo.verifyAppliedChapter"
  | "jizuo.saveChapterMemory";

export interface DomainNodePort {
  lockChapterTarget(target: unknown): Promise<LockedChapterTarget>;
  initializeWorkflowChapter: JizuoDomainNodeAdapter["initializeWorkflowChapter"];
  queryMemory(input: { lock: LockedChapterTarget; query: MemoryQueryInput }): Promise<MemoryGraph>;
  writeWorkflowChapter(input: Parameters<JizuoDomainNodeAdapter["writeWorkflowChapter"]>[0]): ReturnType<JizuoDomainNodeAdapter["writeWorkflowChapter"]>;
  reconcileWorkflowChapterWrite(input: Parameters<JizuoDomainNodeAdapter["reconcileWorkflowChapterWrite"]>[0]): ReturnType<JizuoDomainNodeAdapter["reconcileWorkflowChapterWrite"]>;
  createChapterProposal(input: Parameters<JizuoDomainNodeAdapter["createChapterProposal"]>[0]): Promise<ChapterProposalReference>;
  applyChapterProposal(input: Parameters<JizuoDomainNodeAdapter["applyChapterProposal"]>[0]): Promise<AppliedChapter>;
  verifyAppliedChapter(applied: unknown): Promise<AppliedChapter>;
  saveChapterMemory(input: { verified: AppliedChapter; candidate: MemoryEpisodeCandidate }): Promise<{ episodeKey: string; status: "committed" | "suggested" }>;
  saveWorkflowChapterProjection: JizuoDomainNodeAdapter["saveWorkflowChapterProjection"];
}

export interface JizuoDomainNodeRegistry {
  readonly port: DomainNodePort;
  readonly handlers: Readonly<Record<DomainNodeHandlerId, Function>>;
  resolve(handlerId: string): Function | undefined;
}

/** Closed handler registry; these functions are not Harness model-callable tools. */
export function createJizuoDomainNodeRegistry(adapter: JizuoDomainNodeAdapter): JizuoDomainNodeRegistry {
  const port: DomainNodePort = adapter;
  const handlers = Object.freeze({
    "jizuo.lockChapterTarget": port.lockChapterTarget.bind(port),
    "jizuo.initializeWorkflowChapter": port.initializeWorkflowChapter.bind(port),
    "jizuo.queryMemory": port.queryMemory.bind(port),
    "jizuo.writeWorkflowChapter": port.writeWorkflowChapter.bind(port),
    "jizuo.reconcileWorkflowChapterWrite": port.reconcileWorkflowChapterWrite.bind(port),
    "jizuo.createChapterProposal": port.createChapterProposal.bind(port),
    "jizuo.applyChapterProposal": port.applyChapterProposal.bind(port),
    "jizuo.verifyAppliedChapter": port.verifyAppliedChapter.bind(port),
    "jizuo.saveChapterMemory": port.saveChapterMemory.bind(port),
  });
  return Object.freeze({
    port,
    handlers,
    resolve: (handlerId: string) => handlers[handlerId as DomainNodeHandlerId],
  });
}
