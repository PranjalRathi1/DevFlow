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
 * The full generate workflow: auth/ownership are the caller's
 * responsibility (controller), everything else — prompting, parsing,
 * validating, and persisting only if valid — happens here. Never saves an
 * invalid plan, and never marks a freshly generated plan as approved.
 */
export async function generatePlan(
  ownerId: string,
  projectId: string,
  requirementId: string,
): Promise<PlanDocument> {
  const project = await getProjectForOwner(ownerId, projectId);
  const requirement = await getOwnedRequirementInProject(ownerId, projectId, requirementId);

  const prompt = buildPlanningPrompt({
    projectName: project.name,
    requirementTitle: requirement.title,
    requirementDescription: requirement.description,
  });

  const provider = getAIProvider();
  const startedAt = Date.now();
  let raw: string;
  try {
    raw = await provider.complete(prompt);
  } catch (err) {
    if (err instanceof AIProviderError) {
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
    suggestedTasks: plan.suggestedTasks,
    suggestedOrder: validation.suggestedOrder,
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
    updates.suggestedTasks = input.suggestedTasks;
    updates.suggestedOrder = suggestedOrder;
  }

  const updated = await Plan.findOneAndUpdate({ _id: planId, owner: ownerId }, updates, {
    new: true,
    runValidators: true,
  });
  if (!updated) {
    throw new AppError("Plan not found", 404);
  }
  return updated;
}

export async function rejectPlanForOwner(ownerId: string, planId: string): Promise<PlanDocument> {
  const plan = await getPlanForOwner(ownerId, planId);
  if (plan.status !== "needs_review") {
    throw new AppError("This plan has already been reviewed", 409);
  }
  plan.status = "rejected";
  plan.reviewedAt = new Date();
  await plan.save();
  return plan;
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
  const plan = await getPlanForOwner(ownerId, planId);
  if (plan.status !== "needs_review") {
    throw new AppError("This plan has already been reviewed", 409);
  }
  if (!plan.validation?.valid) {
    // Should be unreachable — invalid plans are never saved — but this is
    // the last line of defense before real data is written.
    throw new AppError("This plan did not pass validation and cannot be approved", 422);
  }

  const tempIdToRealId = new Map<string, string>();
  for (const suggested of plan.suggestedTasks) {
    const task = await Task.create({
      project: plan.project,
      owner: ownerId,
      requirement: plan.requirement,
      title: suggested.title,
      description: suggested.description,
      acceptanceCriteria: suggested.acceptanceCriteria,
      priority: suggested.priority,
    });
    tempIdToRealId.set(suggested.tempId, task._id.toString());
  }

  for (const suggested of plan.suggestedTasks) {
    if (suggested.dependsOn.length === 0) continue;
    const realId = tempIdToRealId.get(suggested.tempId);
    const dependencyIds = suggested.dependsOn.map((tempId) => tempIdToRealId.get(tempId));
    await Task.updateOne({ _id: realId, owner: ownerId }, { $set: { dependencies: dependencyIds } });
  }

  plan.status = "approved";
  plan.reviewedAt = new Date();
  await plan.save();

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
