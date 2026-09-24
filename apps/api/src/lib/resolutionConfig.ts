import path from "node:path";
import ts from "typescript";

/**
 * Task 1 (ADR-028): resolution configuration derived from files the scan
 * observed — tsconfig/jsconfig `baseUrl`/`paths` (with relative `extends`
 * chains and `references`) and local package.json files (workspace
 * packages, `exports`, `imports`). PURE: callers supply file contents; this
 * module never touches the filesystem, never evaluates code, and only
 * ever returns scan-relative, forward-slash paths inside the scan root.
 */

export const CONFIG_LIMITS = {
  maxConfigFiles: 200,
  maxExtendsDepth: 10,
  maxDiagnostics: 100,
} as const;

export interface ConfigDiagnostic {
  file: string;
  message: string;
}

export interface PathAlias {
  /** As written in `paths`, e.g. "@/*". */
  pattern: string;
  /** Substitutions as written, in config order. */
  targets: string[];
}

/** The alias settings that apply to files near one tsconfig/jsconfig. */
export interface AliasScope {
  /** Scan-relative config file the settings come from (after extends/references). */
  configFile: string;
  /** Scan-relative directory `baseUrl` points to ("" = scan root), if set. */
  baseUrl?: string | undefined;
  paths: PathAlias[];
  /** Directory `paths` substitutions are relative to (baseUrl if set, else the defining config's dir). */
  pathsBase: string;
  /** Set when the applicable settings cannot be determined (e.g. references disagree). */
  ambiguous?: string | undefined;
}

export interface LocalPackage {
  /** Scan-relative package.json path. */
  file: string;
  /** Scan-relative package directory ("" = scan root). */
  dir: string;
  name?: string | undefined;
  exports?: unknown;
  imports?: unknown;
  main?: string | undefined;
  module?: string | undefined;
  types?: string | undefined;
  /** Raw `bin` value (string or name -> path map); used for entry points only. */
  bin?: unknown;
}

export interface ResolutionConfig {
  /** Keyed by the directory containing the config. tsconfig.json wins over jsconfig.json. */
  aliasScopes: ReadonlyMap<string, AliasScope>;
  /** Sorted by directory. */
  packages: readonly LocalPackage[];
  packagesByName: ReadonlyMap<string, readonly LocalPackage[]>;
  packagesByDir: ReadonlyMap<string, LocalPackage>;
  diagnostics: ConfigDiagnostic[];
}

export const EMPTY_RESOLUTION_CONFIG: ResolutionConfig = {
  aliasScopes: new Map(),
  packages: [],
  packagesByName: new Map(),
  packagesByDir: new Map(),
  diagnostics: [],
};

const CONFIG_BASENAME = /^(tsconfig|jsconfig)(\..+)?\.json$/;

/** Config files worth loading from an inventory, sorted (bounded). */
export function configFilesIn(inventoryFiles: Iterable<string>): string[] {
  return [...inventoryFiles]
    .filter((f) => {
      const base = f.slice(f.lastIndexOf("/") + 1);
      return base === "package.json" || CONFIG_BASENAME.test(base);
    })
    .sort((a, b) => a.localeCompare(b))
    .slice(0, CONFIG_LIMITS.maxConfigFiles);
}

const dirOf = (file: string) => {
  const d = path.posix.dirname(file);
  return d === "." ? "" : d;
};

/** Joins inside the scan root; null if the result escapes it or is absolute. */
export function joinInRoot(baseDir: string, rel: string): string | null {
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.includes("\\")) return null;
  const joined = path.posix.normalize(baseDir === "" ? rel : `${baseDir}/${rel}`);
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined === "." ? "" : joined.replace(/\/+$/, "");
}

interface RawTsConfig {
  file: string;
  extends: string[];
  references: string[];
  baseUrl?: string | undefined;
  paths?: Record<string, unknown> | undefined;
}

function parseTsConfig(file: string, text: string, diags: ConfigDiagnostic[]): RawTsConfig | null {
  const parsed = ts.parseConfigFileTextToJson(file, text);
  if (parsed.error || typeof parsed.config !== "object" || parsed.config === null) {
    diags.push({ file, message: "Could not parse this config file; its settings are ignored" });
    return null;
  }
  const cfg = parsed.config as Record<string, unknown>;
  const ext = cfg.extends;
  const extendsList =
    typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext.filter((e) => typeof e === "string") : [];
  const refs = Array.isArray(cfg.references)
    ? cfg.references
        .map((r) => (r && typeof r === "object" ? (r as { path?: unknown }).path : undefined))
        .filter((p): p is string => typeof p === "string")
    : [];
  const co = (cfg.compilerOptions ?? {}) as Record<string, unknown>;
  return {
    file,
    extends: extendsList as string[],
    references: refs,
    baseUrl: typeof co.baseUrl === "string" ? co.baseUrl : undefined,
    paths: co.paths && typeof co.paths === "object" ? (co.paths as Record<string, unknown>) : undefined,
  };
}

