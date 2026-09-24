import {
  validateGraph as validateCoreGraph,
  topologicalSort as coreTopologicalSort,
  getDependencies as coreGetDependencies,
  getDependents as coreGetDependents,
  getReadyTasks as coreGetReady,
  getBlockedTasks as coreGetBlocked,
  type DependencyGraph as CoreGraph,
} from "./dependencyGraph.js";
import { isSupportedExtractionLanguage } from "./importExtraction.js";
import type { ImportType, RelationshipStatus } from "../models/Analysis.js";

/**
 * The canonical, evidence-backed source-file dependency graph — built
 * purely from a scan's own recorded inventory and a Batch C2 analysis's
 * extracted relationships. No filesystem access, no code execution, no
 * network calls; nothing here can write, delete, rename, or run anything.
 *
 * Reuses `lib/dependencyGraph.ts`'s already-tested, fully generic
 * (string-id) cycle detection / topological sort / dependency-lookup
 * algorithms rather than reimplementing them — that module doesn't care
 * whether a node id is a temp task id or a file path.
 *
 * EDGE DIRECTION (documented once, applies everywhere in this file):
 * an edge `{from: A, to: B}` means "A imports B" — equivalently "A
 * depends on B". This is the exact same convention `dependencyGraph.ts`
 * already uses for tasks ("A depends on B; B must complete before A is
 * ready"), so its `getDependencies`/`getDependents` map directly:
 * `getDirectDependencies(g, "src/App.tsx")` = files App.tsx imports;
 * `getDirectDependents(g, "src/Header.tsx")` = files that import
 * Header.tsx. An "incoming" edge to a node is something that imports it;
 * an "outgoing" edge from a node is something it imports.
 */

export interface GraphInventoryFile {
  relativePath: string;
  language?: string | null | undefined;
  category?: string | null | undefined;
}

export interface GraphRelationshipInput {
  importerRelativePath: string;
  rawImport: string;
  isLiteral: boolean;
  importType?: ImportType | undefined;
  line?: number | undefined;
  column?: number | undefined;
  typeOnly?: boolean | undefined;
  status: RelationshipStatus;
  resolvedRelativePath?: string | undefined;
  resolutionMethod?: string | undefined;
  reason?: string | undefined;
}

/** A node's identity IS its scan-relative path — stable, scan-scoped, never derived from array position, never an absolute filesystem path. */
export interface GraphNode {
  id: string;
  language?: string | undefined;
  category?: string | undefined;
}

export interface GraphEdgeEvidence {
  rawImport: string;
  isLiteral: boolean;
  importType?: ImportType | undefined;
  line?: number | undefined;
  column?: number | undefined;
  resolutionMethod?: string | undefined;
  /** Stage 5: the statement is erased at runtime (compile-time dependency only). */
  typeOnly?: boolean | undefined;
}

export interface GraphEdge {
  /** Deterministic, derived from `from`/`to` — never a random id, never array-index-based. */
  id: string;
  /** The importer — see the module-level direction note. */
  from: string;
  /** The imported/target module. */
  to: string;
  /**
   * One entry per underlying relationship that resolved to this exact
   * (from, to) pair. A single edge, not one-per-import-statement — see
   * "Duplicate handling" in docs/DECISIONS.md's Batch C3 ADR for why:
   * two import statements between the same two files are the same
   * structural dependency, but both pieces of evidence are kept, never
   * one discarded.
   */
  evidence: GraphEdgeEvidence[];
}

/** Everything that is NOT a confirmed local edge, with full evidence preserved — never silently dropped. */
export interface NonConfirmedRelationship {
  importerRelativePath: string;
  rawImport: string;
  isLiteral: boolean;
  importType?: ImportType | undefined;
  line?: number | undefined;
  column?: number | undefined;
  status: Exclude<RelationshipStatus, "confirmed">;
  reason?: string | undefined;
}

export type GraphValidationError =
  | { type: "importer_not_in_inventory"; importerRelativePath: string }
  | { type: "target_not_in_inventory"; importerRelativePath: string; resolvedRelativePath: string }
  | { type: "self_reference"; nodeId: string }
  | { type: "cycle"; cycle: string[] };

export interface DependencyGraphResult {
  /** Sorted by id. */
  nodes: GraphNode[];
  /** Sorted by (from, to). Confirmed edges only. */
  edges: GraphEdge[];
  unresolved: NonConfirmedRelationship[];
  external: NonConfirmedRelationship[];
  unsupported: NonConfirmedRelationship[];
  parseErrors: NonConfirmedRelationship[];
  /** Every structural problem found — a confirmed relationship whose importer/target isn't a real node is reported here, never silently turned into a phantom node. */
  validationErrors: GraphValidationError[];
  /** Every cycle found, each as an ordered id list with the start node repeated at the end. Deterministic regardless of relationship/inventory input order. */
  cycles: string[][];
  isAcyclic: boolean;
}

