import { apiClient } from "./apiClient";
import type { AuthUser, LoginPayload, RegisterPayload } from "../types/auth";

interface UserResponse {
  user: AuthUser;
}

export const authService = {
  register: (payload: RegisterPayload) => apiClient.post<UserResponse>("/auth/register", payload),
  login: (payload: LoginPayload) => apiClient.post<UserResponse>("/auth/login", payload),
  logout: () => apiClient.post<{ message: string }>("/auth/logout"),
  me: () => apiClient.get<UserResponse>("/auth/me"),
};
