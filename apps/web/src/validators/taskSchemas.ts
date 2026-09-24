import { z } from "zod";
import { PRIORITIES, TASK_STATUSES } from "../types/task";

export const taskFormSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  acceptanceCriteriaText: z.string().trim().max(5000).optional(),
  // "" means "no requirement" — normalized to null before hitting the API.
  requirementId: z.string(),
});
export type TaskFormSchemaValues = z.infer<typeof taskFormSchema>;
