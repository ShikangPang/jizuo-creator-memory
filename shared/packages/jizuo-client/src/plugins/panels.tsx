import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from "react";
const Chapter = lazy(() => import("../overlay/ChapterInspector.tsx").then(module => ({ default: module.ChapterInspector })));
const Volume = lazy(() => import("../overlay/VolumeOutlineInspector.tsx").then(module => ({ default: module.VolumeOutlineInspector })));
const Video = lazy(() => import("../video/VideoInspector.tsx").then(module => ({ default: module.VideoInspector })));
const Memory = lazy(() => import("../overlay/MemoryPalaceOverlay.tsx").then(module => ({ default: module.MemoryPalaceOverlay })));

class PanelBoundary extends Component<{ children: ReactNode; close: (() => void) | undefined }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert">编辑插件加载失败，请关闭后重试。<button onClick={this.props.close}>关闭</button></div>;
    return <Suspense fallback={<p role="status">正在打开编辑插件…</p>}>{this.props.children}</Suspense>;
  }
}
export function ChapterInspector(props: ComponentProps<typeof Chapter>) {
  return <PanelBoundary close={props.close}><Chapter {...props} /></PanelBoundary>;
}
export function VolumeOutlineInspector(props: ComponentProps<typeof Volume>) {
  return <PanelBoundary close={props.close}><Volume {...props} /></PanelBoundary>;
}
export function VideoInspector(props: ComponentProps<typeof Video>) {
  return <PanelBoundary close={props.close}><Video {...props} /></PanelBoundary>;
}
export function MemoryPalaceOverlay(props: ComponentProps<typeof Memory>) {
  return <PanelBoundary close={props.close}><Memory {...props} /></PanelBoundary>;
}
