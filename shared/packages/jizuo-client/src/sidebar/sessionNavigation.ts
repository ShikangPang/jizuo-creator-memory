export interface WorkSessionItem {
  id: string;
  title: string;
  current: boolean;
}

/** Host-owned sessions stay separate from durable work content. */
export interface SessionNavigation {
  newGeneralSession?(): Promise<void>;
  listGeneralSessions?(): Promise<WorkSessionItem[]>;
  listWorkSessions(workId: string): Promise<WorkSessionItem[]>;
  subscribe(listener: () => void): () => void;
  openSession(sessionId: string, workId?: string): void;
  newWorkSession(workId: string): Promise<void>;
  pickWorkspace?(): Promise<boolean>;
  renameSession?(sessionId: string, title: string): Promise<void>;
  archiveSession?(sessionId: string): Promise<void>;
}
