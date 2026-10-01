import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SkillScope = "global" | "work";

export interface ResolvedSkill {
  name: string;
  scope: SkillScope;
  path: string;
  content: string;
}

export interface BuiltinResource {
  path: string;
  sha256: string;
}

export const BUILTIN_RESOURCE_MANIFEST: readonly Readonly<BuiltinResource>[] = Object.freeze([
  Object.freeze({ path: "runtime/skills/h3-prompt-writing/SKILL.md", sha256: "c47208d269e2c12498eb3010e8ecb1fb448f325f969465acd4ff6c16b3e08ea8" }),
  Object.freeze({ path: "runtime/skills/h3-prompt-writing/references/base-en.txt", sha256: "2cfebc096a6e08370f288d468d90b60f7f9bcb938f94bf090816e910e48e75fc" }),
  Object.freeze({ path: "runtime/skills/h3-prompt-writing/references/ref-en.txt", sha256: "1e574f356716ad55612247ffb7bbccbcdb484ad96599d63c7dca1af186b1fab7" }),
  Object.freeze({ path: "runtime/skills/h3-prompt-writing/upstream.json", sha256: "8adcb2431864e7cb01126656f383aad48dec733e0578a5f87664d7ddf46aef07" }),
  Object.freeze({ path: "runtime/skills/minimax-story-visuals/SKILL.md", sha256: "551689f06d7d661430b8f52bb65d75ccb82103ac2cc619ff237d255eb12cda58" }),
  Object.freeze({path:"runtime/skills/novel-memory/SKILL.md",sha256:"04f3670634c9f3bc7f5c7cb1acd7f604eb16e523faeacadf5cd6610d8f57eb47"}),
  Object.freeze({ path: "runtime/skills/story-prompts/SKILL.md", sha256: "6557edb7b619a1b92e4e00ab74b690dd3daccd4aa61eae8532b813bea586bc3d" }),
  Object.freeze({ path: "runtime/skills/scene-prompts/SKILL.md", sha256: "854d01aba356deea7f4af1b2fb04822f443f27fa1d9c51bf3f989511aff5c2c1" }),
  Object.freeze({ path: "runtime/skills/character-prompts/SKILL.md", sha256: "19918d6ae1586f22e9a6cf21ae68e53a6d218556c19ea96020b22985a61db274" }),
  Object.freeze({ path: "runtime/workflows/chapter-production.json", sha256: "d908d90fd8e67e0e67676b0c241a7424147531b49243046163b45c796d364930" }),
  Object.freeze({ path: "runtime/agents/chief-editor.md", sha256: "840e67f44ad8225f4f9163e6f0f4d58d7a54b34b35f9ca6a24b74994d26a51b9" }),
  Object.freeze({ path: "runtime/agents/continuity-reviewer.md", sha256: "5972cb3b0bf97711497678fd9478ef89988a6f730c2fddfc1418977e8ca102c6" }),
  Object.freeze({ path: "runtime/agents/novel-writer.md", sha256: "9cd75db1bf7dc3a2503a8296ba3e784417cf3f93f8b37550b44cc024f2d7be7f" }),
  Object.freeze({ path: "runtime/agents/outline-planner.md", sha256: "468d743672b8a81ffc75ae47f389569eaab62a13ac5a420c1aba094cd5a09567" }),
  Object.freeze({ path: "runtime/agents/style-reviewer.md", sha256: "0dcae188a60057d25632c6966201dafb80d13a5fde943375b1a628fa07ed8001" }),
  Object.freeze({ path: "runtime/agents/ai-trace-reviewer.md", sha256: "b5f376b78916762d8a4df96abe7be9d5b57d17accdf01a67630c26c98327f169" }),
  Object.freeze({ path: "runtime/agents/memory-extractor.md", sha256: "39b7aed4ffbe1ea4c7fb1505c882e6d7dba67df4b3f380d77d314e8516ad56ca" }),
  Object.freeze({ path: "runtime/teams/novel-team.yaml", sha256: "29cd25b94841d174052f139fc33446ccb4ff2a13666d75b7f976e90668dc0ca9" }),
  Object.freeze({ path: "runtime/skills/creative-prompt/SKILL.md", sha256: "b8c9cc01f3ca6add2778979e0e21c6723d221a82c250a4082c45ea70b6e974bc" }),
  Object.freeze({ path: "runtime/skills/novel-video/SKILL.md", sha256: "92ed324d459769d7ad4c48003539ffbe071170e51a336256dedb2682d2fbf4df" }),
  Object.freeze({ path: "runtime/skills/novel-workflow/SKILL.md", sha256: "bda9d2bf52c6bcc074df7911d6ae36ee159900ddae3352f1712ee87590a1b24d" }),
  Object.freeze({ path: "runtime/skills/worldbuilding/SKILL.md", sha256: "40ecff01be5e00f3f8314a2f86652ec969e2cd7488bb12bbe0e0ef5284c30cc8" }),
  Object.freeze({ path: "runtime/skills/style/SKILL.md", sha256: "ab2e7b82487adb00677abea7f8f9015fb0df50461b950abaa4290c38291d7556" }),
]);

