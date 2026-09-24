import { describe, expect, it } from "vitest";
import { extractImports, isSupportedExtractionLanguage } from "../importExtraction.js";

describe("isSupportedExtractionLanguage", () => {
  it("accepts exactly the four supported languages", () => {
    expect(isSupportedExtractionLanguage("javascript")).toBe(true);
    expect(isSupportedExtractionLanguage("jsx")).toBe(true);
    expect(isSupportedExtractionLanguage("typescript")).toBe(true);
    expect(isSupportedExtractionLanguage("tsx")).toBe(true);
  });

  it("rejects everything else, including undefined", () => {
    expect(isSupportedExtractionLanguage("python")).toBe(false);
    expect(isSupportedExtractionLanguage("markdown")).toBe(false);
    expect(isSupportedExtractionLanguage(undefined)).toBe(false);
    expect(isSupportedExtractionLanguage("")).toBe(false);
  });
});

describe("extractImports", () => {
  it("extracts a default import", () => {
    const result = extractImports(`import foo from "./foo";`, "typescript");
    expect(result.status).toBe("ok");
    expect(result.imports).toEqual([
      { rawImport: "./foo", isLiteral: true, importType: "import", line: 1, column: 1 },
    ]);
  });

  it("extracts a named import", () => {
    const result = extractImports(`import { a, b as c } from "./bar";`, "typescript");
    expect(result.status).toBe("ok");
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]).toMatchObject({ rawImport: "./bar", isLiteral: true, importType: "import" });
  });

  it("extracts a namespace import", () => {
    const result = extractImports(`import * as ns from "some-pkg";`, "typescript");
    expect(result.imports).toEqual([
      { rawImport: "some-pkg", isLiteral: true, importType: "import", line: 1, column: 1 },
    ]);
  });

  it("extracts an export-from declaration", () => {
    const result = extractImports(`export { x } from "./baz";`, "typescript");
    expect(result.imports).toEqual([
      { rawImport: "./baz", isLiteral: true, importType: "export_from", line: 1, column: 1 },
    ]);
  });

  it("does not extract a re-export that has no module specifier", () => {
    const result = extractImports(`const x = 1; export { x };`, "typescript");
    expect(result.imports).toHaveLength(0);
  });

  it("extracts a CommonJS require call", () => {
    const result = extractImports(`const x = require("./qux");`, "javascript");
    expect(result.imports).toEqual([
      { rawImport: "./qux", isLiteral: true, importType: "require", line: 1, column: 11 },
    ]);
  });

  it("extracts a static dynamic import", () => {
    const result = extractImports(`async function f() { await import("./dyn"); }`, "typescript");
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]).toMatchObject({
      rawImport: "./dyn",
      isLiteral: true,
      importType: "dynamic_import",
    });
  });

  it("records a non-literal dynamic import as a safe snippet, not a resolvable path", () => {
    const result = extractImports(`function f(name) { return import(name); }`, "javascript");
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]).toMatchObject({ isLiteral: false, importType: "dynamic_import" });
    expect(result.imports[0]?.rawImport).toBe("name");
  });

  it("records a non-literal require argument as a safe snippet, not a resolvable path", () => {
    const result = extractImports(`const mod = require(getModuleName());`, "javascript");
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]).toMatchObject({ isLiteral: false, importType: "require" });
    expect(result.imports[0]?.rawImport).toContain("getModuleName()");
  });

  it("truncates an overly long non-literal snippet rather than recording unbounded text", () => {
    const longExpr = `veryLongVariableName${"X".repeat(500)}`;
    const result = extractImports(`import(${longExpr});`, "javascript");
    expect(result.imports[0]?.rawImport.length).toBeLessThan(130);
  });

  it("extracts multiple imports from one file in source order", () => {
    const src = `import a from "./a";\nimport b from "./b";\nconst c = require("./c");\n`;
    const result = extractImports(src, "javascript");
    expect(result.imports.map((i) => i.rawImport)).toEqual(["./a", "./b", "./c"]);
    expect(result.imports.map((i) => i.line)).toEqual([1, 2, 3]);
  });

  it("does not deduplicate a module imported twice — each call site is its own evidence", () => {
    const src = `import a from "./shared";\nimport b from "./shared";\n`;
    const result = extractImports(src, "javascript");
    expect(result.imports).toHaveLength(2);
    expect(result.imports.every((i) => i.rawImport === "./shared")).toBe(true);
  });

  it("extracts JSX-containing files correctly (jsx language)", () => {
    const src = `import React from "react";\nfunction App() { return <div />; }\nexport default App;\n`;
    const result = extractImports(src, "jsx");
    expect(result.status).toBe("ok");
    expect(result.imports.map((i) => i.rawImport)).toEqual(["react"]);
  });

  it("extracts TSX-containing files correctly (tsx language)", () => {
    const src = `import type { FC } from "react";\nconst App: FC = () => <div />;\nexport default App;\n`;
    const result = extractImports(src, "tsx");
    expect(result.status).toBe("ok");
    expect(result.imports.map((i) => i.rawImport)).toEqual(["react"]);
  });

  it("reports a parse error for genuinely malformed syntax, extracting nothing", () => {
    const result = extractImports(`import { from "./broken; this is not @#$% valid`, "typescript");
    expect(result.status).toBe("parse_error");
    expect(result.imports).toEqual([]);
    expect(result.diagnosticReason).toBeTruthy();
  });

  it("reports line/column for a non-trivial position, not just line 1", () => {
    const src = `// a comment\nconst x = 1;\n\nimport y from "./deep";\n`;
    const result = extractImports(src, "javascript");
    expect(result.imports[0]).toMatchObject({ line: 4, rawImport: "./deep" });
  });
});
