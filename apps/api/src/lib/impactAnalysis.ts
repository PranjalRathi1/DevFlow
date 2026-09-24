import {
  getTransitiveDependents,
  type DependencyGraphResult,
  type GraphEdgeEvidence,
  type NonConfirmedRelationship,
} from "./sourceDependencyGraph.js";

/**
 * Deterministic, read-only change-impact analysis over the CANONICAL
 * dependency graph (lib/sourceDependencyGraph.ts) — no second graph, no
 * filesystem access, no AI. See docs/DECISIONS.md ADR-022.
 *
 * DIRECTION. Graph edges are importer -> imported. For a selected file F:
 *   - "dependencies" = files F imports (outgoing edges). A change to F does
 *     NOT imply they are affected.
 *   - "dependents"   = files that import F, directly or through a chain of
 *     confirmed imports (incoming edges, walked in reverse). A change to F
 *     MAY affect them.
 * Only confirmed edges ever appear in either list. An import edge shows
 * that a file references another at build time; it does not prove that a
 * given symbol is used or how code runs.
 */

export const IMPACT_LIMITS = {
  defaultMaxDepth: 10,
  maxMaxDepth: 25,
  defaultMaxNodes: 200,
  maxMaxNodes: 1000,
  // Stage 7: cycles containing the file were returned uncapped (1,611
  // cycles of up to ~1,400 files each on a synthetic 2,000-file graph).
  cycles: 10,
  cycleFiles: 50,
} as const;

export interface ImpactCycle {
  /** The cycle's files in order (start repeated at the end), cut to `IMPACT_LIMITS.cycleFiles` when long. */
  files: string[];
  /** Distinct files in the whole cycle. */
  length: number;
  truncated: boolean;
}

export const IMPACT_LIMITATIONS = [
  "Based on static import statements only: an edge shows that one file imports another, not that an imported symbol is used or when it runs.",
  "Runtime wiring (route registration, middleware order, dependency injection, dynamic or configuration-driven loading) is not analysed.",
  "Imports that could not be resolved, are unsupported, or sit in files that failed to parse cannot be traced, so real dependents may be missing — see `untraceable`.",
];

export interface ImpactEdgeEvidence {
  rawImport: string;
  importType?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  resolutionMethod?: string | undefined;
  /** Erased at runtime: a compile-time (type) dependency only. */
  typeOnly?: boolean | undefined;
}

export interface ImpactNeighbor {
  file: string;
  /** Evidence of the confirmed edge between this file and the selected one, in source order. */
  evidence: ImpactEdgeEvidence[];
}

export interface TransitiveImpact {
  file: string;
  /** Import hops to the selected file (always >= 2 here; depth 1 is `directDependents`). */
  depth: number;
  /** The file this dependent imports on its shortest path toward the selected file. */
  via: string;
  /** Evidence of the confirmed edge `file -> via`. */
  evidence: ImpactEdgeEvidence[];
}

export interface ImpactResult {
  file: string;
  /** False for scanned files outside the analysed languages (e.g. .css, .md): no import data exists for them. */
  inGraph: boolean;
  directDependencies: ImpactNeighbor[];
  directDependents: ImpactNeighbor[];
  transitiveDependents: TransitiveImpact[];
  /** Exact counts before any cap — compare with the list lengths. */
  totals: { directDependencies: number; directDependents: number };
  /** True when `maxNodes` capped a direct list, or `maxDepth`/`maxNodes` cut the dependent traversal short. */
  truncated: boolean;
  bounds: { maxDepth: number; maxNodes: number };
  /** Present when the file imports itself; never listed as its own dependent/dependency. */
  selfImport: ImpactEdgeEvidence[] | null;
  /** Proven import cycles (from the canonical graph) that include this file — bounded. */
  cycles: ImpactCycle[];
  /** Exact number of proven cycles that include this file. */
  cyclesTotal: number;
  /** The selected file's OWN imports that are not confirmed edges — never counted as impact. */
  nonConfirmedImports: {
    /** Each list is capped at `bounds.maxNodes`; see `totals` for exact counts. */
    unresolved: NonConfirmedRelationship[];
    external: NonConfirmedRelationship[];
    unsupported: NonConfirmedRelationship[];
    parseError: boolean;
    totals: { unresolved: number; external: number; unsupported: number };
  };
  /** Whole-scan counts of relationships that could hide additional dependents. */
  untraceable: { unresolved: number; unsupported: number; parseErrors: number };
  limitations: string[];
}

