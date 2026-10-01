import { ErrorText } from "../ui/ErrorText.tsx";
import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DreamChapterState, DreamModelOption, DreamSettings as DreamSettingsValue, MemorySuggestionSummary } from "@jizuo/memory-domain";
import { DreamChapterProgressList } from "./DreamChapterProgressList.tsx";
import { DreamSuggestionDetails } from "./DreamSuggestionDetails.tsx";
import type { DreamWorkRemote } from "./dreamRemote.ts";

export type DreamSuggestionSummary = MemorySuggestionSummary;
export type DreamSettingsRemote = DreamWorkRemote;

const EMPTY_SETTINGS: DreamSettingsValue = { enabled: false, dailyTokenLimit: 20_000, paused: false };
const STATUS_LABEL = { disabled: "未启用", waiting: "等待空闲", running: "正在整理", paused: "已暂停", paused_budget: "今日剩余额度不足", needs_model: "请选择梦境模型", error: "需要重试" } as const;
const COUNT_LABELS: Array<[DreamChapterState, string]> = [["graphed", "已入图"], ["graph_outdated", "已入图 · 正文有更新"], ["pending", "待处理"], ["partial", "待继续"], ["awaiting_review", "待确认"], ["failed", "失败"], ["busy", "对话处理中"], ["capacity_exceeded", "模型容量不足"], ["capacity_unknown", "模型容量未知"]];

function sameSettings(left: DreamSettingsValue, right: DreamSettingsValue): boolean {
  return left.enabled === right.enabled && left.dailyTokenLimit === right.dailyTokenLimit && left.paused === right.paused
    && left.skipUntil === right.skipUntil && left.modelSelection?.provider === right.modelSelection?.provider && left.modelSelection?.model === right.modelSelection?.model;
}

