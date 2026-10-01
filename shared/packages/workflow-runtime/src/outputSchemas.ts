import { z } from "zod";

export const ReviewKinds = ["continuity", "style", "ai-trace"] as const;
export type ReviewKind = typeof ReviewKinds[number];

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ShortText = z.string().trim().min(1).max(4_000);

export const ChapterPlanSchema = z.object({
  title: ShortText,
  intent: ShortText,
  beats: z.array(z.object({ order: z.number().int().min(1), summary: ShortText }).strict()).min(1).max(64),
  constraints: z.array(ShortText).max(64),
}).strict();

/** Candidate prose is an agent output only; the graph state retains its artifact reference and hash. */
export const ChapterCandidateSchema = z.object({
  candidateHash: ContentHashSchema,
  content: z.string().min(1).max(1_000_000),
}).strict();

export const ReviewIssueSchema = z.object({
  issueId: z.string().trim().min(1).max(128),
  ruleId: z.string().trim().min(1).max(128),
  severity: z.enum(["critical", "major", "minor", "info"]),
  evidence: z.string().trim().min(1).max(4_000),
  requirement: ShortText,
  blocking: z.boolean(),
  fingerprint: ContentHashSchema,
}).strict();

export const ChapterReviewSchema = z.object({
  reviewKind: z.enum(ReviewKinds),
  candidateHash: ContentHashSchema,
  decision: z.enum(["pass", "revise"]),
  score: z.number().finite().min(0).max(1),
  issues: z.array(ReviewIssueSchema).max(128),
}).strict();

export const ChapterMemorySchema = z.object({
  facts: z.array(z.object({
    subject: ShortText,
    predicate: ShortText,
    object: ShortText,
    evidence: ShortText,
  }).strict()).max(256),
}).strict();

export const ChapterMemoryKinds = [
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

export const ChapterMemoryIdentitySchemaV2 = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(ChapterMemoryKinds),
  aliases: z.array(z.string().trim().min(1).max(120)).max(32).default([]),
}).strict();

const ChapterMemoryFactBaseSchemaV2 = z.object({
  subject: ChapterMemoryIdentitySchemaV2,
  predicate: z.string().trim().min(1).max(80),
  evidence: z.string().trim().min(1).max(500),
});

export const ChapterMemoryFactSchemaV2 = z.discriminatedUnion("factKind", [
  ChapterMemoryFactBaseSchemaV2.extend({
    factKind: z.literal("state"),
    value: z.string().trim().min(1).max(500),
  }).strict(),
  ChapterMemoryFactBaseSchemaV2.extend({
    factKind: z.literal("relation"),
    object: ChapterMemoryIdentitySchemaV2,
  }).strict(),
]);

export const ChapterMemorySchemaV2 = z.object({
  facts: z.array(ChapterMemoryFactSchemaV2).max(256),
}).strict();

export type ChapterPlan = z.infer<typeof ChapterPlanSchema>;
export type ChapterCandidate = z.infer<typeof ChapterCandidateSchema>;
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type ChapterReview = z.infer<typeof ChapterReviewSchema>;
export type ChapterMemory = z.infer<typeof ChapterMemorySchema>;
export type ChapterMemoryIdentityV2 = z.infer<typeof ChapterMemoryIdentitySchemaV2>;
export type ChapterMemoryFactV2 = z.infer<typeof ChapterMemoryFactSchemaV2>;
export type ChapterMemoryV2 = z.infer<typeof ChapterMemorySchemaV2>;

export const ChapterPlanOutputSchema = ChapterPlanSchema;
export const ChapterCandidateOutputSchema = ChapterCandidateSchema;
export const ChapterReviewOutputSchemaV1 = ChapterReviewSchema;
export const ChapterMemoryOutputSchema = ChapterMemorySchema;
export const ChapterMemoryOutputSchemaV2 = ChapterMemorySchemaV2;
