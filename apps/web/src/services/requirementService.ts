import { apiClient } from "./apiClient";
import type { Requirement, RequirementFormValues, RequirementStatus } from "../types/requirement";

export const requirementService = {
  list: (projectId: string, filters: { status?: RequirementStatus | undefined } = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    const query = params.toString() ? `?${params.toString()}` : "";
    return apiClient.get<{ requirements: Requirement[] }>(`/projects/${projectId}/requirements${query}`);
  },
  create: (projectId: string, payload: RequirementFormValues) =>
    apiClient.post<{ requirement: Requirement }>(`/projects/${projectId}/requirements`, payload),
  update: (id: string, payload: Partial<RequirementFormValues>) =>
    apiClient.patch<{ requirement: Requirement }>(`/requirements/${id}`, payload),
  remove: (id: string) => apiClient.delete<void>(`/requirements/${id}`),
};
