import { describe, expect, it } from "vitest";
import {
  aliasScopeFor,
  buildResolutionConfig,
  configFilesIn,
  unloadedConfigTargets,
  type ResolutionConfig,
} from "../resolutionConfig.js";
import {
  buildInventoryIndex,
  packageEntryPoints,
  resolveImport,
  type ScanInventoryIndex,
} from "../importResolution.js";

// Expected results below are derived by hand from TypeScript's documented
// `paths`/`baseUrl`/`extends` rules and Node's `exports`/`imports` rules.

function inv(files: string[]): ScanInventoryIndex {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return buildInventoryIndex([
    ...files.map((relativePath) => ({ relativePath, type: "file" as const })),
    ...[...dirs].map((relativePath) => ({ relativePath, type: "directory" as const })),
  ]);
}
const cfg = (files: Record<string, string | object>): ResolutionConfig =>
  buildResolutionConfig(
    new Map(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])),
  );
const tsconfig = (compilerOptions: object, extra: object = {}) => ({ compilerOptions, ...extra });

describe("configuration discovery", () => {
  it("picks tsconfig/jsconfig/package.json files, sorted and bounded", () => {
    expect(
      configFilesIn([
        "b/package.json",
        "a/tsconfig.app.json",
        "src/x.ts",
        "tsconfig.json",
        "jsconfig.json",
        "x.json",
      ]),
    ).toEqual(["a/tsconfig.app.json", "b/package.json", "jsconfig.json", "tsconfig.json"]);
  });

  it("parses comments and trailing commas like TypeScript does", () => {
    const c = cfg({
      "tsconfig.json": `{
        // comment
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },
      }`,
    });
    expect(c.diagnostics).toEqual([]);
    expect(aliasScopeFor(c, "src/a.ts")).toMatchObject({
      baseUrl: "",
      paths: [{ pattern: "@/*", targets: ["src/*"] }],
    });
  });

  it("reports a malformed config and applies nothing from it", () => {
    const c = cfg({ "tsconfig.json": "{ not json" });
    expect(c.diagnostics).toEqual([
      { file: "tsconfig.json", message: expect.stringMatching(/could not parse/i) },
    ]);
    expect(aliasScopeFor(c, "src/a.ts")).toBeUndefined();
  });

  it("follows a relative extends chain; inherited paths stay relative to the config that defined them", () => {
    const c = cfg({
      "configs/base.json": tsconfig({ paths: { "@lib/*": ["../packages/lib/src/*"] } }),
      "apps/web/tsconfig.json": { extends: "../../configs/base.json" },
    });
    const scope = aliasScopeFor(c, "apps/web/src/main.ts")!;
    expect(scope.configFile).toBe("apps/web/tsconfig.json");
    // No baseUrl: substitutions are relative to configs/ (where paths was defined).
    expect(scope.pathsBase).toBe("configs");
    expect(c.diagnostics).toEqual([]);
  });

  it("resolves an extends target without the .json suffix", () => {
    const c = cfg({
      "tsconfig.base.json": tsconfig({ baseUrl: "src" }),
      "tsconfig.json": { extends: "./tsconfig.base" },
    });
    expect(aliasScopeFor(c, "src/a.ts")?.baseUrl).toBe("src");
  });

  it("marks package-based extends unsupported but keeps the config's own settings", () => {
    const c = cfg({
      "tsconfig.json": { extends: "@tsconfig/node20/tsconfig.json", compilerOptions: { baseUrl: "." } },
    });
    expect(c.diagnostics).toEqual([
      { file: "tsconfig.json", message: expect.stringMatching(/refers to a package.*unsupported/) },
    ]);
    expect(aliasScopeFor(c, "a.ts")?.baseUrl).toBe("");
  });

  it("refuses extends and baseUrl that leave the scan root", () => {
    const c = cfg({ "tsconfig.json": { extends: "../outside.json", compilerOptions: { baseUrl: "../.." } } });
    expect(c.diagnostics.map((d) => d.message)).toEqual([
      expect.stringMatching(/points outside the scanned root/),
      expect.stringMatching(/baseUrl .* outside the scanned root/),
    ]);
    expect(aliasScopeFor(c, "a.ts")?.baseUrl).toBeUndefined();
  });

  it("stops at an extends cycle and says so", () => {
    const c = cfg({
      "a.json": { extends: "./tsconfig.json", compilerOptions: { baseUrl: "a" } },
      "tsconfig.json": { extends: "./a.json" },
    });
    expect(c.diagnostics.some((d) => /extends cycle/.test(d.message))).toBe(true);
  });

  it("applies later entries of an extends array over earlier ones", () => {
    const c = cfg({
      "one.json": tsconfig({ baseUrl: "one" }),
      "two.json": tsconfig({ baseUrl: "two" }),
      "tsconfig.json": { extends: ["./one.json", "./two.json"] },
    });
    expect(aliasScopeFor(c, "x.ts")?.baseUrl).toBe("two");
  });

  it("uses the nearest config; tsconfig.json wins over jsconfig.json in the same directory", () => {
    const c = cfg({
      "tsconfig.json": tsconfig({ baseUrl: "root-src" }),
      "jsconfig.json": tsconfig({ baseUrl: "ignored" }),
      "apps/admin/jsconfig.json": tsconfig({ baseUrl: "." }),
    });
    expect(aliasScopeFor(c, "src/a.ts")?.configFile).toBe("tsconfig.json");
    expect(aliasScopeFor(c, "apps/admin/src/a.js")).toMatchObject({
      configFile: "apps/admin/jsconfig.json",
      baseUrl: "apps/admin",
    });
  });

  it("uses aliases from project references only when all defining references agree", () => {
    const same = cfg({
      "tsconfig.json": {
        files: [],
        references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }],
      },
      "tsconfig.app.json": tsconfig({ paths: { "@/*": ["./src/*"] } }),
      "tsconfig.node.json": tsconfig({}),
    });
    const agreed = aliasScopeFor(same, "src/a.ts");
    expect(agreed?.configFile).toBe("tsconfig.app.json");
    expect(agreed?.ambiguous).toBeUndefined();

    const differ = cfg({
      "tsconfig.json": {
        files: [],
        references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.test.json" }],
      },
      "tsconfig.app.json": tsconfig({ paths: { "@/*": ["./src/*"] } }),
      "tsconfig.test.json": tsconfig({ paths: { "@/*": ["./test/*"] } }),
    });
    expect(aliasScopeFor(differ, "src/a.ts")?.ambiguous).toMatch(
      /project references define different path aliases/,
    );
  });

  it("ignores patterns with more than one '*', with a diagnostic", () => {
    const c = cfg({ "tsconfig.json": tsconfig({ paths: { "a/*/b/*": ["x"], "@/*": ["src/*"] } }) });
    expect(aliasScopeFor(c, "a.ts")?.paths.map((p) => p.pattern)).toEqual(["@/*"]);
    expect(c.diagnostics[0]?.message).toMatch(/more than one/);
  });

  it("lists extends targets that exist in the scan but were not loaded yet", () => {
    const loaded = new Map([["tsconfig.json", JSON.stringify({ extends: "./configs/shared.json" })]]);
    expect(unloadedConfigTargets(loaded, new Set(["tsconfig.json", "configs/shared.json"]))).toEqual([
      "configs/shared.json",
    ]);
  });

  it("is independent of the order configs were supplied in", () => {
    const files = {
      "tsconfig.json": tsconfig({ baseUrl: ".", paths: { "@/*": ["src/*"] } }),
      "packages/ui/package.json": { name: "@acme/ui", exports: "./src/index.ts" },
      "package.json": { name: "root", imports: { "#utils": "./src/utils.ts" } },
    };
    const a = cfg(files);
    const b = cfg(Object.fromEntries(Object.entries(files).reverse()));
    expect([...b.aliasScopes.entries()]).toEqual([...a.aliasScopes.entries()]);
    expect(b.packages).toEqual(a.packages);
  });
});

