import mongoose from "mongoose";
import { Project, type ProjectDocument } from "../models/Project.js";
import { Requirement } from "../models/Requirement.js";
import { Task } from "../models/Task.js";
import { Plan } from "../models/Plan.js";
import { Scan } from "../models/Scan.js";
import { Analysis } from "../models/Analysis.js";
import { AppError } from "../utils/AppError.js";
import type { CreateProjectInput, UpdateProjectInput } from "../validators/project.validators.js";

// Shared by requirement.service.ts / task.service.ts too — every
// project-scoped resource validates its :id the same way.
export function requireValidObjectId(id: string, label = "id"): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`Invalid ${label}`, 400);
  }
}

export async function createProject(ownerId: string, input: CreateProjectInput): Promise<ProjectDocument> {
  return Project.create({ ...input, owner: ownerId });
}

export async function listProjectsForOwner(ownerId: string): Promise<ProjectDocument[]> {
  return Project.find({ owner: ownerId }).sort({ createdAt: -1 });
}

/**
 * Ownership is enforced by the query itself (`owner: ownerId` in the
 * filter), not by fetching the document and checking afterward — a
 * non-owner's request for someone else's project simply matches nothing.
 *
 * Returns 404 for both "doesn't exist" and "exists but isn't yours" —
 * deliberately indistinguishable. A 403 would confirm the ID refers to a
 * real project even to a non-owner, letting them enumerate/probe IDs.
 */
export async function getProjectForOwner(ownerId: string, projectId: string): Promise<ProjectDocument> {
  requireValidObjectId(projectId, "project id");
  const project = await Project.findOne({ _id: projectId, owner: ownerId });
  if (!project) {
    throw new AppError("Project not found", 404);
  }
  return project;
}

export async function updateProjectForOwner(
  ownerId: string,
  projectId: string,
  input: UpdateProjectInput,
): Promise<ProjectDocument> {
  requireValidObjectId(projectId, "project id");
  const project = await Project.findOneAndUpdate({ _id: projectId, owner: ownerId }, input, {
    new: true,
    runValidators: true,
  });
  if (!project) {
    throw new AppError("Project not found", 404);
  }
  return project;
}

/**
 * Deletion strategy (see docs/DECISIONS.md): a project delete cascades to
 * its requirements, tasks, and AI plans (added in Batch B — `Plan` was
 * initially missed here and left orphaned rows behind on project deletion
 * until this was caught during Batch B's own review; see
 * docs/IMPLEMENTATION_LOG.md) rather than leaving any of them orphaned.
 * Projects already have a non-destructive alternative
 * (`status: "archived"`), so an actual DELETE is a deliberate, irreversible
 * action — cascading matches that irreversibility rather than silently
 * leaving unreachable child documents behind. Cascade runs after the
 * project itself is confirmed deleted (ownership already verified by that
 * query), scoped by `owner` again on the child deletes as defense in depth.
 */
export async function deleteProjectForOwner(ownerId: string, projectId: string): Promise<void> {
  requireValidObjectId(projectId, "project id");
  const result = await Project.deleteOne({ _id: projectId, owner: ownerId });
  if (result.deletedCount === 0) {
    throw new AppError("Project not found", 404);
  }
  await Promise.all([
    Requirement.deleteMany({ project: projectId, owner: ownerId }),
    Task.deleteMany({ project: projectId, owner: ownerId }),
    Plan.deleteMany({ project: projectId, owner: ownerId }),
    Scan.deleteMany({ project: projectId, owner: ownerId }),
    Analysis.deleteMany({ project: projectId, owner: ownerId }),
  ]);
}
