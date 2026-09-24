import {
  PLANNING_CONTEXT_LIMITS,
  type BudgetReduction,
  type ContextBudget,
  type PlanningContext,
  type PlanningContextLimits,
} from "./planningContext.js";

/**
 * Stage 12 (ADR-027): deterministic budget fitting for the scan-grounded
 * planning prompt. Pure — no I/O, no AI. Given a way to build the context
 * under tighter caps and a way to render + estimate the full prompt, it
 * applies FITTING_STEPS cumulatively, in order, until the estimate fits.
 *
 * The order is the policy: least necessary for safe planning is shortened
 * first. Never shortened by this fitter (the "minimum safe context"): the
 * requirement, planning rules and output schema, scan coverage, every
 * section heading with its EXACT total (so confirmed / unresolved /
 * external / unsupported / parse-error stay distinct and counted), the
 * focus files themselves (down to 6), and the user's impact section. If
 * that minimum still doesn't fit, the caller must refuse — never truncate.
 */
export interface FittingStep {
  id: string;
  /** Caps applied from this step on (cumulative: the lower cap always wins). */
  limits: Partial<PlanningContextLimits>;
}

export const FITTING_STEPS: readonly FittingStep[] = [
  // 1. The flat file inventory: paths also appear in focus/edges, and file
  //    labels are verified server-side whether listed or not.
  { id: "files:100", limits: { files: 100 } },
  // 2. External package names: counts stay; names are least relevant.
  { id: "externalPackages:20", limits: { externalPackages: 20 } },
  // 3. Confirmed edges not touching focus/impact files go first.
  { id: "edges:200", limits: { edges: 200 } },
  { id: "files:40", limits: { files: 40 } },
  { id: "edges:100", limits: { edges: 100 } },
  // 4. Diagnostic item lists (headings + exact totals remain).
  { id: "diagnostics:20/10/10", limits: { unresolved: 20, unsupported: 10, parseErrors: 10 } },
  { id: "cycles:3", limits: { cycles: 3 } },
  { id: "externalPackages:0", limits: { externalPackages: 0 } },
  { id: "files:0", limits: { files: 0 } },
  { id: "edges:40", limits: { edges: 40 } },
  // 5. Only now touch the requirement focus detail...
  { id: "focusDetail:3/2", limits: { focusNeighbors: 3, focusTests: 2 } },
  { id: "diagnostics:5/3/3", limits: { unresolved: 5, unsupported: 3, parseErrors: 3 } },
  { id: "edges:0", limits: { edges: 0 } },
  // ...and finally the number of focus files and listed cycles.
  { id: "focusFiles:6", limits: { focusFiles: 6 } },
  { id: "cycles:0", limits: { cycles: 0 } },
];

/** Headroom kept below the provider's hard prompt budget (ADR-020), on top of its conservative estimate. */
export const FIT_SAFETY_MARGIN_TOKENS = 256;

export interface FitInput {
  /** Builds the context under the given caps, keeping `priority` files' items first. */
  build: (limits: Partial<PlanningContextLimits>, priority: ReadonlySet<string>) => PlanningContext;
  /** Renders the FULL prompt (all sections, impact included) for a context. */
  render: (ctx: PlanningContext) => string;
  estimateTokens: (prompt: string) => number;
  budgetTokens: number;
  /** Extra files to keep first (e.g. the impact target and its relations). */
  priorityFiles?: ReadonlySet<string> | undefined;
}

export type FitResult =
  | { fits: true; context: PlanningContext; prompt: string; budget: ContextBudget }
  | { fits: false; budget: ContextBudget };

/** Files whose items matter most when something must be cut: the focus files and what they touch. */
function focusPriority(ctx: PlanningContext): Set<string> {
  const files = new Set<string>();
  for (const f of ctx.focus?.files ?? []) {
    files.add(f.path);
    for (const n of [...f.importedBy, ...f.imports]) files.add(n.path);
    for (const t of f.tests) files.add(t.path);
  }
  return files;
}

