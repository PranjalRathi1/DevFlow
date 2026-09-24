import { apiClient } from "./apiClient";
import type { Priority, Task, TaskFormValues, TaskStatus } from "../types/task";

export interface TaskFilters {
  status?: TaskStatus;
  priority?: Priority;
  requirementId?: string;
  search?: string;
}

export const taskService = {
  // Fetches the project's full task set (no parentTaskId filter) — the UI
  // derives the top-level/subtask tree client-side from one array rather
  // than issuing a lazy-loaded request per expanded task. See
  // docs/ARCHITECTURE.md.
  list: (projectId: string, filters: TaskFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.priority) params.set("priority", filters.priority);
    if (filters.requirementId) params.set("requirementId", filters.requirementId);
    if (filters.search) params.set("search", filters.search);
    const query = params.toString() ? `?${params.toString()}` : "";
    return apiClient.get<{ tasks: Task[] }>(`/projects/${projectId}/tasks${query}`);
  },
  create: (projectId: string, payload: TaskFormValues) =>
    apiClient.post<{ task: Task }>(`/projects/${projectId}/tasks`, payload),
  update: (id: string, payload: Partial<TaskFormValues>) =>
    apiClient.patch<{ task: Task }>(`/tasks/${id}`, payload),
  remove: (id: string) => apiClient.delete<void>(`/tasks/${id}`),
};
