import { apiClient } from "./apiClient";
import type { AIStatus, Plan } from "../types/plan";

export const planService = {
  aiStatus: () => apiClient.get<AIStatus>("/ai/status"),
  generate: (projectId: string, requirementId: string, scanId?: string, impactFile?: string) =>
    apiClient.post<{ plan: Plan }>(`/projects/${projectId}/plans/generate`, {
      requirementId,
      ...(scanId ? { scanId } : {}),
      ...(scanId && impactFile ? { impactFile } : {}),
    }),
  list: (projectId: string) => apiClient.get<{ plans: Plan[] }>(`/projects/${projectId}/plans`),
  update: (planId: string, payload: Partial<Pick<Plan, "title" | "summary" | "assumptions" | "risks">>) =>
    apiClient.patch<{ plan: Plan }>(`/plans/${planId}`, payload),
  approve: (planId: string) =>
    apiClient.post<{ plan: Plan; createdTasks: unknown[] }>(`/plans/${planId}/approve`),
  reject: (planId: string) => apiClient.post<{ plan: Plan }>(`/plans/${planId}/reject`),
};
