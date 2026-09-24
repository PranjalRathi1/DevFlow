import { apiClient } from "./apiClient";
import type { ScanDependencyGraph } from "../types/graph";
import type { Analysis } from "../types/analysis";

export const graphService = {
  getGraph: (scanId: string) => apiClient.get<{ graph: ScanDependencyGraph }>(`/scans/${scanId}/graph`),
  runAnalysis: (scanId: string) => apiClient.post<{ analysis: Analysis }>(`/scans/${scanId}/analysis`),
};
