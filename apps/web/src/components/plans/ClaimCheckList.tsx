import { Badge } from "../ui/Badge";
import { CLAIM_STATUS_META } from "../../lib/statusMeta";
import type { ClaimCheck } from "../../types/plan";

interface ClaimCheckListProps {
  checks: ClaimCheck[] | undefined;
  /** The file the AI's text is about (an affected file); absent for task-level text. */
  about?: string;
  /** Accessible name for the list. */
  label: string;
}

function claimText(check: ClaimCheck, about: string | undefined): string {
  const subject = check.subject ?? about ?? "this file";
  if (check.kind === "imports") return `${subject} imports ${check.target}`;
  if (check.kind === "imported_by") return `${subject} is imported by ${check.target}`;
  return `names ${check.target}`;
}

/**
 * Task 3 (ADR-030): what the AI STATED in its own text (file paths, "a
 * imports b"), next to what DevFlow found in the scan. The statement is
 * quoted as the AI's; the badge and note are DevFlow's.
 */
export function ClaimCheckList({ checks, about, label }: ClaimCheckListProps) {
  if (!checks || checks.length === 0) return null;
  return (
    <div className="mt-1">
      <p className="text-slate-500">Statements in the AI&apos;s text, checked by DevFlow against the scan:</p>
      <ul className="mt-0.5 flex flex-col gap-0.5" aria-label={label}>
        {checks.map((check) => {
          const meta = CLAIM_STATUS_META[check.status];
          return (
            <li
              key={`${check.kind}:${check.subject ?? ""}:${check.target}`}
              className="flex flex-wrap items-center gap-1.5"
            >
              <span className="text-slate-600">
                AI: &ldquo;<code className="break-all">{claimText(check, about)}</code>&rdquo;
              </span>
              <Badge tone={meta.tone}>{meta.label}</Badge>
              {check.note && <span className="text-slate-500">{check.note}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
