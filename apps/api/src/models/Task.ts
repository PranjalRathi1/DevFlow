import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { PRIORITIES, type Priority } from "./Requirement.js";
import { affectedFileSchema } from "./Plan.js";

export { PRIORITIES };
export type { Priority };

// Deliberately minimal — enough for a manual workflow today without
// inventing states a real team wouldn't use yet.
export const TASK_STATUSES = ["todo", "in_progress", "blocked", "in_review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// C5.1: evidence a task inherited from the AI plan it was approved from —
// a verbatim copy made at approval (plan.service.ts), so it survives even
// if the plan is later removed. Read-only: no task create/update schema
// accepts it (Zod strips unknown keys), and it is never recomputed.
const planEvidenceSchema = new Schema(
  {
    plan: { type: Schema.Types.ObjectId, ref: "Plan", required: true },
    tempId: { type: String, required: true },
    rationale: { type: String, default: "" },
    testingApproach: { type: String, default: "" },
    affectedFiles: { type: [affectedFileSchema], default: [] },
    sourceContext: {
      type: new Schema(
        {
          scan: { type: Schema.Types.ObjectId, ref: "Scan", required: true },
          analysis: { type: Schema.Types.ObjectId, ref: "Analysis", required: true },
          contextVersion: { type: Number, required: true },
          // Stage 4: the target that affectedFiles[].impactRelation refers to.
          impactFile: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { _id: false },
);

const taskSchema = new Schema(
  {
    project: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    // Denormalized from the project's owner — see Requirement.ts for why.
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requirement: {
      type: Schema.Types.ObjectId,
      ref: "Requirement",
      default: null,
      index: true,
    },
    // Subtasks are separate Task documents with a parentTask reference,
    // not embedded subdocuments — see docs/DECISIONS.md for the full
    // reasoning (uniform nodes for Batch B's dependency graph, independent
    // querying/filtering of subtasks, no duplicated status/priority logic).
    parentTask: {
      type: Schema.Types.ObjectId,
      ref: "Task",
      default: null,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },
    status: {
      type: String,
      enum: TASK_STATUSES,
      default: "todo",
    },
    priority: {
      type: String,
      enum: PRIORITIES,
      default: "medium",
    },
    acceptanceCriteria: {
      type: [String],
      default: [],
    },
    // Dependency edges (Batch B) — conceptually distinct from `parentTask`
    // (a tree/subtask hierarchy). Direction: this task depends on each
    // task in the array, i.e. each must be completed before this one can
    // become "ready" — see apps/api/src/lib/dependencyGraph.ts, which is
    // the only code allowed to decide whether a set of these edges is
    // valid (no self/duplicate/cyclic edges). Populated today only via
    // plan approval (see plan.service.ts); not yet settable through the
    // general task-update endpoint — see docs/DECISIONS.md.
    planEvidence: { type: planEvidenceSchema, default: null },
    dependencies: {
      type: [{ type: Schema.Types.ObjectId, ref: "Task" }],
      default: [],
    },
  },
  { timestamps: true },
);

taskSchema.index({ project: 1, status: 1 });
taskSchema.index({ project: 1, parentTask: 1 });
taskSchema.index({ project: 1, dependencies: 1 });

export type TaskSchemaType = InferSchemaType<typeof taskSchema>;
export type TaskDocument = HydratedDocument<TaskSchemaType>;

export const Task = model("Task", taskSchema);
