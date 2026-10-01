/**
 * The code-owned resource manifest for every Harness worker this workflow may
 * invoke. Hashes name the shipped resources, not abbreviated copies of them.
 */
import { WorkflowOutputSchemaManifest } from "./outputSchemaManifest.ts";

function workerSchema(id: keyof typeof WorkflowOutputSchemaManifest) {
  const binding = WorkflowOutputSchemaManifest[id];
  if (!binding) throw new Error(`Missing output schema manifest binding: ${id}`);
  return Object.freeze({ outputSchemaId: id, outputSchemaVersion: binding.version, outputSchemaHash: binding.harnessSchemaHash });
}

export const WorkflowHarnessManifest = Object.freeze({
  workflow: Object.freeze({
    path: "runtime/workflows/chapter-production.json",
    sha256: "d908d90fd8e67e0e67676b0c241a7424147531b49243046163b45c796d364930",
  }),
  team: Object.freeze({
    path: "runtime/teams/novel-team.yaml",
    sha256: "29cd25b94841d174052f139fc33446ccb4ff2a13666d75b7f976e90668dc0ca9",
  }),
  skill: Object.freeze({
    id: "novel-workflow",
    path: "runtime/skills/novel-workflow/SKILL.md",
    sha256: "bda9d2bf52c6bcc074df7911d6ae36ee159900ddae3352f1712ee87590a1b24d",
  }),
  skills: Object.freeze({
    worldbuilding: Object.freeze({
      path: "runtime/skills/worldbuilding/SKILL.md",
      sha256: "40ecff01be5e00f3f8314a2f86652ec969e2cd7488bb12bbe0e0ef5284c30cc8",
    }),
    style: Object.freeze({
      path: "runtime/skills/style/SKILL.md",
      sha256: "ab2e7b82487adb00677abea7f8f9015fb0df50461b950abaa4290c38291d7556",
    }),
  }),
  workers: Object.freeze({
    "outline-planner": Object.freeze({ persona: Object.freeze({ path: "runtime/agents/outline-planner.md", sha256: "468d743672b8a81ffc75ae47f389569eaab62a13ac5a420c1aba094cd5a09567" }), skills: Object.freeze(["worldbuilding", "style"] as const), ...workerSchema("chapter-plan.v1"), artifactKind: "plan" as const }),
    "novel-writer": Object.freeze({ persona: Object.freeze({ path: "runtime/agents/novel-writer.md", sha256: "9cd75db1bf7dc3a2503a8296ba3e784417cf3f93f8b37550b44cc024f2d7be7f" }), skills: Object.freeze(["worldbuilding", "style"] as const), ...workerSchema("chapter-candidate.v1"), artifactKind: "candidate" as const }),
    "continuity-reviewer": Object.freeze({ persona: Object.freeze({ path: "runtime/agents/continuity-reviewer.md", sha256: "5972cb3b0bf97711497678fd9478ef89988a6f730c2fddfc1418977e8ca102c6" }), skills: Object.freeze(["worldbuilding"] as const), ...workerSchema("chapter-review.v1"), artifactKind: "review" as const, reviewKind: "continuity" as const }),
    "style-reviewer": Object.freeze({ persona: Object.freeze({ path: "runtime/agents/style-reviewer.md", sha256: "0dcae188a60057d25632c6966201dafb80d13a5fde943375b1a628fa07ed8001" }), skills: Object.freeze(["style"] as const), ...workerSchema("chapter-review.v1"), artifactKind: "review" as const, reviewKind: "style" as const }),
    "ai-trace-reviewer": Object.freeze({ persona: Object.freeze({ path: "runtime/agents/ai-trace-reviewer.md", sha256: "b5f376b78916762d8a4df96abe7be9d5b57d17accdf01a67630c26c98327f169" }), skills: Object.freeze(["style"] as const), ...workerSchema("chapter-review.v1"), artifactKind: "review" as const, reviewKind: "ai-trace" as const }),
    "memory-extractor": Object.freeze({ persona: Object.freeze({ path: "runtime/agents/memory-extractor.md", sha256: "39b7aed4ffbe1ea4c7fb1505c882e6d7dba67df4b3f380d77d314e8516ad56ca" }), skills: Object.freeze(["worldbuilding", "style"] as const), ...workerSchema("chapter-memory.v2"), artifactKind: "memory" as const }),
  }),
});

export type WorkflowHarnessWorkerId = keyof typeof WorkflowHarnessManifest.workers;
export type WorkflowHarnessWorkerManifest = (typeof WorkflowHarnessManifest.workers)[WorkflowHarnessWorkerId];
