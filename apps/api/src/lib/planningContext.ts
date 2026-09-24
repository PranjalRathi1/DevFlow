import type { DependencyGraphResult, NonConfirmedRelationship } from "./sourceDependencyGraph.js";

/**
 * Batch C5 — deterministic, bounded planning context built from ONE scan
 * and ONE analysis (see docs/DECISIONS.md ADR-019). Pure: no I/O, no AI,
 * no filesystem access. The same inputs always produce the same context
 * and the same prompt text, so a generated plan can be traced back to
 * exactly the evidence the model was shown.
 *
 * Nothing here invents relationships: confirmed edges come only from the
 * canonical graph, and every non-confirmed category stays in its own
 * bucket so the prompt can tell the model they are NOT dependencies.
 */

// 2: compact importer-grouped edge format (ADR-020).
export const PLANNING_CONTEXT_VERSION = 2;

// Caps keep the prompt within a local model's practical context window.
// Truncation is always reported (never silent) — see `truncated`.
// `edges` was raised from 200 when edges moved to the compact grouped
// format (~11 tokens/edge measured, vs ~26.5 before): 400 compact edges
// cost less than the old 200 did. See docs/DECISIONS.md ADR-020.
export const PLANNING_CONTEXT_LIMITS = {
  files: 300,
  edges: 400,
  unresolved: 50,
  externalPackages: 60,
  unsupported: 30,
  parseErrors: 20,
  cycles: 10,
  snippetChars: 120,
} as const;

export interface PlanningInventoryItem {
  relativePath: string;
  type: "file" | "directory";
  status?: string | null | undefined;
  skipReason?: string | null | undefined;
}

export interface ContextEdge {
  from: string;
  to: string;
  /** Total import statements behind this edge. */
  statements: number;
  /**
   * Sorted, distinct source lines of those statements in `from` — the
   * prompt's citation. The raw specifier is not repeated in the prompt
   * (it mostly restates `to`); it stays in the stored analysis evidence.
   */
  lines: number[];
}

export interface ContextRelationship {
  importerRelativePath: string;
  rawImport: string;
  line?: number | undefined;
  reason?: string | undefined;
}

export interface ContextExternalPackage {
  name: string;
  importerCount: number;
}

export interface PlanningContextCounts {
  files: number;
  graphNodes: number;
  confirmedEdges: number;
  unresolved: number;
  external: number;
  /** Distinct external package names (`external` counts import statements). */
  externalPackages: number;
  unsupported: number;
  parseErrors: number;
  cycles: number;
}

export interface PlanningContext {
  version: number;
  scanId: string;
  analysisId: string;
  counts: PlanningContextCounts;
  truncated: boolean;
  files: string[];
  edges: ContextEdge[];
  unresolved: ContextRelationship[];
  externalPackages: ContextExternalPackage[];
  unsupported: ContextRelationship[];
  parseErrors: ContextRelationship[];
  cycles: string[][];
  isAcyclic: boolean;
}

/** Collapses whitespace and caps length — raw import text can be a multi-line source snippet. */
function oneLine(value: string, max: number = PLANNING_CONTEXT_LIMITS.snippetChars): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * `react-dom/client` -> `react-dom`, `@scope/pkg/sub` -> `@scope/pkg`,
 * `node:fs` -> `node:fs`. Pure string handling of the recorded specifier,
 * never a lookup in node_modules.
 */
export function externalPackageName(rawImport: string): string {
  const parts = rawImport.split("/");
  if (rawImport.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? rawImport;
}

/**
 * Paths the scan actually observed. Symlink entries are excluded: the
 * scanner records them as a "file" placeholder without ever resolving the
 * target, so they are not evidence that a file exists.
 */
export function observedInventoryPaths(items: readonly PlanningInventoryItem[]): Set<string> {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.skipReason === "symlink") continue;
    paths.add(item.relativePath);
  }
  return paths;
}

function toContextRelationship(r: NonConfirmedRelationship): ContextRelationship {
  return {
    importerRelativePath: r.importerRelativePath,
    rawImport: oneLine(r.rawImport),
    line: r.line,
    reason: r.reason ? oneLine(r.reason) : undefined,
  };
}

function byLocation(a: ContextRelationship, b: ContextRelationship): number {
  return (
    a.importerRelativePath.localeCompare(b.importerRelativePath) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.rawImport.localeCompare(b.rawImport)
  );
}

