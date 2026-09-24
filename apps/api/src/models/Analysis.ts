import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const ANALYSIS_OUTCOMES = ["completed", "completed_with_warnings", "failed"] as const;
export type AnalysisOutcome = (typeof ANALYSIS_OUTCOMES)[number];

// Matches lib/importResolution.ts's ResolutionStatus plus "parse_error"
// (a file-level extraction failure, folded into the same relationship
// status set per docs/DECISIONS.md's Batch C2 ADR — see there for why).
export const RELATIONSHIP_STATUSES = [
  "confirmed",
  "unresolved",
  "external",
  "unsupported",
  "parse_error",
] as const;
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];

export const IMPORT_TYPES = ["import", "export_from", "require", "dynamic_import"] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

const relationshipSchema = new Schema(
  {
    importerRelativePath: { type: String, required: true },
    // The literal module specifier when `isLiteral` is true; otherwise a
    // short, safe source snippet (never an evaluated value) — see
    // lib/importExtraction.ts. Empty for a whole-file "parse_error" entry
    // (no call site to report).
    rawImport: { type: String, default: "" },
    isLiteral: { type: Boolean, default: false },
    importType: { type: String, enum: IMPORT_TYPES },
    line: { type: Number },
    column: { type: Number },
    status: { type: String, enum: RELATIONSHIP_STATUSES, required: true },
    resolvedRelativePath: { type: String },
    resolutionMethod: { type: String },
    reason: { type: String },
  },
  { _id: false },
);

const analysisSchema = new Schema(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    scan: { type: Schema.Types.ObjectId, ref: "Scan", required: true, index: true },
    outcome: { type: String, enum: ANALYSIS_OUTCOMES, required: true },
    summary: {
      totalFilesAnalyzed: { type: Number, required: true },
      totalFilesSkipped: { type: Number, required: true },
      totalRelationships: { type: Number, required: true },
      byStatus: { type: Schema.Types.Mixed, default: {} },
    },
    relationships: { type: [relationshipSchema], default: [] },
    // Only set when outcome === "failed" — a safe, non-leaking description.
    errorMessage: { type: String },
  },
  { timestamps: true },
);

analysisSchema.index({ scan: 1, createdAt: -1 });

export type AnalysisSchemaType = InferSchemaType<typeof analysisSchema>;
export type AnalysisDocument = HydratedDocument<AnalysisSchemaType>;

export const Analysis = model("Analysis", analysisSchema);
