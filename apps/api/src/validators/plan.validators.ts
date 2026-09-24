import { z } from "zod";

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid id format");

export const generatePlanSchema = z.object({
  requirementId: objectIdSchema,
  // Batch C5: optional — when given, the plan is grounded in this scan and
  // its latest dependency analysis. Omitted = the pre-C5 behavior.
  scanId: objectIdSchema.optional(),
});
export type GeneratePlanInput = z.infer<typeof generatePlanSchema>;

// The PATCH body schema (title/summary/assumptions/risks/suggestedTasks)
// lives in aiPlan.validators.ts as `updatablePlanFieldsSchema` — reused
// directly rather than duplicated, since it's exactly the same shape.
export { updatablePlanFieldsSchema as updatePlanSchema } from "./aiPlan.validators.js";
