import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderProjectTab } from "../../../test/renderWithProviders";
import ProjectPlansTab from "../ProjectPlansTab";
import { projectService } from "../../../services/projectService";
import { requirementService } from "../../../services/requirementService";
import { planService } from "../../../services/planService";
import type { Project } from "../../../types/project";
import type { Requirement } from "../../../types/requirement";
import type { Plan } from "../../../types/plan";

vi.mock("../../../services/projectService");
vi.mock("../../../services/requirementService");
vi.mock("../../../services/planService");

const project: Project = {
  _id: "proj-1",
  name: "Test Project",
  description: "",
  owner: "u1",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const requirement: Requirement = {
  _id: "req-1",
  project: "proj-1",
  owner: "u1",
  title: "Add authentication",
  description: "",
  status: "draft",
  priority: "medium",
  acceptanceCriteria: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const samplePlan: Plan = {
  _id: "plan-1",
  project: "proj-1",
  owner: "u1",
  requirement: "req-1",
  status: "needs_review",
  title: "Authentication Plan",
  summary: "Implement JWT login.",
  assumptions: ["Users have emails"],
  risks: ["No password reset"],
  suggestedTasks: [
    {
      tempId: "t1",
      title: "Design schema",
      description: "",
      acceptanceCriteria: [],
      priority: "medium",
      dependsOn: [],
    },
  ],
  suggestedOrder: ["t1"],
  validation: { valid: true, errors: [] },
  aiMeta: { provider: "ollama", model: "qwen2.5:7b", generatedAt: new Date().toISOString(), durationMs: 500 },
  reviewedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderTab() {
  vi.mocked(projectService.get).mockResolvedValue({ project });
  vi.mocked(requirementService.list).mockResolvedValue({ requirements: [requirement] });
  return renderProjectTab(<ProjectPlansTab />, project._id);
}

describe("ProjectPlansTab", () => {
  it("shows a warning and disables generation when the AI provider is unavailable", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({
      available: false,
      provider: "ollama",
      model: "qwen2.5:7b",
    });
    vi.mocked(planService.list).mockResolvedValue({ plans: [] });
    renderTab();

    expect(await screen.findByText(/currently unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate plan/i })).toBeDisabled();
  });

  it("shows an empty state when there are no plans yet", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({
      available: true,
      provider: "ollama",
      model: "qwen2.5:7b",
    });
    vi.mocked(planService.list).mockResolvedValue({ plans: [] });
    renderTab();

    expect(await screen.findByText(/no plans yet/i)).toBeInTheDocument();
  });

  it("generates a plan and shows a validation-style error from the API on failure", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({
      available: true,
      provider: "ollama",
      model: "qwen2.5:7b",
    });
    vi.mocked(planService.list).mockResolvedValue({ plans: [] });
    vi.mocked(planService.generate).mockRejectedValue(new Error("The AI-generated plan failed validation"));
    const user = userEvent.setup();
    renderTab();

    await screen.findByText(/no plans yet/i);
    await user.selectOptions(screen.getByLabelText(/requirement/i), "req-1");
    await user.click(screen.getByRole("button", { name: /generate plan/i }));

    expect(await screen.findByText(/failed validation/i)).toBeInTheDocument();
  });

  it("lists an existing plan and reviews/approves it", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({
      available: true,
      provider: "ollama",
      model: "qwen2.5:7b",
    });
    vi.mocked(planService.list).mockResolvedValue({ plans: [samplePlan] });
    vi.mocked(planService.approve).mockResolvedValue({
      plan: { ...samplePlan, status: "approved" },
      createdTasks: [],
    });
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByText("Authentication Plan"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Design schema")).toBeInTheDocument();

    await user.click(dialog.getByRole("button", { name: /approve & create tasks/i }));

    await waitFor(() => expect(planService.approve).toHaveBeenCalledWith("plan-1"));
  });

  it("rejects a plan under review", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({
      available: true,
      provider: "ollama",
      model: "qwen2.5:7b",
    });
    vi.mocked(planService.list).mockResolvedValue({ plans: [samplePlan] });
    vi.mocked(planService.reject).mockResolvedValue({ plan: { ...samplePlan, status: "rejected" } });
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByText("Authentication Plan"));
    await user.click(await screen.findByRole("button", { name: /^reject$/i }));

    await waitFor(() => expect(planService.reject).toHaveBeenCalledWith("plan-1"));
  });
});