/** A relative `extends`/reference target, as TypeScript would locate it — only inside the scan root. */
function locateConfig(
  fromFile: string,
  target: string,
  loaded: ReadonlyMap<string, string>,
  asReference: boolean,
) {
  const joined = joinInRoot(dirOf(fromFile), target);
  if (joined === null) return { outside: true as const };
  const candidates = asReference
    ? [joined, `${joined}/tsconfig.json`]
    : joined.endsWith(".json")
      ? [joined]
      : [`${joined}.json`, joined, `${joined}/tsconfig.json`];
  const found = candidates.find((c) => loaded.has(c));
  return { found, candidates };
}

interface Effective {
  baseUrl?: { dir: string; from: string } | undefined;
  paths?: { entries: PathAlias[]; definedIn: string } | undefined;
}

function readPaths(raw: Record<string, unknown>, file: string, diags: ConfigDiagnostic[]): PathAlias[] {
  const out: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(raw)) {
    if ((pattern.match(/\*/g) ?? []).length > 1) {
      diags.push({
        file,
        message: `paths pattern "${pattern}" has more than one "*" and is ignored (as TypeScript does)`,
      });
      continue;
    }
    if (!Array.isArray(targets)) continue;
    const valid = targets.filter(
      (t): t is string => typeof t === "string" && (t.match(/\*/g) ?? []).length <= 1,
    );
    out.push({ pattern, targets: valid });
  }
  return out;
}

/**
 * Builds the resolution configuration. `loaded` maps scan-relative paths
 * to file text for every config file the caller could read (see
 * `configFilesIn` and `unloadedConfigTargets`).
 */
export function buildResolutionConfig(loaded: ReadonlyMap<string, string>): ResolutionConfig {
  const diagnostics: ConfigDiagnostic[] = [];
  const rawConfigs = new Map<string, RawTsConfig>();
  const packages: LocalPackage[] = [];

  for (const file of [...loaded.keys()].sort((a, b) => a.localeCompare(b))) {
    const text = loaded.get(file)!;
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (base === "package.json") {
      try {
        const pkg = JSON.parse(text) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        packages.push({
          file,
          dir: dirOf(file),
          name: str(pkg.name),
          exports: pkg.exports,
          imports: pkg.imports,
          main: str(pkg.main),
          module: str(pkg.module),
          types: str(pkg.types) ?? str(pkg.typings),
          bin: pkg.bin,
        });
      } catch {
        diagnostics.push({ file, message: "Could not parse package.json; it is ignored for resolution" });
      }
    } else {
      // Every other loaded file is a tsconfig-format file: either matched by
      // configFilesIn, or named by a relative extends/reference (any name).
      const parsed = parseTsConfig(file, text, diagnostics);
      if (parsed) rawConfigs.set(file, parsed);
    }
  }

  // Effective baseUrl/paths per config, following relative extends chains.
  const effectiveCache = new Map<string, Effective>();
  const effectiveOf = (file: string, stack: string[]): Effective => {
    const cached = effectiveCache.get(file);
    if (cached) return cached;
    const raw = rawConfigs.get(file);
    if (!raw) return {};
    if (stack.includes(file)) {
      diagnostics.push({
        file,
        message: `extends cycle: ${[...stack, file].join(" -> ")}; the cycle is not followed`,
      });
      return {};
    }
    if (stack.length >= CONFIG_LIMITS.maxExtendsDepth) {
      diagnostics.push({ file, message: "extends chain is too deep; not followed further" });
      return {};
    }
    let eff: Effective = {};
    // Later entries in an extends array override earlier ones (TS 5 semantics).
    for (const target of raw.extends) {
      if (!target.startsWith("./") && !target.startsWith("../")) {
        diagnostics.push({
          file,
          message: `extends "${target}" refers to a package or absolute path; its settings are not applied (unsupported)`,
        });
        continue;
      }
      const loc = locateConfig(file, target, loaded, false);
      if ("outside" in loc) {
        diagnostics.push({
          file,
          message: `extends "${target}" points outside the scanned root; not followed`,
        });
        continue;
      }
      if (!loc.found || !rawConfigs.has(loc.found)) {
        diagnostics.push({
          file,
          message: `extends "${target}" was not found in the scan (or could not be parsed)`,
        });
        continue;
      }
      const parent = effectiveOf(loc.found, [...stack, file]);
      eff = { baseUrl: parent.baseUrl ?? eff.baseUrl, paths: parent.paths ?? eff.paths };
    }
    if (raw.baseUrl !== undefined) {
      const dir = joinInRoot(dirOf(file), raw.baseUrl);
      if (dir === null) {
        diagnostics.push({
          file,
          message: `baseUrl "${raw.baseUrl}" points outside the scanned root; ignored`,
        });
      } else {
        eff = { ...eff, baseUrl: { dir, from: file } };
      }
    }
    if (raw.paths)
      eff = { ...eff, paths: { entries: readPaths(raw.paths, file, diagnostics), definedIn: file } };
    effectiveCache.set(file, eff);
    return eff;
  };

  const scopeFrom = (configFile: string, eff: Effective): AliasScope => ({
    configFile,
    baseUrl: eff.baseUrl?.dir,
    paths: eff.paths?.entries ?? [],
    pathsBase: eff.baseUrl?.dir ?? (eff.paths ? dirOf(eff.paths.definedIn) : dirOf(configFile)),
  });
  const signature = (s: AliasScope) => JSON.stringify([s.baseUrl ?? null, s.pathsBase, s.paths]);

  // One scope per directory: the directory's tsconfig.json, else jsconfig.json.
  const aliasScopes = new Map<string, AliasScope>();
  for (const file of [...rawConfigs.keys()].sort((a, b) => a.localeCompare(b))) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (base !== "tsconfig.json" && base !== "jsconfig.json") continue;
    const dir = dirOf(file);
    if (base === "jsconfig.json" && rawConfigs.has(dir === "" ? "tsconfig.json" : `${dir}/tsconfig.json`))
      continue;

    const eff = effectiveOf(file, []);
    let scope = scopeFrom(file, eff);
    const raw = rawConfigs.get(file)!;
    if (!eff.baseUrl && !eff.paths && raw.references.length > 0) {
      // A "solution" config (e.g. Vite's template): aliases live in the
      // referenced projects. Use them only if every referenced project that
      // defines aliases agrees — which one applies to a given file would
      // require evaluating include/exclude globs, which is not done here.
      const defining: AliasScope[] = [];
      for (const ref of raw.references) {
        const loc = locateConfig(file, ref, loaded, true);
        if ("outside" in loc || !loc.found || !rawConfigs.has(loc.found)) {
          diagnostics.push({
            file,
            message: `reference "${ref}" was not found in the scan or points outside it`,
          });
          continue;
        }
        const refEff = effectiveOf(loc.found, []);
        if (refEff.baseUrl || refEff.paths) defining.push(scopeFrom(loc.found, refEff));
      }
      const distinct = [...new Map(defining.map((d) => [signature(d), d])).values()];
      if (distinct.length === 1) {
        scope = distinct[0]!;
      } else if (distinct.length > 1) {
        scope = {
          configFile: file,
          paths: distinct.flatMap((d) => d.paths),
          pathsBase: dirOf(file),
          ambiguous: `project references define different path aliases (${defining.map((d) => d.configFile).join(", ")}); which applies to a file is not determined`,
        };
      }
    }
    aliasScopes.set(dir, scope);
  }

  const sortedPackages = packages.sort((a, b) => a.dir.localeCompare(b.dir));
  const packagesByName = new Map<string, LocalPackage[]>();
  for (const pkg of sortedPackages) {
    if (!pkg.name) continue;
    packagesByName.set(pkg.name, [...(packagesByName.get(pkg.name) ?? []), pkg]);
  }

  return {
    aliasScopes,
    packages: sortedPackages,
    packagesByName,
    packagesByDir: new Map(sortedPackages.map((p) => [p.dir, p])),
    diagnostics: diagnostics.slice(0, CONFIG_LIMITS.maxDiagnostics),
  };
}

