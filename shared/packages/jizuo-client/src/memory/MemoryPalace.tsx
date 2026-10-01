import { userErrorMessage } from "@jizuo/contracts";
import { IconButton } from "../ui/IconButton.tsx";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CanvasEvent,
  EdgeEvent,
  Graph,
  NodeEvent,
  type IElementEvent,
} from "@antv/g6/esm/index.js";
import type { MemoryGraph, MemoryQueryInput } from "@jizuo/memory-domain";
import type { DreamRemoteSource } from "./dreamRemote.ts";

import { MemoryDetails } from "./MemoryDetails.tsx";
import { MemoryFilters, type MemoryFilterDraft } from "./MemoryFilters.tsx";
import { memoryEdgeElementId, type MemoryGraphSelection } from "./graphSelection.ts";
import "./memory.css";

export interface MemoryPalaceRemote {
  queryMemory(query: MemoryQueryInput): Promise<MemoryGraph>;
}

export interface MemoryPalaceOverlayRemote extends MemoryPalaceRemote, DreamRemoteSource {}

export interface MemoryGraphController {
  replaceData(graph: MemoryGraph): Promise<void> | void;
  zoomBy(ratio: number): Promise<void> | void;
  fitView(): Promise<void> | void;
  resize(width: number, height: number): Promise<void> | void;
  destroy(): void;
}

export type MemoryGraphControllerFactory = (
  container: HTMLElement,
  onSelectionChange: (selection: MemoryGraphSelection) => void,
) => MemoryGraphController;

const ROOM_STYLE = {
  characters: { fill: "#5f7fae", stroke: "#3f628f", text: "#f8fafc" },
  world: { fill: "#4f927d", stroke: "#33725f", text: "#f4fffb" },
  clues: { fill: "#b3823e", stroke: "#8c632d", text: "#fffaf0" },
  plot: { fill: "#ad657b", stroke: "#88475c", text: "#fff7fa" },
  style: { fill: "#7668a6", stroke: "#574a86", text: "#fbfaff" },
} as const;

function compactNodeLabel(name: string): string {
  const characters = Array.from(name.trim() || "未命名");
  const visible = characters.length > 8 ? [...characters.slice(0, 7), "…"] : characters;
  if (visible.length <= 4) return visible.join("");
  const splitAt = Math.ceil(visible.length / 2);
  return `${visible.slice(0, splitAt).join("")}\n${visible.slice(splitAt).join("")}`;
}

class G6MemoryGraphController implements MemoryGraphController {
  private readonly graph: Graph;
  private readonly onSelectionChange: (selection: MemoryGraphSelection) => void;
  private selectedElementId: string | null = null;

  constructor(container: HTMLElement, onSelectionChange: (selection: MemoryGraphSelection) => void) {
    this.onSelectionChange = onSelectionChange;
    this.graph = new Graph({
      container,
      data: { nodes: [], edges: [] },
      autoFit: "view",
      padding: 48,
      canvas: { enableMultiLayer: false },
      layout: {
        type: "force",
        linkDistance: 130,
        nodeStrength: 620,
        gravity: 8,
        preventOverlap: true,
        nodeSpacing: 24,
      },
      node: {
        type: "circle",
        style: {
          labelPlacement: "center",
          labelFontSize: 14,
          labelFontWeight: 600,
          shadowColor: "rgba(15, 23, 42, 0.14)",
          shadowBlur: 8,
          shadowOffsetY: 3,
        },
        state: {
          selected: {
            halo: true,
            haloLineWidth: 14,
            haloStroke: "#4d6bfe",
            haloStrokeOpacity: 0.2,
            lineWidth: 3,
            labelFontSize: 14,
          },
        },
      },
      edge: {
        type: "line",
        style: {
          stroke: "rgba(71, 85, 105, 0.42)",
          lineWidth: 1.2,
          endArrow: true,
          increasedLineWidthForHitTesting: 8,
          cursor: "pointer",
        },
        state: {
          selected: {
            halo: true,
            haloStroke: "#4d6bfe",
            haloStrokeOpacity: 0.18,
            stroke: "#4d6bfe",
            lineWidth: 3,
          },
        },
      },
      behaviors: ["drag-canvas", "zoom-canvas", "drag-element", "hover-activate"],
      zoomRange: [0.4, 2.5],
      animation: false,
    });
    this.graph.on<IElementEvent>(NodeEvent.CLICK, (event) => {
      this.select({ kind: "node", id: String(event.target.id) });
    });
    this.graph.on<IElementEvent>(EdgeEvent.CLICK, (event) => {
      this.select({ kind: "edge", id: String(event.target.id) });
    });
    this.graph.on(CanvasEvent.CLICK, () => {
      this.select(null);
    });
  }

