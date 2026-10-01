import { MEDIA_PROMPT_RULES } from "./media-prompt-rules.generated.ts";

/** Render skill-owned structure in one pass. Values are data and are never reinterpreted as templates. */
export function renderSkillPrompt(key: keyof typeof MEDIA_PROMPT_RULES, values: Readonly<Record<string, string | undefined>> = {}): string {
  const render = (template: string): string => template.replace(/{{#(\w+)}}([\s\S]*?){{\/\1}}|{{(\w+)}}/g, (_match, condition: string | undefined, body: string | undefined, field: string | undefined) => {
    if (condition) return values[condition] ? render(body!) : "";
    if (field === undefined || values[field] === undefined) throw new Error(`Missing skill prompt input: ${key}/${field}`);
    return values[field]!;
  });
  return render(MEDIA_PROMPT_RULES[key]);
}
