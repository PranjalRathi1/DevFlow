// Minimal mirror of apps/api/src/models/Analysis.ts — only what the
// frontend actually needs (triggering analysis and reading its outcome).
// The Graph tab consumes relationships via the graph endpoint instead of
// this type's `relationships` field, so that field isn't modeled here.

export type AnalysisOutcome = "completed" | "completed_with_warnings" | "failed";

export interface Analysis {
  _id: string;
  scan: string;
  outcome: AnalysisOutcome;
  summary: {
    totalFilesAnalyzed: number;
    totalFilesSkipped: number;
    totalRelationships: number;
    byStatus: Record<string, number>;
  };
  errorMessage?: string;
  createdAt: string;
}
