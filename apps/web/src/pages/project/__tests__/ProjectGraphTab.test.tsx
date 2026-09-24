import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderProjectTab } from "../../../test/renderWithProviders";
import ProjectGraphTab from "../ProjectGraphTab";
import { projectService } from "../../../services/projectService";
import { scanService } from "../../../services/scanService";
import { graphService } from "../../../services/graphService";
import { ApiError } from "../../../services/apiClient";
import type { Project } from "../../../types/project";
import type { Scan } from "../../../types/scan";
import type { ScanDependencyGraph } from "../../../types/graph";

vi.mock("../../../services/projectService");
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

function sampleScan(): Scan {
  return {
    _id: "scan-1",
    project: "proj-1",
    outcome: "completed",
    summary: {
      totalScanned: 3,
      totalSkipped: 0,
      totalErrors: 0,
      filesByCategory: {},
      filesByLanguage: {},
      limitsReached: [],
      durationMs: 5,
    },
    items: [],
    createdAt: new Date().toISOString(),
  };
}

function sampleGraph(overrides: Partial<ScanDependencyGraph> = {}): ScanDependencyGraph {
  return {
    scanId: "scan-1",
    analysisId: "analysis-1",
    nodes: [
      { id: "src/a.ts", language: "typescript" },
      { id: "src/b.ts", language: "typescript" },
      { id: "src/c.ts", language: "typescript" },
    ],
    edges: [
      {
        id: "src/a.ts::src/b.ts",
        from: "src/a.ts",
        to: "src/b.ts",
        evidence: [
          { rawImport: "./b", isLiteral: true, importType: "import", line: 1, column: 1 },
          { rawImport: "./b.ts", isLiteral: true, importType: "import", line: 2, column: 1 },
        ],
      },
      {
        id: "src/b.ts::src/c.ts",
        from: "src/b.ts",
        to: "src/c.ts",
        evidence: [{ rawImport: "./c", isLiteral: true, importType: "import", line: 1, column: 1 }],
      },
    ],
    unresolved: [
      {
        importerRelativePath: "src/a.ts",
        rawImport: "./missing",
        isLiteral: true,
        status: "unresolved",
        reason: "No matching file found",
      },
    ],
    external: [{ importerRelativePath: "src/a.ts", rawImport: "react", isLiteral: true, status: "external" }],
    unsupported: [
      {
        importerRelativePath: "src/a.ts",
        rawImport: "./styles.css",
        isLiteral: true,
        status: "unsupported",
        reason: "unsupported extension",
      },
    ],
    parseErrors: [
      {
        importerRelativePath: "src/broken.ts",
        rawImport: "",
        isLiteral: false,
        status: "parse_error",
        reason: "Syntax errors detected",
      },
    ],
    validationErrors: [],
    cycles: [],
    isAcyclic: true,
    topologicalOrder: ["src/c.ts", "src/b.ts", "src/a.ts"],
    rootNodes: ["src/a.ts"],
    leafNodes: ["src/c.ts"],
    ...overrides,
  };
}

function renderTab() {
  vi.mocked(projectService.get).mockResolvedValue({ project });
  return renderProjectTab(<ProjectGraphTab />, project._id);
}

