import { panels as writing } from "../../writing-plugin/src/client.tsx";
import { panels as video } from "../../video-plugin/src/client.tsx";
import { panels as memory } from "../../memory-plugin/src/client.tsx";
import type { PanelFactory } from "./creation-client.ts";
/** Source compatibility only. Production registers each feature via its own Harness client. */
export const createWorkspacePanelContributions: PanelFactory = (...args) => ({ ...writing(...args), ...video(...args), ...memory(...args) });
