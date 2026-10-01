import { gptImageRatios, gptImageSize, isGptImage25, validGptImageSize } from "../../../contracts/src/gpt-image.ts";
import type { MediaGenerationSettings } from "../../../contracts/src/media-generation-controls.ts";

export function GptImageControls({ settings, patch, ratio, model, panorama, turnaround, hasReferences }: {
  settings: MediaGenerationSettings; patch: (value: Partial<MediaGenerationSettings>) => void; ratio: string; model: string;
  panorama: boolean; turnaround: boolean; hasReferences: boolean;
}) {
  const selectedRatio = settings.imageAspectRatio ?? ratio;
  const resolution = settings.imageResolution ?? "1k";
  const size = settings.imageSize ?? gptImageSize(selectedRatio,resolution);
  const format = settings.outputFormat ?? "png";
  const choices = (label: string, values: readonly string[], selected: string | undefined, onChange: (value: string) => void, labels?: Record<string,string>) => <fieldset><legend>{label}</legend><div className="jz-generation-choices">{values.map(value=><button type="button" key={value} aria-pressed={selected===value} onClick={()=>onChange(value)}>{labels?.[value]??value}</button>)}</div></fieldset>;
  return <>
    {!panorama && <>
      {choices("图片比例", gptImageRatios.filter(value=>!turnaround || Number(value.split(":")[0])>Number(value.split(":")[1])),settings.imageSize?undefined:selectedRatio,value=>patch({imageAspectRatio:value as MediaGenerationSettings["imageAspectRatio"],imageSize:undefined}))}
      {choices("图片分辨率",["1k","2k","4k"],settings.imageSize?undefined:resolution,value=>patch({imageResolution:value as "1k"|"2k"|"4k",imageSize:undefined}),{"1k":"1K","2k":"2K","4k":"4K"})}
      <fieldset><legend>图片尺寸</legend><output aria-label="图片尺寸">{size === "auto" ? "由模型自动选择" : size.replace("x", " × ")}</output></fieldset>
      {!turnaround && <button type="button" aria-pressed={size==="auto"} onClick={()=>patch({imageSize:"auto"})}>智能尺寸</button>}
      {!validGptImageSize(size)&&<p role="alert">宽高须为 16 的倍数，长边不超过 3840，比例在 1:3 到 3:1，像素总量为 655,360–8,294,400。</p>}
      <small>按接口像素上限计算实际尺寸；高于 2560 × 1440 的尺寸为实验支持。</small>
      <details><summary>常用尺寸</summary>{choices("快速选择",turnaround?["1536x1024"]:["1024x1024","1536x1024","1024x1536"],size,value=>patch({imageSize:value}),{"1024x1024":"1024 × 1024","1536x1024":"1536 × 1024","1024x1536":"1024 × 1536"})}</details>
    </>}
    {choices("背景",["auto","opaque","transparent"],settings.background??"auto",value=>patch({background:value as MediaGenerationSettings["background"],...(value==="transparent"&&format==="jpeg"?{outputFormat:"png",outputCompression:undefined}:{})}),{auto:"自动",opaque:"不透明",transparent:"透明"})}
    {choices("输出格式",["png","jpeg","webp"],format,value=>patch({outputFormat:value as MediaGenerationSettings["outputFormat"],...(value==="png"?{outputCompression:undefined}:{}),...(value==="jpeg"&&settings.background==="transparent"?{background:"opaque"}:{})}),{png:"PNG",jpeg:"JPEG",webp:"WebP"})}
    {format!=="png"&&<label>压缩率 {settings.outputCompression??100}%<input aria-label="图片压缩率" type="range" min={0} max={100} value={settings.outputCompression??100} onChange={event=>patch({outputCompression:Number(event.target.value)})}/></label>}
    {hasReferences && (isGptImage25(model) ? choices("参考图保真度",["low","high"],settings.inputFidelity??"low",value=>patch({inputFidelity:value as "low"|"high"}),{low:"标准",high:"高"}) : <small>参考图自动使用高保真。</small>)}
    <details><summary>更多参数</summary>{!hasReferences&&choices("内容审核",["auto","low"],settings.moderation??"auto",value=>patch({moderation:value as "auto"|"low"}),{auto:"标准",low:"较宽松"})}<small>每次生成 1 张，继续生成会保留备选。</small></details>
  </>;
}
