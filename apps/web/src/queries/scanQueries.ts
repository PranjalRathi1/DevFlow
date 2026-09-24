import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { scanService } from "../services/scanService";

export function useSourceConfig(projectId: string) {
  return useQuery({
    queryKey: ["source-config", projectId],
    queryFn: () => scanService.getSource(projectId).then((r) => r.sourceConfig),
    enabled: Boolean(projectId),
  });
}

export function useSetSourceConfig(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => scanService.setSource(projectId, path).then((r) => r.sourceConfig),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["source-config", projectId] });
    },
  });
}

export function useLatestScan(projectId: string) {
  return useQuery({
    queryKey: ["latest-scan", projectId],
    queryFn: () => scanService.getLatestScan(projectId).then((r) => r.scan),
    enabled: Boolean(projectId),
  });
}

export function useStartScan(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => scanService.startScan(projectId).then((r) => r.scan),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["latest-scan", projectId] });
    },
  });
}
