import type { VideoAsset, VideoAssetView, VideoDesign, VideoProject } from "@jizuo/contracts";

const viewLabels: Record<VideoAssetView, string> = {
  "character-sheet": "六宫格", turnaround: "三视图", front: "正面", side: "侧面", back: "背面", expression: "表情",
  outfit: "服装", panorama: "360° 环景", detail: "场景画面",
};

export type DesignReferenceGroup = { design: VideoDesign; assets: VideoAsset[] };
export type DesignReferenceAsset = { asset: VideoAsset; design?: VideoDesign; label: string };

function referenceImage(asset: VideoAsset): boolean {
  return asset.kind === "image" && !asset.panorama && asset.view !== "panorama";
}

/** Keep empty settings visible without presenting a setting as an image attachment. */
export function designReferenceGroups(project: VideoProject): DesignReferenceGroup[] {
  const images = project.assets.filter(referenceImage);
  return (project.designs ?? []).map(design => ({
    design,
    assets: images.filter(asset => asset.designId === design.id || !asset.designId && design.referenceAssetIds.includes(asset.id)),
  }));
}

export function formatDesignReferenceLabel(asset: VideoAsset, design?: VideoDesign): string {
  const context = [...(design ? [design.name] : []), ...(asset.view ? [viewLabels[asset.view]] : [])];
  const missing = context.filter(value => !asset.label.includes(value));
  return [...missing, asset.label].join(" · ");
}

/** Search only images owned by this project; a stale setting reference adds no result. */
export function searchDesignReferenceAssets(project: VideoProject, query: string): DesignReferenceAsset[] {
  const groups = designReferenceGroups(project);
  const assetDesigns = new Map<string, VideoDesign[]>();
  for (const { design, assets } of groups) for (const asset of assets) {
    const designs = assetDesigns.get(asset.id) ?? [];
    designs.push(design);
    assetDesigns.set(asset.id, designs);
  }
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return project.assets.filter(referenceImage).flatMap(asset => {
    const designs = assetDesigns.get(asset.id) ?? [];
    const candidates: Array<VideoDesign | undefined> = designs.length ? designs : [undefined];
    const matching = candidates.findIndex(design => words.every(word => [
      asset.label, asset.view ?? "", asset.view ? viewLabels[asset.view] : "", design?.name ?? "", design?.version ?? "",
      design?.kind === "character" ? "人物" : design?.kind === "scene" ? "场景" : "",
    ].join(" ").toLocaleLowerCase().includes(word)));
    if (matching < 0) return [];
    const design = candidates[matching];
    return [{ asset, ...(design ? { design } : {}), label: formatDesignReferenceLabel(asset, design) }];
  });
}
