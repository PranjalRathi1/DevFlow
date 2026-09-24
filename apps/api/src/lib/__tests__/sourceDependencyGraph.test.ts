import { describe, expect, it, vi } from "vitest";
import {
  buildDependencyGraph,
  topologicalOrder,
  getDirectDependencies,
  getDirectDependents,
  getRootNodes,
  getLeafNodes,
  getStructurallyReadyNodes,
  getStructurallyBlockedNodes,
  type GraphInventoryFile,
  type GraphRelationshipInput,
} from "../sourceDependencyGraph.js";

function file(relativePath: string, language = "typescript"): GraphInventoryFile {
  return { relativePath, language };
}

function confirmed(
  importerRelativePath: string,
  resolvedRelativePath: string,
  overrides: Partial<GraphRelationshipInput> = {},
): GraphRelationshipInput {
  return {
    importerRelativePath,
    rawImport: `./${resolvedRelativePath}`,
    isLiteral: true,
    importType: "import",
    status: "confirmed",
    resolvedRelativePath,
    resolutionMethod: "exact",
    ...overrides,
  };
}

function nonConfirmed(
  status: "unresolved" | "external" | "unsupported" | "parse_error",
  importerRelativePath = "src/a.ts",
  overrides: Partial<GraphRelationshipInput> = {},
): GraphRelationshipInput {
  return {
    importerRelativePath,
    rawImport: "whatever",
    isLiteral: true,
    importType: "import",
    status,
    reason: "test reason",
    ...overrides,
  };
}

describe("buildDependencyGraph — basic graph shapes", () => {
  it("handles an empty graph", () => {
    const result = buildDependencyGraph([], []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.isAcyclic).toBe(true);
  });

  it("handles one isolated node with no relationships at all", () => {
    const result = buildDependencyGraph([file("src/a.ts")], []);
    expect(result.nodes).toEqual([{ id: "src/a.ts", language: "typescript", category: undefined }]);
    expect(result.edges).toEqual([]);
  });

  it("builds two nodes and one edge from a single confirmed relationship", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts")],
      [confirmed("src/a.ts", "src/b.ts")],
    );
    expect(result.nodes.map((n) => n.id)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ id: "src/a.ts::src/b.ts", from: "src/a.ts", to: "src/b.ts" });
  });

  it("handles multiple independent components", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts")],
      [confirmed("src/a.ts", "src/b.ts"), confirmed("src/c.ts", "src/d.ts")],
    );
    expect(result.edges).toHaveLength(2);
    expect(result.isAcyclic).toBe(true);
  });

  it("supports multiple edges from one importer", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
      [confirmed("src/a.ts", "src/b.ts"), confirmed("src/a.ts", "src/c.ts")],
    );
    expect(getDirectDependencies(result, "src/a.ts")).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("supports multiple importers pointing to one target", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/shared.ts")],
      [confirmed("src/a.ts", "src/shared.ts"), confirmed("src/b.ts", "src/shared.ts")],
    );
    expect(getDirectDependents(result, "src/shared.ts")).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("buildDependencyGraph — node validation", () => {
  it("reports a missing importer rather than inventing a node", () => {
    const result = buildDependencyGraph([file("src/b.ts")], [confirmed("src/missing.ts", "src/b.ts")]);
    expect(result.edges).toEqual([]);
    expect(result.nodes.map((n) => n.id)).toEqual(["src/b.ts"]);
    expect(result.validationErrors).toContainEqual({
      type: "importer_not_in_inventory",
      importerRelativePath: "src/missing.ts",
    });
  });

  it("reports a missing target rather than inventing a node", () => {
    const result = buildDependencyGraph([file("src/a.ts")], [confirmed("src/a.ts", "src/missing.ts")]);
    expect(result.edges).toEqual([]);
    expect(result.nodes.map((n) => n.id)).toEqual(["src/a.ts"]);
    expect(result.validationErrors).toContainEqual({
      type: "target_not_in_inventory",
      importerRelativePath: "src/a.ts",
      resolvedRelativePath: "src/missing.ts",
    });
  });

  it("rejects a confirmed relationship whose target isn't in THIS inventory (cross-scan contamination)", () => {
    // Simulates a relationship accidentally sourced from a different
    // scan's analysis being handed to this scan's inventory.
    const otherScanInventory = [file("other-project/index.ts"), file("other-project/util.ts")];
    const thisScanRelationships = [confirmed("src/a.ts", "src/b.ts")];
    const result = buildDependencyGraph(otherScanInventory, thisScanRelationships);
    expect(result.edges).toEqual([]);
    expect(result.validationErrors.length).toBeGreaterThan(0);
  });

  it("treats an absolute-path-looking relativePath as an inert opaque id, never accessing it", () => {
    const weird = "C:\\Users\\someone\\project\\src\\a.ts";
    const result = buildDependencyGraph([{ relativePath: weird, language: "typescript" }], []);
    expect(result.nodes[0]?.id).toBe("C:/Users/someone/project/src/a.ts");
  });

  it("normalizes backslash path separators deterministically", () => {
    const result = buildDependencyGraph(
      [file("src\\a.ts"), file("src/b.ts")],
      [confirmed("src\\a.ts", "src/b.ts")],
    );
    expect(result.nodes.map((n) => n.id)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.edges[0]).toMatchObject({ from: "src/a.ts", to: "src/b.ts" });
  });

  it("deduplicates duplicate inventory entries deterministically (first occurrence wins)", () => {
    const result = buildDependencyGraph([file("src/a.ts", "typescript"), file("src/a.ts", "javascript")], []);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.language).toBe("typescript");
  });

  it("excludes non-supported-language inventory files from the node set", () => {
    const result = buildDependencyGraph([file("src/a.ts"), file("README.md", "markdown")], []);
    expect(result.nodes.map((n) => n.id)).toEqual(["src/a.ts"]);
  });
});

