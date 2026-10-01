import { z } from "zod";

import { sha256 } from "./hash.ts";
import { ChapterReviewSchema, ReviewKinds, type ChapterReview, type ReviewIssue, type ReviewKind } from "./outputSchemas.ts";

export type ReviewRuleRegistry = Readonly<Record<ReviewKind, readonly string[]>>;

export const DefaultReviewRules: ReviewRuleRegistry = Object.freeze({
  continuity: Object.freeze(["continuity.character-consistency", "continuity.timeline", "continuity.world-consistency"]),
  style: Object.freeze(["style.voice", "style.readability", "style.pacing"]),
  "ai-trace": Object.freeze(["ai-trace.repetition", "ai-trace.cliche", "ai-trace.synthetic-pattern"]),
});

const CandidateForReviewSchema = z.object({
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().min(1).max(1_000_000),
}).strict();

export interface ReviewGateReason {
  readonly code: "missing-review" | "duplicate-review-kind" | "invalid-review" | "candidate-hash-mismatch" | "unknown-rule" | "evidence-not-in-candidate" | "revise-without-blocking-issue" | "pass-with-blocking-issue" | "duplicate-issue-id" | "invalid-issue-fingerprint" | "invalid-rule-registry";
  readonly reviewKind?: ReviewKind;
  readonly issueId?: string;
}

export type ReviewGateDecision =
  | Readonly<{ kind: "approved-candidate"; candidateHash: string; reviews: Readonly<Record<ReviewKind, ChapterReview>>; issues: readonly ReviewIssue[] }>
  | Readonly<{ kind: "revise"; candidateHash: string; reviews: Readonly<Record<ReviewKind, ChapterReview>>; issues: readonly ReviewIssue[] }>
  | Readonly<{ kind: "rejected"; candidateHash: string; reasons: readonly ReviewGateReason[] }>;

export interface AggregateReviewsInput {
  readonly candidate: Readonly<{ candidateHash: string; content: string }>;
  readonly reviews: readonly unknown[] | Readonly<Partial<Record<ReviewKind, unknown>>>;
  readonly rules?: ReviewRuleRegistry;
}

const severityRank: Readonly<Record<ReviewIssue["severity"], number>> = Object.freeze({ critical: 4, major: 3, minor: 2, info: 1 });

export function createReviewIssueFingerprint(reviewKind: ReviewKind, issue: Pick<ReviewIssue, "ruleId" | "evidence" | "requirement">): string {
  return sha256({ reviewKind, ruleId: issue.ruleId.trim(), evidence: issue.evidence.trim(), requirement: issue.requirement.trim() });
}

function reviewList(reviews: AggregateReviewsInput["reviews"]): readonly unknown[] {
  return Array.isArray(reviews) ? reviews : Object.values(reviews);
}

function rulesAreRegistered(rules: ReviewRuleRegistry): boolean {
  return ReviewKinds.every((kind) => Array.isArray(rules[kind]) && rules[kind].length > 0 && rules[kind].every((rule) => typeof rule === "string" && rule.trim().length > 0));
}

function deduplicateIssues(issues: readonly (ReviewIssue & { readonly reviewKind: ReviewKind })[]): readonly ReviewIssue[] {
  const byFinding = new Map<string, ReviewIssue & { readonly reviewKind: ReviewKind }>();
  for (const issue of issues) {
    const key = [issue.reviewKind, issue.ruleId, issue.evidence, issue.requirement].join("\u0000");
    const existing = byFinding.get(key);
    if (!existing) {
      byFinding.set(key, issue);
      continue;
    }
    const selected = severityRank[issue.severity] > severityRank[existing.severity] || (issue.severity === existing.severity && issue.issueId.localeCompare(existing.issueId) < 0)
      ? issue
      : existing;
    byFinding.set(key, { ...selected, blocking: existing.blocking || issue.blocking });
  }
  return Object.freeze([...byFinding.values()]
    .sort((left, right) => severityRank[right.severity] - severityRank[left.severity]
      || left.reviewKind.localeCompare(right.reviewKind)
      || left.ruleId.localeCompare(right.ruleId)
      || left.evidence.localeCompare(right.evidence)
      || left.requirement.localeCompare(right.requirement))
    .map(({ reviewKind: _reviewKind, ...issue }) => Object.freeze(issue)));
}

