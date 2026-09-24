import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
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
import { getAIProvider } from "../../services/ai/index.js";

// Stage 2: one deterministic, end-to-end walk through the whole workflow
// on a fixture containing EVERY relationship category, with database
// assertions after each step and an independent recomputation of every
// server label. Mocked AI only — real Ollama is validated separately.
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

const scratchBase = path.join(os.tmpdir(), `devflow-lifecycle-e2e-${randomUUID()}`);

// Expected, hand-checked (importer -> imported):
//   confirmed:   app -> items.routes (NodeNext .js->.ts), items.routes -> items.service,
//                items.service -> lib/a, lib/a -> lib/b, lib/b -> lib/a (a real cycle),
//                items.service.test -> items.service
//   external:    app: "express"
//   unresolved:  app: "./missing.js" (no candidate), app: "./dual.js" (ambiguous: dual.js + dual.ts)
//   unsupported: app: "@/alias" (alias), app: "./styles.css" (asset extension)
//   parse error: src/broken.ts
const FIXTURE: Record<string, string> = {
  "src/app.ts": [
    `import { router } from "./routes/items.routes.js";`,
    `import express from "express";`,
    `import { gone } from "./missing.js";`,
    `import { alias } from "@/alias";`,
    `import { dual } from "./dual.js";`,
    `import "./styles.css";`,
    `// import { commented } from "./commented.js";`,
  ].join("\n"),
  "src/routes/items.routes.ts": `import { listItems } from "../services/items.service.js";\nexport const router = listItems;\n`,
  "src/services/items.service.ts": `import { a } from "../lib/a.js";\nexport const listItems = () => a;\n`,
  "src/lib/a.ts": `import { b } from "./b.js";\nexport const a = () => b;\n`,
  "src/lib/b.ts": `import { a } from "./a.js";\nexport const b = () => a;\n`,
  "src/dual.ts": `export const dual = 1;\n`,
  "src/dual.js": `export const dual = 2;\n`,
  "src/styles.css": `body {}\n`,
  "src/broken.ts": `import { from "./nowhere;;; @#$%`,
  "src/services/__tests__/items.service.test.ts": `import { listItems } from "../items.service.js";\nlistItems();\n`,
  // Exists on disk, but inside an ignored directory the scanner never reads (Stage 5).
  "node_modules/express/index.js": `module.exports = {};\n`,
};

async function hashFixture(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of Object.keys(FIXTURE).sort()) {
    const abs = path.join(root, ...rel.split("/"));
    const st = await fs.stat(abs);
    out[rel] = `${createHash("sha256")
      .update(await fs.readFile(abs))
      .digest("hex")}:${st.mtimeMs}`;
  }
  return out;
}

const AI_PLAN = {
  title: "List items with caching",
  summary: "Add caching to item listing.",
  assumptions: ["Items change rarely"],
  risks: ["Stale cache"],
  suggestedTasks: [
    {
      tempId: "t1",
      title: "Add cache to items service",
      dependsOn: [],
      // An UNCONFIRMED dependency claim in prose (app does not import lib/b):
      rationale: "src/app.ts imports src/lib/b.ts, so caching there is safe.",
      testingApproach: "Extend the items service unit test",
      affectedFiles: [
        { path: "src/services/items.service.ts", change: "modify", reason: "add cache" },
        { path: "src/services/cache.ts", change: "create", reason: "new cache module", evidence: "in_scan" },
        { path: "src/services/__tests__/items.service.test.ts", change: "test" },
      ],
    },
    {
      tempId: "t2",
      title: "Wire cache invalidation",
      dependsOn: ["t1"],
      affectedFiles: [
        { path: "src/routes/items.routes.ts", change: "modify" },
        { path: "src/lib/b.ts", change: "create" },
        { path: "src/middleware/cache.middleware.ts", change: "reference" },
        { path: "src/dual.ts" },
      ],
    },
    {
      tempId: "t3",
      title: "Document caching",
      dependsOn: ["t2"],
      // A REAL file the scan could not see: must be "unverified", never "not in scan".
      affectedFiles: [{ path: "node_modules/express/index.js", change: "reference" }],
    },
  ],
};

