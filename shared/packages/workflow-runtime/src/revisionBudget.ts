export const DEFAULT_REVISION_BUDGET = 5;
export const HARD_MAX_REVISION_BUDGET = 10;
export const MAX_SCHEMA_REPAIRS = 2;

export type RevisionBudgetStatus = "reviewing" | "waiting_decision" | "blocked";
export type RevisionBudgetEvent = Readonly<{ kind: "initial" | "manual_extension" | "no_progress_recovery"; delta: number; reason: string }>;

export interface RevisionBudgetState {
  readonly revisionRound: number;
  readonly maxRevisionRounds: number;
  readonly schemaRepairAttempts: number;
  readonly noProgressRounds: number;
  readonly status: RevisionBudgetStatus;
  readonly events: readonly RevisionBudgetEvent[];
}

export interface RevisionQualitySnapshot {
  readonly decision: "approved-candidate" | "revise";
  readonly blockingIssueFingerprints: readonly string[];
  readonly score: number;
}

export type RevisionProgressDecision =
  | Readonly<{ kind: "approved"; revisionRound: number; noProgressRounds: 0 }>
  | Readonly<{ kind: "revise"; nextRevisionRound: number; noProgressRounds: number }>
  | Readonly<{ kind: "waiting_decision"; revisionRound: number; noProgressRounds: 2; reason: "no-review-progress" }>
  | Readonly<{ kind: "continue_with_warnings"; revisionRound: number; reason: "revision-budget-exhausted" }>;

export interface EvaluateRevisionProgressInput {
  readonly revisionRound: number;
  readonly maxRevisionRounds: number;
  readonly noProgressRounds: number;
  readonly previous?: RevisionQualitySnapshot;
  readonly current: RevisionQualitySnapshot;
}

export type RevisionBudgetExtension =
  | Readonly<{ kind: "extended"; maxRevisionRounds: number; event: RevisionBudgetEvent }>
  | Readonly<{ kind: "rejected"; reason: "invalid-revision-budget-extension" | "revision-budget-at-hard-maximum" }>;

function assertBudget(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > HARD_MAX_REVISION_BUDGET) throw new RangeError("Revision budget must be an integer from 1 through 10");
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

export function createInitialRevisionBudget(maxRevisionRounds = DEFAULT_REVISION_BUDGET): RevisionBudgetState {
  assertBudget(maxRevisionRounds);
  return Object.freeze({
    revisionRound: 0,
    maxRevisionRounds,
    schemaRepairAttempts: 0,
    noProgressRounds: 0,
    status: "reviewing",
    events: Object.freeze<RevisionBudgetEvent[]>([{ kind: "initial", delta: maxRevisionRounds, reason: "Initial revision budget" }]),
  });
}

export function evaluateRevisionProgress(input: EvaluateRevisionProgressInput): RevisionProgressDecision {
  assertBudget(input.maxRevisionRounds);
  if (!Number.isInteger(input.revisionRound) || input.revisionRound < 0 || input.revisionRound > HARD_MAX_REVISION_BUDGET) throw new RangeError("Invalid revision round");
  if (!Number.isInteger(input.noProgressRounds) || input.noProgressRounds < 0 || input.noProgressRounds > 2) throw new RangeError("Invalid no-progress round count");
  if (input.current.decision === "approved-candidate") return Object.freeze({ kind: "approved", revisionRound: input.revisionRound, noProgressRounds: 0 });
  if (input.revisionRound >= input.maxRevisionRounds) return Object.freeze({ kind: "continue_with_warnings", revisionRound: input.revisionRound, reason: "revision-budget-exhausted" });

  const improved = input.previous === undefined
    || uniqueCount(input.current.blockingIssueFingerprints) < uniqueCount(input.previous.blockingIssueFingerprints)
    || input.current.score > input.previous.score;
  const noProgressRounds = improved ? 0 : input.noProgressRounds + 1;
  if (noProgressRounds >= 2) return Object.freeze({ kind: "waiting_decision", revisionRound: input.revisionRound, noProgressRounds: 2, reason: "no-review-progress" });
  return Object.freeze({ kind: "revise", nextRevisionRound: input.revisionRound + 1, noProgressRounds });
}

export function extendRevisionBudget(input: { readonly status: RevisionBudgetStatus; readonly maxRevisionRounds: number; readonly amount: number }): RevisionBudgetExtension {
  assertBudget(input.maxRevisionRounds);
  if (input.amount !== 2 || (input.status !== "waiting_decision" && input.status !== "blocked")) {
    return Object.freeze({ kind: "rejected", reason: "invalid-revision-budget-extension" });
  }
  if (input.maxRevisionRounds === HARD_MAX_REVISION_BUDGET) return Object.freeze({ kind: "rejected", reason: "revision-budget-at-hard-maximum" });
  if (input.maxRevisionRounds + input.amount > HARD_MAX_REVISION_BUDGET) return Object.freeze({ kind: "rejected", reason: "revision-budget-at-hard-maximum" });
  const maxRevisionRounds = input.maxRevisionRounds + input.amount;
  return Object.freeze({
    kind: "extended",
    maxRevisionRounds,
    event: Object.freeze({ kind: "manual_extension", delta: maxRevisionRounds - input.maxRevisionRounds, reason: "Manual revision budget extension" }),
  });
}

export function recordSchemaRepairAttempt(input: { readonly revisionRound: number; readonly schemaRepairAttempts: number }):
  | Readonly<{ kind: "repair"; revisionRound: number; schemaRepairAttempts: number }>
  | Readonly<{ kind: "failed"; revisionRound: number; schemaRepairAttempts: number; reason: "schema-repair-limit-exhausted" }> {
  if (!Number.isInteger(input.revisionRound) || input.revisionRound < 0 || input.revisionRound > HARD_MAX_REVISION_BUDGET) throw new RangeError("Invalid revision round");
  if (!Number.isInteger(input.schemaRepairAttempts) || input.schemaRepairAttempts < 0 || input.schemaRepairAttempts > MAX_SCHEMA_REPAIRS) throw new RangeError("Invalid schema repair attempt count");
  if (input.schemaRepairAttempts >= MAX_SCHEMA_REPAIRS) return Object.freeze({ kind: "failed", revisionRound: input.revisionRound, schemaRepairAttempts: MAX_SCHEMA_REPAIRS, reason: "schema-repair-limit-exhausted" });
  return Object.freeze({ kind: "repair", revisionRound: input.revisionRound, schemaRepairAttempts: input.schemaRepairAttempts + 1 });
}
