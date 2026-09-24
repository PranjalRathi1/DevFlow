import { z } from "zod";
import { PRIORITIES, REQUIREMENT_STATUSES } from "../types/requirement";

export const requirementFormSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(REQUIREMENT_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  // One acceptance criterion per line — simpler than a dynamic add/remove
  // list for the same result; split into an array on submit.
  acceptanceCriteriaText: z.string().trim().max(5000).optional(),
});
export type RequirementFormSchemaValues = z.infer<typeof requirementFormSchema>;

export function criteriaTextToArray(text?: string): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function criteriaArrayToText(criteria: string[]): string {
  return criteria.join("\n");
}
