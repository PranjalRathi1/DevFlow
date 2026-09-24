import type { BadgeTone } from "../components/ui/Badge";
import type { ProjectStatus } from "../types/project";
import type { RequirementStatus, Priority } from "../types/requirement";
import type { TaskStatus } from "../types/task";
import type { PlanStatus } from "../types/plan";
import type { ScanOutcome } from "../types/scan";
import type { NonConfirmedStatus } from "../types/graph";

export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; tone: BadgeTone }> = {
  planning: { label: "Planning", tone: "neutral" },
  active: { label: "Active", tone: "info" },
  on_hold: { label: "On Hold", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  archived: { label: "Archived", tone: "neutral" },
};

export const REQUIREMENT_STATUS_META: Record<RequirementStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  approved: { label: "Approved", tone: "info" },
  implemented: { label: "Implemented", tone: "success" },
};

export const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: BadgeTone }> = {
  todo: { label: "To Do", tone: "neutral" },
  in_progress: { label: "In Progress", tone: "info" },
  blocked: { label: "Blocked", tone: "danger" },
  in_review: { label: "In Review", tone: "warning" },
  done: { label: "Done", tone: "success" },
};

export const PLAN_STATUS_META: Record<PlanStatus, { label: string; tone: BadgeTone }> = {
  needs_review: { label: "Needs Review", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
};

export const SCAN_OUTCOME_META: Record<ScanOutcome, { label: string; tone: BadgeTone }> = {
  completed: { label: "Completed", tone: "success" },
  completed_with_warnings: { label: "Completed with Warnings", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

export const RELATIONSHIP_STATUS_META: Record<NonConfirmedStatus, { label: string; tone: BadgeTone }> = {
  unresolved: { label: "Unresolved", tone: "warning" },
  external: { label: "External Package", tone: "info" },
  unsupported: { label: "Unsupported", tone: "neutral" },
  parse_error: { label: "Parse Error", tone: "danger" },
};

export const PRIORITY_META: Record<Priority, { label: string; tone: BadgeTone }> = {
  low: { label: "Low", tone: "neutral" },
  medium: { label: "Medium", tone: "info" },
  high: { label: "High", tone: "warning" },
  critical: { label: "Critical", tone: "danger" },
};
