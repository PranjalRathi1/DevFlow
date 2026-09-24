import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { connectDB, disconnectDB } from "../../config/database.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";
import { Project } from "../../models/Project.js";
import { Requirement } from "../../models/Requirement.js";
import { Task } from "../../models/Task.js";
import { Plan } from "../../models/Plan.js";
import { createTestProject, registerTestUser, type RegisteredTestUser } from "../../__tests__/testHelpers.js";
import { getAIProvider } from "../../services/ai/index.js";

// Mocked per the phase instructions — "Do not require a running Ollama
// instance for normal automated tests." Only getAIProvider is replaced;
// AIProviderError is re-exported from the real module so
// `instanceof AIProviderError` checks in plan.service.ts still work
// against errors constructed in these tests.
vi.mock("../../services/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/ai/index.js")>();
  return { ...actual, getAIProvider: vi.fn() };
});

function mockProvider(overrides: {
  complete?: () => Promise<string>;
  checkAvailability?: () => Promise<boolean>;
}) {
  vi.mocked(getAIProvider).mockReturnValue({
    complete: vi.fn(overrides.complete ?? (() => Promise.resolve(VALID_PLAN_JSON))),
    checkAvailability: vi.fn(overrides.checkAvailability ?? (() => Promise.resolve(true))),
  });
}

const VALID_PLAN_JSON = JSON.stringify({
  title: "Add authentication",
  summary: "Implement JWT login and registration.",
  assumptions: ["Users have email addresses"],
  risks: ["No password reset flow"],
  suggestedTasks: [
    { tempId: "t1", title: "Design user schema", dependsOn: [] },
    { tempId: "t2", title: "Implement login endpoint", dependsOn: ["t1"] },
  ],
});

