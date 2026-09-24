import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectDB, disconnectDB } from "../../config/database.js";
import { env } from "../../config/env.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";
import { Project } from "../../models/Project.js";
import { Requirement } from "../../models/Requirement.js";
import { Scan } from "../../models/Scan.js";
import { Analysis } from "../../models/Analysis.js";
import { Plan } from "../../models/Plan.js";
import { createTestProject, registerTestUser, type RegisteredTestUser } from "../../__tests__/testHelpers.js";
import { getAIProvider } from "../../services/ai/index.js";
import { estimatePromptTokens, maxPromptTokens } from "../../services/ai/ollamaProvider.js";
import { FIT_SAFETY_MARGIN_TOKENS } from "../../lib/contextFitting.js";

// Stage 12 (ADR-027) through the real API: a project large enough that the
// full grounded context exceeds the default budget. Mocked AI only.
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

const scratchBase = path.join(os.tmpdir(), `devflow-fitting-${randomUUID()}`);
const N = 600;
const fileName = (i: number) => `src/mod${i % 20}/scan${String(i).padStart(4, "0")}.service.ts`;

const PLAN = JSON.stringify({
  title: "Rate limit",
  summary: "s",
  assumptions: ["a"],
  risks: ["r"],
  suggestedTasks: [{ tempId: "t1", title: "Do it", dependsOn: [], affectedFiles: [{ path: fileName(0) }] }],
});

describe.skipIf(!dbAvailable)("Context-budget fitting through the API (real MongoDB, mocked AI)", () => {
  const app = createApp();
  let user: RegisteredTestUser;
  let projectId: string;
  let scanId: string;
  let requirementId: string;
  let root: string;
  let hashBefore: string;

  async function hashTree() {
    const h = createHash("sha256");
    for (let i = 0; i < N; i++) h.update(await fs.readFile(path.join(root, ...fileName(i).split("/"))));
    return h.digest("hex");
  }

  beforeAll(async () => {
    user = await registerTestUser(app);
    projectId = await createTestProject(app, user.cookie, { name: "Big project" });
    root = path.join(scratchBase, "fixture");
    for (let i = 0; i < N; i++) {
      const abs = path.join(root, ...fileName(i).split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const imports = [1, 7, 31].map((k) => {
        const target = fileName((i + k) % N);
        const rel = path.posix.relative(path.posix.dirname(fileName(i)), target).replace(/\.ts$/, ".js");
        return `import "${rel.startsWith(".") ? rel : `./${rel}`}";`;
      });
      await fs.writeFile(
        abs,
        [...imports, `import "pkg-${i % 30}";`, `import "./missing-${i}.js";`, ""].join("\n"),
      );
    }
    hashBefore = await hashTree();
    await request(app)
      .put(`/api/projects/${projectId}/source`)
      .set("Cookie", user.cookie)
      .send({ path: root })
      .expect(200);
    scanId = (
      await request(app).post(`/api/projects/${projectId}/scans`).set("Cookie", user.cookie).expect(201)
    ).body.scan._id;
    await request(app).post(`/api/scans/${scanId}/analysis`).set("Cookie", user.cookie).expect(201);
    requirementId = (
      await request(app)
        .post(`/api/projects/${projectId}/requirements`)
        .set("Cookie", user.cookie)
        .send({ title: "Rate-limit scan service endpoints" })
        .expect(201)
    ).body.requirement._id;
  }, 120_000);

  afterAll(async () => {
    for (const m of [Plan, Analysis, Scan, Requirement, Project] as const) {
      await (m as typeof Plan).deleteMany({ owner: user.userId });
    }
    await User.deleteMany({ email: user.email });
    await fs.rm(scratchBase, { recursive: true, force: true });
    await disconnectDB();
  });

  it("fits a large project into the budget, reports what was reduced, and keeps totals exact", async () => {
    const prompts: string[] = [];
    vi.mocked(getAIProvider).mockReturnValue({
      complete: vi.fn((p: string) => {
        prompts.push(p);
        return Promise.resolve(PLAN);
      }),
      checkAvailability: vi.fn(() => Promise.resolve(true)),
    });
    const plan = (
      await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", user.cookie)
        .send({ requirementId, scanId })
        .expect(201)
    ).body.plan;

    const budget = maxPromptTokens(env.OLLAMA_NUM_CTX) - FIT_SAFETY_MARGIN_TOKENS;
    const fitting = plan.sourceContext.fitting;
    expect(fitting.budgetTokens).toBe(budget);
    expect(fitting.estimatedTokensBefore).toBeGreaterThan(budget);
    expect(fitting.estimatedTokensAfter).toBeLessThanOrEqual(budget);
    expect(fitting.steps.length).toBeGreaterThan(0);
    // The prompt the AI actually received is the fitted one, within budget.
    expect(prompts).toHaveLength(1);
    expect(estimatePromptTokens(prompts[0]!)).toBe(fitting.estimatedTokensAfter);
    expect(prompts[0]).toContain("CONTEXT REDUCED TO FIT THE MODEL'S BUDGET:");

    // Totals are the real graph's, not the shortened lists'.
    const graph = (
      await request(app).get(`/api/scans/${scanId}/graph`).set("Cookie", user.cookie).expect(200)
    ).body.graph;
    expect(plan.sourceContext.counts.confirmedEdges).toBe(graph.edges.length);
    expect(plan.sourceContext.counts.unresolved).toBe(graph.unresolved.length);
    expect(plan.sourceContext.counts.external).toBe(graph.external.length);
    expect(plan.sourceContext.truncated).toBe(true);
    const edges = fitting.reductions.find((r: { section: string }) => r.section === "confirmed dependencies");
    if (edges) expect(edges.total).toBe(graph.edges.length);
    // Labels are still server-verified regardless of what was listed.
    expect(plan.suggestedTasks[0].affectedFiles[0]).toMatchObject({ path: fileName(0), evidence: "in_scan" });
    expect(await hashTree()).toBe(hashBefore);
  }, 60_000);

  it("refuses with 422 — before any AI call — when even the minimum safe context cannot fit", async () => {
    const complete = vi.fn(() => Promise.resolve(PLAN));
    vi.mocked(getAIProvider).mockReturnValue({
      complete,
      checkAvailability: vi.fn(() => Promise.resolve(true)),
    });
    const original = env.OLLAMA_NUM_CTX;
    // Below the validated minimum on purpose: leaves almost no prompt budget.
    (env as { OLLAMA_NUM_CTX: number }).OLLAMA_NUM_CTX = 4400;
    try {
      const plansBefore = await Plan.countDocuments({ project: projectId });
      const res = await request(app)
        .post(`/api/projects/${projectId}/plans/generate`)
        .set("Cookie", user.cookie)
        .send({ requirementId, scanId });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/smallest safe planning context/);
      expect(res.body.error.message).toMatch(/OLLAMA_NUM_CTX=4400/);
      expect(complete).not.toHaveBeenCalled();
      expect(await Plan.countDocuments({ project: projectId })).toBe(plansBefore);
    } finally {
      (env as { OLLAMA_NUM_CTX: number }).OLLAMA_NUM_CTX = original;
    }
  }, 60_000);
});
