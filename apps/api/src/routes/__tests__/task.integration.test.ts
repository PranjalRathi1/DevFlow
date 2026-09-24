import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { connectDB, disconnectDB } from "../../config/database.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";
import { Project } from "../../models/Project.js";
import { Requirement } from "../../models/Requirement.js";
import { Task } from "../../models/Task.js";
import { createTestProject, registerTestUser, type RegisteredTestUser } from "../../__tests__/testHelpers.js";

let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)("Tasks & subtasks (real MongoDB)", () => {
  const app = createApp();
  const createdEmails: string[] = [];
  let userA: RegisteredTestUser;
  let userB: RegisteredTestUser;
  let projectAId: string;
  let projectA2Id: string; // a second project owned by A, to test cross-project rejection
  let requirementAId: string;

  beforeAll(async () => {
    userA = await registerTestUser(app);
    userB = await registerTestUser(app);
    createdEmails.push(userA.email, userB.email);
    projectAId = await createTestProject(app, userA.cookie, { name: "Project A1" });
    projectA2Id = await createTestProject(app, userA.cookie, { name: "Project A2" });

    const reqRes = await request(app)
      .post(`/api/projects/${projectAId}/requirements`)
      .set("Cookie", userA.cookie)
      .send({ title: "Auth requirement" });
    requirementAId = reqRes.body.requirement._id;
  });

  afterAll(async () => {
    await Task.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await Requirement.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await Project.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await User.deleteMany({ email: { $in: createdEmails } });
    await disconnectDB();
  });

  it("rejects unauthenticated create/list", async () => {
    const create = await request(app).post(`/api/projects/${projectAId}/tasks`).send({ title: "x" });
    const list = await request(app).get(`/api/projects/${projectAId}/tasks`);
    expect(create.status).toBe(401);
    expect(list.status).toBe(401);
  });

  it("rejects creating a task under a project the caller doesn't own", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectAId}/tasks`)
      .set("Cookie", userB.cookie)
      .send({ title: "Hijack attempt" });
    expect(res.status).toBe(404);
  });

  let taskId: string;

  it("creates a task linked to a requirement in the same project", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectAId}/tasks`)
      .set("Cookie", userA.cookie)
      .send({ title: "Implement JWT middleware", requirementId: requirementAId, priority: "high" });
    expect(res.status).toBe(201);
    expect(res.body.task.requirement).toBe(requirementAId);
    expect(res.body.task.status).toBe("todo");
    taskId = res.body.task._id;
  });

  it("rejects a requirementId that belongs to a different project (cross-project reference)", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectA2Id}/tasks`)
      .set("Cookie", userA.cookie)
      .send({ title: "Cross-project attempt", requirementId: requirementAId });
    expect(res.status).toBe(400);
  });

  let subtaskId: string;

  it("creates a subtask with a valid parentTask in the same project", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectAId}/tasks`)
      .set("Cookie", userA.cookie)
      .send({ title: "Write middleware unit tests", parentTaskId: taskId });
    expect(res.status).toBe(201);
    expect(res.body.task.parentTask).toBe(taskId);
    subtaskId = res.body.task._id;
  });

  it("rejects a parentTaskId that belongs to a different project", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectA2Id}/tasks`)
      .set("Cookie", userA.cookie)
      .send({ title: "Cross-project subtask attempt", parentTaskId: taskId });
    expect(res.status).toBe(400);
  });

  it("rejects a task referencing itself as its own parent (on update)", async () => {
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set("Cookie", userA.cookie)
      .send({ parentTaskId: taskId });
    expect(res.status).toBe(400);
  });

  it("rejects an unowned requirementId/parentTaskId", async () => {
    const badRequirement = await request(app)
      .post(`/api/projects/${projectAId}/tasks`)
      .set("Cookie", userA.cookie)
      .send({ title: "x", requirementId: "000000000000000000000000" });
    const badParent = await request(app)
      .post(`/api/projects/${projectAId}/tasks`)
      .set("Cookie", userA.cookie)
      .send({ title: "x", parentTaskId: "000000000000000000000000" });
    expect(badRequirement.status).toBe(400);
    expect(badParent.status).toBe(400);
  });

  it("filters the project's tasks by parentTaskId=none (top-level only)", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectAId}/tasks?parentTaskId=none`)
      .set("Cookie", userA.cookie);
    expect(res.status).toBe(200);
    const ids: string[] = res.body.tasks.map((t: { _id: string }) => t._id);
    expect(ids).toContain(taskId);
    expect(ids).not.toContain(subtaskId);
  });

  it("filters the project's tasks by parentTaskId=<id> (that task's subtasks)", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectAId}/tasks?parentTaskId=${taskId}`)
      .set("Cookie", userA.cookie);
    expect(res.status).toBe(200);
    const ids: string[] = res.body.tasks.map((t: { _id: string }) => t._id);
    expect(ids).toEqual([subtaskId]);
  });

  it("filters by status and priority", async () => {
    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set("Cookie", userA.cookie)
      .send({ status: "in_progress" });

    const byStatus = await request(app)
      .get(`/api/projects/${projectAId}/tasks?status=in_progress`)
      .set("Cookie", userA.cookie);
    const byPriority = await request(app)
      .get(`/api/projects/${projectAId}/tasks?priority=high`)
      .set("Cookie", userA.cookie);

    expect(byStatus.body.tasks.some((t: { _id: string }) => t._id === taskId)).toBe(true);
    expect(byPriority.body.tasks.some((t: { _id: string }) => t._id === taskId)).toBe(true);
  });

  it("User B cannot read, update, or delete User A's task", async () => {
    const get = await request(app).get(`/api/tasks/${taskId}`).set("Cookie", userB.cookie);
    const patch = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set("Cookie", userB.cookie)
      .send({ status: "done" });
    const del = await request(app).delete(`/api/tasks/${taskId}`).set("Cookie", userB.cookie);

    expect(get.status).toBe(404);
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);

    const stillThere = await request(app).get(`/api/tasks/${taskId}`).set("Cookie", userA.cookie);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.task.status).toBe("in_progress");
  });

  it("rejects a malformed task id with 400 and a well-formed-but-missing id with 404", async () => {
    const malformed = await request(app).get("/api/tasks/not-an-id").set("Cookie", userA.cookie);
    const missing = await request(app).get("/api/tasks/000000000000000000000000").set("Cookie", userA.cookie);
    expect(malformed.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  it("deleting a parent task cascades to its subtasks", async () => {
    const del = await request(app).delete(`/api/tasks/${taskId}`).set("Cookie", userA.cookie);
    expect(del.status).toBe(204);

    const parentCheck = await request(app).get(`/api/tasks/${taskId}`).set("Cookie", userA.cookie);
    const subtaskCheck = await request(app).get(`/api/tasks/${subtaskId}`).set("Cookie", userA.cookie);
    expect(parentCheck.status).toBe(404);
    expect(subtaskCheck.status).toBe(404);
  });

  it("deleting a requirement clears the requirement reference on tasks that used it, without deleting them", async () => {
    const taskRes = await request(app)
      .post(`/api/projects/${projectAId}/tasks`)
      .set("Cookie", userA.cookie)
      .send({ title: "Linked to requirement", requirementId: requirementAId });
    const linkedTaskId = taskRes.body.task._id;

    const del = await request(app).delete(`/api/requirements/${requirementAId}`).set("Cookie", userA.cookie);
    expect(del.status).toBe(204);

    const check = await request(app).get(`/api/tasks/${linkedTaskId}`).set("Cookie", userA.cookie);
    expect(check.status).toBe(200);
    expect(check.body.task.requirement).toBeNull();
  });

  // Focused corrective pass: multi-hop parentTask cycle prevention. Uses its
  // own fresh tasks throughout rather than the shared `taskId`/`subtaskId`
  // above (which earlier tests in this file delete) — kept deterministic
  // and isolated per the corrective-pass instructions. Reuses userA/userB/
  // projectAId/projectA2Id from the outer beforeAll, which are never
  // mutated after setup.
  describe("parentTask cycle prevention", () => {
    async function createTask(
      cookie: string,
      projectId: string,
      title: string,
      parentTaskId?: string,
    ): Promise<{ status: number; id: string | undefined }> {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tasks`)
        .set("Cookie", cookie)
        .send(parentTaskId ? { title, parentTaskId } : { title });
      return { status: res.status, id: res.body.task?._id as string | undefined };
    }

    async function setParent(cookie: string, taskId: string, parentTaskId: string) {
      return request(app).patch(`/api/tasks/${taskId}`).set("Cookie", cookie).send({ parentTaskId });
    }

    it("allows a valid parent assignment", async () => {
      const root = await createTask(userA.cookie, projectAId, "Cycle: root A");
      const child = await createTask(userA.cookie, projectAId, "Cycle: child of A", root.id);
      expect(child.status).toBe(201);
    });

    it("rejects direct self-parenting on update", async () => {
      const task = await createTask(userA.cookie, projectAId, "Cycle: self-parent target");
      const res = await setParent(userA.cookie, task.id as string, task.id as string);
      expect(res.status).toBe(400);
    });

    it("rejects a two-task cycle (A -> B, then B set as A's parent)", async () => {
      const a = await createTask(userA.cookie, projectAId, "Cycle-2: A");
      const b = await createTask(userA.cookie, projectAId, "Cycle-2: B", a.id);

      const res = await setParent(userA.cookie, a.id as string, b.id as string);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/cycle/i);

      // Confirm A's parent is unchanged by the rejected attempt.
      const check = await request(app).get(`/api/tasks/${a.id}`).set("Cookie", userA.cookie);
      expect(check.body.task.parentTask).toBeNull();
    });

    it("rejects a three-task cycle (A <- B <- C, then C set as A's parent)", async () => {
      const a = await createTask(userA.cookie, projectAId, "Cycle-3: A");
      const b = await createTask(userA.cookie, projectAId, "Cycle-3: B", a.id);
      const c = await createTask(userA.cookie, projectAId, "Cycle-3: C", b.id);

      const res = await setParent(userA.cookie, a.id as string, c.id as string);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/cycle/i);
    });

    it("rejects a longer multi-hop cycle (A <- B <- C <- D, then D set as A's parent)", async () => {
      const a = await createTask(userA.cookie, projectAId, "Cycle-4: A");
      const b = await createTask(userA.cookie, projectAId, "Cycle-4: B", a.id);
      const c = await createTask(userA.cookie, projectAId, "Cycle-4: C", b.id);
      const d = await createTask(userA.cookie, projectAId, "Cycle-4: D", c.id);

      const res = await setParent(userA.cookie, a.id as string, d.id as string);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/cycle/i);

      // The chain is untouched by the rejected update.
      const checkA = await request(app).get(`/api/tasks/${a.id}`).set("Cookie", userA.cookie);
      const checkD = await request(app).get(`/api/tasks/${d.id}`).set("Cookie", userA.cookie);
      expect(checkA.body.task.parentTask).toBeNull();
      expect(checkD.body.task.parentTask).toBe(c.id);
    });

    it("allows valid re-parenting to a different branch of the same tree", async () => {
      const root = await createTask(userA.cookie, projectAId, "Cycle-branch: root");
      const branch1 = await createTask(userA.cookie, projectAId, "Cycle-branch: branch1", root.id);
      const branch2 = await createTask(userA.cookie, projectAId, "Cycle-branch: branch2", root.id);
      const leaf = await createTask(userA.cookie, projectAId, "Cycle-branch: leaf", branch1.id);

      const res = await setParent(userA.cookie, leaf.id as string, branch2.id as string);
      expect(res.status).toBe(200);
      expect(res.body.task.parentTask).toBe(branch2.id);
    });

    it("still rejects a parent from a different project (unaffected by the cycle check)", async () => {
      const inOtherProject = await createTask(userA.cookie, projectA2Id, "Cycle: lives in project A2");
      const task = await createTask(userA.cookie, projectAId, "Cycle: lives in project A1");

      const res = await setParent(userA.cookie, task.id as string, inOtherProject.id as string);
      expect(res.status).toBe(400);
    });

    it("still rejects a parent owned by a different user (unaffected by the cycle check)", async () => {
      const projectBId = await createTestProject(app, userB.cookie, { name: "Cycle: User B project" });
      const usersTask = await createTask(userB.cookie, projectBId, "Cycle: User B's task");
      const attackersTask = await createTask(userA.cookie, projectAId, "Cycle: User A's task");

      const res = await setParent(userA.cookie, attackersTask.id as string, usersTask.id as string);
      expect(res.status).toBe(400);

      await Task.deleteOne({ _id: usersTask.id });
      await Project.deleteOne({ _id: projectBId });
    });

    it("does not falsely reject a valid, acyclic chain re-parented within itself", async () => {
      const a = await createTask(userA.cookie, projectAId, "Cycle-valid: A");
      const b = await createTask(userA.cookie, projectAId, "Cycle-valid: B", a.id);
      const c = await createTask(userA.cookie, projectAId, "Cycle-valid: C", b.id);
      const d = await createTask(userA.cookie, projectAId, "Cycle-valid: D", c.id);
      const e = await createTask(userA.cookie, projectAId, "Cycle-valid: E", d.id);

      // Re-parent E directly onto A (still acyclic — A has no ancestors).
      const res = await setParent(userA.cookie, e.id as string, a.id as string);
      expect(res.status).toBe(200);
      expect(res.body.task.parentTask).toBe(a.id);
    });
  });
});

describe.skipIf(dbAvailable)("Task integration (skipped)", () => {
  it("no database reachable at MONGODB_URI — run `npm run db:up` to enable this suite", () => {
    expect(dbAvailable).toBe(false);
  });
});
