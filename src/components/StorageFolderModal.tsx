import {
  ArrowRight,
  Check,
  Download,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SavedDiskFile, StorageConfig } from "../types/moe";
import { apiFetch, withLanTokenUrl } from "../utils/apiClient";

interface StorageFolderModalProps {
  open: boolean;
  onClose: () => void;
  storageConfig: StorageConfig | null;
  onUpdateStorageConfig: (config: StorageConfig) => void;
  onSendImageToI2I: (imageUrl: string) => void;
  onSendImageToI2V: (imageUrl: string) => void;
  onRemixFile: (file: SavedDiskFile) => void;
}

const FOLDER_PRESETS = [
  { label: "~/M5-MoE-Outputs", path: "~/M5-MoE-Outputs" },
  { label: "~/Pictures/M5-MoE", path: "~/Pictures/M5-MoE" },
  { label: "~/Movies/M5-MoE", path: "~/Movies/M5-MoE" },
  { label: "~/Desktop/M5-MoE", path: "~/Desktop/M5-MoE" },
  { label: "~/Downloads/M5-MoE", path: "~/Downloads/M5-MoE" },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function StorageFolderModal({
  open,
  onClose,
  storageConfig,
  onUpdateStorageConfig,
  onSendImageToI2I,
  onSendImageToI2V,
  onRemixFile,
}: StorageFolderModalProps) {
  const [draftDir, setDraftDir] = useState(storageConfig?.outputDir || "~/M5-MoE-Outputs");
  const [autoSave, setAutoSave] = useState(storageConfig?.autoSaveToDisk ?? true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ text: string; isError?: boolean } | null>(null);

  const [files, setFiles] = useState<SavedDiskFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filterType, setFilterType] = useState<"all" | "images" | "videos">("all");

  useEffect(() => {
    if (!open) return;
    if (storageConfig) {
      setDraftDir(storageConfig.outputDir);
      setAutoSave(storageConfig.autoSaveToDisk);
    }
    setSaveMessage(null);
    void fetchSavedFiles();
  }, [open, storageConfig?.outputDir]);

  async function fetchSavedFiles() {
    setLoadingFiles(true);
    try {
      const res = await apiFetch("/api/outputs/list");
      if (res.ok) {
        const data = (await res.json()) as { files?: SavedDiskFile[] };
        setFiles(data.files || []);
      }
    } catch {
      // ignore
    } finally {
      setLoadingFiles(false);
    }
  }

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await apiFetch("/api/storage/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outputDir: draftDir.trim(),
          autoSaveToDisk: autoSave,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMessage({ text: data.error || "Failed to update folder", isError: true });
      } else {
        onUpdateStorageConfig(data as StorageConfig);
        setDraftDir(data.outputDir);
        setSaveMessage({ text: `Saved output folder: ${data.outputDir}` });
        void fetchSavedFiles();
      }
    } catch {
      setSaveMessage({ text: "Network error updating output folder", isError: true });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteFile(name: string) {
    try {
      const res = await apiFetch(`/api/outputs/file?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setFiles((prev) => prev.filter((f) => f.name !== name));
        const cfgRes = await apiFetch("/api/storage/config");
        if (cfgRes.ok) {
          onUpdateStorageConfig((await cfgRes.json()) as StorageConfig);
        }
      }
    } catch {
      // ignore
    }
  }

  if (!open) return null;

  const filteredFiles = files.filter((f) => {
    if (filterType === "images") return !f.isVideo;
    if (filterType === "videos") return f.isVideo;
    return true;
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="storage-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <h2
              id="storage-modal-title"
              className="text-lg font-bold text-slate-900 dark:text-slate-100"
            >
              Local Output Folder & Saved Media
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Configure where generated PNG images and MP4 videos are stored on your M5 Mac drive and download files across LAN devices
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close storage modal"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Folder Configuration Form */}
          <form
            onSubmit={handleSaveConfig}
            className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/60"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-slate-700 dark:text-slate-300" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  M5 Mac Storage Directory
                </h3>
              </div>
              {storageConfig && (
                <span className="font-mono text-xs text-slate-500 tabular-nums dark:text-slate-400">
                  {storageConfig.fileCount} files · {storageConfig.totalSizeMb.toFixed(2)} MB ·{" "}
                  <span
                    className={
                      storageConfig.writable
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                    }
                  >
                    {storageConfig.writable ? "Writable" : "Read-only"}
                  </span>
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={draftDir}
                onChange={(e) => setDraftDir(e.target.value)}
                placeholder="~/M5-MoE-Outputs or /Volumes/ExternalSSD/AI-Outputs"
                aria-label="Local output directory path"
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                disabled={saving || !draftDir.trim()}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap"
              >
                <Check className="h-3.5 w-3.5" />
                <span>{saving ? "Saving..." : "Apply Folder"}</span>
              </button>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Quick folders:
              </span>
              {FOLDER_PRESETS.map((preset) => (
                <button
                  key={preset.path}
                  type="button"
                  onClick={() => setDraftDir(preset.path)}
                  className="rounded border border-slate-200 bg-white px-2 py-0.5 font-mono text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <label className="mt-3 flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={autoSave}
                onChange={(e) => setAutoSave(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-blue-600"
              />
              <span>
                Automatically save every generated image & video to this local folder
              </span>
            </label>

            {saveMessage && (
              <p
                className={`mt-2.5 text-xs font-medium ${
                  saveMessage.isError
                    ? "text-red-600 dark:text-red-400"
                    : "text-emerald-700 dark:text-emerald-400"
                }`}
              >
                {saveMessage.text}
              </p>
            )}
          </form>

          {/* Saved Files Gallery */}
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                {(
                  [
                    { id: "all", label: `All (${files.length})` },
                    { id: "images", label: `Images (${files.filter((f) => !f.isVideo).length})` },
                    { id: "videos", label: `Videos (${files.filter((f) => f.isVideo).length})` },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setFilterType(tab.id)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      filterType === tab.id
                        ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                        : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => void fetchSavedFiles()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingFiles ? "animate-spin" : ""}`} />
                <span>Refresh Folder</span>
              </button>
            </div>

            {filteredFiles.length === 0 ? (
              <div className="rounded-xl border border-slate-200 p-8 text-center dark:border-slate-800">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  No saved files in {storageConfig?.outputDir || "~/M5-MoE-Outputs"} yet
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Generated images and videos appear here automatically and can be downloaded from any device on your LAN.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredFiles.map((file) => (
                  <div
                    key={file.name}
                    className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
                  >
                    <div className="aspect-video w-full overflow-hidden bg-slate-100 dark:bg-slate-900">
                      {file.isVideo ? (
                        <video
                          src={file.url}
                          controls
                          playsInline
                          className="h-full w-full object-contain bg-black"
                        />
                      ) : (
                        <img
                          src={file.url}
                          alt={file.name}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>

                    <div className="flex flex-1 flex-col justify-between p-3">
                      <div>
                        <p className="truncate font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                          {file.name}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                          {file.feature} · {formatBytes(file.sizeBytes)}
                        </p>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <a
                          href={file.downloadUrl}
                          download={file.name}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500"
                        >
                          <Download className="h-3 w-3" />
                          <span>Download</span>
                        </a>

                        {!file.isVideo && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                onSendImageToI2I(file.url);
                                onClose();
                              }}
                              title="Send to Image-to-Image"
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                              <span>I2I</span>
                              <ArrowRight className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                onSendImageToI2V(file.url);
                                onClose();
                              }}
                              title="Animate in Image-to-Video"
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                              <span>I2V</span>
                              <ArrowRight className="h-3 w-3" />
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          onClick={() => void handleDeleteFile(file.name)}
                          aria-label={`Delete ${file.name}`}
                          className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
