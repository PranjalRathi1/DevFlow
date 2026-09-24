import path from "node:path";

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

function isAliasSpecifier(rawImport: string): boolean {
  return ALIAS_PREFIXES.some((prefix) => rawImport.startsWith(prefix)) || rawImport.startsWith("/");
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
): ResolvedImport {
  if (isAliasSpecifier(rawImport)) {
    return { status: "unsupported", reason: "Alias/absolute import resolution is not implemented" };
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

  if (!isRelativeSpecifier(rawImport)) {
    // Bare specifier: "react", "express", "@scope/package" — an external
    // package reference, never treated as a local source file edge.
    return { status: "external", reason: "Bare package specifier, classified as an external dependency" };
  }

  const normalizedCandidate = resolveRelativeCandidate(importerRelativePath, rawImport);
  if (normalizedCandidate === null) {
    return { status: "unsupported", reason: "Import target resolves outside the scanned source root" };
  }

  // Stage 5: a trailing slash names a DIRECTORY ("./lib/"), so only index
  // resolution applies — never a file named "lib" or "lib.ts".
  if (rawImport.endsWith("/")) {
    const dir = normalizedCandidate.replace(/\/+$/, "");
    const index = inventory.directories.has(dir) ? resolveIndex(dir, inventory) : undefined;
    if (index) return index;
    return {
      status: "unresolved",
      reason: inventory.directories.has(dir)
        ? "Resolved to a directory with no supported index file"
        : "Specifier names a directory (trailing slash) that is not in the scanned inventory",
    };
  }
  const candidate = normalizedCandidate;

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
    if (TYPESCRIPT_IMPORTER_EXTENSIONS.has(path.posix.extname(importerRelativePath))) {
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
