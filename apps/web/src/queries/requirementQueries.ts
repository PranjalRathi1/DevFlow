import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requirementService } from "../services/requirementService";
import type { RequirementFormValues, RequirementStatus } from "../types/requirement";

export const requirementKeys = {
  list: (projectId: string, status?: RequirementStatus) => ["requirements", projectId, { status }] as const,
};

export function useRequirements(projectId: string, status?: RequirementStatus) {
  return useQuery({
    queryKey: requirementKeys.list(projectId, status),
    queryFn: () => requirementService.list(projectId, { status }).then((r) => r.requirements),
    enabled: Boolean(projectId),
  });
}

export function useCreateRequirement(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RequirementFormValues) =>
      requirementService.create(projectId, payload).then((r) => r.requirement),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["requirements", projectId] });
    },
  });
}

export function useUpdateRequirement(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<RequirementFormValues> }) =>
      requirementService.update(id, payload).then((r) => r.requirement),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["requirements", projectId] });
    },
  });
}

export function useDeleteRequirement(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requirementService.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["requirements", projectId] });
      // A requirement's deletion clears the reference on any task that
      // used it (see apps/api docs/DECISIONS.md) — refresh tasks too.
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });
}
