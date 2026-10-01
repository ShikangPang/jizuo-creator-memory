import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { StoryboardChatRequest } from "../../jizuo-client/src/video/storyboard-chat.ts";
import type { ChapterExcerptQuote } from "../../jizuo-client/src/overlay/ChapterInspector.tsx";
import type { VideoEpisodeQuote } from "../../jizuo-client/src/video/VideoInspector.tsx";
export interface NativeShellSlots {
  inject(name: string, install: () => () => void): () => void;
  register(options: Record<string, unknown>, component: unknown): () => void;
}

export interface NativeShellHost {
  slots: NativeShellSlots;
  workspaces: {
    archiveSession?(sessionId: string): Promise<void>;
    list?: {
      subscribe?(listener: () => void): () => void;
      getSnapshot(): {
        items?: readonly { workspaceId: WorkspaceId; path: string; title?: string; sessionIds: readonly string[] }[];
        archivedSessionIds: readonly string[];
      };
    };
    create?(input: { path: string }): Promise<{
      workspaceId: WorkspaceId;
      path: string;
      sessionIds: readonly string[];
    }>;
  };
  sessions?: {
    list: {
      subscribe?(listener: () => void): () => void;
      getSnapshot(): {
        current?: string | undefined;
        ids: readonly string[];
        byId: Readonly<Record<string, {
          id: string;
          cwd?: string;
          blank: boolean;
          title?: string;
          displayTitle?: string;
          updatedAt?: number;
        }>>;
      };
    };
    create(input: { workspaceId?: WorkspaceId }): Promise<string>;
    binding?(sessionId: string): { session: { rename(title: string): Promise<{ ok: true } | { ok: false; error: { message: string } }> } } | undefined;
    open(sessionId: string): void;
  };
  uiWorkspace: { startSession(workspaceId?: WorkspaceId): void; pickDirectory?(): Promise<string | null> };
  layout: { toggleSidebar(): void };
  conversation?: { generateStoryboard?(request: StoryboardChatRequest): Promise<void>; appendChapterExcerpt(quote: ChapterExcerptQuote): boolean; appendVideoEpisode?(quote: VideoEpisodeQuote): boolean };
}
