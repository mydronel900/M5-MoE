import {
  ArrowRight,
  Download,
  FolderOpen,
  ImagePlus,
  Save,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { STUDIO_SAMPLE_IMAGES } from "../data/moeDefaults";
import {
  AssignedModel,
  GeneratedMediaItem,
  RenderJob,
  RunnerEndpoints,
  SavedOutputMetadata,
  StorageConfig,
} from "../types/moe";
import { apiFetch, withLanTokenUrl } from "../utils/apiClient";
import { fileToDataUrl, formatDurationMs, urlToDataUrl } from "../utils/imageHelpers";

interface ImageToImageWorkspaceProps {
  model: AssignedModel;
  endpoints: RunnerEndpoints;
  storageConfig: StorageConfig | null;
  initialImageUrl: string | null;
  initialPrompt: string;
  remixSeed?: SavedOutputMetadata | null;
  activeQueueJob?: RenderJob | null;
  history: GeneratedMediaItem[];
  onEnqueueI2I: (payload: {
    model: string;
    runner: string;
    prompt: string;
    negativePrompt: string;
    imageDataUrl: string;
    strength: number;
    steps: number;
    guidanceScale: number;
    seed?: number;
    endpoints: RunnerEndpoints;
  }) => Promise<void>;
  onRefreshStorage: () => void;
  onOpenModelPicker: () => void;
  onOpenLanModal: () => void;
  onOpenStorageModal: () => void;
  onSendToI2V: (imageUrl: string, prompt: string) => void;
  onSendToChatPrompt: (imageUrl: string) => void;
}

export function ImageToImageWorkspace({
  model,
  endpoints,
  storageConfig,
  initialImageUrl,
  initialPrompt,
  remixSeed,
  activeQueueJob,
  history,
  onEnqueueI2I,
  onRefreshStorage,
  onOpenModelPicker,
  onOpenLanModal,
  onOpenStorageModal,
  onSendToI2V,
  onSendToChatPrompt,
}: ImageToImageWorkspaceProps) {
  const [sourceImage, setSourceImage] = useState<string>(
    initialImageUrl || STUDIO_SAMPLE_IMAGES[0].url
  );
  const [prompt, setPrompt] = useState(
    initialPrompt ||
      "Transform into warm golden hour sunlight with subtle film grain and crisp architectural reflections"
  );
  const [negativePrompt, setNegativePrompt] = useState(
    "blurry, artifacts, watermark, distorted"
  );
  const [strength, setStrength] = useState(0.55);
  const [steps, setSteps] = useState(12);
  const [guidanceScale, setGuidanceScale] = useState(7.0);
  const [seed, setSeed] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualSavedPath, setManualSavedPath] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialImageUrl) setSourceImage(initialImageUrl);
  }, [initialImageUrl]);

  useEffect(() => {
    if (initialPrompt) setPrompt(initialPrompt);
  }, [initialPrompt]);

  useEffect(() => {
    if (!remixSeed || remixSeed.feature !== "image-to-image") return;
    if (remixSeed.prompt) setPrompt(remixSeed.prompt);
    if (remixSeed.negativePrompt !== undefined) setNegativePrompt(remixSeed.negativePrompt);
    if (remixSeed.strength !== undefined) setStrength(remixSeed.strength);
    if (remixSeed.steps) setSteps(remixSeed.steps);
    if (remixSeed.guidanceScale !== undefined) setGuidanceScale(remixSeed.guidanceScale);
    if (remixSeed.seed !== undefined) setSeed(String(remixSeed.seed));
  }, [remixSeed]);

  const latestItem = history[0] || null;
  const jobIsBusy =
    activeQueueJob?.status === "running" || activeQueueJob?.status === "queued";

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      setSourceImage(dataUrl);
    } catch {
      setSubmitError("Could not read uploaded image.");
    }
    e.target.value = "";
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceImage || !prompt.trim()) return;
    setIsSubmitting(true);
    setSubmitError(null);
    setManualSavedPath(null);

    try {
      const imageDataUrl = await urlToDataUrl(sourceImage);
      const parsedSeed = seed.trim() ? parseInt(seed.trim(), 10) : undefined;
      await onEnqueueI2I({
        model: model.id,
        runner: model.runner,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim(),
        imageDataUrl,
        strength,
        steps,
        guidanceScale,
        seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
        endpoints,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to queue Image-to-Image");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">
            03. Image to Image
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
        <form
          onSubmit={handleGenerate}
          className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
        >
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Reference Image
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                <ImagePlus className="h-3.5 w-3.5" />
                <span>Upload</span>
              </button>
            </div>

            <div className="mt-2 flex gap-2">
              {STUDIO_SAMPLE_IMAGES.map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => setSourceImage(sample.url)}
                  className={`flex-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    sourceImage === sample.url
                      ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                  }`}
                >
                  {sample.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Transformation Prompt
            </label>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
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
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                Denoising Strength
              </span>
              <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                {strength.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min="0.15"
              max="0.95"
              step="0.05"
              value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
              className="mt-2 w-full accent-blue-600"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Steps
              </span>
              <input
                type="number"
                min={1}
                max={50}
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
                min={1}
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
              ? "Queue Another Restyle"
              : "Queue Image to Image"}
          </button>
        </form>

        {/* Comparison Viewport */}
        <div className="flex flex-col gap-5">
          {(submitError || activeQueueJob?.status === "failed") && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-semibold">
                {submitError || activeQueueJob?.error}
              </p>
              {activeQueueJob?.isOffline && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={onOpenLanModal}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-blue-600"
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    <span>Launch Local M5 Worker</span>
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="grid flex-1 gap-4 md:grid-cols-2">
            {/* Source Input */}
            <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Source Reference
                </span>
                <button
                  type="button"
                  onClick={() => onSendToChatPrompt(sourceImage)}
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Extract Prompt in Chat
                </button>
              </div>
              <div className="flex flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
                <img
                  src={withLanTokenUrl(sourceImage)}
                  alt="Source input reference"
                  referrerPolicy="no-referrer"
                  className="max-h-[420px] w-full object-contain"
                />
              </div>
            </div>

            {/* Output Result */}
            <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Transformed Output
                </span>
                {latestItem && !jobIsBusy && (
                  <span className="font-mono text-xs text-slate-500 tabular-nums dark:text-slate-400">
                    {formatDurationMs(latestItem.elapsedMs)}
                  </span>
                )}
              </div>

              <div className="flex flex-1 flex-col items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                {jobIsBusy && activeQueueJob ? (
                  <div className="w-full space-y-3 text-center">
                    {activeQueueJob.previewUrl && (
                      <img
                        src={activeQueueJob.previewUrl}
                        alt="Progressive step preview"
                        className="mx-auto max-h-[340px] w-auto rounded object-contain"
                      />
                    )}
                    <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      {activeQueueJob.status === "queued"
                        ? `Queued #${activeQueueJob.position}`
                        : activeQueueJob.stepLabel}
                    </p>
                    <div className="mx-auto h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <div
                        className="h-full bg-blue-600 transition-all duration-200"
                        style={{ width: `${Math.max(4, activeQueueJob.progressPercent)}%` }}
                      />
                    </div>
                  </div>
                ) : latestItem ? (
                  <img
                    src={withLanTokenUrl(latestItem.outputUrl)}
                    alt={latestItem.prompt}
                    referrerPolicy="no-referrer"
                    className="max-h-[420px] w-full object-contain"
                  />
                ) : (
                  <p className="max-w-xs text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Outputs auto-save to{" "}
                    <span className="font-mono">{storageConfig?.outputDir || "~/M5-MoE-Outputs"}</span>{" "}
                    when run locally.
                  </p>
                )}
              </div>

              {latestItem && !jobIsBusy && (
                <div className="mt-3 space-y-2">
                  {(manualSavedPath || latestItem.savedPath) && (
                    <p className="truncate font-mono text-xs text-emerald-700 dark:text-emerald-400">
                      Saved on M5: {manualSavedPath || latestItem.savedPath}
                    </p>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await apiFetch("/api/outputs/save", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            dataUrl: latestItem.outputUrl,
                            feature: "image-to-image",
                            metadata: {
                              feature: "image-to-image",
                              prompt: latestItem.prompt,
                              negativePrompt: latestItem.negativePrompt,
                              modelUsed: latestItem.modelUsed,
                              runnerUsed: latestItem.runnerUsed,
                              steps: latestItem.steps,
                              guidanceScale: latestItem.guidanceScale,
                              strength: latestItem.strength,
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
                      download={latestItem.savedFileName || `m5-i2i-${latestItem.id}.png`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download PNG</span>
                    </a>
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
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
