import type { MemoryKind, MemoryRoom } from "./types.ts";

export function roomFor(kind: MemoryKind): MemoryRoom {
  switch (kind) {
    case "character": return "characters";
    case "rule":
    case "organization":
    case "worldbuilding": return "world";
    case "clue":
    case "location":
    case "object": return "clues";
    case "event": return "plot";
    case "style": return "style";
  }
}
