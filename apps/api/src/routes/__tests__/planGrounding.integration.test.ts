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
        { path: "src/cache.ts", reason: "new module", change: "create", evidence: "in_scan" },
        { path: "./src\\index.ts", change: "reference" },
        { path: "src/ghost.ts", change: "modify" },
      ]),
    );
    const res = await generate({ requirementId, scanId }).expect(201);
    const { plan } = res.body;

    expect(plan.status).toBe("needs_review");
    expect(plan.sourceContext).toMatchObject({
      scan: scanId,
      analysis: analysisId,
      contextVersion: 4,
      truncated: false,
      // A small project fits whole: the fitting record is kept, with nothing reduced.
      fitting: { steps: [], reductions: [] },
      counts: { files: 3, graphNodes: 2, confirmedEdges: 1, unresolved: 1, external: 1, unsupported: 1 },
      // Requirement "Add caching" matches no path in this fixture.
      focusTerms: ["cach"],
      focusFiles: [],
    });
    const [task] = plan.suggestedTasks;
    expect(task.rationale).toContain("confirmed");
    expect(task.affectedFiles).toEqual([
      // No intent stated by the AI -> none recorded (not a defaulted "modify").
      {
        path: "src/util.ts",
        reason: "add cache",
        evidence: "in_scan",
        dependentsCount: 1,
        dependenciesCount: 0,
      },
      // The AI's own "in_scan" claim was ignored — the file isn't in the scan.
      { path: "src/cache.ts", reason: "new module", change: "create", evidence: "not_in_scan" },
      {
        path: "src/index.ts",
        reason: "",
        change: "reference",
        evidence: "in_scan",
        dependentsCount: 0,
        dependenciesCount: 1,
      },
      // A claim the scan contradicts is kept but flagged, never "confirmed".
      {
        path: "src/ghost.ts",
        reason: "",
        change: "modify",
        evidence: "not_in_scan",
        conflict: 'Claimed "modify", but this path is not in the scan',
      },
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

  describe("lifecycle races (Stage 1)", () => {
    const approve = (id: string) => request(app).post(`/api/plans/${id}/approve`).set("Cookie", userA.cookie);
    const reject = (id: string) => request(app).post(`/api/plans/${id}/reject`).set("Cookie", userA.cookie);

    it("concurrent approvals create the tasks exactly once", async () => {
      mockProviderReturning(planJson([{ path: "src/util.ts", change: "modify" }]));
      const plan = (await generate({ requirementId, scanId }).expect(201)).body.plan;

      const results = await Promise.all([approve(plan._id), approve(plan._id), approve(plan._id)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      const tasks = await Task.find({ "planEvidence.plan": plan._id });
      expect(tasks).toHaveLength(plan.suggestedTasks.length);
    });

    it("an approval racing a rejection leaves exactly one consistent outcome", async () => {
      mockProviderReturning(planJson([]));
      const plan = (await generate({ requirementId, scanId }).expect(201)).body.plan;

      const [a, r] = await Promise.all([approve(plan._id), reject(plan._id)]);
      expect([a.status, r.status].sort()).toEqual([200, 409]);
      const stored = await Plan.findById(plan._id);
      const tasks = await Task.countDocuments({ "planEvidence.plan": plan._id });
      if (a.status === 200) {
        expect(stored?.status).toBe("approved");
        expect(tasks).toBe(plan.suggestedTasks.length);
      } else {
        expect(stored?.status).toBe("rejected");
        expect(tasks).toBe(0);
      }
    });

    it("survives a failed cleanup: the original error surfaces and a later approval ends with exactly one task set", async () => {
      mockProviderReturning(planJson([{ path: "src/util.ts" }]));
      const plan = (await generate({ requirementId, scanId }).expect(201)).body.plan;
      const realCreate = Task.create.bind(Task);
      let calls = 0;
      const createSpy = vi.spyOn(Task, "create").mockImplementation(((
        ...args: Parameters<typeof Task.create>
      ) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("simulated write failure"));
        return realCreate(...args);
      }) as typeof Task.create);
      // The compensating delete fails too (e.g. the connection dropped). Call 1
      // is approval's leftover sweep; call 2 is the compensation.
      const realDeleteMany = Task.deleteMany.bind(Task);
      let deletes = 0;
      const deleteSpy = vi.spyOn(Task, "deleteMany").mockImplementation(((
        ...args: Parameters<typeof Task.deleteMany>
      ) => {
        deletes += 1;
        if (deletes === 2) return Promise.reject(new Error("cleanup failed"));
        return realDeleteMany(...args);
      }) as unknown as typeof Task.deleteMany);
      try {
        const res = await approve(plan._id);
        expect(res.status).toBe(500);
      } finally {
        createSpy.mockRestore();
        deleteSpy.mockRestore();
      }
      // The claim is still released so the plan can be reviewed again...
      expect((await Plan.findById(plan._id))?.status).toBe("needs_review");
      // ...one orphan from the failed attempt remains for now...
      expect(await Task.countDocuments({ "planEvidence.plan": plan._id })).toBe(1);
      // ...and the next successful approval replaces it rather than duplicating.
      await approve(plan._id).expect(200);
      expect(await Task.countDocuments({ "planEvidence.plan": plan._id })).toBe(plan.suggestedTasks.length);
    });

    it("a failure mid-approval leaves the plan reviewable and no orphan tasks", async () => {
      mockProviderReturning(planJson([{ path: "src/util.ts" }]));
      const plan = (await generate({ requirementId, scanId }).expect(201)).body.plan;
      const realCreate = Task.create.bind(Task);
      let calls = 0;
      const spy = vi.spyOn(Task, "create").mockImplementation(((...args: Parameters<typeof Task.create>) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("simulated write failure"));
        return realCreate(...args);
      }) as typeof Task.create);
      try {
        const res = await approve(plan._id);
        expect(res.status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const stored = await Plan.findById(plan._id);
      expect(stored?.status).toBe("needs_review");
      expect(stored?.reviewedAt).toBeNull();
      expect(await Task.countDocuments({ "planEvidence.plan": plan._id })).toBe(0);
      // ...and it can still be approved normally afterwards.
      await approve(plan._id).expect(200);
      expect(await Task.countDocuments({ "planEvidence.plan": plan._id })).toBe(plan.suggestedTasks.length);
    });

    it("loads a C5-era plan (no change intent stored) without inventing one", async () => {
      const { insertedId: _id } = await Plan.collection.insertOne({
        project: new Plan.base.Types.ObjectId(projectId),
        owner: new Plan.base.Types.ObjectId(userA.userId),
        requirement: new Plan.base.Types.ObjectId(requirementId),
        status: "needs_review",
        title: "Legacy plan",
        summary: "Generated before C5.1",
        assumptions: [],
        risks: [],
        suggestedTasks: [
          {
            tempId: "t1",
            title: "Legacy task",
            description: "",
            acceptanceCriteria: [],
            priority: "medium",
            dependsOn: [],
            rationale: "",
            affectedFiles: [{ path: "src/util.ts", reason: "", evidence: "in_scan", dependentsCount: 1 }],
          },
        ],
        suggestedOrder: ["t1"],
        validation: { valid: true, errors: [] },
        aiMeta: { provider: "ollama", model: "m", generatedAt: new Date(), durationMs: 1 },
        sourceContext: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const loaded = (await request(app).get(`/api/plans/${_id}`).set("Cookie", userA.cookie).expect(200))
        .body.plan;
      const [file] = loaded.suggestedTasks[0].affectedFiles;
      expect(file).not.toHaveProperty("change");
      expect(file).not.toHaveProperty("conflict");
      expect(file.evidence).toBe("in_scan");

      const approved = (await approve(String(_id)).expect(200)).body;
      expect(approved.createdTasks[0].planEvidence.affectedFiles[0]).not.toHaveProperty("change");
    });

    it("stores each task's evidence equal to the plan's, as read back from MongoDB", async () => {
      mockProviderReturning(
        planJson([
          { path: "src/util.ts", change: "modify", reason: "r1" },
          { path: "src/new.ts", change: "create" },
          { path: "src/gone.ts", change: "reference" },
        ]),
      );
      const plan = (await generate({ requirementId, scanId }).expect(201)).body.plan;
      await approve(plan._id).expect(200);

      const storedPlan = await Plan.findById(plan._id).lean();
      const storedTasks = await Task.find({ "planEvidence.plan": plan._id }).lean();
      expect(storedTasks).toHaveLength(storedPlan!.suggestedTasks.length);
      for (const task of storedTasks) {
        const source = storedPlan!.suggestedTasks.find((s) => s.tempId === task.planEvidence!.tempId)!;
        expect(task.planEvidence!.affectedFiles).toEqual(source.affectedFiles);
        expect(task.planEvidence!.rationale).toBe(source.rationale);
        expect(String(task.planEvidence!.sourceContext!.scan)).toBe(String(storedPlan!.sourceContext!.scan));
        expect(String(task.planEvidence!.sourceContext!.analysis)).toBe(
          String(storedPlan!.sourceContext!.analysis),
        );
      }
    });

    it("an edit that loses the race to approval is refused, not applied after the fact", async () => {
      mockProviderReturning(planJson([]));
      const plan = (await generate({ requirementId, scanId }).expect(201)).body.plan;

      const [edit, approval] = await Promise.all([
        request(app)
          .patch(`/api/plans/${plan._id}`)
          .set("Cookie", userA.cookie)
          .send({ title: "Edited during approval" }),
        approve(plan._id),
      ]);
      expect(approval.status).toBe(200);
      const stored = await Plan.findById(plan._id);
      expect(stored?.status).toBe("approved");
      if (edit.status === 200) {
        // The edit won the race: it must have landed BEFORE approval, so the
        // approved tasks were created from the edited plan.
        expect(stored?.title).toBe("Edited during approval");
      } else {
        expect(edit.status).toBe(409);
        expect(stored?.title).toBe(plan.title);
      }
    });
  });

  describe("full lifecycle: generate → review → approve (C5.1)", () => {
    const aiFiles = [
      { path: "src/util.ts", reason: "wrap in cache", change: "modify" },
      { path: "src/cache.ts", reason: "new module", change: "create", evidence: "in_scan" },
      { path: "src/ghost.ts", change: "reference" },
    ];

    async function evidenceCounts() {
      return {
        scans: await Scan.countDocuments({ project: projectId }),
        analyses: await Analysis.countDocuments({ scan: scanId }),
      };
    }

    it("carries server-verified evidence unchanged from generation through review and approval", async () => {
      mockProviderReturning(
        JSON.stringify({
          ...JSON.parse(planJson(aiFiles)),
          suggestedTasks: [
            {
              ...JSON.parse(planJson(aiFiles)).suggestedTasks[0],
              testingApproach: "Unit test next to util",
            },
            { tempId: "t2", title: "Add tests", dependsOn: ["t1"] },
          ],
        }),
      );
      const generated = (await generate({ requirementId, scanId }).expect(201)).body.plan;
      const generatedFiles = generated.suggestedTasks[0].affectedFiles;
      expect(generatedFiles.map((f: { evidence: string }) => f.evidence)).toEqual([
        "in_scan",
        "not_in_scan",
        "not_in_scan",
      ]);
      const countsBefore = await evidenceCounts();

      // Review: the fetched plan is exactly what was generated.
      const reviewed = (
        await request(app).get(`/api/plans/${generated._id}`).set("Cookie", userA.cookie).expect(200)
      ).body.plan;
      expect(reviewed.suggestedTasks).toEqual(generated.suggestedTasks);
      expect(reviewed.sourceContext).toEqual(generated.sourceContext);

      // A metadata-only review edit leaves evidence untouched.
      await request(app)
        .patch(`/api/plans/${generated._id}`)
        .set("Cookie", userA.cookie)
        .send({ title: "Add caching (reviewed)" })
        .expect(200);

      const approved = (
        await request(app).post(`/api/plans/${generated._id}/approve`).set("Cookie", userA.cookie).expect(200)
      ).body;
      expect(approved.plan.status).toBe("approved");
      expect(approved.plan.reviewedAt).not.toBeNull();

      // Each task holds a verbatim copy of its plan task's evidence.
      const t1 = approved.createdTasks.find((t: { title: string }) => t.title === "Wrap util in a cache");
      expect(t1.planEvidence).toEqual({
        plan: generated._id,
        tempId: "t1",
        rationale: generated.suggestedTasks[0].rationale,
        testingApproach: "Unit test next to util",
        affectedFiles: generatedFiles,
        sourceContext: {
          scan: scanId,
          analysis: analysisId,
          contextVersion: generated.sourceContext.contextVersion,
          impactFile: null, // this plan had no impact target
        },
      });
      // The AI's "in_scan" claim for src/cache.ts did not survive anywhere.
      expect(t1.planEvidence.affectedFiles[1]).toMatchObject({
        path: "src/cache.ts",
        evidence: "not_in_scan",
      });
      expect(t1.planEvidence.affectedFiles[2].conflict).toMatch(/not in the scan/);
      const t2 = approved.createdTasks.find((t: { title: string }) => t.title === "Add tests");
      expect(t2.planEvidence).toMatchObject({ tempId: "t2", affectedFiles: [] });

      // The approved plan still has all of it.
      const after = (
        await request(app).get(`/api/plans/${generated._id}`).set("Cookie", userA.cookie).expect(200)
      ).body.plan;
      expect(after.suggestedTasks).toEqual(generated.suggestedTasks);
      expect(after.sourceContext).toEqual(generated.sourceContext);

      // Approval neither re-scanned nor re-analysed.
      expect(await evidenceCounts()).toEqual(countsBefore);

      // Evidence is read-only through the task API.
      const patched = (
        await request(app)
          .patch(`/api/tasks/${t1._id}`)
          .set("Cookie", userA.cookie)
          .send({
            status: "in_progress",
            planEvidence: { affectedFiles: [{ path: "src/cache.ts", evidence: "in_scan" }] },
          })
          .expect(200)
      ).body.task;
      expect(patched.status).toBe("in_progress");
      expect(patched.planEvidence).toEqual(t1.planEvidence);

      // A reviewed plan can't be approved twice or edited afterwards.
      await request(app).post(`/api/plans/${generated._id}/approve`).set("Cookie", userA.cookie).expect(409);
    });

    it("keeps an ungrounded plan's references unverified through approval", async () => {
      mockProviderReturning(planJson([{ path: "src/util.ts", change: "modify" }]));
      const plan = (await generate({ requirementId }).expect(201)).body.plan;
      const approved = (
        await request(app).post(`/api/plans/${plan._id}/approve`).set("Cookie", userA.cookie).expect(200)
      ).body;
      const t1 = approved.createdTasks.find((t: { title: string }) => t.title === "Wrap util in a cache");
      expect(t1.planEvidence.sourceContext).toBeNull();
      expect(t1.planEvidence.affectedFiles).toEqual([
        { path: "src/util.ts", reason: "", change: "modify", evidence: "unverified" },
      ]);
    });

    it("rejection keeps the plan's evidence and creates no tasks", async () => {
      mockProviderReturning(planJson(aiFiles));
      const plan = (await generate({ requirementId, scanId }).expect(201)).body.plan;
      const tasksBefore = await Task.countDocuments({ project: projectId });
      const rejected = (
        await request(app).post(`/api/plans/${plan._id}/reject`).set("Cookie", userA.cookie).expect(200)
      ).body.plan;
      expect(rejected.status).toBe("rejected");
      expect(rejected.suggestedTasks).toEqual(plan.suggestedTasks);
      expect(rejected.sourceContext).toEqual(plan.sourceContext);
      expect(await Task.countDocuments({ project: projectId })).toBe(tasksBefore);
      await request(app).post(`/api/plans/${plan._id}/approve`).set("Cookie", userA.cookie).expect(409);
    });
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