function toEvidence(ev: readonly GraphEdgeEvidence[]): ImpactEdgeEvidence[] {
  return ev
    .map((e) => ({
      rawImport: e.rawImport,
      importType: e.importType,
      line: e.line,
      column: e.column,
      resolutionMethod: e.resolutionMethod,
      ...(e.typeOnly ? { typeOnly: true } : {}),
    }))
    .sort(
      (a, b) =>
        (a.line ?? Infinity) - (b.line ?? Infinity) ||
        (a.column ?? Infinity) - (b.column ?? Infinity) ||
        a.rawImport.localeCompare(b.rawImport),
    );
}

const byFile = (a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file);
const ofFile = (file: string) => (r: NonConfirmedRelationship) => r.importerRelativePath === file;

export function computeImpact(
  graph: DependencyGraphResult,
  file: string,
  bounds: { maxDepth: number; maxNodes: number },
): ImpactResult {
  const edgeEvidence = new Map(graph.edges.map((e) => [`${e.from}::${e.to}`, e.evidence]));
  const inGraph = graph.nodes.some((n) => n.id === file);
  const selfEvidence = edgeEvidence.get(`${file}::${file}`);

  const allDirectDependencies = graph.edges
    .filter((e) => e.from === file && e.to !== file)
    .map((e) => ({ file: e.to, evidence: toEvidence(e.evidence) }))
    .sort(byFile);
  const allDirectDependents = graph.edges
    .filter((e) => e.to === file && e.from !== file)
    .map((e) => ({ file: e.from, evidence: toEvidence(e.evidence) }))
    .sort(byFile);

  // A hub file can have thousands of direct importers; the response stays bounded.
  const directDependencies = allDirectDependencies.slice(0, bounds.maxNodes);
  const directDependents = allDirectDependents.slice(0, bounds.maxNodes);

  const reach = getTransitiveDependents(graph, file, bounds);
  // Already ordered by (depth, file) by getTransitiveDependents.
  const transitiveDependents = reach.dependents
    .filter((d) => d.depth >= 2)
    .map((d) => ({
      file: d.id,
      depth: d.depth,
      via: d.via,
      evidence: toEvidence(edgeEvidence.get(`${d.id}::${d.via}`) ?? []),
    }));

  const allCycles = graph.cycles.filter((c) => c.includes(file));
  const ownUnresolved = graph.unresolved.filter(ofFile(file));
  const ownExternal = graph.external.filter(ofFile(file));
  const ownUnsupported = graph.unsupported.filter(ofFile(file));
  const cycles: ImpactCycle[] = allCycles.slice(0, IMPACT_LIMITS.cycles).map((c) => {
    const length = c.length - 1;
    const cut = length > IMPACT_LIMITS.cycleFiles;
    return { files: cut ? c.slice(0, IMPACT_LIMITS.cycleFiles) : c, length, truncated: cut };
  });

  return {
    file,
    inGraph,
    directDependencies,
    directDependents,
    transitiveDependents,
    totals: {
      directDependencies: allDirectDependencies.length,
      directDependents: allDirectDependents.length,
    },
    truncated:
      reach.truncated ||
      allCycles.length > cycles.length ||
      cycles.some((c) => c.truncated) ||
      directDependencies.length < allDirectDependencies.length ||
      directDependents.length < allDirectDependents.length,
    bounds,
    selfImport: selfEvidence ? toEvidence(selfEvidence) : null,
    cycles,
    cyclesTotal: allCycles.length,
    nonConfirmedImports: {
      // Review S7-1: a file with thousands of imports made these unbounded.
      unresolved: ownUnresolved.slice(0, bounds.maxNodes),
      external: ownExternal.slice(0, bounds.maxNodes),
      unsupported: ownUnsupported.slice(0, bounds.maxNodes),
      parseError: graph.parseErrors.some(ofFile(file)),
      totals: {
        unresolved: ownUnresolved.length,
        external: ownExternal.length,
        unsupported: ownUnsupported.length,
      },
    },
    untraceable: {
      unresolved: graph.unresolved.length,
      unsupported: graph.unsupported.length,
      parseErrors: graph.parseErrors.length,
    },
    limitations: IMPACT_LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Stage 4 (ADR-023): impact as PLANNING CONTEXT. Tighter bounds than the
// API because it shares the prompt budget (ADR-020).
// Depth 6 matches the focus section (service -> controller -> route ->
// route index -> app -> test): at 4, app-level integration tests were
// missed on DevFlow itself. The node cap keeps the section bounded.
export const IMPACT_PLANNING_BOUNDS = { maxDepth: 6, maxNodes: 30 } as const;

// "dependency_and_dependent": the file both imports the target and is
// imported by it (a cycle) — neither role may hide the other.
export const IMPACT_RELATIONS = [
  "target",
  "dependency",
  "direct_dependent",
  "transitive_dependent",
  "dependency_and_dependent",
] as const;
export type ImpactRelation = (typeof IMPACT_RELATIONS)[number];

/**
 * A file's VERIFIED relation to the impact target, read off a computed
 * impact. `undefined` means "not found within the computed (bounded)
 * impact" — NOT "unrelated": a truncated impact can't prove absence.
 */
export function impactRelationOf(impact: ImpactResult, path: string): ImpactRelation | undefined {
  if (path === impact.file) return "target";
  const isDependency = impact.directDependencies.some((d) => d.file === path);
  const isDirect = impact.directDependents.some((d) => d.file === path);
  const isTransitive = impact.transitiveDependents.some((d) => d.file === path);
  if (isDependency && (isDirect || isTransitive)) return "dependency_and_dependent";
  if (isDependency) return "dependency";
  if (isDirect) return "direct_dependent";
  if (isTransitive) return "transitive_dependent";
  return undefined;
}

const cite = (n: ImpactNeighbor) => {
  const lines = n.evidence.flatMap((e) => (e.line !== undefined ? [e.line] : []));
  // Every statement type-only => no runtime import between the two files.
  const typeOnly = n.evidence.length > 0 && n.evidence.every((e) => e.typeOnly) ? " (type-only)" : "";
  return `${lines.length ? `${n.file}:${lines.join(",")}` : n.file}${typeOnly}`;
};

/**
 * Deterministic prompt section. Wording is deliberate: dependents are
 * "may be affected", never "must change"; dependencies are stated as NOT
 * implied to be affected; every list says when it was cut.
 */
export function renderImpactForPrompt(
  impact: ImpactResult,
  categoryOf: (file: string) => string | undefined,
): string {
  const lines = [
    `CHANGE IMPACT for ${impact.file} (deterministic, from confirmed imports only; edges point importer -> imported).`,
  ];
  if (!impact.inGraph) {
    lines.push("- This file is not in an analysed language, so no import relationships are known for it.");
    return lines.join("\n");
  }
  const shown = (n: number, total: number) => (n === total ? `${total}` : `${n} of ${total} shown`);
  lines.push(
    `- It imports (dependencies; changing it does NOT imply these are affected) (${shown(impact.directDependencies.length, impact.totals.directDependencies)}): ${impact.directDependencies.map(cite).join(", ") || "none"}`,
    `- Imported directly by (MAY be affected) (${shown(impact.directDependents.length, impact.totals.directDependents)}): ${impact.directDependents.map(cite).join(", ") || "none"}`,
    `- Reaches it through 2-${impact.bounds.maxDepth} import hops (MAY be affected): ${
      impact.transitiveDependents.map((t) => `${t.file} (${t.depth} hops, via ${t.via})`).join(", ") || "none"
    }`,
  );
  const tests = [...impact.directDependents, ...impact.transitiveDependents]
    .map((d) => d.file)
    .filter((f) => categoryOf(f) === "test");
  lines.push(
    `- Test files among those dependents: ${
      tests.join(", ") ||
      (impact.truncated
        ? `none within the listed files (the search was bounded, so tests may exist further out)`
        : "none found")
    }`,
  );
  const own = impact.nonConfirmedImports;
  lines.push(
    `- Its own imports that are NOT confirmed (never counted as impact): ${own.totals.unresolved} unresolved, ${own.totals.external} external, ${own.totals.unsupported} unsupported${own.parseError ? "; the file itself failed to parse" : ""}.`,
  );
  if (impact.cyclesTotal) lines.push(`- It is part of ${impact.cyclesTotal} proven import cycle(s).`);
  if (impact.truncated) {
    lines.push(
      `- This impact is TRUNCATED (at most ${impact.bounds.maxDepth} hops / ${impact.bounds.maxNodes} files): more files may be affected than listed.`,
    );
  }
  lines.push(
    '- "May be affected" does not mean "must change". Import edges do not show that a symbol is used or how code runs.',
  );
  return lines.join("\n");
}
