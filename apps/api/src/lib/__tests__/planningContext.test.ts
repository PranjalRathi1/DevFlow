import { describe, expect, it } from "vitest";
import { buildDependencyGraph, type GraphRelationshipInput } from "../sourceDependencyGraph.js";
import {
  PLANNING_CONTEXT_LIMITS,
  buildPlanningContext,
  buildRequirementFocus,
  focusTokens,
  classifyAffectedFiles,
  externalPackageName,
  observedInventoryPaths,
  scanCoverage,
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
    expect(ctx).toMatchObject({ scanId: "scan1", analysisId: "an1", version: 3, truncated: false });
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
        { path: "README.md", change: "reference" },
        { path: "src/new-feature.ts", reason: "new", change: "create" },
      ],
      source,
    );
    expect(result).toEqual([
      {
        path: "src/util.ts",
        reason: "edit",
        evidence: "in_scan",
        dependentsCount: 2,
        dependenciesCount: 0,
      },
      { path: "README.md", reason: "", change: "reference", evidence: "in_scan" },
      { path: "src/new-feature.ts", reason: "new", change: "create", evidence: "not_in_scan" },
    ]);
    expect(result.every((f) => f.conflict === undefined)).toBe(true);
  });

  it("flags claims the scan contradicts, without changing the evidence label", () => {
    const result = classifyAffectedFiles(
      [
        { path: "src/util.ts", change: "create" },
        { path: "src/missing.ts", change: "modify" },
        { path: "src/pattern.ts", change: "reference" },
        { path: "src/new.test.ts", change: "test" },
      ],
      source,
    );
    expect(result.map((f) => [f.evidence, f.conflict])).toEqual([
      ["in_scan", 'Claimed "create", but this file already exists in the scan'],
      ["not_in_scan", 'Claimed "modify", but this path is not in the scan'],
      ["not_in_scan", 'Claimed "reference", but this path is not in the scan'],
      ["not_in_scan", undefined],
    ]);
  });

  it("records no intent — and no conflict — when the AI stated none", () => {
    const [file] = classifyAffectedFiles([{ path: "src/not-there.ts" }], source);
    expect(file).not.toHaveProperty("change");
    expect(file?.conflict).toBeUndefined();
    expect(file?.evidence).toBe("not_in_scan");
  });

  it("never treats a symlink placeholder as an existing file", () => {
    expect(classifyAffectedFiles([{ path: "src/link.ts" }], source)[0]?.evidence).toBe("not_in_scan");
  });

  it("marks everything unverified — and flags nothing — when the plan has no scan context", () => {
    expect(classifyAffectedFiles([{ path: "src/util.ts", change: "create" }], null)).toEqual([
      { path: "src/util.ts", reason: "", change: "create", evidence: "unverified" },
    ]);
  });

  it("drops duplicate paths, keeping the first occurrence", () => {
    const result = classifyAffectedFiles(
      [
        { path: "a.ts", reason: "1", change: "create" },
        { path: "a.ts", reason: "2" },
      ],
      source,
    );
    expect(result).toEqual([{ path: "a.ts", reason: "1", change: "create", evidence: "not_in_scan" }]);
  });
});

