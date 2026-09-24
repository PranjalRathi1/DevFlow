import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

const scratchBase = path.join(os.tmpdir(), `devflow-impact-api-${randomUUID()}`);

// Hand-checked (importer -> imported): app -> routes -> service -> db; worker -> service;
// service also has unresolved "./gone.js" and external "pg".
const FIXTURE: Record<string, string> = {
  "src/app.ts": `import { r } from "./routes.js";\n`,
  "src/routes.ts": `import { s } from "./service.js";\nexport const r = s;\n`,
  "src/service.ts": `import { d } from "./db.js";\nimport pg from "pg";\nimport { g } from "./gone.js";\nexport const s = d;\n`,
  "src/db.ts": `export const d = 1;\n`,
  "src/worker.ts": `import { s } from "./service.js";\n`,
  "src/styles.css": `body {}\n`,
};

async function hashes(root: string) {
  const out: Record<string, string> = {};
  for (const rel of Object.keys(FIXTURE).sort()) {
    const abs = path.join(root, ...rel.split("/"));
    out[rel] = `${createHash("sha256")
      .update(await fs.readFile(abs))
      .digest("hex")}:${(await fs.stat(abs)).mtimeMs}`;
  }
  return out;
}

describe.skipIf(!dbAvailable)("GET /api/scans/:id/impact (real MongoDB, real filesystem)", () => {
  const app = createApp();
  const emails: string[] = [];
  let owner: RegisteredTestUser;
  let stranger: RegisteredTestUser;
  let projectId: string;
  let scanId: string;
  let analysisId: string;
  let unanalyzedScanId: string;
  let root: string;
  let before: Record<string, string>;

  const impact = (query: string, cookie = owner.cookie, id = scanId) =>
    request(app).get(`/api/scans/${id}/impact?${query}`).set("Cookie", cookie);

  beforeAll(async () => {
    owner = await registerTestUser(app);
    stranger = await registerTestUser(app);
    emails.push(owner.email, stranger.email);
    projectId = await createTestProject(app, owner.cookie, { name: "Impact" });
    root = path.join(scratchBase, "fixture");
    for (const [rel, content] of Object.entries(FIXTURE)) {
      const abs = path.join(root, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    before = await hashes(root);
    await request(app)
      .put(`/api/projects/${projectId}/source`)
      .set("Cookie", owner.cookie)
      .send({ path: root })
      .expect(200);
    unanalyzedScanId = (
      await request(app).post(`/api/projects/${projectId}/scans`).set("Cookie", owner.cookie).expect(201)
    ).body.scan._id;
    scanId = (
      await request(app).post(`/api/projects/${projectId}/scans`).set("Cookie", owner.cookie).expect(201)
    ).body.scan._id;
    analysisId = (
      await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", owner.cookie).expect(201)
    ).body.analysis._id;
  });

  afterAll(async () => {
    const owners = [owner.userId, stranger.userId];
    await Analysis.deleteMany({ owner: { $in: owners } });
    await Scan.deleteMany({ owner: { $in: owners } });
    await Project.deleteMany({ owner: { $in: owners } });
    await User.deleteMany({ email: { $in: emails } });
    await fs.rm(scratchBase, { recursive: true, force: true });
    await disconnectDB();
  });

  it("returns direction-correct impact with evidence, pinned to the scan and analysis", async () => {
    const res = await impact("file=src/service.ts").expect(200);
    const i = res.body.impact;
    expect(i).toMatchObject({ scanId, analysisId, file: "src/service.ts", inGraph: true, truncated: false });
    expect(i.directDependencies.map((d: { file: string }) => d.file)).toEqual(["src/db.ts"]);
    expect(i.directDependents.map((d: { file: string }) => d.file)).toEqual([
      "src/routes.ts",
      "src/worker.ts",
    ]);
    expect(i.transitiveDependents).toEqual([
      {
        file: "src/app.ts",
        depth: 2,
        via: "src/routes.ts",
        evidence: [
          expect.objectContaining({
            rawImport: "./routes.js",
            line: 1,
            resolutionMethod: "nodenext:.js->.ts",
          }),
        ],
      },
    ]);
    expect(i.nonConfirmedImports.unresolved.map((r: { rawImport: string }) => r.rawImport)).toEqual([
      "./gone.js",
    ]);
    expect(i.nonConfirmedImports.external.map((r: { rawImport: string }) => r.rawImport)).toEqual(["pg"]);
    expect(JSON.stringify(res.body)).not.toContain(scratchBase);
  });

  it("agrees with /graph: direct lists are exactly the graph's incoming/outgoing edges", async () => {
    const graph = (
      await request(app).get(`/api/scans/${scanId}/graph`).set("Cookie", owner.cookie).expect(200)
    ).body.graph;
    for (const file of ["src/app.ts", "src/routes.ts", "src/service.ts", "src/db.ts", "src/worker.ts"]) {
      const i = (await impact(`file=${file}`).expect(200)).body.impact;
      const incoming = graph.edges.filter((e: { to: string }) => e.to === file);
      const outgoing = graph.edges.filter((e: { from: string }) => e.from === file);
      expect(i.directDependents.map((d: { file: string }) => d.file)).toEqual(
        incoming.map((e: { from: string }) => e.from).sort(),
      );
      expect(i.directDependencies.map((d: { file: string }) => d.file)).toEqual(
        outgoing.map((e: { to: string }) => e.to).sort(),
      );
    }
  });

  it("is deterministic across repeated calls", async () => {
    const a = (await impact("file=src/db.ts").expect(200)).body;
    const b = (await impact("file=src/db.ts").expect(200)).body;
    expect(b).toEqual(a);
  });

  it("applies and reports bounds", async () => {
    const i = (await impact("file=src/db.ts&maxDepth=2").expect(200)).body.impact;
    expect(i.bounds).toEqual({ maxDepth: 2, maxNodes: 200 });
    expect(i.truncated).toBe(true);
    expect(i.transitiveDependents.map((t: { file: string }) => t.file)).toEqual([
      "src/routes.ts",
      "src/worker.ts",
    ]);
    await impact("file=src/db.ts&maxDepth=999").expect(400);
    await impact("file=src/db.ts&maxNodes=0").expect(400);
  });

  it("marks a scanned non-source file as having no import data", async () => {
    const i = (await impact("file=src/styles.css").expect(200)).body.impact;
    expect(i.inGraph).toBe(false);
  });

  it.each([
    ["../outside.ts"],
    ["src/../../x.ts"],
    ["/etc/passwd"],
    ["C:/Windows/win.ini"],
    ["..%5Coutside.ts"],
    [""],
  ])("rejects an unsafe or empty path (%s) with 400", async (p) => {
    const res = await impact(`file=${p}`);
    expect(res.status).toBe(400);
  });

  it("404s for a file the scan never observed, and never guesses a near match", async () => {
    await impact("file=src/missing.ts").expect(404);
    await impact("file=src/service").expect(404);
    await impact("file=src").expect(404); // a directory is not a file
  });

  it("requires an analysis for the scan", async () => {
    await impact("file=src/service.ts", owner.cookie, unanalyzedScanId).expect(404);
  });

  it("enforces authentication and ownership", async () => {
    await request(app).get(`/api/scans/${scanId}/impact?file=src/service.ts`).expect(401);
    await impact("file=src/service.ts", stranger.cookie).expect(404);
    await impact("file=src/service.ts", owner.cookie, "not-an-id").expect(400);
  });

  it("creates nothing and leaves the source byte-identical", async () => {
    const scans = await Scan.countDocuments({ project: projectId });
    const analyses = await Analysis.countDocuments({ scan: scanId });
    await impact("file=src/service.ts").expect(200);
    expect(await Scan.countDocuments({ project: projectId })).toBe(scans);
    expect(await Analysis.countDocuments({ scan: scanId })).toBe(analyses);
    expect(await hashes(root)).toEqual(before);
  });
});
