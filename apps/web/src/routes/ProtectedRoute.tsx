import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { LoadingState } from "../components/ui/LoadingState";

// Guards /app/*. Never redirects before the initial GET /api/auth/me check
// resolves — redirecting on "loading" would bounce an already-logged-in
// user (refreshing the page) straight to /login for a flash before their
// session is confirmed, which is exactly the authentication-loop the
// phase instructions warn against.
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Checking your session…" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