describe("requirement focus (C5.1)", () => {
  // A small app with the route -> controller -> service layering and a
  // middleware wired at the route layer, plus tests at two layers.
  const files: Record<string, string> = {
    "src/app.ts": "source",
    "src/routes/index.ts": "source",
    "src/routes/auth.routes.ts": "source",
    "src/routes/scan.routes.ts": "source",
    "src/controllers/scan.controller.ts": "source",
    "src/services/scan.service.ts": "source",
    "src/middleware/rateLimit.middleware.ts": "source",
    "src/routes/__tests__/auth.integration.test.ts": "test",
    "src/routes/__tests__/scan.integration.test.ts": "test",
    "src/services/__tests__/scan.service.test.ts": "test",
  };
  const edge = (from: string, to: string, line: number) =>
    rel({ importerRelativePath: from, rawImport: "./x.js", line, resolvedRelativePath: to });
  const rels = [
    edge("src/app.ts", "src/routes/index.ts", 3),
    edge("src/routes/index.ts", "src/routes/auth.routes.ts", 2),
    edge("src/routes/index.ts", "src/routes/scan.routes.ts", 4),
    edge("src/routes/auth.routes.ts", "src/middleware/rateLimit.middleware.ts", 6),
    edge("src/routes/scan.routes.ts", "src/controllers/scan.controller.ts", 2),
    edge("src/controllers/scan.controller.ts", "src/services/scan.service.ts", 3),
    edge("src/routes/__tests__/auth.integration.test.ts", "src/app.ts", 8),
    edge("src/routes/__tests__/scan.integration.test.ts", "src/app.ts", 8),
    edge("src/services/__tests__/scan.service.test.ts", "src/services/scan.service.ts", 1),
    rel({
      importerRelativePath: "src/routes/scan.routes.ts",
      rawImport: "./missing.js",
      status: "unresolved",
    }),
  ];
  const graph = buildDependencyGraph(
    Object.entries(files).map(([relativePath, category]) => ({
      relativePath,
      category,
      language: "typescript",
    })),
    rels,
  );
  const requirement = {
    title: "Rate-limit scan endpoints",
    description: "Limit how often a user can start scanning.",
  };

  it("stems and filters requirement words deterministically", () => {
    expect(focusTokens("Rate-limiting the Scans, analysis and routes; reusing existing approach")).toEqual([
      "rate",
      "limit",
      "scan",
      "analysis",
      "route",
    ]);
  });

  it("picks non-test files by path words (title words weigh more) and shows confirmed wiring", () => {
    const focus = buildRequirementFocus(requirement, graph);
    expect(focus.files.map((f) => f.path)).toEqual([
      "src/middleware/rateLimit.middleware.ts",
      "src/controllers/scan.controller.ts",
      "src/routes/scan.routes.ts",
      "src/services/scan.service.ts",
    ]);
    const limiter = focus.files[0]!;
    expect(limiter.matchedTerms).toEqual(["limit", "rate"]);
    // The confirmed importer is the ROUTE file — the layer to follow.
    expect(limiter.importedBy).toEqual([{ path: "src/routes/auth.routes.ts", lines: [6] }]);
    const route = focus.files.find((f) => f.path === "src/routes/scan.routes.ts")!;
    expect(route.imports).toEqual([{ path: "src/controllers/scan.controller.ts", lines: [2] }]);
  });

  it("lists only tests that reach the file through confirmed imports, closest name match first", () => {
    const focus = buildRequirementFocus(requirement, graph);
    const limiter = focus.files[0]!;
    // Both integration tests reach the limiter via app -> index -> auth.routes;
    // the one sharing "auth" with the importer ranks first.
    expect(limiter.tests).toEqual([
      { path: "src/routes/__tests__/auth.integration.test.ts", depth: 4 },
      { path: "src/routes/__tests__/scan.integration.test.ts", depth: 4 },
    ]);
    const service = focus.files.find((f) => f.path === "src/services/scan.service.ts")!;
    expect(service.tests[0]).toEqual({ path: "src/services/__tests__/scan.service.test.ts", depth: 1 });
    // No test file is ever a focus candidate itself.
    expect(focus.files.some((f) => f.path.includes("__tests__"))).toBe(false);
  });

  it("never turns an unresolved import into a focus relationship", () => {
    const route = buildRequirementFocus(requirement, graph).files.find(
      (f) => f.path === "src/routes/scan.routes.ts",
    )!;
    expect(route.importsTotal).toBe(1);
    expect(JSON.stringify(route)).not.toContain("missing");
  });

  it("renders the focus with an explicit lexical-match disclaimer and is omitted without a requirement", () => {
    const withFocus = buildPlanningContext({ scanId: "s", analysisId: "a", items: [], graph, requirement });
    const text = renderPlanningContext(withFocus);
    expect(text).toContain("a lexical match, not proof they are relevant");
    expect(text).toContain("- src/middleware/rateLimit.middleware.ts [source; path matches: limit, rate]");
    expect(text).toContain("  imported by: src/routes/auth.routes.ts:6");
    expect(text).toContain("they do not show how an imported symbol is used");
    expect(text.indexOf("REQUIREMENT FOCUS")).toBeLessThan(text.indexOf("Files in the scan inventory"));

    const without = buildPlanningContext({ scanId: "s", analysisId: "a", items: [], graph });
    expect(without.focus).toBeNull();
    expect(renderPlanningContext(without)).not.toContain("REQUIREMENT FOCUS");
  });

  it("is deterministic and bounded", () => {
    const a = buildRequirementFocus(requirement, graph);
    const b = buildRequirementFocus(
      requirement,
      buildDependencyGraph(
        Object.entries(files)
          .reverse()
          .map(([relativePath, category]) => ({ relativePath, category, language: "typescript" })),
        [...rels].reverse(),
      ),
    );
    expect(b).toEqual(a);
    expect(a.files.length).toBeLessThanOrEqual(PLANNING_CONTEXT_LIMITS.focusFiles);
    for (const f of a.files) {
      expect(f.importedBy.length).toBeLessThanOrEqual(PLANNING_CONTEXT_LIMITS.focusNeighbors);
      expect(f.tests.length).toBeLessThanOrEqual(PLANNING_CONTEXT_LIMITS.focusTests);
    }
  });

  it("says so when nothing matches", () => {
    const focus = buildRequirementFocus({ title: "Improve onboarding copy" }, graph);
    expect(focus.files).toEqual([]);
    expect(
      renderPlanningContext({
        ...buildPlanningContext({ scanId: "s", analysisId: "a", items: [], graph }),
        focus,
      }),
    ).toContain("no file path matched");
  });
});

