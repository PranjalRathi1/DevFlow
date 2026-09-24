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

const scratchBase = path.join(os.tmpdir(), `devflow-alias-api-${randomUUID()}`);

// Task 1 (ADR-028): a small monorepo exercising tsconfig `extends`,
// `paths`/`baseUrl`, package `exports`/`imports`, and every non-confirmed
// category. Expected results are written by hand from TypeScript/Node rules.
const FIXTURE_FILES: Record<string, string> = {
  "configs/base.json": JSON.stringify({
    compilerOptions: { baseUrl: "../apps/web", paths: { "@/*": ["src/*"], "@app": ["src/local.ts"] } },
  }),
  "apps/web/tsconfig.json": JSON.stringify({
    extends: "../../configs/base.json",
    compilerOptions: { module: "NodeNext" },
  }),
  "apps/web/package.json": JSON.stringify({ name: "web", imports: { "#env": "./src/env.ts" } }),
  "apps/web/src/main.ts": [
    `import { util } from "@/lib/util";`,
    `import type { Props } from "@/types";`,
    `import { View } from "@/components/View.js";`,
    `import { gone } from "@/missing";`,
    `import { Case } from "@/lib/case";`,
    `import { env } from "#env";`,
    `import { Button } from "@acme/ui";`,
    `import { hidden } from "@acme/ui/src/internal";`,
    `import { helper } from "src/lib/util";`,
    `import { notUnderBaseUrl } from "lib/util";`,
    `import { local } from "./local";`,
    `import react from "react";`,
    `import { app } from "@app";`,
  ].join("\n"),
  "apps/web/src/local.ts": `export const local = 1;\n`,
  "apps/web/src/env.ts": `export const env = 1;\n`,
  "apps/web/src/types.ts": `export type Props = {};\n`,
  "apps/web/src/lib/util.ts": `export const util = 1;\n`,
  "apps/web/src/lib/Case.ts": `export const Case = 1;\n`,
  "apps/web/src/components/View.tsx": `export const View = 1;\n`,
  "packages/ui/package.json": JSON.stringify({
    name: "@acme/ui",
    exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } },
  }),
  "packages/ui/src/index.ts": `export const Button = 1;\n`,
  "packages/ui/src/internal.ts": `export const hidden = 1;\n`,
  "packages/ui/tsconfig.json": JSON.stringify({ extends: "@tsconfig/strictest/tsconfig.json" }),
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

describe.skipIf(!dbAvailable)("alias / package resolution end-to-end (real MongoDB, real filesystem)", () => {
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
    projectId = await createTestProject(app, user.cookie, { name: "Alias Project" });

    fixtureRoot = path.join(scratchBase, "alias-fixture");
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

  it("classifies every alias/package import with its method, and records the config it used", async () => {
    const res = await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", user.cookie);
    expect(res.status).toBe(201);
    const { analysis } = res.body;
    expect(JSON.stringify(res.body)).not.toContain(scratchBase);

    type Rel = {
      importerRelativePath: string;
      rawImport: string;
      status: string;
      typeOnly?: boolean;
      resolvedRelativePath?: string;
      resolutionMethod?: string;
      reason?: string;
    };
    const rels: Rel[] = analysis.relationships.filter(
      (r: Rel) => r.importerRelativePath === "apps/web/src/main.ts",
    );
    const by = (raw: string) => rels.find((r) => r.rawImport === raw);

    expect(by("@/lib/util")).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "apps/web/src/lib/util.ts",
      resolutionMethod: "alias:@/* via apps/web/tsconfig.json; extension:.ts",
    });
    expect(by("@/types")).toMatchObject({
      status: "confirmed",
      typeOnly: true,
      resolvedRelativePath: "apps/web/src/types.ts",
    });
    expect(by("@/components/View.js")).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "apps/web/src/components/View.tsx",
      resolutionMethod: "alias:@/* via apps/web/tsconfig.json; nodenext:.js->.tsx",
    });
    expect(by("@app")).toMatchObject({ status: "confirmed", resolvedRelativePath: "apps/web/src/local.ts" });
    expect(by("#env")).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "apps/web/src/env.ts",
      resolutionMethod: expect.stringMatching(/^package-imports:#env via apps\/web\/package\.json/),
    });
    expect(by("@acme/ui")).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "packages/ui/src/index.ts",
      resolutionMethod: expect.stringMatching(/^workspace:@acme\/ui via packages\/ui\/package\.json/),
    });
    // baseUrl is apps/web: "lib/util" is not under it, so (as in TypeScript)
    // lookup continues to packages — external, never guessed into src/.
    expect(by("lib/util")?.status).toBe("external");
    expect(by("src/lib/util")).toMatchObject({
      status: "confirmed",
      resolvedRelativePath: "apps/web/src/lib/util.ts",
      resolutionMethod: "baseUrl via apps/web/tsconfig.json; extension:.ts",
    });
    expect(by("./local")).toMatchObject({ status: "confirmed", resolutionMethod: "extension:.ts" });

    // Never invented: missing, case mismatch, not-exported, external.
    expect(by("@/missing")).toMatchObject({ status: "unresolved" });
    expect(by("@/missing")?.resolvedRelativePath).toBeUndefined();
    expect(by("@/lib/case")).toMatchObject({
      status: "unresolved",
      reason: expect.stringMatching(/letter case/),
    });
    expect(by("@acme/ui/src/internal")).toMatchObject({
      status: "unresolved",
      reason: expect.stringMatching(/not exported/),
    });
    expect(by("react")?.status).toBe("external");

    expect(analysis.resolutionConfig.aliasScopes).toEqual([
      {
        dir: "apps/web",
        configFile: "apps/web/tsconfig.json",
        baseUrl: "apps/web",
        patterns: ["@/*", "@app"],
        ambiguous: null,
      },
      {
        dir: "packages/ui",
        configFile: "packages/ui/tsconfig.json",
        baseUrl: null,
        patterns: [],
        ambiguous: null,
      },
    ]);
    expect(analysis.resolutionConfig.packages.map((p: { name: string }) => p.name)).toEqual([
      "web",
      "@acme/ui",
    ]);
    expect(analysis.resolutionConfig.diagnostics).toEqual([
      {
        file: "packages/ui/tsconfig.json",
        message: expect.stringMatching(
          /"@tsconfig\/strictest\/tsconfig\.json" refers to a package.*unsupported/,
        ),
      },
    ]);
  });

  it("builds graph edges only from confirmed targets that exist in the scan", async () => {
    const res = await request(app).get(`/api/scans/${scanId}/graph`).set("Cookie", user.cookie);
    expect(res.status).toBe(200);
    const edges: { from: string; to: string }[] = res.body.graph.edges;
    expect(edges.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual(
      [
        "apps/web/src/main.ts -> apps/web/src/components/View.tsx",
        "apps/web/src/main.ts -> apps/web/src/env.ts",
        "apps/web/src/main.ts -> apps/web/src/lib/util.ts",
        "apps/web/src/main.ts -> apps/web/src/local.ts",
        "apps/web/src/main.ts -> apps/web/src/types.ts",
        "apps/web/src/main.ts -> packages/ui/src/index.ts",
      ].sort(),
    );
    expect(res.body.graph.validationErrors).toEqual([]);
  });

  it("leaves the source project byte-for-byte unchanged", async () => {
    expect(await snapshotFixture(fixtureRoot)).toEqual(before);
  });
});
