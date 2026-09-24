import { Plan, type PlanDocument } from "../models/Plan.js";
import { Task } from "../models/Task.js";
import { Requirement } from "../models/Requirement.js";
import { AppError } from "../utils/AppError.js";
import { getProjectForOwner, requireValidObjectId } from "./project.service.js";
import { getAIProvider, AIProviderError } from "./ai/index.js";
import { buildPlanningPrompt } from "./ai/promptBuilder.js";
import {
  validateAIPlan,
  validateSuggestedTasksGraph,
  MAX_RAW_RESPONSE_CHARS,
  type SuggestedTask,
} from "../validators/aiPlan.validators.js";
import type { UpdatablePlanFields } from "../validators/aiPlan.validators.js";
import { loadPlanGrounding, type PlanGrounding } from "./planContext.service.js";
import {
  buildPlanningContext,
  classifyAffectedFiles,
  renderPlanningContext,
  type AffectedFileEvidenceSource,
  type PlanningContext,
} from "../lib/planningContext.js";
import { fitPlanningContext, FIT_SAFETY_MARGIN_TOKENS } from "../lib/contextFitting.js";
import { estimatePromptTokens, maxPromptTokens } from "./ai/ollamaProvider.js";
import { assertObservedFile } from "./impact.service.js";
import {
  computeImpact,
  impactRelationOf,
  renderImpactForPrompt,
  IMPACT_PLANNING_BOUNDS,
  type ImpactResult,
} from "../lib/impactAnalysis.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

async function getOwnedRequirementInProject(ownerId: string, projectId: string, requirementId: string) {
  requireValidObjectId(requirementId, "requirement id");
  const requirement = await Requirement.findOne({ _id: requirementId, owner: ownerId, project: projectId });
  if (!requirement) {
    throw new AppError("Requirement not found in this project", 404);
  }
  return requirement;
}

/**
 * Attaches server-computed evidence to each task's AI-proposed files.
 * The AI (or a human edit) supplies only `path`/`reason`; whether that
 * path exists in the scan is decided here, never trusted from input.
 */
function withFileEvidence(tasks: SuggestedTask[], source: AffectedFileEvidenceSource | null) {
  return tasks.map((task) => ({ ...task, affectedFiles: classifyAffectedFiles(task.affectedFiles, source) }));
}

/** Adds the verified impact relation lookup to a grounding's evidence source (Stage 4). */
function evidenceSourceFor(
  grounding: PlanGrounding,
  impact: ImpactResult | null,
): AffectedFileEvidenceSource {
  return impact
    ? { ...grounding.evidenceSource, impactRelation: (path: string) => impactRelationOf(impact, path) }
    : grounding.evidenceSource;
}

/** Same pinned graph + same stored bounds => the same impact as at generation (deterministic). */
function impactFor(grounding: PlanGrounding, file: string, bounds: { maxDepth: number; maxNodes: number }) {
  assertObservedFile(grounding.scan, file);
  return computeImpact(grounding.graph, file, bounds);
}

/** Files an impact target makes most relevant — kept first if the context must be cut. */
function impactPriority(impact: ImpactResult): Set<string> {
  return new Set([
    impact.file,
    ...impact.directDependencies.map((d) => d.file),
    ...impact.directDependents.map((d) => d.file),
    ...impact.transitiveDependents.map((d) => d.file),
  ]);
}

/** `context` is the context the model was actually shown (possibly budget-fitted). */
function sourceContextFor(grounding: PlanGrounding, context: PlanningContext, impact: ImpactResult | null) {
  return {
    scan: grounding.scan._id,
    analysis: grounding.analysis._id,
    scanCreatedAt: grounding.scan.get("createdAt") as Date | undefined,
    analysisCreatedAt: grounding.analysis.get("createdAt") as Date | undefined,
    contextVersion: context.version,
    truncated: context.truncated,
    counts: context.counts,
    coverage: context.coverage,
    focusTerms: context.focus?.terms ?? [],
    focusFiles: context.focus?.files.map((f) => f.path) ?? [],
    fitting: context.budget ?? null,
    impact: impact
      ? {
          file: impact.file,
          inGraph: impact.inGraph,
          maxDepth: impact.bounds.maxDepth,
          maxNodes: impact.bounds.maxNodes,
          directDependencies: impact.totals.directDependencies,
          directDependents: impact.totals.directDependents,
          transitiveDependentsShown: impact.transitiveDependents.length,
          truncated: impact.truncated,
        }
      : null,
  };
}

