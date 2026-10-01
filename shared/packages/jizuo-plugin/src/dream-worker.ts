import { randomUUID } from "node:crypto";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { BudgetSnapshot } from "@jizuo/memory-domain";
import { DreamMemoryHost } from "./dream-host.ts";
import { DreamIpcPeer, type DreamIpcTransport } from "./dream-ipc.ts";
import { createDreamModel } from "./dream-model.ts";
import { JizuoService } from "./service.ts";

if (!process.send) throw new Error("Dream worker requires its parent IPC channel");
let host: DreamMemoryHost | undefined;
let service: JizuoService | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let publishing = false;
const subscriptions = new Set<string>();
const busy = new Map<string, Set<string>>();
const mutations = new Map<string, () => void>();
const reservations = new Map<string, { id: string; date: string }>();
let activeReservation: string | undefined;
const peer = new DreamIpcPeer(process as DreamIpcTransport, async (method, input) => {
  if (method === "init") {
    if (host) throw new Error("Dream worker already initialized");
    service = new JizuoService({ worksRoot: input.worksRoot, settingsRoot: input.settingsRoot });
    service.saveDreamSettings = (value) => peer.call("settings", value);
    service.saveDreamChapterMemory = async (value, selection, signal, beforeCommit) => {
      await beforeCommit(); signal.throwIfAborted();
      return peer.call("commit", { ...value, selection }, { signal });
    };
    const stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      const { signal, ...request } = options;
      const streamId = await peer.call<string>("stream.open", { request, reservationId: activeReservation }, signal ? { signal } : {});
      try {
        for (;;) {
          const result = await peer.call<IteratorResult<StreamChunk>>("stream.next", { streamId }, { ...(signal ? { signal } : {}), timeoutMs: 180_000 });
          if (result.done) return;
          yield result.value;
        }
      } finally { peer.event("stream.close", { streamId }); }
    };
    host = new DreamMemoryHost(service, { prepare: async (selection) => createDreamModel({ ...await peer.call<{ selection: typeof selection; maxOutputTokens?: number; contextWindow?: number }>("model.describe", selection), stream }) }, {
      getBusyChapterIds: (workId) => busy.get(workId) ?? new Set(),
      isChapterAvailable: (workId, chapterId) => peer.call("chapter.available", { workId, chapterId }),
      budgetFactory: (workRoot) => ({
        get: (date) => peer.call<BudgetSnapshot>("budget.get", { workRoot, date }),
        reserve: async (tokens, limit, date) => {
          const id = randomUUID();
          const reserved = await peer.call<boolean>("budget.reserve", { workRoot, tokens, limit, date, id });
          if (reserved) { reservations.set(workRoot, { id, date: date ?? new Date().toISOString().slice(0, 10) }); activeReservation = id; }
          return reserved;
        },
        settle: async (_reserved, actual, date) => {
          const request = reservations.get(workRoot) ?? [...reservations.values()].find((item) => item.id === activeReservation);
          if (!request) throw new Error("梦境额度请求记录不存在");
          const result = await peer.call<BudgetSnapshot>("budget.settle", { id: request.id, actual, date: date ?? request.date });
          for (const [root, entry] of reservations) if (entry.id === request.id) reservations.delete(root);
          activeReservation = undefined; return result;
        },
      }),
    });
    service.dreamHost = host;
    timer = setInterval(() => { void publish(); }, 1000); timer.unref();
    host.start(); return { pid: process.pid };
  }
  if (!host || !service) throw new Error("梦境后台尚未初始化");
  if (method === "report") { subscriptions.add(input.workId); return host.report(input.workId); }
  if (method === "conversations") return host.conversations(input);
  if (method === "command") { await host.command(input.command, input.workId); void publish(); return { saved: true }; }
  if (method === "mutation.begin") {
    let acknowledge!: () => void;
    const ready = new Promise<void>((resolve) => { acknowledge = resolve; });
    const gate = new Promise<void>((resolve) => mutations.set(input.workId, resolve));
    void host.withWorkMutation(input.workId, async () => { acknowledge(); await gate; }).catch(() => {});
    await ready; return true;
  }
  throw new Error(`Unknown dream worker method: ${method}`);
}, (method, input) => {
  if (method === "shutdown") { shutdown(); return; }
  if (method === "busy") { for (const [id, chapters] of Object.entries(input as Record<string, string[]>)) { busy.set(id, new Set(chapters)); host?.chapterAvailabilityChanged(id); } return; }
  if (method === "touch") host?.touch(input.workId, input.chapterId);
  if (method === "invalidate") host?.invalidate(input.workId);
  if (method === "settingsChanged") host?.settingsChanged(input.workId);
  if (method === "mutation.end") { mutations.get(input.workId)?.(); mutations.delete(input.workId); }
});
async function publish() {
  if (publishing || !host || !service) return; publishing = true;
  try {
    for (const workId of subscriptions) {
      try { peer.event("report", await host.report(workId)); }
      catch (error) { peer.event("reportError", { workId, message: error instanceof Error ? error.message : "读取梦境状态失败" }); }
    }
  } finally { publishing = false; }
}
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  host?.close(); if (timer) clearInterval(timer);
  for (const release of mutations.values()) release();
  const finish = () => { peer.close(); process.exit(0); };
  const deadline = setTimeout(finish, 1800); deadline.unref();
  // Keep IPC alive long enough to settle usage and flush the latest response.
  void (host?.drain() ?? Promise.resolve()).finally(finish);
}
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
