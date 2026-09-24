import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { graphService } from "../services/graphService";

/**
 * Read-only — fetching an already-computed graph is safe to run whenever
 * a scan id is available (same as `useLatestScan`). This never triggers
 * analysis; see `useRunAnalysisForGraph` for the explicit, user-triggered
 * action that does. Every error this endpoint returns (missing analysis,
 * invalid id, ownership) is a permanent business-logic condition, not a
 * transient failure — retrying wouldn't help, so retries are disabled.
 */
export function useDependencyGraph(scanId: string | undefined) {
  return useQuery({
    queryKey: ["dependency-graph", scanId],
    queryFn: () => graphService.getGraph(scanId as string).then((r) => r.graph),
    enabled: Boolean(scanId),
    retry: false,
  });
}

export function useRunAnalysisForGraph(scanId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => graphService.runAnalysis(scanId as string).then((r) => r.analysis),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dependency-graph", scanId] });
    },
  });
}
