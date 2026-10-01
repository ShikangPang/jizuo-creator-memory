import type { VideoClip, VideoTextOverlay } from "@jizuo/contracts";
export type TimelineClipboard = { kind:"texts"; items:VideoTextOverlay[] } | {kind:"clips";items:VideoClip[]};
