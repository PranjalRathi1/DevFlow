import type { Priority } from "./requirement";
import type { AffectedFile } from "./plan";

export { PRIORITIES } from "./requirement";
export type { Priority };

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "in_review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  _id: string;
  project: string;
  owner: string;
  requirement: string | null;
  parentTask: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  acceptanceCriteria: string[];
  /** Read-only evidence copied from the AI plan this task was approved from (C5.1). */
  planEvidence?: TaskPlanEvidence | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPlanEvidence {
  plan: string;
  tempId: string;
  rationale: string;
  testingApproach: string;
  affectedFiles: AffectedFile[];
  sourceContext: {
    scan: string;
    analysis: string;
    contextVersion: number;
    impactFile?: string | null;
  } | null;
}

export interface TaskFormValues {
  title: string;
  description?: string | undefined;
  status?: TaskStatus | undefined;
  priority?: Priority | undefined;
  acceptanceCriteria?: string[] | undefined;
  requirementId?: string | null | undefined;
  parentTaskId?: string | null | undefined;
}