/**
 * The full generate workflow: auth/ownership are the caller's
 * responsibility (controller), everything else — prompting, parsing,
 * validating, and persisting only if valid — happens here. Never saves an
 * invalid plan, and never marks a freshly generated plan as approved.
 */
export async function generatePlan(
  ownerId: string,
  projectId: string,
  requirementId: string,
  scanId?: string,
  impactFile?: string,
): Promise<PlanDocument> {
  const project = await getProjectForOwner(ownerId, projectId);
  const requirement = await getOwnedRequirementInProject(ownerId, projectId, requirementId);
  // Batch C5: resolved BEFORE calling the AI, so a bad/foreign/unanalyzed
  // scan fails fast and never costs a model call.
  const grounding = scanId
    ? await loadPlanGrounding(ownerId, projectId, scanId, undefined, {
        title: requirement.title,
        description: requirement.description,
      })
    : null;

  if (impactFile && !grounding) {
    throw new AppError("impactFile requires scanId", 400);
  }
  const impact = grounding && impactFile ? impactFor(grounding, impactFile, IMPACT_PLANNING_BOUNDS) : null;
  const promptFor = (projectEvidence: string | undefined) =>
    buildPlanningPrompt({
      projectName: project.name,
      requirementTitle: requirement.title,
      requirementDescription: requirement.description,
      projectEvidence,
    });

  // Stage 12 (ADR-027): a grounded prompt is fitted to the model's budget
  // deterministically; if even the minimum safe context can't fit, refuse
  // here — before any AI call — rather than truncate silently.
  let prompt: string;
  let shownContext: PlanningContext | null = null;
  if (grounding) {
    const categories = new Map(grounding.graph.nodes.map((n) => [n.id, n.category]));
    const impactText = impact ? renderImpactForPrompt(impact, (f) => categories.get(f)) : "";
    const budgetTokens = maxPromptTokens(env.OLLAMA_NUM_CTX) - FIT_SAFETY_MARGIN_TOKENS;
    const fit = fitPlanningContext({
      build: (limits, priorityFiles) =>
        buildPlanningContext({
          scanId: grounding.scan._id.toString(),
          analysisId: grounding.analysis._id.toString(),
          items: grounding.scan.items,
          graph: grounding.graph,
          requirement: { title: requirement.title, description: requirement.description },
          limitsReached: grounding.scan.summary?.limitsReached ?? [],
          limits,
          priorityFiles,
        }),
      render: (ctx) => promptFor(`${renderPlanningContext(ctx)}${impactText ? `\n\n${impactText}` : ""}`),
      estimateTokens: estimatePromptTokens,
      budgetTokens,
      priorityFiles: impact ? impactPriority(impact) : undefined,
    });
    if (!fit.fits) {
      throw new AppError(
        `Even the smallest safe planning context (~${fit.budget.estimatedTokensAfter} tokens, estimated) exceeds the prompt budget (${budgetTokens} tokens) for OLLAMA_NUM_CTX=${env.OLLAMA_NUM_CTX}. Increase OLLAMA_NUM_CTX, shorten the requirement, or plan without scan grounding.`,
        422,
      );
    }
    prompt = fit.prompt;
    shownContext = fit.context;
  } else {
    prompt = promptFor(undefined);
  }

  const provider = getAIProvider();
  const startedAt = Date.now();
  let raw: string;
  try {
    raw = await provider.complete(prompt);
  } catch (err) {
    if (err instanceof AIProviderError) {
      if (err.code === "context_overflow") {
        // Not a provider outage: this request's evidence is too large for
        // the configured OLLAMA_NUM_CTX. Nothing was sent to the model.
        throw new AppError(
          "The planning context is too large for the AI model's configured context window (OLLAMA_NUM_CTX). Increase it, or generate the plan without scan grounding.",
          422,
        );
      }
      const status = err.code === "invalid_response" ? 502 : 503;
      throw new AppError(
        err.code === "timeout"
          ? "The AI provider took too long to respond. Please try again."
          : "The AI provider is currently unavailable. You can still create requirements and tasks manually.",
        status,
      );
    }
    logger.error({ err }, "Unexpected error calling AI provider");
    throw new AppError("The AI provider is currently unavailable. Please try again later.", 503);
  }
  const durationMs = Date.now() - startedAt;

  if (raw.length > MAX_RAW_RESPONSE_CHARS) {
    throw new AppError("The AI provider's response was unexpectedly large and was rejected.", 502);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new AppError("The AI provider returned a response that could not be parsed.", 502);
  }

  const validation = validateAIPlan(parsedJson);
  if (!validation.valid || !validation.plan) {
    // Deliberately not persisted — "do not silently save invalid plans."
    // The issues are still surfaced to the caller so the user understands
    // why generation failed (and can retry, or fall back to manual planning).
    throw new AppError(
      `The AI-generated plan failed validation: ${validation.issues.map((i) => i.message).join("; ")}`,
      422,
    );
  }

  const plan = validation.plan;
  return Plan.create({
    project: projectId,
    owner: ownerId,
    requirement: requirementId,
    status: "needs_review",
    title: plan.title,
    summary: plan.summary,
    assumptions: plan.assumptions,
    risks: plan.risks,
    suggestedTasks: withFileEvidence(
      plan.suggestedTasks,
      grounding ? evidenceSourceFor(grounding, impact) : null,
    ),
    suggestedOrder: validation.suggestedOrder,
    sourceContext: grounding && shownContext ? sourceContextFor(grounding, shownContext, impact) : null,
    validation: { valid: true, errors: [] },
    aiMeta: {
      provider: env.AI_PROVIDER,
      model: env.OLLAMA_MODEL,
      generatedAt: new Date(),
      durationMs,
    },
  });
}

