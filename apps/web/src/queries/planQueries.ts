import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { planService } from "../services/planService";

export function useAIStatus() {
  return useQuery({
    queryKey: ["ai-status"],
    queryFn: () => planService.aiStatus(),
    // AI availability can change independently of anything the user does
    // (Ollama started/stopped locally) — refetch reasonably often rather
    // than relying on the default staleTime.
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function usePlans(projectId: string) {
  return useQuery({
    queryKey: ["plans", projectId],
    queryFn: () => planService.list(projectId).then((r) => r.plans),
    enabled: Boolean(projectId),
  });
}

export function useGeneratePlan(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      requirementId,
      scanId,
      impactFile,
    }: {
      requirementId: string;
      scanId?: string | undefined;
      impactFile?: string | undefined;
    }) => planService.generate(projectId, requirementId, scanId, impactFile).then((r) => r.plan),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plans", projectId] });
    },
  });
}

export function useApprovePlan(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => planService.approve(planId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plans", projectId] });
      // Approval materializes real tasks — the tasks tab's cached lists are now stale too.
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });
}

export function useRejectPlan(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => planService.reject(planId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plans", projectId] });
    },
  });
}
