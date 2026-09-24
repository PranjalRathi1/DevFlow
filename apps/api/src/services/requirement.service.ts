import { Requirement, type RequirementDocument } from "../models/Requirement.js";
import { Task } from "../models/Task.js";
import { AppError } from "../utils/AppError.js";
import { getProjectForOwner, requireValidObjectId } from "./project.service.js";
import type {
  CreateRequirementInput,
  ListRequirementsQuery,
  UpdateRequirementInput,
} from "../validators/requirement.validators.js";

export async function createRequirement(
  ownerId: string,
  projectId: string,
  input: CreateRequirementInput,
): Promise<RequirementDocument> {
  await getProjectForOwner(ownerId, projectId); // 404s if the project isn't the caller's
  return Requirement.create({ ...input, project: projectId, owner: ownerId });
}

export async function listRequirementsForProject(
  ownerId: string,
  projectId: string,
  query: ListRequirementsQuery,
): Promise<RequirementDocument[]> {
  await getProjectForOwner(ownerId, projectId);
  const filter: Record<string, unknown> = { project: projectId, owner: ownerId };
  if (query.status) filter.status = query.status;
  return Requirement.find(filter).sort({ createdAt: -1 });
}

/** Same 404-for-both anti-enumeration pattern as project.service.ts. */
export async function getRequirementForOwner(
  ownerId: string,
  requirementId: string,
): Promise<RequirementDocument> {
  requireValidObjectId(requirementId, "requirement id");
  const requirement = await Requirement.findOne({ _id: requirementId, owner: ownerId });
  if (!requirement) {
    throw new AppError("Requirement not found", 404);
  }
  return requirement;
}

export async function updateRequirementForOwner(
  ownerId: string,
  requirementId: string,
  input: UpdateRequirementInput,
): Promise<RequirementDocument> {
  requireValidObjectId(requirementId, "requirement id");
  const requirement = await Requirement.findOneAndUpdate({ _id: requirementId, owner: ownerId }, input, {
    new: true,
    runValidators: true,
  });
  if (!requirement) {
    throw new AppError("Requirement not found", 404);
  }
  return requirement;
}

/**
 * Deleting a requirement doesn't delete the tasks that reference it — it
 * clears their `requirement` field (a task's identity/status isn't
 * conceptually owned by the requirement the way a subtask is owned by its
 * parent task). See docs/DECISIONS.md.
 */
export async function deleteRequirementForOwner(ownerId: string, requirementId: string): Promise<void> {
  requireValidObjectId(requirementId, "requirement id");
  const result = await Requirement.deleteOne({ _id: requirementId, owner: ownerId });
  if (result.deletedCount === 0) {
    throw new AppError("Requirement not found", 404);
  }
  await Task.updateMany({ requirement: requirementId, owner: ownerId }, { $set: { requirement: null } });
}