export function sha256Resource(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readSkillDirectory(root: string, scope: SkillScope): Promise<ResolvedSkill[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills: ResolvedSkill[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "SKILL.md");
    try {
      skills.push({ name: entry.name, scope, path, content: await readFile(path, "utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return skills;
}

export async function resolveSkillLayers(globalRoot: string, workRoot: string): Promise<Map<string, ResolvedSkill>> {
  const resolved = new Map<string, ResolvedSkill>();
  for (const skill of await readSkillDirectory(join(globalRoot, "skills"), "global")) {
    resolved.set(skill.name, skill);
  }
  for (const skill of await readSkillDirectory(join(workRoot, ".jizuo", "skills"), "work")) {
    resolved.set(skill.name, skill);
  }
  return resolved;
}

export function decideBuiltinUpgrade(input: {
  currentContent?: string;
  nextContent: string;
  knownPreviousHashes: string[];
}): { action: "create" | "preserve" } | { action: "replace"; content: string } {
  if (input.currentContent === undefined) return { action: "create" };
  return input.knownPreviousHashes.includes(sha256Resource(input.currentContent))
    ? { action: "replace", content: input.nextContent }
    : { action: "preserve" };
}

export async function upgradeBuiltinResource(input: {
  path: string;
  nextContent: string;
  knownPreviousHashes: string[];
}) {
  let currentContent: string | undefined;
  try {
    currentContent = await readFile(input.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const decision = decideBuiltinUpgrade({
    ...(currentContent === undefined ? {} : { currentContent }),
    nextContent: input.nextContent,
    knownPreviousHashes: input.knownPreviousHashes,
  });
  if (decision.action === "preserve") return decision;
  await mkdir(dirname(input.path), { recursive: true });
  const temporary = `${input.path}.next`;
  await writeFile(temporary, input.nextContent, "utf8");
  await rename(temporary, input.path);
  return decision;
}

/** Upgrade only byte-identical shipped skills; user and work overrides survive. */
export async function upgradeBuiltinWorkflowSkills(runtimeRoot: string, settingsRoot: string): Promise<void> {
  const previous: Readonly<Record<string, string[]>> = {
    "story-prompts": ["4470c008fbe7b8fefedaf359288b699bee1c2d8fb8febe9bef8aff76d91faed3", "86c68b941d57be127c31398df76adf0bfd28c556410b40a7f050c329525329a6"],
    "scene-prompts": ["3ebaf8d8c1c005b9587217db77c944c18d78ce8f0c3539511ff6f9a0fef9bc6b", "3018c8d2dadeb53058445b3eafcfcb0460ba5e0c565290fc8124a9548e1e5a4b", "80be948598a56d2925eb4839b1117f486fb06060ce624072fb285b1c5695c582"],
    "character-prompts": ["2a73ca48efeb31c40b4fa1caeea6f4e0fab6de8f9746fbf2e90046c1ec9931a9", "0ccc3d0a66786a8b415077c394aa2825b89947b87fac200d617a5818431d0231", "9827f4b2ed4bffc5c0da4b86223b864d01298f26ca988c1699f3fbab61a06213"],
    "creative-prompt": ["7d1bc78780a06417a9da3c9508c34014c0b7335477aa2280b286ce111be94716", "ceeb0db61c1ad9004f87433e6499e65b4c073cf071c79e63e96238bc85115d63", "c5e34f200a73f5b96e891c7eed77bb22ade57184d3554f9032388cedca2d59c4", "be37b73a548ec1f43e388ab1bb52a74b601e273a8102126b164eb0c01754a41a", "045df0d13b0f1785f4811446106edc92c8a99fede63c886a67eb06160986ae74", "cf8893d347671703ebec12f1f1aa4d20eb13fd9bc8b8fefae21f23c832d9b8bc"],
    "novel-video": ["887588c546c3e1e9d969feb70e40bd6648fdb9e3d2c178c178e8576679ee323b", "24abbccfaaacb8b0dffb29b13c5177c6a3c4d0c1d512e764bec98baf1da971cd", "da1083ec6348bb75f5a4a50f55d5e2b382f71b053ccfc21d9328bfd2b13a6427", "c9272f2420e123ce347707db4e50d89c4bf4785f1659144a4b1e9d45618eb5b1", "4c5bee44abe2da7da21dcb24b3f95fa5392316b27970ab9401980add2d6dc9d6", "5963659c371a47a4fe48d93e1290b09d0cd7801dc625090be79ea13a437c19b0", "0efa689e5a43e025ed5f41c27f03ea11e4c94c4357ba4c22e85dfff13af2ce64", "486995c9e884bb47759dd31bc46f3403c5e54eae106a48bfbe8d5e26e352a0d7", "7a0c79662333904db54b7e51c7ae6d78caab261e4ee10545cbd4ee635dd63d80", "cf815460008e8113e34edc4065b13d1aec3c51b7a28a7dabfdc3beceb8e2cad4", "e6e6535cf612d2b924883a56f9ec7c0b8684b793d3f87e46ed5d71a77885366c", "c328ad7ed3edf95bb9c29154b49b63b94fe3b660e7bbba7d3d740d4a48bfbf00", "94d00af52c4fcaf6a7be116e772b37506d35f7cb5c1ba57a4b22d071f0743e5c", "f479121660a5ff39e41da4ab8422db7c0faa3ca3f7a0e25420f40dec85ea17b2", "af443fde05568e8621cdb9f2116112564cd2ee8fb5344be2290eb8d74af13346", "69b8be78056d91f59915759a8348dda4d8c087fd21749773f03c0af72302bc6b", "adb57ef1729dc7320122904d26cf07dd4f659a1db28e01cf5b541024dd4dcedd", "406a010b4253288262467c1785a1da040568fbfa2903e9d861ea70dd2450bd24", "11de84edd3247d9c63407cf7a952c1ea00d97e563bb2da3ec585491230334aff"],
    "worldbuilding": ["958cf98767bcf05573be9cb8bb6aa1915144a00390008db2be5d00dc368248ee", "591a8fb47634f256f12219c8237080639607c344fcc2c3e5777e3ff0dcbcec5e", "b6147938a8808c9ee2c704a15636c5f3947e92c5522cb1187bc6084dff34df06"],
    "style": ["148c44aee6a30622e0ba644936f7c61f68fa841b7d04d45e486ba21da37edd0c", "325d81a6dad912316184949f48d1e947af6a465120c6324bb31c51cffd853979", "f5acd2b6ccd534f2cc5ed0f42cb0818a24e7642f1e51e0f9e18898e9727f08c0"],
    "novel-memory": [],
    "novel-workflow": ["de6b45aab8a0abcc76e15615a121cd2f479c4285e1f9ba5da7284d28b38be3ec", "88aa03ae6b488fe19c74d1018d29b7004b059d952fc5701d2c1be1eb7b21e9e0",
      "b483a5a9bbe08a382673e64455f7a112513fe2e0c41b3070534d904eab9157a8",
      "75b0b424486a5de434e7b2ed60adb34ca58b823543593e50a3efe9e29183979f",
      "86d040bc9fdc3635e8a0377180c130e41accf948c1d1637b8f84d4d30dbb7125",
      "95a8481e969612df2a56cf04f4b99ea685dc63ded66fea13d3d5aa1d40cca5aa",
    ],
  };
  // Verify the complete source set before replacing any installed resource.
  const updates = await Promise.all(Object.entries(previous).map(async ([name, knownPreviousHashes]) => {
    const relativePath = `skills/${name}/SKILL.md`;
    const nextContent = await readFile(join(runtimeRoot, relativePath), "utf8");
    const manifest = BUILTIN_RESOURCE_MANIFEST.find((entry) => entry.path === `runtime/${relativePath}`);
    if (!manifest || sha256Resource(nextContent) !== manifest.sha256) throw new Error(`Workflow skill resource integrity verification failed: ${relativePath}`);
    return { path: join(settingsRoot, relativePath), nextContent, knownPreviousHashes };
  }));
  for (const update of updates) await upgradeBuiltinResource(update);
}