describe("resolveImport with tsconfig paths and baseUrl", () => {
  const files = [
    "src/main.ts",
    "src/app.js",
    "src/components/Button.tsx",
    "src/components/index.ts",
    "src/lib/util.ts",
    "src/lib/dual.ts",
    "src/lib/dual.js",
    "src/lib/Case.ts",
    "legacy/lib/old.ts",
    "src/lib/shared.ts",
    "legacy/lib/shared.ts",
  ];
  const index = inv(files);
  const c = cfg({
    "tsconfig.json": tsconfig({
      baseUrl: ".",
      paths: {
        "@app": ["src/main.ts"],
        "@/*": ["src/*"],
        "@/components/*": ["src/components/*"],
        "~lib/*": ["src/lib/*", "legacy/lib/*"],
        "@out/*": ["../outside/*"],
        "*": ["src/lib/*"],
      },
    }),
  });
  const r = (spec: string, importer = "src/main.ts") => resolveImport(importer, spec, index, c);

  it("resolves an exact alias and records pattern + config + inner method", () => {
    expect(r("@app")).toEqual({
      status: "confirmed",
      resolvedRelativePath: "src/main.ts",
      resolutionMethod: "alias:@app via tsconfig.json; exact",
    });
  });

  it("resolves wildcards with the existing extension, index and NodeNext rules", () => {
    expect(r("@/lib/util")).toMatchObject({
      resolvedRelativePath: "src/lib/util.ts",
      resolutionMethod: "alias:@/* via tsconfig.json; extension:.ts",
    });
    expect(r("@/lib/util.js")).toMatchObject({
      resolutionMethod: "alias:@/* via tsconfig.json; nodenext:.js->.ts",
    });
    // NodeNext mapping stays TypeScript-importer-only.
    expect(r("@/lib/util.js", "src/app.js").status).toBe("unresolved");
  });

  it("prefers the wildcard with the longest prefix", () => {
    expect(r("@/components/Button")).toMatchObject({
      resolvedRelativePath: "src/components/Button.tsx",
      resolutionMethod: "alias:@/components/* via tsconfig.json; extension:.tsx",
    });
    expect(r("@/components")).toMatchObject({ resolvedRelativePath: "src/components/index.ts" });
  });

  it("tries substitutions in config order and takes the first that exists (TypeScript's rule)", () => {
    expect(r("~lib/util")).toMatchObject({ resolvedRelativePath: "src/lib/util.ts" });
    expect(r("~lib/old")).toMatchObject({ resolvedRelativePath: "legacy/lib/old.ts" });
    // Present under both substitutions: the earlier one wins, never both.
    expect(r("~lib/shared")).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "src/lib/shared.ts",
    });
  });

  it("keeps an alias with no existing target unresolved, listing what was tried", () => {
    const res = r("@/nope");
    expect(res.status).toBe("unresolved");
    expect(res.resolvedRelativePath).toBeUndefined();
    expect(res.reason).toMatch(
      /"@\/\*" \(tsconfig\.json\) matched but no target exists in the scan \(tried: src\/nope\)/,
    );
  });

  it("keeps an ambiguous NodeNext candidate under an alias unresolved", () => {
    const res = r("@/lib/dual.js");
    expect(res.status).toBe("unresolved");
    expect(res.reason).toMatch(/Ambiguous NodeNext mapping/);
  });

  it("never resolves across letter case under an alias", () => {
    const res = r("@/lib/case");
    expect(res.status).toBe("unresolved");
    expect(res.reason).toMatch(/letter case exists \(src\/lib\/Case\.ts\)/);
  });

  it("marks aliases that map outside the scan root unsupported", () => {
    expect(r("@out/x")).toMatchObject({
      status: "unsupported",
      reason: expect.stringMatching(/outside the scanned root/),
    });
  });

  it("lets a catch-all '*' fall through to external for real packages", () => {
    expect(r("util")).toMatchObject({ status: "confirmed", resolvedRelativePath: "src/lib/util.ts" });
    expect(r("react")).toMatchObject({ status: "external" });
  });

  it("does not change relative imports", () => {
    expect(r("./lib/util")).toEqual({
      status: "confirmed",
      resolvedRelativePath: "src/lib/util.ts",
      resolutionMethod: "extension:.ts",
    });
  });
});

