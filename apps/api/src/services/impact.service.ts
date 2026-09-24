import { getScanForOwner } from "./scan.service.js";
import type { ScanDocument } from "../models/Scan.js";
import type { AnalysisDocument } from "../models/Analysis.js";
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
  /** Task 2: false for analyses made before package entry points were recorded (only "no importers" is then known). */
  packageEntryPointsRecorded: boolean;
}

/**
 * Task 2 (ADR-029): package-declared entry points the analysis recorded,
 * as file -> ["<package.json> <field>", ...]. Empty for older analyses.
 */
export function entryPointsOf(analysis: AnalysisDocument): Map<string, string[]> {
  const config = analysis.get("resolutionConfig") as
    { packages?: { file: string; entryPoints?: { file: string; fields: string[] }[] }[] } | undefined;
  const map = new Map<string, string[]>();
  for (const pkg of config?.packages ?? []) {
    for (const ep of pkg.entryPoints ?? []) {
      map.set(ep.file, [...(map.get(ep.file) ?? []), ...ep.fields.map((f) => `${pkg.file} ${f}`)]);
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.localeCompare(b));
  return map;
}

function hasRecordedEntryPoints(analysis: AnalysisDocument): boolean {
  const config = analysis.get("resolutionConfig") as { packages?: { entryPoints?: unknown }[] } | undefined;
  return config !== undefined && (config.packages ?? []).every((p) => Array.isArray(p.entryPoints));
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
    packageEntryPointsRecorded: hasRecordedEntryPoints(analysis),
    ...computeImpact(graph, file, bounds, { entryPoints: entryPointsOf(analysis) }),
  };
}
