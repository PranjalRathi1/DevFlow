import { CLAIM_CHECK_LIMITS, checkClaims, type ClaimCheck, type ClaimSource } from "./claimChecks.js";
import type { ImpactRelation } from "./impactAnalysis.js";
import {
  getTransitiveDependents,
  type DependencyGraphResult,
  type NonConfirmedRelationship,
} from "./sourceDependencyGraph.js";

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
// 3: requirement focus section (ADR-021).
// 4: deterministic budget fitting with a reduction note (ADR-027).
export const PLANNING_CONTEXT_VERSION = 4;

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
  // Stage 7: files shown per cycle. Only the NUMBER of cycles was capped; a
  // synthetic 2,000-file graph produced 10 cycles of ~1,400 files each
  // (404k characters in one section).
  cycleFiles: 12,
  snippetChars: 120,
  // Requirement focus (ADR-021).
  focusFiles: 12,
  focusNeighbors: 8,
  focusTests: 4,
  // 6 covers service -> controller -> route -> route index -> app -> test.
  focusTestDepth: 6,
  focusTraversalNodes: 200,
} as const;

export type PlanningContextLimits = { -readonly [K in keyof typeof PLANNING_CONTEXT_LIMITS]: number };

/** One list the budget fitter shortened: what was kept vs the exact total (ADR-027). */
export interface BudgetReduction {
  section: string;
  shown: number;
  total: number;
}

/** Set only on a context produced by the budget fitter (lib/contextFitting.ts). */
export interface ContextBudget {
  budgetTokens: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** Ids of the reduction steps applied, in order. Empty = the full context fit. */
  steps: string[];
  reductions: BudgetReduction[];
}

/**
 * Deterministic bounded selection. Untouched when the list fits. When it
 * must be cut, items for which `isPriority` holds are kept first, then the
 * rest in their existing (sorted) order; the kept items are returned in
 * that original order, so the output never depends on input order.
 */
function selectBounded<T>(list: readonly T[], cap: number, isPriority?: (item: T) => boolean): T[] {
  if (list.length <= cap) return [...list];
  if (!isPriority) return list.slice(0, cap);
  const indexed = list.map((item, index) => ({ item, index }));
  const chosen = [...indexed.filter((x) => isPriority(x.item)), ...indexed.filter((x) => !isPriority(x.item))]
    .slice(0, cap)
    .sort((a, b) => a.index - b.index);
  return chosen.map((x) => x.item);
}

export interface PlanningInventoryItem {
  relativePath: string;
  type: "file" | "directory";
  status?: string | null | undefined;
  skipReason?: string | null | undefined;
}

export interface FocusNeighbor {
  path: string;
  /** Import statement lines in the importing file (the confirmed edge's evidence). */
  lines: number[];
}

export interface FocusTest {
  path: string;
  /** Confirmed import hops from the test to the focus file (1 = imports it directly). */
  depth: number;
}

export interface FocusFile {
  path: string;
  category?: string | undefined;
  /** Requirement words found in this path. Lexical only — not evidence of relevance. */
  matchedTerms: string[];
  importedBy: FocusNeighbor[];
  importedByTotal: number;
  imports: FocusNeighbor[];
  importsTotal: number;
  tests: FocusTest[];
  testsTotal: number;
  /** True when the bounded traversal stopped early — more tests may reach this file. */
  testsTraversalTruncated: boolean;
}

