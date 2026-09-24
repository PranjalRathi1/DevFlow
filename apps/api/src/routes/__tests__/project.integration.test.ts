import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { connectDB, disconnectDB } from "../../config/database.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";
import { Project } from "../../models/Project.js";
import { registerTestUser, type RegisteredTestUser } from "../../__tests__/testHelpers.js";

let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)("Project ownership authorization (real MongoDB)", () => {
  const app = createApp();
  const createdEmails: string[] = [];
  let userA: RegisteredTestUser;
  let userB: RegisteredTestUser;
  let projectId: string;

  beforeAll(async () => {
    userA = await registerTestUser(app);
    userB = await registerTestUser(app);
    createdEmails.push(userA.email, userB.email);

    const createRes = await request(app)
      .post("/api/projects")
      .set("Cookie", userA.cookie)
      .send({ name: "User A's Project", description: "Owned by A" });
    projectId = createRes.body.project._id as string;
  });

  afterAll(async () => {
    await Project.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await User.deleteMany({ email: { $in: createdEmails } });
    await disconnectDB();
  });

  it("owner (User A) can create a project", () => {
    expect(projectId).toBeDefined();
  });

  it("owner (User A) can read their own project", async () => {
    const res = await request(app).get(`/api/projects/${projectId}`).set("Cookie", userA.cookie);
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe("User A's Project");
  });

  it("owner (User A) can list their own projects and sees it", async () => {
    const res = await request(app).get("/api/projects").set("Cookie", userA.cookie);
    expect(res.status).toBe(200);
    expect(res.body.projects.some((p: { _id: string }) => p._id === projectId)).toBe(true);
  });

  it("User B cannot read User A's project (404, not 403 — indistinguishable from nonexistent)", async () => {
    const res = await request(app).get(`/api/projects/${projectId}`).set("Cookie", userB.cookie);
    expect(res.status).toBe(404);
  });

  it("User B does not see User A's project in their own list", async () => {
    const res = await request(app).get("/api/projects").set("Cookie", userB.cookie);
    expect(res.status).toBe(200);
    expect(res.body.projects.some((p: { _id: string }) => p._id === projectId)).toBe(false);
  });

  it("User B cannot update User A's project", async () => {
    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Cookie", userB.cookie)
      .send({ name: "Hijacked" });
    expect(res.status).toBe(404);

    // Confirm the project was NOT actually modified.
    const check = await request(app).get(`/api/projects/${projectId}`).set("Cookie", userA.cookie);
    expect(check.body.project.name).toBe("User A's Project");
  });

  it("User B cannot delete User A's project", async () => {
    const res = await request(app).delete(`/api/projects/${projectId}`).set("Cookie", userB.cookie);
    expect(res.status).toBe(404);

    // Confirm the project still exists for the real owner.
    const check = await request(app).get(`/api/projects/${projectId}`).set("Cookie", userA.cookie);
    expect(check.status).toBe(200);
  });

  it("rejects a fabricated but well-formed ObjectId with 404", async () => {
    const res = await request(app).get("/api/projects/000000000000000000000000").set("Cookie", userA.cookie);
    expect(res.status).toBe(404);
  });

  it("rejects a malformed project id with 400", async () => {
    const res = await request(app).get("/api/projects/not-a-valid-id").set("Cookie", userA.cookie);
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests to every project operation", async () => {
    const list = await request(app).get("/api/projects");
    const getOne = await request(app).get(`/api/projects/${projectId}`);
    const create = await request(app).post("/api/projects").send({ name: "x" });
    const update = await request(app).patch(`/api/projects/${projectId}`).send({ name: "x" });
    const remove = await request(app).delete(`/api/projects/${projectId}`);

    for (const res of [list, getOne, create, update, remove]) {
      expect(res.status).toBe(401);
    }
  });

  it("owner (User A) can update and then delete their own project", async () => {
    const update = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Cookie", userA.cookie)
      .send({ status: "active" });
    expect(update.status).toBe(200);
    expect(update.body.project.status).toBe("active");

    const remove = await request(app).delete(`/api/projects/${projectId}`).set("Cookie", userA.cookie);
    expect(remove.status).toBe(204);

    const getAfterDelete = await request(app).get(`/api/projects/${projectId}`).set("Cookie", userA.cookie);
    expect(getAfterDelete.status).toBe(404);
  });
});

describe.skipIf(dbAvailable)("Project ownership integration (skipped)", () => {
  it("no database reachable at MONGODB_URI — run `npm run db:up` to enable this suite", () => {
    expect(dbAvailable).toBe(false);
  });
});
