import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useState } from "react";
import { SpeechProviderConfig, type SpeechSettingsView, type SaveSpeechSettingsInput } from "../../../contracts/src/video-speech.ts";
export interface SpeechSettingsRemote {
  getSpeechSettings():Promise<SpeechSettingsView>;
  saveSpeechSettings(input:SaveSpeechSettingsInput):Promise<SpeechSettingsView>;
}
export function SpeechModelsSettings({remote}:{remote:SpeechSettingsRemote}){
  const [view,setView]=useState<SpeechSettingsView>();
  const [enabled,setEnabled]=useState(false);
  const [config,setConfig]=useState<SpeechProviderConfig>({baseUrl:"https://api.openai.com/v1",model:"gpt-4o-mini-tts",voice:"alloy",speed:1,credentialRef:"jizuo_speech_default"});
  const [apiKey,setApiKey]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [message,setMessage]=useState("");
  const apply=(next:SpeechSettingsView)=>{setView(next);setEnabled(Boolean(next.settings.speech));if(next.settings.speech)setConfig(next.settings.speech);setApiKey("");};
  useEffect(()=>{let active=true;void remote.getSpeechSettings().then(value=>{if(active)apply(value);},cause=>{if(active)setError(userErrorMessage(cause, "配音模型加载失败", { operation: "SpeechModelsSettings", effect: "read" }));});return()=>{active=false;};},[remote]);
  const save=async()=>{if(!view||busy)return;setBusy(true);setError("");setMessage("");try{
    const speech=enabled?SpeechProviderConfig.parse(config):null;
    apply(await remote.saveSpeechSettings({expectedRevision:view.settings.revision,speech,apiKey}));setMessage("配音模型已保存");
  }catch(cause){setError(userErrorMessage(cause, "配音模型保存失败", { operation: "SpeechModelsSettings" }));}finally{setBusy(false);}};
  return <section className="jz-model-output" aria-label="配音模型设置"><h2>AI 配音</h2><p>可选配置，用于生成独立配音轨道。支持 OpenAI 兼容语音接口；生成的配音会标记为 AI 音频。</p>
    <fieldset className="jz-output-model" disabled={!view||busy}><legend>语音生成</legend>
      <label><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/>配置独立配音模型</label>
      {enabled&&<div className="jz-media-config-fields">
        <label>语音 API 地址<input value={config.baseUrl} onChange={event=>setConfig({...config,baseUrl:event.target.value})}/></label>
        <label>语音模型<input value={config.model} onChange={event=>setConfig({...config,model:event.target.value})}/></label>
        <label>声音<input value={config.voice} onChange={event=>setConfig({...config,voice:event.target.value})}/></label>
        <label>语速<input type="number" min={0.25} max={4} step={0.05} value={config.speed??1} onChange={event=>setConfig({...config,speed:event.target.valueAsNumber})}/></label>
        <label>语音 API Key<input type="password" autoComplete="new-password" value={apiKey} placeholder={view?.keyConfigured?"已保存，留空保持原密钥":"填写语音服务 API Key"} onChange={event=>setApiKey(event.target.value)}/></label>
      </div>}
    </fieldset>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <IconButton icon="save" label={(busy?"保存中…":"保存配音模型")} type="button" disabled={!view||busy} onClick={()=>{void save();}} />
  </section>;
}
