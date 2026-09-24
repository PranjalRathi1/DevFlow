import path from "node:path";
import {
  EMPTY_RESOLUTION_CONFIG,
  aliasScopeFor,
  joinInRoot,
  packageFor,
  type AliasScope,
  type LocalPackage,
  type ResolutionConfig,
} from "./resolutionConfig.js";

/**
 * Deterministic module resolution against a known file inventory — no
 * filesystem access at all. Resolution is checked against the SNAPSHOT of
 * files a specific scan recorded (`knownFiles`/`knownDirectories`), not
 * live disk state — the scan is the frozen source of truth this batch
 * validates confirmed relationships against (see
 * docs/DECISIONS.md's Batch C2 ADR). All paths are root-relative,
 * forward-slash-normalized strings, matching `scanner.service.ts`'s
 * convention.
 */

export type ResolutionStatus = "confirmed" | "unresolved" | "external" | "unsupported";

export interface ResolvedImport {
  status: ResolutionStatus;
  /** Only set when status is "confirmed". */
  resolvedRelativePath?: string;
  /** Only set when status is "confirmed" — which rule matched, e.g. "exact", "extension:.ts", "index:index.ts", "nodenext:.js->.ts". */
  resolutionMethod?: string;
  /** Short, safe explanation — set for every non-"confirmed" status. */
  reason?: string;
}

// Order matters and is deliberate, not exhaustive: TypeScript-first,
// matching this project's own stack, then plain JS. Anything else (CSS,
// JSON, assets) is handled by the explicit-extension branch below, never
// guessed by appending.
const CANDIDATE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const INDEX_BASENAMES = CANDIDATE_EXTENSIONS.map((ext) => `index${ext}`);
// Extensions a raw import may explicitly name and still be resolved.
// Anything else explicit (`.css`, `.json`, `.svg`, ...) is classified
// "unsupported" outright, regardless of whether such a file exists in the
// inventory — asset/JSON imports have resolution semantics (bundler
// loaders, Node's JSON-as-module support) this batch does not implement
// or test, so claiming to resolve them would overstate what's supported.
const SUPPORTED_EXPLICIT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Batch C2.1 — NodeNext-compatible mapping (see docs/DECISIONS.md's
// ADR-018). Under `moduleResolution: NodeNext`, a TypeScript file writes
// the extension its target will have AFTER compilation (`./foo.js`),
// while the scanned source is `foo.ts`/`foo.tsx`. Keys are the extension
// written in the specifier; values are the source extensions that emit
// to it, in TypeScript's own lookup order. The literal file named by the
// specifier is always a candidate too. Deliberately NOT included:
// `.js` -> `.jsx` (only valid under `allowJs`), `.mjs`/`.cjs` ->
// `.mts`/`.cts`, and `.d.ts` declaration targets — not needed by the
// projects this was verified against, so not claimed.
const NODENEXT_SOURCE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
};
// The mapping is TypeScript compiler semantics, so it only applies when
// the importer itself is TypeScript. A plain `.js` file importing
// `./foo.js` gets `foo.js` or nothing, exactly as before.
const TYPESCRIPT_IMPORTER_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const ALIAS_PREFIXES = ["@/", "~/"];

export interface ScanInventoryIndex {
  files: ReadonlySet<string>;
  directories: ReadonlySet<string>;
}

export function buildInventoryIndex(
  items: readonly { relativePath: string; type: "file" | "directory" }[],
): ScanInventoryIndex {
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const item of items) {
    (item.type === "file" ? files : directories).add(item.relativePath);
  }
  return { files, directories };
}

function isRelativeSpecifier(rawImport: string): boolean {
  return rawImport.startsWith("./") || rawImport.startsWith("../");
}

/**
 * Joins an importer's directory with a relative specifier using POSIX path
 * math (inventory paths are always "/"-separated) and normalizes `.`/`..`
 * segments. Returns `null` if the normalized result climbs above the scan
 * root — a path-traversal attempt or an out-of-root target must never be
 * silently clamped into something else.
 */
