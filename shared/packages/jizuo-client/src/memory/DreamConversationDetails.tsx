import { ErrorText } from "../ui/ErrorText.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useId, useState } from "react";
import type { DreamChapterConversations, DreamModelConversation } from "@jizuo/memory-domain";
import type { DreamWorkRemote } from "./dreamRemote.ts";

const STATES: Record<DreamModelConversation["state"], string> = {
  running: "进行中", completed: "已保存分段", failed: "失败", cancelled: "已取消", interrupted: "运行已中断",
};
function Conversation({ record }: { record: DreamModelConversation }) {
  const [open, setOpen] = useState(record.state === "running");
  const wholeChapter = record.processingMode === "chapter";
  const stateLabel = wholeChapter && record.state === "completed" ? "已保存整章结果" : STATES[record.state];
  return <details className="jz-dream-conversation" open={open} onToggle={(event) => { setOpen(event.currentTarget.open); }}>
    <summary><span>{wholeChapter ? "整章请求" : `历史分段 · 第 ${record.part} 段`} · {stateLabel}</span><time dateTime={record.startedAt}>{new Date(record.startedAt).toLocaleString()}</time></summary>
    <div className="jz-dream-conversation-body">
      <p className="jz-dream-conversation-meta">{record.modelSelection.provider} / {record.modelSelection.model} · {wholeChapter ? `整章正文 ${(record.to - record.from).toLocaleString("zh-CN")}` : `正文 ${(record.from + 1).toLocaleString("zh-CN")}–${record.to.toLocaleString("zh-CN")}`} 字符{record.usedTokens !== undefined ? ` · 已用 ${record.usedTokens.toLocaleString("zh-CN")} Token` : record.state === "running" ? " · 用量待模型返回" : " · 模型未返回用量"}{record.request.maxOutputTokens ? ` · 输出上限 ${record.request.maxOutputTokens.toLocaleString("zh-CN")} Token` : ""}</p>
      {wholeChapter && record.state === "completed" && <p>整章结果已保存，最终入库或待确认结果请查看章节状态。</p>}
      <details className="jz-dream-conversation-prompt"><summary>发送给模型的提示词</summary><pre>{record.request.system || "此记录未保存提示词。"}</pre></details>
      <details className="jz-dream-conversation-prompt"><summary>发送给模型的正文</summary><pre>{record.request.content}</pre></details>
      {record.reasoning && <details className="jz-dream-conversation-prompt"><summary>模型返回的思考内容</summary><pre>{record.reasoning}</pre></details>}
      <section><h4>模型回复{record.state === "running" ? " · 持续更新" : ""}</h4>{record.output ? <pre tabIndex={0} aria-label="模型回复内容">{record.output}</pre> : <p>{record.state === "running" ? "等待模型返回内容…" : "本次请求没有返回回复正文。"}</p>}</section>
      {record.error && <p className="jz-dream-conversation-error">{<ErrorText error={record.error} operation="DreamConversationDetails" />}</p>}
      {record.state === "interrupted" && <p>上次运行中断，以下内容为最后保存的响应；继续整理会产生新的请求记录。</p>}
      <small>最后记录：{new Date(record.updatedAt).toLocaleString()}</small>
    </div>
  </details>;
}

export function DreamConversationDetails({ load, volumeId, chapterId, running }: {
  load: NonNullable<DreamWorkRemote["getConversations"]>; volumeId: string; chapterId: string; running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DreamChapterConversations>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    let active = true; let pending = false;
    const poll = async () => {
      if (pending) return; pending = true;
      try {
        const value = await load({ volumeId, chapterId });
        if (active) { setData(value); setError(undefined); }
      } catch { if (active) setError("模型对话详情更新失败，请重试。"); }
      finally { pending = false; }
    };
    void poll();
    const timer = running ? setInterval(() => { void poll(); }, 2000) : undefined;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [open, load, volumeId, chapterId, running, refresh]);
  return <div className="jz-dream-conversations">
    <IconButton icon="chat" label={(open ? "收起模型对话" : "查看模型对话")} type="button" className="jz-dream-conversation-toggle" aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open); }} />
    {open && <div id={id}>
      <p className="jz-dream-conversation-note">当前正文版本的模型请求与实际回复{running ? " · 每 2 秒更新" : ""}</p>
      {error && <p role="alert">{error}{data ? "以下为上次获取的内容。" : ""}<IconButton icon="reset" label={"重新加载"} type="button" onClick={() => { setRefresh((value) => value + 1); }} /></p>}
      {!data && !error && <p>正在加载模型对话…</p>}
      {data?.conversations.length === 0 && <p>暂无记录。尚未发出请求，或此章节由旧版本整理，未保存模型对话。</p>}
      {data?.conversations.map((record) => <Conversation key={record.id} record={record} />)}
    </div>}
  </div>;
}
