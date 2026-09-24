import path from "node:path";
import { promises as fs } from "node:fs";
import { classifyFile, shouldIgnoreDirectory, type FileCategory } from "../lib/fileClassification.js";
import { resolveSafeChild } from "../lib/fsSafety.js";
import { logger } from "../utils/logger.js";

export type ScanItemType = "file" | "directory";
export type ScanItemStatus = "scanned" | "skipped" | "error";
export type SkipReason = "symlink" | "ignored" | "too_large" | "limit_reached";
export type ScanErrorCategory = "read_error";
export type ScanOutcome = "completed" | "completed_with_warnings" | "failed";

export interface ScanItem {
  relativePath: string;
  type: ScanItemType;
  category?: FileCategory;
  language?: string;
  extension?: string;
  sizeBytes?: number;
  status: ScanItemStatus;
  skipReason?: SkipReason;
  errorCategory?: ScanErrorCategory;
  errorMessage?: string;
}

export interface ScanSummary {
  totalScanned: number;
  totalSkipped: number;
  totalErrors: number;
  filesByCategory: Record<string, number>;
  filesByLanguage: Record<string, number>;
  limitsReached: string[];
  durationMs: number;
}

export interface ScanResult {
  outcome: ScanOutcome;
  summary: ScanSummary;
  items: ScanItem[];
  errorMessage?: string;
}

export interface ScanLimits {
  maxFileSizeBytes: number;
  maxFiles: number;
  maxDepth: number;
  maxDirectories: number;
  maxDurationMs: number;
}

interface QueueEntry {
  absolutePath: string;
  relativePath: string;
  depth: number;
}

/**
 * Traverses `root` and produces a deterministic, read-only inventory.
 * Never writes, deletes, renames, or executes anything under `root`, and
 * never follows a symlink/junction found during traversal (see
 * lib/fsSafety.ts's two-trust-boundary comment — `root` itself was already
 * canonicalized when configured; entries discovered while walking it are
 * a different, untrusted boundary).
 *
 * Synchronous within this one call — there is no background job system or
 * cancellation endpoint in this batch (see docs/IMPLEMENTATION_LOG.md's
 * Batch C1 entry). `maxDurationMs` is a cooperative, best-effort limit
 * checked between directory entries; it cannot abort a single in-flight
 * `fs` call already in progress.
 */