function resolveRelativeCandidate(importerRelativePath: string, rawImport: string): string | null {
  const importerDir = path.posix.dirname(importerRelativePath);
  const joined = importerDir === "." ? rawImport : `${importerDir}/${rawImport}`;
  const normalized = path.posix.normalize(joined);
  if (normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized === "." ? "" : normalized;
}

export function resolveImport(
  importerRelativePath: string,
  rawImport: string,
  inventory: ScanInventoryIndex,
  config: ResolutionConfig = EMPTY_RESOLUTION_CONFIG,
): ResolvedImport {
  if (rawImport.startsWith("/")) {
    return { status: "unsupported", reason: "Absolute import paths are not resolved" };
  }

  // Stage 5: ".\\foo" used to fall through to "external package". It is a
  // path, not a package name — but backslash separators are platform-
  // specific (not valid in ESM), so it is not resolved either.
  if (rawImport.includes("\\")) {
    return {
      status: "unsupported",
      reason: "Import specifier uses backslash path separators, which are platform-specific and not resolved",
    };
  }

  const importerIsTs = TYPESCRIPT_IMPORTER_EXTENSIONS.has(path.posix.extname(importerRelativePath));

  if (isRelativeSpecifier(rawImport)) {
    const candidate = resolveRelativeCandidate(importerRelativePath, rawImport);
    if (candidate === null) {
      return { status: "unsupported", reason: "Import target resolves outside the scanned source root" };
    }
    return resolveFileCandidate(
      candidate,
      { directoryOnly: rawImport.endsWith("/"), importerIsTs },
      inventory,
    );
  }

  // ---- Non-relative specifiers (Task 1, ADR-028). Order follows
  // TypeScript/Node: package "#imports", then tsconfig `paths`, then
  // `baseUrl`, then local workspace packages, else external.
  if (rawImport.startsWith("#")) {
    return resolvePackageImports(importerRelativePath, rawImport, importerIsTs, inventory, config);
  }

  const scope = aliasScopeFor(config, importerRelativePath);
  if (scope) {
    const viaPaths = resolveViaPaths(scope, rawImport, importerIsTs, inventory);
    if (viaPaths) return viaPaths;
    if (scope.baseUrl !== undefined) {
      const viaBaseUrl = resolveViaBaseUrl(scope, rawImport, importerIsTs, inventory);
      if (viaBaseUrl) return viaBaseUrl;
    }
  }

  const workspace = resolveWorkspacePackage(rawImport, importerIsTs, inventory, config);
  if (workspace) return workspace;

  if (ALIAS_PREFIXES.some((prefix) => rawImport.startsWith(prefix))) {
    return {
      status: "unsupported",
      reason:
        "No path alias matching this import is configured (tsconfig/jsconfig paths); the alias is not resolved",
    };
  }

  // Bare specifier: "react", "express", "@scope/package" — an external
  // package reference, never treated as a local source file edge.
  return { status: "external", reason: "Bare package specifier, classified as an external dependency" };
}

/**
 * Resolves one scan-relative candidate path with the rules every import
 * kind shares: explicit-extension checks, NodeNext `.js`/`.jsx` mapping
 * (TypeScript importers only, ambiguity = unresolved), exact match,
 * extension appending, index files, and the case-mismatch diagnostic.
 */
function resolveFileCandidate(
  candidate: string,
  opts: { directoryOnly: boolean; importerIsTs: boolean },
  inventory: ScanInventoryIndex,
): ResolvedImport {
  // Stage 5: a trailing slash names a DIRECTORY ("./lib/"), so only index
  // resolution applies — never a file named "lib" or "lib.ts".
  if (opts.directoryOnly) {
    const dir = candidate.replace(/\/+$/, "");
    const index = inventory.directories.has(dir) ? resolveIndex(dir, inventory) : undefined;
    if (index) return index;
    return {
      status: "unresolved",
      reason: inventory.directories.has(dir)
        ? "Resolved to a directory with no supported index file"
        : "Specifier names a directory (trailing slash) that is not in the scanned inventory",
    };
  }

  const explicitExt = path.posix.extname(candidate);
  if (explicitExt && !SUPPORTED_EXPLICIT_EXTENSIONS.has(explicitExt)) {
    return {
      status: "unsupported",
      reason: `Import target has an extension outside supported resolution rules (${explicitExt})`,
    };
  }

  // 0. NodeNext emitted-extension mapping (Batch C2.1). Every candidate —
  // the literal file plus each mapped source file — is checked, and only
  // a single match is confirmed. Two or more (e.g. both `foo.js` and
  // `foo.ts`) is a genuine conflict: TypeScript would bind to `foo.ts`
  // while Node would load `foo.js` at runtime, so neither is picked.
  let nodeNextUnresolvedReason: string | undefined;
  const nodeNextSources = NODENEXT_SOURCE_EXTENSIONS[explicitExt];
  if (nodeNextSources) {
    const base = candidate.slice(0, -explicitExt.length);
    const mapped = nodeNextSources.map((ext) => ({ ext, path: `${base}${ext}` }));
    if (opts.importerIsTs) {
      const matches = [candidate, ...mapped.map((m) => m.path)].filter((p) => inventory.files.has(p));
      if (matches.length > 1) {
        return {
          status: "unresolved",
          reason: `Ambiguous NodeNext mapping — multiple candidate files exist (${matches.join(", ")})`,
        };
      }
      const [match] = matches;
      if (match === candidate) {
        return { status: "confirmed", resolvedRelativePath: candidate, resolutionMethod: "exact" };
      }
      const mappedMatch = mapped.find((m) => m.path === match);
      if (mappedMatch) {
        return {
          status: "confirmed",
          resolvedRelativePath: mappedMatch.path,
          resolutionMethod: `nodenext:${explicitExt}->${mappedMatch.ext}`,
        };
      }
      nodeNextUnresolvedReason = `No matching file found in the scanned inventory (NodeNext candidates checked: ${[explicitExt, ...nodeNextSources].join(", ")})`;
    } else if (!inventory.files.has(candidate) && mapped.some((m) => inventory.files.has(m.path))) {
      nodeNextUnresolvedReason =
        "Only a TypeScript source counterpart exists; NodeNext mapping is applied to TypeScript importers only";
    }
  }

  // 1. Exact match — the raw specifier (after normalization), unchanged,
  // matches a known file. Never a guess: the string names a real file.
  if (inventory.files.has(candidate)) {
    return { status: "confirmed", resolvedRelativePath: candidate, resolutionMethod: "exact" };
  }

  // 2. Extension appending — only when the specifier had none, and only
  // through the explicit, ordered list above.
  if (!explicitExt) {
    for (const ext of CANDIDATE_EXTENSIONS) {
      const withExt = `${candidate}${ext}`;
      if (inventory.files.has(withExt)) {
        return { status: "confirmed", resolvedRelativePath: withExt, resolutionMethod: `extension:${ext}` };
      }
    }
  }

  // 3. Index-file resolution — only when the specifier (with or without
  // matching an extension above) names a real directory in the inventory.
  if (inventory.directories.has(candidate)) {
    return (
      resolveIndex(candidate, inventory) ?? {
        status: "unresolved",
        reason: "Resolved to a directory with no supported index file",
      }
    );
  }

  const base = nodeNextUnresolvedReason ?? "No matching file found in the scanned inventory";
  const caseHint = caseMismatch(candidate, explicitExt, inventory);
  return {
    status: "unresolved",
    reason: caseHint
      ? `${base}. A file differing only in letter case exists (${caseHint}); not resolved, because case-sensitive systems would not find it`
      : base,
  };
}

const isAmbiguity = (r: ResolvedImport) => r.status === "unresolved" && /Ambiguous/.test(r.reason ?? "");

/** Prefixes a confirmed inner resolution with how the candidate was derived. */
function via(outer: string, inner: ResolvedImport): ResolvedImport {
  return { ...inner, resolutionMethod: `${outer}; ${inner.resolutionMethod}` };
}

/**
 * TypeScript's `paths` matching: an exact (star-less) key wins; otherwise
 * the wildcard key with the longest prefix (first such key on ties,
 * config order). Returns the substitutions with "*" filled in.
 */
function matchPattern(
  patterns: readonly { pattern: string; targets: readonly string[] }[],
  specifier: string,
): { pattern: string; substitutions: string[] } | undefined {
  const exact = patterns.find((p) => !p.pattern.includes("*") && p.pattern === specifier);
  if (exact) return { pattern: exact.pattern, substitutions: [...exact.targets] };
  let best: { pattern: string; targets: readonly string[]; captured: string; prefix: number } | undefined;
  for (const p of patterns) {
    const star = p.pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = p.pattern.slice(0, star);
    const suffix = p.pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (!best || prefix.length > best.prefix)
    ) {
      best = {
        pattern: p.pattern,
        targets: p.targets,
        captured: specifier.slice(prefix.length, specifier.length - suffix.length),
        prefix: prefix.length,
      };
    }
  }
  if (!best) return undefined;
  const captured = best.captured;
  return { pattern: best.pattern, substitutions: best.targets.map((t) => t.replace("*", captured)) };
}

