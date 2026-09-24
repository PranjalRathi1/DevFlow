import { describe, expect, it } from "vitest";
import { buildDependencyGraph, type GraphRelationshipInput } from "../sourceDependencyGraph.js";
import {
  PLANNING_CONTEXT_LIMITS,
  buildPlanningContext,
  renderPlanningContext,
  type PlanningContext,
  type PlanningContextLimits,
  type PlanningInventoryItem,
} from "../planningContext.js";
import { FITTING_STEPS, FIT_SAFETY_MARGIN_TOKENS, fitPlanningContext } from "../contextFitting.js";
import { buildPlanningPrompt } from "../../services/ai/promptBuilder.js";
import { estimatePromptTokens, maxPromptTokens } from "../../services/ai/ollamaProvider.js";

const requirement = { title: "Rate-limit scan service endpoints", description: "Limit scan calls per user." };
const BUDGET_16K = maxPromptTokens(16384) - FIT_SAFETY_MARGIN_TOKENS;

/** A synthetic project: `n` source files, each importing 3 others, plus unresolved/external/unsupported imports. */
function project(n: number, order: "forward" | "reverse" = "forward") {
  const items: PlanningInventoryItem[] = Array.from({ length: n }, (_, i) => ({
    relativePath: `src/area${i % 20}/scan${String(i).padStart(4, "0")}.service.ts`,
    type: "file",
    status: "scanned",
  }));
  const rels: GraphRelationshipInput[] = [];
  const conf = (from: string, to: string, line: number): GraphRelationshipInput => ({
    importerRelativePath: from,
    rawImport: "./x.js",
    isLiteral: true,
    status: "confirmed",
    line,
    resolvedRelativePath: to,
  });
  for (let i = 0; i < n; i++) {
    for (const k of [1, 7, 31]) rels.push(conf(items[i]!.relativePath, items[(i + k) % n]!.relativePath, k));
  }
  for (let i = 0; i < 60; i++) {
    const importer = items[i % n]!.relativePath;
    rels.push({
      importerRelativePath: importer,
      rawImport: `./gone-${i}.js`,
      isLiteral: true,
      status: "unresolved",
      line: 90 + i,
      reason: "No matching file",
    });
    rels.push({
      importerRelativePath: importer,
      rawImport: `pkg-${i}`,
      isLiteral: true,
      status: "external",
      line: 200 + i,
    });
    rels.push({
      importerRelativePath: importer,
      rawImport: `@/alias-${i}`,
      isLiteral: true,
      status: "unsupported",
      line: 300 + i,
      reason: "Alias",
    });
  }
  const inv = order === "reverse" ? [...items].reverse() : items;
  const rs = order === "reverse" ? [...rels].reverse() : rels;
  const graph = buildDependencyGraph(
    inv.map((i) => ({ relativePath: i.relativePath, language: "typescript" })),
    rs,
  );
  return { items: inv, graph };
}

function fitterFor(
  p: ReturnType<typeof project>,
  overrides: { budget?: number; estimate?: (s: string) => number } = {},
) {
  const build = (limits: Partial<PlanningContextLimits>, priorityFiles: ReadonlySet<string>) =>
    buildPlanningContext({
      scanId: "s",
      analysisId: "a",
      items: p.items,
      graph: p.graph,
      requirement,
      limits,
      priorityFiles,
    });
  const render = (ctx: PlanningContext) =>
    buildPlanningPrompt({
      projectName: "Synthetic",
      requirementTitle: requirement.title,
      requirementDescription: requirement.description,
      projectEvidence: renderPlanningContext(ctx),
    });
  return fitPlanningContext({
    build,
    render,
    estimateTokens: overrides.estimate ?? estimatePromptTokens,
    budgetTokens: overrides.budget ?? BUDGET_16K,
  });
}

describe("fitPlanningContext — no reduction when it already fits", () => {
  it("leaves a small context exactly as it was and records an empty fitting", () => {
    const p = project(30);
    const result = fitterFor(p);
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.budget.steps).toEqual([]);
    expect(result.budget.reductions).toEqual([]);
    const unfitted = buildPlanningContext({
      scanId: "s",
      analysisId: "a",
      items: p.items,
      graph: p.graph,
      requirement,
    });
    expect(renderPlanningContext(result.context)).toBe(renderPlanningContext(unfitted));
    expect(result.prompt).not.toContain("CONTEXT REDUCED");
  });
});

