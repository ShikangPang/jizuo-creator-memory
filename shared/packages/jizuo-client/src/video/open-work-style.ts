import { setSelection } from "../content/selection.ts";

export function openWorkStyle(workId: string) {
  setSelection({workId, videoSection: "style", overlay: "video"});
}
