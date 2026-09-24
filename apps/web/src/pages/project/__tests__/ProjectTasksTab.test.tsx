import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderProjectTab } from "../../../test/renderWithProviders";
import ProjectTasksTab from "../ProjectTasksTab";
import { projectService } from "../../../services/projectService";
import { requirementService } from "../../../services/requirementService";
import { taskService } from "../../../services/taskService";
import type { Project } from "../../../types/project";
import type { Task } from "../../../types/task";

vi.mock("../../../services/projectService");
vi.mock("../../../services/requirementService");
vi.mock("../../../services/taskService");

const project: Project = {
  _id: "proj-1",
  name: "Test Project",
  description: "",
  owner: "u1",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const parentTask: Task = {
  _id: "task-1",
  project: "proj-1",
  owner: "u1",
  requirement: null,
  parentTask: null,
  title: "Implement login",
  description: "",
  status: "todo",
  priority: "medium",
  acceptanceCriteria: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const subtask: Task = {
  ...parentTask,
  _id: "task-2",
  parentTask: "task-1",
  title: "Write login unit tests",
};

function renderTab() {
  vi.mocked(projectService.get).mockResolvedValue({ project });
  vi.mocked(requirementService.list).mockResolvedValue({ requirements: [] });
  return renderProjectTab(<ProjectTasksTab />, project._id);
}

describe("ProjectTasksTab", () => {
  it("shows an empty state with no tasks", async () => {
    vi.mocked(taskService.list).mockResolvedValue({ tasks: [] });
    renderTab();

    expect(await screen.findByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it("renders a top-level task with its subtask nested under it", async () => {
    vi.mocked(taskService.list).mockResolvedValue({ tasks: [parentTask, subtask] });
    renderTab();

    expect(await screen.findByText("Implement login")).toBeInTheDocument();
    expect(screen.getByText("Write login unit tests")).toBeInTheDocument();
  });

  it("changes a task's status via the inline control", async () => {
    vi.mocked(taskService.list).mockResolvedValue({ tasks: [parentTask] });
    vi.mocked(taskService.update).mockResolvedValue({ task: { ...parentTask, status: "in_progress" } });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Implement login");
    await user.selectOptions(screen.getByLabelText(/status for implement login/i), "in_progress");

    await waitFor(() => expect(taskService.update).toHaveBeenCalledWith("task-1", { status: "in_progress" }));
  });

  it("validates and creates a new top-level task", async () => {
    vi.mocked(taskService.list).mockResolvedValue({ tasks: [] });
    vi.mocked(taskService.create).mockResolvedValue({ task: parentTask });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText(/no tasks yet/i);
    // Two "New Task" buttons are on screen at once here (the persistent
    // header action + the empty state's own CTA) — legitimate UI, not a
    // bug; either opens the same dialog.
    await user.click(screen.getAllByRole("button", { name: /new task/i })[0] as HTMLElement);

    await user.click(screen.getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
    expect(taskService.create).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/title/i), "Implement login");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(taskService.create).toHaveBeenCalledTimes(1));
  });
});
