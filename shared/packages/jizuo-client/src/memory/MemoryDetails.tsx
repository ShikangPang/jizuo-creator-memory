import type { MemoryGraph } from "@jizuo/memory-domain";
import { memoryEdgeElementId, type MemoryGraphSelection } from "./graphSelection.ts";

function nodeName(graph: MemoryGraph, id: string): string {
  return graph.nodes.find((node) => node.id === id)?.name ?? "未知记忆";
}

export function MemoryDetails({
  graph,
  selection,
}: {
  graph: MemoryGraph | null;
  selection: MemoryGraphSelection;
}) {
  const selectedNode = selection?.kind === "node"
    ? graph?.nodes.find((node) => node.id === selection.id) ?? null
    : null;
  const selectedEdge = selection?.kind === "edge"
    ? graph?.edges.find((edge) => memoryEdgeElementId(edge) === selection.id) ?? null
    : null;
  const relatedEdges = graph === null ? [] : selectedNode === null
    ? selectedEdge === null ? [] : [selectedEdge]
    : graph.edges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id);
  const relatedStates = graph === null || selectedNode === null
    ? []
    : graph.states.filter((state) => state.identityId === selectedNode.id);
  const evidenceIds = new Set([
    ...relatedEdges.map((edge) => edge.evidenceId),
    ...(selectedNode?.evidenceIds ?? []),
    ...relatedStates.flatMap((state) => state.evidenceIds),
  ]);
  const evidence = graph?.evidence.filter((item) => evidenceIds.has(item.id)) ?? [];

  return (
    <aside className="jz-memory-details" aria-label="记忆证据详情" aria-live="polite">
      <h2>证据详情</h2>
      {graph === null ? (
        <p>正在准备证据详情。</p>
      ) : selection === null || (selectedNode === null && selectedEdge === null) ? (
        <p>点击人物或关系线查看证据。</p>
      ) : (
        <>
          <header className="jz-memory-details-selection">
            <h3>
              {selectedNode?.name
                ?? `${nodeName(graph, selectedEdge!.source)} → ${nodeName(graph, selectedEdge!.target)}`}
            </h3>
            <p>
              {selectedEdge === null
                ? `${relatedEdges.length} 条关系，${evidence.length} 条证据`
                : `关系：${selectedEdge.type}`}
            </p>
          </header>
          {evidence.length === 0 ? (
            <p className="jz-memory-details-empty">当前记忆没有关联的原文证据。</p>
          ) : (
            <ol>
              {evidence.map((item) => {
                const edge = relatedEdges.find((candidate) => candidate.evidenceId === item.id);
                const state = relatedStates.find((candidate) => candidate.evidenceIds.includes(item.id));
                return (
                  <li key={`${item.id}-${item.episodeKey}`}>
                    <strong>第 {item.chapterNumber} 章</strong>
                    {edge !== undefined && (
                      <span className="jz-memory-evidence-relation">
                        {nodeName(graph, edge.source)} → {nodeName(graph, edge.target)}，{edge.type}
                      </span>
                    )}
                    {edge === undefined && state !== undefined && (
                      <span className="jz-memory-evidence-relation">
                        状态：{state.key} = {state.value}
                      </span>
                    )}
                    <p>{item.excerpt}</p>
                    <code title={item.contentHash}>内容哈希 {item.contentHash.slice(0, 12)}</code>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </aside>
  );
}
