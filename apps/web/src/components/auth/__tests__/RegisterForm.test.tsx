import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RegisterForm } from "../RegisterForm";
import { AuthProvider } from "../../../context/AuthContext";
import { authService } from "../../../services/authService";
import { ApiError } from "../../../services/apiClient";

vi.mock("../../../services/authService");

function renderRegisterForm() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <RegisterForm />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("RegisterForm", () => {
  beforeEach(() => {
    vi.mocked(authService.me).mockRejectedValue(new ApiError("Authentication required", 401));
  });

  it("shows validation errors for empty submission without calling the API", async () => {
    const user = userEvent.setup();
    renderRegisterForm();

    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/display name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/email is required/i)).toBeInTheDocument();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(authService.register).not.toHaveBeenCalled();
  });

  it("shows an error for a malformed (but non-empty) email", async () => {
    const user = userEvent.setup();
    renderRegisterForm();

    await user.type(screen.getByLabelText(/display name/i), "Test User");
    await user.type(screen.getByLabelText(/email/i), "not-an-email");
    await user.type(screen.getByLabelText(/password/i), "a-valid-password");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/invalid email address/i)).toBeInTheDocument();
    expect(authService.register).not.toHaveBeenCalled();
  });

  it("shows an error for a password under 8 characters", async () => {
    const user = userEvent.setup();
    renderRegisterForm();

    await user.type(screen.getByLabelText(/display name/i), "Test User");
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(authService.register).not.toHaveBeenCalled();
  });

  it("submits valid input and shows the server error on failure (e.g. duplicate email)", async () => {
    vi.mocked(authService.register).mockRejectedValue(
      new ApiError("An account with this email already exists", 409),
    );
    const user = userEvent.setup();
    renderRegisterForm();

    await user.type(screen.getByLabelText(/display name/i), "Test User");
    await user.type(screen.getByLabelText(/email/i), "taken@example.com");
    await user.type(screen.getByLabelText(/password/i), "a-valid-password");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(authService.register).toHaveBeenCalledWith({
      displayName: "Test User",
      email: "taken@example.com",
      password: "a-valid-password",
    });
  });

  it("calls register with valid input on success", async () => {
    vi.mocked(authService.register).mockResolvedValue({
      user: {
        _id: "1",
        email: "new@example.com",
        displayName: "New User",
        role: "member",
        createdAt: "",
        updatedAt: "",
      },
    });
    const user = userEvent.setup();
    renderRegisterForm();

    await user.type(screen.getByLabelText(/display name/i), "New User");
    await user.type(screen.getByLabelText(/email/i), "new@example.com");
    await user.type(screen.getByLabelText(/password/i), "a-valid-password");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(authService.register).toHaveBeenCalledTimes(1));
  });

  it("links to the login page", () => {
    renderRegisterForm();
    expect(screen.getByRole("link", { name: /log in/i })).toHaveAttribute("href", "/login");
  });
});