export interface RequirementFocus {
  terms: string[];
  files: FocusFile[];
  /** How many source files matched before the `focusFiles` cap. */
  candidatesTotal: number;
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
  /** `null` when no requirement text was given (e.g. re-checking an edited plan). */
  focus: RequirementFocus | null;
  /** Stage 5: how much of the tree the scan actually read. */
  coverage: { stoppedEarly: string[]; unreadDirectories: number; ignoredDirectories: number };
  /** Stage 12: present only when the budget fitter produced this context. */
  budget?: ContextBudget | undefined;
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

/** Limits that stop the scanner's walk outright (scanner.service.ts `break`s): nothing after them was seen. */
const WALK_STOPPING_LIMITS = new Set(["maxFiles", "maxDurationMs"]);

const UNREAD_REASON: Record<string, string> = {
  ignored: "an ignored directory (dependencies/build output)",
  limit_reached: "a directory not read because a scan limit was reached",
};

export interface ScanCoverage {
  /** Walk-stopping limits that were hit, sorted; non-empty = anything unobserved may still exist. */
  stoppedEarly: string[];
  /** Path (unread directory, or symlink placeholder) -> why its contents were never observed. */
  unreadPaths: ReadonlyMap<string, string>;
}

/**
 * What the scan could NOT have seen (Stage 5). A path the inventory lacks
 * is only provably absent when the scan actually looked where it would be.
 */
export function scanCoverage(
  items: readonly (PlanningInventoryItem & { status?: string | null | undefined })[],
  limitsReached: readonly string[],
): ScanCoverage {
  const unreadPaths = new Map<string, string>();
  for (const item of items) {
    // A symlink is recorded as a placeholder and never followed: whatever is
    // at or behind it was not observed.
    if (item.skipReason === "symlink") {
      unreadPaths.set(item.relativePath, "a symbolic link the scan does not follow");
      continue;
    }
    if (item.type !== "directory") continue;
    if (item.status === "error") unreadPaths.set(item.relativePath, "a directory that could not be read");
    else if (item.status === "skipped") {
      unreadPaths.set(
        item.relativePath,
        UNREAD_REASON[item.skipReason ?? ""] ?? "a directory the scan skipped",
      );
    }
  }
  return {
    stoppedEarly: limitsReached.filter((l) => WALK_STOPPING_LIMITS.has(l)).sort(),
    unreadPaths,
  };
}

/** The path itself or its nearest ancestor, if the scan never read it. */
function unreadAncestor(coverage: ScanCoverage, path: string): [string, string] | undefined {
  const segments = path.split("/");
  for (let i = segments.length; i >= 1; i -= 1) {
    const dir = segments.slice(0, i).join("/");
    const reason = coverage.unreadPaths.get(dir);
    if (reason) return [dir, reason];
  }
  return undefined;
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

// Function words and generic verbs only — say nothing about WHERE in a
// codebase something lives. Domain nouns (user, project, file) stay.
const FOCUS_STOPWORDS = new Set(
  (
    "the and for with from that this when into their them they than then there these those what which while " +
    "will would should could must can may not all any each every some such only also just more most less very " +
    "add adds added adding implement implementation support make makes use using used reuse reusing existing " +
    "new clear ensure allow allows able how often per single want need needs feature code " +
    "return returns returned expensive operation work way ways time times are was were " +
    "has have had its approach exist exists"
  ).split(" "),
);

/**
 * A tiny deterministic stemmer — just enough that "limiting"/"limits"
 * match "limit" and "routes" matches "route". Not linguistic: words ending
 * in -is/-us/-ss keep their "s" ("analysis", "status", "access").
 */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) {
    const base = w.slice(0, -3);
    // "running" -> "run", but "rolling" -> "roll" (ll kept).
    return /([bdgmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !/(ss|is|us)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lowercases, splits camelCase and punctuation, drops stopwords (before and after stemming), stems. */
export function focusTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !FOCUS_STOPWORDS.has(w))
    .map(stem)
    .filter((w) => w.length >= 3 && !FOCUS_STOPWORDS.has(w));
}

const EXTENSION_TOKENS = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]);
function pathTokens(p: string): Set<string> {
  return new Set(focusTokens(p).filter((w) => !EXTENSION_TOKENS.has(w)));
}

/**
 * Equal, or one is a prefix of the other with the shorter at least 4
 * characters — covers what the crude stemmer misses ("cach"/"cache",
 * "scan"/"scanner", "limit"/"limiter") without language-specific rules.
 */
