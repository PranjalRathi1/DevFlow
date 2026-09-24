export const REQUIREMENT_STATUSES = ["draft", "approved", "implemented"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Requirement {
  _id: string;
  project: string;
  owner: string;
  title: string;
  description: string;
  status: RequirementStatus;
  priority: Priority;
  acceptanceCriteria: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RequirementFormValues {
  title: string;
  description?: string | undefined;
  status?: RequirementStatus | undefined;
  priority?: Priority | undefined;
  acceptanceCriteria?: string[] | undefined;
}
