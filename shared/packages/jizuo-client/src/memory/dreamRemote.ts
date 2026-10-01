import type {
  DreamCommand,
  DreamModelOption,
  DreamSettings,
  DreamStatus,
  DreamWorkReport,
  DreamChapterConversations,
  MemorySuggestionDetail,
  MemorySuggestionSummary,
} from "@jizuo/memory-domain";

export interface DreamWorkRemote {
  getStatus?(): Promise<DreamStatus>;
  getReport?(): Promise<DreamWorkReport>;
  getConversations?(target: { volumeId: string; chapterId: string }): Promise<DreamChapterConversations>;
  listModels?(): Promise<DreamModelOption[]>;
  control?(command: DreamCommand): Promise<unknown>;
  getSettings(): Promise<DreamSettings>;
  saveSettings(settings: DreamSettings): Promise<DreamSettings>;
  listSuggestions(): Promise<MemorySuggestionSummary[]>;
  getSuggestion?(episodeKey: string): Promise<MemorySuggestionDetail>;
  acceptSuggestion(episodeKey: string): Promise<unknown>;
  rejectSuggestion(episodeKey: string): Promise<unknown>;
}

export interface DreamRemoteSource {
  getDreamStatus?(workId: string): Promise<DreamStatus>;
  getDreamReport?(workId: string): Promise<DreamWorkReport>;
  getDreamConversations?(target: { workId: string; volumeId: string; chapterId: string }): Promise<DreamChapterConversations>;
  listDreamModels?(): Promise<DreamModelOption[]>;
  controlDream?(workId: string, command: DreamCommand): Promise<unknown>;
  getDreamSettings(workId: string): Promise<DreamSettings>;
  saveDreamSettings(workId: string, settings: DreamSettings): Promise<DreamSettings>;
  listMemorySuggestions(workId: string): Promise<MemorySuggestionSummary[]>;
  getMemorySuggestion?(workId: string, episodeKey: string): Promise<MemorySuggestionDetail>;
  acceptMemorySuggestion(workId: string, episodeKey: string): Promise<unknown>;
  rejectMemorySuggestion(workId: string, episodeKey: string): Promise<unknown>;
}

export function createDreamSettingsRemote(remote: DreamRemoteSource, workId: string): DreamWorkRemote {
  return {
    ...(remote.getDreamStatus ? { getStatus: () => remote.getDreamStatus!(workId) } : {}),
    ...(remote.getDreamReport ? { getReport: () => remote.getDreamReport!(workId) } : {}),
    ...(remote.getDreamConversations ? { getConversations: (target: { volumeId: string; chapterId: string }) => remote.getDreamConversations!({ ...target, workId }) } : {}),
    ...(remote.listDreamModels ? { listModels: () => remote.listDreamModels!() } : {}),
    ...(remote.controlDream ? { control: (command: DreamCommand) => remote.controlDream!(workId, command) } : {}),
    getSettings: () => remote.getDreamSettings(workId),
    saveSettings: (settings) => remote.saveDreamSettings(workId, settings),
    listSuggestions: () => remote.listMemorySuggestions(workId),
    ...(remote.getMemorySuggestion ? { getSuggestion: (episodeKey: string) => remote.getMemorySuggestion!(workId, episodeKey) } : {}),
    acceptSuggestion: (episodeKey) => remote.acceptMemorySuggestion(workId, episodeKey),
    rejectSuggestion: (episodeKey) => remote.rejectMemorySuggestion(workId, episodeKey),
  };
}