export async function listPlansForProject(ownerId: string, projectId: string): Promise<PlanDocument[]> {
  await getProjectForOwner(ownerId, projectId);
  return Plan.find({ project: projectId, owner: ownerId }).sort({ createdAt: -1 });
}

/** Same 404-for-both anti-enumeration pattern used everywhere else in this app. */
export async function getPlanForOwner(ownerId: string, planId: string): Promise<PlanDocument> {
  requireValidObjectId(planId, "plan id");
  const plan = await Plan.findOne({ _id: planId, owner: ownerId });
  if (!plan) {
    throw new AppError("Plan not found", 404);
  }
  return plan;
}

export async function updatePlanForOwner(
  ownerId: string,
  planId: string,
  input: UpdatablePlanFields,
): Promise<PlanDocument> {
  const plan = await getPlanForOwner(ownerId, planId);
  if (plan.status !== "needs_review") {
    throw new AppError("This plan has already been reviewed and can no longer be edited", 409);
  }

  const updates: Partial<Pick<PlanDocument, "title" | "summary" | "assumptions" | "risks">> & {
    suggestedTasks?: SuggestedTask[];
    suggestedOrder?: string[];
  } = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.summary !== undefined) updates.summary = input.summary;
  if (input.assumptions !== undefined) updates.assumptions = input.assumptions;
  if (input.risks !== undefined) updates.risks = input.risks;

  if (input.suggestedTasks !== undefined) {
    const { issues, suggestedOrder } = validateSuggestedTasksGraph(input.suggestedTasks);
    if (issues.length > 0) {
      throw new AppError(
        `The edited plan failed validation: ${issues.map((i) => i.message).join("; ")}`,
        422,
      );
    }
    // Re-checked against the SAME scan + analysis the plan was generated
    // from, so an edit can't make a proposed file look verified.
    let source: AffectedFileEvidenceSource | null = null;
    if (plan.sourceContext) {
      const grounding = await loadPlanGrounding(
        ownerId,
        plan.project.toString(),
        plan.sourceContext.scan.toString(),
        plan.sourceContext.analysis.toString(),
      );
      const pinned = plan.sourceContext.impact;
      const impact = pinned
        ? impactFor(grounding, pinned.file, { maxDepth: pinned.maxDepth, maxNodes: pinned.maxNodes })
        : null;
      source = evidenceSourceFor(grounding, impact);
    }
    updates.suggestedTasks = withFileEvidence(input.suggestedTasks, source);
    updates.suggestedOrder = suggestedOrder;
  }

  // Conditional on status, so an edit can never land after a concurrent
  // approval/rejection claimed the plan (the check above is only a fast path).
  const updated = await Plan.findOneAndUpdate(
    { _id: planId, owner: ownerId, status: "needs_review" },
    updates,
    { new: true, runValidators: true },
  );
  if (!updated) {
    throw await reviewConflictError(
      ownerId,
      planId,
      "This plan has already been reviewed and can no longer be edited",
    );
  }
  return updated;
}

