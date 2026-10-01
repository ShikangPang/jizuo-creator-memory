import type { MemoryGraphEdge } from "@jizuo/memory-domain";

export type MemoryGraphSelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

export function memoryEdgeElementId(edge: MemoryGraphEdge): string {
  return `${edge.id}-${edge.chapterNumber}`;
}
