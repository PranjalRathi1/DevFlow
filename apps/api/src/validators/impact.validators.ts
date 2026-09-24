import { z } from "zod";
import { proposedPathSchema } from "./aiPlan.validators.js";
import { IMPACT_LIMITS } from "../lib/impactAnalysis.js";

// `file` reuses the same path rules as AI-proposed paths: project-relative,
// "\\" -> "/", leading "./" stripped; absolute, drive-letter and ".." paths
// rejected (400) — never clamped into something else.
export const impactQuerySchema = z.object({
  file: proposedPathSchema,
  maxDepth: z.coerce
    .number()
    .int()
    .min(1)
    .max(IMPACT_LIMITS.maxMaxDepth)
    .default(IMPACT_LIMITS.defaultMaxDepth),
  maxNodes: z.coerce
    .number()
    .int()
    .min(1)
    .max(IMPACT_LIMITS.maxMaxNodes)
    .default(IMPACT_LIMITS.defaultMaxNodes),
});
export type ImpactQuery = z.infer<typeof impactQuerySchema>;
