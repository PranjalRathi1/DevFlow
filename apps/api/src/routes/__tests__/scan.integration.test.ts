import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { connectDB, disconnectDB } from "../../config/database.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";
import { Project } from "../../models/Project.js";
import { Scan } from "../../models/Scan.js";
import { createTestProject, registerTestUser, type RegisteredTestUser } from "../../__tests__/testHelpers.js";

let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const scratchBase = path.join(os.tmpdir(), `devflow-scan-api-${randomUUID()}`);

describe.skipIf(!dbAvailable)("Source configuration & scanning API (real MongoDB, real filesystem)", () => {
  const app = createApp();
  const createdEmails: string[] = [];
  let userA: RegisteredTestUser;
  let userB: RegisteredTestUser;
  let projectId: string;
  let fixtureRoot: string;

  beforeAll(async () => {
    userA = await registerTestUser(app);
    userB = await registerTestUser(app);
    createdEmails.push(userA.email, userB.email);
    projectId = await createTestProject(app, userA.cookie, { name: "Scan Project" });

    fixtureRoot = path.join(scratchBase, "fixture-project");
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "README.md"), "# Fixture\n");
    await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "src", "index.ts"), "export const x = 1;\n");
  });

  afterAll(async () => {
    await Scan.deleteMany({ project: projectId });
    await Project.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await User.deleteMany({ email: { $in: createdEmails } });
    await fs.rm(scratchBase, { recursive: true, force: true });
    await disconnectDB();
  });

  describe("PUT/GET /api/projects/:projectId/source", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app).put(`/api/projects/${projectId}/source`).send({ path: fixtureRoot });
      expect(res.status).toBe(401);
    });

    it("rejects a request for another user's project (404, not 403)", async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}/source`)
        .set("Cookie", userB.cookie)
        .send({ path: fixtureRoot });
      expect(res.status).toBe(404);
    });

    it("rejects an empty path", async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}/source`)
        .set("Cookie", userA.cookie)
        .send({ path: "" });
      expect(res.status).toBe(400);
    });

    it("rejects a nonexistent path", async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}/source`)
        .set("Cookie", userA.cookie)
        .send({ path: path.join(scratchBase, `does-not-exist-${randomUUID()}`) });
      expect(res.status).toBe(400);
    });

    it("rejects a UNC path", async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}/source`)
        .set("Cookie", userA.cookie)
        .send({ path: "\\\\server\\share\\project" });
      expect(res.status).toBe(400);
    });

    it("rejects a file given where a directory is required", async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}/source`)
        .set("Cookie", userA.cookie)
        .send({ path: path.join(fixtureRoot, "README.md") });
      expect(res.status).toBe(400);
    });

    it("configures a valid source directory and never returns the raw absolute path", async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}/source`)
        .set("Cookie", userA.cookie)
        .send({ path: fixtureRoot });
      expect(res.status).toBe(200);
      expect(res.body.sourceConfig).toMatchObject({ hasPath: true, label: "fixture-project" });
      expect(JSON.stringify(res.body)).not.toContain(fixtureRoot.replace(/\\/g, "\\\\"));
      expect(JSON.stringify(res.body)).not.toContain(scratchBase);
    });

    it("returns the configured source via GET, still without the raw path", async () => {
      const res = await request(app).get(`/api/projects/${projectId}/source`).set("Cookie", userA.cookie);
      expect(res.status).toBe(200);
      expect(res.body.sourceConfig).toMatchObject({ hasPath: true, label: "fixture-project" });
      expect(JSON.stringify(res.body)).not.toContain(scratchBase);
    });

    it("rejects a cross-user GET (404)", async () => {
      const res = await request(app).get(`/api/projects/${projectId}/source`).set("Cookie", userB.cookie);
      expect(res.status).toBe(404);
    });

    it("rejects an invalid project id (400)", async () => {
      const res = await request(app).get(`/api/projects/not-a-real-id/source`).set("Cookie", userA.cookie);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/projects/:projectId/scans and GET .../scans/latest", () => {
    it("rejects starting a scan cross-user (404)", async () => {
      const res = await request(app).post(`/api/projects/${projectId}/scans`).set("Cookie", userB.cookie);
      expect(res.status).toBe(404);
    });

    it("rejects starting a scan when no source is configured", async () => {
      const bareProjectId = await createTestProject(app, userA.cookie, { name: "No Source Project" });
      const res = await request(app).post(`/api/projects/${bareProjectId}/scans`).set("Cookie", userA.cookie);
      expect(res.status).toBe(400);
    });

    it("runs a scan successfully and persists no raw absolute path in the response", async () => {
      const res = await request(app).post(`/api/projects/${projectId}/scans`).set("Cookie", userA.cookie);
      expect(res.status).toBe(201);
      expect(res.body.scan).toMatchObject({ outcome: expect.any(String) });
      expect(res.body.scan.summary.totalScanned).toBeGreaterThan(0);
      const relPaths = res.body.scan.items.map((i: { relativePath: string }) => i.relativePath);
      expect(relPaths).toContain("README.md");
      expect(relPaths).toContain("src/index.ts");
      expect(JSON.stringify(res.body)).not.toContain(scratchBase);
    });

    it("rejects starting a scan when the configured directory was replaced by a junction since it was configured (does not silently scan through it)", async () => {
      const swapProjectId = await createTestProject(app, userA.cookie, { name: "Swap Root Project" });
      const originalPath = path.join(scratchBase, "swap-root-original");
      await fs.mkdir(originalPath, { recursive: true });

      await request(app)
        .put(`/api/projects/${swapProjectId}/source`)
        .set("Cookie", userA.cookie)
        .send({ path: originalPath })
        .expect(200);

      // Simulate the configured directory being replaced by a link
      // pointing somewhere else after it was approved — the exact
      // scenario `revalidateScanRoot` exists to catch at scan time.
      const elsewhere = path.join(scratchBase, "swap-root-elsewhere");
      await fs.mkdir(elsewhere, { recursive: true });
      await fs.writeFile(path.join(elsewhere, "unexpected.txt"), "should never be scanned");
      await fs.rmdir(originalPath);
      await fs.symlink(elsewhere, originalPath, "junction");

      const res = await request(app).post(`/api/projects/${swapProjectId}/scans`).set("Cookie", userA.cookie);
      expect(res.status).toBe(400);
    });

    it("retrieves the latest scan via GET .../scans/latest", async () => {
      const res = await request(app)
        .get(`/api/projects/${projectId}/scans/latest`)
        .set("Cookie", userA.cookie);
      expect(res.status).toBe(200);
      expect(res.body.scan).not.toBeNull();
      expect(res.body.scan.summary.totalScanned).toBeGreaterThan(0);
    });

    it("rejects a cross-user GET of the latest scan (404)", async () => {
      const res = await request(app)
        .get(`/api/projects/${projectId}/scans/latest`)
        .set("Cookie", userB.cookie);
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated scan start (401)", async () => {
      const res = await request(app).post(`/api/projects/${projectId}/scans`);
      expect(res.status).toBe(401);
    });
  });
});
