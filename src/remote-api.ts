import type { DreamCommand, DreamSettings, MemoryQueryInput } from "@jizuo/memory-domain";

import { JizuoError } from "@jizuo/contracts";

import type { JizuoService } from "../../jizuo-plugin/src/service.ts";

import type { DreamModelCatalog } from "../../jizuo-plugin/src/dream-model-catalog.ts";

/** Feature-owned handlers; the core RPC namespace delegates here for compatibility. */
export class MemoryRemoteApi {
  constructor(readonly domain: JizuoService, private readonly dreamModels?: Pick<DreamModelCatalog, "list">) {}
  async queryMemory(request: MemoryQueryInput, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.queryMemory(request);
  }

  async getDreamStatus(request: { workId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.dreamHost) throw new JizuoError("validation_error", "梦境服务尚未启动");
    return this.domain.dreamHost.status(request.workId);
  }

  async getDreamReport(request: { workId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.dreamHost) throw new JizuoError("runtime_unavailable", "梦境服务尚未启动");
    return this.domain.dreamHost.report(request.workId);
  }

  async getDreamConversations(request: { workId: string; volumeId: string; chapterId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.dreamHost) throw new JizuoError("runtime_unavailable", "梦境服务尚未启动");
    return this.domain.dreamHost.conversations(request);
  }

  async listDreamModels(_request: Record<string, never>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.dreamModels) throw new JizuoError("runtime_unavailable", "梦境模型目录尚未就绪");
    return this.dreamModels.list();
  }

  async getMemorySuggestion(request: { workId: string; episodeKey: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.getMemorySuggestion(request);
  }

  async controlDream(request: { workId?: string; command: DreamCommand }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.domain.dreamHost) throw new JizuoError("validation_error", "梦境服务尚未启动");
    return this.domain.dreamHost.command(request.command, request.workId);
  }

  async touchDreamActivity(request: { workId: string; chapterId?: string }, signal: AbortSignal): Promise<{ saved: true }> {
    signal.throwIfAborted();
    this.domain.dreamHost?.touch(request.workId, request.chapterId);
    return { saved: true };
  }

  async getDreamSettings(request: { workId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.getDreamSettings(request.workId);
  }

  async saveDreamSettings(request: { workId: string } & DreamSettings, signal: AbortSignal) {
    signal.throwIfAborted();
    const { workId, ...settings } = request;
    return this.domain.saveDreamSettings({ workId, settings });
  }

  async listMemorySuggestions(request: { workId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.listMemorySuggestions(request.workId);
  }

  async acceptMemorySuggestion(request: { workId: string; episodeKey: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.acceptMemorySuggestion(request);
  }

  async rejectMemorySuggestion(request: { workId: string; episodeKey: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.domain.rejectMemorySuggestion(request);
  }
}
