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

const scratchBase = path.join(os.tmpdir(), `devflow-graph-api-${randomUUID()}`);

describe.skipIf(!dbAvailable)("Dependency graph API (real MongoDB, real filesystem)", () => {
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
    projectId = await createTestProject(app, userA.cookie, { name: "Graph Project" });

    // A -> B -> C, and a genuine 2-cycle between x/y, plus an external import.
    fixtureRoot = path.join(scratchBase, "fixture-project");
    await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "src", "a.ts"),
      `import { b } from "./b";\nimport react from "react";\n`,
    );
    await fs.writeFile(path.join(fixtureRoot, "src", "b.ts"), `import { c } from "./c";\n`);
    await fs.writeFile(path.join(fixtureRoot, "src", "c.ts"), `export const c = 1;\n`);
    await fs.writeFile(path.join(fixtureRoot, "src", "x.ts"), `import { y } from "./y";\n`);
    await fs.writeFile(path.join(fixtureRoot, "src", "y.ts"), `import { x } from "./x";\n`);

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

    await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", userA.cookie).expect(201);
  });

  afterAll(async () => {
    await Analysis.deleteMany({ project: projectId });
    await Scan.deleteMany({ project: projectId });
    await Project.deleteMany({ owner: { $in: [userA.userId, userB.userId] } });
    await User.deleteMany({ email: { $in: createdEmails } });
    await fs.rm(scratchBase, { recursive: true, force: true });
    await disconnectDB();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get(`/api/scans/${scanId}/graph`);
    expect(res.status).toBe(401);
  });

  it("rejects a cross-user request (404, not 403)", async () => {
    const res = await request(app).get(`/api/scans/${scanId}/graph`).set("Cookie", userB.cookie);
    expect(res.status).toBe(404);
  });

  it("returns 404 when no analysis has been run for a valid, owned scan", async () => {
    const bareProjectId = await createTestProject(app, userA.cookie, { name: "No Analysis Project" });
    const bareFixture = path.join(scratchBase, "bare-fixture");
    await fs.mkdir(bareFixture, { recursive: true });
    await fs.writeFile(path.join(bareFixture, "index.ts"), "export const x = 1;\n");
    await request(app)
      .put(`/api/projects/${bareProjectId}/source`)
      .set("Cookie", userA.cookie)
      .send({ path: bareFixture })
      .expect(200);
    const bareScan = await request(app)
      .post(`/api/projects/${bareProjectId}/scans`)
      .set("Cookie", userA.cookie)
      .expect(201);

    const res = await request(app)
      .get(`/api/scans/${bareScan.body.scan._id}/graph`)
      .set("Cookie", userA.cookie);
    expect(res.status).toBe(404);
  });

  it("builds the correct graph end-to-end: real nodes, a real edge, a real cycle, no raw absolute path leaked", async () => {
    const res = await request(app).get(`/api/scans/${scanId}/graph`).set("Cookie", userA.cookie);
    expect(res.status).toBe(200);

    const { graph } = res.body;
    expect(graph.scanId).toBe(scanId);
    expect(JSON.stringify(res.body)).not.toContain(scratchBase);

    const nodeIds = graph.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toEqual(
      expect.arrayContaining(["src/a.ts", "src/b.ts", "src/c.ts", "src/x.ts", "src/y.ts"]),
    );

    const abEdge = graph.edges.find(
      (e: { from: string; to: string }) => e.from === "src/a.ts" && e.to === "src/b.ts",
    );
    expect(abEdge).toBeDefined();
    expect(abEdge.evidence[0]).toMatchObject({ rawImport: "./b" });

    // react is external, never a confirmed edge.
    expect(graph.external.some((r: { rawImport: string }) => r.rawImport === "react")).toBe(true);
    expect(graph.edges.some((e: { to: string }) => e.to === "react")).toBe(false);

    // x <-> y is a real cycle.
    expect(graph.isAcyclic).toBe(false);
    expect(graph.cycles.length).toBeGreaterThan(0);
    expect(graph.topologicalOrder).toBeNull();

    // c is a leaf (imports nothing); a is a root among the a->b->c chain.
    expect(graph.leafNodes).toContain("src/c.ts");
  });

  it("returns a stable, deterministic response across repeated requests", async () => {
    const first = await request(app).get(`/api/scans/${scanId}/graph`).set("Cookie", userA.cookie);
    const second = await request(app).get(`/api/scans/${scanId}/graph`).set("Cookie", userA.cookie);
    expect(second.body.graph.nodes).toEqual(first.body.graph.nodes);
    expect(second.body.graph.edges).toEqual(first.body.graph.edges);
    expect(second.body.graph.cycles).toEqual(first.body.graph.cycles);
  });

  it("rejects an invalid scan id (400)", async () => {
    const res = await request(app).get(`/api/scans/not-a-real-id/graph`).set("Cookie", userA.cookie);
    expect(res.status).toBe(400);
  });
});