describe("buildDependencyGraph — edge construction", () => {
  const inventory = [file("src/a.ts"), file("src/b.ts")];

  it("a confirmed relationship creates exactly one edge", () => {
    const result = buildDependencyGraph(inventory, [confirmed("src/a.ts", "src/b.ts")]);
    expect(result.edges).toHaveLength(1);
  });

  it("an unresolved relationship never creates a confirmed edge", () => {
    const result = buildDependencyGraph(inventory, [nonConfirmed("unresolved")]);
    expect(result.edges).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
  });

  it("an external relationship never creates a confirmed edge", () => {
    const result = buildDependencyGraph(inventory, [nonConfirmed("external")]);
    expect(result.edges).toEqual([]);
    expect(result.external).toHaveLength(1);
  });

  it("an unsupported relationship never creates a confirmed edge", () => {
    const result = buildDependencyGraph(inventory, [nonConfirmed("unsupported")]);
    expect(result.edges).toEqual([]);
    expect(result.unsupported).toHaveLength(1);
  });

  it("a parse_error relationship never creates a confirmed edge", () => {
    const result = buildDependencyGraph(inventory, [nonConfirmed("parse_error")]);
    expect(result.edges).toEqual([]);
    expect(result.parseErrors).toHaveLength(1);
  });

  it("merges duplicate (from,to) relationships into one edge, preserving all evidence", () => {
    const result = buildDependencyGraph(inventory, [
      confirmed("src/a.ts", "src/b.ts", { rawImport: "./b" }),
      confirmed("src/a.ts", "src/b.ts", { rawImport: "./b.ts", resolutionMethod: "exact" }),
    ]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.evidence).toHaveLength(2);
    expect(result.edges[0]?.evidence.map((e) => e.rawImport)).toEqual(["./b", "./b.ts"]);
  });

  it("keeps distinct edges distinct even with the same raw import text but different resolved targets", () => {
    const inv = [file("src/a.ts"), file("src/x/mod.ts"), file("src/y/mod.ts")];
    const result = buildDependencyGraph(inv, [
      confirmed("src/a.ts", "src/x/mod.ts", { rawImport: "./mod" }),
      confirmed("src/a.ts", "src/y/mod.ts", { rawImport: "./mod" }),
    ]);
    expect(result.edges).toHaveLength(2);
  });

  it("produces a stable, deterministic edge id derived from from/to, not from insertion order", () => {
    const result = buildDependencyGraph(inventory, [confirmed("src/a.ts", "src/b.ts")]);
    expect(result.edges[0]?.id).toBe("src/a.ts::src/b.ts");
  });

  it("uses the importer->imported direction consistently (from = importer, to = imported)", () => {
    const result = buildDependencyGraph(inventory, [confirmed("src/a.ts", "src/b.ts")]);
    expect(result.edges[0]?.from).toBe("src/a.ts");
    expect(result.edges[0]?.to).toBe("src/b.ts");
    expect(getDirectDependencies(result, "src/a.ts")).toEqual(["src/b.ts"]);
    expect(getDirectDependents(result, "src/b.ts")).toEqual(["src/a.ts"]);
  });
});

