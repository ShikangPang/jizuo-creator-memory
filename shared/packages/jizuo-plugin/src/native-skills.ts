import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";

export type SkillFeature = "writing" | "video" | "memory" | "media-models";
const featureSkills: Record<SkillFeature, readonly string[]> = {
  writing: ["novel-workflow", "worldbuilding", "style"],
  video: ["novel-video", "creative-prompt", "story-prompts", "scene-prompts", "character-prompts", "h3-prompt-writing", "minimax-story-visuals"],
  memory: ["novel-memory"],
  "media-models": ["creative-prompt", "h3-prompt-writing", "minimax-story-visuals"],
};
interface Definition {
  name: string; description: string; content: string; path: string;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
  resourceBase: { kind: "directory"; path: string };
}
interface Candidate extends Definition { source: string; provider: string; rank: number }
interface Registry {
  registerProvider(create: () => {name: string; list(): Promise<Candidate[]>; get(candidate: Candidate): Promise<Candidate>}): unknown;
}

/** Bind each provider to its feature fiber, so disabling a plugin removes its skills.
 * Separate providers allow shared media skills to survive either owner's disposal.
 */
export async function createNativeSkillRegistrar(runtimeRoot: string, settingsRoot: string) {
  const definitions = new Map<string, Definition>();
  await Promise.all([...new Set(Object.values(featureSkills).flat())].map(async name => {
    const bundledPath = join(runtimeRoot, "skills", name, "SKILL.md");
    const bundled = await readFile(bundledPath, "utf8");
    let path = bundledPath, source = bundled;
    const override = join(settingsRoot, "skills", name, "SKILL.md");
    try {
      const content = await readFile(override, "utf8");
      // Keep bundled relative references resolvable for unchanged installed copies.
      if (content !== bundled) { source = content; path = override; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
    if (!match) throw new Error(`技能缺少元数据：${name}`);
    const meta = parse(match[1]!) as Record<string, unknown>;
    if (meta.name !== name || typeof meta.description !== "string" || !meta.description.trim()) throw new Error(`技能元数据无效：${name}`);
    definitions.set(name, { name, description: meta.description, content: match[2]!, path,
      invocation: { modelInvocable: meta["disable-model-invocation"] !== true, userInvocable: meta["user-invocable"] !== false },
      resourceBase: { kind: "directory", path: dirname(path) } });
  }));
  return (ctx: Context, feature: SkillFeature): void => {
    ctx.inject(["skills"], scope => {
      const skills = scope.get("skills") as unknown as Registry;
      const provider = `jizuo-${feature}`;
      // Built-in rank leaves native project and user skill overrides authoritative.
      skills.registerProvider(() => ({ name: provider,
        async list() { return featureSkills[feature].map(name => ({ ...definitions.get(name)!, source: "bundled", provider, rank: 600 })); },
        async get(candidate) { return candidate; },
      }));
    });
  };
}
