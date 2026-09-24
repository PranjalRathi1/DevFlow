import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const PROJECT_STATUSES = ["planning", "active", "on_hold", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const projectSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    // The project owner. Indexed because "list my projects" / ownership
    // checks (a user can only act on projects they own) are the primary
    // access pattern once Phase 3 authorization lands.
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: PROJECT_STATUSES,
      default: "planning",
    },
    // Local-first project import (Batch C1 — see docs/PRODUCT_SCOPE_LOCAL.md
    // and docs/DECISIONS.md). `canonicalPath` is the server-side absolute
    // filesystem path the scanner reads from; it is a real local path on
    // whatever machine runs the API, so it's never returned by an ordinary
    // query — `select: false` here, PLUS a `toJSON` transform below as a
    // second, independent guard (the same double-guard pattern
    // User.ts uses for `passwordHash`). Only sourceConfig.service.ts reads
    // it, by explicitly opting in with `.select("+sourceConfig.canonicalPath")`.
    // `label` is the safe value the frontend actually renders (derived
    // server-side — see sourceConfig.service.ts).
    sourceConfig: {
      canonicalPath: { type: String, select: false },
      label: { type: String },
      configuredAt: { type: Date },
    },
  },
  { timestamps: true },
);

// Defense in depth, matching User.ts's pattern for passwordHash: even if
// something ever re-selects canonicalPath explicitly, it never survives
// JSON serialization back to a client.
projectSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    const sourceConfig = ret.sourceConfig as Record<string, unknown> | undefined;
    if (sourceConfig) delete sourceConfig.canonicalPath;
    delete ret.__v;
    return ret;
  },
});

export type ProjectSchemaType = InferSchemaType<typeof projectSchema>;
export type ProjectDocument = HydratedDocument<ProjectSchemaType>;

export const Project = model("Project", projectSchema);
