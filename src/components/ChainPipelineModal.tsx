import { ArrowRight, ImagePlus, Play, X } from "lucide-react";
import { useRef, useState } from "react";
import { STUDIO_SAMPLE_IMAGES } from "../data/moeDefaults";
import {
  ChainPipelineMode,
  ExecutionMode,
  ExpertConfigMap,
  RunnerEndpoints,
} from "../types/moe";
import { fileToDataUrl, urlToDataUrl } from "../utils/imageHelpers";

interface ChainPipelineModalProps {
  open: boolean;
  onClose: () => void;
  experts: ExpertConfigMap;
  endpoints: RunnerEndpoints;
  executionMode: ExecutionMode;
  onEnqueueChain: (params: {
    mode: ChainPipelineMode;
    prompt: string;
    sourceImageDataUrl?: string;
    numFrames: number;
    fps: number;
    steps: number;
    strength: number;
  }) => Promise<void>;
}

const CHAIN_MODES: Array<{
  id: ChainPipelineMode;
  title: string;
  stages: string;
  needsImage: boolean;
}> = [
  {
    id: "prompt-to-image-to-video",
    title: "Prompt Architect → Text-to-Image → Image-to-Video",
    stages: "Expert 1 (Prompt) → Expert 2 (Keyframes) → Expert 4 (MP4 Motion)",
    needsImage: false,
  },
  {
    id: "image-to-prompt-to-video",
    title: "Image → Prompt → Image-to-Video",
    stages: "Expert 1 (Vision Prompt) → Expert 4 (MP4 Motion)",
    needsImage: true,
  },
  {
    id: "image-to-prompt-to-i2i-video",
    title: "Image → Prompt → Image-to-Image → Image-to-Video",
    stages: "Expert 1 (Vision Prompt) → Expert 3 (Restyle) → Expert 4 (MP4 Motion)",
    needsImage: true,
  },
];

export function ChainPipelineModal({
  open,
  onClose,
  experts,
  executionMode,
  onEnqueueChain,
}: ChainPipelineModalProps) {
  const [mode, setMode] = useState<ChainPipelineMode>("prompt-to-image-to-video");
  const [prompt, setPrompt] = useState(
    "A tranquil moss-covered cedar courtyard in Kyoto during mist rain, cinematic 35mm dolly forward"
  );
  const [sourceImage, setSourceImage] = useState<string>(STUDIO_SAMPLE_IMAGES[0].url);
  const [numFrames, setNumFrames] = useState(25);
  const [fps, setFps] = useState(12);
  const [steps, setSteps] = useState(4);
  const [strength, setStrength] = useState(0.55);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const activeMeta = CHAIN_MODES.find((m) => m.id === mode)!;

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setSourceImage(await fileToDataUrl(file));
    } catch {
      setError("Could not read source image.");
    }
    e.target.value = "";
  }

  async function handleLaunch(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() && !activeMeta.needsImage) return;
    setSubmitting(true);
    setError(null);
    try {
      const sourceImageDataUrl = activeMeta.needsImage
        ? await urlToDataUrl(sourceImage)
        : undefined;
      await onEnqueueChain({
        mode,
        prompt: prompt.trim(),
        sourceImageDataUrl,
        numFrames,
        fps,
        steps,
        strength,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue chained workflow");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="chain-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <h2
              id="chain-modal-title"
              className="text-lg font-bold text-slate-900 dark:text-slate-100"
            >
              One-Click Chained MoE Workflow
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Executes multi-expert stages sequentially inside the FIFO queue, swapping Metal weights cleanly inside 16GB RAM
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chained workflow modal"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleLaunch} className="flex-1 space-y-5 overflow-y-auto p-6">
          <div className="space-y-2">
            <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Select MoE Pipeline
            </span>
            {CHAIN_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`flex w-full items-start justify-between gap-3 rounded-xl border p-3.5 text-left transition-colors ${
                  mode === m.id
                    ? "border-blue-600 bg-blue-50/70 dark:border-blue-500 dark:bg-blue-950/30"
                    : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                }`}
              >
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {m.title}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {m.stages}
                  </p>
                </div>
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
            <p className="font-semibold text-slate-800 dark:text-slate-200">
              Assigned Experts for This Run
            </p>
            <p className="mt-1 font-mono">
              1: {experts.chat.name} ({executionMode === "cloud-preview" ? "Cloud Preview" : experts.chat.runner}) · 2: {experts["text-to-image"].name} · 3: {experts["image-to-image"].name} · 4: {experts["image-to-video"].name}
            </p>
          </div>

          {activeMeta.needsImage && (
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Source Image Input
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
                  <span>Upload Image</span>
                </button>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <img
                  src={sourceImage}
                  alt="Pipeline source"
                  className="h-16 w-24 rounded-lg border border-slate-200 object-cover dark:border-slate-700"
                />
                <div className="flex flex-1 gap-2">
                  {STUDIO_SAMPLE_IMAGES.map((sample) => (
                    <button
                      key={sample.id}
                      type="button"
                      onClick={() => setSourceImage(sample.url)}
                      className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${
                        sourceImage === sample.url
                          ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300"
                          : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"
                      }`}
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              {activeMeta.needsImage ? "Direction / Restyle Guidance" : "Concept Seed Prompt"}
            </label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Diff Steps
              </span>
              <input
                type="number"
                min={1}
                max={40}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Video Frames
              </span>
              <input
                type="number"
                min={8}
                max={49}
                value={numFrames}
                onChange={(e) => setNumFrames(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                FPS
              </span>
              <input
                type="number"
                min={6}
                max={30}
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                I2I Strength
              </span>
              <input
                type="number"
                step="0.05"
                min={0.15}
                max={0.95}
                value={strength}
                onChange={(e) => setStrength(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
          </div>

          {error && (
            <p className="text-xs font-medium text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{submitting ? "Queueing..." : "Run Chained MoE Pipeline"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