function mergeLimits(
  a: Partial<PlanningContextLimits>,
  b: Partial<PlanningContextLimits>,
): Partial<PlanningContextLimits> {
  const out: Partial<PlanningContextLimits> = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof PlanningContextLimits, number][]) {
    out[k] = Math.min(out[k] ?? PLANNING_CONTEXT_LIMITS[k], v);
  }
  return out;
}

/** What the fitter shortened relative to the full (default-cap) context, with exact totals. */
function reductionsOf(full: PlanningContext, fitted: PlanningContext): BudgetReduction[] {
  const out: BudgetReduction[] = [];
  const add = (section: string, shown: number, before: number, total: number) => {
    if (shown < before) out.push({ section, shown, total });
  };
  const c = full.counts;
  add("files", fitted.files.length, full.files.length, c.files);
  add("confirmed dependencies", fitted.edges.length, full.edges.length, c.confirmedEdges);
  add("unresolved imports", fitted.unresolved.length, full.unresolved.length, c.unresolved);
  add("external packages", fitted.externalPackages.length, full.externalPackages.length, c.externalPackages);
  add("unsupported imports", fitted.unsupported.length, full.unsupported.length, c.unsupported);
  add("parse errors", fitted.parseErrors.length, full.parseErrors.length, c.parseErrors);
  add("import cycles", fitted.cycles.length, full.cycles.length, c.cycles);
  const focusCandidates = full.focus?.candidatesTotal ?? 0;
  add("focus files", fitted.focus?.files.length ?? 0, full.focus?.files.length ?? 0, focusCandidates);
  const detail = (ctx: PlanningContext) =>
    (ctx.focus?.files ?? []).reduce((n, f) => n + f.importedBy.length + f.imports.length + f.tests.length, 0);
  const detailTotal = (full.focus?.files ?? []).reduce(
    (n, f) => n + f.importedByTotal + f.importsTotal + f.testsTotal,
    0,
  );
  add("focus file details", detail(fitted), detail(full), detailTotal);
  return out;
}

export function fitPlanningContext(input: FitInput): FitResult {
  const full = input.build({}, new Set());
  const fullPrompt = input.render(full);
  const before = input.estimateTokens(fullPrompt);
  const target = input.budgetTokens;

  if (before <= target) {
    const budget: ContextBudget = {
      budgetTokens: target,
      estimatedTokensBefore: before,
      estimatedTokensAfter: before,
      steps: [],
      reductions: [],
    };
    const context = { ...full, budget };
    // The note is empty when nothing was reduced, so this is the same text.
    return { fits: true, context, prompt: input.render(context), budget };
  }

  const priority = new Set([...focusPriority(full), ...(input.priorityFiles ?? [])]);
  let limits: Partial<PlanningContextLimits> = {};
  const steps: string[] = [];
  let last: { context: PlanningContext; tokens: number } | undefined;

  for (const step of FITTING_STEPS) {
    limits = mergeLimits(limits, step.limits);
    steps.push(step.id);
    const built = input.build(limits, priority);
    const budget: ContextBudget = {
      budgetTokens: target,
      estimatedTokensBefore: before,
      estimatedTokensAfter: 0,
      steps: [...steps],
      reductions: reductionsOf(full, built),
    };
    // Render WITH the reduction note: the note costs tokens too.
    const context = { ...built, budget };
    const prompt = input.render(context);
    const tokens = input.estimateTokens(prompt);
    budget.estimatedTokensAfter = tokens;
    last = { context, tokens };
    if (tokens <= target) return { fits: true, context, prompt, budget };
  }

  return {
    fits: false,
    budget: last?.context.budget ?? {
      budgetTokens: target,
      estimatedTokensBefore: before,
      estimatedTokensAfter: before,
      steps,
      reductions: [],
    },
  };
}
