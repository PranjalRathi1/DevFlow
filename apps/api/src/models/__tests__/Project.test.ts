import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Project } from "../Project.js";

describe("Project schema", () => {
  const validOwner = new mongoose.Types.ObjectId();

  it("passes validation with valid fields", () => {
    const project = new Project({ name: "DevFlow AI", owner: validOwner });

    expect(project.validateSync()).toBeUndefined();
  });

  it("requires name and owner", () => {
    const project = new Project({});
    const error = project.validateSync();

    expect(error?.errors.name).toBeDefined();
    expect(error?.errors.owner).toBeDefined();
  });

  it("defaults status to planning and description to an empty string", () => {
    const project = new Project({ name: "DevFlow AI", owner: validOwner });

    expect(project.status).toBe("planning");
    expect(project.description).toBe("");
  });

  it("rejects an unrecognized status", () => {
    const project = new Project({ name: "DevFlow AI", owner: validOwner, status: "cancelled" });

    expect(project.validateSync()?.errors.status).toBeDefined();
  });

  it("rejects a name over 200 characters", () => {
    const project = new Project({ name: "x".repeat(201), owner: validOwner });

    expect(project.validateSync()?.errors.name).toBeDefined();
  });
});
