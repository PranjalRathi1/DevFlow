import { AlertTriangle } from "lucide-react";
import { Badge } from "../ui/Badge";
import {
  AFFECTED_FILE_CHANGE_LABELS,
  AFFECTED_FILE_EVIDENCE_META,
  IMPACT_RELATION_LABELS,
} from "../../lib/statusMeta";
import type { AffectedFile } from "../../types/plan";
import { ClaimCheckList } from "./ClaimCheckList";

interface AffectedFileListProps {
  files: AffectedFile[];
  /** Accessible name for the list, e.g. "Affected files for Add limiter". */
  label: string;
  /** Resolves a plan task id to its title, where the plan is at hand. */
  taskTitle?: (tempId: string) => string | undefined;
}

/**
 * Shared by plan review and approved tasks so both show the same evidence
 * the same way. The AI's claims (intended change, reason) are rendered as
 * plain text; the server's findings (evidence badge, import counts,
 * conflict) are visually distinct.
 */
export function AffectedFileList({ files, label, taskTitle }: AffectedFileListProps) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1.5" aria-label={label}>
      {files.map((file) => {
        const evidence = AFFECTED_FILE_EVIDENCE_META[file.evidence];
        return (
          <li key={file.path} className="text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all text-slate-700">{file.path}</code>
              <Badge tone={evidence.tone}>{evidence.label}</Badge>
              {file.change && (
                <span className="text-slate-500">AI intent: {AFFECTED_FILE_CHANGE_LABELS[file.change]}</span>
              )}
              {file.dependentsCount !== undefined && (
                <span className="text-slate-400">
                  imported by {file.dependentsCount} · imports {file.dependenciesCount ?? 0}
                </span>
              )}
            </div>
            {file.impactRelation && (
              <p className="mt-0.5 text-slate-600">
                Verified relation: {IMPACT_RELATION_LABELS[file.impactRelation]}
              </p>
            )}
            {file.plannedBy && (
              <p className="mt-0.5 text-slate-600">
                Not in the scan yet: created earlier in this plan by &ldquo;
                {taskTitle?.(file.plannedBy) ?? file.plannedBy}&rdquo;, which this task depends on.
              </p>
            )}
            {file.evidenceNote && (
              <p className="mt-0.5 text-slate-500">Why unverified: {file.evidenceNote}</p>
            )}
            {file.reason && <p className="mt-0.5 text-slate-500">AI&apos;s reason: {file.reason}</p>}
            <ClaimCheckList
              checks={file.claimChecks}
              about={file.path}
              label={`Checked statements about ${file.path}`}
            />
            {file.conflict && (
              <p className="mt-0.5 flex items-start gap-1 text-warning-800">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{file.conflict}</span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
