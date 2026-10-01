import { useEffect, useState } from "react";
import type { DreamActivityPhase, DreamChapterActivity } from "@jizuo/memory-domain";

const PHASES: Record<DreamActivityPhase, string> = {
  preparing: "准备章节与模型", reading: "读取分段并检查额度", waiting_model: "等待模型响应",
  generating: "模型正在生成记忆", validating: "校验记忆格式与原文证据",
  saving_segment: "保存分段结果", saving_memory: "保存章节记忆",
};
const CHAPTER_PHASES: Record<DreamActivityPhase, string> = {
  preparing: "准备章节与模型", reading: "读取整章并检查模型容量与额度", waiting_model: "等待模型响应",
  generating: "模型正在生成整章记忆", validating: "校验整章记忆与原文证据",
  saving_segment: "保存整章结果", saving_memory: "最终入库：保存章节记忆",
};
function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}

export function DreamActivityDetails({ activity, totalParts }: { activity: DreamChapterActivity; totalParts: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [activity.startedAt]);
  const phaseElapsed = now - Date.parse(activity.phaseStartedAt);
  const lastResponse = now - Date.parse(activity.lastActivityAt);
  const modelActive = activity.phase === "waiting_model" || activity.phase === "generating";
  const wholeChapter = activity.processingMode === "chapter";
  const phases = wholeChapter ? CHAPTER_PHASES : PHASES;
  return <section className="jz-dream-live" aria-label="当前整理活动">
    <div className="jz-dream-live-heading">
      <strong role="status"><span className="jz-dream-live-dot" aria-hidden="true" />{phases[activity.phase]}</strong>
      <span>当前阶段 {duration(phaseElapsed)}</span>
    </div>
    <div className="jz-dream-live-meta">
      {activity.to > activity.from && <span>{wholeChapter ? `整章正文 ${(activity.to - activity.from).toLocaleString("zh-CN")} 字符` : `历史分段 · 第 ${activity.part}/${totalParts} 段 · 正文 ${(activity.from + 1).toLocaleString("zh-CN")}–${activity.to.toLocaleString("zh-CN")} 字符`}</span>}
      {activity.modelSelection && <span>{activity.modelSelection.provider} / {activity.modelSelection.model}</span>}
      <span>本次本章已用 {duration(now - Date.parse(activity.startedAt))}</span>
    </div>
    {modelActive && <p className="jz-dream-live-response">
      <span>{activity.receivedChars > 0 ? `已接收 ${activity.receivedChars.toLocaleString("zh-CN")} 字符` : activity.phase === "waiting_model" ? "请求已发出，等待首个响应" : "模型已响应，尚未返回记忆结果"}</span>
      {activity.phase === "generating" && <span>最近响应 {duration(lastResponse)}前</span>}
    </p>}
    {modelActive && lastResponse >= 60_000 && <p className="jz-dream-live-hint">{activity.phase === "waiting_model" ? "模型暂未返回结果，仍在等待响应。" : "模型已有一段时间未返回新内容，仍在等待响应。"}{wholeChapter ? "整章结果将在校验并保存后更新，最终入库状态以章节状态为准。" : "已保存进度会在本段校验并保存后更新。"}</p>}
    {activity.events.length > 0 && <details className="jz-dream-live-history">
      <summary>最近进展</summary>
      <ol>{activity.events.map((event, index) => <li key={`${event.at}:${index}`}>
        <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>
        <span>{wholeChapter || event.phase === "preparing" || event.phase === "saving_memory" ? "" : `第 ${event.part} 段 · `}{phases[event.phase]}</span>
      </li>)}</ol>
    </details>}
  </section>;
}