function termMatches(term: string, token: string): boolean {
  if (term === token) return true;
  const [shorter, longer] = term.length <= token.length ? [term, token] : [token, term];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

// Words every test basename shares; useless for telling tests apart.
const GENERIC_TEST_TOKENS = new Set(["test", "spec", "integration", "unit", "index"]);
function basenameTokens(p: string): Set<string> {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return new Set([...pathTokens(base)].filter((w) => !GENERIC_TEST_TOKENS.has(w)));
}

/**
 * Deterministic requirement focus. Candidate files are chosen LEXICALLY
 * (a requirement word appears in the path; title words weigh double) —
 * the prompt says so explicitly. Everything shown about each candidate
 * (importers, imports, reaching tests) comes from confirmed graph edges
 * only. Test files are never candidates themselves; they appear under the
 * files they reach. Bounded by `PLANNING_CONTEXT_LIMITS.focus*`.
 */
export function buildRequirementFocus(
  requirement: { title: string; description?: string | undefined },
  graph: Pick<DependencyGraphResult, "nodes" | "edges">,
  limits: PlanningContextLimits = PLANNING_CONTEXT_LIMITS,
): RequirementFocus {
  const L = limits;
  const titleTerms = new Set(focusTokens(requirement.title));
  const allTerms = new Set([...titleTerms, ...focusTokens(requirement.description ?? "")]);
  const terms = [...allTerms].sort((a, b) => a.localeCompare(b));
  const categoryOf = new Map(graph.nodes.map((n) => [n.id, n.category]));

  const scored = graph.nodes
    .filter((n) => n.category !== "test")
    .map((n) => {
      const tokens = [...pathTokens(n.id)];
      const matched = terms.filter((term) => tokens.some((token) => termMatches(term, token)));
      const score = matched.reduce((s, term) => s + (titleTerms.has(term) ? 2 : 1), 0);
      return { id: n.id, category: n.category, matched, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const neighbor = (path: string, lines: number[]): FocusNeighbor => ({ path, lines });
  const edgeLines = (e: DependencyGraphResult["edges"][number]) =>
    [...new Set(e.evidence.flatMap((ev) => (ev.line !== undefined ? [ev.line] : [])))].sort((a, b) => a - b);

  const files = scored.slice(0, L.focusFiles).map((c): FocusFile => {
    const importedBy = graph.edges
      .filter((e) => e.to === c.id)
      .map((e) => neighbor(e.from, edgeLines(e)))
      .sort((a, b) => a.path.localeCompare(b.path));
    const imports = graph.edges
      .filter((e) => e.from === c.id)
      .map((e) => neighbor(e.to, edgeLines(e)))
      .sort((a, b) => a.path.localeCompare(b.path));

    const reach = getTransitiveDependents(graph, c.id, {
      maxDepth: L.focusTestDepth,
      maxNodes: L.focusTraversalNodes,
    });
    // Only tests that DO reach this file through confirmed imports are
    // listed; the ORDER among them is lexical: how many basename words a
    // test shares with this file or its direct importers (e.g. a limiter
    // imported by auth.routes.ts ranks auth.integration.test.ts first),
    // then distance, then path.
    const rankWords = new Set(
      [c.id, ...importedBy.map((n) => n.path)].flatMap((x) => [...basenameTokens(x)]),
    );
    const tests = reach.dependents
      .filter((d) => categoryOf.get(d.id) === "test")
      .map((d) => ({
        path: d.id,
        depth: d.depth,
        shared: [...basenameTokens(d.id)].filter((w) => rankWords.has(w)).length,
      }))
      .sort((a, b) => b.shared - a.shared || a.depth - b.depth || a.path.localeCompare(b.path));

    return {
      path: c.id,
      category: c.category,
      matchedTerms: c.matched,
      importedBy: importedBy.slice(0, L.focusNeighbors),
      importedByTotal: importedBy.length,
      imports: imports.slice(0, L.focusNeighbors),
      importsTotal: imports.length,
      tests: tests.slice(0, L.focusTests).map(({ path, depth }) => ({ path, depth })),
      testsTotal: tests.length,
      testsTraversalTruncated: reach.truncated,
    };
  });

  return { terms, files, candidatesTotal: scored.length };
}

export function buildPlanningContext(input: {
  scanId: string;
  analysisId: string;
  items: readonly PlanningInventoryItem[];
  graph: DependencyGraphResult;
  requirement?: { title: string; description?: string | undefined } | undefined;
  /** The scan's `summary.limitsReached` (Stage 5). */
  limitsReached?: readonly string[] | undefined;
  /** Stage 12: per-list caps lower than the defaults (budget fitting only). */
  limits?: Partial<PlanningContextLimits> | undefined;
  /** Stage 12: files whose items are kept first when a list must be cut. */
  priorityFiles?: ReadonlySet<string> | undefined;
}): PlanningContext {
  const L: PlanningContextLimits = { ...PLANNING_CONTEXT_LIMITS, ...input.limits };
  const { graph } = input;
  const pri = input.priorityFiles && input.priorityFiles.size > 0 ? input.priorityFiles : undefined;
  const touches = pri ? (...paths: string[]) => paths.some((p) => pri.has(p)) : undefined;

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

  // Without `priorityFiles` every selection is a plain sorted prefix — the
  // exact pre-Stage-12 behaviour.
  const files = selectBounded(allFiles, L.files, touches && ((f) => touches(f)));
  const edges = selectBounded(allEdges, L.edges, touches && ((e) => touches(e.from, e.to)));
  const byImporter = touches && ((r: ContextRelationship) => touches(r.importerRelativePath));
  const keptUnresolved = selectBounded(unresolved, L.unresolved, byImporter);
  const keptUnsupported = selectBounded(unsupported, L.unsupported, byImporter);
  const keptParseErrors = selectBounded(parseErrors, L.parseErrors, byImporter);
  const keptPackages = selectBounded(allPackages, L.externalPackages);
  const keptCycles = selectBounded(graph.cycles, L.cycles, touches && ((c) => touches(...c)));

  const truncated =
    files.length < allFiles.length ||
    edges.length < allEdges.length ||
    keptUnresolved.length < unresolved.length ||
    keptPackages.length < allPackages.length ||
    keptUnsupported.length < unsupported.length ||
    keptParseErrors.length < parseErrors.length ||
    keptCycles.length < graph.cycles.length ||
    keptCycles.some((c) => c.length - 1 > L.cycleFiles);

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
    files,
    edges,
    unresolved: keptUnresolved,
    externalPackages: keptPackages,
    unsupported: keptUnsupported,
    parseErrors: keptParseErrors,
    cycles: keptCycles,
    isAcyclic: graph.isAcyclic,
    coverage: (() => {
      const cov = scanCoverage(input.items, input.limitsReached ?? []);
      return {
        stoppedEarly: cov.stoppedEarly,
        // Real directories only; symlink placeholders are not "directories not read".
        unreadDirectories: input.items.filter(
          (i) => i.type === "directory" && (i.status === "skipped" || i.status === "error"),
        ).length,
        ignoredDirectories: input.items.filter(
          (i) => i.type === "directory" && i.status === "skipped" && i.skipReason === "ignored",
        ).length,
      };
    })(),
    focus: input.requirement ? buildRequirementFocus(input.requirement, graph, L) : null,
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

function citeNeighbors(list: FocusNeighbor[], total: number): string {
  if (total === 0) return "none";
  const shown = list.map((n) => (n.lines.length ? `${n.path}:${n.lines.join(",")}` : n.path)).join(", ");
  return total > list.length ? `${shown} (+${total - list.length} more)` : shown;
}

function renderFocus(focus: RequirementFocus): string[] {
  const lines = [
    `REQUIREMENT FOCUS. Files below were picked ONLY because their path contains a word from the requirement (${focus.terms.join(", ") || "no usable words"}) — a lexical match, not proof they are relevant. Their import relationships below ARE confirmed by the analysis. Import relationships show where things are wired; they do not show how an imported symbol is used.`,
  ];
  if (focus.files.length === 0) {
    lines.push("- (no file path matched the requirement's words)");
    return lines;
  }
  if (focus.candidatesTotal > focus.files.length) {
    lines.push(
      `(${focus.files.length} of ${focus.candidatesTotal} matching files shown, strongest matches first)`,
    );
  }
  for (const f of focus.files) {
    const tests =
      f.testsTotal === 0
        ? `none found within ${PLANNING_CONTEXT_LIMITS.focusTestDepth} import hops${f.testsTraversalTruncated ? " (search was bounded)" : ""}`
        : f.tests
            .map((t) => `${t.path} (${t.depth === 1 ? "imports it directly" : `${t.depth} hops`})`)
            .join(", ") +
          (f.testsTotal > f.tests.length ? ` (+${f.testsTotal - f.tests.length} more)` : "") +
          (f.testsTraversalTruncated ? " (search was bounded)" : "");
    lines.push(
      `- ${f.path} [${f.category ?? "uncategorized"}; path matches: ${f.matchedTerms.join(", ")}]`,
      `  imported by: ${citeNeighbors(f.importedBy, f.importedByTotal)}`,
      `  imports: ${citeNeighbors(f.imports, f.importsTotal)}`,
      `  test files reaching it through confirmed imports (closest name match first): ${tests}`,
    );
  }
  return lines;
}

/** A cycle is stored with its start repeated at the end; long ones are shown as a bounded prefix. */
function renderCycle(cycle: readonly string[]): string {
  const files = cycle.length - 1;
  if (files <= PLANNING_CONTEXT_LIMITS.cycleFiles) return cycle.join(" -> ");
  const shown = cycle.slice(0, PLANNING_CONTEXT_LIMITS.cycleFiles);
  return `${shown.join(" -> ")} -> … (${files - shown.length} more files, then back to ${cycle[0]})`;
}

function renderBudget(b: ContextBudget): string {
  const parts = b.reductions.map((r) => `${r.section} (${r.shown} of ${r.total} listed)`);
  return `CONTEXT REDUCED TO FIT THE MODEL'S BUDGET: ${parts.join("; ")}. Anything not listed below was left out for space — it is NOT absent from the project, and its absence here is not evidence of anything. Totals in each heading are exact.`;
}

function renderCoverage(c: PlanningContext["coverage"]): string {
  const gaps = c.unreadDirectories - c.ignoredDirectories;
  const ignored = c.ignoredDirectories
    ? ` ${c.ignoredDirectories} ignored director${c.ignoredDirectories === 1 ? "y" : "ies"} (dependencies/build output) were not read.`
    : "";
  if (c.stoppedEarly.length === 0 && gaps === 0) {
    return `Scan coverage: complete.${ignored}`;
  }
  const parts = [
    ...(c.stoppedEarly.length ? [`the scan stopped early (${c.stoppedEarly.join(", ")})`] : []),
    `${c.unreadDirectories} directories were not read`,
  ];
  return `Scan coverage: INCOMPLETE — ${parts.join("; ")}. A file missing from this context may still exist; do not assume it is absent.`;
}

/** Deterministic prompt section. Every list states whether it was truncated. */
export function renderPlanningContext(ctx: PlanningContext): string {
  const lines: string[] = [];
  lines.push(
    `VERIFIED PROJECT CONTEXT (read-only scan ${ctx.scanId}, dependency analysis ${ctx.analysisId}).`,
    "This is the ONLY evidence you have about the codebase. Do not assume any file, dependency, or package that is not listed here.",
    "",
    renderCoverage(ctx.coverage),
    "",
    ...(ctx.budget && ctx.budget.reductions.length > 0 ? [renderBudget(ctx.budget), ""] : []),
    ...(ctx.focus ? [...renderFocus(ctx.focus), ""] : []),
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
    ...(ctx.isAcyclic ? [] : ctx.cycles.map((c) => `- ${renderCycle(c)}`)),
  );
  if (ctx.truncated) {
    lines.push("", "Some lists above were truncated to keep this context bounded; the totals are exact.");
  }
  return lines.join("\n");
}

export type AffectedFileEvidence = "in_scan" | "not_in_scan" | "unverified";

export type AffectedFileChangeClaim = "modify" | "create" | "test" | "reference";

export interface ClassifiedAffectedFile {
  path: string;
  reason: string;
  /** Absent when the AI stated no intent — never defaulted. */
  change?: AffectedFileChangeClaim | undefined;
  evidence: AffectedFileEvidence;
  conflict?: string | undefined;
  /** Stage 4: verified relation to the plan's impact target (absent = not found within the bounded impact). */
  impactRelation?: ImpactRelation | undefined;
  /** Stage 5: why a label is "unverified" even though the plan is grounded (e.g. inside an unread directory). */
  evidenceNote?: string | undefined;
  dependentsCount?: number | undefined;
  dependenciesCount?: number | undefined;
  /** Task 3: an earlier task this one depends on creates this path (set at plan level). */
  plannedBy?: string | undefined;
  /** Task 3: paths/import relationships the AI stated in `reason`, checked against the scan. */
  claimChecks?: ClaimCheck[] | undefined;
}

export interface AffectedFileEvidenceSource {
  inventory: ReadonlySet<string>;
  graph: Pick<DependencyGraphResult, "nodes" | "edges">;
  /** Stage 4: verified relation to the plan's impact target, if one was requested. */
  impactRelation?: ((path: string) => ImpactRelation | undefined) | undefined;
  /** Stage 5: what the scan could not have seen. Absent = treat the scan as complete (pre-Stage 5 behaviour). */
  coverage?: ScanCoverage | undefined;
}

/** Why a path absent from the inventory may still exist; undefined = the scan looked and it is absent. */
function absenceNote(source: AffectedFileEvidenceSource, path: string): string | undefined {
  if (source.inventory.has(path) || !source.coverage) return undefined;
  const unread = unreadAncestor(source.coverage, path);
  if (unread) {
    return unread[0] === path
      ? `This path is ${unread[1]}; its contents were not observed.`
      : `Inside ${unread[0]}, ${unread[1]}; the scan did not look inside it.`;
  }
  if (source.coverage.stoppedEarly.length) {
    return `The scan stopped early (${source.coverage.stoppedEarly.join(", ")}), so this path may exist but was not observed.`;
  }
  return undefined;
}

/** Task 3: the scan evidence free-text claims are checked against. */
export function claimSourceFor(source: AffectedFileEvidenceSource): ClaimSource {
  return {
    inventory: source.inventory,
    graph: source.graph,
    absenceNote: (path) => absenceNote(source, path),
  };
}

/**
 * Classifies AI-proposed paths against the recorded scan — the AI never
 * decides whether a file exists. `null` source (plan not grounded in a
 * scan) means every path is "unverified", never "in_scan". Duplicate
 * paths keep their first occurrence.
 */
export function classifyAffectedFiles(
  files: readonly {
    path: string;
    reason?: string | undefined;
    change?: AffectedFileChangeClaim | undefined;
  }[],
  source: AffectedFileEvidenceSource | null,
): ClassifiedAffectedFile[] {
  const seen = new Set<string>();
  const result: ClassifiedAffectedFile[] = [];
  const nodeIds = source ? new Set(source.graph.nodes.map((n) => n.id)) : null;
  const claimSource = source ? claimSourceFor(source) : null;
  const claimsOf = (path: string, reason: string) => {
    const checks = claimSource ? checkClaims(reason, path, claimSource, CLAIM_CHECK_LIMITS.perFile) : [];
    return checks.length ? { claimChecks: checks } : {};
  };

  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const reason = file.reason ?? "";
    const change = file.change;
    // Only present when the AI actually stated an intent.
    const claim = change ? { change } : {};

    if (!source) {
      result.push({ path: file.path, reason, ...claim, evidence: "unverified" });
      continue;
    }
    // Absent from the inventory only proves absence where the scan looked.
    const note = absenceNote(source, file.path);
    if (note) {
      result.push({
        path: file.path,
        reason,
        ...claim,
        evidence: "unverified",
        evidenceNote: note,
        ...claimsOf(file.path, reason),
      });
      continue;
    }
    if (!source.inventory.has(file.path)) {
      result.push({
        path: file.path,
        reason,
        ...claim,
        evidence: "not_in_scan",
        // Only "create" (and a new test file) make sense for a path the
        // scan never saw; modifying or following a file that isn't there is
        // a contradiction the reviewer must see.
        conflict:
          change === "modify" || change === "reference"
            ? `Claimed "${change}", but this path is not in the scan`
            : undefined,
        ...claimsOf(file.path, reason),
      });
      continue;
    }
    const isNode = nodeIds?.has(file.path) ?? false;
    // Only in-scan files can have a verified relation to the impact target.
    const relation = source.impactRelation?.(file.path);
    result.push({
      path: file.path,
      reason,
      ...claim,
      evidence: "in_scan",
      conflict:
        change === "create" ? 'Claimed "create", but this file already exists in the scan' : undefined,
      ...(relation ? { impactRelation: relation } : {}),
      dependentsCount: isNode ? source.graph.edges.filter((e) => e.to === file.path).length : undefined,
      dependenciesCount: isNode ? source.graph.edges.filter((e) => e.from === file.path).length : undefined,
      ...claimsOf(file.path, reason),
    });
  }
  return result;
}
