import { z } from "zod";
import { PRIORITIES } from "../models/Requirement.js";
import { topologicalSort, validateGraph, type DependencyGraph } from "../lib/dependencyGraph.js";

// Bounds chosen to keep a plan reviewable by a human in one sitting and to
// cap the cost/blast-radius of trusting AI output at all — not arbitrary,
// but not scientifically derived either; revisit if real usage shows
// these are wrong in practice.
const MAX_TASKS = 30;
const MAX_LIST_ITEMS = 20;
const MAX_TEXT = 2000;
const MAX_TEMP_ID = 50;
/** Rejected before even attempting JSON.parse — a defensive bound on raw provider output size. */
export const MAX_RAW_RESPONSE_CHARS = 100_000;

const tempIdSchema = z.string().trim().min(1).max(MAX_TEMP_ID);

const MAX_AFFECTED_FILES = 20;

/**
 * An AI-proposed project-relative path. Normalized (`\` -> `/`, leading
 * `./` stripped) so it can be compared with scan inventory paths; an
 * absolute, drive-letter, or `..`-climbing path is rejected outright
 * rather than guessed into something else. Nothing here touches disk.
 */
export const proposedPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((p) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, ""))
  .refine(
    (p) =>
      p.length > 0 &&
      !p.startsWith("/") &&
      !/^[a-zA-Z]:/.test(p) &&
      !p.includes("\0") &&
      !p.split("/").some((segment) => segment === ".."),
    { message: 'must be a project-relative path without ".." segments' },
  );

// Only path + reason are accepted from the AI (or a human edit). Whether a
// file exists in the scan is computed server-side — an `evidence` field
// supplied here is stripped by Zod, never trusted.
const affectedFileInputSchema = z.object({
  path: proposedPathSchema,
  reason: z.string().trim().max(500).optional().default(""),
});

const suggestedTaskSchema = z.object({
  tempId: tempIdSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(MAX_TEXT).optional().default(""),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(MAX_LIST_ITEMS).optional().default([]),
  priority: z.enum(PRIORITIES).optional().default("medium"),
  dependsOn: z.array(tempIdSchema).max(MAX_LIST_ITEMS).optional().default([]),
  rationale: z.string().trim().max(1000).optional().default(""),
  affectedFiles: z.array(affectedFileInputSchema).max(MAX_AFFECTED_FILES).optional().default([]),
});

export const aiPlanSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(MAX_TEXT),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(MAX_LIST_ITEMS).optional().default([]),
  risks: z.array(z.string().trim().min(1).max(500)).max(MAX_LIST_ITEMS).optional().default([]),
  suggestedTasks: z.array(suggestedTaskSchema).min(1).max(MAX_TASKS),
});
export type AIPlanOutput = z.infer<typeof aiPlanSchema>;
export type SuggestedTask = AIPlanOutput["suggestedTasks"][number];

// Reused by plan.service.ts's update path: editing a plan's suggestedTasks
// (still allowed while status is "needs_review" — see Plan.ts) must be
// re-validated the same way freshly-generated AI output is, so a human
// edit can't reintroduce a cycle/duplicate/dangling reference either.
export const updatablePlanFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(MAX_TEXT).optional(),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(MAX_LIST_ITEMS).optional(),
  risks: z.array(z.string().trim().min(1).max(500)).max(MAX_LIST_ITEMS).optional(),
  suggestedTasks: z.array(suggestedTaskSchema).min(1).max(MAX_TASKS).optional(),
});
export type UpdatablePlanFields = z.infer<typeof updatablePlanFieldsSchema>;

export interface PlanValidationIssue {
  type:
    "schema" | "duplicate_temp_id" | "self_dependency" | "duplicate_edge" | "missing_dependency" | "cycle";
  message: string;
}

export interface PlanValidationResult {
  valid: boolean;
  plan: AIPlanOutput | null;
  issues: PlanValidationIssue[];
  /** Topological order of tempIds — computed by the graph engine, never trusted from the AI. Empty when invalid. */
  suggestedOrder: string[];
}

/**
 * Semantic checks Zod alone can't express: unique tempIds, and the
 * dependsOn graph itself — reusing the same graph engine that validates
 * real Task.dependencies, so neither AI output nor a human edit can ever
 * result in a persisted plan with a defect the engine would catch anyway.
 * Shared by `validateAIPlan` (fresh generation) and `plan.service.ts`'s
 * update path (editing suggestedTasks while a plan is still under review).
 */
export function validateSuggestedTasksGraph(suggestedTasks: SuggestedTask[]): {
  issues: PlanValidationIssue[];
  suggestedOrder: string[];
} {
  const issues: PlanValidationIssue[] = [];

  const seenTempIds = new Set<string>();
  for (const task of suggestedTasks) {
    if (seenTempIds.has(task.tempId)) {
      issues.push({ type: "duplicate_temp_id", message: `Duplicate temporary task id: "${task.tempId}"` });
    }
    seenTempIds.add(task.tempId);
  }

  const graph: DependencyGraph = {
    nodes: [...seenTempIds],
    edges: suggestedTasks.flatMap((task) => task.dependsOn.map((to) => ({ from: task.tempId, to }))),
  };
  const graphResult = validateGraph(graph);
  for (const error of graphResult.errors) {
    switch (error.type) {
      case "self_dependency":
        issues.push({ type: "self_dependency", message: `Task "${error.taskId}" depends on itself` });
        break;
      case "duplicate_edge":
        issues.push({
          type: "duplicate_edge",
          message: `Task "${error.from}" lists "${error.to}" as a dependency more than once`,
        });
        break;
      case "missing_node":
        issues.push({
          type: "missing_dependency",
          message: `Task "${error.referencedBy}" depends on unknown task "${error.taskId}"`,
        });
        break;
      case "cycle":
        issues.push({ type: "cycle", message: `Circular dependency: ${error.cycle.join(" -> ")}` });
        break;
    }
  }

  if (issues.length > 0) {
    return { issues, suggestedOrder: [] };
  }

  // The graph was already confirmed acyclic above, so topologicalSort
  // returning null here isn't a real code path — `?? []` is defensive only.
  return { issues: [], suggestedOrder: topologicalSort(graph) ?? [] };
}

/**
 * Full validation pipeline for raw AI output: Zod structural validation,
 * then `validateSuggestedTasksGraph`. Never partially trusts the input:
 * any issue means `valid: false` and the plan must not be persisted.
 */
export function validateAIPlan(raw: unknown): PlanValidationResult {
  const parsed = aiPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      plan: null,
      issues: parsed.error.issues.map((issue) => ({
        type: "schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
      suggestedOrder: [],
    };
  }

  const plan = parsed.data;
  const { issues, suggestedOrder } = validateSuggestedTasksGraph(plan.suggestedTasks);
  return { valid: issues.length === 0, plan, issues, suggestedOrder };
}