describe("scan coverage: never call a file 'not in scan' when the scan couldn't have seen it (Stage 5)", () => {
  const partial: PlanningInventoryItem[] = [
    { relativePath: "src", type: "directory", status: "scanned" },
    { relativePath: "src/a.ts", type: "file", status: "scanned" },
    { relativePath: "node_modules", type: "directory", status: "skipped", skipReason: "ignored" },
    { relativePath: "src/deep", type: "directory", status: "skipped", skipReason: "limit_reached" },
    { relativePath: "src/locked", type: "directory", status: "error" },
  ];
  const graph = graphFor([], partial);

  it("marks paths inside unread directories unverified, with the reason, and no false conflict", () => {
    const source = { inventory: observedInventoryPaths(partial), graph, coverage: scanCoverage(partial, []) };
    const result = classifyAffectedFiles(
      [
        { path: "node_modules/lib/index.js", change: "modify" },
        { path: "src/deep/x/y.ts", change: "reference" },
        { path: "src/locked/z.ts" },
        { path: "src/b.ts", change: "modify" },
      ],
      source,
    );
    expect(result.map((f) => [f.evidence, f.conflict ?? null])).toEqual([
      ["unverified", null],
      ["unverified", null],
      ["unverified", null],
      ["not_in_scan", 'Claimed "modify", but this path is not in the scan'],
    ]);
    expect(result[0]?.evidenceNote).toMatch(/node_modules.*ignored/);
    expect(result[1]?.evidenceNote).toMatch(/src\/deep.*limit/);
    expect(result[2]?.evidenceNote).toMatch(/src\/locked.*could not be read/);
    expect(result[3]?.evidenceNote).toBeUndefined();
  });

  it("never labels a symlink, or a path through one, as absent or present", () => {
    const withLink: PlanningInventoryItem[] = [
      ...partial,
      { relativePath: "src/linked", type: "file", status: "skipped", skipReason: "symlink" },
    ];
    const source = {
      inventory: observedInventoryPaths(withLink),
      graph,
      coverage: scanCoverage(withLink, []),
    };
    const [itself, behind] = classifyAffectedFiles(
      [{ path: "src/linked" }, { path: "src/linked/x.ts" }],
      source,
    );
    expect(itself).toMatchObject({
      evidence: "unverified",
      evidenceNote: expect.stringMatching(/symbolic link/),
    });
    expect(behind).toMatchObject({
      evidence: "unverified",
      evidenceNote: expect.stringContaining("Inside src/linked"),
    });
  });

  it("marks every unobserved path unverified when the scan stopped early", () => {
    const source = {
      inventory: observedInventoryPaths(partial),
      graph,
      coverage: scanCoverage(partial, ["maxFiles"]),
    };
    const [missing, present] = classifyAffectedFiles(
      [{ path: "src/b.ts", change: "modify" }, { path: "src/a.ts" }],
      source,
    );
    expect(missing).toMatchObject({
      evidence: "unverified",
      evidenceNote: expect.stringMatching(/stopped early.*maxFiles/),
    });
    expect(missing?.conflict).toBeUndefined();
    // What the scan DID see is still confirmed.
    expect(present?.evidence).toBe("in_scan");
  });

  it("states scan completeness in the planning context", () => {
    const complete = renderPlanningContext(
      buildPlanningContext({ scanId: "s", analysisId: "a", items: items, graph: graphFor(relationships) }),
    );
    expect(complete).toContain("Scan coverage: complete");
    const ctx = buildPlanningContext({
      scanId: "s",
      analysisId: "a",
      items: partial,
      graph,
      limitsReached: ["maxFiles"],
    });
    expect(ctx.coverage).toEqual({ stoppedEarly: ["maxFiles"], unreadDirectories: 3, ignoredDirectories: 1 });
    const text = renderPlanningContext(ctx);
    expect(text).toContain("Scan coverage: INCOMPLETE");
    expect(text).toContain("stopped early (maxFiles)");
    expect(text).toContain("3 directories were not read");
  });
});

