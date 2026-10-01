import type { JizuoRemoteService } from "./remote-service.ts";
import type { JizuoService } from "./service.ts";
import type { WorkflowChapterWriteToolPort } from "./tools.ts";
/** Shared data ownership survives unloading optional tool/UI plugins. */
export interface CreationHostRuntime {
  readonly apis: JizuoRemoteService["creationApis"];
  readonly service: JizuoService;
  readonly workflowChapterWrites: WorkflowChapterWriteToolPort | undefined;
}
