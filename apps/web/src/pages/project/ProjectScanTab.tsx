import { useState } from "react";
import { FolderSearch, AlertTriangle } from "lucide-react";
import { useProjectContext } from "./useProjectContext";
import { useLatestScan, useSetSourceConfig, useSourceConfig, useStartScan } from "../../queries/scanQueries";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { LoadingState } from "../../components/ui/LoadingState";
import { FormField } from "../../components/forms/FormField";
import { SCAN_OUTCOME_META } from "../../lib/statusMeta";
import { errorMessage } from "../../lib/errorMessage";

const ITEM_PREVIEW_LIMIT = 50;

export default function ProjectScanTab() {
  const project = useProjectContext();
  const { data: sourceConfig, isLoading: sourceLoading } = useSourceConfig(project._id);
  const { data: latestScan, isLoading: scanLoading } = useLatestScan(project._id);
  const setSourceConfig = useSetSourceConfig(project._id);
  const startScan = useStartScan(project._id);

  const [pathInput, setPathInput] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <FolderSearch className="h-4 w-4 text-brand-600" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-900">Source Directory</h2>
        </div>
        <p className="mb-3 text-sm text-slate-500">
          Point DevFlow at a local project directory to scan it read-only. DevFlow never modifies, executes,
          or installs anything inside it — see{" "}
          <span className="font-mono text-xs">docs/PRODUCT_SCOPE_LOCAL.md</span>.
        </p>

        {sourceLoading ? (
          <LoadingState label="Loading source configuration…" />
        ) : (
          <p className="mb-3 text-sm text-slate-700">
            Current:{" "}
            {sourceConfig?.hasPath ? (
              <span className="font-medium">{sourceConfig.label}</span>
            ) : (
              "Not configured"
            )}
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <FormField
              label="Local directory path"
              name="sourcePath"
              placeholder="C:\Users\you\Projects\my-app"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
            />
          </div>
          <Button
            disabled={!pathInput.trim() || setSourceConfig.isPending}
            onClick={() => {
              setSourceError(null);
              setSourceConfig.mutate(pathInput.trim(), {
                onSuccess: () => setPathInput(""),
                onError: (err) =>
                  setSourceError(errorMessage(err, "Failed to configure the source directory.")),
              });
            }}
          >
            {setSourceConfig.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        {sourceError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {sourceError}
          </p>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Scan</h2>
          <Button
            size="sm"
            disabled={!sourceConfig?.hasPath || startScan.isPending}
            onClick={() => {
              setScanError(null);
              startScan.mutate(undefined, {
                onError: (err) => setScanError(errorMessage(err, "Failed to run the scan.")),
              });
            }}
          >
            {startScan.isPending ? "Scanning…" : "Run Scan"}
          </Button>
        </div>

        {!sourceConfig?.hasPath && (
          <p className="text-sm text-slate-500">Configure a source directory above before scanning.</p>
        )}

        {scanError && (
          <p role="alert" className="mb-2 text-sm text-red-600">
            {scanError}
          </p>
        )}

        {scanLoading && <LoadingState label="Loading latest scan…" />}

        {!scanLoading && !latestScan && sourceConfig?.hasPath && (
          <p className="text-sm text-slate-500">No scan has been run yet.</p>
        )}

        {latestScan && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Badge tone={SCAN_OUTCOME_META[latestScan.outcome].tone}>
                {SCAN_OUTCOME_META[latestScan.outcome].label}
              </Badge>
              <span className="text-xs text-slate-400">
                {new Date(latestScan.createdAt).toLocaleString()}
              </span>
            </div>

            {latestScan.outcome === "failed" && latestScan.errorMessage && (
              <div className="flex items-start gap-2 rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{latestScan.errorMessage}</span>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Scanned</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {latestScan.summary.totalScanned}
                </p>
              </Card>
              <Card>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Skipped</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {latestScan.summary.totalSkipped}
                </p>
              </Card>
              <Card>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Errors</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">{latestScan.summary.totalErrors}</p>
              </Card>
            </div>

            {latestScan.summary.limitsReached.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  This scan hit a limit and may be incomplete: {latestScan.summary.limitsReached.join(", ")}.
                </span>
              </div>
            )}

            {latestScan.items.length === 0 ? (
              <p className="text-sm text-slate-500">No items were recorded for this scan.</p>
            ) : (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Inventory ({latestScan.items.length} item{latestScan.items.length === 1 ? "" : "s"})
                </p>
                <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
                  <table className="w-full text-left text-sm">
                    <tbody>
                      {latestScan.items.slice(0, ITEM_PREVIEW_LIMIT).map((item, i) => (
                        <tr key={i} className="border-b border-slate-100 last:border-b-0">
                          <td className="px-3 py-1.5 font-mono text-xs text-slate-700">
                            {item.relativePath}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-slate-500">{item.category ?? item.type}</td>
                          <td className="px-3 py-1.5 text-xs">
                            {item.status === "scanned" && <span className="text-success-700">scanned</span>}
                            {item.status === "skipped" && (
                              <span className="text-warning-700">skipped ({item.skipReason})</span>
                            )}
                            {item.status === "error" && <span className="text-danger-700">error</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {latestScan.items.length > ITEM_PREVIEW_LIMIT && (
                  <p className="mt-1 text-xs text-slate-400">
                    Showing the first {ITEM_PREVIEW_LIMIT} of {latestScan.items.length} items.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
