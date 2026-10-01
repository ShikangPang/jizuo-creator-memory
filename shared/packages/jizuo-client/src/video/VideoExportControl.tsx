import { useEffect, useRef, useState } from "react";
import type { VideoRuntimeStatus } from "@jizuo/contracts";
import { VideoToolIcon } from "./VideoToolIcon.tsx";

export function videoExportBlockers(status: VideoRuntimeStatus, styled: boolean, wrap: boolean): string[] {
  return [
    !status.ffmpeg.available && "未找到可运行的 FFmpeg",
    !status.ffprobe.available && "未找到可运行的 ffprobe",
    status.ffmpeg.available && !status.h264 && "缺少 H.264（libx264）编码器",
    status.ffmpeg.available && !status.aac && "缺少 AAC 编码器",
    styled && !status.styledSubtitles && "当前文字需要 libass 字幕渲染支持",
    wrap && !status.unicodeWrapping && "当前文本框需要 Unicode 自动换行支持",
  ].filter((message): message is string => Boolean(message));
}

export function VideoExportControl({ check, disabled, styled, wrap, onExport }: {
  check?: (() => Promise<VideoRuntimeStatus>) | undefined; disabled: boolean; styled: boolean; wrap: boolean; onExport(): void;
}) {
  const [status, setStatus] = useState<VideoRuntimeStatus>();
  const [pending, setPending] = useState(Boolean(check));
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const sequence = useRef(0);
  const refresh = async () => {
    if (!check) return;
    const id = ++sequence.current;
    setPending(true); setError(false);
    try { const result = await check(); if (id === sequence.current) { setStatus(result); if (videoExportBlockers(result, styled, wrap).length) setOpen(true); } }
    catch { if (id === sequence.current) { setStatus(undefined); setError(true); setOpen(true); } }
    finally { if (id === sequence.current) setPending(false); }
  };
  useEffect(() => { void refresh(); return () => { sequence.current += 1; }; }, [check]);
  const blockers = status ? videoExportBlockers(status, styled, wrap) : [];
  const blocked = Boolean(check) && (pending || error || !status || blockers.length > 0);
  return <>
    <button title={blocked ? "请先检查导出环境" : "导出 MP4"} className="jz-video-icon-button" aria-label="导出 MP4" type="button" disabled={disabled || blocked} onClick={onExport}><VideoToolIcon name="export" /></button>
    {check && <details className="jz-video-runtime" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{pending ? "正在检查导出环境…" : error || blockers.length ? "导出环境需处理" : "导出环境"}</summary>
      <div className="jz-video-runtime-content">
        <p>检查运行 Harness 的设备；此处不会自动安装软件。</p>
        {error && <p role="alert">导出环境检查失败，请重新检查。</p>}
        {blockers.length > 0 && <p role="alert">{blockers.join("；")}。</p>}
        {status && <><p>FFmpeg：{status.ffmpeg.available ? "可用" : "不可用"}；ffprobe：{status.ffprobe.available ? "可用" : "不可用"}；样式字幕：{status.styledSubtitles ? "支持" : "不支持"}；文本框换行：{status.unicodeWrapping ? "支持" : "不支持"}。</p>
          {status.ffmpeg.path && <p>FFmpeg 路径：<code>{status.ffmpeg.path}</code></p>}
          {status.ffprobe.path && <p>ffprobe 路径：<code>{status.ffprobe.path}</code></p>}</>}
        <button type="button" disabled={pending} onClick={() => { void refresh(); }}>重新检查</button>
        <details><summary>安装与配置步骤</summary>
          {(!status || status.platform === "darwin") && <p>macOS：已安装 Homebrew 时，在终端执行 <code>brew install ffmpeg-full</code>。没有 Homebrew 时先按 <a href="https://brew.sh/" target="_blank" rel="noreferrer">Homebrew 官方指引</a>安装。Apple Silicon 默认路径为 <code>/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg</code>，Intel 为 <code>/usr/local/opt/ffmpeg-full/bin/ffmpeg</code>；ffprobe 在同一目录。<a href="https://formulae.brew.sh/formula/ffmpeg-full" target="_blank" rel="noreferrer">查看完整组件</a>。</p>}
          {(!status || status.platform !== "darwin") && <p>Windows：从 <a href="https://ffmpeg.org/download.html" target="_blank" rel="noreferrer">FFmpeg 官方下载页</a>选择完整构建，解压后将含 ffmpeg.exe 和 ffprobe.exe 的 bin 目录加入用户 Path。Linux：使用发行版软件管理器安装 ffmpeg（需包含 ffprobe、libx264、AAC、libass）；安装后重新检查字幕和换行能力。</p>}
          <p>自定义安装位置：在启动 Harness 的环境中配置 <code>JIZUO_FFMPEG_PATH</code> 和 <code>JIZUO_FFPROBE_PATH</code>，值为两个可执行文件的完整绝对路径。例如 Windows：<code>C:\ffmpeg\bin\ffmpeg.exe</code> 和 <code>C:\ffmpeg\bin\ffprobe.exe</code>。设置后完全退出并重新打开 Harness，再点“重新检查”。终端环境变量不一定会被从桌面图标启动的应用继承。</p>
          <p>安装后可在终端运行 <code>ffmpeg -version</code>、<code>ffprobe -version</code>。样式字幕要求 libass；中文文本框还要求字幕过滤器支持 wrap_unicode。仅显示版本号不代表满足全部导出能力。</p>
        </details>
      </div>
    </details>}
  </>;
}
