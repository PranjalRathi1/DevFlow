import { apiClient } from "./apiClient";
import type { CreateProjectPayload, Project, UpdateProjectPayload } from "../types/project";

export const projectService = {
  list: () => apiClient.get<{ projects: Project[] }>("/projects"),
  get: (id: string) => apiClient.get<{ project: Project }>(`/projects/${id}`),
  create: (payload: CreateProjectPayload) => apiClient.post<{ project: Project }>("/projects", payload),
  update: (id: string, payload: UpdateProjectPayload) =>
    apiClient.patch<{ project: Project }>(`/projects/${id}`, payload),
  remove: (id: string) => apiClient.delete<void>(`/projects/${id}`),
};
