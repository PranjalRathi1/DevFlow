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
  /** Only set when status is "confirmed" — which rule matched, e.g. "exact", "extension:.ts", "index:index.ts". */
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

  if (!isRelativeSpecifier(rawImport)) {
    // Bare specifier: "react", "express", "@scope/package" — an external
    // package reference, never treated as a local source file edge.
    return { status: "external", reason: "Bare package specifier, classified as an external dependency" };
  }

  const candidate = resolveRelativeCandidate(importerRelativePath, rawImport);
  if (candidate === null) {
    return { status: "unsupported", reason: "Import target resolves outside the scanned source root" };
  }

  const explicitExt = path.posix.extname(candidate);
  if (explicitExt && !SUPPORTED_EXPLICIT_EXTENSIONS.has(explicitExt)) {
    return {
      status: "unsupported",
      reason: `Import target has an extension outside supported resolution rules (${explicitExt})`,
    };
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
    for (const indexName of INDEX_BASENAMES) {
      const indexPath = candidate === "" ? indexName : `${candidate}/${indexName}`;
      if (inventory.files.has(indexPath)) {
        return {
          status: "confirmed",
          resolvedRelativePath: indexPath,
          resolutionMethod: `index:${indexName}`,
        };
      }
    }
    return { status: "unresolved", reason: "Resolved to a directory with no supported index file" };
  }

  return { status: "unresolved", reason: "No matching file found in the scanned inventory" };
}
