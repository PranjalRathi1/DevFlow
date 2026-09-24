import { apiClient } from "./apiClient";
import type { HealthStatus } from "../types/health";

export const healthService = {
  getHealth: () => apiClient.get<HealthStatus>("/health"),
};