  private select(selection: MemoryGraphSelection): void {
    const nextElementId = selection?.id ?? null;
    const states: Record<string, string[]> = {};
    if (this.selectedElementId !== null && this.selectedElementId !== nextElementId) {
      states[this.selectedElementId] = [];
    }
    if (nextElementId !== null) states[nextElementId] = ["selected"];
    if (Object.keys(states).length > 0) {
      void this.graph.setElementState(states, false).catch(() => undefined);
    }
    this.selectedElementId = nextElementId;
    this.onSelectionChange(selection);
  }

  async replaceData(graph: MemoryGraph): Promise<void> {
    this.selectedElementId = null;
    this.graph.setData({
      nodes: graph.nodes.map((node) => {
        const color = ROOM_STYLE[node.room];
        return {
          id: node.id,
          type: "circle",
          data: { ...node },
          style: {
            size: 84,
            fill: color.fill,
            stroke: color.stroke,
            lineWidth: 1.5,
            cursor: "pointer",
            labelText: compactNodeLabel(node.name),
            labelFill: color.text,
            labelFontSize: 14,
            labelFontWeight: 600,
            labelLineHeight: 20,
          },
        };
      }),
      edges: graph.edges.map((edge) => ({
        id: memoryEdgeElementId(edge),
        source: edge.source,
        target: edge.target,
        data: { ...edge },
      })),
    });
    await this.graph.render();
  }

  zoomBy(ratio: number) { return this.graph.zoomBy(ratio); }
  fitView() { return this.graph.fitView({ when: "always", direction: "both" }); }
  resize(width: number, height: number) { this.graph.resize(width, height); }
  destroy() { this.graph.destroy(); }
}

const createG6MemoryGraphController: MemoryGraphControllerFactory = (container, onSelectionChange) => (
  new G6MemoryGraphController(container, onSelectionChange)
);

const ROOMS = [
  ["characters", "人物"],
  ["world", "世界"],
  ["clues", "线索"],
  ["plot", "情节"],
  ["style", "风格"],
] as const;

type MemoryRoom = (typeof ROOMS)[number][0];

function filterGraphByRoom(graph: MemoryGraph, room: MemoryRoom | null): MemoryGraph {
  if (room === null) return graph;
  const nodes = graph.nodes.filter((node) => node.room === room);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const states = graph.states.filter((state) => nodeIds.has(state.identityId));
  const evidenceIds = new Set(edges.map((edge) => edge.evidenceId));
  nodes.forEach((node) => node.evidenceIds.forEach((evidenceId) => evidenceIds.add(evidenceId)));
  states.forEach((state) => state.evidenceIds.forEach((evidenceId) => evidenceIds.add(evidenceId)));
  return {
    ...graph,
    nodes,
    states,
    edges,
    evidence: graph.evidence.filter((evidence) => evidenceIds.has(evidence.id)),
  };
}