function toCoreGraph(result: Pick<DependencyGraphResult, "nodes" | "edges">): CoreGraph {
  return {
    nodes: result.nodes.map((n) => n.id),
    edges: result.edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

function edgeId(from: string, to: string): string {
  return `${from}::${to}`;
}

// Scan-relative paths are always forward-slash per Batch C1/C2 convention,
// but this normalizes defensively so a caller-supplied backslash never
// causes two representations of the same file to be treated as different
// nodes — path separators must be deterministic regardless of origin.
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function toNonConfirmed(r: GraphRelationshipInput): NonConfirmedRelationship {
  return {
    importerRelativePath: normalizePath(r.importerRelativePath),
    rawImport: r.rawImport,
    isLiteral: r.isLiteral,
    importType: r.importType,
    line: r.line,
    column: r.column,
    status: r.status as Exclude<RelationshipStatus, "confirmed">,
    reason: r.reason,
  };
}

function sortValidationErrors(errors: GraphValidationError[]): GraphValidationError[] {
  return [...errors].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * Builds the canonical graph. Pure — no I/O, no exceptions for bad input
 * (bad relationships become validation errors, not thrown errors), fully
 * deterministic regardless of the order `inventoryFiles`/`relationships`
 * are given in.
 */
export function buildDependencyGraph(
  inventoryFiles: readonly GraphInventoryFile[],
  relationships: readonly GraphRelationshipInput[],
): DependencyGraphResult {
  // First occurrence wins for duplicate inventory entries — deterministic,
  // documented, never a crash on malformed caller input.
  const nodeById = new Map<string, GraphNode>();
  for (const file of inventoryFiles) {
    if (!isSupportedExtractionLanguage(file.language)) continue;
    const id = normalizePath(file.relativePath);
    if (nodeById.has(id)) continue;
    nodeById.set(id, {
      id,
      language: file.language ?? undefined,
      category: file.category ?? undefined,
    });
  }

  const unresolved: NonConfirmedRelationship[] = [];
  const external: NonConfirmedRelationship[] = [];
  const unsupported: NonConfirmedRelationship[] = [];
  const parseErrors: NonConfirmedRelationship[] = [];
  const validationErrors: GraphValidationError[] = [];

  // Keyed by "from::to" so N relationships resolving to the same pair
  // merge into one edge without losing any evidence.
  const edgesByKey = new Map<string, GraphEdge>();

  for (const rel of relationships) {
    if (rel.status !== "confirmed") {
      const bucket =
        rel.status === "unresolved"
          ? unresolved
          : rel.status === "external"
            ? external
            : rel.status === "unsupported"
              ? unsupported
              : parseErrors;
      bucket.push(toNonConfirmed(rel));
      continue;
    }

    const importer = normalizePath(rel.importerRelativePath);
    const target = rel.resolvedRelativePath ? normalizePath(rel.resolvedRelativePath) : undefined;

    // A "confirmed" status is never trusted blindly — independently
    // re-validated against THIS inventory, so relationships accidentally
    // sourced from a different scan can never contaminate this graph.
    if (!nodeById.has(importer)) {
      validationErrors.push({ type: "importer_not_in_inventory", importerRelativePath: importer });
      continue;
    }
    if (!target || !nodeById.has(target)) {
      validationErrors.push({
        type: "target_not_in_inventory",
        importerRelativePath: importer,
        resolvedRelativePath: target ?? "",
      });
      continue;
    }

    const from = importer;
    const to = target;
    const key = edgeId(from, to);
    const evidenceEntry: GraphEdgeEvidence = {
      rawImport: rel.rawImport,
      isLiteral: rel.isLiteral,
      importType: rel.importType,
      line: rel.line,
      column: rel.column,
      resolutionMethod: rel.resolutionMethod,
      ...(rel.typeOnly ? { typeOnly: true } : {}),
    };
    const existing = edgesByKey.get(key);
    if (existing) {
      existing.evidence.push(evidenceEntry);
    } else {
      edgesByKey.set(key, { id: key, from, to, evidence: [evidenceEntry] });
      if (from === to) {
        validationErrors.push({ type: "self_reference", nodeId: from });
      }
    }
  }

  const nodes = [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgesByKey.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  const coreValidation = validateCoreGraph(toCoreGraph({ nodes, edges }));
  const cycles = coreValidation.errors
    .filter((e): e is Extract<typeof e, { type: "cycle" }> => e.type === "cycle")
    .map((e) => e.cycle)
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));

  for (const cycle of cycles) {
    validationErrors.push({ type: "cycle", cycle });
  }

  return {
    nodes,
    edges,
    unresolved,
    external,
    unsupported,
    parseErrors,
    validationErrors: sortValidationErrors(validationErrors),
    cycles,
    isAcyclic: cycles.length === 0,
  };
}

/**
 * Dependency-first order: a node appears only after every node it
 * imports (its dependencies) already appears — i.e. leaves first,
 * entry points last. `null` if the graph has a cycle (check
 * `result.isAcyclic` first for a detailed reason via `result.cycles`).
 */
export function topologicalOrder(result: DependencyGraphResult): string[] | null {
  return coreTopologicalSort(toCoreGraph(result));
}

/** Files `nodeId` imports (outgoing edges), sorted. */
export function getDirectDependencies(result: DependencyGraphResult, nodeId: string): string[] {
  return coreGetDependencies(toCoreGraph(result), nodeId);
}

/** Files that import `nodeId` (incoming edges), sorted. */
export function getDirectDependents(result: DependencyGraphResult, nodeId: string): string[] {
  return coreGetDependents(toCoreGraph(result), nodeId);
}

export interface TransitiveDependent {
  id: string;
  /** Import hops from the start node: 1 = imports it directly. */
  depth: number;
  /** The file this dependent imports on its shortest path back to the start node. */
  via: string;
}

/**
 * Files that import `nodeId` directly or through a chain of CONFIRMED
 * edges (breadth-first over incoming edges), i.e. what could be affected
 * by a change to it. Bounded by `maxDepth` hops and `maxNodes` results.
 * `truncated` is set when either bound cut anything off, so a caller can
 * never mistake a bounded answer for a complete one. Cycle-safe (each file
 * is visited once; the start node is never its own dependent) and
 * deterministic (level by level, ids sorted within a level; the first
 * `via` in that order wins). Unresolved/external/unsupported imports are
 * never edges here, so they never contribute.
 */
export function getTransitiveDependents(
  result: Pick<DependencyGraphResult, "edges">,
  nodeId: string,
  bounds: { maxDepth: number; maxNodes: number },
): { dependents: TransitiveDependent[]; truncated: boolean } {
  const importersOf = new Map<string, string[]>();
  for (const e of result.edges) {
    const list = importersOf.get(e.to) ?? [];
    list.push(e.from);
    importersOf.set(e.to, list);
  }

  const visited = new Set<string>([nodeId]);
  const dependents: TransitiveDependent[] = [];
  let frontier = [nodeId];
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next = new Map<string, string>();
    for (const current of [...frontier].sort((a, b) => a.localeCompare(b))) {
      for (const importer of importersOf.get(current) ?? []) {
        if (!visited.has(importer) && !next.has(importer)) next.set(importer, current);
      }
    }
    if (next.size === 0) break;
    if (depth > bounds.maxDepth) return { dependents, truncated: true };
    for (const id of [...next.keys()].sort((a, b) => a.localeCompare(b))) {
      if (dependents.length >= bounds.maxNodes) return { dependents, truncated: true };
      visited.add(id);
      dependents.push({ id, depth, via: next.get(id) as string });
    }
    frontier = [...next.keys()];
  }
  return { dependents, truncated: false };
}

/** Nodes nothing else imports — typical entry points. Sorted. */
export function getRootNodes(result: DependencyGraphResult): string[] {
  return result.nodes.map((n) => n.id).filter((id) => getDirectDependents(result, id).length === 0);
}

/** Nodes that import nothing locally — leaf dependencies. Sorted. */
export function getLeafNodes(result: DependencyGraphResult): string[] {
  return result.nodes.map((n) => n.id).filter((id) => getDirectDependencies(result, id).length === 0);
}

/**
 * Purely structural — `completedNodeIds` is an arbitrary, caller-supplied
 * set with whatever meaning the caller assigns to it (this batch invents
 * no task-execution/build state of its own). A node is "ready" once every
 * node it depends on (imports) is in that set. Unknown ids in
 * `completedNodeIds` that aren't real graph nodes are ignored, not
 * treated as an error — this function never mutates its input.
 */
export function getStructurallyReadyNodes(
  result: DependencyGraphResult,
  completedNodeIds: Iterable<string>,
): string[] {
  return coreGetReady(toCoreGraph(result), completedNodeIds);
}

/** The structural inverse of `getStructurallyReadyNodes` — see its doc comment. */
export function getStructurallyBlockedNodes(
  result: DependencyGraphResult,
  completedNodeIds: Iterable<string>,
): string[] {
  return coreGetBlocked(toCoreGraph(result), completedNodeIds);
}
