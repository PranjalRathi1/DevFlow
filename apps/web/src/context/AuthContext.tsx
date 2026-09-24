import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { authService } from "../services/authService";
import { ApiError } from "../services/apiClient";
import type { AuthUser, LoginPayload, RegisterPayload } from "../types/auth";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Set by a failed login/register attempt; cleared on the next attempt. Not used for the initial session check. */
  error: string | null;
  register: (payload: RegisterPayload) => Promise<void>;
  login: (payload: LoginPayload) => Promise<void>;
  logout: () => Promise<void>;
}

// eslint-disable-next-line react-refresh/only-export-components -- context object is intentionally exported alongside the provider for useAuth.ts to consume
export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  // On mount, check whether an existing session cookie is still valid —
  // this is what makes "stay logged in after a page refresh" work, and
  // what surfaces an expired/invalid cookie as a clean "logged out" state
  // rather than a crash or an infinite loading spinner.
  useEffect(() => {
    let cancelled = false;

    authService
      .me()
      .then(({ user: currentUser }) => {
        if (!cancelled) {
          setUser(currentUser);
          setStatus("authenticated");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setStatus("unauthenticated");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback(async (payload: RegisterPayload) => {
    setError(null);
    try {
      const { user: newUser } = await authService.register(payload);
      setUser(newUser);
      setStatus("authenticated");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed. Please try again.");
      throw err;
    }
  }, []);

  const login = useCallback(async (payload: LoginPayload) => {
    setError(null);
    try {
      const { user: loggedInUser } = await authService.login(payload);
      setUser(loggedInUser);
      setStatus("authenticated");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed. Please try again.");
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } finally {
      // Clear local state even if the network call fails — the user asked
      // to log out, and the cookie's short TTL bounds any lingering risk.
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, error, register, login, logout }),
    [status, user, error, register, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