describe("resolveImport with baseUrl only", () => {
  const index = inv(["src/components/Button.tsx", "src/main.ts"]);
  const c = cfg({ "tsconfig.json": tsconfig({ baseUrl: "src" }) });
  it("resolves non-relative paths under baseUrl, and leaves real packages external", () => {
    expect(resolveImport("src/main.ts", "components/Button", index, c)).toEqual({
      status: "confirmed",
      resolvedRelativePath: "src/components/Button.tsx",
      resolutionMethod: "baseUrl via tsconfig.json; extension:.tsx",
    });
    expect(resolveImport("src/main.ts", "react", index, c).status).toBe("external");
  });
});

describe("resolveImport: nearest config and ambiguity", () => {
  it("uses the importer's nearest config, not the root one", () => {
    const index = inv(["apps/web/src/x.ts", "src/x.ts"]);
    const c = cfg({
      "tsconfig.json": tsconfig({ paths: { "@/*": ["./src/*"] } }),
      "apps/web/tsconfig.json": tsconfig({ paths: { "@/*": ["./src/*"] } }),
    });
    expect(resolveImport("apps/web/src/main.ts", "@/x", index, c).resolvedRelativePath).toBe(
      "apps/web/src/x.ts",
    );
    expect(resolveImport("src/main.ts", "@/x", index, c).resolvedRelativePath).toBe("src/x.ts");
  });

  it("does not pick between disagreeing project references", () => {
    const index = inv(["src/x.ts", "test/x.ts"]);
    const c = cfg({
      "tsconfig.json": { references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.test.json" }] },
      "tsconfig.app.json": tsconfig({ paths: { "@/*": ["./src/*"] } }),
      "tsconfig.test.json": tsconfig({ paths: { "@/*": ["./test/*"] } }),
    });
    const res = resolveImport("src/main.ts", "@/x", index, c);
    expect(res.status).toBe("unresolved");
    expect(res.reason).toMatch(/different path aliases/);
  });

  it("keeps an unconfigured @/ alias unsupported, exactly as before", () => {
    expect(resolveImport("src/a.ts", "@/x", inv(["src/x.ts"])).status).toBe("unsupported");
  });
});

describe("resolveImport with local packages (exports / imports / workspaces)", () => {
  const index = inv([
    "apps/web/src/main.ts",
    "packages/ui/src/index.ts",
    "packages/ui/src/button.ts",
    "packages/ui/src/node.ts",
    "packages/core/lib/index.js",
    "packages/core/lib/extra.js",
    "packages/built/src/index.ts",
    "src/utils/format.ts",
    "src/main.ts",
  ]);
  const c = cfg({
    "packages/ui/package.json": {
      name: "@acme/ui",
      exports: {
        ".": { types: "./src/index.ts", default: "./src/index.ts" },
        "./button": "./src/button.ts",
        "./split": { node: "./src/node.ts", default: "./src/button.ts" },
        "./components/*": "./src/*.ts",
        "./private/*": null,
        "./escape": "./../core/lib/index.js",
        "./fallback": ["./src/button.ts"],
      },
    },
    "packages/core/package.json": { name: "core", main: "lib/index.js" },
    "packages/built/package.json": { name: "built", exports: { ".": { import: "./dist/index.js" } } },
    "packages/dup-a/package.json": { name: "dup" },
    "packages/dup-b/package.json": { name: "dup" },
    "package.json": {
      name: "root",
      imports: { "#utils/*": "./src/utils/*.ts", "#main": "./src/main.ts", "#dep": "some-package" },
    },
  });
  const r = (spec: string, importer = "apps/web/src/main.ts") => resolveImport(importer, spec, index, c);

  it("resolves a workspace package through exports, agreeing conditions confirmed", () => {
    expect(r("@acme/ui")).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "packages/ui/src/index.ts",
      resolutionMethod: expect.stringMatching(
        /^workspace:@acme\/ui via packages\/ui\/package\.json; exports\["\."\] \[types\/default\]; exact$/,
      ),
    });
    expect(r("@acme/ui/button")).toMatchObject({ resolvedRelativePath: "packages/ui/src/button.ts" });
    expect(r("@acme/ui/components/button")).toMatchObject({
      resolvedRelativePath: "packages/ui/src/button.ts",
    });
  });

  it("never picks between conditions that resolve to different files", () => {
    const res = r("@acme/ui/split");
    expect(res.status).toBe("unresolved");
    expect(res.reason).toMatch(/conditions resolve to different files/);
  });

  it("respects exports boundaries, null exclusions, escapes and fallback arrays", () => {
    expect(r("@acme/ui/src/button.ts")).toMatchObject({
      status: "unresolved",
      reason: expect.stringMatching(/not exported/),
    });
    expect(r("@acme/ui/private/x")).toMatchObject({
      status: "unresolved",
      reason: expect.stringMatching(/excluded/),
    });
    expect(r("@acme/ui/escape")).toMatchObject({
      status: "unsupported",
      reason: expect.stringMatching(/escapes the package directory/),
    });
    expect(r("@acme/ui/fallback")).toMatchObject({
      status: "unsupported",
      reason: expect.stringMatching(/fallback arrays/),
    });
  });

  it("resolves a package without exports via its entry field or subpath", () => {
    expect(r("core")).toMatchObject({ resolvedRelativePath: "packages/core/lib/index.js" });
    expect(r("core/lib/extra")).toMatchObject({ resolvedRelativePath: "packages/core/lib/extra.js" });
  });

  it("does not confirm exports that only point at build output missing from the scan", () => {
    expect(r("built")).toMatchObject({
      status: "unresolved",
      reason: expect.stringMatching(/may point to build output/),
    });
  });

  it("does not pick between duplicate package names", () => {
    expect(r("dup")).toMatchObject({
      status: "unresolved",
      reason: expect.stringMatching(/Several local packages/),
    });
  });

  it("resolves package #imports, and keeps package targets external", () => {
    expect(r("#utils/format", "src/main.ts")).toMatchObject({ resolvedRelativePath: "src/utils/format.ts" });
    expect(r("#main", "src/main.ts")).toMatchObject({ resolvedRelativePath: "src/main.ts" });
    expect(r("#dep", "src/main.ts").status).toBe("external");
    expect(r("#nope", "src/main.ts")).toMatchObject({
      status: "unresolved",
      reason: expect.stringMatching(/No "imports" entry/),
    });
  });

  it("keeps non-local bare packages external", () => {
    expect(r("react").status).toBe("external");
    expect(r("@acme/other").status).toBe("external");
  });

  it("every confirmed result exists in the scan inventory", () => {
    const specs = [
      "@acme/ui",
      "@acme/ui/button",
      "@acme/ui/split",
      "core",
      "core/lib/extra",
      "built",
      "dup",
      "#utils/format",
      "react",
    ];
    for (const s of specs) {
      const res = r(s, "src/main.ts");
      if (res.status === "confirmed") expect(index.files.has(res.resolvedRelativePath!)).toBe(true);
      else expect(res.resolvedRelativePath).toBeUndefined();
    }
  });
});

