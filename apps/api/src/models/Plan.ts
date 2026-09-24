import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { PRIORITIES } from "./Requirement.js";

// Generation + structural/graph validation happen synchronously, in the
// same request, before anything is persisted (see plan.service.ts) — an
// invalid plan is never saved at all, so there's no stored "generated but
// not yet validated" state. The persisted lifecycle starts at
// "needs_review". "Edited" isn't a separate status: editing (PATCH) is
// only allowed while status is "needs_review", and doesn't change it.
export const PLAN_STATUSES = ["needs_review", "approved", "rejected"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

const suggestedTaskSchema = new Schema(
  {
    tempId: { type: String, required: true, trim: true, maxlength: 50 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    acceptanceCriteria: { type: [String], default: [] },
    priority: { type: String, enum: PRIORITIES, default: "medium" },
    dependsOn: { type: [String], default: [] },
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
