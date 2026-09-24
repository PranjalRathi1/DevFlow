export type FileCategory =
  | "source"
  | "test"
  | "configuration"
  | "documentation"
  | "asset"
  | "generated"
  | "dependency"
  | "binary"
  | "unknown";

export type ScanItemStatus = "scanned" | "skipped" | "error";

export interface ScanItem {
  relativePath: string;
  type: "file" | "directory";
  category?: FileCategory;
  language?: string;
  extension?: string;
  sizeBytes?: number;
  status: ScanItemStatus;
  skipReason?: string;
  errorCategory?: string;
  errorMessage?: string;
}

export interface ScanSummary {
  totalScanned: number;
  totalSkipped: number;
  totalErrors: number;
  filesByCategory: Record<string, number>;
  filesByLanguage: Record<string, number>;
  limitsReached: string[];
  durationMs: number;
}

export type ScanOutcome = "completed" | "completed_with_warnings" | "failed";

export interface Scan {
  _id: string;
  project: string;
  outcome: ScanOutcome;
  summary: ScanSummary;
  items: ScanItem[];
  errorMessage?: string;
  createdAt: string;
}

export interface SourceConfig {
  label: string | null;
  configuredAt: string | null;
  hasPath: boolean;
}