describe("buildDependencyGraph — cycle detection", () => {
  it("reports no cycle for an acyclic graph", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
      [confirmed("src/a.ts", "src/b.ts"), confirmed("src/b.ts", "src/c.ts")],
    );
    expect(result.isAcyclic).toBe(true);
    expect(result.cycles).toEqual([]);
  });

  it("detects a direct self-cycle (a file importing itself)", () => {
    const result = buildDependencyGraph([file("src/a.ts")], [confirmed("src/a.ts", "src/a.ts")]);
    expect(result.isAcyclic).toBe(false);
    expect(result.cycles).toEqual([["src/a.ts", "src/a.ts"]]);
    expect(result.validationErrors).toContainEqual({ type: "self_reference", nodeId: "src/a.ts" });
  });

  it("detects a two-node cycle", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts")],
      [confirmed("src/a.ts", "src/b.ts"), confirmed("src/b.ts", "src/a.ts")],
    );
    expect(result.isAcyclic).toBe(false);
    expect(result.cycles).toHaveLength(1);
  });

  it("detects a three-node cycle", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
      [
        confirmed("src/a.ts", "src/b.ts"),
        confirmed("src/b.ts", "src/c.ts"),
        confirmed("src/c.ts", "src/a.ts"),
      ],
    );
    expect(result.isAcyclic).toBe(false);
    expect(result.cycles[0]).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"]);
  });

  it("detects a longer (five-node) cycle", () => {
    const names = ["a", "b", "c", "d", "e"].map((n) => `src/${n}.ts`);
    const rels = names.map((n, i) => confirmed(n, names[(i + 1) % names.length] as string));
    const result = buildDependencyGraph(
      names.map((n) => file(n)),
      rels,
    );
    expect(result.isAcyclic).toBe(false);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toHaveLength(6); // 5 nodes + repeated start
  });

  it("detects multiple independent cycles", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts")],
      [
        confirmed("src/a.ts", "src/b.ts"),
        confirmed("src/b.ts", "src/a.ts"),
        confirmed("src/c.ts", "src/d.ts"),
        confirmed("src/d.ts", "src/c.ts"),
      ],
    );
    expect(result.cycles).toHaveLength(2);
  });

  it("detects a cycle alongside an unrelated acyclic component without false positives on the acyclic part", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/x.ts"), file("src/y.ts")],
      [
        confirmed("src/a.ts", "src/b.ts"),
        confirmed("src/b.ts", "src/a.ts"),
        confirmed("src/x.ts", "src/y.ts"),
      ],
    );
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
  });

  it("produces identical cycle output regardless of relationship input order (shuffled)", () => {
    const inv = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")];
    const rels = [
      confirmed("src/a.ts", "src/b.ts"),
      confirmed("src/b.ts", "src/c.ts"),
      confirmed("src/c.ts", "src/a.ts"),
    ];
    const forward = buildDependencyGraph(inv, rels);
    const shuffled = buildDependencyGraph(inv, [...rels].reverse());
    expect(shuffled.cycles).toEqual(forward.cycles);
  });
});

describe("topologicalOrder — semantics: dependency-first (leaves before importers)", () => {
  it("returns an empty order for an empty graph", () => {
    const result = buildDependencyGraph([], []);
    expect(topologicalOrder(result)).toEqual([]);
  });

  it("returns the single node for a single-node graph", () => {
    const result = buildDependencyGraph([file("src/a.ts")], []);
    expect(topologicalOrder(result)).toEqual(["src/a.ts"]);
  });

  it("orders a linear chain dependency-first", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
      [confirmed("src/a.ts", "src/b.ts"), confirmed("src/b.ts", "src/c.ts")],
    );
    // a imports b imports c => c (the base dependency) must come first.
    expect(topologicalOrder(result)).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"]);
  });

  it("orders a branching graph with every dependency before its importer", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")],
      [confirmed("src/a.ts", "src/b.ts"), confirmed("src/a.ts", "src/c.ts")],
    );
    const order = topologicalOrder(result) ?? [];
    expect(order.indexOf("src/b.ts")).toBeLessThan(order.indexOf("src/a.ts"));
    expect(order.indexOf("src/c.ts")).toBeLessThan(order.indexOf("src/a.ts"));
  });

  it("orders a merging graph correctly (two importers, one shared dependency)", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/shared.ts")],
      [confirmed("src/a.ts", "src/shared.ts"), confirmed("src/b.ts", "src/shared.ts")],
    );
    const order = topologicalOrder(result) ?? [];
    expect(order.indexOf("src/shared.ts")).toBeLessThan(order.indexOf("src/a.ts"));
    expect(order.indexOf("src/shared.ts")).toBeLessThan(order.indexOf("src/b.ts"));
  });

  it("handles a disconnected graph with isolated nodes", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts"), file("src/isolated.ts")],
      [confirmed("src/a.ts", "src/b.ts")],
    );
    const order = topologicalOrder(result) ?? [];
    expect(order).toContain("src/isolated.ts");
    expect(order).toHaveLength(3);
  });

  it("breaks ties deterministically (sorted by id) among simultaneously-ready nodes", () => {
    const result = buildDependencyGraph([file("src/z.ts"), file("src/a.ts"), file("src/m.ts")], []);
    expect(topologicalOrder(result)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("returns null for a cyclic graph instead of a misleading partial order", () => {
    const result = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts")],
      [confirmed("src/a.ts", "src/b.ts"), confirmed("src/b.ts", "src/a.ts")],
    );
    expect(topologicalOrder(result)).toBeNull();
  });
});

