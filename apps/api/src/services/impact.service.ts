import { getScanForOwner } from "./scan.service.js";
import type { ScanDocument } from "../models/Scan.js";
import { buildScanDependencyGraph, findLatestAnalysisOrThrow } from "./graph.service.js";
import { computeImpact, type ImpactResult } from "../lib/impactAnalysis.js";
import { observedInventoryPaths } from "../lib/planningContext.js";
import { AppError } from "../utils/AppError.js";

export interface ScanImpact extends ImpactResult {
  scanId: string;
  analysisId: string;
  /** When the analysis this impact was computed from ran — the evidence is as of then, not "now". */
  analysisCreatedAt: Date | undefined;
  /** Stage 5: walk-stopping limits hit by the scan; non-empty = dependents may be missing entirely. */
  scanLimitsReached: string[];
}

/** 404 unless `file` is a file (not a directory, not a symlink placeholder) the scan observed. Never guesses near matches. */
export function assertObservedFile(scan: ScanDocument, file: string): void {
  const isObservedFile =
    observedInventoryPaths(scan.items).has(file) &&
    scan.items.some((i) => i.relativePath === file && i.type === "file");
  if (!isObservedFile) {
    throw new AppError("File not found in this scan", 404);
  }
}

/**
 * Read-only: loads the owner's scan and its latest analysis, confirms the
 * file is a file the scan actually observed, and computes impact over the
 * same canonical graph the Graph API returns. No filesystem access, no
 * re-scan, no re-analysis, no AI.
 */
export async function getImpactForOwner(
  ownerId: string,
  scanId: string,
  file: string,
  bounds: { maxDepth: number; maxNodes: number },
): Promise<ScanImpact> {
  const scan = await getScanForOwner(ownerId, scanId);
  const analysis = await findLatestAnalysisOrThrow(ownerId, scan);

  assertObservedFile(scan, file);
  const graph = buildScanDependencyGraph(scan, analysis);
  return {
    scanId: scan._id.toString(),
    analysisId: analysis._id.toString(),
    analysisCreatedAt: analysis.get("createdAt") as Date | undefined,
    scanLimitsReached: [...(scan.summary?.limitsReached ?? [])],
    ...computeImpact(graph, file, bounds),
  };
}
