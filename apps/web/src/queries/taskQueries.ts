import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { taskService, type TaskFilters } from "../services/taskService";
import type { TaskFormValues } from "../types/task";

export const taskKeys = {
  list: (projectId: string, filters: TaskFilters) => ["tasks", projectId, filters] as const,
};

export function useTasks(projectId: string, filters: TaskFilters = {}) {
  return useQuery({
    queryKey: taskKeys.list(projectId, filters),
    queryFn: () => taskService.list(projectId, filters).then((r) => r.tasks),
    enabled: Boolean(projectId),
  });
}

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: TaskFormValues) => taskService.create(projectId, payload).then((r) => r.task),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });
}

export function useUpdateTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<TaskFormValues> }) =>
      taskService.update(id, payload).then((r) => r.task),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });
}

export function useDeleteTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => taskService.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });
}