describe("performance at the scanner's file cap (Stage 7)", () => {
  it("builds focus + context and classifies files for 2,000 files / 6,000 edges quickly and within bounds", () => {
    const n = 2000;
    const inv: PlanningInventoryItem[] = Array.from({ length: n }, (_, i) => ({
      relativePath: `src/mod${i % 40}/scan${i}.service.ts`,
      type: "file",
      status: "scanned",
    }));
    const langs = new Map(inv.map((i) => [i.relativePath, "typescript"]));
    const rels: GraphRelationshipInput[] = [];
    for (let i = 0; i < n; i++) {
      for (const k of [1, 7, 31]) {
        const j = (i + k) % n;
        rels.push(
          rel({
            importerRelativePath: inv[i]!.relativePath,
            rawImport: "./x.js",
            line: k,
            resolvedRelativePath: inv[j]!.relativePath,
          }),
        );
      }
    }
    const g = buildDependencyGraph(
      inv.map((i) => ({ relativePath: i.relativePath, language: langs.get(i.relativePath) })),
      rels,
    );
    const started = performance.now();
    const ctx = buildPlanningContext({
      scanId: "s",
      analysisId: "a",
      items: inv,
      graph: g,
      requirement: { title: "Rate-limit scan service endpoints" },
    });
    const text = renderPlanningContext(ctx);
    const classified = classifyAffectedFiles(
      inv.slice(0, 120).map((i) => ({ path: i.relativePath })),
      { inventory: observedInventoryPaths(inv), graph: g, coverage: scanCoverage(inv, []) },
    );
    const elapsed = performance.now() - started;

    expect(ctx.counts.confirmedEdges).toBe(6000);
    expect(ctx.edges).toHaveLength(PLANNING_CONTEXT_LIMITS.edges);
    expect(ctx.focus?.files).toHaveLength(PLANNING_CONTEXT_LIMITS.focusFiles);
    expect(ctx.truncated).toBe(true);
    expect(text).toContain(`${PLANNING_CONTEXT_LIMITS.edges} of 6000 shown`);
    expect(classified.every((f) => f.evidence === "in_scan")).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("cycle length is bounded in the context (Stage 7)", () => {
  it("renders a long cycle as a bounded prefix, says how many files were cut, and flags truncation", () => {
    const n = 40;
    const ring: PlanningInventoryItem[] = Array.from({ length: n }, (_, i) => ({
      relativePath: `src/r${String(i).padStart(2, "0")}.ts`,
      type: "file",
      status: "scanned",
    }));
    const g = buildDependencyGraph(
      ring.map((i) => ({ relativePath: i.relativePath, language: "typescript" })),
      ring.map((f, i) =>
        rel({
          importerRelativePath: f.relativePath,
          rawImport: "./x.js",
          resolvedRelativePath: ring[(i + 1) % n]!.relativePath,
        }),
      ),
    );
    const ctx = buildPlanningContext({ scanId: "s", analysisId: "a", items: ring, graph: g });
    const text = renderPlanningContext(ctx);
    // Search the cycles section only: the edge list also has a line starting "- src/r00.ts -> ".
    const cyclesSection = text.slice(text.indexOf("Import cycles among confirmed dependencies"));
    const cycleLine = cyclesSection.split("\n").find((l) => l.startsWith("- src/r00.ts -> "))!;
    expect(cycleLine.split(" -> ")).toHaveLength(PLANNING_CONTEXT_LIMITS.cycleFiles + 1);
    expect(cycleLine).toContain(
      `(${n - PLANNING_CONTEXT_LIMITS.cycleFiles} more files, then back to src/r00.ts)`,
    );
    expect(ctx.truncated).toBe(true);
    expect(ctx.counts.cycles).toBe(1);
  });
});
