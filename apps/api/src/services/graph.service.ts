import { Analysis } from "../models/Analysis.js";
import { getScanForOwner } from "./scan.service.js";
import {
  buildDependencyGraph,
  topologicalOrder,
  getRootNodes,
  getLeafNodes,
  type DependencyGraphResult,
  type GraphRelationshipInput,
} from "../lib/sourceDependencyGraph.js";
import { AppError } from "../utils/AppError.js";

export interface ScanDependencyGraph extends DependencyGraphResult {
  scanId: string;
  analysisId: string;
  /** `null` when the graph has a cycle — see `cycles` for detail. */
  topologicalOrder: string[] | null;
  rootNodes: string[];
  leafNodes: string[];
}

/**
 * Computed on demand from the already-persisted `Scan`/`Analysis`
 * documents — no separate graph model exists (see docs/DECISIONS.md's
 * Batch C3 ADR for why: the graph is a pure, deterministic function of
 * data already stored, so persisting a third copy would only risk
 * staleness). Ownership is enforced via `getScanForOwner`'s existing
 * `{_id, owner}` check; the analysis is looked up scoped to that exact
 * scan id, so a relationship from a different scan can never leak in.
 */
export async function getDependencyGraphForOwner(
  ownerId: string,
  scanId: string,
): Promise<ScanDependencyGraph> {
  const scan = await getScanForOwner(ownerId, scanId);

  const analysis = await Analysis.findOne({ scan: scan._id, owner: ownerId }).sort({ createdAt: -1 });
  if (!analysis) {
    throw new AppError("No analysis has been run for this scan yet", 404);
  }

  // Converted to plain objects at this boundary — the pure graph engine
  // takes only plain data, never a Mongoose subdocument type.
  const relationships: GraphRelationshipInput[] = analysis.relationships.map((r) => ({
    importerRelativePath: r.importerRelativePath,
    rawImport: r.rawImport,
    isLiteral: r.isLiteral,
    importType: r.importType ?? undefined,
    line: r.line ?? undefined,
    column: r.column ?? undefined,
    status: r.status,
    resolvedRelativePath: r.resolvedRelativePath ?? undefined,
    resolutionMethod: r.resolutionMethod ?? undefined,
    reason: r.reason ?? undefined,
  }));
  const graph = buildDependencyGraph(scan.items, relationships);

  return {
    ...graph,
    scanId: scan._id.toString(),
    analysisId: analysis._id.toString(),
    topologicalOrder: topologicalOrder(graph),
    rootNodes: getRootNodes(graph),
    leafNodes: getLeafNodes(graph),
  };
}