describe("ProjectGraphTab", () => {
  it("shows a loading state before scan/graph data resolves", async () => {
    vi.mocked(scanService.getLatestScan).mockImplementation(() => new Promise(() => {}));
    renderTab();
    expect(await screen.findByText(/loading scan/i)).toBeInTheDocument();
  });

  it("shows a 'no scan yet' state when the project has never been scanned", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: null });
    renderTab();
    expect(await screen.findByText(/no scan yet/i)).toBeInTheDocument();
  });

  it("shows a missing-analysis state (404) and offers to run analysis, without running it automatically", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockRejectedValue(
      new ApiError("No analysis has been run for this scan yet", 404),
    );
    renderTab();

    expect(await screen.findByText(/no analysis has been run/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run analysis/i })).toBeInTheDocument();
    expect(graphService.runAnalysis).not.toHaveBeenCalled();
  });

  it("running analysis from the missing-analysis state calls the API and does not fire automatically on load", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockRejectedValue(
      new ApiError("No analysis has been run for this scan yet", 404),
    );
    vi.mocked(graphService.runAnalysis).mockResolvedValue({
      analysis: {
        _id: "a1",
        scan: "scan-1",
        outcome: "completed",
        summary: { totalFilesAnalyzed: 1, totalFilesSkipped: 0, totalRelationships: 0, byStatus: {} },
        createdAt: new Date().toISOString(),
      },
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByRole("button", { name: /run analysis/i });
    await user.click(screen.getByRole("button", { name: /run analysis/i }));
    await waitFor(() => expect(graphService.runAnalysis).toHaveBeenCalledWith("scan-1"));
  });

  it("shows a safe generic message on a non-404 API failure, not a raw server error", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockRejectedValue(new ApiError("Internal server error", 500));
    renderTab();
    expect(await screen.findByText(/internal server error/i)).toBeInTheDocument();
    expect(screen.queryByText(/no analysis has been run/i)).not.toBeInTheDocument();
  });

  it("shows an empty-graph state when analysis found no confirmed dependencies", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({
      graph: sampleGraph({ edges: [], unresolved: [], external: [], unsupported: [], parseErrors: [] }),
    });
    renderTab();
    expect(await screen.findByText(/no confirmed local dependencies/i)).toBeInTheDocument();
  });

  it("renders nodes and edges with correct importer -> imported direction, using only safe relative paths", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({ graph: sampleGraph() });
    renderTab();

    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    expect(screen.getByText("src/c.ts")).toBeInTheDocument();

    // Accessible edge description states the importer->imported direction explicitly.
    expect(screen.getByRole("button", { name: /src\/a\.ts imports src\/b\.ts/i })).toBeInTheDocument();

    const fullText = document.body.textContent ?? "";
    expect(fullText).not.toMatch(/[a-zA-Z]:\\/); // no Windows absolute path
    expect(fullText).not.toContain("/home/");
    expect(fullText).not.toContain("C:\\Users");
  });

  it("selecting a node shows its dependencies and dependents in the details panel", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({ graph: sampleGraph() });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("src/a.ts");
    await user.click(screen.getByText("src/a.ts"));

    expect(await screen.findByText(/depends on \(1\)/i)).toBeInTheDocument();
    expect(await screen.findByText(/imported by \(0\)/i)).toBeInTheDocument();
  });

  it("selecting an edge shows every merged evidence record, not just a count", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({ graph: sampleGraph() });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText(/2 evidence/i);
    await user.click(screen.getByText(/2 evidence/i));

    expect(await screen.findByText("./b")).toBeInTheDocument();
    expect(screen.getByText("./b.ts")).toBeInTheDocument();
  });

  it("displays a cycle summary and detail when the graph contains a cycle", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({
      graph: sampleGraph({
        isAcyclic: false,
        topologicalOrder: null,
        cycles: [["src/a.ts", "src/b.ts", "src/a.ts"]],
      }),
    });
    renderTab();

    expect(await screen.findByText(/cycles \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText("src/a.ts → src/b.ts → src/a.ts")).toBeInTheDocument();
  });

  it("shows a validation-error warning rather than claiming the graph is fully accurate", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({
      graph: sampleGraph({
        validationErrors: [
          {
            type: "target_not_in_inventory",
            importerRelativePath: "src/a.ts",
            resolvedRelativePath: "src/ghost.ts",
          },
        ],
      }),
    });
    renderTab();
    expect(await screen.findByText(/structural issue/i)).toBeInTheDocument();
    expect(screen.getByText(/may be incomplete/i)).toBeInTheDocument();
  });

  it("shows unresolved/external/unsupported/parse-error diagnostics with counts and expandable detail", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({ graph: sampleGraph() });
    const user = userEvent.setup();
    renderTab();

    await screen.findByRole("heading", { name: "Diagnostics" });
    await user.click(screen.getByText("Unresolved"));
    expect(await screen.findByText("./missing")).toBeInTheDocument();

    await user.click(screen.getByText("External Package"));
    expect(await screen.findByText("react")).toBeInTheDocument();

    await user.click(screen.getByText("Unsupported"));
    expect(await screen.findByText("./styles.css")).toBeInTheDocument();

    await user.click(screen.getByText("Parse Error"));
    expect(await screen.findByText("Syntax errors detected")).toBeInTheDocument();
  });

  it("never represents an external or unresolved relationship as a confirmed edge", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({ graph: sampleGraph() });
    renderTab();

    await screen.findByText("Confirmed Dependencies (2)");
    // "react" (external) must not appear as one of the two confirmed edges.
    expect(screen.queryByRole("button", { name: /imports react/i })).not.toBeInTheDocument();
  });

  it("renders identically regardless of the order the backend returns nodes/edges in", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    const graph = sampleGraph();
    const reordered = sampleGraph({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() });

    vi.mocked(graphService.getGraph).mockResolvedValueOnce({ graph });
    const first = renderTab();
    await screen.findByText("src/a.ts");
    const firstNodeCount = screen.getAllByText(/^src\//).length;
    first.unmount();

    vi.mocked(graphService.getGraph).mockResolvedValueOnce({ graph: reordered });
    renderTab();
    await screen.findByText("src/a.ts");
    expect(screen.getAllByText(/^src\//).length).toBe(firstNodeCount);
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    expect(screen.getByText("src/c.ts")).toBeInTheDocument();
  });

  it("provides an accessible graph summary alternative to the visual canvas", async () => {
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: sampleScan() });
    vi.mocked(graphService.getGraph).mockResolvedValue({ graph: sampleGraph() });
    renderTab();

    const svg = await screen.findByRole("img", { name: /dependency graph visualization/i });
    expect(svg).toHaveAttribute("aria-label", expect.stringContaining("3 files"));
    expect(svg).toHaveAttribute("aria-label", expect.stringContaining("2 confirmed dependencies"));
  });
});
