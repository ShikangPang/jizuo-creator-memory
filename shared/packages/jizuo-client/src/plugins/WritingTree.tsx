import type { ReactNode } from "react";
import type { ChapterSummary, VolumeSummary, WorkSummary } from "@jizuo/contracts";
import { setSelection, useSelection } from "../content/selection.ts";
import { ActionIcon } from "../ui/ActionIcon.tsx";
import type { TreeTarget, CreateTarget } from "../sidebar/WorksSidebarPanel.tsx";

export interface WritingTreeProps {
  work: WorkSummary;
  volumes: Record<string, VolumeSummary[]>;
  chapters: Record<string, ChapterSummary[]>;
  expandedVolumeId: string | null;
  renameTarget: TreeTarget | null;
  setExpandedVolumeId(id: string | null): void;
  closeMenu(): void;
  beginCreate(target: CreateTarget): void;
  renderRename(target: TreeTarget): ReactNode;
  renderActions(target: TreeTarget, onCreate?: () => void, label?: string): ReactNode;
}
export function WritingTree({ work, volumes, chapters, expandedVolumeId, renameTarget, setExpandedVolumeId,
  closeMenu, beginCreate, renderRename, renderActions }: WritingTreeProps) {
  const selection = useSelection();
  return <>
    {(volumes[work.id] ?? []).length === 0 && <p className="jz-tree-empty">暂无分卷</p>}
    {(volumes[work.id] ?? []).map((volume) => {
      const volumeExpanded = expandedVolumeId === volume.id;
      const volumeTarget: TreeTarget = {
        kind: "volume",
        workId: work.id,
        volumeId: volume.id,
        title: volume.title,
      };
      const volumeRenaming = renameTarget !== null && renameTarget.kind === "volume" && renameTarget.volumeId === volume.id;
      return (
        <div key={volume.id} className="jz-volume-node" role="treeitem" aria-expanded={volumeExpanded}>
          <div className="jz-tree-row jz-tree-volume" data-selected={selection.volumeId === volume.id || undefined}>
            {volumeRenaming ? renderRename(volumeTarget) : (
              <>
                <button
                  type="button"
                  className="jz-tree-main"
                  aria-label={volume.title}
                  aria-current={selection.volumeId === volume.id ? "true" : undefined}
                  aria-expanded={volumeExpanded}
                  onClick={() => {
                    const nextExpanded = !volumeExpanded;
                    setExpandedVolumeId(nextExpanded ? volume.id : null);
                    closeMenu();
                    setSelection({ workId: work.id, volumeId: volume.id });
                  }}
                >
                  <span className={`jz-tree-chevron ${volumeExpanded ? "expanded" : ""}`}><ActionIcon name="right" className="jz-icon" /></span>
                  <span className="jz-tree-kind"><ActionIcon name="folder" className="jz-icon" /></span>
                  <span className="jz-tree-title">{volume.title}</span>
                  <span className="jz-tree-count">{(chapters[volume.id] ?? []).length || ""}</span>
                </button>
                {renderActions(volumeTarget, () => { beginCreate({ kind: "chapter", workId: work.id, volumeId: volume.id }); }, "新建章节")}
              </>
            )}
          </div>

          {volumeExpanded && (
            <div className="jz-tree-children chapters" role="group">
              {(chapters[volume.id] ?? []).length === 0 && <p className="jz-tree-empty">暂无章节</p>}
              {(chapters[volume.id] ?? []).map((chapter) => {
                const chapterTarget: TreeTarget = {
                  kind: "chapter",
                  workId: work.id,
                  volumeId: volume.id,
                  chapterId: chapter.id,
                  title: chapter.title,
                };
                const chapterRenaming = renameTarget !== null && renameTarget.kind === "chapter" && renameTarget.chapterId === chapter.id;
                return (
                  <div className="jz-tree-row jz-tree-chapter" key={chapter.id} role="treeitem" data-selected={selection.chapterId === chapter.id || undefined}>
                    {chapterRenaming ? renderRename(chapterTarget) : (
                      <>
                        <button
                          type="button"
                          className="jz-tree-main"
                          aria-current={selection.chapterId === chapter.id ? "true" : undefined}
                          onClick={() => {
                            closeMenu();
                            setSelection({
                              workId: work.id,
                              volumeId: volume.id,
                              chapterId: chapter.id,
                              chapterTitle: chapter.title,
                              overlay: "chapter",
                            });
                          }}
                        >
                          <span className="jz-tree-spacer" />
                          <span className="jz-tree-kind document"><ActionIcon name="document" className="jz-icon" /></span>
                          <span className="jz-tree-title">{chapter.title}</span>
                          {chapter.draftStatus === "pending" && <span className="jz-tree-status">待生成</span>}
                        </button>
                        {renderActions(chapterTarget)}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    })}
  </>;
}
