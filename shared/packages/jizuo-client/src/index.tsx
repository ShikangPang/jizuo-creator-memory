export {
  createDraftPersistence,
  type DraftPersistence,
  type KeyValueStorage,
  type PersistedDraft,
} from "./persistence.ts";
export { DiffReview } from "./editor/DiffReview.tsx";
export { RevisionPanel, type ChapterRevisionItem } from "./editor/RevisionPanel.tsx";
export { useAutosave, type AutosaveState } from "./editor/useAutosave.ts";
export {
  MemoryPalace,
  type MemoryGraphController,
  type MemoryPalaceOverlayRemote,
  type MemoryPalaceRemote,
} from "./memory/MemoryPalace.tsx";
export { DreamSettings, type DreamSettingsRemote, type DreamSuggestionSummary } from "./memory/DreamSettings.tsx";
export { AccountPanel, type AccountPanelState, type AccountRemote } from "./account/AccountPanel.tsx";
export {
  ModelSettings,
  validateByokEndpoint,
  type ByokSettings,
  type HostedModel,
  type ModelSettingsRemote,
} from "./account/ModelSettings.tsx";
export {
  WorksSidebarPanel,
  type SubscribeWorksChanges,
} from "./sidebar/WorksSidebarPanel.tsx";
export { JizuoBrand } from "./sidebar/JizuoBrand.tsx";
export { JizuoBrandMark, type JizuoBrandMarkProps } from "./brand/JizuoBrandMark.tsx";
export { JizuoSidebarRoot, type JizuoSidebarRootProps } from "./sidebar/JizuoSidebarRoot.tsx";
export type {
  JizuoSidebarInjected,
  JizuoSidebarSlotProps,
  SidebarFooterActionOwnerProps,
  SidebarSectionOwnerProps,
  SidebarSettingsOwnerProps,
} from "./sidebar/slots.ts";
export type {
  JizuoContentRemote,
  JizuoWorkflowContentRemote,
  JizuoWorkflowRemote,
} from "./content/remote.ts";
export {
  WorkflowRunsStore,
  WorkflowStoreError,
  WorkflowStoreUnavailableError,
  type WorkflowProjectionPhase,
  type WorkflowRunsSnapshot,
  type WorkflowRunsStoreOptions,
  type WorkflowSessionSource,
} from "./workflow/workflowStore.ts";
export { useWorkflowRuns, useWorkflowRunsSnapshot, type UseWorkflowRunsOptions } from "./workflow/useWorkflowRuns.ts";
export { ChapterWorkflowProgressDock, type ChapterWorkflowProgressDockProps } from "./workflow/ChapterWorkflowProgressDock.tsx";
export { WorkflowProgressPill, workflowStatusLabel, type WorkflowProgressPillProps } from "./workflow/WorkflowProgressPill.tsx";
export { WorkflowRunPopover, type WorkflowRunAction, type WorkflowRunPopoverProps } from "./workflow/WorkflowRunPopover.tsx";
export {
  createChapterExcerptReference,
  createChapterTriggerSource,
  decodeChapterExcerptReference,
  registerChapterTriggers,
  type ChapterExcerptReferenceInput,
  type ChapterTriggerCandidate,
  type ChapterTriggerService,
  type ChapterTriggerSource,
  type EncodedChapterExcerpt,
} from "./content/chapterTriggers.ts";
export {
  clearSelection,
  switchWorkMode,
  restoreWorkSelection,
  type WorkContentMode,
  getSelection,
  setSelection,
  subscribeSelection,
  useSelection,
  type JizuoOverlay,
  type JizuoSelection,
} from "./content/selection.ts";
export type { ChapterExcerptQuote } from "./overlay/ChapterInspector.tsx";


export { applyConversationInset, clearConversationInset } from "./overlay/shellChrome.ts";
export { JizuoSettingsCard } from "./settings/JizuoSettingsCard.tsx";
export { AboutJizuo, type AboutJizuoRemote } from "./settings/AboutJizuo.tsx";
export { UpdateNoticeDialog, type UpdateNotice, type UpdateNoticeStore } from "./settings/UpdateNoticeDialog.tsx";
export { ModelOutputSettings, type ModelOutputSettingsRemote } from "./settings/ModelOutputSettings.tsx";
export {
  WorkStorageSettings,
  type WorkLocationStatus,
  type WorkLocations,
  type WorkLocationsRemote,
  type WorkStorageSettingsProps,
} from "./settings/WorkStorageSettings.tsx";

export type { SessionNavigation, WorkSessionItem } from "./sidebar/sessionNavigation.ts";

export { ProviderModelsSettings, type ProviderModelsSettingsOwner, type ProviderModelsSettingsProps } from "./settings/ProviderModelsSettings.tsx";
export { DreamMemorySettings } from "./settings/DreamMemorySettings.tsx";

export type { VideoInspectorProps, VideoEpisodeQuote } from "./video/VideoInspector.tsx";

export { MediaModelsSettings, type MediaSettingsRemote, type MediaLibraryRemote } from "./settings/MediaModelsSettings.tsx";

export { SpeechModelsSettings, type SpeechSettingsRemote } from "./settings/SpeechModelsSettings.tsx";
export { ComposerModelTypeControl, type ComposerModelTypeControlProps, type ComposerInputPhaseStore } from "./video/ComposerModelTypeControl.tsx";
export { ComposerPromptReferencePreview } from "./video/ComposerPromptReferencePreview.tsx";

export { ChapterInspector, VolumeOutlineInspector, VideoInspector, MemoryPalaceOverlay } from "./plugins/panels.tsx";