export function buildPlanningContext(input: {
  scanId: string;
  analysisId: string;
  items: readonly PlanningInventoryItem[];
  graph: DependencyGraphResult;
}): PlanningContext {
  const L = PLANNING_CONTEXT_LIMITS;
  const { graph } = input;

  const allFiles = input.items
    .filter((i) => i.type === "file" && i.skipReason !== "symlink")
    .map((i) => i.relativePath)
    .sort((a, b) => a.localeCompare(b));

  // Lines are sorted, so the result doesn't depend on relationship input
  // order (the graph keeps evidence in input order).
  const allEdges: ContextEdge[] = graph.edges.map((e) => ({
    from: e.from,
    to: e.to,
    statements: e.evidence.length,
    lines: [...new Set(e.evidence.flatMap((ev) => (ev.line !== undefined ? [ev.line] : [])))].sort(
      (a, b) => a - b,
    ),
  }));

  const packageImporters = new Map<string, Set<string>>();
  for (const r of graph.external) {
    const name = externalPackageName(r.rawImport);
    const importers = packageImporters.get(name) ?? new Set<string>();
    importers.add(r.importerRelativePath);
    packageImporters.set(name, importers);
  }
  const allPackages = [...packageImporters.entries()]
    .map(([name, importers]) => ({ name, importerCount: importers.size }))
    .sort((a, b) => b.importerCount - a.importerCount || a.name.localeCompare(b.name));

  const unresolved = graph.unresolved.map(toContextRelationship).sort(byLocation);
  const unsupported = graph.unsupported.map(toContextRelationship).sort(byLocation);
  const parseErrors = graph.parseErrors.map(toContextRelationship).sort(byLocation);

  const truncated =
    allFiles.length > L.files ||
    allEdges.length > L.edges ||
    unresolved.length > L.unresolved ||
    allPackages.length > L.externalPackages ||
    unsupported.length > L.unsupported ||
    parseErrors.length > L.parseErrors ||
    graph.cycles.length > L.cycles;

  return {
    version: PLANNING_CONTEXT_VERSION,
    scanId: input.scanId,
    analysisId: input.analysisId,
    counts: {
      files: allFiles.length,
      graphNodes: graph.nodes.length,
      confirmedEdges: allEdges.length,
      unresolved: unresolved.length,
      external: graph.external.length,
      externalPackages: allPackages.length,
      unsupported: unsupported.length,
      parseErrors: parseErrors.length,
      cycles: graph.cycles.length,
    },
    truncated,
    files: allFiles.slice(0, L.files),
    edges: allEdges.slice(0, L.edges),
    unresolved: unresolved.slice(0, L.unresolved),
    externalPackages: allPackages.slice(0, L.externalPackages),
    unsupported: unsupported.slice(0, L.unsupported),
    parseErrors: parseErrors.slice(0, L.parseErrors),
    cycles: graph.cycles.slice(0, L.cycles),
    isAcyclic: graph.isAcyclic,
  };
}

function shownOf(shown: number, total: number): string {
  return shown === total ? `${total}` : `${shown} of ${total} shown`;
}

function locationSuffix(r: ContextRelationship): string {
  return `${r.line !== undefined ? ` (line ${r.line})` : ""}${r.reason ? ` — ${r.reason}` : ""}`;
}

/**
 * One line per importer instead of one per edge: the importer path was
 * repeated on every edge line and edges were ~76% of the prompt (measured
 * with the model's tokenizer — see docs/DECISIONS.md ADR-020). Every edge
 * and every cited line is still listed; `edges` is already sorted by
 * (from, to), so grouping preserves the order.
 */
function renderEdgesByImporter(edges: readonly ContextEdge[]): string[] {
  const lines: string[] = [];
  let current: string | undefined;
  let targets: string[] = [];
  const flush = () => {
    if (current !== undefined) lines.push(`- ${current} -> ${targets.join(", ")}`);
  };
  for (const e of edges) {
    if (e.from !== current) {
      flush();
      current = e.from;
      targets = [];
    }
    targets.push(e.lines.length ? `${e.to}:${e.lines.join(",")}` : e.to);
  }
  flush();
  return lines;
}

