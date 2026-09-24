import { describe, expect, it } from "vitest";
import { buildDependencyGraph, type GraphRelationshipInput } from "../sourceDependencyGraph.js";
import {
  computeImpact,
  impactRelationOf,
  renderImpactForPrompt,
  IMPACT_LIMITS,
  IMPACT_PLANNING_BOUNDS,
} from "../impactAnalysis.js";

const ts = (id: string) => ({ relativePath: `src/${id}.ts`, language: "typescript" });
function imp(
  from: string,
  to: string,
  line = 1,
  extra: Partial<GraphRelationshipInput> = {},
): GraphRelationshipInput {
  return {
    importerRelativePath: `src/${from}.ts`,
    rawImport: `./${to}.js`,
    isLiteral: true,
    importType: "import",
    line,
    column: 1,
    status: "confirmed",
    resolvedRelativePath: `src/${to}.ts`,
    resolutionMethod: "nodenext:.js->.ts",
    ...extra,
  };
}
function non(
  from: string,
  status: GraphRelationshipInput["status"],
  rawImport: string,
): GraphRelationshipInput {
  return { importerRelativePath: `src/${from}.ts`, rawImport, isLiteral: true, status, line: 9 };
}
const wide = { maxDepth: 10, maxNodes: 100 };
const files = (list: { file: string }[]) => list.map((x) => x.file);

// Hand-checked graph (importer -> imported):
//   app -> routes -> service -> db          (a chain)
//   app -> util, service -> util            (util is a shared dependency)
//   worker -> service                       (service has two direct dependents)
//   service imports util twice (lines 2 and 5)
//   service: unresolved "./gone.js", external "pg", unsupported "@/alias"
const inventory = ["app", "routes", "service", "db", "util", "worker"].map(ts);
const rels = [
  imp("app", "routes", 1),
  imp("app", "util", 2),
  imp("routes", "service", 1),
  imp("service", "db", 1),
  imp("service", "util", 5),
  imp("service", "util", 2),
  imp("worker", "service", 3),
  non("service", "unresolved", "./gone.js"),
  non("service", "external", "pg"),
  non("service", "unsupported", "@/alias"),
];
const graph = buildDependencyGraph(inventory, rels);

describe("computeImpact — direction and categories", () => {
  it("separates what a file imports from what imports it", () => {
    const r = computeImpact(graph, "src/service.ts", wide);
    // service IMPORTS db and util -> dependencies (not affected by a change to service).
    expect(files(r.directDependencies)).toEqual(["src/db.ts", "src/util.ts"]);
    // routes and worker IMPORT service -> dependents (may be affected).
    expect(files(r.directDependents)).toEqual(["src/routes.ts", "src/worker.ts"]);
    // app imports routes, which imports service -> transitive, depth 2, via routes.
    expect(r.transitiveDependents).toEqual([
      {
        file: "src/app.ts",
        reach: "runtime",
        depth: 2,
        via: "src/routes.ts",
        evidence: [
          {
            rawImport: "./routes.js",
            importType: "import",
            line: 1,
            column: 1,
            resolutionMethod: "nodenext:.js->.ts",
          },
        ],
      },
    ]);
    expect(r.truncated).toBe(false);
    expect(r.totals).toEqual({ directDependencies: 2, directDependents: 2 });
  });

  it("a leaf dependency is affected by nothing it imports, but has dependents", () => {
    const r = computeImpact(graph, "src/db.ts", wide);
    expect(r.directDependencies).toEqual([]);
    expect(files(r.directDependents)).toEqual(["src/service.ts"]);
    expect(r.transitiveDependents.map((t) => [t.file, t.depth, t.via])).toEqual([
      ["src/routes.ts", 2, "src/service.ts"],
      ["src/worker.ts", 2, "src/service.ts"],
      ["src/app.ts", 3, "src/routes.ts"],
    ]);
  });

  it("lists a shared dependent once, at its shortest depth", () => {
    // app reaches util directly (depth 1) AND via routes -> service (depth 3).
    const r = computeImpact(graph, "src/util.ts", wide);
    expect(files(r.directDependents)).toEqual(["src/app.ts", "src/service.ts"]);
    const all = [...files(r.directDependents), ...files(r.transitiveDependents)];
    expect(all.filter((f) => f === "src/app.ts")).toHaveLength(1);
    expect(r.transitiveDependents.map((t) => t.file)).toEqual(["src/routes.ts", "src/worker.ts"]);
  });

  it("keeps every evidence entry of a merged edge, in source order", () => {
    const r = computeImpact(graph, "src/util.ts", wide);
    const fromService = r.directDependents.find((d) => d.file === "src/service.ts")!;
    expect(fromService.evidence.map((e) => e.line)).toEqual([2, 5]);
  });

  it("never turns unresolved, external, or unsupported imports into impact", () => {
    const r = computeImpact(graph, "src/service.ts", wide);
    const everything = JSON.stringify([r.directDependencies, r.directDependents, r.transitiveDependents]);
    expect(everything).not.toMatch(/gone|"pg"|@\/alias/);
    expect(r.nonConfirmedImports.unresolved.map((x) => x.rawImport)).toEqual(["./gone.js"]);
    expect(r.nonConfirmedImports.external.map((x) => x.rawImport)).toEqual(["pg"]);
    expect(r.nonConfirmedImports.unsupported.map((x) => x.rawImport)).toEqual(["@/alias"]);
    expect(r.untraceable).toEqual({ unresolved: 1, unsupported: 1, parseErrors: 0 });
    expect(r.limitations.join(" ")).toMatch(/not that an imported symbol is used/);
  });
});

