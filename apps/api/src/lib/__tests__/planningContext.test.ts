import { describe, expect, it } from "vitest";
import { buildDependencyGraph, type GraphRelationshipInput } from "../sourceDependencyGraph.js";
import {
  PLANNING_CONTEXT_LIMITS,
  buildPlanningContext,
  classifyAffectedFiles,
  externalPackageName,
  observedInventoryPaths,
  renderPlanningContext,
  type PlanningInventoryItem,
} from "../planningContext.js";

const items: PlanningInventoryItem[] = [
  { relativePath: "src", type: "directory", status: "scanned" },
  { relativePath: "src/index.ts", type: "file", status: "scanned" },
  { relativePath: "src/util.ts", type: "file", status: "scanned" },
  { relativePath: "src/view.tsx", type: "file", status: "scanned" },
  { relativePath: "README.md", type: "file", status: "scanned" },
  { relativePath: "src/link.ts", type: "file", status: "skipped", skipReason: "symlink" },
];
const languages: Record<string, string> = {
  "src/index.ts": "typescript",
  "src/util.ts": "typescript",
  "src/view.tsx": "typescript",
};

function rel(overrides: Partial<GraphRelationshipInput>): GraphRelationshipInput {
  return {
    importerRelativePath: "src/index.ts",
    rawImport: "",
    isLiteral: true,
    status: "confirmed",
    ...overrides,
  };
}

const relationships: GraphRelationshipInput[] = [
  rel({
    rawImport: "./util.js",
    line: 1,
    resolvedRelativePath: "src/util.ts",
    resolutionMethod: "nodenext:.js->.ts",
  }),
  rel({
    rawImport: "./util.js",
    line: 9,
    resolvedRelativePath: "src/util.ts",
    resolutionMethod: "nodenext:.js->.ts",
  }),
  rel({
    importerRelativePath: "src/view.tsx",
    rawImport: "./util",
    line: 2,
    resolvedRelativePath: "src/util.ts",
  }),
  rel({ rawImport: "./missing.js", line: 3, status: "unresolved", reason: "No matching file" }),
  rel({ rawImport: "react-dom/client", line: 4, status: "external" }),
  rel({ importerRelativePath: "src/view.tsx", rawImport: "react", line: 1, status: "external" }),
  rel({ rawImport: "@scope/pkg/sub", line: 5, status: "external" }),
  rel({ rawImport: "@/alias", line: 6, status: "unsupported", reason: "Alias" }),
  rel({
    rawImport: "load(\n   name\n)",
    isLiteral: false,
    line: 7,
    status: "unsupported",
    reason: "Non-literal",
  }),
  rel({
    importerRelativePath: "src/util.ts",
    rawImport: "",
    status: "parse_error",
    reason: "Unable to parse",
  }),
];

function graphFor(rels: GraphRelationshipInput[], inv = items) {
  return buildDependencyGraph(
    inv
      .filter((i) => i.type === "file")
      .map((i) => ({ relativePath: i.relativePath, language: languages[i.relativePath] })),
    rels,
  );
}

function contextFor(rels = relationships, inv = items) {
  return buildPlanningContext({ scanId: "scan1", analysisId: "an1", items: inv, graph: graphFor(rels, inv) });
}

