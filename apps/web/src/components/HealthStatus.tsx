import { useHealth } from "../hooks/useHealth";

export function HealthStatus() {
  const health = useHealth();

  if (health.status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
        Checking backend status…
      </div>
    );
  }

  if (health.status === "error") {
    return (
      <div
        role="alert"
        className="flex flex-col gap-1 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
      >
        <span className="flex items-center gap-2 font-medium">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          Backend unreachable
        </span>
        <span className="text-red-600">{health.message}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
      <span className="flex items-center gap-2 font-medium">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        Backend online
      </span>
      <span className="text-emerald-700">
        Uptime {health.data.uptimeSeconds}s · checked {new Date(health.data.timestamp).toLocaleTimeString()}
      </span>
    </div>
  );
}