let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)("AI plan generation & review (real MongoDB, mocked AI provider)", () => {
  const app = createApp();
  const createdEmails: string[] = [];
  let userA: RegisteredTestUser;
  let userB: RegisteredTestUser;
  let projectId: string;
  let requirementId: string;

  beforeAll(async () => {
    userA = await registerTestUser(app);
    userB = await registerTestUser(app);
    createdEmails.push(userA.email, userB.email);
    projectId = await createTestProject(app, userA.cookie, { name: "AI Plan Project" });

    const reqRes = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .set("Cookie", userA.cookie)
      .send({ title: "Add authentication" });
    requirementId = reqRes.body.requirement._id;
  });

  afterAll(async () => {
    await Plan.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await Task.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await Requirement.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await Project.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await User.deleteMany({ email: { $in: createdEmails } });
    await disconnectDB();
  });

  beforeEach(() => {
    vi.mocked(getAIProvider).mockReset();
  });

  describe("GET /api/ai/status", () => {
    it("reports availability from the provider (mocked true/false)", async () => {
      mockProvider({ checkAvailability: () => Promise.resolve(true) });
      const up = await request(app).get("/api/ai/status").set("Cookie", userA.cookie);
      expect(up.status).toBe(200);
      expect(up.body.available).toBe(true);

      mockProvider({ checkAvailability: () => Promise.resolve(false) });
      const down = await request(app).get("/api/ai/status").set("Cookie", userA.cookie);
      expect(down.body.available).toBe(false);
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/api/ai/status");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/projects/:projectId/plans/generate", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .send({ requirementId });
      expect(res.status).toBe(401);
    });

    it("rejects generation under a project the caller doesn't own", async () => {
      mockProvider({});
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userB.cookie)
        .send({ requirementId });
      expect(res.status).toBe(404);
    });

    it("rejects a missing/malformed requirementId", async () => {
      mockProvider({});
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId: "not-an-id" });
      expect(res.status).toBe(400);
    });

    it("rejects a requirementId that doesn't belong to this project", async () => {
      mockProvider({});
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId: "000000000000000000000000" });
      expect(res.status).toBe(404);
    });

    it("returns 503 when the AI provider is unavailable, and persists nothing", async () => {
      const { AIProviderError } = await vi.importActual<typeof import("../../services/ai/index.js")>(
        "../../services/ai/index.js",
      );
      mockProvider({ complete: () => Promise.reject(new AIProviderError("down", "unavailable")) });

      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId });
      expect(res.status).toBe(503);

      const count = await Plan.countDocuments({ project: projectId });
      expect(count).toBe(0);
    });

    it("returns 503 on a provider timeout", async () => {
      const { AIProviderError } = await vi.importActual<typeof import("../../services/ai/index.js")>(
        "../../services/ai/index.js",
      );
      mockProvider({ complete: () => Promise.reject(new AIProviderError("timed out", "timeout")) });

      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId });
      expect(res.status).toBe(503);
    });

    it("returns 502 for a response that isn't valid JSON, and persists nothing", async () => {
      mockProvider({ complete: () => Promise.resolve("not json at all") });
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId });
      expect(res.status).toBe(502);

      const count = await Plan.countDocuments({ project: projectId });
      expect(count).toBe(0);
    });

    it("returns 422 for structurally invalid output (missing required field), and persists nothing", async () => {
      mockProvider({ complete: () => Promise.resolve(JSON.stringify({ summary: "no title or tasks" })) });
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId });
      expect(res.status).toBe(422);

      const count = await Plan.countDocuments({ project: projectId });
      expect(count).toBe(0);
    });

    it("returns 422 for a cyclic suggested dependency graph, and persists nothing", async () => {
      mockProvider({
        complete: () =>
          Promise.resolve(
            JSON.stringify({
              title: "Bad plan",
              summary: "Has a cycle",
              suggestedTasks: [
                { tempId: "a", title: "A", dependsOn: ["b"] },
                { tempId: "b", title: "B", dependsOn: ["a"] },
              ],
            }),
          ),
      });
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId });
      expect(res.status).toBe(422);

      const count = await Plan.countDocuments({ project: projectId });
      expect(count).toBe(0);
    });

    it("generates and persists a valid plan as needs_review, with a computed topological order", async () => {
      mockProvider({});
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId });

      expect(res.status).toBe(201);
      expect(res.body.plan.status).toBe("needs_review");
      expect(res.body.plan.suggestedTasks).toHaveLength(2);
      expect(res.body.plan.suggestedOrder).toEqual(["t1", "t2"]);
      expect(res.body.plan.aiMeta.provider).toBe("ollama");
    });
  });

  describe("Plan review lifecycle", () => {
    let planId: string;

    beforeAll(async () => {
      mockProvider({});
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId });
      planId = res.body.plan._id;
    });

    it("lists plans scoped to the project", async () => {
      const res = await request(app).get(`/api/projects/${projectId}/plans`).set("Cookie", userA.cookie);
      expect(res.status).toBe(200);
      expect(res.body.plans.some((p: { _id: string }) => p._id === planId)).toBe(true);
    });

    it("User B cannot read, edit, approve, or reject User A's plan", async () => {
      const get = await request(app).get(`/api/plans/${planId}`).set("Cookie", userB.cookie);
      const patch = await request(app)
        .patch(`/api/plans/${planId}`)
        .set("Cookie", userB.cookie)
        .send({ title: "Hijacked" });
      const approve = await request(app).post(`/api/plans/${planId}/approve`).set("Cookie", userB.cookie);
      const reject = await request(app).post(`/api/plans/${planId}/reject`).set("Cookie", userB.cookie);

      expect(get.status).toBe(404);
      expect(patch.status).toBe(404);
      expect(approve.status).toBe(404);
      expect(reject.status).toBe(404);
    });

    it("allows editing suggestedTasks while needs_review, re-validating the graph", async () => {
      const badEdit = await request(app)
        .patch(`/api/plans/${planId}`)
        .set("Cookie", userA.cookie)
        .send({ suggestedTasks: [{ tempId: "x", title: "Self-cycle", dependsOn: ["x"] }] });
      expect(badEdit.status).toBe(422);

      const goodEdit = await request(app)
        .patch(`/api/plans/${planId}`)
        .set("Cookie", userA.cookie)
        .send({ title: "Add authentication (revised)" });
      expect(goodEdit.status).toBe(200);
      expect(goodEdit.body.plan.title).toBe("Add authentication (revised)");
    });

    it("approving materializes real tasks with resolved dependencies, and flips status", async () => {
      const res = await request(app).post(`/api/plans/${planId}/approve`).set("Cookie", userA.cookie);
      expect(res.status).toBe(200);
      expect(res.body.plan.status).toBe("approved");
      expect(res.body.createdTasks).toHaveLength(2);

      const t1 = res.body.createdTasks.find((t: { title: string }) => t.title === "Design user schema");
      const t2 = res.body.createdTasks.find((t: { title: string }) => t.title === "Implement login endpoint");
      expect(t2.dependencies).toEqual([t1._id]);
      expect(t2.requirement).toBe(requirementId);
    });

    it("cannot approve or reject an already-reviewed plan", async () => {
      const approveAgain = await request(app)
        .post(`/api/plans/${planId}/approve`)
        .set("Cookie", userA.cookie);
      const rejectAfter = await request(app).post(`/api/plans/${planId}/reject`).set("Cookie", userA.cookie);
      expect(approveAgain.status).toBe(409);
      expect(rejectAfter.status).toBe(409);
    });

    it("cannot edit an already-reviewed plan", async () => {
      const res = await request(app)
        .patch(`/api/plans/${planId}`)
        .set("Cookie", userA.cookie)
        .send({ title: "Too late" });
      expect(res.status).toBe(409);
    });
  });

  describe("Rejecting a plan", () => {
    it("marks the plan rejected and creates no tasks", async () => {
      mockProvider({});
      const genRes = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId });
      const planId = genRes.body.plan._id;

      const res = await request(app).post(`/api/plans/${planId}/reject`).set("Cookie", userA.cookie);
      expect(res.status).toBe(200);
      expect(res.body.plan.status).toBe("rejected");

      const taskCount = await Task.countDocuments({ project: projectId, title: "Design user schema" });
      // Only the tasks from the earlier *approved* plan in this file should exist — none from this rejected one.
      expect(taskCount).toBe(1);
    });
  });

  // Found during this batch's own consolidated review: deleteProjectForOwner
  // originally cascaded to Requirement/Task but not Plan, which would have
  // left orphaned Plan rows referencing a deleted project. Fixed in
  // project.service.ts; this test guards the fix. Uses its own fresh
  // project (not the shared `projectId` other tests in this file depend on).
  describe("Project deletion cascades to plans", () => {
    it("deletes a project's plans along with its requirements and tasks", async () => {
      const cascadeProjectId = await createTestProject(app, userA.cookie, { name: "Cascade Test Project" });
      const reqRes = await request(app)
        .post(`/api/projects/${cascadeProjectId}/requirements`)
        .set("Cookie", userA.cookie)
        .send({ title: "Cascade requirement" });
      const cascadeRequirementId = reqRes.body.requirement._id;

      mockProvider({});
      const planRes = await request(app)
        .post(`/api/projects/${cascadeProjectId}/plans/generate`)
        .set("Cookie", userA.cookie)
        .send({ requirementId: cascadeRequirementId });
      const cascadePlanId = planRes.body.plan._id;

      const del = await request(app).delete(`/api/projects/${cascadeProjectId}`).set("Cookie", userA.cookie);
      expect(del.status).toBe(204);

      const planCheck = await request(app).get(`/api/plans/${cascadePlanId}`).set("Cookie", userA.cookie);
      expect(planCheck.status).toBe(404);
      expect(await Plan.countDocuments({ project: cascadeProjectId })).toBe(0);
    });
  });
});

describe.skipIf(dbAvailable)("AI plan integration (skipped)", () => {
  it("no database reachable at MONGODB_URI — run `npm run db:up` to enable this suite", () => {
    expect(dbAvailable).toBe(false);
  });
});
