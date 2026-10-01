type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type NspoxReasoningEfforts = false | Partial<Record<Effort | "off", string | null>>;

// Explicit capabilities from the pinned pi-ai 0.85.1 catalog. NSPOX is a
// separate route, so Harness cannot inherit the original provider's metadata.
// Do not infer capabilities from a broad model-name prefix: chat-only models,
// media models and unknown gateway aliases must not advertise invented levels.
const levels = new Map<string, readonly Effort[]>();
function register(ids: string[], efforts: readonly Effort[]) {
  for (const id of ids) levels.set(id, efforts);
}
register(["gpt-5", "gpt-5-mini", "gpt-5-nano"], ["minimal", "low", "medium", "high"]);
register(["gpt-5-pro"], ["high"]);
register(["gpt-5.1", "o1", "o1-pro", "o3", "o3-mini", "o3-pro", "o4-mini"], ["low", "medium", "high"]);
register([
  "gpt-5.2", "gpt-5.3-codex", "gpt-5.3-codex-spark",
  "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5",
], ["low", "medium", "high", "xhigh"]);
register(["gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"], ["medium", "high", "xhigh"]);
register(["gpt-5.2-chat-latest"], ["medium", "xhigh"]);
register(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra"], ["low", "medium", "high", "xhigh", "max"]);
register(["glm-5.2", "glm-5.2-highspeed"], ["high", "max"]);
register(["glm-5.3", "glm-5.3-flash", "glm-5.3-highspeed"], ["low", "high", "max"]);

export function nspoxReasoningEfforts(modelId: string): NspoxReasoningEfforts | undefined {
  const supported = levels.get(modelId) ?? levels.get(modelId.replace(/-\d{4}-\d{2}-\d{2}$/, ""));
  // Omission keeps the gateway default. In particular, do not map an absent
  // selection to "none", or equate turning thinking off with a low budget.
  return supported ? Object.fromEntries(supported.map(level => [level, level])) : undefined;
}
