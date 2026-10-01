import { z } from "zod";
export const GptImageOptions = {
  quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  outputCompression: z.number().int().min(0).max(100).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  inputFidelity: z.enum(["low", "high"]).optional(),
};
export const gptImageRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21", "3:1", "1:3"] as const;
export const isGptImage2 = (model: string) => /(?:^|\/)gpt-image-2(?:$|[.-])/.test(model);
export const isGptImage25 = (model: string) => /(?:^|\/)gpt-image-2[.-]5(?:$|-)/.test(model);
export function validGptImageSize(size: string): boolean {
  if (size === "auto") return true;
  if (!/^\d+x\d+$/.test(size)) return false;
  const [w,h] = size.split("x").map(Number) as [number,number];
  return w > 0 && h > 0 && w % 16 === 0 && h % 16 === 0 && Math.max(w,h) <= 3840 && Math.max(w,h)/Math.min(w,h) <= 3 && w*h >= 655360 && w*h <= 8294400;
}
/** Exact rational aspect ratios, quantized to the API's 16-pixel grid and pixel budget. */
export function gptImageSize(ratio: string, resolution: "1k" | "2k" | "4k" = "1k"): string {
  let [w,h] = ratio.split(":").map(Number) as [number,number];
  const gcd = (a:number,b:number):number => b ? gcd(b,a%b) : a;
  const divisor=gcd(w,h); w/=divisor;h/=divisor;
  const edge=resolution==="4k"?3840:resolution==="2k"?2048:w===h?1024:1536;
  const unit=Math.floor(Math.min(edge/(Math.max(w,h)*16),Math.sqrt(8294400/(w*h))/16));
  return `${w*unit*16}x${h*unit*16}`;
}
