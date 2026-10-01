import { DESIGN_VIEW_PROMPTS } from "../../../contracts/src/media-prompt-rules.ts";
import { composeDesignBasePrompt, composeDesignPrompt } from "./design-prompt.ts";
import { wrapPromptReference } from "./prompt-reference-envelope.ts";
import { VideoAssetView, type VideoProject } from "@jizuo/contracts";

export const DESIGN_CHAT_SOURCE = "人物与场景";
type DesignReference = { workId: string; designId: string; view?: VideoAssetView };
export function decodeDesignReference(ref: string): DesignReference {
  const value = JSON.parse(decodeURIComponent(ref));
  if (!value || ![value.workId, value.designId].every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(id))) throw new Error("设定引用无效，请重新选择人物或场景");
  const view = value.view === undefined ? undefined : VideoAssetView.parse(value.view);
  return { workId: value.workId, designId: value.designId, ...(view ? { view } : {}) };
}
export function serializeDesignReference(project: VideoProject, ref: DesignReference): string {
  const design = project.designs?.find(item => item.id === ref.designId);
  if (project.workId !== ref.workId || !design) throw new Error("人物或场景设定已不存在，请重新选择");
  const view = ref.view;
  return wrapPromptReference(DESIGN_CHAT_SOURCE, `${design.name}`,
    JSON.stringify({ visualStyle: project.visualStyle, workId: project.workId, revision: project.revision, ...(view ? { requestedView: view } : {}), design: { id: design.id, kind: design.kind, name: design.name, version: design.version, locked: design.locked, description: design.description },
      viewInstructions: view ? DESIGN_VIEW_PROMPTS[view] : undefined, generationPrompt: view ? composeDesignPrompt(project, design, view) : composeDesignBasePrompt(project, design), references: project.assets.filter(asset => asset.designId === design.id || design.referenceAssetIds.includes(asset.id)).map(asset => ({ id: asset.id, label: asset.label, view: asset.view, panorama: Boolean(asset.panorama) })) }), design.kind === "character" ? "character-prompts" : "scene-prompts");
}
