import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { PRIORITIES } from "./Requirement.js";
import { AFFECTED_FILE_CHANGES } from "../validators/aiPlan.validators.js";
import { IMPACT_RELATIONS } from "../lib/impactAnalysis.js";

// Generation + structural/graph validation happen synchronously, in the
// same request, before anything is persisted (see plan.service.ts) — an
// invalid plan is never saved at all, so there's no stored "generated but
// not yet validated" state. The persisted lifecycle starts at
// "needs_review". "Edited" isn't a separate status: editing (PATCH) is
// only allowed while status is "needs_review", and doesn't change it.
export const PLAN_STATUSES = ["needs_review", "approved", "rejected"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

// Batch C5: which evidence backs a file the AI says a task touches. Set
// by the server against the recorded scan (lib/planningContext.ts), never
// taken from the AI. "unverified" = the plan was not grounded in a scan.
export const AFFECTED_FILE_EVIDENCE = ["in_scan", "not_in_scan", "unverified"] as const;

// Exported for Task.planEvidence (C5.1): an approved task carries a verbatim
// copy of these, so the shape must stay identical.
export const affectedFileSchema = new Schema(
  {
    path: { type: String, required: true, trim: true, maxlength: 300 },
    // AI/human-supplied (claims):
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    // No default: absent means the AI stated no intent (and C5-era plans
    // loaded from the database must not appear to claim one).
    change: { type: String, enum: AFFECTED_FILE_CHANGES },
    // Server-computed (evidence) — never taken from input:
    evidence: { type: String, enum: AFFECTED_FILE_EVIDENCE, required: true },
    // Confirmed-graph counts at generation time; only for in-scan source files.
    dependentsCount: { type: Number },
    dependenciesCount: { type: Number },
    // Set when the claimed `change` contradicts the scan (C5.1).
    conflict: { type: String, maxlength: 300 },
    // Stage 4: verified relation to the plan's impact target, from the
    // bounded impact. Absent = not found within it (NOT "unrelated").
    impactRelation: { type: String, enum: IMPACT_RELATIONS },
    // Stage 5: why a grounded plan still can't verify this path.
    evidenceNote: { type: String, maxlength: 300 },
  },
  { _id: false },
);

// Batch C5: identity of the exact scan + analysis the planner was shown,
// plus exact totals, so a reviewer can see what the plan is grounded in.
// `null` for a plan generated without scan context.
const sourceContextSchema = new Schema(
  {
    scan: { type: Schema.Types.ObjectId, ref: "Scan", required: true },
    analysis: { type: Schema.Types.ObjectId, ref: "Analysis", required: true },
    scanCreatedAt: { type: Date },
    analysisCreatedAt: { type: Date },
    contextVersion: { type: Number, required: true },
    // C5.1: what the lexical requirement focus pointed the model at, so a
    // reviewer can see why those files were in front of it.
    // Stage 5: how much of the tree the scan read. Absent on older plans.
    coverage: {
      type: new Schema(
        {
          stoppedEarly: { type: [String], default: [] },
          unreadDirectories: { type: Number, required: true },
          ignoredDirectories: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    focusTerms: { type: [String], default: [] },
    focusFiles: { type: [String], default: [] },
    // Stage 4: the optional impact target and what the model was shown.
    impact: {
      type: new Schema(
        {
          file: { type: String, required: true },
          inGraph: { type: Boolean, required: true },
          maxDepth: { type: Number, required: true },
          maxNodes: { type: Number, required: true },
          directDependencies: { type: Number, required: true },
          directDependents: { type: Number, required: true },
          transitiveDependentsShown: { type: Number, required: true },
          truncated: { type: Boolean, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    truncated: { type: Boolean, required: true },
    counts: {
      files: { type: Number, required: true },
      graphNodes: { type: Number, required: true },
      confirmedEdges: { type: Number, required: true },
      unresolved: { type: Number, required: true },
      external: { type: Number, required: true },
      externalPackages: { type: Number, required: true },
      unsupported: { type: Number, required: true },
      parseErrors: { type: Number, required: true },
      cycles: { type: Number, required: true },
    },
  },
  { _id: false },
);

const suggestedTaskSchema = new Schema(
  {
    tempId: { type: String, required: true, trim: true, maxlength: 50 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    acceptanceCriteria: { type: [String], default: [] },
    priority: { type: String, enum: PRIORITIES, default: "medium" },
    dependsOn: { type: [String], default: [] },
    rationale: { type: String, trim: true, maxlength: 1000, default: "" },
    testingApproach: { type: String, trim: true, maxlength: 1000, default: "" },
    affectedFiles: { type: [affectedFileSchema], default: [] },
  },
  { _id: false },
);

const planSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    // Denormalized from the project's owner — same pattern as Requirement/Task.
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requirement: { type: Schema.Types.ObjectId, ref: "Requirement", required: true, index: true },
    status: { type: String, enum: PLAN_STATUSES, default: "needs_review" },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    summary: { type: String, required: true, trim: true, maxlength: 2000 },
    assumptions: { type: [String], default: [] },
    risks: { type: [String], default: [] },
    suggestedTasks: { type: [suggestedTaskSchema], default: [] },
    sourceContext: { type: sourceContextSchema, default: null },
    // Computed by the dependency graph engine at generation time — never
    // trusted from the AI. Empty for an (impossible, since we never save
    // one) invalid plan.
    suggestedOrder: { type: [String], default: [] },
    // A snapshot of the validation outcome at generation time, kept for
    // audit/debugging — the plan is only ever saved when valid, so
    // `errors` is expected to always be empty in practice, but recording
    // it costs nothing and documents what was actually checked.
    validation: {
      valid: { type: Boolean, required: true },
      errors: { type: [Schema.Types.Mixed], default: [] },
    },
    // Provider/model metadata for traceability — no raw prompt or full
    // response text stored (avoid retaining potentially large/sensitive
    // provider payloads beyond what's needed to explain the plan).
    aiMeta: {
      provider: { type: String, required: true },
      model: { type: String, required: true },
      generatedAt: { type: Date, required: true },
      durationMs: { type: Number, required: true },
    },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

planSchema.index({ project: 1, createdAt: -1 });

export type PlanSchemaType = InferSchemaType<typeof planSchema>;
export type PlanDocument = HydratedDocument<PlanSchemaType>;

export const Plan = model("Plan", planSchema);