describe("package imports without configuration", () => {
  it("classifies '#x' as unresolved (a package-internal import), never as an external package", () => {
    const res = resolveImport("src/a.ts", "#internal", inv(["src/a.ts"]));
    expect(res.status).toBe("unresolved");
    expect(res.reason).toMatch(/no enclosing package\.json/);
  });
});

describe("packageEntryPoints (Task 2)", () => {
  const index = inv([
    "packages/ui/src/index.ts",
    "packages/ui/src/button.ts",
    "packages/ui/bin/cli.js",
    "packages/ui/lib/main.js",
    "packages/other/x.ts",
    "src/index.js",
  ]);
  const pkgOf = (files: Record<string, object>) => cfg(files).packages[0]!;

  it("collects in-scan files declared by exports, main/module/types and bin, with every declaring field", () => {
    const pkg = pkgOf({
      "packages/ui/package.json": {
        name: "@acme/ui",
        main: "lib/main.js",
        types: "./src/index.ts",
        bin: { acme: "./bin/cli.js" },
        exports: {
          ".": { types: "./src/index.ts", import: "./dist/index.js" },
          "./button": "./src/button.ts",
          "./components/*": "./src/*.ts",
          "./private": null,
          "./bad": "src/button.ts",
          "./escape": "./../other/x.ts",
        },
      },
    });
    expect(packageEntryPoints(pkg, index)).toEqual([
      { file: "packages/ui/bin/cli.js", fields: ["bin.acme"] },
      { file: "packages/ui/lib/main.js", fields: ["main"] },
      { file: "packages/ui/src/button.ts", fields: ['exports["./button"] [default]'] },
      { file: "packages/ui/src/index.ts", fields: ['exports["."] [types]', "types"] },
    ]);
  });

  it("handles exports sugar and a string bin, and never maps build output onto sources", () => {
    const pkg = pkgOf({ "package.json": { name: "root", exports: "./src/index.js", bin: "src/index.js" } });
    expect(packageEntryPoints(pkg, index)).toEqual([
      { file: "src/index.js", fields: ["bin", 'exports["."] [default]'] },
    ]);
    const built = pkgOf({ "packages/ui/package.json": { main: "./src/index.js" } });
    expect(packageEntryPoints(built, index)).toEqual([]); // src/index.js is not src/index.ts
  });
});
