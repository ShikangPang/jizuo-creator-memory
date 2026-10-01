import type { WorkflowRegistry } from "./registry.ts";
import { aggregateReviews, type ReviewGateDecision } from "./reviewGate.ts";
import { createReviewIssueFingerprint, DefaultReviewRules } from "./reviewGate.ts";
import { evaluateRevisionProgress, type RevisionProgressDecision } from "./revisionBudget.ts";
import type { WorkflowArtifactReference, WorkflowGraphState } from "./state.ts";
import { ChapterReviewOutputSchema, type RequiredReviewKind } from "./registry.ts";

export type ConditionResolver = (state: WorkflowGraphState) => boolean;
export type CandidateContentResolver = (candidate: WorkflowArtifactReference, state: WorkflowGraphState) => string | undefined | Promise<string | undefined>;
export interface ConditionResolverOptions { readonly resolveCandidateContent?: CandidateContentResolver; }

export type ReviewStageGateDecision =
  | Readonly<{ kind: "passed"; candidateHash: string }>
  | Readonly<{ kind: "revise"; candidateHash: string; unresolvedIssueFingerprints: readonly string[] }>
  | Readonly<{ kind: "rejected"; candidateHash: string; reason: string }>;

/**
 * Validates one serial stage against the exact current candidate. Unlike the
 * v1 aggregate gate, this intentionally cannot observe or clear another
 * stage's review output.
 */
export async function evaluateReviewStageGateResolved(
  state: WorkflowGraphState,
  stageId: RequiredReviewKind,
  resolveCandidateContent: CandidateContentResolver,
): Promise<ReviewStageGateDecision> {
  const candidate = state.candidate;
  const review = ChapterReviewOutputSchema.safeParse(state.reviewOutputs?.[stageId]);
  const content = candidate ? await resolveCandidateContent(candidate, state) : undefined;
  if (!candidate || content === undefined || !review.success) {
    return Object.freeze({ kind: "rejected", candidateHash: candidate?.sha256 ?? "", reason: "missing-or-invalid-review" });
  }
  if (review.data.reviewKind !== stageId || review.data.candidateHash !== candidate.sha256) {
    return Object.freeze({ kind: "rejected", candidateHash: candidate.sha256, reason: "candidate-hash-mismatch" });
  }
  const hasBlockingIssue = review.data.issues.some((issue) => issue.blocking);
  if (review.data.decision === "revise" && !hasBlockingIssue || review.data.decision === "pass" && hasBlockingIssue) {
    return Object.freeze({ kind: "rejected", candidateHash: candidate.sha256, reason: "decision-issue-mismatch" });
  }
  for (const issue of review.data.issues) {
    if (!DefaultReviewRules[stageId].includes(issue.ruleId)
      || !content.includes(issue.evidence)
      || issue.fingerprint !== createReviewIssueFingerprint(stageId, issue)) {
      return Object.freeze({ kind: "rejected", candidateHash: candidate.sha256, reason: "invalid-review-evidence" });
    }
  }
  if (review.data.decision === "pass") return Object.freeze({ kind: "passed", candidateHash: candidate.sha256 });
  return Object.freeze({
    kind: "revise",
    candidateHash: candidate.sha256,
    unresolvedIssueFingerprints: Object.freeze(review.data.issues.filter((issue) => issue.blocking).map((issue) => issue.fingerprint)),
  });
}

/** Bridges the strict review gate to the existing code-owned review condition. */
export function reviewGateAllowsProposal(decision: ReviewGateDecision): boolean {
  return decision.kind === "approved-candidate";
}

/** Only an explicit revision decision may traverse the finite revision edge. */
export function revisionDecisionAllowsAutomaticRevision(decision: RevisionProgressDecision): boolean {
  return decision.kind === "revise";
}

function reviewsForCurrentCandidate(state: WorkflowGraphState) {
  const candidateHash = state.candidate?.sha256;
  if (!candidateHash || !state.reviewOutputs) return {};
  return Object.fromEntries(Object.entries(state.reviewOutputs).filter(([, review]) =>
    review?.candidateHash === candidateHash,
  ));
}

