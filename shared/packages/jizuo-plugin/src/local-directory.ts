import { subscribeVideoProject } from "../../jizuo-client/src/video/useVideoProject.ts";
import { getSelection, subscribeSelection } from "../../jizuo-client/src/content/selection.ts";
import type { JizuoContentRemote } from "../../jizuo-client/src/content/remote.ts";

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
const join = (root: string, path: string) => `${normalize(root)}/${path}`;

/** Resolve at click time so renames and navigation cannot leave a cached directory behind. */
export async function resolveLocalDirectory(remote: JizuoContentRemote, cwd: string, selection = getSelection()): Promise<string> {
  if (!selection.workId || !remote.resolveWorkPath) return cwd;
  const { path: root } = await remote.resolveWorkPath(selection.workId);
  // A remembered selection may belong to another conversation.
  if (normalize(root) !== normalize(cwd)) return cwd;
  const workId = selection.workId;
  if (selection.mode === "video") {
    const project = remote.getVideoProjectView
      ? (await remote.getVideoProjectView(selection.designId || !selection.episodeId ? { workId, scope: "library" } : { workId, scope: "episode", episodeId: selection.episodeId })).project
      : await remote.getVideoProject?.({ workId });
    if (!project) return root;
    const episode = project.episodes.find(item => item.id === selection.episodeId && !item.deletedAt);
    const shot = episode?.shots.find(item => item.id === selection.shotId && !item.archived);
    const assetId = selection.videoSection === "shots" || selection.videoSection === "storyboard"
      ? shot?.videoAssetId ?? shot?.imageAssetId : undefined;
    const asset = project.assets.find(item => item.id === assetId && !item.deletedAt)
      ?? [...project.assets].reverse().find(item => !item.deletedAt && (
        selection.designId ? item.designId === selection.designId :
        selection.episodeId ? item.episodeId === selection.episodeId && (selection.videoSection !== "editing" || item.kind === "export") : false
      ));
    if (asset) {
      const path = asset.path.replace(/^\.jizuo\/video\//, "video/");
      return join(root, path.slice(0, path.lastIndexOf("/")));
    }
    return join(root, "video");
  }
  if (selection.volumeId && selection.chapterId && remote.resolveChapterPath) {
    return (await remote.resolveChapterPath({ workId, volumeId: selection.volumeId, chapterId: selection.chapterId })).path;
  }
  if (selection.volumeId) {
    const volume = (await remote.listVolumes({ workId })).find(item => item.id === selection.volumeId);
    if (volume) return join(root, `content/volumes/${volume.folderName}`);
  }
  return root;
}

export function registerLocalDirectoryQuery(remote: JizuoContentRemote): () => void {
  type Entry = { key: string; created: number; result: Promise<{ root: string; path: string }> };
  let entry: Entry | undefined;
  const keyOf = (selection: ReturnType<typeof getSelection>) => JSON.stringify([
    selection.workId, selection.volumeId, selection.chapterId, selection.chapterTitle,
    selection.mode, selection.episodeId, selection.shotId, selection.designId, selection.videoSection,
  ]);
  const prepare = () => {
    const selection = getSelection(), key = keyOf(selection);
    if (!selection.workId || !remote.resolveWorkPath) { entry = undefined; return; }
    if (entry?.key === key && Date.now() - entry.created < 30_000) return entry;
    const root = remote.resolveWorkPath(selection.workId);
    const result = root.then(async location => ({ root: location.path,
      path: await resolveLocalDirectory({ ...remote, resolveWorkPath: () => root }, location.path, selection),
    }));
    const next = { key, created: Date.now(), result }; entry = next;
    void result.catch(() => { if (entry === next) entry = undefined; });
    return next;
  };
  const unsubscribe = subscribeSelection(() => { prepare(); });
  const unsubscribeVideo = subscribeVideoProject(project => {
    if (project.workId === getSelection().workId && getSelection().mode === "video") { entry = undefined; prepare(); }
  });
  prepare();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ cwd: string; path?: Promise<string> }>).detail;
    if (!detail || typeof detail.cwd !== "string") return;
    const prepared = prepare();
    detail.path = prepared ? prepared.result.then(result => normalize(result.root) === normalize(detail.cwd) ? result.path : detail.cwd) : Promise.resolve(detail.cwd);
  };
  window.addEventListener("jizuo:local-directory-query", listener);
  return () => { unsubscribe(); unsubscribeVideo(); window.removeEventListener("jizuo:local-directory-query", listener); entry = undefined; };
}