describe("fitPlanningContext — large projects", () => {
  const big = project(2000);
  const result = fitterFor(big);

  it("fits a project far over budget, and the final prompt really is within budget", () => {
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.budget.estimatedTokensBefore).toBeGreaterThan(BUDGET_16K);
    expect(result.budget.estimatedTokensAfter).toBeLessThanOrEqual(BUDGET_16K);
    expect(estimatePromptTokens(result.prompt)).toBe(result.budget.estimatedTokensAfter);
    expect(result.budget.steps.length).toBeGreaterThan(0);
  });

  it("applies steps as an in-order prefix of the declared policy", () => {
    if (!result.fits) throw new Error("expected fit");
    expect(result.budget.steps).toEqual(FITTING_STEPS.slice(0, result.budget.steps.length).map((s) => s.id));
  });

  it("keeps every total exact and reports each shortened section with its true total", () => {
    if (!result.fits) throw new Error("expected fit");
    const full = buildPlanningContext({
      scanId: "s",
      analysisId: "a",
      items: big.items,
      graph: big.graph,
      requirement,
    });
    expect(result.context.counts).toEqual(full.counts);
    expect(result.context.truncated).toBe(true);
    for (const r of result.budget.reductions) expect(r.shown).toBeLessThan(r.total);
    const files = result.budget.reductions.find((r) => r.section === "files");
    expect(files).toEqual({ section: "files", shown: result.context.files.length, total: 2000 });
    const edges = result.budget.reductions.find((r) => r.section === "confirmed dependencies");
    expect(edges?.total).toBe(6000);
  });

  it("tells the model what was left out, and that omitted is not absent", () => {
    if (!result.fits) throw new Error("expected fit");
    expect(result.prompt).toContain("CONTEXT REDUCED TO FIT THE MODEL'S BUDGET:");
    expect(result.prompt).toContain("it is NOT absent from the project");
    expect(result.prompt).toMatch(/files \(\d+ of 2000 listed\)/);
    // Every category heading survives with its exact total.
    expect(result.prompt).toContain("Files in the scan inventory (");
    expect(result.prompt).toMatch(
      /Confirmed internal dependencies \(\d+ of 6000 shown\)|Confirmed internal dependencies \(0 of 6000 shown\)/,
    );
    expect(result.prompt).toMatch(/Unresolved imports — NOT confirmed dependencies \(\d+ of 60 shown\)/);
    expect(result.prompt).toMatch(/External packages, by number of importing files \(\d+ of 60 shown\)/);
    expect(result.prompt).toMatch(/Unsupported import syntax — not analyzed \(\d+ of 60 shown\)/);
  });

  it("never turns unresolved, external, or unsupported imports into edges", () => {
    if (!result.fits) throw new Error("expected fit");
    const edgeTargets = new Set(result.context.edges.map((e) => e.to));
    for (const u of result.context.unresolved) expect(edgeTargets.has(u.rawImport)).toBe(false);
    expect(JSON.stringify(result.context.edges)).not.toMatch(/gone-|pkg-|@\/alias/);
    // Every kept item is a genuine relationship of the SAME category in the graph
    // (priority selection may keep a different subset than the default prefix).
    const key = (r: { importerRelativePath: string; rawImport: string }) =>
      `${r.importerRelativePath}:${r.rawImport}`;
    const graphUnresolved = new Set(big.graph.unresolved.map(key));
    const graphUnsupported = new Set(big.graph.unsupported.map(key));
    for (const u of result.context.unresolved) expect(graphUnresolved.has(key(u))).toBe(true);
    for (const u of result.context.unsupported) expect(graphUnsupported.has(key(u))).toBe(true);
  });

  it("keeps focus-related items first when a list is cut", () => {
    if (!result.fits) throw new Error("expected fit");
    const focus = result.context.focus!;
    const priority = new Set(
      focus.files.flatMap((f) => [
        f.path,
        ...f.importedBy.map((n) => n.path),
        ...f.imports.map((n) => n.path),
        ...f.tests.map((t) => t.path),
      ]),
    );
    const touching = result.context.edges.filter((e) => priority.has(e.from) || priority.has(e.to)).length;
    const totalTouching = big.graph.edges.filter((e) => priority.has(e.from) || priority.has(e.to)).length;
    // Either every priority edge was kept, or the kept list is ALL priority edges.
    expect(touching === totalTouching || touching === result.context.edges.length).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const again = fitterFor(project(2000, "reverse"));
    if (!result.fits || !again.fits) throw new Error("expected fit");
    expect(again.prompt).toBe(result.prompt);
    expect(again.budget).toEqual(result.budget);
  });
});

describe("fitPlanningContext — each step, in order", () => {
  const p = project(600);

  it.each(FITTING_STEPS.map((s, i) => [i + 1, s.id] as const))(
    "stops after exactly %i step(s) (last: %s) when the estimate first fits there, with caps enforced",
    (n) => {
      // Estimator that reports "over budget" until the fitter has rendered n reduced prompts.
      let calls = 0;
      const estimate = () => (calls++ <= n - 1 ? 1_000_000 : 1);
      const result = fitterFor(p, { budget: 100, estimate });
      expect(result.fits).toBe(true);
      if (!result.fits) return;
      expect(result.budget.steps).toEqual(FITTING_STEPS.slice(0, n).map((s) => s.id));
      const caps: Record<string, number> = { ...PLANNING_CONTEXT_LIMITS };
      for (const step of FITTING_STEPS.slice(0, n)) {
        for (const [k, v] of Object.entries(step.limits)) caps[k] = Math.min(caps[k]!, v as number);
      }
      const ctx = result.context;
      expect(ctx.files.length).toBeLessThanOrEqual(caps.files!);
      expect(ctx.edges.length).toBeLessThanOrEqual(caps.edges!);
      expect(ctx.unresolved.length).toBeLessThanOrEqual(caps.unresolved!);
      expect(ctx.externalPackages.length).toBeLessThanOrEqual(caps.externalPackages!);
      expect(ctx.unsupported.length).toBeLessThanOrEqual(caps.unsupported!);
      expect(ctx.cycles.length).toBeLessThanOrEqual(caps.cycles!);
      expect(ctx.focus!.files.length).toBeLessThanOrEqual(caps.focusFiles!);
      for (const f of ctx.focus!.files) {
        expect(f.importedBy.length).toBeLessThanOrEqual(caps.focusNeighbors!);
        expect(f.tests.length).toBeLessThanOrEqual(caps.focusTests!);
      }
    },
  );
});

describe("fitPlanningContext — cannot fit", () => {
  it("reports failure after the minimum safe context, having applied every step", () => {
    const result = fitterFor(project(600), { budget: 10 });
    expect(result.fits).toBe(false);
    expect(result.budget.steps).toEqual(FITTING_STEPS.map((s) => s.id));
    expect(result.budget.estimatedTokensAfter).toBeGreaterThan(10);
  });
});
