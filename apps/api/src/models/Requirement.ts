import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// Shared with Task — same underlying meaning ("how important/urgent"), no
// reason to define it twice. See docs/DECISIONS.md for the "import the
// const from the model file" pattern used instead of a packages/shared
// build step (ADR on shared-enum strategy).
export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

// A requirement's lifecycle before it's broken into tasks. Kept minimal —
// "draft" (still being written), "approved" (ready to plan/break down),
// "implemented" (the work described is done).
export const REQUIREMENT_STATUSES = ["draft", "approved", "implemented"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

const requirementSchema = new Schema(
  {
    project: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    // Denormalized from the parent project's owner at creation time (never
    // client-settable, never changes — there's no project-transfer feature
    // yet). Lets every single-resource lookup be query-level
    // ownership-enforced (`Requirement.findOne({_id, owner})`) exactly like
    // Project, instead of a fetch-then-check-parent pattern.
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
      enum: REQUIREMENT_STATUSES,
      default: "draft",
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
  },
  { timestamps: true },
);

requirementSchema.index({ project: 1, createdAt: -1 });

export type RequirementSchemaType = InferSchemaType<typeof requirementSchema>;
export type RequirementDocument = HydratedDocument<RequirementSchemaType>;

export const Requirement = model("Requirement", requirementSchema);