describe("externalPackageName", () => {
  it("reduces subpath and scoped specifiers to the package name", () => {
    expect(externalPackageName("react-dom/client")).toBe("react-dom");
    expect(externalPackageName("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(externalPackageName("node:fs")).toBe("node:fs");
    expect(externalPackageName("lodash")).toBe("lodash");
  });
});

describe("buildPlanningContext", () => {
  it("records scan/analysis identity and exact counts per category", () => {
    const ctx = contextFor();
    expect(ctx).toMatchObject({ scanId: "scan1", analysisId: "an1", version: 2, truncated: false });
    expect(ctx.counts).toEqual({
      files: 4,
      graphNodes: 3,
      confirmedEdges: 2,
      unresolved: 1,
      external: 3,
      externalPackages: 3,
      unsupported: 2,
      parseErrors: 1,
      cycles: 0,
    });
  });

  it("lists only real inventory files, sorted, and excludes symlink placeholders", () => {
    expect(contextFor().files).toEqual(["README.md", "src/index.ts", "src/util.ts", "src/view.tsx"]);
  });

  it("takes confirmed edges only from the canonical graph, with direction and every statement line", () => {
    const ctx = contextFor();
    expect(ctx.edges).toEqual([
      { from: "src/index.ts", to: "src/util.ts", statements: 2, lines: [1, 9] },
      { from: "src/view.tsx", to: "src/util.ts", statements: 1, lines: [2] },
    ]);
  });

  it("renders edges grouped by importer, one line per importer, without dropping any edge", () => {
    const text = renderPlanningContext(
      contextFor([
        rel({ rawImport: "./view.js", line: 4, resolvedRelativePath: "src/view.tsx" }),
        rel({ rawImport: "./util.js", line: 2, resolvedRelativePath: "src/util.ts" }),
        rel({
          importerRelativePath: "src/view.tsx",
          rawImport: "./util",
          resolvedRelativePath: "src/util.ts",
        }),
      ]),
    );
    expect(text).toContain("- src/index.ts -> src/util.ts:2, src/view.tsx:4");
    // An edge whose evidence has no line number is still listed, just uncited.
    expect(text).toContain("- src/view.tsx -> src/util.ts\n");
    expect(text).toContain("Confirmed internal dependencies (3)");
  });

  it("keeps unresolved, external, unsupported, and parse errors in separate buckets — never as edges", () => {
    const ctx = contextFor();
    expect(ctx.unresolved.map((r) => r.rawImport)).toEqual(["./missing.js"]);
    expect(ctx.externalPackages.map((p) => p.name).sort()).toEqual(["@scope/pkg", "react", "react-dom"]);
    expect(ctx.unsupported.map((r) => r.rawImport)).toEqual(["@/alias", "load( name )"]);
    expect(ctx.parseErrors).toEqual([expect.objectContaining({ importerRelativePath: "src/util.ts" })]);
    expect(ctx.edges.some((e) => e.to.includes("missing"))).toBe(false);
  });

  it("claims no cycle when the graph is acyclic, and lists only proven cycles otherwise", () => {
    expect(contextFor().isAcyclic).toBe(true);
    expect(renderPlanningContext(contextFor())).toContain("Import cycles: none found");

    const cyclic = contextFor([
      rel({ rawImport: "./util", resolvedRelativePath: "src/util.ts" }),
      rel({
        importerRelativePath: "src/util.ts",
        rawImport: "./index",
        resolvedRelativePath: "src/index.ts",
      }),
    ]);
    expect(cyclic.isAcyclic).toBe(false);
    expect(cyclic.cycles).toHaveLength(1);
    expect(renderPlanningContext(cyclic)).toMatch(/src\/index\.ts -> src\/util\.ts -> src\/index\.ts/);
  });

  it("is deterministic regardless of input order", () => {
    const a = contextFor();
    const b = contextFor([...relationships].reverse(), [...items].reverse());
    expect(b).toEqual(a);
    expect(renderPlanningContext(b)).toBe(renderPlanningContext(a));
  });

  it("bounds every list, reports truncation, and keeps exact totals", () => {
    const many: PlanningInventoryItem[] = Array.from(
      { length: PLANNING_CONTEXT_LIMITS.files + 5 },
      (_, i) => ({
        relativePath: `f${String(i).padStart(4, "0")}.md`,
        type: "file",
        status: "scanned",
      }),
    );
    const unresolved = Array.from({ length: PLANNING_CONTEXT_LIMITS.unresolved + 3 }, (_, i) =>
      rel({ rawImport: `./m${i}`, line: i, status: "unresolved" }),
    );
    const ctx = contextFor(unresolved, many);
    expect(ctx.truncated).toBe(true);
    expect(ctx.files).toHaveLength(PLANNING_CONTEXT_LIMITS.files);
    expect(ctx.counts.files).toBe(PLANNING_CONTEXT_LIMITS.files + 5);
    expect(ctx.unresolved).toHaveLength(PLANNING_CONTEXT_LIMITS.unresolved);
    expect(ctx.counts.unresolved).toBe(PLANNING_CONTEXT_LIMITS.unresolved + 3);
    const text = renderPlanningContext(ctx);
    expect(text).toContain(`${PLANNING_CONTEXT_LIMITS.files} of ${PLANNING_CONTEXT_LIMITS.files + 5} shown`);
    expect(text).toMatch(/truncated/);
  });

  it("caps confirmed edges deterministically and reports the exact total", () => {
    const n = PLANNING_CONTEXT_LIMITS.edges + 2;
    const inv: PlanningInventoryItem[] = Array.from({ length: n + 1 }, (_, i) => ({
      relativePath: `src/m${String(i).padStart(4, "0")}.ts`,
      type: "file",
      status: "scanned",
    }));
    const langs = Object.fromEntries(inv.map((i) => [i.relativePath, "typescript"]));
    const rels = Array.from({ length: n }, (_, i) =>
      rel({
        importerRelativePath: "src/m0000.ts",
        rawImport: `./m${i + 1}.js`,
        line: i + 1,
        resolvedRelativePath: `src/m${String(i + 1).padStart(4, "0")}.ts`,
      }),
    );
    const graph = buildDependencyGraph(
      inv.map((i) => ({ relativePath: i.relativePath, language: langs[i.relativePath] })),
      rels,
    );
    const ctx = buildPlanningContext({ scanId: "s", analysisId: "a", items: inv, graph });
    expect(ctx.counts.confirmedEdges).toBe(n);
    expect(ctx.edges).toHaveLength(PLANNING_CONTEXT_LIMITS.edges);
    expect(ctx.truncated).toBe(true);
    expect(renderPlanningContext(ctx)).toContain(`(${PLANNING_CONTEXT_LIMITS.edges} of ${n} shown)`);
  });

  it("renders multi-line snippets on one line and labels non-confirmed categories explicitly", () => {
    const text = renderPlanningContext(contextFor());
    expect(text).toContain("- src/index.ts -> src/util.ts:1,9\n");
    expect(text).toContain("Unresolved imports — NOT confirmed dependencies");
    expect(text).toContain('"load( name )"');
    expect(text).toContain("react-dom (1 file)");
    expect(text).not.toMatch(/load\(\n/);
  });
});

describe("classifyAffectedFiles", () => {
  const graph = graphFor(relationships);
  const source = { inventory: observedInventoryPaths(items), graph };

  it("marks inventory paths in_scan with confirmed-graph counts, others not_in_scan", () => {
    const result = classifyAffectedFiles(
      [
        { path: "src/util.ts", reason: "edit" },
        { path: "README.md" },
        { path: "src/new-feature.ts", reason: "new" },
      ],
      source,
    );
    expect(result).toEqual([
      { path: "src/util.ts", reason: "edit", evidence: "in_scan", dependentsCount: 2, dependenciesCount: 0 },
      {
        path: "README.md",
        reason: "",
        evidence: "in_scan",
        dependentsCount: undefined,
        dependenciesCount: undefined,
      },
      { path: "src/new-feature.ts", reason: "new", evidence: "not_in_scan" },
    ]);
  });

  it("never treats a symlink placeholder as an existing file", () => {
    expect(classifyAffectedFiles([{ path: "src/link.ts" }], source)[0]?.evidence).toBe("not_in_scan");
  });

  it("marks everything unverified when the plan has no scan context", () => {
    expect(classifyAffectedFiles([{ path: "src/util.ts" }], null)).toEqual([
      { path: "src/util.ts", reason: "", evidence: "unverified" },
    ]);
  });

  it("drops duplicate paths, keeping the first occurrence", () => {
    const result = classifyAffectedFiles(
      [
        { path: "a.ts", reason: "1" },
        { path: "a.ts", reason: "2" },
      ],
      source,
    );
    expect(result).toEqual([{ path: "a.ts", reason: "1", evidence: "not_in_scan" }]);
  });
});