describe("structural analysis — roots, leaves, dependencies, dependents", () => {
  const inv = [file("src/entry.ts"), file("src/mid.ts"), file("src/leaf.ts"), file("src/isolated.ts")];
  const rels = [confirmed("src/entry.ts", "src/mid.ts"), confirmed("src/mid.ts", "src/leaf.ts")];

  it("identifies root nodes (nothing imports them)", () => {
    const result = buildDependencyGraph(inv, rels);
    expect(getRootNodes(result).sort()).toEqual(["src/entry.ts", "src/isolated.ts"]);
  });

  it("identifies leaf nodes (they import nothing locally)", () => {
    const result = buildDependencyGraph(inv, rels);
    expect(getLeafNodes(result).sort()).toEqual(["src/isolated.ts", "src/leaf.ts"]);
  });

  it("reports direct dependencies and dependents correctly", () => {
    const result = buildDependencyGraph(inv, rels);
    expect(getDirectDependencies(result, "src/entry.ts")).toEqual(["src/mid.ts"]);
    expect(getDirectDependents(result, "src/mid.ts")).toEqual(["src/entry.ts"]);
  });

  it("produces deterministic output across repeated calls", () => {
    const result = buildDependencyGraph(inv, rels);
    expect(getRootNodes(result)).toEqual(getRootNodes(result));
    expect(getLeafNodes(result)).toEqual(getLeafNodes(result));
  });

  it("ignores unknown ids in a supplied completed-node set without mutating it", () => {
    const result = buildDependencyGraph(inv, rels);
    const completed = new Set(["src/leaf.ts", "src/does-not-exist.ts"]);
    const before = [...completed];
    const ready = getStructurallyReadyNodes(result, completed);
    expect(ready).toContain("src/mid.ts");
    expect([...completed]).toEqual(before);
  });

  it("never marks a node in a cycle as ready unless externally supplied as completed", () => {
    const cyclic = buildDependencyGraph(
      [file("src/a.ts"), file("src/b.ts")],
      [confirmed("src/a.ts", "src/b.ts"), confirmed("src/b.ts", "src/a.ts")],
    );
    expect(getStructurallyReadyNodes(cyclic, [])).toEqual([]);
    expect(getStructurallyBlockedNodes(cyclic, []).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("determinism — shuffled input produces identical canonical output", () => {
  it("produces identical nodes/edges/cycles/validationErrors regardless of inventory and relationship order", () => {
    const inv = [file("src/c.ts"), file("src/a.ts"), file("src/b.ts"), file("src/missing-target.ts")];
    const invReversed = [...inv].reverse();
    const rels = [
      confirmed("src/a.ts", "src/b.ts"),
      confirmed("src/b.ts", "src/c.ts"),
      confirmed("src/c.ts", "src/a.ts"),
      confirmed("src/does-not-exist.ts", "src/a.ts"),
    ];
    const relsShuffled = [rels[3], rels[1], rels[0], rels[2]] as GraphRelationshipInput[];

    const first = buildDependencyGraph(inv, rels);
    const second = buildDependencyGraph(invReversed, relsShuffled);

    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
    expect(second.cycles).toEqual(first.cycles);
    expect(second.validationErrors).toEqual(first.validationErrors);
  });
});

describe("purity and security", () => {
  it("never calls any node:fs function while building or analyzing a graph", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => {
      throw new Error("node:fs must never be touched by the pure graph engine");
    });
    const mod = await import("../sourceDependencyGraph.js");
    const inv = [file("src/a.ts"), file("src/b.ts")];
    const rels = [confirmed("src/a.ts", "src/b.ts")];
    const result = mod.buildDependencyGraph(inv, rels);
    expect(result.edges).toHaveLength(1);
    expect(mod.topologicalOrder(result)).toEqual(["src/b.ts", "src/a.ts"]);
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});