function resolveViaPaths(
  scope: AliasScope,
  rawImport: string,
  importerIsTs: boolean,
  inventory: ScanInventoryIndex,
): ResolvedImport | undefined {
  const match = matchPattern(scope.paths, rawImport);
  if (!match) return undefined;
  if (scope.ambiguous) {
    return { status: "unresolved", reason: `Path alias "${match.pattern}" matched, but ${scope.ambiguous}` };
  }
  const tried: string[] = [];
  const hints: string[] = [];
  let outside = 0;
  // Substitutions in config order; the first that resolves wins — exactly
  // TypeScript's rule, which bundlers and tsconfig-paths also follow.
  for (const sub of match.substitutions) {
    const candidate = joinInRoot(scope.pathsBase, sub);
    if (candidate === null) {
      outside += 1;
      continue;
    }
    tried.push(candidate);
    const r = resolveFileCandidate(candidate, { directoryOnly: sub.endsWith("/"), importerIsTs }, inventory);
    if (r.status === "confirmed") return via(`alias:${match.pattern} via ${scope.configFile}`, r);
    if (isAmbiguity(r) || r.status === "unsupported") {
      return { ...r, reason: `Path alias "${match.pattern}" (${scope.configFile}): ${r.reason}` };
    }
    if (r.reason?.includes("letter case")) hints.push(r.reason);
  }
  if (tried.length === 0 && outside > 0) {
    return {
      status: "unsupported",
      reason: `Path alias "${match.pattern}" (${scope.configFile}) maps outside the scanned root`,
    };
  }
  // A catch-all "*" pattern falls through to normal resolution, as in TS
  // (e.g. "react" under "*": ["src/*"] is still an installed package).
  if (match.pattern === "*") return undefined;
  return {
    status: "unresolved",
    reason: `Path alias "${match.pattern}" (${scope.configFile}) matched but no target exists in the scan (tried: ${tried.join(", ")})${hints.length ? `. ${hints.join(" ")}` : ""}`,
  };
}

