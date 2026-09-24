import { describe, expect, it } from "vitest";
import { buildDependencyGraph, type GraphRelationshipInput } from "../sourceDependencyGraph.js";
import { computeImpact, renderImpactForPrompt } from "../impactAnalysis.js";

// Task 2 (ADR-029): runtime vs type-only reach, re-export (barrel) reach,
// exact totals and affected entry points. Expected values are derived by
// hand below; the random-graph test checks against an independent
// Floyd–Warshall oracle (a different algorithm from the BFS under test).

const f = (id: string) => `src/${id}.ts`;
function edge(from: string, to: string, extra: Partial<GraphRelationshipInput> = {}): GraphRelationshipInput {
  return {
    importerRelativePath: f(from),
    rawImport: `./${to}.js`,
    isLiteral: true,
    importType: "import",
    line: 1,
    column: 1,
    status: "confirmed",
    resolvedRelativePath: f(to),
    resolutionMethod: "nodenext:.js->.ts",
    ...extra,
  };
}
const typeOnly = { typeOnly: true };
const reExport = { importType: "export_from" as const };

// Hand-checked graph (importer -> imported), target = types:
//   model   -type-> types          model:   depth 1, type_only
//   service -> model               service: depth 2, type_only (its only path has a type edge)
//   handler -> types (+ a type-only line) handler: depth 1, runtime
//   index   =re-export=> handler   index:   depth 2, runtime, re-exports only
//   index   =re-export=> model
//   app     -> index               app:     depth 3, runtime, re-exports only (every path via index)
//   cli     -> handler             cli:     depth 2, runtime
//   facade  -> handler AND =re-export=> handler   facade: depth 2, runtime, NOT re-exports only
//   mixed   -type-> types          mixed:   depth 1 (direct), runtime via handler
//   mixed   -> handler
//   cycA <-> cycB, cycB -> types   cycB depth 1, cycA depth 2 (cycle terminates)
// No importers: app, cli, facade, mixed, service. package.json declares index.
const names = [
  "types",
  "model",
  "service",
  "handler",
  "index",
  "app",
  "cli",
  "facade",
  "mixed",
  "cycA",
  "cycB",
];
const inventory = names.map((n) => ({ relativePath: f(n), language: "typescript" }));
const rels = [
  edge("model", "types", typeOnly),
  edge("service", "model"),
  edge("handler", "types"),
  // A second, type-only statement on the same pair: one runtime statement keeps the edge runtime.
  edge("handler", "types", { ...typeOnly, line: 2 }),
  edge("index", "handler", reExport),
  edge("index", "model", reExport),
  edge("app", "index"),
  edge("cli", "handler"),
  edge("facade", "handler", { line: 1 }),
  edge("facade", "handler", { ...reExport, line: 2 }),
  edge("mixed", "types", { ...typeOnly, line: 1 }),
  edge("mixed", "handler", { line: 2 }),
  edge("cycA", "cycB"),
  edge("cycB", "cycA"),
  edge("cycB", "types"),
];
const entryPoints = new Map([[f("index"), ["package.json main"]]]);
const wide = { maxDepth: 10, maxNodes: 100 };