describe("computeImpact — cycles, self-imports, non-graph files", () => {
  it("is cycle-safe and reports the proven cycle", () => {
    // a -> b -> c -> a, and x -> a
    const g = buildDependencyGraph(["a", "b", "c", "x"].map(ts), [
      imp("a", "b"),
      imp("b", "c"),
      imp("c", "a"),
      imp("x", "a"),
    ]);
    const r = computeImpact(g, "src/a.ts", wide);
    expect(files(r.directDependents)).toEqual(["src/c.ts", "src/x.ts"]);
    expect(r.transitiveDependents.map((t) => [t.file, t.depth])).toEqual([["src/b.ts", 2]]);
    expect(r.cycles).toHaveLength(1);
    expect(r.cyclesTotal).toBe(1);
    expect(r.cycles[0]).toMatchObject({ length: 3, truncated: false });
    expect(r.cycles[0]!.files).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts", "src/c.ts"]));
    // The selected file never appears as its own dependent.
    expect([...files(r.directDependents), ...files(r.transitiveDependents)]).not.toContain("src/a.ts");
  });

  it("reports a self-import separately instead of listing the file as its own dependent", () => {
    const g = buildDependencyGraph(["a", "b"].map(ts), [imp("a", "a", 4), imp("b", "a", 1)]);
    const r = computeImpact(g, "src/a.ts", wide);
    expect(r.selfImport?.map((e) => e.line)).toEqual([4]);
    expect(files(r.directDependents)).toEqual(["src/b.ts"]);
    expect(files(r.directDependencies)).toEqual([]);
  });

  it("says a scanned non-source file has no import data rather than 'no impact'", () => {
    const g = buildDependencyGraph(
      [ts("a"), { relativePath: "src/styles.css", language: "css" }],
      [imp("a", "a")],
    );
    const r = computeImpact(g, "src/styles.css", wide);
    expect(r.inGraph).toBe(false);
    expect(r.directDependents).toEqual([]);
  });
});

