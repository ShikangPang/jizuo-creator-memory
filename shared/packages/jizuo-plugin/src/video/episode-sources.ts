import { JizuoError } from "@jizuo/contracts";
import type { JizuoService } from "../service.ts";

/** Source identity belongs to the novel; returned workId remains the video target. */
export async function readEpisodeSources(service: JizuoService, input: {workId:string;episodeId:string}) {
  const project = await service.video.read(input.workId);
  const episode = project.episodes.find(item => item.id === input.episodeId);
  if (!episode) throw new JizuoError("validation_error", "视频集不属于当前作品或已不存在");
  const works = await service.listWorks();
  const volumesByWork = new Map(await Promise.all([...new Set(episode.sourceChapters.map(source => source.sourceWorkId ?? input.workId))].map(async workId => [
    workId, works.some(work => work.id === workId) ? await service.listVolumes(workId) : [],
  ] as const)));
  const chaptersByVolume = new Map(await Promise.all([...new Map(episode.sourceChapters.map(source => {
    const workId = source.sourceWorkId ?? input.workId;
    return [`${workId}/${source.volumeId}`, {workId, volumeId: source.volumeId}] as const;
  })).entries()].map(async ([key, target]) => [key, volumesByWork.get(target.workId)?.some(volume => volume.id === target.volumeId) ? await service.listChapters(target) : []] as const)));
  return {workId: project.workId, episodeId: episode.id, title: episode.title, revision: project.revision, sourceChapters: episode.sourceChapters.map((source, index) => {
    const sourceWorkId = source.sourceWorkId ?? input.workId;
    const volume = volumesByWork.get(sourceWorkId)?.find(item => item.id === source.volumeId);
    const chapter = chaptersByVolume.get(`${sourceWorkId}/${source.volumeId}`)?.find(item => item.id === source.chapterId);
    return {...source, order: index + 1, volumeTitle: volume?.title ?? null, chapterTitle: chapter?.title ?? null,
      status: chapter ? "available" : !works.some(work => work.id === sourceWorkId) ? "work_missing" : volume ? "chapter_missing" : "volume_missing"};
  })};
}
