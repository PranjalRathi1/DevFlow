import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderProjectTab } from "../../../test/renderWithProviders";
import ProjectRequirementsTab from "../ProjectRequirementsTab";
import { projectService } from "../../../services/projectService";
import { requirementService } from "../../../services/requirementService";
import type { Project } from "../../../types/project";
import type { Requirement } from "../../../types/requirement";

vi.mock("../../../services/projectService");
vi.mock("../../../services/requirementService");

const project: Project = {
  _id: "proj-1",
  name: "Test Project",
  description: "",
  owner: "u1",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const sampleRequirement: Requirement = {
  _id: "req-1",
  project: "proj-1",
  owner: "u1",
  title: "Add SSO",
  description: "Support single sign-on",
  status: "draft",
  priority: "high",
  acceptanceCriteria: ["Users can log in with Google"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderTab() {
  vi.mocked(projectService.get).mockResolvedValue({ project });
  return renderProjectTab(<ProjectRequirementsTab />, project._id);
}

describe("ProjectRequirementsTab", () => {
  it("shows an empty state with no requirements", async () => {
    vi.mocked(requirementService.list).mockResolvedValue({ requirements: [] });
    renderTab();

    expect(await screen.findByText(/no requirements yet/i)).toBeInTheDocument();
  });

  it("lists requirements with status/priority badges and acceptance criteria count", async () => {
    vi.mocked(requirementService.list).mockResolvedValue({ requirements: [sampleRequirement] });
    renderTab();

    expect(await screen.findByText("Add SSO")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/high priority/i)).toBeInTheDocument();
    expect(screen.getByText(/1 acceptance criterion/i)).toBeInTheDocument();
  });

  it("validates the create form and creates a requirement on submit", async () => {
    vi.mocked(requirementService.list).mockResolvedValue({ requirements: [] });
    vi.mocked(requirementService.create).mockResolvedValue({ requirement: sampleRequirement });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText(/no requirements yet/i);
    // Two "New Requirement" buttons are on screen at once here (the
    // persistent header action + the empty state's own CTA) — legitimate
    // UI, not a bug; either opens the same dialog.
    await user.click(screen.getAllByRole("button", { name: /new requirement/i })[0] as HTMLElement);

    // Empty submit shows validation, doesn't call the API.
    await user.click(screen.getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
    expect(requirementService.create).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/title/i), "Add SSO");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(requirementService.create).toHaveBeenCalledTimes(1));
  });
});
