import { useMemo, useState } from "react";
import {
  GitBranch,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  X,
  RefreshCw,
} from "lucide-react";
import { useProjectContext } from "./useProjectContext";
import { useLatestScan } from "../../queries/scanQueries";
import { useDependencyGraph, useRunAnalysisForGraph } from "../../queries/graphQueries";
import { DependencyGraphCanvas, type GraphSelection } from "../../components/graph/DependencyGraphCanvas";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { LoadingState } from "../../components/ui/LoadingState";
import { ErrorState } from "../../components/ui/ErrorState";
import { EmptyState } from "../../components/ui/EmptyState";
import { RELATIONSHIP_STATUS_META } from "../../lib/statusMeta";
import { errorMessage } from "../../lib/errorMessage";
import { ApiError } from "../../services/apiClient";
import type { NonConfirmedRelationship, NonConfirmedStatus } from "../../types/graph";

const ZOOM_STEP = 0.15;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warning" | "danger" | undefined;
}) {
  const valueClass =
    tone === "danger"
      ? "text-danger-600"
      : tone === "warning" && value > 0
        ? "text-warning-700"
        : "text-slate-900";
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</p>
    </Card>
  );
}

function RelationshipRow({ rel }: { rel: NonConfirmedRelationship }) {
  const meta = RELATIONSHIP_STATUS_META[rel.status];
  return (
    <li className="flex flex-col gap-1 border-b border-slate-100 py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-slate-700" title={rel.importerRelativePath}>
          {rel.importerRelativePath}
        </span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      <p className="text-xs text-slate-500">
        <span className="font-mono">{rel.rawImport || "(no import target — file-level issue)"}</span>
        {rel.line !== undefined && <span className="text-slate-400"> · line {rel.line}</span>}
      </p>
      {rel.reason && <p className="text-xs text-slate-400">{rel.reason}</p>}
    </li>
  );
}

function DiagnosticSection({
  status,
  items,
}: {
  status: NonConfirmedStatus;
  items: NonConfirmedRelationship[];
}) {
  const [open, setOpen] = useState(false);
  const meta = RELATIONSHIP_STATUS_META[status];
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          )}
          {meta.label}
        </span>
        <Badge tone={items.length > 0 ? meta.tone : "neutral"}>{items.length}</Badge>
      </button>
      {open && (
        <ul className="pb-2">
          {items.length === 0 ? (
            <li className="py-1 text-xs text-slate-400">None found.</li>
          ) : (
            items.map((rel, i) => <RelationshipRow key={i} rel={rel} />)
          )}
        </ul>
      )}
    </div>
  );
}

