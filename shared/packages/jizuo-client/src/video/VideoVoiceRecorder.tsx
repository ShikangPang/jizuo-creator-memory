import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useRef, useState } from "react";
import { VideoToolIcon } from "./VideoToolIcon.tsx";

function recordingError(cause: unknown): string {
  const name = cause != null && typeof cause === "object" && "name" in cause ? cause.name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") {
    const platform = navigator.userAgent ?? "";
    if (/Macintosh|Mac OS X/.test(platform)) return "无法访问麦克风。请在系统设置 → 隐私与安全性 → 麦克风中允许即作后重启；若列表中没有即作，请更新安装包。也可以上传音频文件。";
    if (/Windows/.test(platform)) return "无法访问麦克风。请在 Windows 设置 → 隐私和安全性 → 麦克风中允许桌面应用访问后重试，也可以上传音频文件。";
    return "请在浏览器的网站权限和系统设置中允许麦克风权限后重试，也可以上传音频文件。";
  }
  if (name === "NotFoundError") return "未找到可用麦克风，请连接或启用录音设备后重试，也可以上传音频文件。";
  if (name === "NotReadableError" || name === "AbortError") return "无法读取麦克风，请检查设备连接或关闭其他占用麦克风的应用后重试。";
  return userErrorMessage(cause, "录音失败，请重试或上传音频文件。", { operation: "VideoVoiceRecorder" });
}

export function encodeVoiceWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const data = new ArrayBuffer(44 + samples.length * 2), view = new DataView(data);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, data.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true); });
  return data;
}

export function VideoVoiceRecorder({ save, busy, active = true }: { save: (file: File) => Promise<unknown>; busy: boolean; active?: boolean | undefined }) {
  const [recording, setRecording] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [draft, setDraft] = useState<File>();
  const [url, setUrl] = useState("");
  const dispose = useRef<() => void>(() => {}), finish = useRef<() => void>(() => {});
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; dispose.current(); }, []);
  useEffect(() => { if (active === false) { generation.current++; dispose.current(); setRecording(false); setPending(false); } }, [active]);
  useEffect(() => { if (!draft) { setUrl(""); return; } const next = URL.createObjectURL(draft); setUrl(next); return () => URL.revokeObjectURL(next); }, [draft]);
  const start = async () => {
    if (pending || recording) return;
    const request = ++generation.current; setPending(true); setError("");
    let stream: MediaStream | undefined, context: AudioContext | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境不支持录音，请上传音频文件");
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (request !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      context = new AudioContext({ sampleRate: 16000 }); await context.resume();
      if (request !== generation.current) { stream.getTracks().forEach(track => track.stop()); await context.close(); return; }
      const source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = []; let count = 0; const rate = context.sampleRate;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); processor.onaudioprocess = null; processor.disconnect(); source.disconnect(); stream?.getTracks().forEach(track => track.stop()); if (context?.state !== "closed") void context?.close(); };
      dispose.current = cleanup;
      processor.onaudioprocess = event => { const chunk = new Float32Array(event.inputBuffer.getChannelData(0)); chunks.push(chunk); count += chunk.length; };
      finish.current = () => {
        cleanup(); setRecording(false);
        if (!count) { setError("未录到声音，请重试"); return; }
        const samples = new Float32Array(count); let offset = 0; chunks.forEach(chunk => { samples.set(chunk, offset); offset += chunk.length; });
        setDraft(new File([encodeVoiceWav(samples, rate)], `录音配音-${Date.now()}.wav`, { type: "audio/wav" }));
      };
      source.connect(processor); processor.connect(context.destination);
      timer = setTimeout(() => finish.current(), 180000);
      setRecording(true);
    } catch (cause) {
      stream?.getTracks().forEach(track => track.stop()); if (context && context.state !== "closed") void context.close();
      if (request === generation.current) setError(recordingError(cause));
    } finally { if (request === generation.current) setPending(false); }
  };
  return <div className="jz-voice-recorder"><button type="button" className="jz-video-icon-button" disabled={busy || pending} aria-label={recording ? "结束录音" : "开始录音"} title={recording ? "结束录音" : "麦克风录音（最长 3 分钟）"} onClick={() => recording ? finish.current() : void start()}><VideoToolIcon name={recording ? "close" : "mic"}/></button>
    {recording && <small role="status">录音中…</small>}
    {url && !recording && <><audio controls src={url}/><IconButton icon="save" label={"保存录音"} type="button" disabled={busy || pending} onClick={() => { if (draft) void save(draft); }} /></>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
