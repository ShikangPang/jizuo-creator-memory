export const WORK_IMAGE_DRAG_TYPE = "application/x-jizuo-work-image";

export type WorkImageDragPayload = { workId: string; assetId: string };

const stableId = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

export function parseWorkImageDrag(raw: string): WorkImageDragPayload | undefined {
  if (!raw || raw.length > 256) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const payload = value as Record<string, unknown>;
    if (Object.keys(payload).length !== 2
      || typeof payload.workId !== "string" || !stableId.test(payload.workId)
      || typeof payload.assetId !== "string" || !stableId.test(payload.assetId)) return;
    return { workId: payload.workId, assetId: payload.assetId };
  } catch { return; }
}

export function readWorkImageDrag(dataTransfer: Pick<DataTransfer, "getData">): WorkImageDragPayload | undefined {
  try { return parseWorkImageDrag(dataTransfer.getData(WORK_IMAGE_DRAG_TYPE)); }
  catch { return; }
}

export function writeWorkImageDrag(dataTransfer: Pick<DataTransfer, "clearData" | "setData" | "effectAllowed">, payload: WorkImageDragPayload): void {
  dataTransfer.clearData();
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(WORK_IMAGE_DRAG_TYPE, JSON.stringify({ workId: payload.workId, assetId: payload.assetId }));
}
