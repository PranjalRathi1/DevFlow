// Mirrors apps/api/src/models/Project.ts's PROJECT_STATUSES. Duplicated
// rather than shared via packages/shared — see docs/DECISIONS.md for the
// documented trade-off (a build/workspace-link step for a handful of
// string unions isn't justified yet; packages/shared is reserved for the
// dependency-graph engine in Batch B, where sharing genuinely matters).
export const PROJECT_STATUSES = ["planning", "active", "on_hold", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project {
  _id: string;
  name: string;
  description: string;
  owner: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectPayload {
  name: string;
  description?: string | undefined;
  status?: ProjectStatus | undefined;
}

export type UpdateProjectPayload = Partial<CreateProjectPayload>;