function resolveViaBaseUrl(
  scope: AliasScope,
  rawImport: string,
  importerIsTs: boolean,
  inventory: ScanInventoryIndex,
): ResolvedImport | undefined {
  const candidate = joinInRoot(scope.baseUrl ?? "", rawImport);
  if (candidate === null) return undefined;
  const r = resolveFileCandidate(
    candidate,
    { directoryOnly: rawImport.endsWith("/"), importerIsTs },
    inventory,
  );
  if (r.status === "confirmed") return via(`baseUrl via ${scope.configFile}`, r);
  if (isAmbiguity(r)) return { ...r, reason: `baseUrl (${scope.configFile}): ${r.reason}` };
  // Not found under baseUrl: TypeScript continues to node_modules lookup.
  return undefined;
}

/** "@scope/name/sub/path" -> { name: "@scope/name", subpath: "./sub/path" }. */
function splitPackageSpecifier(spec: string): { name: string; subpath: string } | undefined {
  const parts = spec.split("/");
  const nameParts = spec.startsWith("@") ? 2 : 1;
  if (parts.length < nameParts || parts.slice(0, nameParts).some((p) => p === "")) return undefined;
  const rest = parts.slice(nameParts).join("/");
  return { name: parts.slice(0, nameParts).join("/"), subpath: rest ? `./${rest}` : "." };
}

type TargetLeaf = { conditions: string; target: string };
type TargetLookup =
  | { kind: "leaves"; key: string; leaves: TargetLeaf[] }
  | { kind: "none" }
  | { kind: "excluded"; key: string }
  | { kind: "unsupported"; reason: string };

/** Flattens a conditional export/import value into (condition path, target) leaves, in declaration order. */
function flattenTarget(
  value: unknown,
  captured: string | undefined,
  conditions: string[] = [],
): TargetLeaf[] | "null" | "array" {
  if (value === null) return "null";
  if (typeof value === "string") {
    return [
      {
        conditions: conditions.join(".") || "default",
        target: captured !== undefined ? value.replaceAll("*", captured) : value,
      },
    ];
  }
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    const out: TargetLeaf[] = [];
    for (const [cond, v] of Object.entries(value as Record<string, unknown>)) {
      const sub = flattenTarget(v, captured, [...conditions, cond]);
      if (sub === "array") return "array";
      if (sub !== "null") out.push(...sub);
    }
    return out;
  }
  return [];
}