/** After a conditional update matched nothing: was the plan gone, or already reviewed? */
async function reviewConflictError(ownerId: string, planId: string, message: string): Promise<AppError> {
  const exists = await Plan.exists({ _id: planId, owner: ownerId });
  return exists ? new AppError(message, 409) : new AppError("Plan not found", 404);
}

/**
 * Atomically moves a plan out of "needs_review". Exactly one concurrent
 * caller can win: the filter only matches while the status is still
 * "needs_review" (Stage 1 — a read-then-save let three simultaneous
 * approvals all succeed).
 */
async function claimForReview(
  ownerId: string,
  planId: string,
  status: "approved" | "rejected",
): Promise<PlanDocument> {
  requireValidObjectId(planId, "plan id");
  const filter: Record<string, unknown> = { _id: planId, owner: ownerId, status: "needs_review" };
  // Last line of defence: an invalid plan is never approvable (they are
  // never persisted, so this should be unreachable).
  if (status === "approved") filter["validation.valid"] = true;
  const claimed = await Plan.findOneAndUpdate(
    filter,
    { $set: { status, reviewedAt: new Date() } },
    { new: true },
  );
  if (claimed) return claimed;

  const current = await Plan.findOne({ _id: planId, owner: ownerId });
  if (!current) throw new AppError("Plan not found", 404);
  if (current.status !== "needs_review") throw new AppError("This plan has already been reviewed", 409);
  throw new AppError("This plan did not pass validation and cannot be approved", 422);
}

export async function rejectPlanForOwner(ownerId: string, planId: string): Promise<PlanDocument> {
  // Only the status and review time change; the plan's evidence stays as reviewed.
  return claimForReview(ownerId, planId, "rejected");
}

type PlanTask = PlanDocument["suggestedTasks"][number];

/**
 * A detached, plain copy of one plan task's evidence for its Task. Built
 * field by field from the plan as reviewed — never re-derived — so the
 * task can't share references with the plan document, and a field
 * that was absent (e.g. no `change` claimed) stays absent.
 */
function snapshotTaskEvidence(plan: PlanDocument, task: PlanTask) {
  const sc = plan.sourceContext;
  return {
    plan: plan._id,
    tempId: task.tempId,
    rationale: task.rationale ?? "",
    testingApproach: task.testingApproach ?? "",
    affectedFiles: task.affectedFiles.map((f) => ({
      path: f.path,
      reason: f.reason,
      evidence: f.evidence,
      ...(f.change ? { change: f.change } : {}),
      ...(f.dependentsCount != null ? { dependentsCount: f.dependentsCount } : {}),
      ...(f.dependenciesCount != null ? { dependenciesCount: f.dependenciesCount } : {}),
      ...(f.conflict ? { conflict: f.conflict } : {}),
      ...(f.impactRelation ? { impactRelation: f.impactRelation } : {}),
      ...(f.evidenceNote ? { evidenceNote: f.evidenceNote } : {}),
    })),
    sourceContext: sc
      ? {
          scan: sc.scan,
          analysis: sc.analysis,
          contextVersion: sc.contextVersion,
          impactFile: sc.impact?.file ?? null,
        }
      : null,
  };
}

