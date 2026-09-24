import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { connectDB, disconnectDB } from "../../config/database.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";
import { Project } from "../../models/Project.js";
import { Requirement } from "../../models/Requirement.js";
import { Scan } from "../../models/Scan.js";
import { Analysis } from "../../models/Analysis.js";
import { Plan } from "../../models/Plan.js";
import { Task } from "../../models/Task.js";
import { createTestProject, registerTestUser, type RegisteredTestUser } from "../../__tests__/testHelpers.js";
import { AIProviderError, getAIProvider } from "../../services/ai/index.js";

// Same seam as plan.integration.test.ts — no running Ollama needed.
vi.mock("../../services/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/ai/index.js")>();
  return { ...actual, getAIProvider: vi.fn() };
});

let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const scratchBase = path.join(os.tmpdir(), `devflow-plan-grounding-${randomUUID()}`);

const FIXTURE_FILES: Record<string, string> = {
  "src/index.ts": [
    `import { util } from "./util.js";`,
    `import express from "express";`,
    `import { gone } from "./missing.js";`,
    `import styles from "./styles.css";`,
  ].join("\n"),
  "src/util.ts": `export const util = 1;\n`,
  "src/styles.css": `body {}\n`,
};

function planJson(affectedFiles: unknown[]) {
  return JSON.stringify({
    title: "Add caching",
    summary: "Cache util results.",
    suggestedTasks: [
      {
        tempId: "t1",
        title: "Wrap util in a cache",
        dependsOn: [],
        rationale: "src/index.ts imports src/util.ts (confirmed).",
        affectedFiles,
      },
      { tempId: "t2", title: "Add tests", dependsOn: ["t1"] },
    ],
  });
}

const prompts: string[] = [];
function mockProviderReturning(raw: string) {
  const complete = vi.fn((prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve(raw);
  });
  vi.mocked(getAIProvider).mockReturnValue({
    complete,
    checkAvailability: vi.fn(() => Promise.resolve(true)),
  });
  return complete;
}

