import type { DreamChapterState } from "./types.ts";

export interface DreamChapterFacts {
  hasFormalMemory: boolean;
  formalRevisionMatches: boolean;
  source: "saved" | "empty" | "editing";
  attempt: "none" | "running" | "partial" | "awaiting_review" | "rejected" | "no_facts" | "failed";
}

/** Shared by scheduling and reporting; graph coverage never depends on a UI filter. */
export function classifyDreamChapter(facts: DreamChapterFacts): DreamChapterState {
  if (facts.hasFormalMemory) return facts.formalRevisionMatches ? "graphed" : "graph_outdated";
  if (facts.source !== "saved") return facts.source;
  return facts.attempt === "none" ? "pending" : facts.attempt;
}
