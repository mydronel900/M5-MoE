import { ChevronDown, ChevronUp, Layers, Trash2, X } from "lucide-react";
import { useState } from "react";
import { RenderJob } from "../types/moe";

interface RenderQueuePanelProps {
  jobs: RenderJob[];
  onCancelJob: (jobId: string) => void;
  onClearCompleted: () => void;
}

export function RenderQueuePanel({
  jobs,
  onCancelJob,
  onClearCompleted,
}: RenderQueuePanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (jobs.length === 0) return null;

  const runningJob = jobs.find((j) => j.status === "running");
  const queuedJobs = jobs.filter((j) => j.status === "queued");
  const hasFinished = jobs.some(
    (j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled"
  );

  const headlineJob = runningJob || queuedJobs[0] || jobs[0];

  return (
    <div className="border-b border-slate-200 bg-white px-6 py-2.5 dark:border-slate-800 dark:bg-slate-900/90">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Layers className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />

          {headlineJob.previewUrl && headlineJob.status === "running" && (
            <img
              src={headlineJob.previewUrl}
              alt="Live diffusion step preview"
              className="h-8 w-8 shrink-0 rounded border border-slate-200 object-cover dark:border-slate-700"
            />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                M5 FIFO Queue
              </span>
              <span className="text-slate-400">·</span>
              <span className="truncate font-mono text-slate-700 dark:text-slate-300">
                {headlineJob.label}
              </span>
              <span className="text-slate-400">·</span>
              <span
                className={`font-medium tabular-nums ${
                  headlineJob.status === "running"
                    ? "text-blue-600 dark:text-blue-400"
                    : headlineJob.status === "failed"
                    ? "text-red-600 dark:text-red-400"
                    : headlineJob.status === "completed"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {headlineJob.stepLabel}
                {headlineJob.status === "running" ? ` (${headlineJob.progressPercent}%)` : ""}
              </span>
            </div>

            {headlineJob.status === "running" && (
              <div className="mt-1.5 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className="h-full bg-blue-600 transition-all duration-200"
                  style={{ width: `${Math.max(4, headlineJob.progressPercent)}%` }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-slate-500 tabular-nums dark:text-slate-400">
            {runningJob ? "1 active" : "Idle"} · {queuedJobs.length} queued
          </span>

          {(headlineJob.status === "running" || headlineJob.status === "queued") && (
            <button
              type="button"
              onClick={() => onCancelJob(headlineJob.id)}
              title="Cancel active job"
              className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          )}

          {hasFinished && (
            <button
              type="button"
              onClick={onClearCompleted}
              title="Clear finished jobs"
              className="rounded border border-slate-200 p-1 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <span>{jobs.length}</span>
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-slate-50 dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-950/70">
          {jobs.map((job) => (
            <div key={job.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <div className="flex min-w-0 items-center gap-2.5">
                {job.previewUrl && (
                  <img
                    src={job.previewUrl}
                    alt={job.label}
                    className="h-7 w-7 shrink-0 rounded object-cover"
                  />
                )}
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-800 dark:text-slate-200">
                    {job.status === "queued" ? `#${job.position} · ` : ""}
                    {job.label}
                  </p>
                  <p className="truncate text-slate-500 tabular-nums dark:text-slate-400">
                    {job.error || job.stepLabel}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-slate-500 tabular-nums dark:text-slate-400">
                  {job.status} · {job.progressPercent}%
                </span>
                {(job.status === "running" || job.status === "queued") && (
                  <button
                    type="button"
                    onClick={() => onCancelJob(job.id)}
                    aria-label={`Cancel ${job.label}`}
                    className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
