import { z } from "zod";

import { deepFreeze, sha256 } from "./hash.ts";
import {
  ChapterCandidateOutputSchema,
  ChapterMemoryOutputSchema,
  ChapterMemoryOutputSchemaV2,
  ChapterPlanOutputSchema,
  ChapterReviewOutputSchemaV1,
} from "./outputSchemas.ts";

/** Frozen JSON-Schema subset retained as an integrity contract for graph data. */
export interface HarnessJsonSchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly properties?: Readonly<Record<string, HarnessJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: HarnessJsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly oneOf?: readonly HarnessJsonSchema[];
}

export interface WorkflowOutputSchemaBinding {
  readonly id: string;
  readonly version: 1;
  readonly parser: z.ZodType;
  readonly harnessSchema: Readonly<HarnessJsonSchema>;
  readonly harnessSchemaHash: string;
}

function binding(id: string, parser: z.ZodType, harnessSchema: HarnessJsonSchema): WorkflowOutputSchemaBinding {
  const frozenSchema = deepFreeze(harnessSchema);
  return Object.freeze({ id, version: 1 as const, parser, harnessSchema: frozenSchema, harnessSchemaHash: sha256(frozenSchema) });
}

/**
 * The sole mapping between each durable Zod parser and its frozen JSON shape.
 * Model workers reply with ordinary text; the host derives this control data
 * and validates it before persistence. The canonical hash prevents the graph
 * contract from silently drifting while ID and version remain unchanged.
 */
export const WorkflowOutputSchemaManifest: Readonly<Record<string, WorkflowOutputSchemaBinding>> = Object.freeze({
  "chapter-plan.v1": binding("chapter-plan.v1", ChapterPlanOutputSchema, {
    type: "object", properties: {
      title: { type: "string" }, intent: { type: "string" },
      beats: { type: "array", items: { type: "object", properties: { order: { type: "integer" }, summary: { type: "string" } }, required: ["order", "summary"], additionalProperties: false } },
      constraints: { type: "array", items: { type: "string" } },
    }, required: ["title", "intent", "beats", "constraints"], additionalProperties: false,
  }),
  "chapter-candidate.v1": binding("chapter-candidate.v1", ChapterCandidateOutputSchema, {
    type: "object", properties: { candidateHash: { type: "string" }, content: { type: "string" } }, required: ["candidateHash", "content"], additionalProperties: false,
  }),
  "chapter-review.v1": binding("chapter-review.v1", ChapterReviewOutputSchemaV1, {
    type: "object", properties: {
      reviewKind: { type: "string", enum: ["continuity", "style", "ai-trace"] }, candidateHash: { type: "string" }, decision: { type: "string", enum: ["pass", "revise"] }, score: { type: "number" },
      issues: { type: "array", items: { type: "object", properties: { issueId: { type: "string" }, ruleId: { type: "string" }, severity: { type: "string", enum: ["critical", "major", "minor", "info"] }, evidence: { type: "string" }, requirement: { type: "string" }, blocking: { type: "boolean" }, fingerprint: { type: "string" } }, required: ["issueId", "ruleId", "severity", "evidence", "requirement", "blocking", "fingerprint"], additionalProperties: false } },
    }, required: ["reviewKind", "candidateHash", "decision", "score", "issues"], additionalProperties: false,
  }),
  "chapter-approved-candidate.v1": binding("chapter-approved-candidate.v1", ChapterCandidateOutputSchema, {
    type: "object", properties: { candidateHash: { type: "string" }, content: { type: "string" } }, required: ["candidateHash", "content"], additionalProperties: false,
  }),
  "chapter-memory.v1": binding("chapter-memory.v1", ChapterMemoryOutputSchema, {
    type: "object", properties: { facts: { type: "array", items: { type: "object", properties: { subject: { type: "string" }, predicate: { type: "string" }, object: { type: "string" }, evidence: { type: "string" } }, required: ["subject", "predicate", "object", "evidence"], additionalProperties: false } } }, required: ["facts"], additionalProperties: false,
  }),
  "chapter-memory.v2": binding("chapter-memory.v2", ChapterMemoryOutputSchemaV2, {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                factKind: { type: "string", enum: ["state"] },
                subject: memoryIdentitySchemaV2(),
                predicate: { type: "string" },
                value: { type: "string" },
                evidence: { type: "string" },
              },
              required: ["factKind", "subject", "predicate", "value", "evidence"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                factKind: { type: "string", enum: ["relation"] },
                subject: memoryIdentitySchemaV2(),
                predicate: { type: "string" },
                object: memoryIdentitySchemaV2(),
                evidence: { type: "string" },
              },
              required: ["factKind", "subject", "predicate", "object", "evidence"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ["facts"],
    additionalProperties: false,
  }),
});

function memoryIdentitySchemaV2(): HarnessJsonSchema {
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      kind: { type: "string", enum: ["character", "rule", "organization", "worldbuilding", "clue", "location", "object", "event", "style"] },
      aliases: { type: "array", items: { type: "string" } },
    },
    required: ["name", "kind", "aliases"],
    additionalProperties: false,
  };
}

export function outputSchemaBinding(id: string): WorkflowOutputSchemaBinding | undefined {
  return WorkflowOutputSchemaManifest[id];
}