export function evaluateStrictReviewGate(state: WorkflowGraphState, resolveCandidateContent?: CandidateContentResolver): ReviewGateDecision {
  const candidate = state.candidate;
  const resolved = candidate && resolveCandidateContent?.(candidate, state);
  const content = typeof resolved === "string" ? resolved : undefined;
  if (!candidate || content === undefined) return Object.freeze({ kind: "rejected" as const, candidateHash: candidate?.sha256 ?? "", reasons: Object.freeze([{ code: "invalid-review" as const }]) });
  return aggregateReviews({ candidate: { candidateHash: candidate.sha256, content }, reviews: reviewsForCurrentCandidate(state) });
}

/** Async production gate used when candidate prose is recovered from an integrity-checked artifact. */
export async function evaluateStrictReviewGateResolved(state: WorkflowGraphState, resolveCandidateContent: CandidateContentResolver): Promise<ReviewGateDecision> {
  const candidate = state.candidate;
  const content = candidate ? await resolveCandidateContent(candidate, state) : undefined;
  if (!candidate || content === undefined) return Object.freeze({ kind: "rejected" as const, candidateHash: candidate?.sha256 ?? "", reasons: Object.freeze([{ code: "invalid-review" as const }]) });
  return aggregateReviews({ candidate: { candidateHash: candidate.sha256, content }, reviews: reviewsForCurrentCandidate(state) });
}

export function evaluateRevisionDecision(state: WorkflowGraphState, review: ReviewGateDecision): RevisionProgressDecision | undefined {
  if (review.kind !== "revise") return undefined;
  const current = { decision: "revise" as const, blockingIssueFingerprints: review.issues.filter((issue) => issue.blocking).map((issue) => issue.fingerprint), score: Object.values(review.reviews).reduce((sum, value) => sum + value.score, 0) / 3 };
  const previous = state.reviewOutcome && state.reviewOutcome.candidateHash !== review.candidateHash
    ? { decision: "revise" as const, blockingIssueFingerprints: state.reviewOutcome.blockingIssueFingerprints, score: state.reviewOutcome.score }
    : undefined;
  return evaluateRevisionProgress({
    revisionRound: state.revisionRound,
    maxRevisionRounds: state.revisionRound + state.remainingRevisionRounds,
    noProgressRounds: state.noProgressRounds ?? 0,
    ...(previous ? { previous } : {}),
    current,
  });
}

/**
 * Materializes the fixed registry conditions into the only functions the
 * compiler may execute for JSON `when` branches.
 */
export function createConditionResolvers(registry: WorkflowRegistry, options: ConditionResolverOptions = {}): Readonly<Record<string, ConditionResolver>> {
  return Object.freeze(Object.fromEntries(Object.entries(registry.conditions).map(([id, condition]) => [
    id, (state: WorkflowGraphState) => {
      const resolvedCandidateContent = state.candidate ? options.resolveCandidateContent?.(state.candidate, state) : undefined;
      const candidateContent = typeof resolvedCandidateContent === "string" ? resolvedCandidateContent : undefined;
      return condition.implementation.evaluate({
      remainingRevisionRounds: state.remainingRevisionRounds,
      revisionRound: state.revisionRound,
      ...(state.noProgressRounds === undefined ? {} : { noProgressRounds: state.noProgressRounds }),
      ...(state.reviewOutcome === undefined ? {} : { reviewOutcome: state.reviewOutcome }),
      ...(state.revisionDecision === undefined ? {} : { revisionDecision: state.revisionDecision }),
      ...(state.candidate && candidateContent !== undefined ? { candidate: { candidateHash: state.candidate.sha256, content: candidateContent } } : {}),
      ...(state.reviewOutcome === undefined ? {} : { previousReviewQuality: state.reviewOutcome }),
      ...(state.approved === undefined ? {} : { approved: state.approved }),
      target: { mode: state.target.mode },
      chapterWriteMode: state.chapterWriteMode ?? "candidate-only",
      ...(state.chapterWriteArtifact === undefined ? {} : { chapterWriteArtifact: state.chapterWriteArtifact }),
      ...(state.chapterWriteRevision === undefined ? {} : { chapterWriteRevision: state.chapterWriteRevision }),
      reviewOutputs: reviewsForCurrentCandidate(state),
      });
    },
  ])));
}
