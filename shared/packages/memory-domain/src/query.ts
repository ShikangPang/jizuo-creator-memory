import { projectMemoryGraph } from "./projection.ts";
import type { MemoryRepository } from "./repository.ts";
import { MemoryQuery, type MemoryGraph, type MemoryQueryInput } from "./types.ts";

export interface MemoryQueryOptions {
  readonly maximumChapter?: number;
}

export class MemoryQueryService {
  private readonly cache = new Map<string, MemoryGraph>();

  constructor(private readonly repository: MemoryRepository) {}

  async queryMemory(rawQuery: MemoryQueryInput, options: MemoryQueryOptions = {}): Promise<MemoryGraph> {
    const query = MemoryQuery.parse(rawQuery);
    if (options.maximumChapter !== undefined && (!Number.isInteger(options.maximumChapter) || options.maximumChapter < 1)) {
      throw new RangeError("maximumChapter must be a positive integer");
    }
    const { identities, states, edges, evidence, revision } = await this.repository.readSnapshot();
    const cacheKey = JSON.stringify({ query, maximumChapter: options.maximumChapter, revision, sourceStates: ["confirmed"] });
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const graph = projectMemoryGraph({
      query,
      identities,
      states,
      edges,
      evidence,
      revision,
      ...(options.maximumChapter === undefined ? {} : { maximumChapter: options.maximumChapter }),
    });
    this.cache.set(cacheKey, graph);
    if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    return graph;
  }
}