describe.skipIf(!dbAvailable)("Scan-grounded plan generation (real MongoDB, mocked AI provider)", () => {
  const app = createApp();
  const createdEmails: string[] = [];
  let userA: RegisteredTestUser;
  let userB: RegisteredTestUser;
  let projectId: string;
  let otherProjectId: string;
  let requirementId: string;
  let scanId: string;
  let analysisId: string;
  let unanalyzedScanId: string;
  let fixtureRoot: string;
  let before: Record<string, string>;

  async function snapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const rel of Object.keys(FIXTURE_FILES)) {
      const abs = path.join(fixtureRoot, ...rel.split("/"));
      out[rel] = `${(await fs.stat(abs)).mtimeMs}:${await fs.readFile(abs, "utf-8")}`;
    }
    return out;
  }

  function generate(body: Record<string, unknown>, cookie = userA.cookie, project = projectId) {
    return request(app).post(`/api/projects/${project}/plans/generate`).set("Cookie", cookie).send(body);
  }

  beforeAll(async () => {
    userA = await registerTestUser(app);
    userB = await registerTestUser(app);
    createdEmails.push(userA.email, userB.email);
    projectId = await createTestProject(app, userA.cookie, { name: "Grounded Plan Project" });
    otherProjectId = await createTestProject(app, userA.cookie, { name: "Other Project" });

    const reqRes = await request(app)
      .post(`/api/projects/${projectId}/requirements`)
      .set("Cookie", userA.cookie)
      .send({ title: "Add caching" })
      .expect(201);
    requirementId = reqRes.body.requirement._id;

    fixtureRoot = path.join(scratchBase, "fixture");
    for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
      const abs = path.join(fixtureRoot, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    before = await snapshot();

    await request(app)
      .put(`/api/projects/${projectId}/source`)
      .set("Cookie", userA.cookie)
      .send({ path: fixtureRoot })
      .expect(200);
    unanalyzedScanId = (
      await request(app).post(`/api/projects/${projectId}/scans`).set("Cookie", userA.cookie).expect(201)
    ).body.scan._id;
    scanId = (
      await request(app).post(`/api/projects/${projectId}/scans`).set("Cookie", userA.cookie).expect(201)
    ).body.scan._id;
    analysisId = (
      await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", userA.cookie).expect(201)
    ).body.analysis._id;
  });

  beforeEach(() => {
    prompts.length = 0;
    vi.mocked(getAIProvider).mockReset();
  });

  afterAll(async () => {
    const owners = [userA.userId, userB.userId];
    await Plan.deleteMany({ owner: { $in: owners } });
    await Task.deleteMany({ owner: { $in: owners } });
    await Analysis.deleteMany({ owner: { $in: owners } });
    await Scan.deleteMany({ owner: { $in: owners } });
    await Requirement.deleteMany({ owner: { $in: owners } });
    await Project.deleteMany({ owner: { $in: owners } });
    await User.deleteMany({ email: { $in: createdEmails } });
    await fs.rm(scratchBase, { recursive: true, force: true });
    await disconnectDB();
  });

  it("grounds the prompt in the scan's verified evidence, keeping categories distinct", async () => {
    mockProviderReturning(planJson([]));
    await generate({ requirementId, scanId }).expect(201);

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain(`scan ${scanId}, dependency analysis ${analysisId}`);
    expect(prompt).toContain("- src/index.ts -> src/util.ts:1\n");
    expect(prompt).toMatch(
      /Unresolved imports — NOT confirmed dependencies \(1\):\n- src\/index\.ts: "\.\/missing\.js"/,
    );
    expect(prompt).toContain("- express (1 file)");
    expect(prompt).toMatch(
      /Unsupported import syntax — not analyzed \(1\):\n- src\/index\.ts: "\.\/styles\.css"/,
    );
    expect(prompt).toContain("Import cycles: none found");
    // Unresolved/unsupported specifiers never appear as a confirmed edge line.
    expect(prompt).not.toMatch(/-> .*missing/);
    expect(prompt).not.toContain(scratchBase);
  });

  it("persists sourceContext and server-classified affected-file evidence", async () => {
    mockProviderReturning(
      planJson([
        { path: "src/util.ts", reason: "add cache" },
        { path: "src/cache.ts", reason: "new module", evidence: "in_scan" },
        { path: "./src\\index.ts" },
      ]),
    );
    const res = await generate({ requirementId, scanId }).expect(201);
    const { plan } = res.body;

    expect(plan.status).toBe("needs_review");
    expect(plan.sourceContext).toMatchObject({
      scan: scanId,
      analysis: analysisId,
      contextVersion: 2,
      truncated: false,
      counts: { files: 3, graphNodes: 2, confirmedEdges: 1, unresolved: 1, external: 1, unsupported: 1 },
    });
    const [task] = plan.suggestedTasks;
    expect(task.rationale).toContain("confirmed");
    expect(task.affectedFiles).toEqual([
      {
        path: "src/util.ts",
        reason: "add cache",
        evidence: "in_scan",
        dependentsCount: 1,
        dependenciesCount: 0,
      },
      // The AI's own "in_scan" claim was ignored — the file isn't in the scan.
      { path: "src/cache.ts", reason: "new module", evidence: "not_in_scan" },
      { path: "src/index.ts", reason: "", evidence: "in_scan", dependentsCount: 0, dependenciesCount: 1 },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(scratchBase);

    const stored = await Plan.findById(plan._id);
    expect(stored?.sourceContext?.scan.toString()).toBe(scanId);
  });

  it("marks files unverified and stores no sourceContext when no scan is given (pre-C5 behavior)", async () => {
    mockProviderReturning(planJson([{ path: "src/util.ts" }]));
    const res = await generate({ requirementId }).expect(201);
    expect(res.body.plan.sourceContext).toBeNull();
    expect(res.body.plan.suggestedTasks[0].affectedFiles[0].evidence).toBe("unverified");
    expect(prompts[0]).toContain("No scan of the codebase was provided");
  });

  it("rejects an AI plan with an unsafe file path (422) and persists nothing", async () => {
    mockProviderReturning(planJson([{ path: "../../etc/passwd" }]));
    const count = await Plan.countDocuments({ project: projectId });
    const res = await generate({ requirementId, scanId });
    expect(res.status).toBe(422);
    expect(await Plan.countDocuments({ project: projectId })).toBe(count);
  });

  it("requires an analysis for the scan (409) without calling the AI", async () => {
    const complete = mockProviderReturning(planJson([]));
    const res = await generate({ requirementId, scanId: unanalyzedScanId });
    expect(res.status).toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/analysis/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a scan from another project (404) and another user's scan (404)", async () => {
    const complete = mockProviderReturning(planJson([]));
    const otherReq = await request(app)
      .post(`/api/projects/${otherProjectId}/requirements`)
      .set("Cookie", userA.cookie)
      .send({ title: "Other" })
      .expect(201);
    const crossProject = await generate(
      { requirementId: otherReq.body.requirement._id, scanId },
      userA.cookie,
      otherProjectId,
    );
    expect(crossProject.status).toBe(404);

    const userBProject = await createTestProject(app, userB.cookie, { name: "B" });
    const userBReq = await request(app)
      .post(`/api/projects/${userBProject}/requirements`)
      .set("Cookie", userB.cookie)
      .send({ title: "B req" })
      .expect(201);
    const crossUser = await generate(
      { requirementId: userBReq.body.requirement._id, scanId },
      userB.cookie,
      userBProject,
    );
    expect(crossUser.status).toBe(404);
    expect(complete).not.toHaveBeenCalled();
  });

  it("maps a context overflow to 422 with a clear message and persists nothing", async () => {
    vi.mocked(getAIProvider).mockReturnValue({
      complete: vi.fn(() => Promise.reject(new AIProviderError("too big", "context_overflow"))),
      checkAvailability: vi.fn(() => Promise.resolve(true)),
    });
    const count = await Plan.countDocuments({ project: projectId });
    const res = await generate({ requirementId, scanId });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/OLLAMA_NUM_CTX/);
    expect(await Plan.countDocuments({ project: projectId })).toBe(count);
  });

  it("rejects a malformed scanId (400)", async () => {
    mockProviderReturning(planJson([]));
    const res = await generate({ requirementId, scanId: "not-an-id" });
    expect(res.status).toBe(400);
  });

  it("re-checks edited affected files against the plan's own scan — an edit cannot forge evidence", async () => {
    mockProviderReturning(planJson([{ path: "src/util.ts" }]));
    const planId = (await generate({ requirementId, scanId }).expect(201)).body.plan._id;

    const res = await request(app)
      .patch(`/api/plans/${planId}`)
      .set("Cookie", userA.cookie)
      .send({
        suggestedTasks: [
          {
            tempId: "t1",
            title: "Edited",
            dependsOn: [],
            affectedFiles: [
              { path: "src/made-up.ts", evidence: "in_scan" },
              { path: "src/util.ts", reason: "still here" },
            ],
          },
        ],
      })
      .expect(200);
    expect(
      res.body.plan.suggestedTasks[0].affectedFiles.map((f: { evidence: string }) => f.evidence),
    ).toEqual(["not_in_scan", "in_scan"]);
  });

  it("keeps the existing review flow: a grounded plan can be approved into tasks", async () => {
    mockProviderReturning(planJson([{ path: "src/util.ts" }]));
    const planId = (await generate({ requirementId, scanId }).expect(201)).body.plan._id;
    const res = await request(app)
      .post(`/api/plans/${planId}/approve`)
      .set("Cookie", userA.cookie)
      .expect(200);
    expect(res.body.plan.status).toBe("approved");
    expect(res.body.createdTasks).toHaveLength(2);
  });

  it("never modifies the scanned source project", async () => {
    expect(await snapshot()).toEqual(before);
    expect((await fs.readdir(path.join(fixtureRoot, "src"))).sort()).toEqual([
      "index.ts",
      "styles.css",
      "util.ts",
    ]);
  });
});
