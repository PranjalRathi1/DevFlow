import { apiClient } from "./apiClient";
import type { Scan, SourceConfig } from "../types/scan";

export const scanService = {
  getSource: (projectId: string) =>
    apiClient.get<{ sourceConfig: SourceConfig }>(`/projects/${projectId}/source`),
  setSource: (projectId: string, path: string) =>
    apiClient.put<{ sourceConfig: SourceConfig }>(`/projects/${projectId}/source`, { path }),
  startScan: (projectId: string) => apiClient.post<{ scan: Scan }>(`/projects/${projectId}/scans`),
  getLatestScan: (projectId: string) =>
    apiClient.get<{ scan: Scan | null }>(`/projects/${projectId}/scans/latest`),
};
