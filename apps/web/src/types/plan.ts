import type { Priority } from "./requirement";

export const PLAN_STATUSES = ["needs_review", "approved", "rejected"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface SuggestedTask {
  tempId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: Priority;
  dependsOn: string[];
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