/** Relative extends/reference targets that exist in the inventory but were not loaded yet. */
export function unloadedConfigTargets(
  loaded: ReadonlyMap<string, string>,
  inventoryFiles: ReadonlySet<string>,
): string[] {
  const want = new Set<string>();
  for (const [file, text] of loaded) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (base === "package.json") continue;
    const parsed = parseTsConfig(file, text, []);
    if (!parsed) continue;
    for (const [target, asRef] of [
      ...parsed.extends.map((t) => [t, false] as const),
      ...parsed.references.map((t) => [t, true] as const),
    ]) {
      if (!target.startsWith("./") && !target.startsWith("../")) continue;
      const loc = locateConfig(file, target, loaded, asRef);
      if ("outside" in loc || loc.found) continue;
      for (const c of loc.candidates) if (inventoryFiles.has(c) && !loaded.has(c)) want.add(c);
    }
  }
  return [...want].sort((a, b) => a.localeCompare(b));
}

/** The alias scope for an importer: its nearest ancestor directory with a config. */
export function aliasScopeFor(config: ResolutionConfig, importer: string): AliasScope | undefined {
  let dir = dirOf(importer);
  for (;;) {
    const scope = config.aliasScopes.get(dir);
    if (scope) return scope;
    if (dir === "") return undefined;
    dir = dirOf(dir);
  }
}

/** The nearest package.json at or above the importer's directory. */
export function packageFor(config: ResolutionConfig, importer: string): LocalPackage | undefined {
  let dir = dirOf(importer);
  for (;;) {
    const pkg = config.packagesByDir.get(dir);
    if (pkg) return pkg;
    if (dir === "") return undefined;
    dir = dirOf(dir);
  }
}
