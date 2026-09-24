import type { Priority } from "./requirement";

export const PLAN_STATUSES = ["needs_review", "approved", "rejected"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Set by the server against the recorded scan — never by the AI. */
export type AffectedFileEvidence = "in_scan" | "not_in_scan" | "unverified";

export interface AffectedFile {
  path: string;
  reason: string;
  evidence: AffectedFileEvidence;
  dependentsCount?: number;
  dependenciesCount?: number;
}

/** The exact scan + analysis a plan was grounded in (Batch C5). */
export interface PlanSourceContext {
  scan: string;
  analysis: string;
  scanCreatedAt?: string;
  analysisCreatedAt?: string;
  contextVersion: number;
  truncated: boolean;
  counts: {
    files: number;
    graphNodes: number;
    confirmedEdges: number;
    unresolved: number;
    external: number;
    externalPackages: number;
    unsupported: number;
    parseErrors: number;
    cycles: number;
  };
}

export interface SuggestedTask {
  tempId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: Priority;
  dependsOn: string[];
  // Optional: plans generated before Batch C5 may not carry these.
  rationale?: string;
  affectedFiles?: AffectedFile[];
}

export interface Plan {
  _id: string;
  project: string;
  owner: string;
  requirement: string;
  status: PlanStatus;
  title: string;
  summary: string;
  assumptions: string[];
  risks: string[];
  suggestedTasks: SuggestedTask[];
  suggestedOrder: string[];
  sourceContext?: PlanSourceContext | null;
  validation: { valid: boolean; errors: unknown[] };
  aiMeta: { provider: string; model: string; generatedAt: string; durationMs: number };
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AIStatus {
  available: boolean;
  provider: string;
  model: string;
}
