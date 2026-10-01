import { z } from "zod";
import { StableId, type VideoProject } from "@jizuo/contracts";
import { wrapPromptReference } from "./prompt-reference-envelope.ts";
export const STYLE_CHAT_SOURCE = "作品画风";
const StyleReference = z.object({ workId: StableId, scope: z.enum(["style", "designs", "episode", "current"]).default("style"), episodeId: StableId.optional(), shotId: StableId.optional(), designId: StableId.optional() }).strict();
export type StyleReference = z.infer<typeof StyleReference>;
export const decodeStyleReference = (ref: string) => StyleReference.parse(JSON.parse(decodeURIComponent(ref)));
export function serializeStyleReference(project: VideoProject, ref: StyleReference): string {
  if (project.workId !== ref.workId) throw new Error("画风引用不属于当前作品");
  const episode = project.episodes.find(item => item.id === ref.episodeId && !item.deletedAt);
  const designs = (project.designs ?? []).filter(item => !item.deletedAt && (ref.scope === "designs" || ref.scope === "current" && item.id === ref.designId));
  const shots = (episode?.shots ?? []).filter(item => !item.archived && (ref.scope === "episode" || ref.scope === "current" && item.id === ref.shotId));
  if (ref.scope === "episode" && !episode || ref.scope === "current" && !designs.length && !shots.length) throw new Error("整理目标已不可用，请重新选择");
  const content = JSON.stringify({ workId: project.workId, revision: project.revision, visualStyle: project.visualStyle ?? null,
    scope: ref.scope, ...(ref.scope !== "style" ? { designs, episodeId: episode?.id, shots } : {}) });
  if (content.length > 250000) throw new Error("提示词整理范围过大，请选择单个人物或镜头");
  return wrapPromptReference(STYLE_CHAT_SOURCE, ref.scope === "style" ? `作品画风 · ${project.visualStyle?.name ?? "未设置"}` : "按作品画风整理提示词", content);
}
