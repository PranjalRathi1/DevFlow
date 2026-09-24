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

const scratchBase = path.join(os.tmpdir(), `devflow-nodenext-api-${randomUUID()}`);

// A small NodeNext-style project: TypeScript sources importing each other
// through emitted `.js`/`.jsx` specifiers, plus deliberate conflict,
// missing-target, and JS-importer cases.
const FIXTURE_FILES: Record<string, string> = {
  "src/index.ts": [
    `import { util } from "./lib/util.js";`,
    `import { View } from "./components/View.js";`,
    `import { legacy } from "./legacy.js";`,
    `import { dual } from "./dual.js";`,
    `import { gone } from "./missing.js";`,
    `import { ai } from "./services/ai/index.js";`,
    `import path from "node:path";`,
    `export { util as reexported } from "./lib/util.js";`,
  ].join("\n"),
  "src/App.tsx": `import { Button } from "./Button.jsx";\nexport const App = () => Button;\n`,
  "src/Button.tsx": `export const Button = 1;\n`,
  "src/lib/util.ts": `export const util = 1;\n`,
  "src/components/View.tsx": `export const View = 1;\n`,
  "src/legacy.js": `export const legacy = 1;\n`,
  "src/dual.ts": `export const dual = 1;\n`,
  "src/dual.js": `export const dual = 2;\n`,
  "src/services/ai/index.ts": `export const ai = 1;\n`,
  "src/plain.js": `import { util } from "./lib/util.js";\n`,
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
  "NodeNext-compatible resolution end-to-end (real MongoDB, real filesystem)",
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
      projectId = await createTestProject(app, user.cookie, { name: "NodeNext Project" });

      fixtureRoot = path.join(scratchBase, "nodenext-fixture");
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
    });

    afterAll(async () => {
      await Analysis.deleteMany({ project: projectId });
      await Scan.deleteMany({ project: projectId });
      await Project.deleteMany({ owner: user.userId });
      await User.deleteMany({ email: { $in: createdEmails } });
      await fs.rm(scratchBase, { recursive: true, force: true });
      await disconnectDB();
    });

    it("classifies every NodeNext relationship with accurate evidence", async () => {
      const res = await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", user.cookie);
      expect(res.status).toBe(201);
      const { analysis } = res.body;
      expect(JSON.stringify(res.body)).not.toContain(scratchBase);

      type Rel = {
        importerRelativePath: string;
        rawImport: string;
        status: string;
        line?: number;
        resolvedRelativePath?: string;
        resolutionMethod?: string;
        reason?: string;
      };
      const rels: Rel[] = analysis.relationships;
      const find = (importer: string, raw: string) =>
        rels.filter((r) => r.importerRelativePath === importer && r.rawImport === raw);

      // Raw specifier is preserved verbatim; the mapped target and method are recorded separately.
      const utilRels = find("src/index.ts", "./lib/util.js");
      expect(utilRels).toHaveLength(2);
      for (const r of utilRels) {
        expect(r).toMatchObject({
          status: "confirmed",
          resolvedRelativePath: "src/lib/util.ts",
          resolutionMethod: "nodenext:.js->.ts",
        });
      }
      expect(utilRels.map((r) => r.line).sort()).toEqual([1, 8]);

      expect(find("src/index.ts", "./components/View.js")[0]).toMatchObject({
        status: "confirmed",
        resolvedRelativePath: "src/components/View.tsx",
        resolutionMethod: "nodenext:.js->.tsx",
        line: 2,
      });
      expect(find("src/index.ts", "./legacy.js")[0]).toMatchObject({
        status: "confirmed",
        resolvedRelativePath: "src/legacy.js",
        resolutionMethod: "exact",
      });
      expect(find("src/index.ts", "./services/ai/index.js")[0]).toMatchObject({
        status: "confirmed",
        resolvedRelativePath: "src/services/ai/index.ts",
        resolutionMethod: "nodenext:.js->.ts",
      });
      expect(find("src/App.tsx", "./Button.jsx")[0]).toMatchObject({
        status: "confirmed",
        resolvedRelativePath: "src/Button.tsx",
        resolutionMethod: "nodenext:.jsx->.tsx",
      });

      const dual = find("src/index.ts", "./dual.js")[0];
      expect(dual?.status).toBe("unresolved");
      expect(dual?.resolvedRelativePath).toBeUndefined();
      expect(dual?.reason).toMatch(/ambiguous/i);

      expect(find("src/index.ts", "./missing.js")[0]?.status).toBe("unresolved");
      expect(find("src/index.ts", "node:path")[0]?.status).toBe("external");

      const plain = find("src/plain.js", "./lib/util.js")[0];
      expect(plain?.status).toBe("unresolved");
      expect(plain?.reason).toMatch(/TypeScript importers only/);

      // Every confirmed target is a real file in THIS scan's inventory.
      const scanRes = await request(app).get(`/api/scans/${scanId}`).set("Cookie", user.cookie);
      const scannedFiles = new Set(
        scanRes.body.scan.items
          .filter((i: { type: string }) => i.type === "file")
          .map((i: { relativePath: string }) => i.relativePath),
      );
      const confirmed = rels.filter((r) => r.status === "confirmed");
      expect(confirmed).toHaveLength(6);
      for (const r of confirmed) {
        expect(scannedFiles.has(r.resolvedRelativePath)).toBe(true);
      }
    });

    it("produces graph edges in the correct direction with the raw .js specifier as evidence", async () => {
      const res = await request(app).get(`/api/scans/${scanId}/graph`).set("Cookie", user.cookie);
      expect(res.status).toBe(200);
      const { graph } = res.body;
      expect(JSON.stringify(res.body)).not.toContain(scratchBase);

      type Edge = { from: string; to: string; evidence: { rawImport: string; resolutionMethod?: string }[] };
      const edges: Edge[] = graph.edges;
      expect(edges.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual([
        "src/App.tsx -> src/Button.tsx",
        "src/index.ts -> src/components/View.tsx",
        "src/index.ts -> src/legacy.js",
        "src/index.ts -> src/lib/util.ts",
        "src/index.ts -> src/services/ai/index.ts",
      ]);

      const utilEdge = edges.find((e) => e.to === "src/lib/util.ts");
      expect(utilEdge?.evidence).toHaveLength(2);
      for (const ev of utilEdge?.evidence ?? []) {
        expect(ev).toMatchObject({ rawImport: "./lib/util.js", resolutionMethod: "nodenext:.js->.ts" });
      }

      // Nothing is silently dropped, and nothing ambiguous became an edge.
      expect(edges.some((e) => e.to === "src/dual.ts" || e.to === "src/dual.js")).toBe(false);
      const unresolvedRaw = graph.unresolved.map((r: { rawImport: string }) => r.rawImport).sort();
      expect(unresolvedRaw).toEqual(["./dual.js", "./lib/util.js", "./missing.js"]);
      expect(graph.validationErrors).toEqual([]);
    });

    it("leaves the source project byte-for-byte unchanged", async () => {
      const after = await snapshotFixture(fixtureRoot);
      expect(after).toEqual(before);
      const entries = await fs.readdir(path.join(fixtureRoot, "src"));
      expect(entries.sort()).toEqual(
        [
          "App.tsx",
          "Button.tsx",
          "components",
          "dual.js",
          "dual.ts",
          "index.ts",
          "legacy.js",
          "lib",
          "plain.js",
          "services",
        ].sort(),
      );
    });
  },
);
