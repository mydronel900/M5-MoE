import {
  Check,
  Download,
  FolderOpen,
  Search,
  Server,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { CURATED_M5_PRESETS, EXPERT_META } from "../data/moeDefaults";
import {
  AssignedModel,
  ExpertFeatureId,
  HuggingFaceModelItem,
  LocalModelItem,
  RunnerBackend,
  RunnerEndpoints,
} from "../types/moe";
import { formatDownloads } from "../utils/imageHelpers";

interface ModelPickerModalProps {
  feature: ExpertFeatureId | null;
  currentModel: AssignedModel | null;
  endpoints: RunnerEndpoints;
  onClose: () => void;
  onAssignModel: (feature: ExpertFeatureId, model: AssignedModel) => void;
}

const RUNNER_OPTIONS: Array<{ id: RunnerBackend; label: string }> = [
  { id: "mlx-worker", label: "M5 MLX Worker (:8787)" },
  { id: "ollama", label: "Ollama (:11434)" },
  { id: "openai-local", label: "MLX / LM Studio (:8080)" },
  { id: "a1111", label: "A1111 / Forge (:7860)" },
  { id: "comfyui", label: "ComfyUI (:8188)" },
];

export function ModelPickerModal({
  feature,
  currentModel,
  endpoints,
  onClose,
  onAssignModel,
}: ModelPickerModalProps) {
  const [sourceTab, setSourceTab] = useState<"huggingface" | "local">(
    "huggingface"
  );
  const [query, setQuery] = useState("");
  const [hfResults, setHfResults] = useState<HuggingFaceModelItem[]>([]);
  const [hfLoading, setHfLoading] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);

  const [localModels, setLocalModels] = useState<LocalModelItem[]>([]);
  const [localLoading, setLocalLoading] = useState(false);

  const [selectedRunner, setSelectedRunner] = useState<RunnerBackend>(
    currentModel?.runner || "mlx-worker"
  );
  const [customModelId, setCustomModelId] = useState("");
  const [customRamGb, setCustomRamGb] = useState("5.5");
  const [pullStatus, setPullStatus] = useState<{
    modelId: string;
    message: string;
    command?: string;
    isError?: boolean;
  } | null>(null);
  const [pullingId, setPullingId] = useState<string | null>(null);

  useEffect(() => {
    if (!feature) return;
    setSelectedRunner(currentModel?.runner || "mlx-worker");
    setSourceTab(currentModel?.source || "huggingface");
    setPullStatus(null);
    setHfError(null);
    setQuery("");
    // Load curated presets first, then fetch live HF search
    setHfResults(CURATED_M5_PRESETS[feature]);
    void searchHuggingFace(EXPERT_META[feature].defaultSearchQuery, feature);
    void fetchLocalModels();
  }, [feature]);

  if (!feature || !currentModel) return null;

  const meta = EXPERT_META[feature];

  async function searchHuggingFace(searchTerm: string, feat: ExpertFeatureId) {
    setHfLoading(true);
    setHfError(null);
    try {
      const params = new URLSearchParams({
        q: searchTerm,
        feature: feat,
        limit: "16",
      });
      const res = await fetch(`/api/hf/search?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setHfError(data.error || "Could not search Hugging Face Hub");
      } else if (Array.isArray(data.models) && data.models.length > 0) {
        setHfResults(data.models);
      } else {
        setHfResults([]);
      }
    } catch {
      setHfError("Network error contacting Hugging Face Hub");
    } finally {
      setHfLoading(false);
    }
  }

  async function fetchLocalModels() {
    setLocalLoading(true);
    try {
      const params = new URLSearchParams({
        mlxWorkerUrl: endpoints.mlxWorkerUrl,
        ollamaUrl: endpoints.ollamaUrl,
      });
      const res = await fetch(`/api/local/models?${params.toString()}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.models)) {
        setLocalModels(data.models);
      }
    } catch {
      setLocalModels([]);
    } finally {
      setLocalLoading(false);
    }
  }

  async function handlePullModel(modelId: string) {
    setPullingId(modelId);
    setPullStatus(null);
    try {
      const res = await fetch("/api/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId,
          runner: selectedRunner,
          endpoints,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPullStatus({
          modelId,
          message: data.error || "Pull failed",
          command: data.command,
          isError: true,
        });
      } else {
        setPullStatus({
          modelId,
          message: `Downloaded ${modelId} to local M5 cache.`,
        });
        void fetchLocalModels();
      }
    } catch {
      setPullStatus({
        modelId,
        message: "Could not reach backend to pull model.",
        isError: true,
      });
    } finally {
      setPullingId(null);
    }
  }

  function assignHfModel(item: HuggingFaceModelItem) {
    onAssignModel(feature!, {
      id: item.id,
      name: item.name,
      source: "huggingface",
      runner: selectedRunner,
      quantization: item.quantization,
      estimatedRamGb: item.estimatedRamGb,
      pipelineTag: item.pipelineTag,
    });
    onClose();
  }

  function assignLocalModel(item: LocalModelItem) {
    onAssignModel(feature!, {
      id: item.id,
      name: item.name,
      source: "local",
      runner: item.runner,
      quantization: item.sourceType === "ollama" ? "GGUF Q4" : "Local Weights",
      estimatedRamGb: item.sizeGb ? Math.round((item.sizeGb + 1.0) * 10) / 10 : 5.0,
      localPath: item.path,
      pipelineTag: meta.pipelineTag,
    });
    onClose();
  }

  function assignCustomLocal(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = customModelId.trim();
    if (!trimmed) return;
    onAssignModel(feature!, {
      id: trimmed,
      name: trimmed.split("/").pop() || trimmed,
      source: trimmed.startsWith("/") || trimmed.startsWith("~") ? "local" : sourceTab,
      runner: selectedRunner,
      quantization: "Custom",
      estimatedRamGb: Math.max(0.5, parseFloat(customRamGb) || 5.5),
      localPath: trimmed.startsWith("/") || trimmed.startsWith("~") ? trimmed : undefined,
      pipelineTag: meta.pipelineTag,
    });
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="model-picker-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Expert {meta.index} · {meta.pipelineTag}
            </p>
            <h2
              id="model-picker-title"
              className="mt-0.5 text-lg font-bold text-slate-900 dark:text-slate-100"
            >
              Assign Dedicated Model: {meta.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close model picker"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Runner & Source Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-6 py-3 dark:border-slate-800 dark:bg-slate-950/50">
          <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setSourceTab("huggingface")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                sourceTab === "huggingface"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Hugging Face Hub
            </button>
            <button
              type="button"
              onClick={() => {
                setSourceTab("local");
                void fetchLocalModels();
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                sourceTab === "local"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Local Disk & Ollama
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400">
            <Server className="h-3.5 w-3.5" />
            <span>Runner:</span>
            <select
              value={selectedRunner}
              onChange={(e) => setSelectedRunner(e.target.value as RunnerBackend)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              {RUNNER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {sourceTab === "huggingface" ? (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void searchHuggingFace(query, feature);
                }}
                className="flex gap-2"
              >
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Search Hugging Face (${meta.defaultSearchQuery})...`}
                    className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </div>
                <button
                  type="submit"
                  disabled={hfLoading}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  {hfLoading ? "Searching..." : "Search Hub"}
                </button>
                <button
                  type="button"
                  onClick={() => setHfResults(CURATED_M5_PRESETS[feature])}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  M5 16GB Picks
                </button>
              </form>

              {hfError && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                  {hfError}. Showing curated Apple Silicon M5 presets below.
                </div>
              )}

              {pullStatus && (
                <div
                  className={`rounded-lg border p-3 text-xs ${
                    pullStatus.isError
                      ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
                      : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200"
                  }`}
                >
                  <p className="font-medium">{pullStatus.message}</p>
                  {pullStatus.command && (
                    <code className="mt-1.5 block rounded bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-100">
                      {pullStatus.command}
                    </code>
                  )}
                </div>
              )}

              <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {hfResults.length === 0 && !hfLoading ? (
                  <div className="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
                    No models matched your search. Try searching `mlx-community` or load M5 16GB Picks.
                  </div>
                ) : (
                  hfResults.map((m) => {
                    const isSelected = currentModel.id === m.id;
                    return (
                      <div
                        key={m.id}
                        className="flex flex-col justify-between gap-3 p-3.5 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                              {m.id}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                            {formatDownloads(m.downloads)} downloads
                            <span aria-hidden="true"> · </span>
                            {m.quantization}
                            <span aria-hidden="true"> · </span>
                            ~{m.estimatedRamGb.toFixed(1)} GB RAM
                            <span aria-hidden="true"> · </span>
                            <span
                              className={
                                m.fits16Gb === "comfortable"
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : m.fits16Gb === "tight"
                                  ? "text-amber-700 dark:text-amber-400"
                                  : "text-red-700 dark:text-red-400"
                              }
                            >
                              {m.fits16Gb === "comfortable"
                                ? "Fits 16GB M5"
                                : m.fits16Gb === "tight"
                                ? "Tight on 16GB"
                                : "Exceeds 16GB"}
                            </span>
                          </p>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handlePullModel(m.id)}
                            disabled={pullingId === m.id}
                            title="Pull weights to M5 local cache"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>{pullingId === m.id ? "Pulling..." : "Pull"}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => assignHfModel(m)}
                            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                              isSelected
                                ? "bg-emerald-600 text-white"
                                : "bg-blue-600 text-white hover:bg-blue-500"
                            }`}
                          >
                            {isSelected && <Check className="h-3.5 w-3.5" />}
                            <span>{isSelected ? "Assigned" : "Assign"}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Scanned <code className="font-mono">~/.cache/huggingface/hub</code>,{" "}
                  <code className="font-mono">~/Models</code>, Ollama, and M5 MLX Worker.
                </p>
                <button
                  type="button"
                  onClick={() => void fetchLocalModels()}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {localLoading ? "Scanning..." : "Rescan Local"}
                </button>
              </div>

              <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {localModels.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 p-8 text-center">
                    <FolderOpen className="h-6 w-6 text-slate-400" />
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      No local cached weights detected on this host
                    </p>
                    <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
                      When running on your M5 MacBook Air, downloaded Hugging Face snapshots and Ollama models appear here automatically. You can also enter a local path or Ollama tag below.
                    </p>
                  </div>
                ) : (
                  localModels.map((item) => {
                    const isSelected = currentModel.id === item.id;
                    return (
                      <div
                        key={`${item.sourceType}-${item.id}`}
                        className="flex items-center justify-between gap-3 p-3.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {item.id}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-slate-500 tabular-nums dark:text-slate-400">
                            {item.sourceType}
                            <span aria-hidden="true"> · </span>
                            {item.sizeGb !== null ? `${item.sizeGb.toFixed(2)} GB` : "Size unknown"}
                            <span aria-hidden="true"> · </span>
                            {item.path}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => assignLocalModel(item)}
                          className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap ${
                            isSelected
                              ? "bg-emerald-600 text-white"
                              : "bg-blue-600 text-white hover:bg-blue-500"
                          }`}
                        >
                          {isSelected ? "Assigned" : "Use Local"}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Custom Model ID or Local Directory Path */}
          <form
            onSubmit={assignCustomLocal}
            className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/60"
          >
            <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Custom Local Path, Ollama Tag, or Hugging Face Repo ID
            </h3>
            <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={customModelId}
                onChange={(e) => setCustomModelId(e.target.value)}
                placeholder="e.g. qwen2.5-vl:7b or /Users/you/Models/flux-4bit"
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <input
                type="number"
                step="0.1"
                min="0.5"
                max="16"
                value={customRamGb}
                onChange={(e) => setCustomRamGb(e.target.value)}
                aria-label="Estimated RAM in GB"
                className="w-24 rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                Assign Custom
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
