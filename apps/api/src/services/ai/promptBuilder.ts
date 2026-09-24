export interface PlanningContext {
  projectName: string;
  requirementTitle: string;
  requirementDescription: string;
  /**
   * Batch C5: the rendered, bounded scan evidence
   * (lib/planningContext.ts#renderPlanningContext). Omitted for a plan not
   * grounded in a scan — the prompt then says no codebase evidence exists.
   */
  projectEvidence?: string | undefined;
}

/**
 * Builds a controlled prompt instructing the model to emit exactly the
 * JSON shape `aiPlanSchema` (validators/aiPlan.validators.ts) expects. The
 * AI's raw output is still fully re-validated on the way back — this
 * prompt shapes the request, it isn't trusted to guarantee the response.
 */
export function buildPlanningPrompt(context: PlanningContext): string {
  return `You are an engineering planning assistant. Break the following requirement into a structured, dependency-aware task plan.

Project: ${context.projectName}
Requirement: ${context.requirementTitle}
Description: ${context.requirementDescription || "(no additional description provided)"}

${context.projectEvidence ?? "No scan of the codebase was provided. You have NO verified information about its files or dependencies; any file path you mention is unverified."}

Respond with ONLY a single JSON object (no markdown, no commentary) matching exactly this shape:

{
  "title": string (short plan title),
  "summary": string (1-3 sentences),
  "assumptions": string[] (things you assumed, may be empty),
  "risks": string[] (technical risks, may be empty),
  "suggestedTasks": [
    {
      "tempId": string (short unique id you choose, e.g. "t1", "t2"),
      "title": string,
      "description": string,
      "acceptanceCriteria": string[],
      "priority": "low" | "medium" | "high" | "critical",
      "dependsOn": string[] (tempIds of tasks that must be done first, may be empty),
      "rationale": string (why this task is needed, citing the evidence above where it applies),
      "affectedFiles": [ { "path": string (project-relative, forward slashes), "reason": string } ] (may be empty)
    }
  ]
}

Rules:
- Every "dependsOn" value must be a "tempId" that also appears in "suggestedTasks".
- Do not make a task depend on itself.
- Do not create circular dependencies (if A depends on B, B must not depend on A, directly or indirectly).
- Produce at most 20 tasks.
- For an existing file, use its exact path from the scan inventory. Any path not in the inventory is recorded as a proposed NEW file, not an existing one.
- Never claim a dependency between files unless it is listed as a confirmed internal dependency. Unresolved, external, and unsupported imports are not confirmed dependencies.
- Never use absolute paths or ".." in file paths.
- Output ONLY the JSON object, nothing else.`;
}
