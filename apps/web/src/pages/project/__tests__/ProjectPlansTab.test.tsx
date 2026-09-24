import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderProjectTab } from "../../../test/renderWithProviders";
import ProjectPlansTab from "../ProjectPlansTab";
import { projectService } from "../../../services/projectService";
import { requirementService } from "../../../services/requirementService";
import { planService } from "../../../services/planService";
import { scanService } from "../../../services/scanService";
import type { Project } from "../../../types/project";
import type { Requirement } from "../../../types/requirement";
import type { Plan } from "../../../types/plan";
import type { Scan } from "../../../types/scan";

vi.mock("../../../services/projectService");
vi.mock("../../../services/requirementService");
vi.mock("../../../services/planService");
vi.mock("../../../services/scanService");

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

const latestScan = {
  _id: "scan-1",
  project: "proj-1",
  outcome: "completed",
  items: [],
  createdAt: new Date().toISOString(),
} as unknown as Scan;

function renderTab(scan: Scan | null = null) {
  vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan });
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
  it("grounds generation in the latest scan by default, and can opt out", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
    vi.mocked(planService.list).mockResolvedValue({ plans: [] });
    vi.mocked(planService.generate).mockResolvedValue({ plan: samplePlan });
    const user = userEvent.setup();
    renderTab(latestScan);

    const checkbox = await screen.findByRole("checkbox", { name: /ground the plan in the latest scan/i });
    expect(checkbox).toBeChecked();
    await user.selectOptions(screen.getByLabelText(/requirement/i), "req-1");
    await user.click(screen.getByRole("button", { name: /generate plan/i }));
    await waitFor(() => expect(planService.generate).toHaveBeenCalledWith("proj-1", "req-1", "scan-1"));

    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: /generate plan/i }));
    await waitFor(() => expect(planService.generate).toHaveBeenLastCalledWith("proj-1", "req-1", undefined));
  });

  it("explains that a plan will be ungrounded when there is no usable scan", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
    vi.mocked(planService.list).mockResolvedValue({ plans: [] });
    renderTab({ ...latestScan, outcome: "failed" } as Scan);

    expect(await screen.findByText(/no usable scan yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows scan grounding, rationale, and per-file evidence in the review dialog", async () => {
    const groundedPlan: Plan = {
      ...samplePlan,
      sourceContext: {
        scan: "scan-1",
        analysis: "an-1",
        contextVersion: 1,
        truncated: false,
        counts: {
          files: 12,
          graphNodes: 9,
          confirmedEdges: 7,
          unresolved: 2,
          external: 5,
          externalPackages: 3,
          unsupported: 1,
          parseErrors: 0,
          cycles: 0,
        },
      },
      suggestedTasks: [
        {
          ...samplePlan.suggestedTasks[0]!,
          rationale: "util.ts is imported by index.ts",
          affectedFiles: [
            {
              path: "src/util.ts",
              reason: "add cache",
              evidence: "in_scan",
              dependentsCount: 3,
              dependenciesCount: 1,
            },
            { path: "src/cache.ts", reason: "new module", evidence: "not_in_scan" },
          ],
        },
      ],
    };
    vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
    vi.mocked(planService.list).mockResolvedValue({ plans: [groundedPlan] });
    const user = userEvent.setup();
    renderTab(latestScan);

    await user.click(await screen.findByText("Authentication Plan"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/12 files · 7 confirmed dependencies · 2 unresolved/)).toBeInTheDocument();
    expect(dialog.getByText(/no import cycles/)).toBeInTheDocument();
    expect(dialog.getByText(/util\.ts is imported by index\.ts/)).toBeInTheDocument();

    const files = within(dialog.getByRole("list", { name: /affected files for design schema/i }));
    const [existing, proposed] = files.getAllByRole("listitem");
    expect(within(existing!).getByText("src/util.ts")).toBeInTheDocument();
    expect(within(existing!).getByText("In scan")).toBeInTheDocument();
    expect(within(existing!).getByText(/imported by 3 · imports 1/)).toBeInTheDocument();
    expect(within(proposed!).getByText("src/cache.ts")).toBeInTheDocument();
    expect(within(proposed!).getByText(/not in scan — proposed/i)).toBeInTheDocument();
  });

  it("labels a plan without scan context as unverified", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
    vi.mocked(planService.list).mockResolvedValue({ plans: [{ ...samplePlan, sourceContext: null }] });
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByText("Authentication Plan"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/not grounded in a scan/i)).toBeInTheDocument();
  });
});
