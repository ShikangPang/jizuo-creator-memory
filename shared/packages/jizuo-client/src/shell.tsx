// Shared shell exports deliberately exclude optional editors and their module side effects.
export type * from "./index.tsx";
export { ChapterWorkflowProgressDock } from "./workflow/ChapterWorkflowProgressDock.tsx";
export { AboutJizuo } from "./settings/AboutJizuo.tsx";
export { UpdateNoticeDialog } from "./settings/UpdateNoticeDialog.tsx";
export { JizuoSettingsCard } from "./settings/JizuoSettingsCard.tsx";
export { ProviderModelsSettings } from "./settings/ProviderModelsSettings.tsx";
export { MediaModelsSettings } from "./settings/MediaModelsSettings.tsx";
export { DreamMemorySettings } from "./settings/DreamMemorySettings.tsx";
export { WorkStorageSettings } from "./settings/WorkStorageSettings.tsx";
export { JizuoSidebarRoot } from "./sidebar/JizuoSidebarRoot.tsx";
export { createChapterExcerptReference, registerChapterTriggers } from "./content/chapterTriggers.ts";
export { getSelection, setSelection, subscribeSelection, clearSelection, restoreWorkSelection } from "./content/selection.ts";
export { WorkflowStoreUnavailableError } from "./workflow/workflowStore.ts";
