import { useState } from "react";
import { Sparkles, AlertTriangle } from "lucide-react";
import { useProjectContext } from "./useProjectContext";
import { useRequirements } from "../../queries/requirementQueries";
import {
  useAIStatus,
  useApprovePlan,
  useGeneratePlan,
  usePlans,
  useRejectPlan,
} from "../../queries/planQueries";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Dialog } from "../../components/ui/Dialog";
import { LoadingState } from "../../components/ui/LoadingState";
import { ErrorState } from "../../components/ui/ErrorState";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectField } from "../../components/forms/SelectField";
import { PLAN_STATUS_META, PRIORITY_META } from "../../lib/statusMeta";
import { AffectedFileList } from "../../components/plans/AffectedFileList";
import { ClaimCheckList } from "../../components/plans/ClaimCheckList";
import { errorMessage } from "../../lib/errorMessage";
import { useLatestScan } from "../../queries/scanQueries";
import { useDependencyGraph } from "../../queries/graphQueries";
import type { Plan } from "../../types/plan";

/** "3 days ago" — coarse on purpose; the exact time is shown next to it. */
function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function PlanEvidenceSummary({
  plan,
  latestScanId,
  latestAnalysis,
}: {
  plan: Plan;
  latestScanId: string | undefined;
  /** The latest analysis of the latest scan, when known. */
  latestAnalysis: { scanId: string; analysisId: string } | undefined;
}) {
  const ctx = plan.sourceContext;
  if (!ctx) {
    return (
      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Not grounded in a scan — file paths in this plan are unverified.
      </p>
    );
  }
  const c = ctx.counts;
  const cov = ctx.coverage;
  const coverageGaps = cov ? cov.unreadDirectories - cov.ignoredDirectories : 0;
  const stale = latestScanId !== undefined && latestScanId !== ctx.scan;
  const reanalysed =
    !stale && latestAnalysis?.scanId === ctx.scan && latestAnalysis.analysisId !== ctx.analysis;
  const resolution = ctx.resolution;
  const impact = ctx.impact;
  const targetReferenced =
    impact && plan.suggestedTasks.some((t) => (t.affectedFiles ?? []).some((f) => f.path === impact.file));
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      {stale && (
        <p role="note" className="mb-2 flex items-start gap-1 text-warning-800">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            A newer scan of this project exists. This plan&apos;s evidence is from the older scan below and
            may no longer match the code.
          </span>
        </p>
      )}
      {reanalysed && (
        <p role="note" className="mb-2 flex items-start gap-1 text-warning-800">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            This scan was analysed again after the plan was generated. The plan&apos;s file labels use the
            earlier analysis.
          </span>
        </p>
      )}
      <p className="font-semibold text-slate-700">
        Grounded in scan
        {ctx.scanCreatedAt
          ? ` from ${new Date(ctx.scanCreatedAt).toLocaleString()} (${age(ctx.scanCreatedAt)})`
          : ""}
      </p>
      <p className="mt-1">
        DevFlow does not watch the source folder: files changed after this scan are not reflected. Run a new
        scan to refresh the evidence.
      </p>
      <p className="mt-1">
        {c.files} files · {c.confirmedEdges} confirmed dependencies · {c.unresolved} unresolved ·{" "}
        {c.externalPackages} external packages · {c.unsupported} unsupported · {c.parseErrors} parse errors ·{" "}
        {c.cycles === 0 ? "no import cycles" : `${c.cycles} import cycles`}
      </p>
      {ctx.truncated && (
        <p className="mt-1">Some evidence lists were truncated for the AI; the totals above are exact.</p>
      )}
      {ctx.fitting && ctx.fitting.reductions.length > 0 && (
        <p className="mt-1 text-warning-800">
          To fit the AI model&apos;s context budget, some evidence lists were shortened:{" "}
          {ctx.fitting.reductions.map((r) => `${r.section} (${r.shown} of ${r.total})`).join(", ")}. Items
          left out were not shown to the AI — they are not absent from the project.
        </p>
      )}
      {cov && (cov.stoppedEarly.length > 0 || coverageGaps > 0) && (
        <p className="mt-1 text-warning-800">
          The scan was incomplete
          {cov.stoppedEarly.length > 0 ? ` (stopped early: ${cov.stoppedEarly.join(", ")})` : ""};{" "}
          {cov.unreadDirectories} directories were not read. Files there are labelled unverified, not absent.
        </p>
      )}
      {resolution && (
        <p className="mt-1">
          Import resolution:{" "}
          {resolution.aliasConfigs.length > 0
            ? `path aliases from ${resolution.aliasConfigs.join(", ")}`
            : "no path aliases configured"}
          {resolution.localPackages > 0 ? `; ${resolution.localPackages} local package.json file(s)` : ""}.
        </p>
      )}
      {resolution && resolution.diagnosticsTotal > 0 && (
        <div className="mt-1 text-warning-800">
          <p>
            {resolution.diagnosticsTotal} configuration problem(s) — imports that depend on them are left
            unresolved or unsupported, so some dependencies may be missing:
          </p>
          <ul className="list-inside list-disc" aria-label="Import configuration problems">
            {resolution.diagnostics.map((d) => (
              <li key={`${d.file}:${d.message}`}>
                <code>{d.file}</code>: {d.message}
              </li>
            ))}
            {resolution.diagnosticsTotal > resolution.diagnostics.length && (
              <li>…and {resolution.diagnosticsTotal - resolution.diagnostics.length} more</li>
            )}
          </ul>
        </div>
      )}
      {impact && (
        <p className="mt-1">
          Planned change target: <code>{impact.file}</code> — {impact.directDependents} direct dependents,{" "}
          {impact.transitiveDependentsShown} indirect dependents shown to the AI (within {impact.maxDepth}{" "}
          import hops){impact.truncated ? "; the impact was cut off, so more files may be affected" : ""}.
          {impact.dependentsAtAnyDepth !== undefined &&
            ` In total ${impact.dependentsAtAnyDepth} file(s) depend on it at any depth${
              impact.typeOnlyDependents
                ? ` (${impact.typeOnlyDependents} only through type-only imports)`
                : ""
            }${impact.entryPointsAffected ? `; ${impact.entryPointsAffected} entry point(s) reach it` : ""}.`}{" "}
          Dependents may be affected; they do not all need to change.
          {!targetReferenced && " No task in this plan references the target file."}
        </p>
      )}
      {ctx.focusTerms && ctx.focusTerms.length > 0 && (
        <p className="mt-1">
          Requirement focus (matched by file name only, not proof of relevance):{" "}
          {ctx.focusFiles && ctx.focusFiles.length > 0 ? ctx.focusFiles.join(", ") : "no matching files"}
        </p>
      )}
      <p className="mt-2 text-slate-500">
        File labels are checked by DevFlow against this scan: <strong>In scan</strong> = the scan saw the
        file; <strong>Not in scan — proposed</strong> = the scan looked there and did not find it;{" "}
        <strong>Unverified</strong> = DevFlow could not check (the scan did not read that location). Import
        relationships show references between files, not how code runs. The AI&apos;s intent, reasons and
        rationale are its own claims.
      </p>
    </div>
  );
}

