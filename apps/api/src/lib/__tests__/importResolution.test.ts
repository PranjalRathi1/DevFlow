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
