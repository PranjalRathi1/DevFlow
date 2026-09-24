import { Analysis } from "../models/Analysis.js";
import type { ScanDocument } from "../models/Scan.js";
import type { AnalysisDocument } from "../models/Analysis.js";
import { getScanForOwner } from "./scan.service.js";
import { buildScanDependencyGraph, type ScanDependencyGraph } from "./graph.service.js";
import { requireValidObjectId } from "./project.service.js";
import {
  buildPlanningContext,
  observedInventoryPaths,
  type AffectedFileEvidenceSource,
  type PlanningContext,
} from "../lib/planningContext.js";
import { AppError } from "../utils/AppError.js";

export interface PlanGrounding {
  scan: ScanDocument;
  analysis: AnalysisDocument;
  graph: ScanDependencyGraph;
  context: PlanningContext;
  evidenceSource: AffectedFileEvidenceSource;
}

/**
 * Loads everything a scan-grounded plan needs, from stored data only — no
 * filesystem access, no re-scan, no re-analysis. Ownership is enforced by
 * `getScanForOwner`; the scan must also belong to THIS project, so a
 * plan can never be grounded in another project's evidence.
 *
 * `analysisId` pins a specific analysis (used when re-checking an edited
 * plan against the evidence it was generated from); otherwise the latest
 * analysis of the scan is used, the same one the Graph tab shows.
 */
export async function loadPlanGrounding(
  ownerId: string,
  projectId: string,
  scanId: string,
  analysisId?: string,
): Promise<PlanGrounding> {
  const scan = await getScanForOwner(ownerId, scanId);
  if (scan.project.toString() !== projectId) {
    // Same 404 as a missing/foreign scan — no cross-project existence leak.
    throw new AppError("Scan not found", 404);
  }
  if (scan.outcome === "failed") {
    throw new AppError("Cannot ground a plan in a scan that failed to read the source directory", 400);
  }

  let analysis: AnalysisDocument | null;
  if (analysisId) {
    requireValidObjectId(analysisId, "analysis id");
    analysis = await Analysis.findOne({ _id: analysisId, scan: scan._id, owner: ownerId });
  } else {
    analysis = await Analysis.findOne({ scan: scan._id, owner: ownerId }).sort({ createdAt: -1 });
  }
  if (!analysis) {
    throw new AppError(
      "No dependency analysis exists for this scan. Run the analysis (Graph tab) before generating a scan-grounded plan.",
      409,
    );
  }
  if (analysis.outcome === "failed") {
    throw new AppError("The latest dependency analysis for this scan failed; re-run it before planning", 409);
  }

  const graph = buildScanDependencyGraph(scan, analysis);
  const context = buildPlanningContext({
    scanId: scan._id.toString(),
    analysisId: analysis._id.toString(),
    items: scan.items,
    graph,
  });

  return {
    scan,
    analysis,
    graph,
    context,
    evidenceSource: { inventory: observedInventoryPaths(scan.items), graph },
  };
}
