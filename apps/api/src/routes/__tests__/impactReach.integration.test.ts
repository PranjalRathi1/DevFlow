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

const scratchBase = path.join(os.tmpdir(), `devflow-impact-reach-${randomUUID()}`);

// Task 2 (ADR-029), hand-derived. Target: src/types.ts
//   src/model.ts   — import type from types         -> direct, type_only
//   src/service.ts — imports model                   -> depth 2, type_only
//   src/handler.ts — imports types at runtime        -> direct, runtime
//   src/index.ts   — re-exports handler (barrel)     -> depth 2, runtime, re-exports only; package "main"
//   src/app.ts     — imports index                   -> depth 3, runtime, re-exports only; no importers
//   bin/cli.js     — imports the barrel "../src/index.ts" -> depth 3, re-exports only; package "bin"
const FIXTURE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "reach-fixture",
    main: "./src/index.ts",
    bin: { reach: "./bin/cli.js" },
  }),
  "src/types.ts": `export interface User { id: string }\n`,
  "src/model.ts": `import type { User } from "./types";\nexport const load = (): User | null => null;\n`,
  "src/service.ts": `import { load } from "./model";\nexport const run = () => load();\n`,
  "src/handler.ts": `import * as T from "./types";\nexport const handle = () => T;\n`,
  "src/index.ts": `export { handle } from "./handler";\n`,
  "src/app.ts": `import { handle } from "./index";\nhandle();\n`,
  "bin/cli.js": `import { handle } from "../src/index.ts";\nhandle();\n`,
};

async function snapshotFixture(root: string): Promise<Record<string, { content: string; mtimeMs: number }>> {
  const snap: Record<string, { content: string; mtimeMs: number }> = {};
  for (const rel of Object.keys(FIXTURE_FILES)) {
    const abs = path.join(root, ...rel.split("/"));
    const stat = await fs.stat(abs);
    snap[rel] = { content: await fs.readFile(abs, "utf-8"), mtimeMs: stat.mtimeMs };
  }
  return snap;
}

describe.skipIf(!dbAvailable)(
  "impact reach and entry points end-to-end (real MongoDB, real filesystem)",
  () => {
    const app = createApp();
    const createdEmails: string[] = [];
    let user: RegisteredTestUser;
    let projectId: string;
    let fixtureRoot: string;
    let scanId: string;
    let before: Awaited<ReturnType<typeof snapshotFixture>>;

    beforeAll(async () => {
      user = await registerTestUser(app);
      createdEmails.push(user.email);
      projectId = await createTestProject(app, user.cookie, { name: "Impact Reach Project" });
      fixtureRoot = path.join(scratchBase, "reach-fixture");
      for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
        const abs = path.join(fixtureRoot, ...rel.split("/"));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
      before = await snapshotFixture(fixtureRoot);
      await request(app)
        .put(`/api/projects/${projectId}/source`)
        .set("Cookie", user.cookie)
        .send({ path: fixtureRoot })
        .expect(200);
      const scanRes = await request(app)
        .post(`/api/projects/${projectId}/scans`)
        .set("Cookie", user.cookie)
        .expect(201);
      scanId = scanRes.body.scan._id;
      await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", user.cookie).expect(201);
    });

    afterAll(async () => {
      await Analysis.deleteMany({ project: projectId });
      await Scan.deleteMany({ project: projectId });
      await Project.deleteMany({ owner: user.userId });
      await User.deleteMany({ email: { $in: createdEmails } });
      await fs.rm(scratchBase, { recursive: true, force: true });
      await disconnectDB();
    });

    it("labels runtime/type-only/re-export reach and lists declared and root entry points", async () => {
      const res = await request(app)
        .get(`/api/scans/${scanId}/impact?file=src/types.ts&maxDepth=10&maxNodes=100`)
        .set("Cookie", user.cookie);
      expect(res.status).toBe(200);
      const { impact } = res.body;
      expect(JSON.stringify(res.body)).not.toContain(scratchBase);

      type Dep = { file: string; reach: string; onlyThroughReExports?: boolean; depth?: number };
      const deps: Dep[] = [...impact.directDependents, ...impact.transitiveDependents];
      const byFile = Object.fromEntries(
        deps.map((d) => [d.file, `${d.reach}${d.onlyThroughReExports ? "+reexports" : ""}`]),
      );
      expect(byFile).toEqual({
        "src/model.ts": "type_only",
        "src/service.ts": "type_only",
        "src/handler.ts": "runtime",
        "src/index.ts": "runtime+reexports",
        "src/app.ts": "runtime+reexports",
        "bin/cli.js": "runtime+reexports",
      });
      expect(impact.dependentTotals).toEqual({ all: 6, runtime: 4, typeOnly: 2, onlyThroughReExports: 3 });
      expect(impact.packageEntryPointsRecorded).toBe(true);
      expect(
        impact.affectedEntryPoints.map(
          (p: { file: string; depth: number; declaredBy: string[]; noImporters: boolean }) => [
            p.file,
            p.depth,
            p.declaredBy,
            p.noImporters,
          ],
        ),
      ).toEqual([
        ["src/index.ts", 2, ["package.json main"], false],
        ["src/service.ts", 2, [], true],
        ["bin/cli.js", 3, ["package.json bin.reach"], true],
        ["src/app.ts", 3, [], true],
      ]);
      expect(impact.affectedEntryPointsTotal).toBe(4);
    });

    it("leaves the source project byte-for-byte unchanged", async () => {
      expect(await snapshotFixture(fixtureRoot)).toEqual(before);
    });
  },
);