describe("impact reach classification (hand-derived fixture)", () => {
  const r = computeImpact(buildDependencyGraph(inventory, rels), f("types"), wide, { entryPoints });
  const label = (file: string) => {
    const d = [...r.directDependents, ...r.transitiveDependents].find((x) => x.file === f(file));
    return d && { reach: d.reach, reExportsOnly: d.onlyThroughReExports === true };
  };

  it("labels each dependent runtime or type-only, and re-export-only where every path is a re-export", () => {
    expect(label("model")).toEqual({ reach: "type_only", reExportsOnly: false });
    expect(label("service")).toEqual({ reach: "type_only", reExportsOnly: false });
    expect(label("handler")).toEqual({ reach: "runtime", reExportsOnly: false });
    expect(label("index")).toEqual({ reach: "runtime", reExportsOnly: true });
    expect(label("app")).toEqual({ reach: "runtime", reExportsOnly: true });
    expect(label("cli")).toEqual({ reach: "runtime", reExportsOnly: false });
    expect(label("facade")).toEqual({ reach: "runtime", reExportsOnly: false });
    // Its direct edge is type-only, but it ALSO reaches types at runtime via handler.
    expect(label("mixed")).toEqual({ reach: "runtime", reExportsOnly: false });
    expect(label("cycB")).toEqual({ reach: "runtime", reExportsOnly: false });
    expect(label("cycA")).toEqual({ reach: "runtime", reExportsOnly: false });
  });

  it("keeps depths and the existing lists unchanged (cycle-safe, target never its own dependent)", () => {
    expect(r.directDependents.map((d) => d.file)).toEqual(["cycB", "handler", "mixed", "model"].map(f));
    expect(r.transitiveDependents.map((d) => [d.file, d.depth])).toEqual([
      [f("cli"), 2],
      [f("cycA"), 2],
      [f("facade"), 2],
      [f("index"), 2],
      [f("service"), 2],
      [f("app"), 3],
    ]);
    expect([...r.directDependents, ...r.transitiveDependents].some((d) => d.file === f("types"))).toBe(false);
  });

  it("reports exact totals", () => {
    expect(r.dependentTotals).toEqual({ all: 10, runtime: 8, typeOnly: 2, onlyThroughReExports: 2 });
  });

  it("lists affected entry points: declared ones and files nothing imports, by (depth, file)", () => {
    expect(r.affectedEntryPoints).toEqual([
      { file: f("mixed"), depth: 1, reach: "runtime", declaredBy: [], noImporters: true },
      { file: f("cli"), depth: 2, reach: "runtime", declaredBy: [], noImporters: true },
      { file: f("facade"), depth: 2, reach: "runtime", declaredBy: [], noImporters: true },
      {
        file: f("index"),
        depth: 2,
        reach: "runtime",
        onlyThroughReExports: true,
        declaredBy: ["package.json main"],
        noImporters: false,
      },
      { file: f("service"), depth: 2, reach: "type_only", declaredBy: [], noImporters: true },
      {
        file: f("app"),
        depth: 3,
        reach: "runtime",
        onlyThroughReExports: true,
        declaredBy: [],
        noImporters: true,
      },
    ]);
    expect(r.affectedEntryPointsTotal).toBe(6);
  });

  it("keeps totals exact when the listed traversal is bounded", () => {
    const b = computeImpact(buildDependencyGraph(inventory, rels), f("types"), { maxDepth: 1, maxNodes: 2 });
    expect(b.truncated).toBe(true);
    expect(b.transitiveDependents).toEqual([]);
    expect(b.dependentTotals).toEqual(r.dependentTotals);
    expect(b.affectedEntryPoints).toHaveLength(2);
    expect(b.affectedEntryPointsTotal).toBe(5); // no declared entry points without the map
  });

  it("is independent of relationship input order", () => {
    const shuffled = [...rels].reverse();
    const again = computeImpact(buildDependencyGraph([...inventory].reverse(), shuffled), f("types"), wide, {
      entryPoints,
    });
    expect(again).toEqual(r);
  });

  it("states reach and entry points in the planning prompt without overstating them", () => {
    const text = renderImpactForPrompt(r, () => undefined);
    expect(text).toContain(`${f("model")}:1 (type-only)`);
    expect(text).toContain(`${f("service")} (2 hops, via ${f("model")}, type-only reach)`);
    expect(text).toContain(`${f("app")} (3 hops, via ${f("index")}, re-exports only)`);
    expect(text).toContain(
      "Exactly 10 file(s) depend on it at any depth: 8 possibly at runtime, 2 only through type-only imports (compile-time); 2 only through re-exports.",
    );
    expect(text).toMatch(/Entry points that reach it \(6; .*\): src\/mixed\.ts \(no importers\), /);
    expect(text).toContain(`${f("index")} (package entry, re-exports only)`);
  });

  it("an isolated file has no dependents and is its own only entry point", () => {
    const g = buildDependencyGraph([{ relativePath: f("alone"), language: "typescript" }], []);
    const i = computeImpact(g, f("alone"), wide);
    expect(i.dependentTotals).toEqual({ all: 0, runtime: 0, typeOnly: 0, onlyThroughReExports: 0 });
    expect(i.affectedEntryPoints).toEqual([
      { file: f("alone"), depth: 0, reach: "runtime", declaredBy: [], noImporters: true },
    ]);
    expect(renderImpactForPrompt(i, () => undefined)).not.toContain("Exactly");
  });
});

