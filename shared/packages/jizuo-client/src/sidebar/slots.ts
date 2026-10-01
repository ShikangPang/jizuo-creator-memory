import type { SessionNavigation } from "./sessionNavigation.ts";
import type { WorkspaceId } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type { ReactNode } from "react";
import type { PickImportFile, SubscribeWorksChanges } from "./WorksSidebarPanel.tsx";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "sidebar.workspaces": { kind: "single"; scope: "root"; owner: SidebarSectionOwnerProps };
    "sidebar.settings": { kind: "single"; scope: "root"; owner: SidebarSettingsOwnerProps };
    "sidebar.footer.action": { kind: "list"; scope: "root"; owner: SidebarFooterActionOwnerProps };
  }
}

export interface SidebarSectionOwnerProps {
  wide: boolean;
  expandSidebar: () => void;
}

export interface SidebarSettingsOwnerProps {
  wide: boolean;
}

export interface SidebarFooterActionOwnerProps {
  wide: boolean;
}

export interface JizuoSidebarInjected {
  sessionNavigation?: SessionNavigation;
  startSession: (workspaceId?: WorkspaceId) => void;
  startWorkSession: (workId: string) => Promise<void>;
  pickImportFile: PickImportFile;
  pickExportFile?: (input: { title: string; format: import("@jizuo/contracts").NovelFileFormat }) => Promise<string | null>;
  subscribeWorksChanges?: SubscribeWorksChanges;
  toggleSidebar: () => void;
}

export interface JizuoSidebarSlotProps extends JizuoSidebarInjected {
  collapsed: boolean;
  width: number;
  t: (key: string) => string;
  renderSlot: (name: string, props: Record<string, unknown>) => ReactNode;
}