describe("computeImpact — determinism and bounds", () => {
  it("returns identical output regardless of input order", () => {
    const shuffled = buildDependencyGraph([...inventory].reverse(), [...rels].reverse());
    for (const f of ["src/service.ts", "src/util.ts", "src/db.ts"]) {
      expect(computeImpact(shuffled, f, wide)).toEqual(computeImpact(graph, f, wide));
    }
  });

  it("flags truncation when depth or node caps cut the traversal", () => {
    const byDepth = computeImpact(graph, "src/db.ts", { maxDepth: 2, maxNodes: 100 });
    expect(byDepth.transitiveDependents.map((t) => t.file)).toEqual(["src/routes.ts", "src/worker.ts"]);
    expect(byDepth.truncated).toBe(true);
    const byNodes = computeImpact(graph, "src/db.ts", { maxDepth: 10, maxNodes: 2 });
    expect(byNodes.truncated).toBe(true);
    expect(byNodes.transitiveDependents.map((t) => t.file)).toEqual(["src/routes.ts"]);
  });

  it("handles large graphs within bounds (chain of 3,000 and fan-in of 3,000)", () => {
    const n = 3000;
    const chainFiles = Array.from({ length: n }, (_, i) => ts(`c${i}`));
    const chain = Array.from({ length: n - 1 }, (_, i) => imp(`c${i + 1}`, `c${i}`));
    const fanFiles = [ts("hub"), ...Array.from({ length: n }, (_, i) => ts(`f${i}`))];
    const fan = Array.from({ length: n }, (_, i) => imp(`f${i}`, "hub"));
    const g = buildDependencyGraph([...chainFiles, ...fanFiles], [...chain, ...fan]);

    const started = performance.now();
    const deep = computeImpact(g, "src/c0.ts", {
      maxDepth: IMPACT_LIMITS.maxMaxDepth,
      maxNodes: IMPACT_LIMITS.maxMaxNodes,
    });
    const hub = computeImpact(g, "src/hub.ts", { maxDepth: 10, maxNodes: IMPACT_LIMITS.maxMaxNodes });
    const elapsed = performance.now() - started;

    // Deep chain: cut at depth 25 (1 direct + 24 transitive), flagged.
    expect(deep.directDependents).toHaveLength(1);
    expect(deep.transitiveDependents).toHaveLength(IMPACT_LIMITS.maxMaxDepth - 1);
    expect(deep.truncated).toBe(true);
    // Wide fan-in: 3,000 direct importers, but the response is capped and says so.
    expect(hub.directDependents).toHaveLength(IMPACT_LIMITS.maxMaxNodes);
    expect(hub.totals.directDependents).toBe(n);
    expect(hub.truncated).toBe(true);
    // The capped list is the deterministic (sorted) prefix.
    expect(hub.directDependents.map((d) => d.file)).toEqual(
      [...Array.from({ length: n }, (_, i) => `src/f${i}.ts`)].sort().slice(0, IMPACT_LIMITS.maxMaxNodes),
    );
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("impact as planning context (Stage 4)", () => {
  const noCategory = () => undefined;

  it("reads verified relations off the computed impact, and never claims absence it can't prove", () => {
    const r = computeImpact(graph, "src/service.ts", wide);
    expect(impactRelationOf(r, "src/service.ts")).toBe("target");
    expect(impactRelationOf(r, "src/db.ts")).toBe("dependency");
    expect(impactRelationOf(r, "src/worker.ts")).toBe("direct_dependent");
    expect(impactRelationOf(r, "src/app.ts")).toBe("transitive_dependent");
    // A file not found within the (possibly bounded) impact gets no label at all.
    expect(impactRelationOf(r, "src/nowhere.ts")).toBeUndefined();
    const cut = computeImpact(graph, "src/service.ts", { maxDepth: 1, maxNodes: 100 });
    expect(cut.truncated).toBe(true);
    expect(impactRelationOf(cut, "src/app.ts")).toBeUndefined();
  });

  it("keeps both roles for a file in a cycle with the target", () => {
    const g = buildDependencyGraph(["a", "b", "c"].map(ts), [imp("a", "b"), imp("b", "a"), imp("c", "a")]);
    const r = computeImpact(g, "src/a.ts", wide);
    expect(impactRelationOf(r, "src/b.ts")).toBe("dependency_and_dependent");
    expect(impactRelationOf(r, "src/c.ts")).toBe("direct_dependent");
  });

  it("renders dependents as 'may be affected' and dependencies as not implied, with evidence lines", () => {
    const text = renderImpactForPrompt(computeImpact(graph, "src/service.ts", wide), noCategory);
    expect(text).toContain("CHANGE IMPACT for src/service.ts");
    expect(text).toContain(
      "It imports (dependencies; changing it does NOT imply these are affected) (2): src/db.ts:1, src/util.ts:2,5",
    );
    expect(text).toContain("Imported directly by (MAY be affected) (2): src/routes.ts:1, src/worker.ts:3");
    expect(text).toContain("src/app.ts (2 hops, via src/routes.ts)");
    expect(text).toContain("1 unresolved, 1 external, 1 unsupported");
    expect(text).toContain('"May be affected" does not mean "must change"');
    expect(text).not.toContain("TRUNCATED");
  });

  it("labels a truncated impact explicitly", () => {
    const text = renderImpactForPrompt(
      computeImpact(graph, "src/db.ts", { maxDepth: 2, maxNodes: 100 }),
      noCategory,
    );
    expect(text).toContain("This impact is TRUNCATED (at most 2 hops / 100 files)");
  });

  it("lists test files among dependents using the deterministic category", () => {
    const text = renderImpactForPrompt(computeImpact(graph, "src/service.ts", wide), (f) =>
      f === "src/worker.ts" ? "test" : "source",
    );
    expect(text).toContain("Test files among those dependents: src/worker.ts");
  });

  it("says a non-analysed file has no known relationships instead of listing none", () => {
    const g = buildDependencyGraph([ts("a"), { relativePath: "src/x.css", language: "css" }], []);
    const text = renderImpactForPrompt(computeImpact(g, "src/x.css", IMPACT_PLANNING_BOUNDS), noCategory);
    expect(text).toContain("not in an analysed language");
    expect(text).not.toContain("Imported directly by");
  });

  it("is deterministic", () => {
    const shuffled = buildDependencyGraph([...inventory].reverse(), [...rels].reverse());
    expect(
      renderImpactForPrompt(computeImpact(shuffled, "src/util.ts", IMPACT_PLANNING_BOUNDS), noCategory),
    ).toBe(renderImpactForPrompt(computeImpact(graph, "src/util.ts", IMPACT_PLANNING_BOUNDS), noCategory));
  });
});

describe("type-only evidence (Stage 5)", () => {
  it("carries typeOnly through the graph into impact evidence and marks all-type-only neighbours", () => {
    const g = buildDependencyGraph(["a", "b", "c"].map(ts), [
      imp("b", "a", 1, { typeOnly: true }),
      imp("c", "a", 2),
      imp("c", "a", 3, { typeOnly: true }),
    ]);
    const r = computeImpact(g, "src/a.ts", wide);
    expect(r.directDependents.find((d) => d.file === "src/b.ts")!.evidence).toEqual([
      expect.objectContaining({ line: 1, typeOnly: true }),
    ]);
    const text = renderImpactForPrompt(r, () => undefined);
    // b only ever imports a's types; c has a value import too.
    expect(text).toContain("src/b.ts:1 (type-only), src/c.ts:2,3");
  });
});

describe("impact cycles are bounded (Stage 7)", () => {
  it("caps the length of a returned cycle and reports the exact length and truncation", () => {
    const n = 120;
    const names = Array.from({ length: n }, (_, i) => `r${String(i).padStart(3, "0")}`);
    const g = buildDependencyGraph(
      names.map(ts),
      names.map((f, i) => imp(f, names[(i + 1) % n]!)),
    );
    const r = computeImpact(g, "src/r000.ts", wide);
    expect(r.cyclesTotal).toBe(1);
    expect(r.cycles[0]).toMatchObject({ length: n, truncated: true });
    expect(r.cycles[0]!.files).toHaveLength(IMPACT_LIMITS.cycleFiles);
    expect(r.truncated).toBe(true);
  });
});

describe("the file's own non-confirmed imports are bounded (review S7-1)", () => {
  it("caps each list at maxNodes and keeps exact totals, in the API result and the prompt", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      non("a", "external", `pkg-${String(i).padStart(2, "0")}`),
    );
    const g = buildDependencyGraph([ts("a")], many);
    const r = computeImpact(g, "src/a.ts", { maxDepth: 5, maxNodes: 10 });
    expect(r.nonConfirmedImports.external).toHaveLength(10);
    expect(r.nonConfirmedImports.totals).toEqual({ unresolved: 0, external: 25, unsupported: 0 });
    expect(r.truncated).toBe(false); // truncation flag is about impact traversal; totals disclose this cap
    expect(renderImpactForPrompt(r, () => undefined)).toContain("0 unresolved, 25 external, 0 unsupported");
  });
});