// ---- Independent oracle: Floyd–Warshall shortest distances on random graphs.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function floyd(n: number, edges: [number, number][]): number[][] {
  const d = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );
  for (const [a, b] of edges) if (a !== b) d[a]![b] = 1;
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) if (d[i]![k]! + d[k]![j]! < d[i]![j]!) d[i]![j] = d[i]![k]! + d[k]![j]!;
  return d;
}

describe("impact reach matches an independent oracle on random graphs", () => {
  it("agrees on reach sets, depths, labels and totals for 40 seeded graphs", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const n = 6 + Math.floor(rand() * 18);
      const ids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(2, "0")}`);
      // Several statements may join one pair (≈ n/2 repeats per graph).
      const kinds: { a: number; b: number; typeOnly: boolean; reExport: boolean }[] = [];
      for (let k = 0; k < n * 2; k++) {
        const repeat =
          kinds.length > 0 && rand() < 0.25 ? kinds[Math.floor(rand() * kinds.length)]! : undefined;
        const a = repeat ? repeat.a : Math.floor(rand() * n);
        const b = repeat ? repeat.b : Math.floor(rand() * n);
        kinds.push({ a, b, typeOnly: rand() < 0.3, reExport: rand() < 0.25 });
      }
      // Oracle's own edge classification, per pair.
      const pairs = new Map<string, { a: number; b: number; typeOnly: boolean; reExport: boolean }>();
      for (const k of kinds) {
        const key = `${k.a}-${k.b}`;
        const prev = pairs.get(key);
        pairs.set(key, {
          a: k.a,
          b: k.b,
          typeOnly: (prev?.typeOnly ?? true) && k.typeOnly,
          reExport: (prev?.reExport ?? true) && k.reExport,
        });
      }
      const pairList = [...pairs.values()];
      const graph = buildDependencyGraph(
        ids.map((id) => ({ relativePath: f(id), language: "typescript" })),
        kinds.map((k, line) =>
          edge(ids[k.a]!, ids[k.b]!, {
            line: line + 1,
            ...(k.typeOnly ? typeOnly : {}),
            ...(k.reExport ? reExport : {}),
          }),
        ),
      );
      const all = floyd(
        n,
        pairList.map((k) => [k.a, k.b]),
      );
      const runtime = floyd(
        n,
        pairList.filter((k) => !k.typeOnly).map((k) => [k.a, k.b]),
      );
      const nonReExport = floyd(
        n,
        pairList.filter((k) => !k.reExport).map((k) => [k.a, k.b]),
      );
      const hasImporter = new Set(pairList.filter((k) => k.a !== k.b).map((k) => k.b));

      for (let t = 0; t < n; t++) {
        const r = computeImpact(graph, f(ids[t]!), { maxDepth: 25, maxNodes: 1000 });
        const dependents = ids.map((_, i) => i).filter((i) => i !== t && all[i]![t]! < Infinity);
        const ctx = `seed ${seed} target ${ids[t]}`;

        expect(
          r.directDependents.map((d) => d.file),
          ctx,
        ).toEqual(dependents.filter((i) => all[i]![t] === 1).map((i) => f(ids[i]!)));
        expect(
          r.transitiveDependents
            .map((d) => [d.file, d.depth])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          ctx,
        ).toEqual(dependents.filter((i) => all[i]![t]! >= 2).map((i) => [f(ids[i]!), all[i]![t]]));
        for (const d of [...r.directDependents, ...r.transitiveDependents]) {
          const i = ids.indexOf(d.file.slice(4, -3));
          expect(d.reach, `${ctx} ${d.file}`).toBe(runtime[i]![t]! < Infinity ? "runtime" : "type_only");
          expect(d.onlyThroughReExports === true, `${ctx} ${d.file}`).toBe(nonReExport[i]![t] === Infinity);
        }
        expect(r.dependentTotals, ctx).toEqual({
          all: dependents.length,
          runtime: dependents.filter((i) => runtime[i]![t]! < Infinity).length,
          typeOnly: dependents.filter((i) => runtime[i]![t] === Infinity).length,
          onlyThroughReExports: dependents.filter((i) => nonReExport[i]![t] === Infinity).length,
        });
        expect(r.affectedEntryPoints.map((p) => p.file).sort(), ctx).toEqual(
          [t, ...dependents]
            .filter((i) => !hasImporter.has(i))
            .map((i) => f(ids[i]!))
            .sort(),
        );
      }
    }
  });
});
