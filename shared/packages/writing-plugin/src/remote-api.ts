import type { ExportWorkInput, SearchWorkInput, ApplyProposalInput, ApplyImportInput, ChapterChangeProposal, ChapterProposal, ChapterTarget, ReadChapterRevisionInput, ReadChapterWorkflowRecordInput, PreviewImportInput, RenameChapterInput, RenameVolumeInput, ReplaceChapterInput, RestoreChapterRevisionInput, SaveChapterOutlineInput, SaveVolumeOutlineInput } from "@jizuo/contracts";

import type {
  WorkflowRunDetailProjection,
  WorkflowRunProjection,
} from "@jizuo/contracts";
import { JizuoError } from "@jizuo/contracts";

import type { JizuoService } from "../../jizuo-plugin/src/service.ts";

import type { WorkflowRemotePort } from "../../jizuo-plugin/src/remote-service.ts";

/** Feature-owned handlers; the core RPC namespace delegates here for compatibility. */
export class WritingRemoteApi {
  constructor(readonly domain: JizuoService, private readonly workflowRuns?: WorkflowRemotePort) {}
  async exportWork(request: ExportWorkInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.exportWork(request);
  }

  async searchWork(request: SearchWorkInput, signal: AbortSignal) {
    return this.domain.searchWork(request, signal);
  }

  async previewImport(request: PreviewImportInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.previewImport(request);
  }

  async applyImport(request: ApplyImportInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.applyImport(request);
  }

  async listVolumes(request: { workId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.listVolumes(request.workId);
  }

  async createVolume(request: { workId: string; title: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.createVolume(request);
  }

  async renameVolume(request: RenameVolumeInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.renameVolume(request);
  }

  async saveVolumeOutline(request: SaveVolumeOutlineInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.saveVolumeOutline(request);
  }

  async listChapters(request: { workId: string; volumeId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.listChapters(request);
  }

  async createChapter(request: {
    workId: string;
    volumeId: string;
    title: string;
    content?: string;
    plan?: string;
    detailedOutline?: string;
  }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.createChapter({ ...request, mode: "create_explicit" });
  }

  async renameChapter(request: RenameChapterInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.renameChapter(request);
  }

  async readChapter(request: ChapterTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.readChapter(request);
  }

  async replaceChapter(request: ReplaceChapterInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.replaceChapter(request);
  }

  async saveChapterOutline(request: SaveChapterOutlineInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.saveChapterOutline(request);
  }

  async listProposals(request: ChapterTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    const workflowRuns = this.workflowRuns;
    const proposals = await this.domain.listProposals(request);
    const visible = await Promise.all(proposals.map(async proposal =>
      !workflowRuns?.ownsProposal(proposal.id) && !await this.domain.isWorkflowOwnedProposal(proposal.id)));
    return proposals.filter((_proposal, index) => visible[index]);
  }

  async getProposalPreview(request: { proposalId: string }, signal: AbortSignal): Promise<ChapterProposal> {
    signal.throwIfAborted();
    return this.domain.getProposalPreview(request.proposalId);
  }

  async rejectProposal(request: { proposalId: string }, signal: AbortSignal): Promise<ChapterChangeProposal> {
    signal.throwIfAborted();
    await this.assertLegacyProposalActionAllowed(request.proposalId);
    return this.domain.rejectProposal(request.proposalId);
  }

  async authorizeProposal(request: { proposalId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.assertLegacyProposalActionAllowed(request.proposalId);
    return this.domain.authorizeProposal(request.proposalId);
  }

  async applyProposal(request: ApplyProposalInput, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.assertLegacyProposalActionAllowed(request.proposalId);
    return this.domain.applyProposal(request);
  }

  async restoreChapterRevision(request: RestoreChapterRevisionInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.restoreChapterRevision(request);
  }

  async listChapterRevisions(request: ChapterTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.listChapterRevisions(request);
  }

  async readChapterRevision(request: ReadChapterRevisionInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.readChapterRevision(request);
  }

  async listChapterWorkflowRecords(request: ChapterTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.listChapterWorkflowRecords(request);
  }

  async readChapterWorkflowRecord(request: ReadChapterWorkflowRecordInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.readChapterWorkflowRecord(request);
  }

  async listWorkflowRuns(request: { sessionId: string; statuses?: readonly string[] }, signal: AbortSignal): Promise<readonly WorkflowRunProjection[]> {
    signal.throwIfAborted();
    return this.requireWorkflowRuns().list(request);
  }

  async getWorkflowRun(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal.throwIfAborted();
    return this.requireWorkflowRuns().get(request);
  }

  async decideWorkflowApproval(request: {
    runId: string;
    proposalId: string;
    decision: "approved" | "rejected";
  }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal.throwIfAborted();
    // The run service obtains a one-time proposal capability only on this
    // approved branch and keeps it process-local. Typert never observes it.
    return this.requireWorkflowRuns().decideApproval(request);
  }

  async extendWorkflowBudget(request: { runId: string; additionalRounds: 2 }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal.throwIfAborted();
    return this.requireWorkflowRuns().extendBudget(request);
  }

  async pauseWorkflowRun(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal.throwIfAborted();
    return this.requireWorkflowRuns().pause(request.runId);
  }

  async resumeWorkflowRun(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal.throwIfAborted();
    return this.requireWorkflowRuns().resume(request.runId);
  }

  async cancelWorkflowRun(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal.throwIfAborted();
    return this.requireWorkflowRuns().cancel(request.runId);
  }

  async reconcileWorkflowApply(request: { runId: string }, signal: AbortSignal): Promise<WorkflowRunDetailProjection> {
    signal.throwIfAborted();
    return this.requireWorkflowRuns().reconcileIndeterminateApply(request.runId);
  }

  async watchWorkflowRuns(request: {
    sessionId: string;
    afterSequence: number;
    timeoutMs: number;
  }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.requireWorkflowRuns().waitForChange(request, signal);
  }

  async resolveChapterPath(request: ChapterTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.resolveChapterPath(request);
  }

  private requireWorkflowRuns(): WorkflowRemotePort {
    if (this.workflowRuns === undefined) {
      throw new JizuoError("runtime_unavailable", "章节工作流运行时尚未启用");
    }
    return this.workflowRuns;
  }

  private async assertLegacyProposalActionAllowed(proposalId: string): Promise<void> {
    if (await this.domain.isWorkflowOwnedProposal(proposalId)) {
      throw new JizuoError("denied", "该提案属于章节工作流，请在工作流进度中确认或拒绝");
    }
    if (!this.workflowRuns?.ownsProposal(proposalId)) return;
    throw new JizuoError("denied", "该提案属于章节工作流，请在工作流进度中确认或拒绝");
  }
}
