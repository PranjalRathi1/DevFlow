import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const SCAN_OUTCOMES = ["completed", "completed_with_warnings", "failed"] as const;
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

const scanItemSchema = new Schema(
  {
    relativePath: { type: String, required: true },
    type: { type: String, enum: ["file", "directory"], required: true },
    category: { type: String },
    language: { type: String },
    extension: { type: String },
    sizeBytes: { type: Number },
    status: { type: String, enum: ["scanned", "skipped", "error"], required: true },
    skipReason: { type: String },
    errorCategory: { type: String },
    errorMessage: { type: String },
  },
  { _id: false },
);

const scanSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    // Denormalized from the project's owner — same pattern as every other
    // project-scoped resource (Requirement/Task/Plan).
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    outcome: { type: String, enum: SCAN_OUTCOMES, required: true },
    summary: {
      totalScanned: { type: Number, required: true },
      totalSkipped: { type: Number, required: true },
      totalErrors: { type: Number, required: true },
      filesByCategory: { type: Schema.Types.Mixed, default: {} },
      filesByLanguage: { type: Schema.Types.Mixed, default: {} },
      limitsReached: { type: [String], default: [] },
      durationMs: { type: Number, required: true },
    },
    items: { type: [scanItemSchema], default: [] },
    // Only set when outcome === "failed" — a safe, non-leaking description
    // (see scanner.service.ts's safeErrorMessage), never a raw OS error.
    errorMessage: { type: String },
  },
  { timestamps: true },
);

scanSchema.index({ project: 1, createdAt: -1 });

export type ScanSchemaType = InferSchemaType<typeof scanSchema>;
export type ScanDocument = HydratedDocument<ScanSchemaType>;

export const Scan = model("Scan", scanSchema);
