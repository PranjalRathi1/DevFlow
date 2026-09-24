import { Project } from "../models/Project.js";
import { Scan, type ScanDocument } from "../models/Scan.js";
import { requireValidObjectId } from "./project.service.js";
import { revalidateScanRoot, FsSafetyError } from "../lib/fsSafety.js";
import { scanDirectory, type ScanLimits } from "./scanner.service.js";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

function limitsFromEnv(): ScanLimits {
  return {
    maxFileSizeBytes: env.SCAN_MAX_FILE_SIZE_BYTES,
    maxFiles: env.SCAN_MAX_FILES,
    maxDepth: env.SCAN_MAX_DEPTH,
    maxDirectories: env.SCAN_MAX_DIRECTORIES,
    maxDurationMs: env.SCAN_MAX_DURATION_MS,
  };
}

/**
 * Runs a scan synchronously within this call and persists the result —
 * there is no background job system or cancellation endpoint in this
 * batch (see docs/IMPLEMENTATION_LOG.md's Batch C1 entry). Ownership is
 * enforced via the same `{_id, owner}` query pattern as every other
 * project-scoped write; `canonicalPath` is only ever read here, via an
 * explicit `.select("+sourceConfig.canonicalPath")` opt-in.
 */
export async function runScanForOwner(ownerId: string, projectId: string): Promise<ScanDocument> {
  requireValidObjectId(projectId, "project id");
  const project = await Project.findOne({ _id: projectId, owner: ownerId }).select(
    "+sourceConfig.canonicalPath",
  );
  if (!project) {
    throw new AppError("Project not found", 404);
  }
  const configuredPath = project.sourceConfig?.canonicalPath;
  if (!configuredPath) {
    throw new AppError("No source directory is configured for this project", 400);
  }

  // Re-validate at scan time, not just at configuration time — the
  // directory could have been moved/deleted/replaced-with-a-symlink since
  // it was configured. Uses `revalidateScanRoot` (lstat-based), not
  // `resolveScanRoot` (realpath-based) — see its doc comment for why:
  // re-resolving an already-canonical path would silently follow it if
  // it's since become a symlink.
  let canonicalPath: string;
  try {
    canonicalPath = await revalidateScanRoot(configuredPath);
  } catch (err) {
    if (err instanceof FsSafetyError) {
      throw new AppError(`Configured source directory is no longer valid: ${err.message}`, 400);
    }
    throw err;
  }

  const result = await scanDirectory(canonicalPath, limitsFromEnv());

  return Scan.create({
    project: projectId,
    owner: ownerId,
    outcome: result.outcome,
    summary: result.summary,
    items: result.items,
    errorMessage: result.errorMessage,
  });
}

export async function getLatestScanForOwner(
  ownerId: string,
  projectId: string,
): Promise<ScanDocument | null> {
  requireValidObjectId(projectId, "project id");
  const project = await Project.findOne({ _id: projectId, owner: ownerId });
  if (!project) {
    throw new AppError("Project not found", 404);
  }
  return Scan.findOne({ project: projectId, owner: ownerId }).sort({ createdAt: -1 });
}

/**
 * Single-scan-by-id lookup, ownership-enforced via `Scan`'s own
 * denormalized `owner` field — same query-level pattern as
 * `Plan`/`Task`/`Requirement`, no `:projectId` needed in the URL. Added
 * in Batch C2 as the mounting point for `/api/scans/:id/analysis`.
 */
export async function getScanForOwner(ownerId: string, scanId: string): Promise<ScanDocument> {
  requireValidObjectId(scanId, "scan id");
  const scan = await Scan.findOne({ _id: scanId, owner: ownerId });
  if (!scan) {
    throw new AppError("Scan not found", 404);
  }
  return scan;
}
