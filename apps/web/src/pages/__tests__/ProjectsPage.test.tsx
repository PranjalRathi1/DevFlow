import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import ProjectsPage from "../ProjectsPage";
import { projectService } from "../../services/projectService";
import type { Project } from "../../types/project";

vi.mock("../../services/projectService");

const sampleProject: Project = {
  _id: "p1",
  name: "DevFlow AI",
  description: "The app itself",
  owner: "u1",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("ProjectsPage", () => {
  it("shows a loading state, then the empty state when there are no projects", async () => {
    vi.mocked(projectService.list).mockResolvedValue({ projects: [] });
    renderWithProviders(<ProjectsPage />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("renders real projects returned by the API", async () => {
    vi.mocked(projectService.list).mockResolvedValue({ projects: [sampleProject] });
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText("DevFlow AI")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows an error state when the request fails", async () => {
    vi.mocked(projectService.list).mockRejectedValue(new Error("network down"));
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/network down/i);
  });
});
