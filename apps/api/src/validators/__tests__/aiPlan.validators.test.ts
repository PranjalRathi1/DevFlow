import { describe, expect, it } from "vitest";
import { validateAIPlan } from "../aiPlan.validators.js";

function validPlan(overrides: Record<string, unknown> = {}) {
  return {
    title: "Add authentication",
    summary: "Implement JWT-based login and registration.",
    assumptions: ["Users have email addresses"],
    risks: ["Password reset flow not covered"],
    suggestedTasks: [
      { tempId: "t1", title: "Design user schema", dependsOn: [] },
      { tempId: "t2", title: "Implement login endpoint", dependsOn: ["t1"] },
    ],
    ...overrides,
  };
}

describe("validateAIPlan", () => {
  it("accepts a well-formed plan and computes a topological order", () => {
    const result = validateAIPlan(validPlan());
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.suggestedOrder).toEqual(["t1", "t2"]);
  });

  it("fills in defaults for optional fields", () => {
    const result = validateAIPlan(validPlan());
    expect(result.plan?.suggestedTasks[0]?.priority).toBe("medium");
    expect(result.plan?.suggestedTasks[0]?.description).toBe("");
  });

  it("rejects completely malformed input", () => {
    const result = validateAIPlan("this is not even an object");
    expect(result.valid).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.issues[0]?.type).toBe("schema");
  });

  it("rejects a missing required field (title)", () => {
    const { title: _omit, ...rest } = validPlan();
    const result = validateAIPlan(rest);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "schema")).toBe(true);
  });

  it("rejects an empty suggestedTasks array", () => {
    const result = validateAIPlan(validPlan({ suggestedTasks: [] }));
    expect(result.valid).toBe(false);
  });

  it("rejects an invalid priority enum value", () => {
    const result = validateAIPlan(
      validPlan({ suggestedTasks: [{ tempId: "t1", title: "x", priority: "urgent!!", dependsOn: [] }] }),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects duplicate temporary task ids", () => {
    const result = validateAIPlan(
      validPlan({
        suggestedTasks: [
          { tempId: "t1", title: "First", dependsOn: [] },
          { tempId: "t1", title: "Second", dependsOn: [] },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "duplicate_temp_id")).toBe(true);
  });

  it("rejects a self-dependency", () => {
    const result = validateAIPlan(
      validPlan({ suggestedTasks: [{ tempId: "t1", title: "x", dependsOn: ["t1"] }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "self_dependency")).toBe(true);
  });

  it("rejects a dependency referencing a missing tempId", () => {
    const result = validateAIPlan(
      validPlan({ suggestedTasks: [{ tempId: "t1", title: "x", dependsOn: ["ghost"] }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "missing_dependency")).toBe(true);
  });

  it("rejects a cyclic dependency graph", () => {
    const result = validateAIPlan(
      validPlan({
        suggestedTasks: [
          { tempId: "t1", title: "A", dependsOn: ["t2"] },
          { tempId: "t2", title: "B", dependsOn: ["t1"] },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "cycle")).toBe(true);
  });

  it("rejects a plan exceeding the maximum task count", () => {
    const suggestedTasks = Array.from({ length: 31 }, (_, i) => ({
      tempId: `t${i}`,
      title: `Task ${i}`,
      dependsOn: [],
    }));
    const result = validateAIPlan(validPlan({ suggestedTasks }));
    expect(result.valid).toBe(false);
  });

  it("does not silently accept a plan with any issue — valid is always false if issues exist", () => {
    const result = validateAIPlan(
      validPlan({ suggestedTasks: [{ tempId: "t1", title: "x", dependsOn: ["t1", "ghost"] }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("validateAIPlan — affected files and rationale (Batch C5)", () => {
  function withFiles(affectedFiles: unknown) {
    return validPlan({
      suggestedTasks: [{ tempId: "t1", title: "Edit", dependsOn: [], rationale: "Because", affectedFiles }],
    });
  }

  it("defaults rationale and affectedFiles for a pre-C5-shaped plan", () => {
    const result = validateAIPlan(validPlan());
    expect(result.plan?.suggestedTasks[0]).toMatchObject({ rationale: "", affectedFiles: [] });
  });

  it("normalizes backslashes and leading ./ in proposed paths", () => {
    const result = validateAIPlan(withFiles([{ path: ".\\src\\a.ts" }, { path: "./src/b.ts", reason: "x" }]));
    expect(result.valid).toBe(true);
    expect(result.plan?.suggestedTasks[0]?.affectedFiles).toEqual([
      { path: "src/a.ts", reason: "" },
      { path: "src/b.ts", reason: "x" },
    ]);
  });

  it.each([
    ["/etc/passwd"],
    ["C:/Windows/system.ini"],
    ["c:\\x.ts"],
    ["..\\outside.ts"],
    ["../outside.ts"],
    ["src/../../x.ts"],
    [""],
  ])("rejects an unsafe or empty path: %j", (p) => {
    const result = validateAIPlan(withFiles([{ path: p }]));
    expect(result.valid).toBe(false);
    expect(result.issues.every((i) => i.type === "schema")).toBe(true);
  });

  it("strips an AI-supplied evidence claim — existence is computed server-side only", () => {
    const result = validateAIPlan(
      withFiles([{ path: "src/a.ts", evidence: "in_scan", dependentsCount: 99 }]),
    );
    expect(result.plan?.suggestedTasks[0]?.affectedFiles).toEqual([{ path: "src/a.ts", reason: "" }]);
  });

  it("caps affected files per task", () => {
    const files = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.ts` }));
    expect(validateAIPlan(withFiles(files)).valid).toBe(false);
  });
});
