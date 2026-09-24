import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Task } from "../Task.js";

describe("Task schema", () => {
  const project = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();

  it("passes validation with valid fields", () => {
    const task = new Task({ title: "Implement login", project, owner });
    expect(task.validateSync()).toBeUndefined();
  });

  it("requires title, project, and owner", () => {
    const task = new Task({});
    const error = task.validateSync();
    expect(error?.errors.title).toBeDefined();
    expect(error?.errors.project).toBeDefined();
    expect(error?.errors.owner).toBeDefined();
  });

  it("defaults status to todo, priority to medium, requirement/parentTask to null", () => {
    const task = new Task({ title: "Implement login", project, owner });
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("medium");
    expect(task.requirement).toBeNull();
    expect(task.parentTask).toBeNull();
  });

  it("rejects an unrecognized status or priority", () => {
    const badStatus = new Task({ title: "x", project, owner, status: "cancelled" });
    expect(badStatus.validateSync()?.errors.status).toBeDefined();

    const badPriority = new Task({ title: "x", project, owner, priority: "urgent" });
    expect(badPriority.validateSync()?.errors.priority).toBeDefined();
  });

  it("accepts a parentTask reference (subtask shape)", () => {
    const parentTask = new mongoose.Types.ObjectId();
    const subtask = new Task({ title: "Subtask", project, owner, parentTask });
    expect(subtask.validateSync()).toBeUndefined();
    expect(subtask.parentTask?.toString()).toBe(parentTask.toString());
  });
});
