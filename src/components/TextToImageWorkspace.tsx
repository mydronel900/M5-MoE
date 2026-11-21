import {
  ArrowRight,
  Download,
  FolderOpen,
  Image as ImageIcon,
  Save,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  AssignedModel,
  GeneratedMediaItem,
  RenderJob,
  RunnerEndpoints,
  SavedOutputMetadata,
  StorageConfig,
} from "../types/moe";
import { apiFetch, withLanTokenUrl } from "../utils/apiClient";
import { formatDurationMs } from "../utils/imageHelpers";

interface TextToImageWorkspaceProps {
  model: AssignedModel;
  endpoints: RunnerEndpoints;
  storageConfig: StorageConfig | null;
  initialPrompt: string;
  remixSeed?: SavedOutputMetadata | null;
  activeQueueJob?: RenderJob | null;
  history: GeneratedMediaItem[];
  onEnqueueT2I: (payload: {
    model: string;
    runner: string;
    prompt: string;
    negativePrompt: string;
    width: number;
    height: number;
    steps: number;
    guidanceScale: number;
    seed?: number;
    endpoints: RunnerEndpoints;
  }) => Promise<void>;
  onRefreshStorage: () => void;
  onOpenModelPicker: () => void;
  onOpenLanModal: () => void;
  onOpenStorageModal: () => void;
  onSendToI2I: (imageUrl: string, prompt: string) => void;
  onSendToI2V: (imageUrl: string, prompt: string) => void;
}

const ASPECT_PRESETS = [
  { label: "1:1 (1024×1024)", width: 1024, height: 1024 },
  { label: "4:3 (1024×768)", width: 1024, height: 768 },
  { label: "16:9 (1024×576)", width: 1024, height: 576 },
  { label: "3:4 (768×1024)", width: 768, height: 1024 },
  { label: "9:16 (576×1024)", width: 576, height: 1024 },
];