/** Node's exports/imports map lookup (exact key, else single-"*" key with the longest prefix). */
function lookupMap(map: unknown, key: string, keyPrefix: "." | "#"): TargetLookup {
  if (map === undefined) return { kind: "none" };
  let entries: Record<string, unknown>;
  if (typeof map === "string" || Array.isArray(map) || map === null) {
    if (keyPrefix !== "." || key !== ".") return { kind: "none" };
    entries = { ".": map };
  } else if (typeof map === "object") {
    const keys = Object.keys(map as object);
    const isSubpathMap = keys.some((k) => k.startsWith(keyPrefix));
    if (isSubpathMap && keys.some((k) => !k.startsWith(keyPrefix))) {
      return { kind: "unsupported", reason: `invalid map: mixes "${keyPrefix}" keys and condition keys` };
    }
    entries = isSubpathMap ? (map as Record<string, unknown>) : keyPrefix === "." ? { ".": map } : {};
  } else {
    return { kind: "none" };
  }

  let chosen: { key: string; value: unknown; captured?: string } | undefined;
  if (key in entries) chosen = { key, value: entries[key] };
  else {
    let bestPrefix = -1;
    for (const [k, v] of Object.entries(entries)) {
      const star = k.indexOf("*");
      if (star < 0 || k.indexOf("*", star + 1) >= 0) continue;
      const prefix = k.slice(0, star);
      const suffix = k.slice(star + 1);
      if (
        key.length >= k.length &&
        key.startsWith(prefix) &&
        key.endsWith(suffix) &&
        prefix.length > bestPrefix
      ) {
        bestPrefix = prefix.length;
        chosen = { key: k, value: v, captured: key.slice(prefix.length, key.length - suffix.length) };
      }
    }
  }
  if (!chosen) return { kind: "none" };
  const leaves = flattenTarget(chosen.value, chosen.captured);
  if (leaves === "null") return { kind: "excluded", key: chosen.key };
  if (leaves === "array")
    return { kind: "unsupported", reason: `fallback arrays in "${chosen.key}" are not supported` };
  return { kind: "leaves", key: chosen.key, leaves };
}

/**
 * Resolves map leaves inside one package directory. Confirmed only when
 * every leaf that resolves in the scan resolves to the SAME file; leaves
 * pointing to different files are a genuine ambiguity (different
 * runtimes/conditions pick differently) and stay unresolved.
 */
function resolveLeaves(
  pkg: LocalPackage,
  leaves: readonly TargetLeaf[],
  importerIsTs: boolean,
  inventory: ScanInventoryIndex,
  label: string,
): ResolvedImport {
  const found = new Map<string, { conditions: string[]; inner: ResolvedImport }>();
  const notFound: string[] = [];
  for (const leaf of leaves) {
    if (!leaf.target.startsWith("./")) {
      return {
        status: "unsupported",
        reason: `${label}: target "${leaf.target}" is not package-relative ("./...")`,
      };
    }
    const candidate = joinInRoot(pkg.dir, leaf.target);
    if (
      candidate === null ||
      (pkg.dir !== "" && candidate !== pkg.dir && !candidate.startsWith(`${pkg.dir}/`))
    ) {
      return {
        status: "unsupported",
        reason: `${label}: target "${leaf.target}" escapes the package directory`,
      };
    }
    const r = resolveFileCandidate(
      candidate,
      { directoryOnly: leaf.target.endsWith("/"), importerIsTs },
      inventory,
    );
    if (isAmbiguity(r)) return { ...r, reason: `${label}: ${r.reason}` };
    if (r.status === "confirmed" && r.resolvedRelativePath) {
      const entry = found.get(r.resolvedRelativePath) ?? { conditions: [], inner: r };
      entry.conditions.push(leaf.conditions);
      found.set(r.resolvedRelativePath, entry);
    } else {
      notFound.push(`${leaf.conditions}: ${leaf.target}`);
    }
  }
  if (found.size > 1) {
    const detail = [...found.entries()].map(([file, e]) => `${e.conditions.join("/")} -> ${file}`).join("; ");
    return {
      status: "unresolved",
      reason: `${label}: conditions resolve to different files (${detail}); not picked`,
    };
  }
  const only = [...found.values()][0];
  if (!only) {
    return {
      status: "unresolved",
      reason: `${label}: no target exists in the scan (${notFound.join(", ")}); it may point to build output`,
    };
  }
  const coverage = notFound.length
    ? ` (${leaves.length - notFound.length} of ${leaves.length} conditions found in scan)`
    : "";
  return via(`${label} [${only.conditions.join("/")}]${coverage}`, only.inner);
}

