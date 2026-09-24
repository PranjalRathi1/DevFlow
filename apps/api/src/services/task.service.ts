import { Task, type TaskDocument } from "../models/Task.js";
import { Requirement } from "../models/Requirement.js";
import { AppError } from "../utils/AppError.js";
import { getProjectForOwner, requireValidObjectId } from "./project.service.js";
import type { CreateTaskInput, ListTasksQuery, UpdateTaskInput } from "../validators/task.validators.js";

/** Confirms a requirement reference exists, is owned by the caller, and belongs to the given project. */
async function assertRequirementInProject(
  ownerId: string,
  projectId: string,
  requirementId: string,
): Promise<void> {
  const requirement = await Requirement.findOne({ _id: requirementId, owner: ownerId, project: projectId });
  if (!requirement) {
    throw new AppError("Requirement reference is invalid or belongs to a different project", 400);
  }
}

/** Confirms a parent-task reference exists, is owned by the caller, and belongs to the given project. */
async function assertParentTaskInProject(
  ownerId: string,
  projectId: string,
  parentTaskId: string,
): Promise<void> {
  const parent = await Task.findOne({ _id: parentTaskId, owner: ownerId, project: projectId });
  if (!parent) {
    throw new AppError("Parent task reference is invalid or belongs to a different project", 400);
  }
}

// Hard cap on top of the visited-set check below — the set already
// guarantees termination (it can't grow past the number of tasks that
// exist), but this bounds worst-case traversal cost explicitly rather
// than relying solely on that reasoning.
const MAX_ANCESTOR_HOPS = 1000;

/**
 * Walks upward from `proposedParentId` via `parentTask` links, rejecting
 * the reparent if that walk ever reaches `taskId` — i.e. rejects any cycle
 * of any length, not just direct self-parenting (which is checked
 * separately, before this even runs). Only meaningful on update: a task
 * being created can't yet be any existing task's ancestor, so no walk is
 * needed there (see the two call sites in assertReferences below).
 *
 * The visited set also makes this safe against a pre-existing cycle
 * already present in stored data (shouldn't happen, since every write
 * goes through this check, but avoids an infinite loop if it ever does).
 */
async function assertNoCycle(ownerId: string, proposedParentId: string, taskId: string): Promise<void> {
  const visited = new Set<string>();
  let currentId: string | null = proposedParentId;
  let hops = 0;

  while (currentId) {
    if (currentId === taskId) {
      throw new AppError("This parent assignment would create a cycle in the task hierarchy", 400);
    }
    if (visited.has(currentId) || ++hops > MAX_ANCESTOR_HOPS) {
      break;
    }
    visited.add(currentId);

    const parent: Pick<TaskDocument, "parentTask"> | null = await Task.findOne({
      _id: currentId,
      owner: ownerId,
    }).select("parentTask");
    currentId = parent?.parentTask ? parent.parentTask.toString() : null;
  }
}

async function assertReferences(
  ownerId: string,
  projectId: string,
  input: { requirementId?: string | null | undefined; parentTaskId?: string | null | undefined },
  selfId?: string,
): Promise<void> {
  if (input.requirementId) {
    await assertRequirementInProject(ownerId, projectId, input.requirementId);
  }
  if (input.parentTaskId) {
    if (selfId && input.parentTaskId === selfId) {
      throw new AppError("A task cannot be its own parent", 400);
    }
    await assertParentTaskInProject(ownerId, projectId, input.parentTaskId);
    if (selfId) {
      await assertNoCycle(ownerId, input.parentTaskId, selfId);
    }
  }
}

function toDocumentFields(input: CreateTaskInput | UpdateTaskInput) {
  const { requirementId, parentTaskId, ...rest } = input;
  const fields: Record<string, unknown> = { ...rest };
  if (requirementId !== undefined) fields.requirement = requirementId;
  if (parentTaskId !== undefined) fields.parentTask = parentTaskId;
  return fields;
}

export async function createTask(
  ownerId: string,
  projectId: string,
  input: CreateTaskInput,
): Promise<TaskDocument> {
  await getProjectForOwner(ownerId, projectId);
  await assertReferences(ownerId, projectId, input);
  return Task.create({ ...toDocumentFields(input), project: projectId, owner: ownerId });
}

export async function listTasksForProject(
  ownerId: string,
  projectId: string,
  query: ListTasksQuery,
): Promise<TaskDocument[]> {
  await getProjectForOwner(ownerId, projectId);
  const filter: Record<string, unknown> = { project: projectId, owner: ownerId };
  if (query.status) filter.status = query.status;
  if (query.priority) filter.priority = query.priority;
  if (query.requirementId) filter.requirement = query.requirementId;
  if (query.parentTaskId === "none") {
    filter.parentTask = null;
  } else if (query.parentTaskId) {
    filter.parentTask = query.parentTaskId;
  }
  if (query.search) {
    filter.title = { $regex: escapeRegExp(query.search), $options: "i" };
  }
  return Task.find(filter).sort({ createdAt: -1 });
}

export async function getTaskForOwner(ownerId: string, taskId: string): Promise<TaskDocument> {
  requireValidObjectId(taskId, "task id");
  const task = await Task.findOne({ _id: taskId, owner: ownerId });
  if (!task) {
    throw new AppError("Task not found", 404);
  }
  return task;
}

export async function updateTaskForOwner(
  ownerId: string,
  taskId: string,
  input: UpdateTaskInput,
): Promise<TaskDocument> {
  requireValidObjectId(taskId, "task id");
  const existing = await Task.findOne({ _id: taskId, owner: ownerId });
  if (!existing) {
    throw new AppError("Task not found", 404);
  }
  await assertReferences(ownerId, existing.project.toString(), input, taskId);

  const updated = await Task.findOneAndUpdate({ _id: taskId, owner: ownerId }, toDocumentFields(input), {
    new: true,
    runValidators: true,
  });
  // existing was just confirmed present; a concurrent delete between the
  // two queries is the only way this could be null.
  if (!updated) {
    throw new AppError("Task not found", 404);
  }
  return updated;
}

/**
 * Deleting a task cascades to its full subtask subtree (BFS over
 * parentTask references) rather than leaving orphaned subtasks pointing at
 * a deleted parent — see docs/DECISIONS.md.
 */
export async function deleteTaskForOwner(ownerId: string, taskId: string): Promise<void> {
  requireValidObjectId(taskId, "task id");

  const idsToDelete: string[] = [taskId];
  let frontier = [taskId];
  while (frontier.length > 0) {
    const children = await Task.find({ parentTask: { $in: frontier }, owner: ownerId }).select("_id");
    const childIds = children.map((c) => c._id.toString());
    if (childIds.length === 0) break;
    idsToDelete.push(...childIds);
    frontier = childIds;
  }

  const result = await Task.deleteMany({ _id: { $in: idsToDelete }, owner: ownerId });
  if (result.deletedCount === 0) {
    throw new AppError("Task not found", 404);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