/**
 * Materializes an approved plan's suggestedTasks into real Task documents,
 * resolving tempId dependsOn references to real ObjectIds. Two passes:
 * create every task first (to learn each tempId's real _id), then wire up
 * `dependencies` on each. Not wrapped in a MongoDB transaction — this
 * single-node deployment doesn't run a replica set, so multi-document
 * transactions aren't available; safe without one here because the
 * resulting real-id graph is structurally identical (an isomorphic
 * relabeling) to the tempId graph already validated as acyclic at
 * generation time, so there's no scenario where materialization itself
 * could introduce a defect the earlier validation didn't already rule out.
 */
export async function approvePlanForOwner(
  ownerId: string,
  planId: string,
): Promise<{ plan: PlanDocument; createdTasks: InstanceType<typeof Task>[] }> {
  // Claim first (atomic), so concurrent approvals/rejections can't both
  // proceed; only the winner materializes tasks.
  const plan = await claimForReview(ownerId, planId, "approved");

  // C5.1: each task keeps a copy of its evidence as it stands on the
  // reviewed plan. Copied, never re-derived: approval does no
  // rescan/reanalysis and cannot create evidence the plan didn't have.
  const tempIdToRealId = new Map<string, string>();
  try {
    // The claim above only succeeds from "needs_review", so any task that
    // already points at this plan is a leftover of an earlier approval
    // whose cleanup failed. Remove it so a plan never ends up with two
    // task sets.
    await Task.deleteMany({ "planEvidence.plan": plan._id, owner: ownerId });
    for (const suggested of plan.suggestedTasks) {
      const task = await Task.create({
        project: plan.project,
        owner: ownerId,
        requirement: plan.requirement,
        title: suggested.title,
        description: suggested.description,
        acceptanceCriteria: suggested.acceptanceCriteria,
        priority: suggested.priority,
        planEvidence: snapshotTaskEvidence(plan, suggested),
      });
      tempIdToRealId.set(suggested.tempId, task._id.toString());
    }

    for (const suggested of plan.suggestedTasks) {
      if (suggested.dependsOn.length === 0) continue;
      const realId = tempIdToRealId.get(suggested.tempId);
      const dependencyIds = suggested.dependsOn.map((tempId) => tempIdToRealId.get(tempId));
      await Task.updateOne({ _id: realId, owner: ownerId }, { $set: { dependencies: dependencyIds } });
    }
  } catch (err) {
    // No multi-document transactions on this single-node deployment, so
    // compensate: remove what was created and release the claim, leaving
    // the plan reviewable again instead of "approved" with missing tasks.
    // Each step is best-effort and independent — a failing cleanup must
    // neither skip releasing the claim nor replace the original error.
    // Anything left behind is removed by the next approval (see above).
    try {
      await Task.deleteMany({ _id: { $in: [...tempIdToRealId.values()] }, owner: ownerId });
    } catch (cleanupErr) {
      logger.error(
        { err: cleanupErr, planId: plan._id.toString() },
        "Approval cleanup: could not remove partial tasks",
      );
    }
    try {
      await Plan.updateOne(
        { _id: plan._id, owner: ownerId, status: "approved" },
        { $set: { status: "needs_review", reviewedAt: null } },
      );
    } catch (releaseErr) {
      logger.error(
        { err: releaseErr, planId: plan._id.toString() },
        "Approval cleanup: could not release the review claim",
      );
    }
    throw err;
  }

  // Re-fetch rather than returning the documents collected during the
  // first pass above — those predate the second pass's dependency writes,
  // so returning them directly would silently omit `dependencies` from
  // the response even though it was persisted correctly.
  const createdTasks = await Task.find({ _id: { $in: [...tempIdToRealId.values()] } });

  return { plan, createdTasks };
}

export async function checkAIProviderStatus(): Promise<{
  available: boolean;
  provider: string;
  model: string;
}> {
  const available = await getAIProvider().checkAvailability();
  return { available, provider: env.AI_PROVIDER, model: env.OLLAMA_MODEL };
}
