import { describe, expect, it } from "vitest";
import { buildInventoryIndex, resolveImport, type ScanInventoryIndex } from "../importResolution.js";

function inventory(files: string[], directories: string[] = []): ScanInventoryIndex {
  return buildInventoryIndex([
    ...files.map((relativePath) => ({ relativePath, type: "file" as const })),
    ...directories.map((relativePath) => ({ relativePath, type: "directory" as const })),
  ]);
}

describe("resolveImport — relative resolution", () => {
  it("resolves an extensionless import via the extension-appending rule", () => {
    const inv = inventory(["src/foo.ts", "src/bar.ts"]);
    const result = resolveImport("src/bar.ts", "./foo", inv);
    expect(result).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/foo.ts",
      resolutionMethod: "extension:.ts",
    });
  });

  it("resolves an import with an explicit supported extension via an exact match", () => {
    const inv = inventory(["src/foo.ts"]);
    const result = resolveImport("src/bar.ts", "./foo.ts", inv);
    expect(result).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/foo.ts",
      resolutionMethod: "exact",
    });
  });

  it("resolves a parent-directory (..) import", () => {
    const inv = inventory(["src/utils/helper.ts", "src/index.ts"]);
    const result = resolveImport("src/utils/helper.ts", "../index", inv);
    expect(result).toMatchObject({ status: "confirmed", resolvedRelativePath: "src/index.ts" });
  });

  it("resolves a directory import to its index file", () => {
    const inv = inventory(["src/utils/index.ts"], ["src/utils"]);
    const result = resolveImport("src/main.ts", "./utils", inv);
    expect(result).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/utils/index.ts",
      resolutionMethod: "index:index.ts",
    });
  });

  it("reports 'unresolved' for a directory target with no supported index file", () => {
    const inv = inventory(["src/utils/helper.ts"], ["src/utils"]);
    const result = resolveImport("src/main.ts", "./utils", inv);
    expect(result.status).toBe("unresolved");
    expect(result.reason).toMatch(/index/i);
  });

  it("reports 'unresolved' for a genuinely missing target", () => {
    const inv = inventory(["src/foo.ts"]);
    const result = resolveImport("src/main.ts", "./does-not-exist", inv);
    expect(result.status).toBe("unresolved");
  });

  it("deterministically picks the .ts candidate when both .ts and .js exist (proves no ambiguity)", () => {
    const inv = inventory(["src/module.ts", "src/module.js"]);
    const first = resolveImport("src/main.ts", "./module", inv);
    const second = resolveImport("src/main.ts", "./module", inv);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "confirmed", resolvedRelativePath: "src/module.ts" });
  });

  it("prefers an exact literal match over extension-appending when both could apply", () => {
    // A file literally named "module" (no extension) alongside "module.ts"
    // — proves the resolver has one defined priority, not a coin flip.
    const inv = inventory(["src/module", "src/module.ts"]);
    const result = resolveImport("src/main.ts", "./module", inv);
    expect(result).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/module",
      resolutionMethod: "exact",
    });
  });
});

describe("resolveImport — external packages", () => {
  it("classifies a bare package specifier as external", () => {
    const inv = inventory([]);
    const result = resolveImport("src/main.ts", "react", inv);
    expect(result.status).toBe("external");
  });

  it("classifies a scoped package specifier as external", () => {
    const inv = inventory([]);
    const result = resolveImport("src/main.ts", "@scope/package", inv);
    expect(result.status).toBe("external");
  });

  it("never creates a local file edge for an external package even if a same-named file exists", () => {
    const inv = inventory(["react.ts"]);
    const result = resolveImport("src/main.ts", "react", inv);
    expect(result.status).toBe("external");
  });
});

describe("resolveImport — aliases and unsafe paths", () => {
  it("marks an @/ alias as unsupported, not silently resolved", () => {
    const inv = inventory(["src/components/Button.ts"]);
    const result = resolveImport("src/App.ts", "@/components/Button", inv);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/alias/i);
  });

  it("marks a ~/ alias as unsupported", () => {
    const inv = inventory([]);
    const result = resolveImport("src/App.ts", "~/lib/thing", inv);
    expect(result.status).toBe("unsupported");
  });

  it("marks an absolute (rooted) import as unsupported", () => {
    const inv = inventory(["etc/passwd"]);
    const result = resolveImport("src/App.ts", "/etc/passwd", inv);
    expect(result.status).toBe("unsupported");
  });

  it("rejects a path-traversal attempt that climbs above the scan root", () => {
    const inv = inventory(["secret.ts"]);
    const result = resolveImport("src/App.ts", "../../../secret", inv);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/outside/i);
    expect(result.resolvedRelativePath).toBeUndefined();
  });

  it("rejects an import target that would normalize to exactly the scan root's parent", () => {
    const inv = inventory(["App.ts"]);
    const result = resolveImport("App.ts", "../App", inv);
    expect(result.status).toBe("unsupported");
  });
});

