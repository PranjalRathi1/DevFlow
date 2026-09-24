import type { Priority } from "./requirement";

export const PLAN_STATUSES = ["needs_review", "approved", "rejected"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Set by the server against the recorded scan — never by the AI. */
export type AffectedFileEvidence = "in_scan" | "not_in_scan" | "unverified";

/** Server-verified relation to the plan's impact target (Stage 4). */
export type ImpactRelation =
  "target" | "dependency" | "direct_dependent" | "transitive_dependent" | "dependency_and_dependent";

/** Task 3: a statement from the AI's own text, checked by the server against the scan. */
export type ClaimKind = "imports" | "imported_by" | "mentions";
export type ClaimStatus = "supported" | "not_found" | "in_scan" | "not_in_scan" | "unverifiable";
export interface ClaimCheck {
  kind: ClaimKind;
  target: string;
  /** Set when the text itself names the other file ("a.ts imports b.ts"). */
  subject?: string;
  status: ClaimStatus;
  note?: string;
}

/** The AI's stated intent for a file — a claim, not evidence. */
export type AffectedFileChange = "modify" | "create" | "test" | "reference";

export interface AffectedFile {
  path: string;
  reason: string;
  // Optional: plans generated before C5.1 don't carry it.
  change?: AffectedFileChange;
  evidence: AffectedFileEvidence;
  dependentsCount?: number;
  dependenciesCount?: number;
  /** Server-set when `change` contradicts the scan. */
  conflict?: string;
  /** Server-set; absent = not found within the bounded impact (NOT "unrelated"). */
  impactRelation?: ImpactRelation;
  /** Server-set: why a grounded plan still could not verify this path. */
  evidenceNote?: string;
  /** Server-set (Task 3): tempId of an earlier task this one depends on that creates this path. */
  plannedBy?: string;
  /** Server-set (Task 3): statements in `reason` checked against the scan. */
  claimChecks?: ClaimCheck[];
}

/** The exact scan + analysis a plan was grounded in (Batch C5). */
export interface PlanSourceContext {
  scan: string;
  analysis: string;
  scanCreatedAt?: string;
  analysisCreatedAt?: string;
  contextVersion: number;
  truncated: boolean;
  // C5.1 — absent on older plans.
  focusTerms?: string[];
  focusFiles?: string[];
  // Stage 12 — how the context was fitted to the model's budget; absent on older plans.
  fitting?: {
    budgetTokens: number;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    steps: string[];
    reductions: { section: string; shown: number; total: number }[];
  };
  // Stage 5 / Stage 4 — absent on older plans.
  coverage?: { stoppedEarly: string[]; unreadDirectories: number; ignoredDirectories: number };
  // Task 3 — the import-resolution configuration behind the evidence; absent on older plans.
  resolution?: {
    aliasConfigs: string[];
    localPackages: number;
    diagnosticsTotal: number;
    diagnostics: { file: string; message: string }[];
  };
  impact?: {
    file: string;
    inGraph: boolean;
    maxDepth: number;
    maxNodes: number;
    directDependencies: number;
    directDependents: number;
    transitiveDependentsShown: number;
    // Task 2 — exact totals; absent on older plans.
    dependentsAtAnyDepth?: number;
    typeOnlyDependents?: number;
    entryPointsAffected?: number;
    truncated: boolean;
  } | null;
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
  testingApproach?: string;
  affectedFiles?: AffectedFile[];
  /** Server-set (Task 3): paths/relationships named in the task's own text, checked. */
  mentionedPaths?: ClaimCheck[];
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