export default function ProjectGraphTab() {
  const project = useProjectContext();
  const { data: latestScan, isLoading: scanLoading } = useLatestScan(project._id);
  const scanId = latestScan?._id;
  const { data: graph, isLoading: graphLoading, isError, error, refetch } = useDependencyGraph(scanId);
  const runAnalysis = useRunAnalysisForGraph(scanId);

  const [selection, setSelection] = useState<GraphSelection>(null);
  const [scale, setScale] = useState(1);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const isMissingAnalysis = isError && error instanceof ApiError && error.status === 404;

  const selectedNode = useMemo(() => {
    if (!graph || selection?.type !== "node") return null;
    return graph.nodes.find((n) => n.id === selection.id) ?? null;
  }, [graph, selection]);

  const selectedEdge = useMemo(() => {
    if (!graph || selection?.type !== "edge") return null;
    return graph.edges.find((e) => e.id === selection.id) ?? null;
  }, [graph, selection]);

  const dependenciesOfSelected = useMemo(() => {
    if (!graph || !selectedNode) return [];
    return graph.edges.filter((e) => e.from === selectedNode.id).map((e) => e.to);
  }, [graph, selectedNode]);

  const dependentsOfSelected = useMemo(() => {
    if (!graph || !selectedNode) return [];
    return graph.edges.filter((e) => e.to === selectedNode.id).map((e) => e.from);
  }, [graph, selectedNode]);

  function runAnalysisNow() {
    setAnalysisError(null);
    runAnalysis.mutate(undefined, {
      onError: (err) => setAnalysisError(errorMessage(err, "Failed to run analysis.")),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-brand-600" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-900">Dependency Graph</h2>
      </div>

      {scanLoading && <LoadingState label="Loading scan…" />}

      {!scanLoading && !latestScan && (
        <EmptyState
          icon={<GitBranch className="h-8 w-8" />}
          title="No scan yet"
          description="Configure a source directory and run a scan in the Scan tab before a dependency graph can be built."
        />
      )}

      {latestScan && graphLoading && <LoadingState label="Loading dependency graph…" />}

      {latestScan && isMissingAnalysis && (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <GitBranch className="h-8 w-8 text-slate-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-slate-900">No analysis has been run for the latest scan</p>
            <p className="mt-1 max-w-md text-sm text-slate-500">
              Import extraction and resolution need to run once before a graph can be built from this scan's
              inventory.
            </p>
          </div>
          <Button onClick={runAnalysisNow} disabled={runAnalysis.isPending}>
            {runAnalysis.isPending ? "Running Analysis…" : "Run Analysis"}
          </Button>
          {analysisError && (
            <p role="alert" className="text-sm text-red-600">
              {analysisError}
            </p>
          )}
        </Card>
      )}

      {isError && !isMissingAnalysis && (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      )}

      {graph && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Files" value={graph.nodes.length} />
            <StatCard label="Confirmed Dependencies" value={graph.edges.length} />
            <StatCard
              label="Cycles"
              value={graph.cycles.length}
              tone={graph.cycles.length > 0 ? "danger" : undefined}
            />
            <StatCard
              label="Diagnostics"
              value={
                graph.unresolved.length +
                graph.external.length +
                graph.unsupported.length +
                graph.parseErrors.length
              }
              tone="warning"
            />
          </div>

          {graph.validationErrors.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm text-danger-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {graph.validationErrors.length} structural issue
                {graph.validationErrors.length === 1 ? "" : "s"} found while building this graph — it may be
                incomplete. See Diagnostics below for detail.
              </span>
            </div>
          )}

          {graph.nodes.length === 0 ? (
            <EmptyState
              icon={<GitBranch className="h-8 w-8" />}
              title="No analyzable files in this scan"
              description="The scan didn't record any JavaScript, JSX, TypeScript, or TSX files, so there's nothing to graph."
            />
          ) : graph.edges.length === 0 ? (
            <EmptyState
              icon={<GitBranch className="h-8 w-8" />}
              title="No confirmed local dependencies"
              description="Files were analyzed and relationships were found, but none resolved to a confirmed local import — check Diagnostics below for why."
            />
          ) : null}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="flex flex-col gap-4 lg:col-span-2">
              <Card>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">Graph View</h3>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Zoom out"
                      onClick={() => setScale((s) => Math.max(ZOOM_MIN, +(s - ZOOM_STEP).toFixed(2)))}
                    >
                      <ZoomOut className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Zoom in"
                      onClick={() => setScale((s) => Math.min(ZOOM_MAX, +(s + ZOOM_STEP).toFixed(2)))}
                    >
                      <ZoomIn className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" aria-label="Fit to view" onClick={() => setScale(1)}>
                      <Maximize2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Re-run analysis"
                      disabled={runAnalysis.isPending}
                      onClick={runAnalysisNow}
                    >
                      <RefreshCw className={`h-4 w-4 ${runAnalysis.isPending ? "animate-spin" : ""}`} />
                    </Button>
                  </div>
                </div>
                {graph.edges.length > 0 || graph.nodes.length > 0 ? (
                  <DependencyGraphCanvas
                    graph={graph}
                    selection={selection}
                    scale={scale}
                    onSelectNode={(id) => setSelection({ type: "node", id })}
                    onSelectEdge={(id) => setSelection({ type: "edge", id })}
                  />
                ) : null}
                <p className="mt-2 text-xs text-slate-400">
                  Layout follows dependency order (files nothing depends on are placed first) wrapped into a
                  grid for readability — it is not an optimized diagram layout. Arrows point from an importing
                  file to the file it imports.
                </p>
              </Card>

              {graph.cycles.length > 0 && (
                <Card>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <AlertTriangle className="h-4 w-4 text-danger-600" aria-hidden="true" />
                    Cycles ({graph.cycles.length})
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {graph.cycles.map((cycle, i) => (
                      <li
                        key={i}
                        className="rounded-md bg-danger-50 px-2.5 py-1.5 font-mono text-xs text-danger-800"
                      >
                        {cycle.join(" → ")}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">Files ({graph.nodes.length})</h3>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-left text-sm">
                    <tbody>
                      {graph.nodes.map((node) => (
                        <tr
                          key={node.id}
                          onClick={() => setSelection({ type: "node", id: node.id })}
                          className={`cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50 ${
                            selection?.type === "node" && selection.id === node.id ? "bg-brand-50" : ""
                          }`}
                        >
                          <td className="px-2 py-1.5 font-mono text-xs text-slate-700">{node.id}</td>
                          <td className="px-2 py-1.5 text-right text-xs text-slate-400">{node.language}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">
                  Confirmed Dependencies ({graph.edges.length})
                </h3>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-left text-sm">
                    <tbody>
                      {graph.edges.map((edge) => (
                        <tr
                          key={edge.id}
                          onClick={() => setSelection({ type: "edge", id: edge.id })}
                          className={`cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50 ${
                            selection?.type === "edge" && selection.id === edge.id ? "bg-brand-50" : ""
                          }`}
                        >
                          <td className="px-2 py-1.5 font-mono text-xs text-slate-700">
                            {edge.from} <span className="text-slate-400">→</span> {edge.to}
                          </td>
                          <td className="px-2 py-1.5 text-right text-xs text-slate-400">
                            {edge.evidence.length} evidence
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card>
                <h3 className="mb-1 text-sm font-semibold text-slate-900">Diagnostics</h3>
                <p className="mb-2 text-xs text-slate-500">
                  Relationships that were found but did not become a confirmed local dependency.
                </p>
                <DiagnosticSection status="unresolved" items={graph.unresolved} />
                <DiagnosticSection status="external" items={graph.external} />
                <DiagnosticSection status="unsupported" items={graph.unsupported} />
                <DiagnosticSection status="parse_error" items={graph.parseErrors} />
              </Card>
            </div>

            <div className="lg:sticky lg:top-4 lg:self-start">
              <Card>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">Details</h3>
                  {selection && (
                    <button
                      type="button"
                      onClick={() => setSelection(null)}
                      aria-label="Clear selection"
                      className="text-slate-400 hover:text-slate-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {!selection && (
                  <p className="text-sm text-slate-500">Select a file or dependency to inspect it here.</p>
                )}

                {selectedNode && (
                  <div className="flex flex-col gap-3">
                    <p className="break-all font-mono text-xs text-slate-900">{selectedNode.id}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedNode.language && <Badge tone="info">{selectedNode.language}</Badge>}
                      {graph.rootNodes.includes(selectedNode.id) && <Badge tone="neutral">Root</Badge>}
                      {graph.leafNodes.includes(selectedNode.id) && <Badge tone="neutral">Leaf</Badge>}
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Depends on ({dependenciesOfSelected.length})
                      </p>
                      {dependenciesOfSelected.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-400">Nothing — imports no local files.</p>
                      ) : (
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {dependenciesOfSelected.map((id) => (
                            <li key={id} className="truncate font-mono text-xs text-slate-600">
                              {id}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Imported by ({dependentsOfSelected.length})
                      </p>
                      {dependentsOfSelected.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-400">Nothing imports this file.</p>
                      ) : (
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {dependentsOfSelected.map((id) => (
                            <li key={id} className="truncate font-mono text-xs text-slate-600">
                              {id}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}

                {selectedEdge && (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1 font-mono text-xs">
                      <span className="text-slate-900">{selectedEdge.from}</span>
                      <span className="text-slate-400">imports ↓</span>
                      <span className="text-slate-900">{selectedEdge.to}</span>
                    </div>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Evidence ({selectedEdge.evidence.length})
                      </p>
                      <ul className="mt-1 flex flex-col gap-2">
                        {selectedEdge.evidence.map((ev, i) => (
                          <li key={i} className="rounded-md border border-slate-200 p-2 text-xs">
                            <p className="font-mono text-slate-800">{ev.rawImport}</p>
                            <p className="mt-0.5 text-slate-500">
                              {ev.importType ?? "import"}
                              {ev.line !== undefined && ` · line ${ev.line}`}
                              {ev.column !== undefined && `:${ev.column}`}
                            </p>
                            {ev.resolutionMethod && (
                              <p className="text-slate-400">resolved via {ev.resolutionMethod}</p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