export async function scanDirectory(root: string, limits: ScanLimits): Promise<ScanResult> {
  const startedAt = Date.now();
  const items: ScanItem[] = [];
  const summary: ScanSummary = {
    totalScanned: 0,
    totalSkipped: 0,
    totalErrors: 0,
    filesByCategory: {},
    filesByLanguage: {},
    limitsReached: [],
    durationMs: 0,
  };

  function noteLimit(name: string): void {
    if (!summary.limitsReached.includes(name)) summary.limitsReached.push(name);
  }

  // Root itself is included as an item for completeness/traceability.
  items.push({ relativePath: ".", type: "directory", status: "scanned" });
  summary.totalScanned += 1;

  // Explicit stack (not recursion) so deep trees can't blow the call stack,
  // and directories are processed depth-first with siblings pre-sorted at
  // each level for deterministic output — plain string comparison (UTF-16
  // code unit order), not locale-aware, so behavior doesn't vary by the
  // server's OS locale settings. `sortEntries` can itself throw
  // (`resolveSafeChild`'s defense-in-depth boundary check) — practically
  // unreachable with real OS-supplied entry names, but caught here anyway
  // so an anomaly can't crash the whole scan with an unhandled exception;
  // it's folded into the same "can't safely read this directory" outcome
  // as a real readdir failure.
  let stack: QueueEntry[];
  try {
    const rootEntries = await fs.readdir(root, { withFileTypes: true });
    stack = sortEntries(rootEntries, root, "").reverse();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "Scan failed reading root directory");
    return {
      outcome: "failed",
      summary: { ...summary, durationMs: Date.now() - startedAt },
      items: [],
      errorMessage: "Could not read the configured source directory",
    };
  }
  let directoriesVisited = 1; // root counts as one

  while (stack.length > 0) {
    if (Date.now() - startedAt > limits.maxDurationMs) {
      noteLimit("maxDurationMs");
      break;
    }
    if (items.length >= limits.maxFiles) {
      noteLimit("maxFiles");
      break;
    }

    const entry = stack.pop();
    if (!entry) break;

    let lst;
    try {
      // lstat, never stat — stat would follow a symlink to read its
      // target's metadata, which is exactly the interaction with
      // untrusted-tree symlinks this scanner avoids.
      lst = await fs.lstat(entry.absolutePath);
    } catch (err) {
      // Type unknown (couldn't stat it) — "file" is a reporting default,
      // not a claim; this is a rare TOCTOU race (readdir saw it, then it
      // was removed/became inaccessible before lstat ran).
      items.push({
        relativePath: entry.relativePath,
        type: "file",
        status: "error",
        errorCategory: "read_error",
        errorMessage: safeErrorMessage(err),
      });
      summary.totalErrors += 1;
      continue;
    }

    if (lst.isSymbolicLink()) {
      // Deliberately not resolved further (no stat on the link target) —
      // whether it points at a file or directory is never determined, so
      // "file" here is a reporting placeholder, not a claim.
      items.push({
        relativePath: entry.relativePath,
        type: "file",
        status: "skipped",
        skipReason: "symlink",
      });
      summary.totalSkipped += 1;
      continue;
    }

    if (lst.isDirectory()) {
      const dirName = path.basename(entry.relativePath);
      if (shouldIgnoreDirectory(dirName)) {
        items.push({
          relativePath: entry.relativePath,
          type: "directory",
          status: "skipped",
          skipReason: "ignored",
        });
        summary.totalSkipped += 1;
        continue;
      }
      // `entry.depth` counts levels below root, starting at 1 for root's
      // direct children. A directory AT the limit is itself recorded (as
      // skipped/limit_reached) but never descended into — so maxDepth=1
      // means root's immediate children are reported but nothing beneath
      // them is ever discovered.
      if (entry.depth >= limits.maxDepth) {
        items.push({
          relativePath: entry.relativePath,
          type: "directory",
          status: "skipped",
          skipReason: "limit_reached",
        });
        summary.totalSkipped += 1;
        noteLimit("maxDepth");
        continue;
      }
      if (directoriesVisited >= limits.maxDirectories) {
        items.push({
          relativePath: entry.relativePath,
          type: "directory",
          status: "skipped",
          skipReason: "limit_reached",
        });
        summary.totalSkipped += 1;
        noteLimit("maxDirectories");
        continue;
      }

      // The directory's own item is recorded exactly once, AFTER we know
      // whether it can actually be read — not optimistically as "scanned"
      // before attempting readdir. Recording it twice (once scanned, once
      // error) would violate "no duplicate records per path" the moment
      // readdir fails partway through, which is exactly what happened
      // here before this fix (caught by a mocked-readdir-failure test,
      // not by inspection — see docs/IMPLEMENTATION_LOG.md).
      directoriesVisited += 1;

      // Both the readdir call and sortEntries (see the root-level comment
      // above for why) can throw — either way this directory becomes
      // unreadable and traversal continues with its siblings, rather than
      // the whole scan crashing. Both are computed BEFORE recording the
      // directory's own item, so a failure in either produces exactly one
      // "error" item, never a "scanned" item followed by a second "error"
      // item for the same path.
      try {
        const children = await fs.readdir(entry.absolutePath, { withFileTypes: true });
        const childEntries = sortEntries(children, entry.absolutePath, entry.relativePath, entry.depth + 1);
        items.push({ relativePath: entry.relativePath, type: "directory", status: "scanned" });
        summary.totalScanned += 1;
        stack.push(...childEntries.reverse());
      } catch (err) {
        items.push({
          relativePath: entry.relativePath,
          type: "directory",
          status: "error",
          errorCategory: "read_error",
          errorMessage: safeErrorMessage(err),
        });
        summary.totalErrors += 1;
      }
      continue;
    }

    if (!lst.isFile()) {
      // Sockets, FIFOs, block/character devices — not a file or directory
      // we have any business reading. Recorded, not silently dropped.
      items.push({
        relativePath: entry.relativePath,
        type: "file",
        status: "skipped",
        skipReason: "ignored",
      });
      summary.totalSkipped += 1;
      continue;
    }

    if (lst.size > limits.maxFileSizeBytes) {
      const { category, language } = classifyFile(entry.relativePath);
      items.push({
        relativePath: entry.relativePath,
        type: "file",
        category,
        language,
        extension: path.extname(entry.relativePath),
        sizeBytes: lst.size,
        status: "skipped",
        skipReason: "too_large",
      });
      summary.totalSkipped += 1;
      continue;
    }

    const { category, language } = classifyFile(entry.relativePath);
    items.push({
      relativePath: entry.relativePath,
      type: "file",
      category,
      language,
      extension: path.extname(entry.relativePath),
      sizeBytes: lst.size,
      status: "scanned",
    });
    summary.totalScanned += 1;
    summary.filesByCategory[category] = (summary.filesByCategory[category] ?? 0) + 1;
    summary.filesByLanguage[language] = (summary.filesByLanguage[language] ?? 0) + 1;
  }

  summary.durationMs = Date.now() - startedAt;
  const outcome: ScanOutcome =
    summary.totalErrors > 0 || summary.totalSkipped > 0 || summary.limitsReached.length > 0
      ? "completed_with_warnings"
      : "completed";

  return { outcome, summary, items };
}

function sortEntries(
  entries: import("node:fs").Dirent[],
  parentAbsolute: string,
  parentRelative: string,
  depth = 1,
): QueueEntry[] {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => {
      const relativePath = parentRelative ? `${parentRelative}/${e.name}` : e.name;
      return {
        absolutePath: resolveSafeChild(parentAbsolute, e.name),
        relativePath,
        depth,
      };
    });
}

// Never surface raw OS error text (can include local absolute paths) to a
// client — keep only a short, safe category description.
function safeErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "EACCES" || code === "EPERM") return "Permission denied";
  if (code === "ENOENT") return "Path no longer exists";
  return "Read error";
}