describe("resolveImport — unsupported extensions", () => {
  it("marks an explicit non-JS/TS extension as unsupported even when the file exists", () => {
    const inv = inventory(["src/logo.svg"]);
    const result = resolveImport("src/App.ts", "./logo.svg", inv);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/extension/i);
  });

  it("marks a .json import as unsupported (JSON-as-module resolution not implemented)", () => {
    const inv = inventory(["src/data.json"]);
    const result = resolveImport("src/App.ts", "./data.json", inv);
    expect(result.status).toBe("unsupported");
  });
});

describe("resolveImport — NodeNext emitted-extension mapping (Batch C2.1)", () => {
  it("maps an explicit .js specifier to the .ts source file", () => {
    const inv = inventory(["src/lib/util.ts", "src/index.ts"]);
    const result = resolveImport("src/index.ts", "./lib/util.js", inv);
    expect(result).toEqual({
      status: "confirmed",
      resolvedRelativePath: "src/lib/util.ts",
      resolutionMethod: "nodenext:.js->.ts",
    });
  });

  it("maps an explicit .js specifier to a .tsx source file", () => {
    const inv = inventory(["src/components/View.tsx"]);
    const result = resolveImport("src/index.ts", "./components/View.js", inv);
    expect(result).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/components/View.tsx",
      resolutionMethod: "nodenext:.js->.tsx",
    });
  });

  it("maps an explicit .jsx specifier to a .tsx source file", () => {
    const inv = inventory(["src/Button.tsx"]);
    const result = resolveImport("src/App.tsx", "./Button.jsx", inv);
    expect(result).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/Button.tsx",
      resolutionMethod: "nodenext:.jsx->.tsx",
    });
  });

  it("maps a parent-directory .js specifier", () => {
    const inv = inventory(["src/models/Analysis.ts", "src/services/analysis.service.ts"]);
    const result = resolveImport("src/services/analysis.service.ts", "../models/Analysis.js", inv);
    expect(result).toMatchObject({ status: "confirmed", resolvedRelativePath: "src/models/Analysis.ts" });
  });

  it("maps an explicit index.js specifier to the directory's index.ts", () => {
    const inv = inventory(["src/services/ai/index.ts"], ["src/services/ai"]);
    const result = resolveImport("src/app.ts", "./services/ai/index.js", inv);
    expect(result).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/services/ai/index.ts",
      resolutionMethod: "nodenext:.js->.ts",
    });
  });

  it("applies the mapping to .mts and .cts importers too", () => {
    const inv = inventory(["src/util.ts"]);
    expect(resolveImport("src/a.mts", "./util.js", inv).status).toBe("confirmed");
    expect(resolveImport("src/a.cts", "./util.js", inv).status).toBe("confirmed");
  });

  it("confirms a genuinely existing .js file as an exact match when it is the only candidate", () => {
    const inv = inventory(["src/legacy.js"]);
    const result = resolveImport("src/index.ts", "./legacy.js", inv);
    expect(result).toEqual({
      status: "confirmed",
      resolvedRelativePath: "src/legacy.js",
      resolutionMethod: "exact",
    });
  });

  it("confirms a genuinely existing .jsx file as an exact match when it is the only candidate", () => {
    const inv = inventory(["src/Old.jsx"]);
    const result = resolveImport("src/App.tsx", "./Old.jsx", inv);
    expect(result).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/Old.jsx",
      resolutionMethod: "exact",
    });
  });

  it("does NOT confirm when both the literal .js file and a .ts source exist (conflict)", () => {
    const inv = inventory(["src/dual.js", "src/dual.ts"]);
    const result = resolveImport("src/index.ts", "./dual.js", inv);
    expect(result.status).toBe("unresolved");
    expect(result.resolvedRelativePath).toBeUndefined();
    expect(result.resolutionMethod).toBeUndefined();
    expect(result.reason).toMatch(/ambiguous/i);
    expect(result.reason).toContain("src/dual.js");
    expect(result.reason).toContain("src/dual.ts");
  });

  it("does NOT confirm when both .ts and .tsx sources exist for one .js specifier", () => {
    const inv = inventory(["src/thing.ts", "src/thing.tsx"]);
    const result = resolveImport("src/index.ts", "./thing.js", inv);
    expect(result.status).toBe("unresolved");
    expect(result.reason).toMatch(/ambiguous/i);
  });

  it("does NOT confirm when both the literal .jsx file and a .tsx source exist", () => {
    const inv = inventory(["src/W.jsx", "src/W.tsx"]);
    const result = resolveImport("src/App.tsx", "./W.jsx", inv);
    expect(result.status).toBe("unresolved");
    expect(result.reason).toMatch(/ambiguous/i);
  });

  it("keeps a missing .js target unresolved and lists the candidates checked", () => {
    const inv = inventory(["src/other.ts"]);
    const result = resolveImport("src/index.ts", "./missing.js", inv);
    expect(result.status).toBe("unresolved");
    expect(result.resolvedRelativePath).toBeUndefined();
    expect(result.reason).toMatch(/NodeNext candidates checked: \.js, \.ts, \.tsx/);
  });

  it("does not map .js to .jsx (allowJs-only behavior is not assumed)", () => {
    const inv = inventory(["src/Widget.jsx"]);
    expect(resolveImport("src/index.ts", "./Widget.js", inv).status).toBe("unresolved");
  });

  it("does not map .jsx to .ts", () => {
    const inv = inventory(["src/Widget.ts"]);
    expect(resolveImport("src/App.tsx", "./Widget.jsx", inv).status).toBe("unresolved");
  });

  it("does not map .mjs/.cjs specifiers to .mts/.cts or .ts", () => {
    const inv = inventory(["src/esm.mts", "src/esm.ts", "src/cjs.cts"]);
    expect(resolveImport("src/index.ts", "./esm.mjs", inv).status).toBe("unresolved");
    expect(resolveImport("src/index.ts", "./cjs.cjs", inv).status).toBe("unresolved");
  });

  it("does not apply the mapping for a plain JavaScript importer, and says why", () => {
    const inv = inventory(["src/util.ts"]);
    for (const importer of ["src/plain.js", "src/plain.jsx", "src/plain.mjs", "src/plain.cjs"]) {
      const result = resolveImport(importer, "./util.js", inv);
      expect(result.status).toBe("unresolved");
      expect(result.reason).toMatch(/TypeScript importers only/);
    }
  });

  it("still resolves a real .js file for a plain JavaScript importer exactly as before", () => {
    const inv = inventory(["src/util.js", "src/util.ts"]);
    expect(resolveImport("src/plain.js", "./util.js", inv)).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/util.js",
      resolutionMethod: "exact",
    });
  });

  it("does not rewrite an explicit .ts specifier to .tsx", () => {
    const inv = inventory(["src/foo.tsx"]);
    expect(resolveImport("src/index.ts", "./foo.ts", inv).status).toBe("unresolved");
  });

  it("leaves extensionless resolution completely unchanged", () => {
    const inv = inventory(["src/module.ts", "src/module.js"]);
    expect(resolveImport("src/main.ts", "./module", inv)).toEqual({
      status: "confirmed",
      resolvedRelativePath: "src/module.ts",
      resolutionMethod: "extension:.ts",
    });
  });

  it("leaves extensionless directory/index resolution unchanged", () => {
    const inv = inventory(["src/utils/index.ts"], ["src/utils"]);
    expect(resolveImport("src/main.ts", "./utils", inv)).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/utils/index.ts",
      resolutionMethod: "index:index.ts",
    });
  });

  it("does not guess ./utils.js means ./utils/index.ts", () => {
    const inv = inventory(["src/utils/index.ts"], ["src/utils"]);
    expect(resolveImport("src/main.ts", "./utils.js", inv).status).toBe("unresolved");
  });

  it("rejects a .js path-traversal attempt even if a mapped .ts file would exist", () => {
    const inv = inventory(["secret.ts"]);
    const result = resolveImport("src/App.ts", "../../secret.js", inv);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/outside/i);
    expect(result.resolvedRelativePath).toBeUndefined();
  });

  it("does not apply the mapping to alias or bare specifiers ending in .js", () => {
    const inv = inventory(["src/thing.ts", "chart.ts"]);
    expect(resolveImport("src/App.ts", "@/thing.js", inv).status).toBe("unsupported");
    expect(resolveImport("src/App.ts", "chart.js", inv).status).toBe("external");
  });

  it("never mutates the inventory and is deterministic across repeated calls", () => {
    const inv = inventory(["src/a.ts", "src/b.tsx", "src/c.js", "src/c.ts"]);
    const before = [...inv.files];
    const specs = ["./a.js", "./b.js", "./c.js", "./nope.js"];
    const first = specs.map((s) => resolveImport("src/index.ts", s, inv));
    const second = specs.map((s) => resolveImport("src/index.ts", s, inv));
    expect(second).toEqual(first);
    expect([...inv.files]).toEqual(before);
  });

  it("every confirmed result names a file that exists in the scan inventory", () => {
    const files = [
      "src/a.ts",
      "src/b.tsx",
      "src/c.js",
      "src/d.jsx",
      "src/e/index.ts",
      "src/f.ts",
      "src/f.js",
    ];
    const inv = inventory(files, ["src/e"]);
    const specs = ["./a.js", "./b.js", "./c.js", "./d.jsx", "./b.jsx", "./e/index.js", "./e", "./f.js"];
    specs.push("./g.js", "./a", "./b", "./a.ts", "./d.js", "../x.js", "../../x.js");
    let confirmedCount = 0;
    for (const importer of ["src/index.ts", "src/index.tsx", "src/index.js"]) {
      for (const spec of specs) {
        const result = resolveImport(importer, spec, inv);
        if (result.status === "confirmed") {
          confirmedCount += 1;
          expect(inv.files.has(result.resolvedRelativePath ?? "")).toBe(true);
          expect(result.resolutionMethod).toBeDefined();
        } else {
          expect(result.resolvedRelativePath).toBeUndefined();
        }
      }
    }
    expect(confirmedCount).toBeGreaterThan(0);
  });
});