export function DreamSettings({ remote, showHeader = true }: { remote: DreamSettingsRemote; showHeader?: boolean }) {
  const [saved, setSaved] = useState<DreamSettingsValue>(EMPTY_SETTINGS);
  const [draft, setDraft] = useState<DreamSettingsValue>(EMPTY_SETTINGS);
  const [models, setModels] = useState<DreamModelOption[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(remote.listModels === undefined);
  const [report, setReport] = useState<Awaited<ReturnType<NonNullable<DreamSettingsRemote["getReport"]>>>>();
  const [legacyStatus, setLegacyStatus] = useState<Awaited<ReturnType<NonNullable<DreamSettingsRemote["getStatus"]>>>>();
  const [suggestions, setSuggestions] = useState<MemorySuggestionSummary[]>([]);
  const [sourceStates, setSourceStates] = useState<Record<string, "current" | "changed" | "missing">>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const generation = useRef(0);
  const status = report?.status ?? legacyStatus;

  const refreshSuggestions = async (expectedGeneration = generation.current) => { const items = await remote.listSuggestions(); if (generation.current === expectedGeneration) setSuggestions(items); };
  const refreshRuntime = async (expectedGeneration = generation.current) => {
    if (remote.getReport) { const value = await remote.getReport(); if (generation.current === expectedGeneration) setReport(value); }
    else if (remote.getStatus) { const value = await remote.getStatus(); if (generation.current === expectedGeneration) setLegacyStatus(value); }
  };

  useEffect(() => {
    const currentGeneration = ++generation.current; let active = true;
    const modelOptions = remote.listModels?.().catch(() => { if (active) setMessage("模型目录暂时无法加载，仍可关闭梦境记忆"); return [] as DreamModelOption[]; }) ?? Promise.resolve([]);
    Promise.all([remote.getSettings(), remote.listSuggestions(), modelOptions]).then(([settings, items, options]) => {
      if (!active) return;
      setSaved(settings); setDraft(settings); setSuggestions(items); setModels(options); setModelsLoaded(true);
    }, (error: unknown) => { if (active) setMessage(userErrorMessage(error, "梦境设置加载失败", { operation: "DreamSettings", effect: "read" })); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (generation.current === currentGeneration) generation.current += 1; };
  }, [remote]);

  useEffect(() => {
    if (!remote.getReport && !remote.getStatus) return;
    let pending = false; const currentGeneration = generation.current;
    const poll = async () => { if (pending) return; pending = true; try { await Promise.all([refreshRuntime(currentGeneration), refreshSuggestions(currentGeneration)]); } catch { if (generation.current === currentGeneration) setMessage("梦境状态暂时无法更新，请稍后重试"); } finally { pending = false; } };
    void poll(); const timer = setInterval(() => { void poll(); }, 5_000);
    return () => { clearInterval(timer); };
  }, [remote]);

  const selectedOption = useMemo(() => draft.modelSelection ? models.find((item) => item.provider === draft.modelSelection!.provider && item.model === draft.modelSelection!.model) : undefined, [draft.modelSelection, models]);
  const providers = useMemo(() => {
    const values = new Map(models.map((item) => [item.provider, item.providerName]));
    if (draft.modelSelection && !values.has(draft.modelSelection.provider)) values.set(draft.modelSelection.provider, `${draft.modelSelection.provider}（不可用）`);
    return Array.from(values.entries());
  }, [draft.modelSelection, models]);
  const providerModels = useMemo(() => {
    const values = models.filter((item) => item.provider === draft.modelSelection?.provider);
    if (draft.modelSelection && !values.some((item) => item.model === draft.modelSelection!.model)) values.push({ ...draft.modelSelection, providerName: draft.modelSelection.provider, modelName: `${draft.modelSelection.model}（不可用）`, available: false, unavailableReason: "原模型已不可用，请重新选择。" });
    return values;
  }, [draft.modelSelection, models]);
  const dirty = !sameSettings(saved, draft);
  const refreshModels = async () => {
    if (!remote.listModels) return; const currentGeneration = generation.current; setModelsLoaded(false); setMessage(undefined);
    try { const options = await remote.listModels(); if (generation.current === currentGeneration) { setModels(options); setModelsLoaded(true); } }
    catch { if (generation.current === currentGeneration) { setModelsLoaded(true); setMessage("模型目录暂时无法加载，仍可关闭梦境记忆"); } }
  };

  const persist = async (next: DreamSettingsValue, success?: string, preserveFormDraft = false) => {
    const currentGeneration = generation.current; setBusy(true); setMessage(undefined);
    try { const value = await remote.saveSettings(next); if (generation.current !== currentGeneration) return false; setSaved(value); setDraft((current) => preserveFormDraft ? { ...current, enabled: value.enabled, modelSelection: value.modelSelection } : value); await refreshRuntime(currentGeneration); if (generation.current === currentGeneration && success) setMessage(success); return true; }
    catch (error) { if (generation.current === currentGeneration) setMessage(userErrorMessage(error, "保存失败", { operation: "DreamSettings" })); return false; }
    finally { if (generation.current === currentGeneration) setBusy(false); }
  };
  const toggle = async (enabled: boolean) => {
    const option = draft.modelSelection ? models.find((item) => item.provider === draft.modelSelection!.provider && item.model === draft.modelSelection!.model) : undefined;
    if (enabled && remote.listModels && (!draft.modelSelection || (modelsLoaded && (!option || !option.available)))) { setMessage("请先选择一个可用的梦境模型"); return; }
    const next = enabled ? { ...saved, enabled, modelSelection: draft.modelSelection } : { ...saved, enabled };
    await persist(next, enabled ? "梦境记忆已启用" : "梦境记忆已关闭", true);
  };
  const save = async (event: FormEvent) => { event.preventDefault(); await persist(draft, "梦境设置已保存"); };
  const control = async (command: Parameters<NonNullable<DreamSettingsRemote["control"]>>[0]) => {
    if (!remote.control) return; const currentGeneration = generation.current; setBusy(true); setMessage(command === "run_now" ? "正在提交整理请求…" : undefined);
    try {
      await remote.control(command);
      if (generation.current !== currentGeneration) return;
      if (command === "run_now") setMessage("已提交立即整理请求，进度会自动更新；如需等待，原因会显示在上方。");
      const next = await remote.getSettings();
      if (generation.current !== currentGeneration) return;
      setSaved(next); setDraft(next); await refreshRuntime(currentGeneration);
    }
    catch { if (generation.current === currentGeneration) setMessage("梦境操作失败，请重试"); } finally { if (generation.current === currentGeneration) setBusy(false); }
  };
  const review = async (episodeKey: string, decision: "accept" | "reject") => {
    const currentGeneration = generation.current; setBusy(true); setMessage(undefined);
    try { if (decision === "accept") await remote.acceptSuggestion(episodeKey); else await remote.rejectSuggestion(episodeKey); await Promise.all([refreshSuggestions(currentGeneration), refreshRuntime(currentGeneration)]); if (generation.current === currentGeneration) setMessage(decision === "accept" ? "整章候选已进入正式记忆" : "整章候选已拒绝并保留记录"); }
    catch (error) { if (generation.current === currentGeneration) setMessage(userErrorMessage(error, "审核失败", { operation: "DreamSettings" })); } finally { if (generation.current === currentGeneration) setBusy(false); }
  };

  return <section className="jz-dream-settings" aria-label="梦境记忆设置" aria-busy={loading}>
    {showHeader && <header><div><p>Dream Memory</p><h2>梦境记忆</h2></div><span>{saved.enabled ? saved.paused ? "已暂停" : "已启用" : "默认关闭"}</span></header>}
    <p className="jz-dream-description">按整章整理正式图谱中尚无记忆的章节。模型容量不足或容量未知时会跳过本章，请更换梦境模型后重试。对话正在处理的章节会暂时跳过，其他章节可继续整理。有疑义的内容等待作者确认。</p>
    {status && <div className="jz-dream-runtime" aria-live="polite"><strong>{STATUS_LABEL[status.state]}</strong><span>{status.currentChapter ?? `已入图 ${status.completedChapters} 章 · 队列 ${status.pendingChapters} 章`}</span>{status.waitingReason && <small>{status.waitingReason}</small>}<progress aria-label="今日梦境额度" value={Math.min(status.dailyTokenLimit, status.usedTokens + status.reservedTokens)} max={status.dailyTokenLimit} /><small>今日已用 {status.usedTokens.toLocaleString()} / {status.dailyTokenLimit.toLocaleString()} Token{status.reservedTokens ? ` · 本次预留 ${status.reservedTokens.toLocaleString()}` : ""}</small>{status.state === "paused_budget" && <small>今日剩余额度不足，将在下个额度周期继续，也可以调整每日上限。</small>}{saved.skipUntil && Date.parse(saved.skipUntil) > Date.now() && <small>已跳过今晚，将在 {new Date(saved.skipUntil).toLocaleString()} 后继续。</small>}{status.lastError && <p role="alert">{<ErrorText error={status.lastError} operation="DreamSettings" />}</p>}{remote.control && <div className="jz-dream-controls"><IconButton icon="sparkles" label={"立即整理"} type="button" disabled={busy || !saved.enabled || status.state === "running" || status.state === "needs_model"} onClick={() => { void control("run_now"); }} /><IconButton icon={status.state === "paused" ? "play" : "pause"} label={(status.state === "paused" ? "继续整理" : "暂停")} type="button" disabled={busy || !saved.enabled} onClick={() => { void control(status.state === "paused" ? "resume" : "pause"); }} /><IconButton icon="right" label={"今晚跳过"} type="button" disabled={busy || !saved.enabled} onClick={() => { void control("skip_tonight"); }} /></div>}</div>}
    {message && <p className="jz-dream-message" role="status">{message}</p>}
    {report && <div className="jz-dream-counts" aria-label="章节状态概览">{COUNT_LABELS.map(([key, label]) => <div key={key}><strong>{report.counts[key] ?? 0}</strong><span>{label}</span></div>)}</div>}
    <form onSubmit={(event) => { void save(event); }}>
      <label className="jz-dream-switch"><input type="checkbox" checked={saved.enabled} disabled={loading || busy} onChange={(event) => { void toggle(event.target.checked); }} /><span>启用梦境记忆</span></label>
      {remote.listModels && <><label><span>模型服务方</span><select aria-label="梦境模型服务方" value={draft.modelSelection?.provider ?? ""} onChange={(event) => { const provider = event.target.value; setDraft({ ...draft, modelSelection: provider ? { provider, model: "" } : undefined }); }}><option value="">请选择服务方</option>{providers.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>模型</span><select aria-label="梦境模型" value={draft.modelSelection?.model ?? ""} disabled={!draft.modelSelection?.provider} onChange={(event) => { if (draft.modelSelection) setDraft({ ...draft, modelSelection: { ...draft.modelSelection, model: event.target.value } }); }}><option value="">请选择模型</option>{providerModels.map((item) => <option key={item.model} value={item.model} disabled={!item.available}>{item.modelName}{item.available ? "" : item.modelName.endsWith("（不可用）") ? "" : "（不可用）"}</option>)}</select></label><IconButton icon="reset" label={(modelsLoaded ? "刷新模型列表" : "刷新中…")} type="button" disabled={!modelsLoaded || busy} onClick={() => { void refreshModels(); }} /></>}
      {draft.modelSelection && modelsLoaded && remote.listModels && (!selectedOption || !selectedOption.available) && <p className="jz-dream-model-warning" role="alert">{selectedOption?.unavailableReason ?? "原模型已不可用，请重新选择。"}</p>}
      <label><span>每日 Token 上限</span><input aria-label="每日 Token 上限" type="number" min="1000" step="1000" value={draft.dailyTokenLimit} onChange={(event) => { setDraft({ ...draft, dailyTokenLimit: Math.max(1, Number(event.target.value)) }); }} /></label>
      <IconButton icon="save" label={"保存模型与额度"} type="submit" disabled={loading || busy || !dirty} />{dirty && <small className="jz-dream-dirty">有未保存更改</small>}
    </form>
    {report && <DreamChapterProgressList chapters={report.chapters} getConversations={remote.getConversations} />}
    <div className="jz-dream-suggestions"><h3>待确认推断</h3>{suggestions.length === 0 ? <p>没有待确认建议。</p> : <ul>{suggestions.map((item) => <li key={item.episodeKey}><div className="jz-dream-suggestion-main"><small>{[item.volumeTitle, item.chapterTitle ?? (item.chapterNumber ? `第 ${item.chapterNumber} 章` : undefined)].filter(Boolean).join(" · ")}</small><p>{item.summary}</p><small>{item.identityCount ?? 0} 个对象 · {item.stateCount ?? 0} 条状态 · {item.edgeCount ?? 0} 条关系</small>{remote.getSuggestion ? <DreamSuggestionDetails load={() => remote.getSuggestion!(item.episodeKey)} onSourceState={(state) => { setSourceStates((current) => ({ ...current, [item.episodeKey]: state })); }} /> : item.details ? <details><summary>查看候选记忆与原文</summary><p>{item.details}</p></details> : null}</div><div className="jz-dream-review"><small>按钮将审核整章候选</small><IconButton icon="apply" label={"接受整章候选"} type="button" disabled={busy || (sourceStates[item.episodeKey] !== undefined && sourceStates[item.episodeKey] !== "current")} onClick={() => { void review(item.episodeKey, "accept"); }} /><IconButton icon="close" label={"拒绝整章候选"} type="button" disabled={busy} onClick={() => { void review(item.episodeKey, "reject"); }} /></div></li>)}</ul>}</div>
  </section>;
}
