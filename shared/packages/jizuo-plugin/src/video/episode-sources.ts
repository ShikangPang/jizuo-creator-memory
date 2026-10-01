import { JizuoError } from "@jizuo/contracts";
import type { JizuoService } from "../service.ts";

/** Source identity belongs to the novel; returned workId remains the video target. */
export async function readEpisodeSources(service: JizuoService, input: {workId:string;episodeId:string;includeContent?:boolean | undefined}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const project = await service.video.read(input.workId);
  const episode = project.episodes.find(item => item.id === input.episodeId);
  if (!episode) throw new JizuoError("validation_error", "视频集不属于当前作品或已不存在");
  if (input.includeContent && episode.sourceChapters.length > 100) throw new JizuoError("validation_error", "一次读取最多支持 100 章，请缩小视频集原著范围；正文未截断");
  const works = await service.listWorks();
  const volumesByWork = new Map(await Promise.all([...new Set(episode.sourceChapters.map(source => source.sourceWorkId ?? input.workId))].map(async workId => [
    workId, works.some(work => work.id === workId) ? await service.listVolumes(workId) : [],
  ] as const)));
  const chaptersByVolume = new Map(await Promise.all([...new Map(episode.sourceChapters.map(source => {
    const workId = source.sourceWorkId ?? input.workId;
    return [`${workId}/${source.volumeId}`, {workId, volumeId: source.volumeId}] as const;
  })).entries()].map(async ([key, target]) => [key, volumesByWork.get(target.workId)?.some(volume => volume.id === target.volumeId) ? await service.listChapters(target) : []] as const)));
  const sourceChapters = episode.sourceChapters.map((source, index) => {
    const sourceWorkId = source.sourceWorkId ?? input.workId;
    const volume = volumesByWork.get(sourceWorkId)?.find(item => item.id === source.volumeId);
    const chapter = chaptersByVolume.get(`${sourceWorkId}/${source.volumeId}`)?.find(item => item.id === source.chapterId);
    return {...source, order: index + 1, volumeTitle: volume?.title ?? null, chapterTitle: chapter?.title ?? null,
      status: chapter ? "available" : !works.some(work => work.id === sourceWorkId) ? "work_missing" : volume ? "chapter_missing" : "volume_missing"};
  });
  const metadata = {workId: project.workId, episodeId: episode.id, title: episode.title, revision: project.revision, sourceChapters};
  if (!input.includeContent) return metadata;
  const unavailable = sourceChapters.find(source => source.status !== "available");
  if (unavailable) throw new JizuoError("validation_error", `第 ${unavailable.order} 个原著来源已不可用，请重新选择视频集的原著章节`, {sourceWorkId: unavailable.sourceWorkId ?? input.workId, volumeId: unavailable.volumeId, chapterId: unavailable.chapterId, status: unavailable.status});
  let characters = 0;
  const contents = [];
  for (const source of sourceChapters) {
    signal?.throwIfAborted();
    const sourceWorkId = source.sourceWorkId ?? input.workId;
    const chapter = await service.readChapter({workId: sourceWorkId, volumeId: source.volumeId, chapterId: source.chapterId});
    characters += chapter.content.length;
    if (characters > 100_000) throw new JizuoError("validation_error", "原著正文超过 100000 字符，请缩小视频集原著范围；正文未截断");
    contents.push({...source, sourceWorkId, content: chapter.content, currentRevisionToken: chapter.revisionToken});
  }
  signal?.throwIfAborted();
  if ((await service.video.read(input.workId)).revision !== project.revision) throw new JizuoError("revision_conflict", "视频集来源在读取期间已修改，请重新读取");
  return {...metadata, sourceChapters: contents};
}