/**
 * Fails closed unless every required reviewer inspected the exact candidate and
 * every issue quotes actual candidate prose under a registered rule.
 */
export function aggregateReviews(input: AggregateReviewsInput): ReviewGateDecision {
  const candidate = CandidateForReviewSchema.safeParse(input.candidate);
  if (!candidate.success) throw new TypeError("Invalid candidate supplied to review gate");
  const rules = input.rules ?? DefaultReviewRules;
  if (!rulesAreRegistered(rules)) {
    return Object.freeze({ kind: "rejected", candidateHash: candidate.data.candidateHash, reasons: Object.freeze<ReviewGateReason[]>([{ code: "invalid-rule-registry" }]) });
  }

  const reasons: ReviewGateReason[] = [];
  const parsed = {} as Record<ReviewKind, ChapterReview>;
  const issueIds = new Set<string>();
  const issues: (ReviewIssue & { readonly reviewKind: ReviewKind })[] = [];

  for (const rawReview of reviewList(input.reviews)) {
    const review = ChapterReviewSchema.safeParse(rawReview);
    if (!review.success) {
      reasons.push({ code: "invalid-review" });
      continue;
    }
    const value = review.data;
    if (parsed[value.reviewKind]) {
      reasons.push({ code: "duplicate-review-kind", reviewKind: value.reviewKind });
      continue;
    }
    parsed[value.reviewKind] = value;
    if (value.candidateHash !== candidate.data.candidateHash) reasons.push({ code: "candidate-hash-mismatch", reviewKind: value.reviewKind });
    const hasBlockingIssue = value.issues.some((issue) => issue.blocking);
    if (value.decision === "revise" && !hasBlockingIssue) reasons.push({ code: "revise-without-blocking-issue", reviewKind: value.reviewKind });
    if (value.decision === "pass" && hasBlockingIssue) reasons.push({ code: "pass-with-blocking-issue", reviewKind: value.reviewKind });
    for (const issue of value.issues) {
      if (issueIds.has(issue.issueId)) reasons.push({ code: "duplicate-issue-id", reviewKind: value.reviewKind, issueId: issue.issueId });
      issueIds.add(issue.issueId);
      if (!rules[value.reviewKind].includes(issue.ruleId)) reasons.push({ code: "unknown-rule", reviewKind: value.reviewKind, issueId: issue.issueId });
      if (!candidate.data.content.includes(issue.evidence)) reasons.push({ code: "evidence-not-in-candidate", reviewKind: value.reviewKind, issueId: issue.issueId });
      if (issue.fingerprint !== createReviewIssueFingerprint(value.reviewKind, issue)) reasons.push({ code: "invalid-issue-fingerprint", reviewKind: value.reviewKind, issueId: issue.issueId });
      issues.push({ ...issue, reviewKind: value.reviewKind });
    }
  }
  for (const reviewKind of ReviewKinds) {
    if (!parsed[reviewKind]) reasons.push({ code: "missing-review", reviewKind });
  }
  if (reasons.length > 0) {
    return Object.freeze({
      kind: "rejected",
      candidateHash: candidate.data.candidateHash,
      reasons: Object.freeze(reasons.sort((left, right) => `${left.code}:${left.reviewKind ?? ""}:${left.issueId ?? ""}`.localeCompare(`${right.code}:${right.reviewKind ?? ""}:${right.issueId ?? ""}`))),
    });
  }

  const aggregatedIssues = deduplicateIssues(issues);
  const result = {
    candidateHash: candidate.data.candidateHash,
    reviews: Object.freeze(parsed),
    issues: aggregatedIssues,
  };
  return Object.freeze(aggregatedIssues.some((issue) => issue.blocking)
    ? { kind: "revise" as const, ...result }
    : { kind: "approved-candidate" as const, ...result });
}