export function MemoryPalace({
  workId,
  remote,
  controllerFactory = createG6MemoryGraphController,
  initialQuery = { mode: "range_strict", from: 1, to: 1 },
}: {
  workId: string;
  remote: MemoryPalaceRemote;
  controllerFactory?: MemoryGraphControllerFactory;
  initialQuery?: MemoryFilterDraft;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MemoryGraphController | null>(null);
  const requestRef = useRef(0);
  const [draft, setDraft] = useState<MemoryFilterDraft>(initialQuery);
  const [query, setQuery] = useState<MemoryFilterDraft>(initialQuery);
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<MemoryRoom | null>(null);
  const [selection, setSelection] = useState<MemoryGraphSelection>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const visibleGraph = useMemo(
    () => graph === null ? null : filterGraphByRoom(graph, selectedRoom),
    [graph, selectedRoom],
  );

  useEffect(() => {
    if (containerRef.current === null) return;
    const controller = controllerFactory(containerRef.current, setSelection);
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [controllerFactory]);

  useEffect(() => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    remote.queryMemory({ workId, ...query }).then((next) => {
      if (request !== requestRef.current) return;
      setGraph(next);
      setSelectedRoom(null);
      setSelection(null);
    }).catch((cause: unknown) => {
      if (request === requestRef.current) {
        setError(userErrorMessage(cause, "记忆查询失败", { operation: "MemoryPalace", effect: "read" }));
      }
    }).finally(() => {
      if (request === requestRef.current) setLoading(false);
    });
  }, [query, remote, workId]);

  useEffect(() => {
    if (visibleGraph === null) return;
    Promise.resolve(controllerRef.current?.replaceData(visibleGraph)).catch((cause: unknown) => {
      setError(userErrorMessage(cause, "记忆图谱渲染失败", { operation: "MemoryPalace" }));
    });
  }, [visibleGraph]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const resize = (width: number, height: number): void => {
      if (width <= 0 || height <= 0) return;
      const controller = controllerRef.current;
      if (controller === null) return;
      Promise.resolve(controller.resize(width, height)).then(() => {
        if ((visibleGraph?.nodes.length ?? 0) > 0) return controller.fitView();
      }).catch((cause: unknown) => {
        setError(userErrorMessage(cause, "记忆图谱尺寸同步失败", { operation: "MemoryPalace" }));
      });
    };

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries.find((candidate) => candidate.target === container);
        if (entry !== undefined) resize(entry.contentRect.width, entry.contentRect.height);
      });
      observer.observe(container);
      return () => { observer.disconnect(); };
    }

    const onWindowResize = (): void => {
      const bounds = container.getBoundingClientRect();
      resize(bounds.width, bounds.height);
    };
    window.addEventListener("resize", onWindowResize);
    onWindowResize();
    return () => { window.removeEventListener("resize", onWindowResize); };
  }, [visibleGraph]);

  const hasNodes = (visibleGraph?.nodes.length ?? 0) > 0;
  const zoomTo = async (nextZoom: number) => {
    const bounded = Math.min(2.5, Math.max(0.4, nextZoom));
    if (bounded === zoom) return;
    await controllerRef.current?.zoomBy(bounded / zoom);
    setZoom(bounded);
  };

  return (
    <section className="jz-memory-palace">
      <div className="jz-memory-querybar">
        <MemoryFilters value={draft} loading={loading} onChange={setDraft} onSubmit={() => { setQuery({ ...draft }); }} />
      </div>

      <nav className="jz-memory-rooms" aria-label="记忆房间">
        <button
          type="button"
          aria-pressed={selectedRoom === null}
          onClick={() => { setSelectedRoom(null); setSelection(null); }}
        >
          全部<b>{graph?.nodes.length ?? 0}</b>
        </button>
        {ROOMS.map(([room, label]) => (
          <button
            key={room}
            type="button"
            aria-pressed={selectedRoom === room}
            onClick={() => {
              setSelectedRoom((current) => current === room ? null : room);
              setSelection(null);
            }}
          >
            {label}<b>{graph?.nodes.filter((node) => node.room === room).length ?? 0}</b>
          </button>
        ))}
      </nav>

      <div className="jz-memory-workspace">
        <section className="jz-memory-canvas" aria-label="时序记忆图">
          <div className="jz-memory-toolbar">
            <IconButton icon="zoomOut" label={"缩小记忆图"} type="button" aria-label="缩小记忆图" disabled={!hasNodes || zoom <= 0.4} onClick={() => { void zoomTo(zoom / 1.2); }} />
            <output aria-label="当前缩放倍率">{Math.round(zoom * 100)}%</output>
            <IconButton icon="zoomIn" label={"放大记忆图"} type="button" aria-label="放大记忆图" disabled={!hasNodes || zoom >= 2.5} onClick={() => { void zoomTo(zoom * 1.2); }} />
            <IconButton icon="fit" label={"适应画布"} type="button" aria-label="适应画布" disabled={!hasNodes} onClick={() => { void controllerRef.current?.fitView(); setZoom(1); }} />
          </div>
          <div className="jz-memory-graph" ref={containerRef} />
          {loading && <div className="jz-memory-loading" role="status">正在按新范围查询，当前图暂时保留…</div>}
          {!loading && visibleGraph?.nodes.length === 0 && (
            <div className="jz-memory-empty">
              {graph?.nodes.length === 0 ? "这个范围还没有已确认记忆。" : "这个宫殿暂无记忆，选择其他分类查看。"}
            </div>
          )}
          {error !== null && <div className="jz-memory-error" role="alert">{error}</div>}
        </section>
        <MemoryDetails graph={visibleGraph} selection={selection} />
      </div>
    </section>
  );
}