function resolvePackageImports(
  importer: string,
  rawImport: string,
  importerIsTs: boolean,
  inventory: ScanInventoryIndex,
  config: ResolutionConfig,
): ResolvedImport {
  const pkg = packageFor(config, importer);
  if (!pkg || pkg.imports === undefined) {
    return {
      status: "unresolved",
      reason: `"${rawImport}" is a package import ("#"), but no enclosing package.json in the scan defines "imports"`,
    };
  }
  const found = lookupMap(pkg.imports, rawImport, "#");
  if (found.kind === "none") {
    return { status: "unresolved", reason: `No "imports" entry in ${pkg.file} matches "${rawImport}"` };
  }
  if (found.kind === "excluded") {
    return {
      status: "unresolved",
      reason: `"imports" entry "${found.key}" in ${pkg.file} is null (excluded)`,
    };
  }
  if (found.kind === "unsupported") return { status: "unsupported", reason: `${pkg.file}: ${found.reason}` };
  // A "#" import may map to an installed package rather than a local file.
  if (found.leaves.every((l) => !l.target.startsWith("./") && !l.target.startsWith("/"))) {
    return { status: "external", reason: `"imports" entry "${found.key}" in ${pkg.file} maps to a package` };
  }
  return resolveLeaves(
    pkg,
    found.leaves,
    importerIsTs,
    inventory,
    `package-imports:${found.key} via ${pkg.file}`,
  );
}

function resolveWorkspacePackage(
  rawImport: string,
  importerIsTs: boolean,
  inventory: ScanInventoryIndex,
  config: ResolutionConfig,
): ResolvedImport | undefined {
  const spec = splitPackageSpecifier(rawImport);
  if (!spec) return undefined;
  const candidates = config.packagesByName.get(spec.name);
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length > 1) {
    return {
      status: "unresolved",
      reason: `Several local packages are named "${spec.name}" (${candidates.map((p) => p.file).join(", ")}); not picked`,
    };
  }
  const pkg = candidates[0]!;
  const label = `workspace:${spec.name} via ${pkg.file}`;

  if (pkg.exports !== undefined) {
    // With "exports", ONLY exported subpaths are reachable (Node semantics).
    const found = lookupMap(pkg.exports, spec.subpath, ".");
    if (found.kind === "none") {
      return { status: "unresolved", reason: `${label}: subpath "${spec.subpath}" is not exported` };
    }
    if (found.kind === "excluded") {
      return {
        status: "unresolved",
        reason: `${label}: subpath "${found.key}" is excluded (null) in exports`,
      };
    }
    if (found.kind === "unsupported") return { status: "unsupported", reason: `${label}: ${found.reason}` };
    return resolveLeaves(pkg, found.leaves, importerIsTs, inventory, `${label}; exports["${found.key}"]`);
  }

  if (spec.subpath !== ".") {
    const candidate = joinInRoot(pkg.dir, spec.subpath);
    if (candidate === null)
      return { status: "unsupported", reason: `${label}: subpath escapes the scanned root` };
    const r = resolveFileCandidate(
      candidate,
      { directoryOnly: rawImport.endsWith("/"), importerIsTs },
      inventory,
    );
    return r.status === "confirmed" ? via(label, r) : { ...r, reason: `${label}: ${r.reason}` };
  }

  // Package root without "exports": the entry fields, then an index file.
  const fields = (["types", "module", "main"] as const)
    .filter((f) => typeof pkg[f] === "string")
    .map((f) => ({ conditions: f, target: pkg[f]!.startsWith("./") ? pkg[f]! : `./${pkg[f]!}` }));
  if (fields.length > 0) return resolveLeaves(pkg, fields, importerIsTs, inventory, label);
  const index = resolveIndex(pkg.dir, inventory);
  return index
    ? via(`${label}; no entry fields`, index)
    : { status: "unresolved", reason: `${label}: no entry field and no index file in the scan` };
}