export default function ProjectPlansTab() {
  const project = useProjectContext();
  const { data: requirements } = useRequirements(project._id);
  const { data: latestScan } = useLatestScan(project._id);
  const groundableScan = latestScan && latestScan.outcome !== "failed" ? latestScan : null;
  const [useScanContext, setUseScanContext] = useState(true);
  const [impactFile, setImpactFile] = useState("");
  // Files the latest scan's analysis knows about — the only valid impact targets.
  const { data: graph } = useDependencyGraph(
    groundableScan && useScanContext ? groundableScan._id : undefined,
  );
  const { data: aiStatus } = useAIStatus();
  const { data: plans, isLoading, isError, error, refetch } = usePlans(project._id);
  const generatePlan = useGeneratePlan(project._id);
  const approvePlan = useApprovePlan(project._id);
  const rejectPlan = useRejectPlan(project._id);

  const [selectedRequirementId, setSelectedRequirementId] = useState("");
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [reviewingPlan, setReviewingPlan] = useState<Plan | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const requirementTitleByTempId = (plan: Plan, tempId: string) =>
    plan.suggestedTasks.find((t) => t.tempId === tempId)?.title ?? tempId;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-600" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-900">Generate an AI Plan</h2>
        </div>

        {aiStatus && !aiStatus.available && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              The AI provider ({aiStatus.provider}/{aiStatus.model}) is currently unavailable. You can still
              create requirements and tasks manually in the Requirements and Tasks tabs.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <SelectField
              label="Requirement"
              name="requirementId"
              options={[
                { value: "", label: "Select a requirement…" },
                ...(requirements ?? []).map((r) => ({ value: r._id, label: r.title })),
              ]}
              value={selectedRequirementId}
              onChange={(e) => setSelectedRequirementId(e.target.value)}
            />
          </div>
          <Button
            disabled={!selectedRequirementId || generatePlan.isPending || aiStatus?.available === false}
            onClick={() => {
              setGenerateError(null);
              generatePlan.mutate(
                {
                  requirementId: selectedRequirementId,
                  scanId: groundableScan && useScanContext ? groundableScan._id : undefined,
                  impactFile: groundableScan && useScanContext && impactFile ? impactFile : undefined,
                },
                { onError: (err) => setGenerateError(errorMessage(err, "Failed to generate a plan.")) },
              );
            }}
          >
            {generatePlan.isPending ? "Generating…" : "Generate Plan"}
          </Button>
        </div>
        {groundableScan ? (
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={useScanContext}
              onChange={(e) => setUseScanContext(e.target.checked)}
            />
            Ground the plan in the latest scan ({new Date(groundableScan.createdAt).toLocaleString()}) and its
            dependency analysis
          </label>
        ) : null}
        {groundableScan && useScanContext && graph && graph.nodes.length > 0 && (
          <div className="mt-3 max-w-xl">
            <SelectField
              label="File you plan to change (optional)"
              name="impactFile"
              options={[
                { value: "", label: "No specific file" },
                ...graph.nodes.map((n) => ({ value: n.id, label: n.id })),
              ]}
              value={impactFile}
              onChange={(e) => setImpactFile(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              Adds the files that import it (directly or indirectly) to the AI&apos;s context as possibly
              affected.
            </p>
          </div>
        )}
        {!groundableScan && (
          <p className="mt-2 text-xs text-slate-500">
            No usable scan yet — the plan will not be grounded in project evidence. Run a scan and its
            dependency analysis first for an evidence-backed plan.
          </p>
        )}
        {generateError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {generateError}
          </p>
        )}
        {(!requirements || requirements.length === 0) && (
          <p className="mt-2 text-xs text-slate-500">
            Create a requirement in the Requirements tab first — a plan is generated from one.
          </p>
        )}
      </Card>

      {isLoading && <LoadingState label="Loading plans…" />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}

      {plans &&
        (plans.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-8 w-8" />}
            title="No plans yet"
            description="Generate an AI plan above, or keep working entirely manually in Requirements and Tasks — AI is optional."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {plans.map((plan) => {
              const meta = PLAN_STATUS_META[plan.status];
              return (
                <button
                  key={plan._id}
                  type="button"
                  onClick={() => {
                    setReviewError(null);
                    setReviewingPlan(plan);
                  }}
                  className="text-left"
                >
                  <Card className="transition-shadow hover:shadow-md">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">{plan.title}</p>
                        <p className="mt-1 text-sm text-slate-500">{plan.summary}</p>
                        <p className="mt-2 text-xs text-slate-400">
                          {plan.suggestedTasks.length} suggested tasks · generated{" "}
                          {new Date(plan.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>
                  </Card>
                </button>
              );
            })}
          </div>
        ))}

      <Dialog
        open={reviewingPlan !== null}
        onOpenChange={(open) => !open && setReviewingPlan(null)}
        title={reviewingPlan?.title ?? "Plan"}
        description={reviewingPlan?.summary}
      >
        {reviewingPlan && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Badge tone={PLAN_STATUS_META[reviewingPlan.status].tone}>
                {PLAN_STATUS_META[reviewingPlan.status].label}
              </Badge>
              <span className="text-xs text-slate-400">
                {reviewingPlan.aiMeta.provider}/{reviewingPlan.aiMeta.model}
              </span>
            </div>

            <PlanEvidenceSummary
              plan={reviewingPlan}
              latestScanId={latestScan?._id}
              latestAnalysis={graph ? { scanId: graph.scanId, analysisId: graph.analysisId } : undefined}
            />

            {reviewingPlan.assumptions.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Assumptions</p>
                <ul className="mt-1 list-inside list-disc text-sm text-slate-700">
                  {reviewingPlan.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}

            {reviewingPlan.risks.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Risks</p>
                <ul className="mt-1 list-inside list-disc text-sm text-slate-700">
                  {reviewingPlan.risks.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Suggested Tasks ({reviewingPlan.suggestedTasks.length})
              </p>
              <div className="mt-2 flex flex-col gap-2">
                {reviewingPlan.suggestedOrder.map((tempId) => {
                  const task = reviewingPlan.suggestedTasks.find((t) => t.tempId === tempId);
                  if (!task) return null;
                  return (
                    <div key={tempId} className="rounded-md border border-slate-200 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-slate-900">{task.title}</p>
                        <Badge tone={PRIORITY_META[task.priority].tone}>
                          {PRIORITY_META[task.priority].label}
                        </Badge>
                      </div>
                      {task.description && <p className="mt-1 text-sm text-slate-500">{task.description}</p>}
                      {task.rationale && (
                        <p className="mt-1 text-xs text-slate-500">
                          <span className="font-semibold">AI rationale:</span> {task.rationale}
                        </p>
                      )}
                      {task.testingApproach && (
                        <p className="mt-1 text-xs text-slate-500">
                          <span className="font-semibold">AI testing approach:</span> {task.testingApproach}
                        </p>
                      )}
                      <AffectedFileList
                        files={task.affectedFiles ?? []}
                        label={`Affected files for ${task.title}`}
                        taskTitle={(id) => reviewingPlan.suggestedTasks.find((t) => t.tempId === id)?.title}
                      />
                      <div className="text-xs">
                        <ClaimCheckList
                          checks={task.mentionedPaths}
                          label={`Checked statements in the text of ${task.title}`}
                        />
                      </div>
                      {task.dependsOn.length > 0 && (
                        <p className="mt-1 text-xs text-slate-400">
                          Depends on:{" "}
                          {task.dependsOn.map((id) => requirementTitleByTempId(reviewingPlan, id)).join(", ")}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {reviewError && (
              <p role="alert" className="text-sm text-red-600">
                {reviewError}
              </p>
            )}

            {reviewingPlan.status !== "needs_review" && (
              <p className="text-xs text-slate-500">
                {reviewingPlan.status === "approved"
                  ? "Approved — its tasks were created with a copy of this evidence."
                  : "Rejected — no tasks were created."}
                {reviewingPlan.reviewedAt
                  ? ` Reviewed ${new Date(reviewingPlan.reviewedAt).toLocaleString()}.`
                  : ""}
              </p>
            )}

            {reviewingPlan.status === "needs_review" && (
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  disabled={rejectPlan.isPending}
                  onClick={() => {
                    setReviewError(null);
                    rejectPlan.mutate(reviewingPlan._id, {
                      onSuccess: () => setReviewingPlan(null),
                      onError: (err) => setReviewError(errorMessage(err, "Failed to reject the plan.")),
                    });
                  }}
                >
                  Reject
                </Button>
                <Button
                  disabled={approvePlan.isPending}
                  onClick={() => {
                    setReviewError(null);
                    approvePlan.mutate(reviewingPlan._id, {
                      onSuccess: () => setReviewingPlan(null),
                      onError: (err) => setReviewError(errorMessage(err, "Failed to approve the plan.")),
                    });
                  }}
                >
                  {approvePlan.isPending ? "Approving…" : "Approve & Create Tasks"}
                </Button>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
