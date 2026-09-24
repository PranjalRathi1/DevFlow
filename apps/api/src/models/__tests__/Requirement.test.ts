import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Requirement } from "../Requirement.js";

describe("Requirement schema", () => {
  const project = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();

  it("passes validation with valid fields", () => {
    const requirement = new Requirement({ title: "Add auth", project, owner });
    expect(requirement.validateSync()).toBeUndefined();
  });

  it("requires title, project, and owner", () => {
    const requirement = new Requirement({});
    const error = requirement.validateSync();
    expect(error?.errors.title).toBeDefined();
    expect(error?.errors.project).toBeDefined();
    expect(error?.errors.owner).toBeDefined();
  });

  it("defaults status to draft, priority to medium, and acceptanceCriteria to []", () => {
    const requirement = new Requirement({ title: "Add auth", project, owner });
    expect(requirement.status).toBe("draft");
    expect(requirement.priority).toBe("medium");
    expect(requirement.acceptanceCriteria).toEqual([]);
  });

  it("rejects an unrecognized status", () => {
    const requirement = new Requirement({ title: "x", project, owner, status: "shipped" });
    expect(requirement.validateSync()?.errors.status).toBeDefined();
  });
});
