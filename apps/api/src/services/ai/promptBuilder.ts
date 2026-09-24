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

// Batch C5.1 (ADR-021): only meaningful when scan evidence is present.
// Tells the model HOW to use the evidence to pick an integration layer,
// without asking for anything the context doesn't contain.
const GROUNDED_GUIDANCE = `How to plan against this codebase:
- Choose where to implement by following an existing pattern: find a file that already does something similar (see REQUIREMENT FOCUS) and look at which files import it ("imported by"). Implement the new work in that same layer. Do not assume middleware or cross-cutting behaviour belongs in controllers — check where existing middleware is imported.
- For endpoint behaviour, name the route file that imports the controller (see "imports" on route files) as well as any service involved.
- In "rationale", explain why you chose that location and name the existing file whose pattern you follow, citing only relationships listed above. You may quote a line number only if it appears in the context.
- For tests, prefer extending a test file listed as reaching the changed file. If none fits, propose a new test file path; it will be recorded as a proposed new file.
- If the context cannot tell you something (for example how an imported symbol is used at runtime), say so in "assumptions" instead of guessing.
- If a CHANGE IMPACT section is present: its dependents MAY be affected, which does not mean they must change. Only propose changing a dependent when the requirement needs it, and say why. The target's own dependencies are not affected by changing it. If the impact is marked TRUNCATED, say in "risks" that more files may be affected. Prefer test files listed among its dependents.`;

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

${context.projectEvidence ? `${context.projectEvidence}\n\n${GROUNDED_GUIDANCE}` : "No scan of the codebase was provided. You have NO verified information about its files or dependencies; any file path you mention is unverified."}

Respond with ONLY a single JSON object (no markdown, no commentary) matching exactly this shape:

{
  "title": string (short plan title),
  "summary": string (1-3 sentences),
  "assumptions": string[] (at least one: what you assumed that the context does not prove),
  "risks": string[] (at least one: what could go wrong or regress),
  "suggestedTasks": [
    {
      "tempId": string (short unique id you choose, e.g. "t1", "t2"),
      "title": string (specific and actionable),
      "description": string (the objective and exactly what to change),
      "acceptanceCriteria": string[] (verifiable outcomes),
      "priority": "low" | "medium" | "high" | "critical",
      "dependsOn": string[] (tempIds of tasks that must be done first, may be empty),
      "rationale": string (why this task, and why this location),
      "testingApproach": string (test type — unit, integration/API, or frontend — and which test file to extend or create),
      "affectedFiles": [
        {
          "path": string (project-relative, forward slashes),
          "change": "modify" | "create" | "test" | "reference" ("reference" = an existing file whose pattern you follow but do not change),
          "reason": string
        }
      ]
    }
  ]
}

Rules:
- Every "dependsOn" value must be a "tempId" that also appears in "suggestedTasks".
- Do not make a task depend on itself.
- Do not create circular dependencies (if A depends on B, B must not depend on A, directly or indirectly).
- Produce between 3 and 8 tasks, ordered so implementation comes before its tests and documentation. At most 6 affectedFiles per task.
- For an existing file, use its exact path from the scan inventory. Any path not in the inventory is recorded as a proposed NEW file, not an existing one.
- Never claim a dependency between files unless it is listed as a confirmed internal dependency. Unresolved, external, and unsupported imports are not confirmed dependencies.
- Never claim that existing tests already cover the new behaviour, and never describe work as already done.
- Never use absolute paths or ".." in file paths.
- Output ONLY the JSON object, nothing else.`;
}
