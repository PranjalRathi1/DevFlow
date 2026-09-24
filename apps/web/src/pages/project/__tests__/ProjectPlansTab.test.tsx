import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderProjectTab } from "../../../test/renderWithProviders";
import ProjectPlansTab from "../ProjectPlansTab";
import { projectService } from "../../../services/projectService";
import { requirementService } from "../../../services/requirementService";
import { planService } from "../../../services/planService";
import { scanService } from "../../../services/scanService";
import { graphService } from "../../../services/graphService";
import type { Project } from "../../../types/project";
import type { Requirement } from "../../../types/requirement";
import type { Plan } from "../../../types/plan";
import type { Scan } from "../../../types/scan";

vi.mock("../../../services/projectService");
vi.mock("../../../services/requirementService");
vi.mock("../../../services/planService");
vi.mock("../../../services/scanService");
vi.mock("../../../services/graphService");

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

// Only the fields the Plans tab reads from the graph.
const graphWith = (ids: string[]) =>
  ({ graph: { nodes: ids.map((id) => ({ id })) } }) as unknown as Awaited<
    ReturnType<typeof graphService.getGraph>
  >;

function renderTab(scan: Scan | null = null, graphIds: string[] | null = null) {
  vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan });
  if (graphIds) vi.mocked(graphService.getGraph).mockResolvedValue(graphWith(graphIds));
  else
    vi.mocked(graphService.getGraph).mockRejectedValue(
      new Error("No analysis has been run for this scan yet"),
    );
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
    await waitFor(() =>
      expect(planService.generate).toHaveBeenCalledWith("proj-1", "req-1", "scan-1", undefined),
    );

    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: /generate plan/i }));
    await waitFor(() =>
      expect(planService.generate).toHaveBeenLastCalledWith("proj-1", "req-1", undefined, undefined),
    );
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

  it("separates the AI's claims from DevFlow's checks in the review dialog", async () => {
    const plan: Plan = {
      ...samplePlan,
      sourceContext: {
        scan: "scan-1",
        analysis: "an-1",
        contextVersion: 3,
        truncated: false,
        counts: {
          files: 5,
          graphNodes: 4,
          confirmedEdges: 3,
          unresolved: 0,
          external: 1,
          externalPackages: 1,
          unsupported: 0,
          parseErrors: 0,
          cycles: 0,
        },
        focusTerms: ["limit", "rate"],
        focusFiles: ["src/middleware/rateLimit.middleware.ts"],
      },
      suggestedTasks: [
        {
          ...samplePlan.suggestedTasks[0]!,
          testingApproach: "Integration test in auth.integration.test.ts",
          affectedFiles: [
            {
              path: "src/middleware/rateLimit.middleware.ts",
              reason: "existing limiter",
              change: "reference",
              evidence: "in_scan",
              dependentsCount: 1,
              dependenciesCount: 1,
            },
            {
              path: "src/util.ts",
              reason: "",
              change: "create",
              evidence: "in_scan",
              conflict: 'Claimed "create", but this file already exists in the scan',
            },
          ],
        },
      ],
    };
    vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
    vi.mocked(planService.list).mockResolvedValue({ plans: [plan] });
    const user = userEvent.setup();
    renderTab(latestScan);

    await user.click(await screen.findByText("Authentication Plan"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(/matched by file name only, not proof of relevance/i)).toHaveTextContent(
      "src/middleware/rateLimit.middleware.ts",
    );
    expect(dialog.getByText(/file labels are checked by devflow/i)).toBeInTheDocument();
    expect(dialog.getByText(/integration test in auth\.integration\.test\.ts/i)).toBeInTheDocument();
    // The testing approach is AI-authored and labelled as such.
    expect(dialog.getByText(/AI testing approach:/)).toBeInTheDocument();
    const files = within(dialog.getByRole("list", { name: /affected files for design schema/i }));
    const [reference, conflicting] = files.getAllByRole("listitem");
    expect(reference).toHaveTextContent("AI intent: follow its pattern (no change)");
    expect(reference).toHaveTextContent("In scan");
    expect(conflicting).toHaveTextContent('Claimed "create", but this file already exists in the scan');
  });

  it("states the review outcome for an approved plan and offers no review actions", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
    vi.mocked(planService.list).mockResolvedValue({
      plans: [{ ...samplePlan, status: "approved", reviewedAt: new Date().toISOString() }],
    });
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByText("Authentication Plan"));
    const dialog = within(await screen.findByRole("dialog"));
    expect(
      dialog.getByText(/approved — its tasks were created with a copy of this evidence/i),
    ).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: /^reject$/i })).not.toBeInTheDocument();
  });

  it("offers the scan's analysed files as an optional impact target and sends the choice", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
    vi.mocked(planService.list).mockResolvedValue({ plans: [] });
    vi.mocked(planService.generate).mockResolvedValue({ plan: samplePlan });
    const user = userEvent.setup();
    renderTab(latestScan, ["src/a.ts", "src/routes/scan.routes.ts"]);

    const target = await screen.findByLabelText(/file you plan to change/i);
    await user.selectOptions(screen.getByLabelText(/^requirement$/i), "req-1");
    await user.selectOptions(target, "src/routes/scan.routes.ts");
    await user.click(screen.getByRole("button", { name: /generate plan/i }));
    await waitFor(() =>
      expect(planService.generate).toHaveBeenCalledWith(
        "proj-1",
        "req-1",
        "scan-1",
        "src/routes/scan.routes.ts",
      ),
    );
  });

  it("hides the impact target picker when the scan has no analysis", async () => {
    vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
    vi.mocked(planService.list).mockResolvedValue({ plans: [] });
    renderTab(latestScan, null);
    await screen.findByRole("checkbox", { name: /ground the plan in the latest scan/i });
    expect(screen.queryByLabelText(/file you plan to change/i)).not.toBeInTheDocument();
  });

  describe("review evidence (Stage 8)", () => {
    const baseContext = {
      scan: "scan-1",
      analysis: "an-1",
      contextVersion: 3,
      truncated: false,
      counts: {
        files: 5,
        graphNodes: 4,
        confirmedEdges: 3,
        unresolved: 0,
        external: 0,
        externalPackages: 0,
        unsupported: 0,
        parseErrors: 0,
        cycles: 0,
      },
    };
    const planWith = (
      sourceContext: NonNullable<Plan["sourceContext"]>,
      affectedFiles: NonNullable<Plan["suggestedTasks"][number]["affectedFiles"]>,
    ): Plan => ({
      ...samplePlan,
      sourceContext,
      suggestedTasks: [{ ...samplePlan.suggestedTasks[0]!, affectedFiles }],
    });
    async function openReview(plan: Plan, scan: Scan | null = latestScan) {
      vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
      vi.mocked(planService.list).mockResolvedValue({ plans: [plan] });
      const user = userEvent.setup();
      renderTab(scan);
      await user.click(await screen.findByText("Authentication Plan"));
      return within(await screen.findByRole("dialog"));
    }

    it("warns when the plan's evidence comes from an older scan than the latest", async () => {
      const dialog = await openReview(planWith({ ...baseContext, scan: "scan-OLD" }, []), latestScan);
      expect(await dialog.findByText(/a newer scan of this project exists/i)).toBeInTheDocument();
    });

    it("does not warn when the plan is grounded in the latest scan", async () => {
      const dialog = await openReview(planWith(baseContext, []), latestScan);
      await dialog.findByText(/grounded in scan/i);
      expect(dialog.queryByText(/a newer scan of this project exists/i)).not.toBeInTheDocument();
    });

    it("says an incomplete scan leaves unread files unverified, and shows why for each", async () => {
      const dialog = await openReview(
        planWith(
          {
            ...baseContext,
            coverage: { stoppedEarly: ["maxFiles"], unreadDirectories: 2, ignoredDirectories: 1 },
          },
          [
            {
              path: "node_modules/x/index.js",
              reason: "",
              evidence: "unverified",
              evidenceNote:
                "Inside node_modules, an ignored directory (dependencies/build output); the scan did not look inside it.",
            },
          ],
        ),
      );
      expect(dialog.getByText(/the scan was incomplete \(stopped early: maxFiles\)/i)).toBeInTheDocument();
      const list = within(dialog.getByRole("list", { name: /affected files for design schema/i }));
      expect(list.getByText("Unverified")).toBeInTheDocument();
      expect(list.getByText(/why unverified: inside node_modules/i)).toBeInTheDocument();
    });

    it("words impact relations as possibilities and flags an unreferenced target", async () => {
      const dialog = await openReview(
        planWith(
          {
            ...baseContext,
            impact: {
              file: "src/routes/scan.routes.ts",
              inGraph: true,
              maxDepth: 6,
              maxNodes: 30,
              directDependencies: 8,
              directDependents: 1,
              transitiveDependentsShown: 16,
              truncated: true,
            },
          },
          [
            {
              path: "src/controllers/scan.controller.ts",
              reason: "",
              change: "modify",
              evidence: "in_scan",
              impactRelation: "dependency",
            },
            {
              path: "src/routes/index.ts",
              reason: "wire it",
              evidence: "in_scan",
              impactRelation: "direct_dependent",
            },
          ],
        ),
      );
      const summary = dialog.getByText(/planned change target/i);
      expect(summary).toHaveTextContent("src/routes/scan.routes.ts");
      expect(summary).toHaveTextContent(/more files may be affected/);
      expect(summary).toHaveTextContent(/do not all need to change/);
      expect(summary).toHaveTextContent(/no task in this plan references the target file/i);
      const list = within(dialog.getByRole("list", { name: /affected files for design schema/i }));
      expect(
        list.getByText(/imported by the target \(changing the target does not affect it\)/),
      ).toBeInTheDocument();
      expect(list.getByText(/imports the target directly \(may be affected\)/)).toBeInTheDocument();
      // AI prose is labelled as the AI's own words.
      expect(list.getByText(/AI's reason: wire it/)).toBeInTheDocument();
      expect(dialog.queryByText(/must change/i)).not.toBeInTheDocument();
    });

    it("shows when the AI's context was reduced to fit its budget, and that omitted is not absent", async () => {
      const dialog = await openReview(
        planWith(
          {
            ...baseContext,
            fitting: {
              budgetTokens: 12032,
              estimatedTokensBefore: 24000,
              estimatedTokensAfter: 11800,
              steps: ["files:100", "externalPackages:20", "edges:200"],
              reductions: [
                { section: "files", shown: 100, total: 2000 },
                { section: "confirmed dependencies", shown: 200, total: 6000 },
              ],
            },
          },
          [],
        ),
      );
      const note = dialog.getByText(/some evidence lists were shortened/i);
      expect(note).toHaveTextContent("files (100 of 2000), confirmed dependencies (200 of 6000)");
      expect(note).toHaveTextContent(/not absent from the project/);
    });

    it("says nothing about reduction when the full context fit", async () => {
      const dialog = await openReview(
        planWith(
          {
            ...baseContext,
            fitting: {
              budgetTokens: 12032,
              estimatedTokensBefore: 5000,
              estimatedTokensAfter: 5000,
              steps: [],
              reductions: [],
            },
          },
          [],
        ),
      );
      await dialog.findByText(/grounded in scan/i);
      expect(dialog.queryByText(/some evidence lists were shortened/i)).not.toBeInTheDocument();
    });

    it("explains every label, including that unverified is not absent", async () => {
      const dialog = await openReview(planWith(baseContext, []));
      const legend = dialog.getByText(/file labels are checked by devflow/i);
      expect(legend).toHaveTextContent(/the scan looked there and did not find it/);
      expect(legend).toHaveTextContent(/devflow could not check/i);
      expect(legend).toHaveTextContent(/not how code runs/);
    });
  });

  describe("claims, freshness and resolution evidence (Task 3)", () => {
    const ctx = {
      scan: "scan-1",
      analysis: "an-1",
      contextVersion: 4,
      truncated: false,
      scanCreatedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
      counts: {
        files: 5,
        graphNodes: 4,
        confirmedEdges: 3,
        unresolved: 0,
        external: 0,
        externalPackages: 0,
        unsupported: 0,
        parseErrors: 0,
        cycles: 0,
      },
    };
    async function openReview(plan: Plan, graph?: { scanId: string; analysisId: string }) {
      vi.mocked(planService.aiStatus).mockResolvedValue({ available: true, provider: "ollama", model: "m" });
      vi.mocked(planService.list).mockResolvedValue({ plans: [plan] });
      vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: latestScan });
      if (graph) {
        vi.mocked(graphService.getGraph).mockResolvedValue({
          graph: { ...graph, nodes: [{ id: "src/a.ts" }] },
        } as unknown as Awaited<ReturnType<typeof graphService.getGraph>>);
      } else {
        vi.mocked(graphService.getGraph).mockRejectedValue(new Error("No analysis"));
      }
      vi.mocked(projectService.get).mockResolvedValue({ project });
      vi.mocked(requirementService.list).mockResolvedValue({ requirements: [requirement] });
      const user = userEvent.setup();
      renderProjectTab(<ProjectPlansTab />, project._id);
      await user.click(await screen.findByText("Authentication Plan"));
      return within(await screen.findByRole("dialog"));
    }

    it("shows each checked AI statement as the AI's words next to DevFlow's finding", async () => {
      const plan: Plan = {
        ...samplePlan,
        sourceContext: ctx,
        suggestedTasks: [
          {
            ...samplePlan.suggestedTasks[0]!,
            affectedFiles: [
              {
                path: "src/routes.ts",
                reason: "Imported by src/app.ts and src/worker.ts",
                evidence: "in_scan",
                claimChecks: [
                  {
                    kind: "imported_by",
                    target: "src/app.ts",
                    status: "supported",
                    note: "Confirmed import src/app.ts -> src/routes.ts (line 3).",
                  },
                  {
                    kind: "imported_by",
                    target: "src/worker.ts",
                    status: "not_found",
                    note: "No confirmed import src/worker.ts -> src/routes.ts in this scan.",
                  },
                ],
              },
            ],
            mentionedPaths: [
              {
                kind: "mentions",
                target: "src/ghost.ts",
                status: "not_in_scan",
                note: "The scan looked for this path and did not find it.",
              },
            ],
          },
        ],
      };
      const dialog = await openReview(plan);
      const fileClaims = within(dialog.getByRole("list", { name: "Checked statements about src/routes.ts" }));
      const items = fileClaims.getAllByRole("listitem");
      expect(items[0]).toHaveTextContent(
        /AI: .src\/routes\.ts is imported by src\/app\.ts.\s*Supported by scan/,
      );
      expect(items[1]).toHaveTextContent(
        /src\/routes\.ts is imported by src\/worker\.ts.\s*Not shown by scan/,
      );
      const taskClaims = within(
        dialog.getByRole("list", { name: "Checked statements in the text of Design schema" }),
      );
      expect(taskClaims.getByText("Not in scan")).toBeInTheDocument();
      expect(taskClaims.getByText(/names src\/ghost\.ts/)).toBeInTheDocument();
      // Never worded as a verdict on the AI.
      expect(dialog.queryByText(/\b(false|wrong|incorrect)\b/i)).not.toBeInTheDocument();
    });

    it("explains a file created by an earlier task instead of flagging it", async () => {
      const dialog = await openReview({
        ...samplePlan,
        sourceContext: ctx,
        suggestedTasks: [
          {
            ...samplePlan.suggestedTasks[0]!,
            affectedFiles: [{ path: "src/page.ts", reason: "", change: "create", evidence: "not_in_scan" }],
          },
          {
            tempId: "t2",
            title: "Fill page",
            description: "",
            acceptanceCriteria: [],
            priority: "medium",
            dependsOn: ["t1"],
            affectedFiles: [
              { path: "src/page.ts", reason: "", change: "modify", evidence: "not_in_scan", plannedBy: "t1" },
            ],
          },
        ],
        suggestedOrder: ["t1", "t2"],
      });
      const list = within(dialog.getByRole("list", { name: "Affected files for Fill page" }));
      expect(
        list.getByText(/created earlier in this plan by .Design schema., which this task depends on/),
      ).toBeInTheDocument();
      expect(list.getByText("Not in scan — proposed")).toBeInTheDocument();
    });

    it("states the evidence age and that later edits are not reflected", async () => {
      const dialog = await openReview({ ...samplePlan, sourceContext: ctx });
      expect(dialog.getByText(/grounded in scan from .*\(3 days ago\)/i)).toBeInTheDocument();
      expect(dialog.getByText(/files changed after this scan are not reflected/i)).toBeInTheDocument();
    });

    it("notes when the plan's scan has been analysed again since generation", async () => {
      const dialog = await openReview(
        { ...samplePlan, sourceContext: ctx },
        { scanId: "scan-1", analysisId: "an-2" },
      );
      expect(await dialog.findByText(/analysed again after the plan was generated/i)).toBeInTheDocument();
    });

    it("does not note re-analysis when the plan uses the latest analysis", async () => {
      const dialog = await openReview(
        { ...samplePlan, sourceContext: ctx },
        { scanId: "scan-1", analysisId: "an-1" },
      );
      await dialog.findByText(/grounded in scan/i);
      expect(dialog.queryByText(/analysed again/i)).not.toBeInTheDocument();
    });

    it("shows the alias configuration and its problems, bounded", async () => {
      const dialog = await openReview({
        ...samplePlan,
        sourceContext: {
          ...ctx,
          resolution: {
            aliasConfigs: ["apps/web/tsconfig.json"],
            localPackages: 2,
            diagnosticsTotal: 7,
            diagnostics: [
              {
                file: "packages/ui/tsconfig.json",
                message: 'extends "@tsconfig/strictest" refers to a package; unsupported',
              },
            ],
          },
        },
      });
      expect(
        dialog.getByText(/path aliases from apps\/web\/tsconfig\.json; 2 local package\.json/),
      ).toBeInTheDocument();
      expect(dialog.getByText(/7 configuration problem\(s\)/)).toBeInTheDocument();
      const problems = within(dialog.getByRole("list", { name: "Import configuration problems" }));
      expect(problems.getByText(/refers to a package; unsupported/)).toBeInTheDocument();
      expect(problems.getByText("…and 6 more")).toBeInTheDocument();
    });

    it("shows exact impact totals including type-only dependents and entry points", async () => {
      const dialog = await openReview({
        ...samplePlan,
        sourceContext: {
          ...ctx,
          impact: {
            file: "src/types.ts",
            inGraph: true,
            maxDepth: 6,
            maxNodes: 30,
            directDependencies: 0,
            directDependents: 4,
            transitiveDependentsShown: 5,
            dependentsAtAnyDepth: 10,
            typeOnlyDependents: 2,
            entryPointsAffected: 6,
            truncated: false,
          },
        },
      });
      expect(dialog.getByText(/planned change target/i)).toHaveTextContent(
        /In total 10 file\(s\) depend on it at any depth \(2 only through type-only imports\); 6 entry point\(s\) reach it\./,
      );
    });
  });
});
