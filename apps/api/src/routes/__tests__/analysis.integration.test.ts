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
import { Analysis } from "../../models/Analysis.js";
import { createTestProject, registerTestUser, type RegisteredTestUser } from "../../__tests__/testHelpers.js";

let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const scratchBase = path.join(os.tmpdir(), `devflow-analysis-api-${randomUUID()}`);

describe.skipIf(!dbAvailable)("Import extraction & resolution API (real MongoDB, real filesystem)", () => {
  const app = createApp();
  const createdEmails: string[] = [];
  let userA: RegisteredTestUser;
  let userB: RegisteredTestUser;
  let projectId: string;
  let fixtureRoot: string;
  let scanId: string;

  beforeAll(async () => {
    userA = await registerTestUser(app);
    userB = await registerTestUser(app);
    createdEmails.push(userA.email, userB.email);
    projectId = await createTestProject(app, userA.cookie, { name: "Analysis Project" });

    fixtureRoot = path.join(scratchBase, "fixture-project");
    await fs.mkdir(path.join(fixtureRoot, "src", "utils"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "src", "index.ts"),
      [
        `import { helper } from "./utils/helper";`,
        `import react from "react";`,
        `import "./styles.css";`,
        `import missing from "./does-not-exist";`,
        `import aliased from "@/thing";`,
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(fixtureRoot, "src", "utils", "helper.ts"),
      `export const helper = () => 1;\n`,
    );
    await fs.writeFile(path.join(fixtureRoot, "src", "broken.ts"), `import { from "./nowhere;;; @#$%`);

    await request(app)
      .put(`/api/projects/${projectId}/source`)
      .set("Cookie", userA.cookie)
      .send({ path: fixtureRoot })
      .expect(200);

    const scanRes = await request(app)
      .post(`/api/projects/${projectId}/scans`)
      .set("Cookie", userA.cookie)
      .expect(201);
    scanId = scanRes.body.scan._id;
  });

  afterAll(async () => {
    await Analysis.deleteMany({ project: projectId });
    await Scan.deleteMany({ project: projectId });
    await Project.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await User.deleteMany({ email: { $in: createdEmails } });
    await fs.rm(scratchBase, { recursive: true, force: true });
    await disconnectDB();
  });

  describe("GET /api/scans/:id", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get(`/api/scans/${scanId}`);
      expect(res.status).toBe(401);
    });

    it("rejects a cross-user request (404, not 403)", async () => {
      const res = await request(app).get(`/api/scans/${scanId}`).set("Cookie", userB.cookie);
      expect(res.status).toBe(404);
    });

    it("returns the scan for its owner", async () => {
      const res = await request(app).get(`/api/scans/${scanId}`).set("Cookie", userA.cookie);
      expect(res.status).toBe(200);
      expect(res.body.scan._id).toBe(scanId);
    });

    it("rejects an invalid scan id (400)", async () => {
      const res = await request(app).get(`/api/scans/not-a-real-id`).set("Cookie", userA.cookie);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/scans/:id/analysis", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app).post(`/api/scans/${scanId}/analysis`);
      expect(res.status).toBe(401);
    });

    it("rejects a cross-user request (404)", async () => {
      const res = await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", userB.cookie);
      expect(res.status).toBe(404);
    });

    it("rejects analyzing a scan that itself failed", async () => {
      const failedScan = await Scan.create({
        project: projectId,
        owner: userA.userId,
        outcome: "failed",
        summary: { totalScanned: 0, totalSkipped: 0, totalErrors: 0, durationMs: 1, limitsReached: [] },
        items: [],
        errorMessage: "Could not read the configured source directory",
      });
      const res = await request(app)
        .post(`/api/scans/${failedScan._id.toString()}/analysis`)
        .set("Cookie", userA.cookie);
      expect(res.status).toBe(400);
    });

    it("runs analysis end-to-end and correctly classifies every relationship type, with no raw absolute path leaked", async () => {
      const res = await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", userA.cookie);
      expect(res.status).toBe(201);

      const { analysis } = res.body;
      expect(analysis.outcome).toBe("completed_with_warnings");
      expect(JSON.stringify(res.body)).not.toContain(scratchBase);

      const byImporter = (importer: string) =>
        analysis.relationships.filter(
          (r: { importerRelativePath: string }) => r.importerRelativePath === importer,
        );

      const indexRelationships = byImporter("src/index.ts");
      expect(indexRelationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rawImport: "./utils/helper",
            status: "confirmed",
            resolvedRelativePath: "src/utils/helper.ts",
          }),
          expect.objectContaining({ rawImport: "react", status: "external" }),
          expect.objectContaining({ rawImport: "./styles.css", status: "unsupported" }),
          expect.objectContaining({ rawImport: "./does-not-exist", status: "unresolved" }),
          expect.objectContaining({ rawImport: "@/thing", status: "unsupported" }),
        ]),
      );

      const brokenRelationships = byImporter("src/broken.ts");
      expect(brokenRelationships).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "parse_error" })]),
      );

      expect(analysis.summary.totalFilesAnalyzed).toBe(3);
      expect(analysis.summary.byStatus.confirmed).toBe(1);
      expect(analysis.summary.byStatus.external).toBe(1);
      expect(analysis.summary.byStatus.parse_error).toBe(1);
    });
  });

  describe("GET /api/scans/:id/analysis", () => {
    it("retrieves the latest analysis for its owner", async () => {
      const res = await request(app).get(`/api/scans/${scanId}/analysis`).set("Cookie", userA.cookie);
      expect(res.status).toBe(200);
      expect(res.body.analysis).not.toBeNull();
      expect(res.body.analysis.summary.totalRelationships).toBeGreaterThan(0);
    });

    it("rejects a cross-user request (404)", async () => {
      const res = await request(app).get(`/api/scans/${scanId}/analysis`).set("Cookie", userB.cookie);
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get(`/api/scans/${scanId}/analysis`);
      expect(res.status).toBe(401);
    });
  });
});
