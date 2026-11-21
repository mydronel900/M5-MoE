import {
  Download,
  Film,
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

interface ImageToVideoWorkspaceProps {
  model: AssignedModel;
  endpoints: RunnerEndpoints;
  storageConfig: StorageConfig | null;
  initialImageUrl: string | null;
  initialPrompt: string;
  remixSeed?: SavedOutputMetadata | null;
  activeQueueJob?: RenderJob | null;
  history: GeneratedMediaItem[];
  onEnqueueI2V: (payload: {
    model: string;
    runner: string;
    prompt: string;
    imageDataUrl: string;
    numFrames: number;
    fps: number;
    seed?: number;
    endpoints: RunnerEndpoints;
  }) => Promise<void>;
  onRefreshStorage: () => void;
  onOpenModelPicker: () => void;
  onOpenLanModal: () => void;
  onOpenStorageModal: () => void;
}

export function ImageToVideoWorkspace({
  model,
  endpoints,
  storageConfig,
  initialImageUrl,
  initialPrompt,
  remixSeed,
  activeQueueJob,
  history,
  onEnqueueI2V,
  onRefreshStorage,
  onOpenModelPicker,
  onOpenLanModal,
  onOpenStorageModal,
}: ImageToVideoWorkspaceProps) {
  const [sourceImage, setSourceImage] = useState<string>(
    initialImageUrl || STUDIO_SAMPLE_IMAGES[0].url
  );
  const [prompt, setPrompt] = useState(
    initialPrompt ||
      "Gentle camera push-in as soft forest mist drifts past the cedar pavilion windows, natural swaying pine branches"
  );
  const [numFrames, setNumFrames] = useState(25);
  const [fps, setFps] = useState(12);
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
    if (!remixSeed || remixSeed.feature !== "image-to-video") return;
    if (remixSeed.prompt) setPrompt(remixSeed.prompt);
    if (remixSeed.numFrames) setNumFrames(remixSeed.numFrames);
    if (remixSeed.fps) setFps(remixSeed.fps);
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
      setSubmitError("Could not read keyframe image.");
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
      await onEnqueueI2V({
        model: model.id,
        runner: model.runner,
        prompt: prompt.trim(),
        imageDataUrl,
        numFrames,
        fps,
        seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
        endpoints,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to queue Image-to-Video");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">
            04. Image to Video
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
                Starting Keyframe
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
                <span>Upload Keyframe</span>
              </button>
            </div>

            <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
              <img
                src={withLanTokenUrl(sourceImage)}
                alt="Starting video keyframe"
                referrerPolicy="no-referrer"
                className="h-36 w-full object-cover"
              />
            </div>

            <div className="mt-2 flex gap-2">
              {STUDIO_SAMPLE_IMAGES.map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => setSourceImage(sample.url)}
                  className={`flex-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${
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
              Motion & Camera Prompt
            </label>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe camera movement and motion..."
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Frames
              </span>
              <select
                value={numFrames}
                onChange={(e) => setNumFrames(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                <option value={16}>16</option>
                <option value={25}>25</option>
                <option value={49}>49</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                FPS
              </span>
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                <option value={8}>8</option>
                <option value={12}>12</option>
                <option value={24}>24</option>
              </select>
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
              ? "Queue Another Video"
              : "Queue Video Generation"}
          </button>
        </form>

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

          <div className="flex min-h-[380px] flex-1 flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            {jobIsBusy && activeQueueJob ? (
              <div className="w-full max-w-xl space-y-4 text-center">
                {activeQueueJob.previewUrl && (
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
                    <img
                      src={activeQueueJob.previewUrl}
                      alt="Progressive video diffusion preview"
                      className="mx-auto max-h-[380px] w-auto object-contain"
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
                <video
                  src={withLanTokenUrl(latestItem.outputUrl)}
                  controls
                  loop
                  autoPlay
                  playsInline
                  className="mx-auto max-h-[500px] w-full rounded-lg border border-slate-200 bg-black dark:border-slate-800"
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
                      {latestItem.modelUsed}
                      <span aria-hidden="true"> · </span>
                      {latestItem.numFrames || numFrames} frames @ {latestItem.fps || fps} fps
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
                            feature: "image-to-video",
                            metadata: {
                              feature: "image-to-video",
                              prompt: latestItem.prompt,
                              modelUsed: latestItem.modelUsed,
                              runnerUsed: latestItem.runnerUsed,
                              numFrames: latestItem.numFrames,
                              fps: latestItem.fps,
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
                      download={latestItem.savedFileName || `m5-i2v-${latestItem.id}.mp4`}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download MP4</span>
                    </a>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex max-w-md flex-col items-center text-center">
                <Film className="h-8 w-8 text-slate-300 dark:text-slate-700" />
                <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
                  Local Image-to-Video Viewport
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Jobs queue single-file for M5 16GB RAM with live previews and save to{" "}
                  <span className="font-mono">{storageConfig?.outputDir || "~/M5-MoE-Outputs"}</span>.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