/** Deterministic prompt section. Every list states whether it was truncated. */
export function renderPlanningContext(ctx: PlanningContext): string {
  const lines: string[] = [];
  lines.push(
    `VERIFIED PROJECT CONTEXT (read-only scan ${ctx.scanId}, dependency analysis ${ctx.analysisId}).`,
    "This is the ONLY evidence you have about the codebase. Do not assume any file, dependency, or package that is not listed here.",
    "",
    `Files in the scan inventory (${shownOf(ctx.files.length, ctx.counts.files)}):`,
    ...(ctx.files.length ? ctx.files.map((f) => `- ${f}`) : ["- (none)"]),
    "",
    `Confirmed internal dependencies (${shownOf(ctx.edges.length, ctx.counts.confirmedEdges)}). Each line is "importer -> imported:L", where L is the line of the import statement in the importer:`,
    ...(ctx.edges.length ? renderEdgesByImporter(ctx.edges) : ["- (none)"]),
    "",
    `Unresolved imports — NOT confirmed dependencies (${shownOf(ctx.unresolved.length, ctx.counts.unresolved)}):`,
    ...(ctx.unresolved.length
      ? ctx.unresolved.map((r) => `- ${r.importerRelativePath}: "${r.rawImport}"${locationSuffix(r)}`)
      : ["- (none)"]),
    "",
    `External packages, by number of importing files (${shownOf(ctx.externalPackages.length, ctx.counts.externalPackages)}):`,
    ...(ctx.externalPackages.length
      ? ctx.externalPackages.map(
          (p) => `- ${p.name} (${p.importerCount} file${p.importerCount === 1 ? "" : "s"})`,
        )
      : ["- (none)"]),
    "",
    `Unsupported import syntax — not analyzed (${shownOf(ctx.unsupported.length, ctx.counts.unsupported)}):`,
    ...(ctx.unsupported.length
      ? ctx.unsupported.map((r) => `- ${r.importerRelativePath}: "${r.rawImport}"${locationSuffix(r)}`)
      : ["- (none)"]),
    "",
    `Files that could not be parsed (${shownOf(ctx.parseErrors.length, ctx.counts.parseErrors)}):`,
    ...(ctx.parseErrors.length
      ? ctx.parseErrors.map((r) => `- ${r.importerRelativePath}${r.reason ? ` — ${r.reason}` : ""}`)
      : ["- (none)"]),
    "",
    ctx.isAcyclic
      ? "Import cycles: none found among the confirmed dependencies."
      : `Import cycles among confirmed dependencies (${shownOf(ctx.cycles.length, ctx.counts.cycles)}):`,
    ...(ctx.isAcyclic ? [] : ctx.cycles.map((c) => `- ${c.join(" -> ")}`)),
  );
  if (ctx.truncated) {
    lines.push("", "Some lists above were truncated to keep this context bounded; the totals are exact.");
  }
  return lines.join("\n");
}

export type AffectedFileEvidence = "in_scan" | "not_in_scan" | "unverified";

export interface ClassifiedAffectedFile {
  path: string;
  reason: string;
  evidence: AffectedFileEvidence;
  dependentsCount?: number | undefined;
  dependenciesCount?: number | undefined;
}

export interface AffectedFileEvidenceSource {
  inventory: ReadonlySet<string>;
  graph: Pick<DependencyGraphResult, "nodes" | "edges">;
}

/**
 * Classifies AI-proposed paths against the recorded scan — the AI never
 * decides whether a file exists. `null` source (plan not grounded in a
 * scan) means every path is "unverified", never "in_scan". Duplicate
 * paths keep their first occurrence.
 */
export function classifyAffectedFiles(
  files: readonly { path: string; reason?: string | undefined }[],
  source: AffectedFileEvidenceSource | null,
): ClassifiedAffectedFile[] {
  const seen = new Set<string>();
  const result: ClassifiedAffectedFile[] = [];
  const nodeIds = source ? new Set(source.graph.nodes.map((n) => n.id)) : null;

  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const reason = file.reason ?? "";

    if (!source) {
      result.push({ path: file.path, reason, evidence: "unverified" });
      continue;
    }
    if (!source.inventory.has(file.path)) {
      result.push({ path: file.path, reason, evidence: "not_in_scan" });
      continue;
    }
    const isNode = nodeIds?.has(file.path) ?? false;
    result.push({
      path: file.path,
      reason,
      evidence: "in_scan",
      dependentsCount: isNode ? source.graph.edges.filter((e) => e.to === file.path).length : undefined,
      dependenciesCount: isNode ? source.graph.edges.filter((e) => e.from === file.path).length : undefined,
    });
  }
  return result;
}
