import { z } from "zod";
import { PRIORITIES, REQUIREMENT_STATUSES } from "../models/Requirement.js";

export const createRequirementSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(REQUIREMENT_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
});
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

export const updateRequirementSchema = createRequirementSchema.partial();
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;

export const listRequirementsQuerySchema = z.object({
  status: z.enum(REQUIREMENT_STATUSES).optional(),
});
export type ListRequirementsQuery = z.infer<typeof listRequirementsQuerySchema>;
