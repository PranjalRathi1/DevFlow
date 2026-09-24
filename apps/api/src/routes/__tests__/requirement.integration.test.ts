import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { connectDB, disconnectDB } from "../../config/database.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";
import { Project } from "../../models/Project.js";
import { Requirement } from "../../models/Requirement.js";
import { createTestProject, registerTestUser, type RegisteredTestUser } from "../../__tests__/testHelpers.js";

let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)("Requirements (real MongoDB)", () => {
  const app = createApp();
  const createdEmails: string[] = [];
  let userA: RegisteredTestUser;
  let userB: RegisteredTestUser;
  let projectAId: string;

  beforeAll(async () => {
    userA = await registerTestUser(app);
    userB = await registerTestUser(app);
    createdEmails.push(userA.email, userB.email);
    projectAId = await createTestProject(app, userA.cookie);
  });

  afterAll(async () => {
    await Requirement.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await Project.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await User.deleteMany({ email: { $in: createdEmails } });
    await disconnectDB();
  });

  it("rejects unauthenticated create/list", async () => {
    const create = await request(app).post(`/api/projects/${projectAId}/requirements`).send({ title: "x" });
    const list = await request(app).get(`/api/projects/${projectAId}/requirements`);
    expect(create.status).toBe(401);
    expect(list.status).toBe(401);
  });

  it("rejects creating a requirement under a project the caller doesn't own", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectAId}/requirements`)
      .set("Cookie", userB.cookie)
      .send({ title: "Hijack attempt" });
    expect(res.status).toBe(404);
  });

  it("rejects validation errors (missing title)", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectAId}/requirements`)
      .set("Cookie", userA.cookie)
      .send({ description: "no title" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  let requirementId: string;

  it("creates a requirement for the owner", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectAId}/requirements`)
      .set("Cookie", userA.cookie)
      .send({
        title: "Implement RBAC",
        description: "Role-based access control",
        priority: "high",
        acceptanceCriteria: ["Admins can assign roles"],
      });
    expect(res.status).toBe(201);
    expect(res.body.requirement.title).toBe("Implement RBAC");
    expect(res.body.requirement.status).toBe("draft");
    requirementId = res.body.requirement._id;
  });

  it("lists requirements scoped to the project", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectAId}/requirements`)
      .set("Cookie", userA.cookie);
    expect(res.status).toBe(200);
    expect(res.body.requirements.some((r: { _id: string }) => r._id === requirementId)).toBe(true);
  });

  it("gets a single requirement by id", async () => {
    const res = await request(app).get(`/api/requirements/${requirementId}`).set("Cookie", userA.cookie);
    expect(res.status).toBe(200);
    expect(res.body.requirement._id).toBe(requirementId);
  });

  it("updates a requirement", async () => {
    const res = await request(app)
      .patch(`/api/requirements/${requirementId}`)
      .set("Cookie", userA.cookie)
      .send({ status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.requirement.status).toBe("approved");
  });

  it("User B cannot read, update, or delete User A's requirement", async () => {
    const get = await request(app).get(`/api/requirements/${requirementId}`).set("Cookie", userB.cookie);
    const patch = await request(app)
      .patch(`/api/requirements/${requirementId}`)
      .set("Cookie", userB.cookie)
      .send({ title: "Hijacked" });
    const del = await request(app).delete(`/api/requirements/${requirementId}`).set("Cookie", userB.cookie);

    expect(get.status).toBe(404);
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);

    const stillThere = await request(app)
      .get(`/api/requirements/${requirementId}`)
      .set("Cookie", userA.cookie);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.requirement.title).toBe("Implement RBAC");
  });

  it("rejects a malformed requirement id with 400 and a well-formed-but-missing id with 404", async () => {
    const malformed = await request(app).get("/api/requirements/not-an-id").set("Cookie", userA.cookie);
    const missing = await request(app)
      .get("/api/requirements/000000000000000000000000")
      .set("Cookie", userA.cookie);
    expect(malformed.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  it("deletes a requirement (owner)", async () => {
    const res = await request(app).delete(`/api/requirements/${requirementId}`).set("Cookie", userA.cookie);
    expect(res.status).toBe(204);

    const check = await request(app).get(`/api/requirements/${requirementId}`).set("Cookie", userA.cookie);
    expect(check.status).toBe(404);
  });
});

describe.skipIf(dbAvailable)("Requirements integration (skipped)", () => {
  it("no database reachable at MONGODB_URI — run `npm run db:up` to enable this suite", () => {
    expect(dbAvailable).toBe(false);
  });
});
