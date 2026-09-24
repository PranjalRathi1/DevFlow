import { z } from "zod";
import { PRIORITIES, TASK_STATUSES } from "../models/Task.js";

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id format");

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  // Format-validated here; "does it actually belong to this project" is
  // checked in task.service.ts, which needs a DB round-trip anyway.
  requirementId: objectIdSchema.nullish(),
  parentTaskId: objectIdSchema.nullish(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = createTaskSchema.partial();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const listTasksQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  requirementId: objectIdSchema.optional(),
  // "none" explicitly lists top-level tasks only (the default list view);
  // an actual id lists that parent's direct subtasks; omitted = both -->
  // see task.service.ts for how each is interpreted.
  parentTaskId: z.union([objectIdSchema, z.literal("none")]).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
