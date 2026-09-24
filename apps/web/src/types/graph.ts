// Mirrors apps/api/src/lib/sourceDependencyGraph.ts's DependencyGraphResult
// and apps/api/src/services/graph.service.ts's ScanDependencyGraph exactly
// — the frontend never re-derives graph semantics, only renders what the
// backend already computed.

export interface GraphNode {
  id: string;
  language?: string;
  category?: string;
}

export type ImportType = "import" | "export_from" | "require" | "dynamic_import";

export interface GraphEdgeEvidence {
  rawImport: string;
  isLiteral: boolean;
  importType?: ImportType;
  line?: number;
  column?: number;
  resolutionMethod?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  evidence: GraphEdgeEvidence[];
}

export type NonConfirmedStatus = "unresolved" | "external" | "unsupported" | "parse_error";

export interface NonConfirmedRelationship {
  importerRelativePath: string;
  rawImport: string;
  isLiteral: boolean;
  importType?: ImportType;
  line?: number;
  column?: number;
  status: NonConfirmedStatus;
  reason?: string;
}

export type GraphValidationError =
  | { type: "importer_not_in_inventory"; importerRelativePath: string }
  | { type: "target_not_in_inventory"; importerRelativePath: string; resolvedRelativePath: string }
  | { type: "self_reference"; nodeId: string }
  | { type: "cycle"; cycle: string[] };

export interface ScanDependencyGraph {
  scanId: string;
  analysisId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: NonConfirmedRelationship[];
  external: NonConfirmedRelationship[];
  unsupported: NonConfirmedRelationship[];
  parseErrors: NonConfirmedRelationship[];
  validationErrors: GraphValidationError[];
  cycles: string[][];
  isAcyclic: boolean;
  topologicalOrder: string[] | null;
  rootNodes: string[];
  leafNodes: string[];
}
