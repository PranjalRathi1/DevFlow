import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NewProjectPage from "../NewProjectPage";
import { projectService } from "../../services/projectService";
import type { Project } from "../../types/project";

vi.mock("../../services/projectService");

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/projects/new"]}>
        <Routes>
          <Route path="/app/projects/new" element={<NewProjectPage />} />
          <Route path="/app/projects/:projectId" element={<div>Project detail page</div>} />
          <Route path="/app/projects" element={<div>Projects list page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NewProjectPage", () => {
  it("shows a validation error and does not call the API for an empty name", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(projectService.create).not.toHaveBeenCalled();
  });

  it("creates a project and navigates to its detail page on success", async () => {
    const created: Project = {
      _id: "new-id",
      name: "My New Project",
      description: "",
      owner: "u1",
      status: "planning",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(projectService.create).mockResolvedValue({ project: created });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^name$/i), "My New Project");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(await screen.findByText("Project detail page")).toBeInTheDocument();
    expect(projectService.create).toHaveBeenCalledWith(expect.objectContaining({ name: "My New Project" }));
  });

  it("shows a server error and does not navigate on failure", async () => {
    vi.mocked(projectService.create).mockRejectedValue(new Error("Server exploded"));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^name$/i), "Doomed Project");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    expect(await screen.findByText(/server exploded/i)).toBeInTheDocument();
    expect(screen.queryByText("Project detail page")).not.toBeInTheDocument();
  });
});
