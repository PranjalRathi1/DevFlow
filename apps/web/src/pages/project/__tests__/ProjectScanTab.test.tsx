import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderProjectTab } from "../../../test/renderWithProviders";
import ProjectScanTab from "../ProjectScanTab";
import { projectService } from "../../../services/projectService";
import { scanService } from "../../../services/scanService";
import type { Project } from "../../../types/project";
import type { Scan, SourceConfig } from "../../../types/scan";

vi.mock("../../../services/projectService");
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

const notConfigured: SourceConfig = { label: null, configuredAt: null, hasPath: false };
const configured: SourceConfig = { label: "my-app", configuredAt: new Date().toISOString(), hasPath: true };

function sampleScan(overrides: Partial<Scan> = {}): Scan {
  return {
    _id: "scan-1",
    project: "proj-1",
    outcome: "completed",
    summary: {
      totalScanned: 3,
      totalSkipped: 0,
      totalErrors: 0,
      filesByCategory: { source: 2, documentation: 1 },
      filesByLanguage: { typescript: 2 },
      limitsReached: [],
      durationMs: 12,
    },
    items: [
      { relativePath: "README.md", type: "file", category: "documentation", status: "scanned" },
      { relativePath: "src/index.ts", type: "file", category: "source", status: "scanned" },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderTab() {
  vi.mocked(projectService.get).mockResolvedValue({ project });
  return renderProjectTab(<ProjectScanTab />, project._id);
}

describe("ProjectScanTab", () => {
  it("shows 'Not configured' and no raw path when no source directory is set", async () => {
    vi.mocked(scanService.getSource).mockResolvedValue({ sourceConfig: notConfigured });
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: null });
    renderTab();

    expect(await screen.findByText(/not configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run scan/i })).toBeDisabled();
  });

  it("displays only the safe label for a configured source, never a raw path", async () => {
    vi.mocked(scanService.getSource).mockResolvedValue({ sourceConfig: configured });
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: null });
    renderTab();

    expect(await screen.findByText("my-app")).toBeInTheDocument();
    expect(screen.getByText(/no scan has been run yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run scan/i })).toBeEnabled();
  });

  it("saves a new source directory", async () => {
    vi.mocked(scanService.getSource).mockResolvedValue({ sourceConfig: notConfigured });
    vi.mocked(scanService.getLatestScan).mockResolvedValue({ scan: null });
    vi.mocked(scanService.setSource).mockResolvedValue({ sourceConfig: configured });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText(/not configured/i);
    await user.type(screen.getByLabelText(/local directory path/i), "C:\\Users\\me\\my-app");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(scanService.setSource).toHaveBeenCalledWith("proj-1", "C:\\Users\\me\\my-app"),
    );
  });

  it("runs a scan and shows the completed outcome with summary counts", async () => {
    vi.mocked(scanService.getSource).mockResolvedValue({ sourceConfig: configured });
    vi.mocked(scanService.getLatestScan).mockResolvedValueOnce({ scan: null }).mockResolvedValue({
      scan: sampleScan(),
    });
    vi.mocked(scanService.startScan).mockResolvedValue({ scan: sampleScan() });
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: /run scan/i }));

    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
  });

  it("shows a warning outcome and the limits that were reached", async () => {
    vi.mocked(scanService.getSource).mockResolvedValue({ sourceConfig: configured });
    vi.mocked(scanService.getLatestScan).mockResolvedValue({
      scan: sampleScan({
        outcome: "completed_with_warnings",
        summary: {
          totalScanned: 2,
          totalSkipped: 1,
          totalErrors: 0,
          filesByCategory: {},
          filesByLanguage: {},
          limitsReached: ["maxFiles"],
          durationMs: 5,
        },
      }),
    });
    renderTab();

    expect(await screen.findByText(/completed with warnings/i)).toBeInTheDocument();
    expect(screen.getByText(/maxFiles/)).toBeInTheDocument();
  });

  it("shows a failed outcome with its safe error message", async () => {
    vi.mocked(scanService.getSource).mockResolvedValue({ sourceConfig: configured });
    vi.mocked(scanService.getLatestScan).mockResolvedValue({
      scan: sampleScan({
        outcome: "failed",
        items: [],
        errorMessage: "Could not read the configured source directory",
        summary: {
          totalScanned: 0,
          totalSkipped: 0,
          totalErrors: 0,
          filesByCategory: {},
          filesByLanguage: {},
          limitsReached: [],
          durationMs: 1,
        },
      }),
    });
    renderTab();

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/could not read the configured source directory/i)).toBeInTheDocument();
  });

  it("shows an empty-inventory message when a scan recorded no items", async () => {
    vi.mocked(scanService.getSource).mockResolvedValue({ sourceConfig: configured });
    vi.mocked(scanService.getLatestScan).mockResolvedValue({
      scan: sampleScan({
        items: [],
        summary: {
          totalScanned: 0,
          totalSkipped: 0,
          totalErrors: 0,
          filesByCategory: {},
          filesByLanguage: {},
          limitsReached: [],
          durationMs: 1,
        },
      }),
    });
    renderTab();

    expect(await screen.findByText(/no items were recorded/i)).toBeInTheDocument();
  });
});
