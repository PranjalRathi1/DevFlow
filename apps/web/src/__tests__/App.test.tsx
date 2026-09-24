import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import { AuthProvider } from "../context/AuthContext";
import { authService } from "../services/authService";
import { projectService } from "../services/projectService";
import { ApiError } from "../services/apiClient";

vi.mock("../services/authService");
vi.mock("../services/projectService");

const authenticatedUser = {
  _id: "1",
  email: "user@example.com",
  displayName: "Existing User",
  role: "member" as const,
  createdAt: "",
  updatedAt: "",
};

function renderApp(initialEntry = "/") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("App routing & auth gate", () => {
  it("shows a loading state before the initial session check resolves", () => {
    vi.mocked(authService.me).mockReturnValue(new Promise(() => {})); // never resolves
    renderApp();

    expect(screen.getByRole("status")).toHaveTextContent(/checking your session/i);
  });

  it("redirects an unauthenticated visitor at '/' to the login page (protected content hidden)", async () => {
    vi.mocked(authService.me).mockRejectedValue(new ApiError("Authentication required", 401));
    renderApp("/");

    expect(await screen.findByRole("heading", { name: /log in to your account/i })).toBeInTheDocument();
    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
  });

  it("redirects an unauthenticated visitor from a protected URL to /login", async () => {
    vi.mocked(authService.me).mockRejectedValue(new ApiError("Authentication required", 401));
    renderApp("/app/dashboard");

    expect(await screen.findByRole("heading", { name: /log in to your account/i })).toBeInTheDocument();
  });

  it("redirects an authenticated visitor at '/' to the dashboard", async () => {
    vi.mocked(authService.me).mockResolvedValue({ user: authenticatedUser });
    vi.mocked(projectService.list).mockResolvedValue({ projects: [] });
    renderApp("/");

    expect(await screen.findByText(/welcome back, existing user/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /log in to your account/i })).not.toBeInTheDocument();
  });

  it("redirects an already-authenticated visitor away from /login", async () => {
    vi.mocked(authService.me).mockResolvedValue({ user: authenticatedUser });
    vi.mocked(projectService.list).mockResolvedValue({ projects: [] });
    renderApp("/login");

    expect(await screen.findByText(/welcome back, existing user/i)).toBeInTheDocument();
  });

  it("shows a not-found page for an unknown route", async () => {
    vi.mocked(authService.me).mockRejectedValue(new ApiError("Authentication required", 401));
    renderApp("/this-does-not-exist");

    expect(await screen.findByText(/page not found/i)).toBeInTheDocument();
  });

  it("logs out and returns to the login page, hiding protected content", async () => {
    vi.mocked(authService.me).mockResolvedValue({ user: authenticatedUser });
    vi.mocked(authService.logout).mockResolvedValue({ message: "Logged out" });
    vi.mocked(projectService.list).mockResolvedValue({ projects: [] });
    const user = userEvent.setup();
    renderApp("/app/dashboard");

    await screen.findByText(/welcome back/i);

    await user.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(authService.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: /log in to your account/i })).toBeInTheDocument();
    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
  });
});
