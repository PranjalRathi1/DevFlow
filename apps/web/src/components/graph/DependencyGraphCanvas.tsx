import type { ScanDependencyGraph } from "../../types/graph";

export type GraphSelection = { type: "node"; id: string } | { type: "edge"; id: string } | null;

interface Props {
  graph: ScanDependencyGraph;
  selection: GraphSelection;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  scale: number;
}

const CELL_W = 190;
const CELL_H = 90;
const PADDING = 40;
const NODE_W = 160;
const NODE_H = 44;

/**
 * A deliberately simple, deterministic layout — NOT a graph layout
 * algorithm. Column/row position is derived directly from the backend's
 * own `topologicalOrder` (or a stable sort of node ids when the graph is
 * cyclic and no order exists), wrapped into a grid purely for on-screen
 * readability. No cycle detection, path resolution, or graph
 * construction happens here — see docs/DECISIONS.md's Batch C4 ADR for
 * why no graph-visualization library was added.
 */
function layout(graph: ScanDependencyGraph): {
  order: string[];
  positions: Map<string, { x: number; y: number }>;
} {
  const order = graph.topologicalOrder ?? [...graph.nodes.map((n) => n.id)].sort();
  const columns = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(order.length || 1))));
  const positions = new Map<string, { x: number; y: number }>();
  order.forEach((id, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    positions.set(id, { x: PADDING + col * CELL_W, y: PADDING + row * CELL_H });
  });
  return { order, positions };
}

/** Consecutive pairs within each reported cycle — reading data the backend already computed, not detecting anything. */
function cycleEdgeKeys(cycles: string[][]): Set<string> {
  const keys = new Set<string>();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.length - 1; i++) {
      keys.add(`${cycle[i]}::${cycle[i + 1]}`);
    }
  }
  return keys;
}

function shortLabel(id: string): string {
  const parts = id.split("/");
  const base = parts[parts.length - 1] ?? id;
  return base.length > 22 ? `${base.slice(0, 19)}…` : base;
}

export function DependencyGraphCanvas({ graph, selection, onSelectNode, onSelectEdge, scale }: Props) {
  const { order, positions } = layout(graph);
  const inCycle = cycleEdgeKeys(graph.cycles);

  const width = Math.max(
    400,
    PADDING * 2 + Math.min(8, Math.max(1, Math.ceil(Math.sqrt(order.length || 1)))) * CELL_W,
  );
  const height =
    PADDING * 2 +
    (Math.floor((order.length - 1) / Math.max(1, Math.min(8, Math.ceil(Math.sqrt(order.length || 1))))) + 1) *
      CELL_H;

  return (
    <div className="overflow-auto rounded-md border border-slate-200 bg-white" style={{ maxHeight: 480 }}>
      <svg
        role="img"
        aria-label={`Dependency graph visualization: ${graph.nodes.length} files, ${graph.edges.length} confirmed dependencies${graph.isAcyclic ? "" : `, ${graph.cycles.length} cycle(s) detected`}`}
        width={width * scale}
        height={height * scale}
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#64748b" />
          </marker>
          <marker id="arrow-cycle" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#dc2626" />
          </marker>
        </defs>

        {/* Visual-only edge lines — no interactivity here. In a dense grid
            layout an edge frequently passes under an unrelated node's
            rect; since SVG hit-testing gives later (topmost) DOM elements
            priority, a click on this line would often be intercepted by
            whatever node happens to be drawn on top of that pixel instead.
            The actual click target is the invisible, wider hit-line drawn
            after the nodes below — same visual result, reliably clickable. */}
        {graph.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const isCyclic = inCycle.has(edge.id);
          const isSelected = selection?.type === "edge" && selection.id === edge.id;
          return (
            <line
              key={edge.id}
              aria-hidden="true"
              x1={from.x + NODE_W / 2}
              y1={from.y + NODE_H / 2}
              x2={to.x + NODE_W / 2}
              y2={to.y + NODE_H / 2}
              stroke={isSelected ? "#1d4ed8" : isCyclic ? "#dc2626" : "#94a3b8"}
              strokeWidth={isSelected ? 3 : 2}
              strokeDasharray={isCyclic ? "4 3" : undefined}
              markerEnd={isCyclic ? "url(#arrow-cycle)" : "url(#arrow)"}
              pointerEvents="none"
            />
          );
        })}

        {order.map((id) => {
          const pos = positions.get(id);
          if (!pos) return null;
          const node = graph.nodes.find((n) => n.id === id);
          const isSelected = selection?.type === "node" && selection.id === id;
          const isRoot = graph.rootNodes.includes(id);
          const isLeaf = graph.leafNodes.includes(id);
          return (
            <g
              key={id}
              data-testid={`graph-node-${id}`}
              role="button"
              tabIndex={0}
              aria-label={`File ${id}${isRoot ? ", root (nothing imports it)" : ""}${isLeaf ? ", leaf (imports nothing locally)" : ""}`}
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={() => onSelectNode(id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelectNode(id);
              }}
              style={{ cursor: "pointer" }}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={isSelected ? "#dbeafe" : "#f8fafc"}
                stroke={isSelected ? "#1d4ed8" : "#cbd5e1"}
                strokeWidth={isSelected ? 2 : 1}
              />
              <text x={8} y={NODE_H / 2 + 4} fontSize={11} fill="#0f172a">
                {shortLabel(id)}
              </text>
              {node?.language && (
                <text x={8} y={NODE_H - 6} fontSize={9} fill="#64748b">
                  {node.language}
                </text>
              )}
            </g>
          );
        })}

        {/* Invisible, wider hit-areas for edges — rendered last (on top of
            the nodes above), so a click reliably reaches the edge even
            where its visible line passes underneath an unrelated node's
            box. Carries all the interactive/accessible semantics that
            used to live on the visual line. */}
        {graph.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const isCyclic = inCycle.has(edge.id);
          return (
            <line
              key={edge.id}
              data-testid={`graph-edge-${edge.id}`}
              role="button"
              tabIndex={0}
              aria-label={`Dependency: ${edge.from} imports ${edge.to}${isCyclic ? " (part of a cycle)" : ""}`}
              x1={from.x + NODE_W / 2}
              y1={from.y + NODE_H / 2}
              x2={to.x + NODE_W / 2}
              y2={to.y + NODE_H / 2}
              stroke="transparent"
              strokeWidth={12}
              onClick={() => onSelectEdge(edge.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelectEdge(edge.id);
              }}
              style={{ cursor: "pointer" }}
            >
              <title>{`${edge.from} -> ${edge.to}`}</title>
            </line>
          );
        })}
      </svg>
    </div>
  );
}
