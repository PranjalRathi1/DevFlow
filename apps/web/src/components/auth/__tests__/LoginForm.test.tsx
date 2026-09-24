import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { LoginForm } from "../LoginForm";
import { AuthProvider } from "../../../context/AuthContext";
import { authService } from "../../../services/authService";
import { ApiError } from "../../../services/apiClient";

vi.mock("../../../services/authService");

function renderLoginForm() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <LoginForm />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("LoginForm", () => {
  beforeEach(() => {
    vi.mocked(authService.me).mockRejectedValue(new ApiError("Authentication required", 401));
  });

  it("shows validation errors for empty submission without calling the API", async () => {
    const user = userEvent.setup();
    renderLoginForm();

    await user.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText(/email is required/i)).toBeInTheDocument();
    expect(authService.login).not.toHaveBeenCalled();
  });

  it("shows an error for a malformed (but non-empty) email", async () => {
    const user = userEvent.setup();
    renderLoginForm();

    await user.type(screen.getByLabelText(/email/i), "not-an-email");
    await user.type(screen.getByLabelText(/password/i), "some-password");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText(/invalid email address/i)).toBeInTheDocument();
    expect(authService.login).not.toHaveBeenCalled();
  });

  it("shows the generic error message on invalid credentials (failure state)", async () => {
    vi.mocked(authService.login).mockRejectedValue(new ApiError("Invalid email or password", 401));
    const user = userEvent.setup();
    renderLoginForm();

    await user.type(screen.getByLabelText(/email/i), "wrong@example.com");
    await user.type(screen.getByLabelText(/password/i), "wrong-password");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
  });

  it("calls login with valid credentials on success (success state)", async () => {
    vi.mocked(authService.login).mockResolvedValue({
      user: {
        _id: "1",
        email: "user@example.com",
        displayName: "Existing User",
        role: "member",
        createdAt: "",
        updatedAt: "",
      },
    });
    const user = userEvent.setup();
    renderLoginForm();

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "correct-password");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() =>
      expect(authService.login).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "correct-password",
      }),
    );
    expect(screen.queryByText(/invalid email or password/i)).not.toBeInTheDocument();
  });

  it("shows a loading state on the submit button while the request is in flight", async () => {
    let resolveLogin: (value: { user: import("../../../types/auth").AuthUser }) => void = () => {};
    vi.mocked(authService.login).mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );
    const user = userEvent.setup();
    renderLoginForm();

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "correct-password");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByRole("button", { name: /logging in/i })).toBeDisabled();

    resolveLogin({
      user: {
        _id: "1",
        email: "user@example.com",
        displayName: "X",
        role: "member",
        createdAt: "",
        updatedAt: "",
      },
    });
  });

  it("links to the register page", () => {
    renderLoginForm();
    expect(screen.getByRole("link", { name: /create one/i })).toHaveAttribute("href", "/register");
  });
});