function resolveIndex(dir: string, inventory: ScanInventoryIndex): ResolvedImport | undefined {
  for (const indexName of INDEX_BASENAMES) {
    const indexPath = dir === "" ? indexName : `${dir}/${indexName}`;
    if (inventory.files.has(indexPath)) {
      return { status: "confirmed", resolvedRelativePath: indexPath, resolutionMethod: `index:${indexName}` };
    }
  }
  return undefined;
}

/**
 * Stage 5 diagnostic only — never a resolution: the first inventory file
 * (sorted, so deterministic) that equals one of the candidates tried when
 * compared case-insensitively.
 */
function caseMismatch(
  candidate: string,
  explicitExt: string,
  inventory: ScanInventoryIndex,
): string | undefined {
  const base = explicitExt ? candidate.slice(0, -explicitExt.length) : candidate;
  const tried = new Set(
    [
      candidate,
      ...(explicitExt ? (NODENEXT_SOURCE_EXTENSIONS[explicitExt] ?? []).map((ext) => `${base}${ext}`) : []),
      ...(explicitExt ? [] : CANDIDATE_EXTENSIONS.map((ext) => `${candidate}${ext}`)),
    ].map((c) => c.toLowerCase()),
  );
  return [...inventory.files].sort().find((f) => tried.has(f.toLowerCase()));
}

export interface PackageEntryPoint {
  file: string;
  /** Which package.json fields declare it, e.g. `exports["."] [import]`, `main`, `bin.cli`. */
  fields: string[];
}

/**
 * Task 2 (ADR-029): the in-scan files a package.json DECLARES as entry
 * points — non-wildcard `exports` subpaths, `main`/`module`/`types`, and
 * `bin` — resolved with the same file rules as imports (no NodeNext
 * mapping: a declared `dist/x.js` is build output, not `src/x.ts`).
 * Targets outside the package directory or missing from the scan produce
 * nothing. Sorted by file; fields sorted.
 */
export function packageEntryPoints(pkg: LocalPackage, inventory: ScanInventoryIndex): PackageEntryPoint[] {
  const declared: { field: string; target: string; strict: boolean }[] = [];
  const e = pkg.exports;
  if (e !== undefined && e !== null) {
    const isSubpathMap =
      typeof e === "object" && !Array.isArray(e) && Object.keys(e).some((k) => k.startsWith("."));
    const entries: [string, unknown][] = isSubpathMap ? Object.entries(e as object) : [[".", e]];
    for (const [key, value] of entries) {
      if (key.includes("*")) continue;
      const leaves = flattenTarget(value, undefined);
      if (!Array.isArray(leaves)) continue;
      for (const leaf of leaves) {
        declared.push({ field: `exports["${key}"] [${leaf.conditions}]`, target: leaf.target, strict: true });
      }
    }
  }
  for (const f of ["main", "module", "types"] as const) {
    const v = pkg[f];
    if (typeof v === "string") declared.push({ field: f, target: v, strict: false });
  }
  if (typeof pkg.bin === "string") declared.push({ field: "bin", target: pkg.bin, strict: false });
  else if (pkg.bin && typeof pkg.bin === "object" && !Array.isArray(pkg.bin)) {
    for (const [name, v] of Object.entries(pkg.bin as Record<string, unknown>)) {
      if (typeof v === "string") declared.push({ field: `bin.${name}`, target: v, strict: false });
    }
  }

  const found = new Map<string, Set<string>>();
  for (const { field, target, strict } of declared) {
    if (strict && !target.startsWith("./")) continue;
    const rel = target.startsWith("./") ? target : `./${target}`;
    const candidate = joinInRoot(pkg.dir, rel);
    if (candidate === null || (pkg.dir !== "" && !candidate.startsWith(`${pkg.dir}/`))) continue;
    const r = resolveFileCandidate(candidate, { directoryOnly: false, importerIsTs: false }, inventory);
    if (r.status !== "confirmed" || !r.resolvedRelativePath) continue;
    found.set(r.resolvedRelativePath, (found.get(r.resolvedRelativePath) ?? new Set()).add(field));
  }
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, fields]) => ({ file, fields: [...fields].sort((a, b) => a.localeCompare(b)) }));
}
