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
import { AFFECTED_FILE_EVIDENCE_META, PLAN_STATUS_META, PRIORITY_META } from "../../lib/statusMeta";
import { errorMessage } from "../../lib/errorMessage";
import { useLatestScan } from "../../queries/scanQueries";
import type { Plan } from "../../types/plan";

function PlanEvidenceSummary({ plan }: { plan: Plan }) {
  const ctx = plan.sourceContext;
  if (!ctx) {
    return (
      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Not grounded in a scan — file paths in this plan are unverified.
      </p>
    );
  }
  const c = ctx.counts;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <p className="font-semibold text-slate-700">
        Grounded in scan
        {ctx.scanCreatedAt ? ` from ${new Date(ctx.scanCreatedAt).toLocaleString()}` : ""}
      </p>
      <p className="mt-1">
        {c.files} files · {c.confirmedEdges} confirmed dependencies · {c.unresolved} unresolved ·{" "}
        {c.externalPackages} external packages · {c.unsupported} unsupported · {c.parseErrors} parse errors ·{" "}
        {c.cycles === 0 ? "no import cycles" : `${c.cycles} import cycles`}
      </p>
      {ctx.truncated && (
        <p className="mt-1">Some evidence lists were truncated for the AI; the totals above are exact.</p>
      )}
    </div>
  );
}

export default function ProjectPlansTab() {
  const project = useProjectContext();
  const { data: requirements } = useRequirements(project._id);
  const { data: latestScan } = useLatestScan(project._id);
  const groundableScan = latestScan && latestScan.outcome !== "failed" ? latestScan : null;
  const [useScanContext, setUseScanContext] = useState(true);
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
        ) : (
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

            <PlanEvidenceSummary plan={reviewingPlan} />

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
                          <span className="font-semibold">Rationale:</span> {task.rationale}
                        </p>
                      )}
                      {task.affectedFiles && task.affectedFiles.length > 0 && (
                        <ul
                          className="mt-2 flex flex-col gap-1"
                          aria-label={`Affected files for ${task.title}`}
                        >
                          {task.affectedFiles.map((file) => {
                            const evidence = AFFECTED_FILE_EVIDENCE_META[file.evidence];
                            return (
                              <li key={file.path} className="flex flex-wrap items-center gap-2 text-xs">
                                <code className="break-all text-slate-700">{file.path}</code>
                                <Badge tone={evidence.tone}>{evidence.label}</Badge>
                                {file.dependentsCount !== undefined && (
                                  <span className="text-slate-400">
                                    imported by {file.dependentsCount} · imports {file.dependenciesCount ?? 0}
                                  </span>
                                )}
                                {file.reason && <span className="text-slate-500">— {file.reason}</span>}
                              </li>
                            );
                          })}
                        </ul>
                      )}
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
