import type { VideoAsset, VideoProject } from "@jizuo/contracts";

// Portable to Windows, including device names and trailing dots/spaces.
function filename(value: string): string {
  const name = Array.from(value.normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "－"))
    .slice(0, 36).join("").replace(/[. ]+$/g, "").trim();
  if (!name || name === "." || name === "..") return "未命名";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

const views = {
  "character-sheet": "六宫格设定图", turnaround: "三视图", front: "正面", side: "侧面",
  back: "背面", expression: "表情", outfit: "服装", panorama: "全景", detail: "细节",
};
const kinds = { image: "图片", video: "视频", audio: "音频", export: "成片" };

export function assetFilenameBase(metadata: Pick<VideoAsset, "kind" | "label" | "episodeId" | "shotId" | "designId" | "view">, project: VideoProject): string {
  const design = project.designs?.find(item => item.id === metadata.designId);
  const episodeIndex = project.episodes.findIndex(item => item.id === metadata.episodeId);
  const episode = project.episodes[episodeIndex];
  const shot = episode?.shots.find(item => item.id === metadata.shotId);
  let directory = "video/assets/公共素材";
  let subject = metadata.label;
  if (metadata.designId) {
    directory = `video/assets/设定库/${design?.kind === "scene" ? "场景" : "人物"}/${filename(design?.name ?? metadata.label)}/${filename(design?.version ?? "未标注版本")}`;
    subject = design?.name ?? metadata.label;
  } else if (episode) {
    directory = `video/assets/剧情/第${String(episodeIndex + 1).padStart(3, "0")}集-${filename(episode.title)}/${kinds[metadata.kind]}`;
    subject = shot ? `镜头${String(episode.shots.indexOf(shot) + 1).padStart(3, "0")}-${shot.title}` : metadata.label;
  }
  return `${directory}/${filename(subject)}-${metadata.view ? views[metadata.view] : kinds[metadata.kind]}`;
}
