import type { Priority } from "./requirement";

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
  createdAt: string;
  updatedAt: string;
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
