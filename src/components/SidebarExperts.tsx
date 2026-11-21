import {
  CheckCircle2,
  Cpu,
  FolderOpen,
  HardDrive,
  Moon,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { EXPERT_META } from "../data/moeDefaults";
import {
  ExecutionMode,
  ExpertConfigMap,
  ExpertFeatureId,
  StorageConfig,
  SystemInfoResponse,
} from "../types/moe";

interface SidebarExpertsProps {
  activeFeature: ExpertFeatureId;
  onSelectFeature: (feature: ExpertFeatureId) => void;
  experts: ExpertConfigMap;
  onConfigureExpert: (feature: ExpertFeatureId) => void;
  onOpenChainModal: () => void;
  onUnloadWorker: () => void;
  isUnloadingWorker: boolean;
  swapStrategy: "auto-swap" | "resident";
  onChangeSwapStrategy: (strategy: "auto-swap" | "resident") => void;
  executionMode: ExecutionMode;
  onChangeExecutionMode: (mode: ExecutionMode) => void;
  systemInfo: SystemInfoResponse | null;
  onRefreshSystemInfo: () => void;
  isRefreshingSystem: boolean;
  storageConfig: StorageConfig | null;
  onOpenStorageModal: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const FEATURES: ExpertFeatureId[] = [
  "chat",
  "text-to-image",
  "image-to-image",
  "image-to-video",
];

export function SidebarExperts({
  activeFeature,
  onSelectFeature,
  experts,
  onConfigureExpert,
  onOpenChainModal,
  onUnloadWorker,
  isUnloadingWorker,
  swapStrategy,
  onChangeSwapStrategy,
  executionMode,
  onChangeExecutionMode,
  systemInfo,
  onRefreshSystemInfo,
  isRefreshingSystem,
  storageConfig,
  onOpenStorageModal,
  darkMode,
  onToggleDarkMode,
  mobileOpen,
  onCloseMobile,
}: SidebarExpertsProps) {
  const osReserveGb = 4.2;
  const activeExpert = experts[activeFeature];
  const totalResidentRamGb = FEATURES.reduce(
    (sum, id) => sum + experts[id].estimatedRamGb,
    0
  );
  const projectedRamGb =
    swapStrategy === "auto-swap"
      ? Math.round((osReserveGb + activeExpert.estimatedRamGb) * 10) / 10
      : Math.round((osReserveGb + totalResidentRamGb) * 10) / 10;

  const memoryPercent = Math.min(100, Math.round((projectedRamGb / 16) * 100));
  const exceeds16Gb = projectedRamGb > 15.2;

  const onlineRunnerCount =
    systemInfo?.runners.filter((r) => r.online).length ?? 0;

  const content = (
    <div className="flex h-full flex-col justify-between overflow-y-auto p-4">
      <div className="space-y-6">
        {/* Mobile header close */}
        <div className="flex items-center justify-between lg:hidden">
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            MoE Expert Router
          </span>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close sidebar"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Dedicated Expert Assignments */}
        <section aria-labelledby="experts-heading">
          <div className="mb-2.5 flex items-center justify-between">
            <h2
              id="experts-heading"
              className="text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400"
            >
              Dedicated MoE Experts
            </h2>
            <span className="font-mono text-xs text-slate-400 tabular-nums dark:text-slate-500">
              4 slots
            </span>
          </div>

          <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {FEATURES.map((id) => {
              const meta = EXPERT_META[id];
              const assigned = experts[id];
              const isActive = activeFeature === id;
              return (
                <div
                  key={id}
                  className={`p-3 transition-colors ${
                    isActive
                      ? "bg-blue-50/70 dark:bg-blue-950/30"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectFeature(id);
                        onCloseMobile();
                      }}
                      className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-blue-600"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs text-slate-400 tabular-nums dark:text-slate-500">
                          {meta.index}.
                        </span>
                        <span
                          className={`truncate text-sm font-semibold ${
                            isActive
                              ? "text-blue-700 dark:text-blue-400"
                              : "text-slate-900 dark:text-slate-100"
                          }`}
                        >
                          {meta.shortLabel}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-slate-700 dark:text-slate-300">
                        {assigned.name}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                        {assigned.source === "huggingface" ? "HF Hub" : "Local"}
                        <span aria-hidden="true"> · </span>
                        {assigned.quantization}
                        <span aria-hidden="true"> · </span>
                        {assigned.estimatedRamGb.toFixed(1)} GB
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => onConfigureExpert(id)}
                      title={`Select model for ${meta.shortLabel}`}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                      <SlidersHorizontal className="h-3 w-3" />
                      <span>Model</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* M5 MacBook Air 16GB Unified Memory Budget */}
        <section
          aria-labelledby="memory-heading"
          className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-slate-600 dark:text-slate-400" />
              <h2
                id="memory-heading"
                className="text-xs font-semibold text-slate-900 dark:text-slate-100"
              >
                M5 16GB Unified Memory
              </h2>
            </div>
            <span
              className={`font-mono text-xs font-semibold tabular-nums ${
                exceeds16Gb
                  ? "text-red-600 dark:text-red-400"
                  : "text-slate-700 dark:text-slate-300"
              }`}
            >
              {projectedRamGb.toFixed(1)} / 16.0 GB
            </span>
          </div>

          <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className={`h-full transition-all duration-200 ${
                exceeds16Gb
                  ? "bg-red-600"
                  : memoryPercent > 80
                  ? "bg-amber-500"
                  : "bg-blue-600"
              }`}
              style={{ width: `${memoryPercent}%` }}
            />
          </div>

          <p className="mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {swapStrategy === "auto-swap"
              ? `Swaps idle experts off Metal cache so ${activeExpert.name} runs cleanly inside 16GB.`
              : "Keeping all 4 experts resident exceeds 16GB unified memory."}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => onChangeSwapStrategy("auto-swap")}
              className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                swapStrategy === "auto-swap"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Auto-Swap
            </button>
            <button
              type="button"
              onClick={() => onChangeSwapStrategy("resident")}
              className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                swapStrategy === "resident"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Keep Resident
            </button>
          </div>
        </section>

        {/* Execution Mode & Privacy Boundary */}
        <section
          aria-labelledby="privacy-heading"
          className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-slate-600 dark:text-slate-400" />
              <h2
                id="privacy-heading"
                className="text-xs font-semibold text-slate-900 dark:text-slate-100"
              >
                Execution Target
              </h2>
            </div>
            <button
              type="button"
              onClick={onRefreshSystemInfo}
              title="Re-probe local M5 runners"
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isRefreshingSystem ? "animate-spin" : ""}`}
              />
            </button>
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            <button
              type="button"
              onClick={() => onChangeExecutionMode("local")}
              className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                executionMode === "local"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Local M5 Only
            </button>
            <button
              type="button"
              onClick={() => onChangeExecutionMode("cloud-preview")}
              disabled={!systemInfo?.geminiPreviewAvailable}
              className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-50 ${
                executionMode === "cloud-preview"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Cloud Preview
            </button>
          </div>

          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
            {onlineRunnerCount > 0 ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span>
              {executionMode === "cloud-preview"
                ? "Cloud Preview active for Chat & Image-to-Prompt"
                : onlineRunnerCount > 0
                ? `${onlineRunnerCount} local runner active`
                : "No local M5 runner detected yet"}
            </span>
          </div>
        </section>

        {/* Local Output Folder */}
        <section
          aria-labelledby="storage-heading"
          className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-slate-600 dark:text-slate-400" />
              <h2
                id="storage-heading"
                className="text-xs font-semibold text-slate-900 dark:text-slate-100"
              >
                Local Output Folder
              </h2>
            </div>
            <span className="font-mono text-xs text-slate-500 tabular-nums dark:text-slate-400">
              {storageConfig ? `${storageConfig.fileCount} files` : "..."}
            </span>
          </div>

          <p className="mt-2 truncate font-mono text-xs text-slate-700 dark:text-slate-300" title={storageConfig?.outputDir}>
            {storageConfig?.outputDir || "~/M5-MoE-Outputs"}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {storageConfig?.autoSaveToDisk
              ? "Auto-save to Mac drive enabled"
              : "Manual save/download mode"}
          </p>

          <button
            type="button"
            onClick={() => {
              onOpenStorageModal();
              onCloseMobile();
            }}
            className="mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Change Folder & Saved Files
          </button>
        </section>
      </div>

      {/* Bottom Theme Switch */}
      <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-800">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {systemInfo ? `${systemInfo.arch} · ${systemInfo.totalMemoryGb} GB host` : "Apple Silicon M5"}
        </span>
        <button
          type="button"
          onClick={onToggleDarkMode}
          aria-label={darkMode ? "Switch to light theme" : "Switch to dark theme"}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {darkMode ? (
            <>
              <Sun className="h-3.5 w-3.5" />
              <span>Light</span>
            </>
          ) : (
            <>
              <Moon className="h-3.5 w-3.5" />
              <span>Dark</span>
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="hidden w-72 shrink-0 border-r border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-950 lg:block">
        {content}
      </aside>

      {/* Mobile slide-over drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs"
            onClick={onCloseMobile}
          />
          <aside className="relative z-10 w-80 max-w-[85vw] bg-slate-50 shadow-xl dark:bg-slate-950">
            {content}
          </aside>
        </div>
      )}
    </>
  );
}