describe.skipIf(!dbAvailable)("Plan lifecycle end-to-end (real MongoDB, mocked AI)", () => {
  const app = createApp();
  const emails: string[] = [];
  let user: RegisteredTestUser;
  let other: RegisteredTestUser;
  let projectId: string;
  let fixtureRoot: string;
  let hashesBefore: Record<string, string>;

  beforeAll(async () => {
    user = await registerTestUser(app);
    other = await registerTestUser(app);
    emails.push(user.email, other.email);
    projectId = await createTestProject(app, user.cookie, { name: "Lifecycle E2E" });
    fixtureRoot = path.join(scratchBase, "fixture");
    for (const [rel, content] of Object.entries(FIXTURE)) {
      const abs = path.join(fixtureRoot, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    hashesBefore = await hashFixture(fixtureRoot);
  });

  afterAll(async () => {
    const owners = [user.userId, other.userId];
    for (const m of [Plan, Task, Analysis, Scan, Requirement, Project] as const) {
      await (m as typeof Plan).deleteMany({ owner: { $in: owners } });
    }
    await User.deleteMany({ email: { $in: emails } });
    await fs.rm(scratchBase, { recursive: true, force: true });
    await disconnectDB();
  });

  it("runs scan → analysis → graph → generate → review → edit → approve → task edit with evidence intact", async () => {
    const as = (req: request.Test) => req.set("Cookie", user.cookie);

    // 1–5. Configure, scan, analyse.
    await as(request(app).put(`/api/projects/${projectId}/source`))
      .send({ path: fixtureRoot })
      .expect(200);
    const scan = (await as(request(app).post(`/api/projects/${projectId}/scans`)).expect(201)).body.scan;
    const analysis = (await as(request(app).post(`/api/scans/${scan._id}/analysis`)).expect(201)).body
      .analysis;

    // 6. Canonical graph: exactly the hand-checked edges, every other category separate.
    const graph = (await as(request(app).get(`/api/scans/${scan._id}/graph`)).expect(200)).body.graph;
    expect(graph.edges.map((e: { from: string; to: string }) => `${e.from} -> ${e.to}`).sort()).toEqual([
      "src/app.ts -> src/routes/items.routes.ts",
      "src/lib/a.ts -> src/lib/b.ts",
      "src/lib/b.ts -> src/lib/a.ts",
      "src/routes/items.routes.ts -> src/services/items.service.ts",
      "src/services/__tests__/items.service.test.ts -> src/services/items.service.ts",
      "src/services/items.service.ts -> src/lib/a.ts",
    ]);
    const raws = (list: { rawImport: string }[]) => list.map((r) => r.rawImport).sort();
    expect(raws(graph.external)).toEqual(["express"]);
    expect(raws(graph.unresolved)).toEqual(["./dual.js", "./missing.js"]);
    expect(graph.unresolved.find((r: { rawImport: string }) => r.rawImport === "./dual.js").reason).toMatch(
      /ambiguous/i,
    );
    expect(raws(graph.unsupported)).toEqual(["./styles.css", "@/alias"]);
    expect(graph.parseErrors.map((r: { importerRelativePath: string }) => r.importerRelativePath)).toEqual([
      "src/broken.ts",
    ]);
    expect(graph.isAcyclic).toBe(false);
    // The commented-out import was never extracted.
    expect(JSON.stringify(graph)).not.toContain("commented");

    const counts = async () => ({
      scans: await Scan.countDocuments({ project: projectId }),
      analyses: await Analysis.countDocuments({ scan: scan._id }),
    });
    const countsAfterAnalysis = await counts();

    // 7. Generate a grounded plan (mocked AI).
    const complete = vi.fn(() => Promise.resolve(JSON.stringify(AI_PLAN)));
    vi.mocked(getAIProvider).mockReturnValue({
      complete,
      checkAvailability: vi.fn(() => Promise.resolve(true)),
    });
    const requirement = (
      await as(request(app).post(`/api/projects/${projectId}/requirements`))
        .send({ title: "Cache item listing" })
        .expect(201)
    ).body.requirement;
    const generated = (
      await as(request(app).post(`/api/projects/${projectId}/plans/generate`))
        .send({ requirementId: requirement._id, scanId: scan._id })
        .expect(201)
    ).body.plan;
    expect(complete).toHaveBeenCalledTimes(1);

    // 8. Independent recomputation of EVERY server label from the scan + graph APIs.
    const scanItems = (await as(request(app).get(`/api/scans/${scan._id}`)).expect(200)).body.scan.items as {
      relativePath: string;
      skipReason?: string;
    }[];
    const inventory = new Set(scanItems.filter((i) => i.skipReason !== "symlink").map((i) => i.relativePath));
    const nodeIds = new Set(graph.nodes.map((n: { id: string }) => n.id));
    const unreadDirs = (scanItems as { relativePath: string; type?: string; status?: string }[])
      .filter((i) => i.type === "directory" && i.status !== "scanned")
      .map((i) => i.relativePath);
    const expectedFile = (f: { path: string; change?: string }) => {
      if (!inventory.has(f.path) && unreadDirs.some((d) => f.path.startsWith(`${d}/`))) {
        return { evidence: "unverified", evidenceNote: expect.stringContaining("ignored directory") };
      }
      const evidence = inventory.has(f.path) ? "in_scan" : "not_in_scan";
      const isNode = nodeIds.has(f.path);
      const conflict =
        evidence === "not_in_scan" && (f.change === "modify" || f.change === "reference")
          ? `Claimed "${f.change}", but this path is not in the scan`
          : evidence === "in_scan" && f.change === "create"
            ? 'Claimed "create", but this file already exists in the scan'
            : undefined;
      return {
        evidence,
        ...(isNode
          ? {
              dependentsCount: graph.edges.filter((e: { to: string }) => e.to === f.path).length,
              dependenciesCount: graph.edges.filter((e: { from: string }) => e.from === f.path).length,
            }
          : {}),
        ...(conflict ? { conflict } : {}),
      };
    };
    let checkedFiles = 0;
    for (const task of generated.suggestedTasks) {
      const aiTask = AI_PLAN.suggestedTasks.find((t) => t.tempId === task.tempId)!;
      expect(task.affectedFiles).toHaveLength(aiTask.affectedFiles.length);
      for (const [i, file] of task.affectedFiles.entries()) {
        expect(file).toMatchObject(expectedFile(aiTask.affectedFiles[i]!));
        if (!("change" in aiTask.affectedFiles[i]!)) expect(file).not.toHaveProperty("change");
        checkedFiles += 1;
      }
    }
    expect(checkedFiles).toBe(8);
    // No false conflict on the unread file, even though it claimed "reference".
    expect(generated.suggestedTasks[2].affectedFiles[0]).not.toHaveProperty("conflict");
    expect(generated.sourceContext.coverage).toEqual({
      stoppedEarly: [],
      unreadDirectories: 1,
      ignoredDirectories: 1,
    });
    // Spot-check the interesting cases explicitly too.
    const [t1, t2] = generated.suggestedTasks;
    expect(t1.affectedFiles[1]).toMatchObject({ path: "src/services/cache.ts", evidence: "not_in_scan" });
    expect(t2.affectedFiles[1].conflict).toMatch(/already exists/);
    expect(t2.affectedFiles[2]).toMatchObject({
      evidence: "not_in_scan",
      conflict: expect.stringMatching(/not in the scan/),
    });
    expect(t2.affectedFiles[3]).toEqual({
      path: "src/dual.ts",
      reason: "",
      evidence: "in_scan",
      dependentsCount: 0,
      dependenciesCount: 0,
    });

    // The prose claim "app imports lib/b" stays prose: no edge, no evidence created.
    expect(t1.rationale).toContain("src/app.ts imports src/lib/b.ts");
    const graphAfter = (await as(request(app).get(`/api/scans/${scan._id}/graph`)).expect(200)).body.graph;
    expect(graphAfter.edges).toEqual(graph.edges);

    // sourceContext pins the exact scan + analysis.
    expect(generated.sourceContext).toMatchObject({
      scan: scan._id,
      analysis: analysis._id,
      counts: { confirmedEdges: 6, unresolved: 2, external: 1, unsupported: 2, parseErrors: 1, cycles: 1 },
    });

    // 9–10. Review, then edit allowed metadata.
    const snapshot = { suggestedTasks: generated.suggestedTasks, sourceContext: generated.sourceContext };
    const reviewed = (await as(request(app).get(`/api/plans/${generated._id}`)).expect(200)).body.plan;
    expect({ suggestedTasks: reviewed.suggestedTasks, sourceContext: reviewed.sourceContext }).toEqual(
      snapshot,
    );
    await as(request(app).patch(`/api/plans/${generated._id}`))
      .send({ title: "Reviewed title" })
      .expect(200);
    const dbAfterEdit = await Plan.findById(generated._id).lean();
    expect(dbAfterEdit?.title).toBe("Reviewed title");
    expect(JSON.parse(JSON.stringify(dbAfterEdit?.suggestedTasks))).toEqual(snapshot.suggestedTasks);

    // Another user can't see or approve it.
    await request(app).get(`/api/plans/${generated._id}`).set("Cookie", other.cookie).expect(404);
    await request(app).post(`/api/plans/${generated._id}/approve`).set("Cookie", other.cookie).expect(404);

    // 11–12. Approve and re-read.
    const approval = (await as(request(app).post(`/api/plans/${generated._id}/approve`)).expect(200)).body;
    expect(approval.createdTasks).toHaveLength(3);
    const approvedPlan = (await as(request(app).get(`/api/plans/${generated._id}`)).expect(200)).body.plan;
    expect(approvedPlan.status).toBe("approved");
    expect({
      suggestedTasks: approvedPlan.suggestedTasks,
      sourceContext: approvedPlan.sourceContext,
    }).toEqual(snapshot);

    // Each task maps to the RIGHT plan task (no array mix-ups) with identical evidence.
    const tasksDb = await Task.find({ "planEvidence.plan": generated._id }).lean();
    expect(tasksDb).toHaveLength(3);
    for (const task of tasksDb) {
      const source = snapshot.suggestedTasks.find(
        (s: { tempId: string }) => s.tempId === task.planEvidence!.tempId,
      );
      expect(task.title).toBe(source.title);
      expect(JSON.parse(JSON.stringify(task.planEvidence!.affectedFiles))).toEqual(source.affectedFiles);
      expect(String(task.planEvidence!.sourceContext!.scan)).toBe(scan._id);
      expect(String(task.planEvidence!.sourceContext!.analysis)).toBe(analysis._id);
    }
    // Dependencies were wired to the right tasks.
    const byTemp = new Map(tasksDb.map((t) => [t.planEvidence!.tempId, t]));
    expect(byTemp.get("t2")!.dependencies.map(String)).toEqual([String(byTemp.get("t1")!._id)]);

    // 13–15. Edit a task through the normal API (as the frontend does) and re-read.
    const t1Task = byTemp.get("t1")!;
    const t1Evidence = JSON.parse(JSON.stringify(t1Task.planEvidence));
    await as(request(app).patch(`/api/tasks/${t1Task._id}`))
      .send({ status: "done", title: "Renamed", planEvidence: { affectedFiles: [] } })
      .expect(200);
    const reread = (await as(request(app).get(`/api/tasks/${t1Task._id}`)).expect(200)).body.task;
    expect(reread).toMatchObject({ status: "done", title: "Renamed" });
    expect(reread.planEvidence).toEqual(t1Evidence);

    // Terminal state rules still hold.
    await as(request(app).post(`/api/plans/${generated._id}/approve`)).expect(409);
    await as(request(app).post(`/api/plans/${generated._id}/reject`)).expect(409);
    await as(request(app).patch(`/api/plans/${generated._id}`))
      .send({ title: "late" })
      .expect(409);

    // 16–17. Nothing re-scanned/re-analysed; source byte-identical.
    expect(await counts()).toEqual(countsAfterAnalysis);
    expect(await hashFixture(fixtureRoot)).toEqual(hashesBefore);
  });

  it("impact-aware planning: bounded impact in the prompt, verified relations on files, carried through approval", async () => {
    const as = (req: request.Test) => req.set("Cookie", user.cookie);
    const scan = (await as(request(app).post(`/api/projects/${projectId}/scans`)).expect(201)).body.scan;
    const analysis = (await as(request(app).post(`/api/scans/${scan._id}/analysis`)).expect(201)).body
      .analysis;
    const requirement = (
      await as(request(app).post(`/api/projects/${projectId}/requirements`))
        .send({ title: "Change lib a" })
        .expect(201)
    ).body.requirement;

    const prompts: string[] = [];
    const aiPlan = {
      title: "Change a",
      summary: "Adjust lib/a.",
      assumptions: ["x"],
      risks: ["y"],
      suggestedTasks: [
        {
          tempId: "t1",
          title: "Edit a",
          dependsOn: [],
          affectedFiles: [
            { path: "src/lib/a.ts", change: "modify" },
            { path: "src/lib/b.ts", change: "reference" },
            { path: "src/app.ts", change: "modify", impactRelation: "dependency" },
            { path: "src/dual.ts", change: "reference" },
            { path: "src/new-helper.ts", change: "create" },
          ],
        },
      ],
    };
    const complete = vi.fn((p: string) => {
      prompts.push(p);
      return Promise.resolve(JSON.stringify(aiPlan));
    });
    vi.mocked(getAIProvider).mockReturnValue({
      complete,
      checkAvailability: vi.fn(() => Promise.resolve(true)),
    });

    // Guard rails first: bad target never reaches the AI.
    const gen = (body: Record<string, unknown>) =>
      as(request(app).post(`/api/projects/${projectId}/plans/generate`)).send({
        requirementId: requirement._id,
        ...body,
      });
    expect((await gen({ impactFile: "src/lib/a.ts" })).status).toBe(400); // needs scanId
    expect((await gen({ scanId: scan._id, impactFile: "../escape.ts" })).status).toBe(400);
    expect((await gen({ scanId: scan._id, impactFile: "src/lib/nope.ts" })).status).toBe(404);
    expect((await gen({ scanId: scan._id, impactFile: "src/lib" })).status).toBe(404);
    expect(complete).not.toHaveBeenCalled();

    const plan = (await gen({ scanId: scan._id, impactFile: "src/lib/a.ts" }).expect(201)).body.plan;
    const prompt = prompts[0]!;
    expect(prompt).toContain("CHANGE IMPACT for src/lib/a.ts");
    expect(prompt).toContain(
      "Imported directly by (MAY be affected) (2): src/lib/b.ts:1, src/services/items.service.ts:1",
    );
    expect(prompt).toContain("src/routes/items.routes.ts (2 hops, via src/services/items.service.ts)");
    expect(prompt).toContain("src/app.ts (3 hops, via src/routes/items.routes.ts)");
    expect(prompt).toContain(
      "Test files among those dependents: src/services/__tests__/items.service.test.ts",
    );
    expect(prompt).toContain("It is part of 1 proven import cycle(s).");
    expect(prompt).toContain('"May be affected" does not mean "must change"');

    // Pinned to the same scan + analysis, with what the model was shown.
    expect(plan.sourceContext).toMatchObject({
      scan: scan._id,
      analysis: analysis._id,
      impact: {
        file: "src/lib/a.ts",
        inGraph: true,
        maxDepth: 6,
        maxNodes: 30,
        directDependencies: 1,
        directDependents: 2,
        transitiveDependentsShown: 3,
        truncated: false,
      },
    });

    // Relations are server-verified; the AI's "dependency" claim for app.ts is ignored.
    const relations = Object.fromEntries(
      plan.suggestedTasks[0].affectedFiles.map((f: { path: string; impactRelation?: string }) => [
        f.path,
        f.impactRelation ?? null,
      ]),
    );
    expect(relations).toEqual({
      "src/lib/a.ts": "target",
      "src/lib/b.ts": "dependency_and_dependent", // a imports b AND b imports a: the cycle
      "src/app.ts": "transitive_dependent",
      "src/dual.ts": null, // in scan, but not related to a within the impact
      "src/new-helper.ts": null, // not in scan: never gets a relation
    });

    // An edit is re-checked against the pinned impact; relations can't be forged.
    const edited = (
      await as(request(app).patch(`/api/plans/${plan._id}`))
        .send({
          suggestedTasks: [
            {
              tempId: "t1",
              title: "Edit a",
              dependsOn: [],
              affectedFiles: [{ path: "src/dual.ts", impactRelation: "target" }],
            },
          ],
        })
        .expect(200)
    ).body.plan;
    expect(edited.suggestedTasks[0].affectedFiles[0]).not.toHaveProperty("impactRelation");

    // Approval carries relations and the target onto the task.
    await as(request(app).patch(`/api/plans/${plan._id}`))
      .send({
        suggestedTasks: [
          { ...aiPlan.suggestedTasks[0], affectedFiles: aiPlan.suggestedTasks[0]!.affectedFiles },
        ],
      })
      .expect(200);
    const approved = (await as(request(app).post(`/api/plans/${plan._id}/approve`)).expect(200)).body;
    const ev = approved.createdTasks[0].planEvidence;
    expect(ev.sourceContext).toMatchObject({
      scan: scan._id,
      analysis: analysis._id,
      impactFile: "src/lib/a.ts",
    });
    expect(ev.affectedFiles.find((f: { path: string }) => f.path === "src/app.ts").impactRelation).toBe(
      "transitive_dependent",
    );
    expect(await hashFixture(fixtureRoot)).toEqual(hashesBefore);
  });

  it("refuses to ground a plan in a failed scan, without calling the AI", async () => {
    const complete = vi.fn(() => Promise.resolve(JSON.stringify(AI_PLAN)));
    vi.mocked(getAIProvider).mockReturnValue({
      complete,
      checkAvailability: vi.fn(() => Promise.resolve(true)),
    });
    const failed = await Scan.create({
      project: projectId,
      owner: user.userId,
      outcome: "failed",
      summary: { totalScanned: 0, totalSkipped: 0, totalErrors: 0, durationMs: 1, limitsReached: [] },
      items: [],
      errorMessage: "Could not read the configured source directory",
    });
    const requirement = (
      await request(app)
        .post(`/api/projects/${projectId}/requirements`)
        .set("Cookie", user.cookie)
        .send({ title: "Anything" })
        .expect(201)
    ).body.requirement;
    const res = await request(app)
      .post(`/api/projects/${projectId}/plans/generate`)
      .set("Cookie", user.cookie)
      .send({ requirementId: requirement._id, scanId: String(failed._id) });
    expect(res.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
    expect(await Plan.countDocuments({ requirement: requirement._id })).toBe(0);
  });
});
