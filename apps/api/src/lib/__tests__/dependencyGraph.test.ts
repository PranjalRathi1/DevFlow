import { describe, expect, it } from "vitest";
import {
  getBlockedTasks,
  getDependencies,
  getDependents,
  getReadyTasks,
  topologicalSort,
  validateGraph,
  type DependencyGraph,
} from "../dependencyGraph.js";

function graph(nodes: string[], edges: [string, string][]): DependencyGraph {
  return { nodes, edges: edges.map(([from, to]) => ({ from, to })) };
}

describe("validateGraph", () => {
  it("accepts an empty graph", () => {
    expect(validateGraph(graph([], []))).toEqual({ valid: true, errors: [] });
  });

  it("accepts a single task with no edges", () => {
    expect(validateGraph(graph(["A"], []))).toEqual({ valid: true, errors: [] });
  });

  it("accepts a linear dependency chain", () => {
    // A depends on B depends on C
    expect(
      validateGraph(
        graph(
          ["A", "B", "C"],
          [
            ["A", "B"],
            ["B", "C"],
          ],
        ),
      ).valid,
    ).toBe(true);
  });

  it("accepts branching dependencies (one task depended on by many)", () => {
    // B and C both depend on A
    expect(
      validateGraph(
        graph(
          ["A", "B", "C"],
          [
            ["B", "A"],
            ["C", "A"],
          ],
        ),
      ).valid,
    ).toBe(true);
  });

  it("accepts merging dependencies (one task depending on many)", () => {
    // A depends on both B and C
    expect(
      validateGraph(
        graph(
          ["A", "B", "C"],
          [
            ["A", "B"],
            ["A", "C"],
          ],
        ),
      ).valid,
    ).toBe(true);
  });

  it("accepts independent tasks with no edges between them", () => {
    expect(validateGraph(graph(["A", "B", "C"], [])).valid).toBe(true);
  });

  it("rejects a self-dependency", () => {
    const result = validateGraph(graph(["A"], [["A", "A"]]));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({ type: "self_dependency", taskId: "A" });
  });

  it("rejects a duplicate edge", () => {
    const result = validateGraph(
      graph(
        ["A", "B"],
        [
          ["A", "B"],
          ["A", "B"],
        ],
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({ type: "duplicate_edge", from: "A", to: "B" });
  });

  it("rejects an edge referencing a missing node", () => {
    const result = validateGraph(graph(["A"], [["A", "GHOST"]]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "missing_node" && e.taskId === "GHOST")).toBe(true);
  });

  it("rejects a two-node cycle", () => {
    const result = validateGraph(
      graph(
        ["A", "B"],
        [
          ["A", "B"],
          ["B", "A"],
        ],
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "cycle")).toBe(true);
  });

  it("rejects a multi-node cycle", () => {
    const result = validateGraph(
      graph(
        ["A", "B", "C", "D"],
        [
          ["A", "B"],
          ["B", "C"],
          ["C", "D"],
          ["D", "A"],
        ],
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "cycle")).toBe(true);
  });
});

describe("topologicalSort", () => {
  it("returns [] for an empty graph", () => {
    expect(topologicalSort(graph([], []))).toEqual([]);
  });

  it("orders a linear chain with dependencies before dependents", () => {
    // A depends on B depends on C -> C, B, A
    const order = topologicalSort(
      graph(
        ["A", "B", "C"],
        [
          ["A", "B"],
          ["B", "C"],
        ],
      ),
    ) as string[];
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
  });

  it("produces a stable, deterministic order for independent tasks (sorted by id)", () => {
    expect(topologicalSort(graph(["C", "A", "B"], []))).toEqual(["A", "B", "C"]);
  });

  it("returns null when the graph has a cycle", () => {
    expect(
      topologicalSort(
        graph(
          ["A", "B"],
          [
            ["A", "B"],
            ["B", "A"],
          ],
        ),
      ),
    ).toBeNull();
  });
});

describe("getDependencies / getDependents", () => {
  it("looks up direct dependencies and dependents", () => {
    const g = graph(
      ["A", "B", "C"],
      [
        ["A", "B"],
        ["A", "C"],
      ],
    );
    expect(getDependencies(g, "A")).toEqual(["B", "C"]);
    expect(getDependents(g, "B")).toEqual(["A"]);
    expect(getDependencies(g, "B")).toEqual([]);
  });
});

describe("getReadyTasks / getBlockedTasks", () => {
  const g = graph(
    ["A", "B", "C"],
    [
      ["A", "B"],
      ["B", "C"],
    ],
  ); // A -> B -> C

  it("with nothing completed, only the root dependency is ready", () => {
    expect(getReadyTasks(g, [])).toEqual(["C"]);
    expect(getBlockedTasks(g, [])).toEqual(["A", "B"]);
  });

  it("completing a dependency unblocks its direct dependent", () => {
    expect(getReadyTasks(g, ["C"])).toEqual(["B"]);
    expect(getBlockedTasks(g, ["C"])).toEqual(["A"]);
  });

  it("completing the whole chain leaves nothing ready or blocked", () => {
    expect(getReadyTasks(g, ["A", "B", "C"])).toEqual([]);
    expect(getBlockedTasks(g, ["A", "B", "C"])).toEqual([]);
  });

  it("independent tasks are all ready immediately", () => {
    expect(getReadyTasks(graph(["A", "B", "C"], []), [])).toEqual(["A", "B", "C"]);
  });
});
