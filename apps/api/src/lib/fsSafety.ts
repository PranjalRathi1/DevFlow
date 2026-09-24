import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Path-safety primitives for anything that reads from a user-configured
 * local directory (project source import — see docs/PRODUCT_SCOPE_LOCAL.md).
 * Nothing here writes, deletes, renames, or executes anything — this module
 * only decides whether a read is safe to perform.
 *
 * Two distinct trust boundaries, deliberately handled differently:
 *  1. The configured ROOT itself (`resolveScanRoot`) is explicitly chosen by
 *     the authenticated project owner — it's fully canonicalized (symlinks
 *     in the path resolved) once, at configuration time, because the user
 *     is intentionally pointing here.
 *  2. Entries discovered WHILE TRAVERSING that root (see
 *     services/scanner.service.ts) are never followed if they're symlinks —
 *     a directory tree can contain links placed by anything (a build tool,
 *     a git checkout, untrusted generated content) that could otherwise
 *     walk the scanner outside the root the user actually approved.
 */

export type FsSafetyErrorCode =
  "invalid_path" | "unc_not_supported" | "not_found" | "not_a_directory" | "outside_root" | "root_changed";

export class FsSafetyError extends Error {
  readonly code: FsSafetyErrorCode;
  constructor(message: string, code: FsSafetyErrorCode) {
    super(message);
    this.name = "FsSafetyError";
    this.code = code;
  }
}

// A leading `\\` (after normalizing `/` to `\`) covers UNC shares
// (`\\server\share\...`), device paths (`\\.\...`), and extended-length
// paths (`\\?\...`). Policy: reject all of them. Network shares complicate
// the read-only/availability guarantees this module makes (permissions,
// latency, drive-mapping ambiguity), and there's no product requirement
// driving support for them yet — see docs/DECISIONS.md.
function isUncOrDevicePath(rawPath: string): boolean {
  return rawPath.replace(/\//g, "\\").startsWith("\\\\");
}

/**
 * Validates and canonicalizes a user-supplied path for use as a scan root.
 * Rejects anything that isn't an existing, real (non-UNC) directory.
 * Relative input is resolved against the current process's working
 * directory — callers passing user input should generally require an
 * absolute path, since "relative to the API server process" is rarely
 * what a user means, but relative segments (`.`, `..`) inside an otherwise
 * absolute path are handled correctly either way via `path.resolve`.
 */
export async function resolveScanRoot(rawPath: string): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new FsSafetyError("A source path is required", "invalid_path");
  }
  if (isUncOrDevicePath(rawPath)) {
    throw new FsSafetyError("UNC and device paths are not supported", "unc_not_supported");
  }

  const absolute = path.resolve(rawPath);

  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    throw new FsSafetyError("Source path does not exist or is not accessible", "not_found");
  }

  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    throw new FsSafetyError("Source path does not exist or is not accessible", "not_found");
  }

  if (!stat.isDirectory()) {
    throw new FsSafetyError("Source path must be a directory, not a file", "not_a_directory");
  }

  return real;
}

/**
 * True boundary check — NOT a `startsWith` string comparison, which is
 * unsafe (`C:\Projects\App-Outside` would incorrectly appear "inside"
 * `C:\Projects\App` under a naive prefix check). `path.relative` computes
 * an actual path-segment-aware relationship: if the result climbs upward
 * (`..`) or is itself absolute (e.g. a different Windows drive), the
 * candidate is not inside the root.
 */
export function isPathInsideRoot(root: string, candidateAbsolute: string): boolean {
  const rel = path.relative(root, candidateAbsolute);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Joins a root with a relative child path and asserts the result is still
 * inside the root, throwing rather than silently clamping. Used by the
 * scanner when constructing child paths from directory-entry names it read
 * — a defense-in-depth check, since real filesystem entry names can't
 * themselves contain path separators or `..`.
 */
export function resolveSafeChild(root: string, relativeChild: string): string {
  const candidate = path.resolve(root, relativeChild);
  if (!isPathInsideRoot(root, candidate)) {
    throw new FsSafetyError(`Path escapes the configured source root: ${relativeChild}`, "outside_root");
  }
  return candidate;
}

/**
 * Re-validates an ALREADY-canonicalized root at scan time (as opposed to
 * `resolveScanRoot`, which is for a fresh, user-supplied path at
 * configuration time). Deliberately does NOT call `fs.realpath` again:
 * `realpath` always resolves symlinks in the final path component too, so
 * re-resolving a stored canonical path would silently follow it if the
 * path has since been replaced by a symlink — exactly the kind of
 * substitution the traversal's own "never follow a symlink" policy exists
 * to prevent, just applied to the root itself instead of an entry found
 * during traversal. `lstat` (not `stat`/`realpath`) confirms the exact
 * path is still what it was approved as: a real directory, not a symlink.
 */
export async function revalidateScanRoot(canonicalPath: string): Promise<string> {
  let lst;
  try {
    lst = await fs.lstat(canonicalPath);
  } catch {
    throw new FsSafetyError("Source path does not exist or is not accessible", "not_found");
  }
  if (lst.isSymbolicLink()) {
    throw new FsSafetyError(
      "The configured source path has changed (it is now a symlink) and must be reconfigured",
      "root_changed",
    );
  }
  if (!lst.isDirectory()) {
    throw new FsSafetyError("Source path must be a directory, not a file", "not_a_directory");
  }
  return canonicalPath;
}
