import type { VideoProject } from "@jizuo/contracts";
import type { StartVideoProductionInput, ControlVideoProductionInput } from "../../../contracts/src/video-production.ts";
import type { VideoEditingRemote } from "./editing-remote.ts";

export interface VideoProductionRemote extends VideoEditingRemote {
  startVideoProduction?(input: StartVideoProductionInput): Promise<VideoProject>;
  controlVideoProduction?(input: ControlVideoProductionInput): Promise<VideoProject>;
}
