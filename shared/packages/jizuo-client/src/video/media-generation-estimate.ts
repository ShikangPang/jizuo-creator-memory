import { resolveVideoGenerationDuration, type MediaProviderConfig } from "../../../contracts/src/media.ts";
import type { MediaSettingsView } from "../../../contracts/src/media-settings.ts";

export interface MediaGenerationEstimate {
  config: MediaProviderConfig | null | undefined;
  durationSeconds: number | undefined;
  unit: string | undefined;
  creditsPerUnit: number | undefined;
  estimatedCredits: number | undefined;
  availableCredits: number | undefined;
  reservedCredits: number | undefined;
  insufficientCredits: boolean;
}

export function sumEstimatedMediaCredits(values: Array<number | undefined>): number | undefined {
  if (values.some((value) => value === undefined || !Number.isFinite(value) || value < 0)) return undefined;
  const terms = (values as number[]).map((value) => {
    const [mantissa = "", exponent = "0"] = String(value).toLowerCase().split("e");
    const [whole = "0", fraction = ""] = mantissa.split(".");
    return { coefficient: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
  });
  const exponent = Math.min(0, ...terms.map((term) => term.exponent));
  const total = terms.reduce((sum, term) => sum + term.coefficient * 10n ** BigInt(term.exponent - exponent), 0n);
  const result = Number(`${total}e${exponent}`);
  return Number.isFinite(result) ? result : undefined;
}

// Keep decimal catalog prices exact before converting the final result to a JS number.
function multiplyCredits(price: number, count: number): number | undefined {
  if (!Number.isFinite(price) || price < 0 || !Number.isSafeInteger(count) || count < 1) return undefined;
  const [mantissa = "", exponent = "0"] = String(price).toLowerCase().split("e");
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const result = Number(`${BigInt(whole + fraction) * BigInt(count)}e${Number(exponent) - fraction.length}`);
  return Number.isFinite(result) ? result : undefined;
}

export function estimateMediaGeneration(view: MediaSettingsView | undefined, kind: "image" | "video", shotDurationSec?: number): MediaGenerationEstimate {
  const config = view?.settings[kind];
  const durationSeconds = config && kind === "video" && shotDurationSec !== undefined ? resolveVideoGenerationDuration(config, shotDurationSec) : undefined;
  const connection = config?.protocol === "nspox" ? view?.connections?.find((item) => item.kind === kind && item.isDefault && item.config.protocol === config.protocol && item.config.model === config.model && item.config.credentialRef === config.credentialRef && item.config.baseUrl === config.baseUrl) : undefined;
  const billing = connection?.billing;
  const count = kind === "image" && ["image", "张"].includes(billing?.unit ?? "") || kind === "video" && billing?.unit === "video" ? 1
    : kind === "video" && ["second", "秒"].includes(billing?.unit ?? "") && durationSeconds !== undefined && durationSeconds > 0 && durationSeconds <= 30 ? durationSeconds : undefined;
  const estimatedCredits = billing && count !== undefined ? multiplyCredits(billing.creditsPerUnit, count) : undefined;
  const credits = config?.protocol === "nspox" && view?.keyConfigured[kind] && view.mediaCredits?.credentialRef === config.credentialRef ? view.mediaCredits : undefined;
  return { config, durationSeconds, unit: billing?.unit, creditsPerUnit: billing?.creditsPerUnit, estimatedCredits,
    availableCredits: credits?.available, reservedCredits: credits?.reserved,
    insufficientCredits: estimatedCredits !== undefined && credits !== undefined && credits.available < estimatedCredits };
}
