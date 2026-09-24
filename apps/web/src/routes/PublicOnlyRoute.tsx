import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { LoadingState } from "../components/ui/LoadingState";

// Guards /login and /register — an already-authenticated user visiting
// either is redirected into the app instead of seeing an auth form again.
export function PublicOnlyRoute() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Checking your session…" />
      </div>
    );
  }

  if (status === "authenticated") {
    return <Navigate to="/app/dashboard" replace />;
  }

  return <Outlet />;
}