export function TextToImageWorkspace({
  model,
  endpoints,
  storageConfig,
  initialPrompt,
  remixSeed,
  activeQueueJob,
  history,
  onEnqueueT2I,
  onRefreshStorage,
  onOpenModelPicker,
  onOpenLanModal,
  onOpenStorageModal,
  onSendToI2I,
  onSendToI2V,
}: TextToImageWorkspaceProps) {
  const [prompt, setPrompt] = useState(
    initialPrompt ||
      "Minimalist architectural studio interior in Tokyo, warm morning sunlight across raw concrete and hinoki wood, 35mm documentary lens"
  );
  const [negativePrompt, setNegativePrompt] = useState(
    "blurry, distorted geometry, watermark, text overlay, oversaturated"
  );
  const [aspectIdx, setAspectIdx] = useState(0);
  const [steps, setSteps] = useState(4);
  const [guidanceScale, setGuidanceScale] = useState(3.5);
  const [seed, setSeed] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualSavedPath, setManualSavedPath] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt);
    }
  }, [initialPrompt]);

  useEffect(() => {
    if (!remixSeed || remixSeed.feature !== "text-to-image") return;
    if (remixSeed.prompt) setPrompt(remixSeed.prompt);
    if (remixSeed.negativePrompt !== undefined) setNegativePrompt(remixSeed.negativePrompt);
    if (remixSeed.steps) setSteps(remixSeed.steps);
    if (remixSeed.guidanceScale !== undefined) setGuidanceScale(remixSeed.guidanceScale);
    if (remixSeed.seed !== undefined) setSeed(String(remixSeed.seed));
    if (remixSeed.width && remixSeed.height) {
      const idx = ASPECT_PRESETS.findIndex(
        (p) => p.width === remixSeed.width && p.height === remixSeed.height
      );
      if (idx >= 0) setAspectIdx(idx);
    }
  }, [remixSeed]);

  const latestItem = history[0] || null;
  const preset = ASPECT_PRESETS[aspectIdx];
  const jobIsBusy =
    activeQueueJob?.status === "running" || activeQueueJob?.status === "queued";

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setIsSubmitting(true);
    setSubmitError(null);
    setManualSavedPath(null);

    try {
      const parsedSeed = seed.trim() ? parseInt(seed.trim(), 10) : undefined;
      await onEnqueueT2I({
        model: model.id,
        runner: model.runner,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim(),
        width: preset.width,
        height: preset.height,
        steps,
        guidanceScale,
        seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
        endpoints,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to enqueue render job");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">
            02. Text to Image
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Dedicated Expert:{" "}
            <span className="font-mono font-medium text-slate-700 dark:text-slate-300">
              {model.id}
            </span>
            <span aria-hidden="true"> · </span>
            {model.quantization}
            <span aria-hidden="true"> · </span>
            ~{model.estimatedRamGb.toFixed(1)} GB RAM
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenStorageModal}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Output Folder</span>
          </button>

          <button
            type="button"
            onClick={onOpenModelPicker}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Change Model</span>
          </button>
        </div>
      </div>

      <div className="grid flex-1 gap-6 p-6 lg:grid-cols-[380px_1fr]">
        {/* Controls Panel */}
        <form
          onSubmit={handleGenerate}
          className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
        >
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Prompt
            </label>
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the image to synthesize locally..."
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Negative Prompt
            </label>
            <input
              type="text"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Dimensions
            </label>
            <select
              value={aspectIdx}
              onChange={(e) => setAspectIdx(Number(e.target.value))}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {ASPECT_PRESETS.map((p, idx) => (
                <option key={p.label} value={idx}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Steps
              </span>
              <input
                type="number"
                min={1}
                max={60}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>

            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                CFG
              </span>
              <input
                type="number"
                step="0.5"
                min={0}
                max={20}
                value={guidanceScale}
                onChange={(e) => setGuidanceScale(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>

            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Seed
              </span>
              <input
                type="text"
                placeholder="Random"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !prompt.trim()}
            className="mt-auto w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {isSubmitting
              ? "Queueing..."
              : jobIsBusy
              ? "Queue Another Render"
              : "Queue Image Generation"}
          </button>
        </form>

        {/* Output Canvas & History */}
        <div className="flex flex-col gap-5">
          {(submitError || activeQueueJob?.status === "failed") && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-semibold">
                {submitError || activeQueueJob?.error}
              </p>
              {activeQueueJob?.isOffline && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={onOpenLanModal}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-blue-600"
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    <span>Launch Local M5 Worker</span>
                  </button>
                  <a
                    href="/api/worker/script"
                    download="m5_mlx_worker.py"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-slate-900 dark:text-amber-200"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download m5_mlx_worker.py</span>
                  </a>
                </div>
              )}
            </div>
          )}

          <div className="flex min-h-[380px] flex-1 flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            {jobIsBusy && activeQueueJob ? (
              <div className="w-full max-w-xl space-y-4 text-center">
                {activeQueueJob.previewUrl && (
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
                    <img
                      src={activeQueueJob.previewUrl}
                      alt="Progressive diffusion preview"
                      className="mx-auto max-h-[420px] w-auto object-contain"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    {activeQueueJob.status === "queued"
                      ? `Queued at position #${activeQueueJob.position}`
                      : activeQueueJob.stepLabel}
                  </p>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-full bg-blue-600 transition-all duration-200"
                      style={{ width: `${Math.max(4, activeQueueJob.progressPercent)}%` }}
                    />
                  </div>
                  <p className="font-mono text-xs text-slate-500 tabular-nums dark:text-slate-400">
                    {activeQueueJob.progressPercent}% · VAE tiling active
                  </p>
                </div>
              </div>
            ) : latestItem ? (
              <div className="w-full space-y-4">
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
                  <img
                    src={withLanTokenUrl(latestItem.outputUrl)}
                    alt={latestItem.prompt}
                    referrerPolicy="no-referrer"
                    className="mx-auto max-h-[520px] w-auto object-contain"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
                      {latestItem.modelUsed}
                      <span aria-hidden="true"> · </span>
                      {latestItem.width || preset.width}×{latestItem.height || preset.height}
                      <span aria-hidden="true"> · </span>
                      {formatDurationMs(latestItem.elapsedMs)}
                    </p>
                    {(manualSavedPath || latestItem.savedPath) && (
                      <p className="mt-1 font-mono text-xs text-emerald-700 dark:text-emerald-400">
                        Saved on M5: {manualSavedPath || latestItem.savedPath}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await apiFetch("/api/outputs/save", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            dataUrl: latestItem.outputUrl,
                            feature: "text-to-image",
                            metadata: {
                              feature: "text-to-image",
                              prompt: latestItem.prompt,
                              negativePrompt: latestItem.negativePrompt,
                              modelUsed: latestItem.modelUsed,
                              runnerUsed: latestItem.runnerUsed,
                              width: latestItem.width,
                              height: latestItem.height,
                              steps: latestItem.steps,
                              guidanceScale: latestItem.guidanceScale,
                              seed: latestItem.seed,
                              elapsedMs: latestItem.elapsedMs,
                              createdAt: latestItem.createdAt,
                            },
                          }),
                        });
                        if (res.ok) {
                          const saved = await res.json();
                          setManualSavedPath(saved.savedPath);
                          onRefreshStorage();
                        }
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Save className="h-3.5 w-3.5" />
                      <span>Save to Folder</span>
                    </button>
                    <a
                      href={withLanTokenUrl(latestItem.downloadUrl || latestItem.outputUrl)}
                      download={latestItem.savedFileName || `m5-t2i-${latestItem.id}.png`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download PNG</span>
                    </a>
                    <button
                      type="button"
                      onClick={() => onSendToI2I(withLanTokenUrl(latestItem.outputUrl), latestItem.prompt)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <span>Image to Image</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onSendToI2V(withLanTokenUrl(latestItem.outputUrl), latestItem.prompt)}
                      className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                    >
                      <span>Animate Video</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex max-w-md flex-col items-center text-center">
                <ImageIcon className="h-8 w-8 text-slate-300 dark:text-slate-700" />
                <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
                  Local Text-to-Image Viewport
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Jobs queue single-file for M5 16GB RAM with live step previews and save to{" "}
                  <span className="font-mono">{storageConfig?.outputDir || "~/M5-MoE-Outputs"}</span>.
                </p>
              </div>
            )}
          </div>

          {history.length > 1 && (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              {history.slice(1, 6).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSendToI2I(withLanTokenUrl(item.outputUrl), item.prompt)}
                  className="group overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                >
                  <img
                    src={withLanTokenUrl(item.outputUrl)}
                    alt={item.prompt}
                    referrerPolicy="no-referrer"
                    className="aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-105"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
