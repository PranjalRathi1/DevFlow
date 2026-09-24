export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
      {label}
    </div>
  );
}
