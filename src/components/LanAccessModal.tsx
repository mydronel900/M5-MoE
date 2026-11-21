import { Check, Copy, Download, Laptop, Lock, Smartphone, Terminal, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { LanAuthStatus, RunnerEndpoints, SystemInfoResponse } from "../types/moe";
import { apiFetch } from "../utils/apiClient";

interface LanAccessModalProps {
  open: boolean;
  onClose: () => void;
  systemInfo: SystemInfoResponse | null;
  endpoints: RunnerEndpoints;
  onSaveEndpoints: (endpoints: RunnerEndpoints) => void;
  onRefreshSystemInfo: () => void;
  authStatus: LanAuthStatus | null;
  onUpdateAuthStatus: (status: LanAuthStatus, token?: string) => void;
}

export function LanAccessModal({
  open,
  onClose,
  systemInfo,
  endpoints,
  onSaveEndpoints,
  onRefreshSystemInfo,
  authStatus,
  onUpdateAuthStatus,
}: LanAccessModalProps) {
  const [selectedUrl, setSelectedUrl] = useState("");
  const [qrSvg, setQrSvg] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [draftEndpoints, setDraftEndpoints] = useState<RunnerEndpoints>(endpoints);
  const [pinDraft, setPinDraft] = useState("");
  const [pinSaving, setPinSaving] = useState(false);
  const [pinNotice, setPinNotice] = useState<{ text: string; isError?: boolean } | null>(null);

  useEffect(() => {
    setDraftEndpoints(endpoints);
  }, [endpoints]);

  useEffect(() => {
    if (!open) return;
    const primary =
      systemInfo?.lanAddresses[0]?.url ||
      systemInfo?.mdnsUrl ||
      (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");
    setSelectedUrl(primary);
    setPinNotice(null);
  }, [open, systemInfo]);

  useEffect(() => {
    if (!selectedUrl) return;
    QRCode.toString(selectedUrl, {
      type: "svg",
      width: 168,
      margin: 1,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((svg) => setQrSvg(svg))
      .catch(() => setQrSvg(""));
  }, [selectedUrl]);

  if (!open) return null;

  const installCommand =
    "python3 -m venv .venv && source .venv/bin/activate && pip install fastapi uvicorn pillow pydantic huggingface_hub mlx-lm mlx-vlm mflux diffusers transformers accelerate torch 'imageio[ffmpeg]' && python3 scripts/m5_mlx_worker.py";

  async function copyText(text: string, which: "url" | "cmd") {
    try {
      await navigator.clipboard.writeText(text);
      if (which === "url") {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 1800);
      } else {
        setCopiedCmd(true);
        setTimeout(() => setCopiedCmd(false), 1800);
      }
    } catch {
      // ignore clipboard restrictions
    }
  }

  async function handleConfigurePin(enable: boolean) {
    if (enable && !/^\d{4}$/.test(pinDraft)) {
      setPinNotice({ text: "Enter a 4-digit numeric PIN.", isError: true });
      return;
    }
    setPinSaving(true);
    setPinNotice(null);
    try {
      const res = await apiFetch("/api/auth/configure-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: enable,
          pin: enable ? pinDraft : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPinNotice({ text: data.error || "Failed to update PIN.", isError: true });
      } else {
        onUpdateAuthStatus(
          {
            lanPinEnabled: Boolean(data.lanPinEnabled),
            authenticated: Boolean(data.authenticated),
            isLocalhost: Boolean(data.isLocalhost),
            requiresPin: Boolean(data.requiresPin),
          },
          data.token
        );
        setPinDraft("");
        setPinNotice({
          text: enable
            ? "4-digit LAN Access PIN enabled for remote Wi-Fi devices."
            : "LAN Access PIN disabled.",
        });
      }
    } catch {
      setPinNotice({ text: "Could not save LAN PIN setting.", isError: true });
    } finally {
      setPinSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lan-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <h2
              id="lan-modal-title"
              className="text-lg font-bold text-slate-900 dark:text-slate-100"
            >
              Local LAN Access & M5 Apple Silicon Setup
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Server bound to <code className="font-mono">0.0.0.0:{systemInfo?.port ?? 3000}</code> for devices on the same Wi-Fi network
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close LAN Access modal"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* LAN QR + Addresses */}
          <div className="grid gap-6 md:grid-cols-[184px_1fr]">
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700">
              {qrSvg ? (
                <div
                  className="h-40 w-40"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
              ) : (
                <div className="flex h-40 w-40 items-center justify-center text-xs text-slate-400">
                  Generating QR...
                </div>
              )}
              <span className="mt-2 flex items-center gap-1 text-xs font-medium text-slate-600">
                <Smartphone className="h-3.5 w-3.5" />
                Scan on Phone / iPad
              </span>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Local Network Endpoints
                </h3>
                <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                  {systemInfo?.hostname || "macbook-air"}.local
                </span>
              </div>

              <div className="space-y-2">
                {systemInfo?.lanAddresses.map((lan) => (
                  <button
                    key={lan.address}
                    type="button"
                    onClick={() => setSelectedUrl(lan.url)}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      selectedUrl === lan.url
                        ? "border-blue-600 bg-blue-50/70 text-blue-900 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-100"
                        : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
                    }`}
                  >
                    <span className="font-mono font-semibold">{lan.url}</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      {lan.interfaceName}
                    </span>
                  </button>
                ))}
                {systemInfo?.mdnsUrl && (
                  <button
                    type="button"
                    onClick={() => setSelectedUrl(systemInfo.mdnsUrl)}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      selectedUrl === systemInfo.mdnsUrl
                        ? "border-blue-600 bg-blue-50/70 text-blue-900 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-100"
                        : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
                    }`}
                  >
                    <span className="font-mono font-semibold">{systemInfo.mdnsUrl}</span>
                    <span className="text-slate-500 dark:text-slate-400">Bonjour mDNS</span>
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  readOnly
                  value={selectedUrl}
                  aria-label="Selected LAN URL"
                  className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => void copyText(selectedUrl, "url")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap dark:bg-blue-600 dark:hover:bg-blue-500"
                >
                  {copiedUrl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedUrl ? "Copied" : "Copy URL"}</span>
                </button>
              </div>
            </div>
          </div>

          {/* M5 Local Worker Download & Launch */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/60">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Laptop className="h-4 w-4 text-slate-700 dark:text-slate-300" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  M5 MacBook Air (16GB) Local MLX & MPS Worker
                </h3>
              </div>
              <a
                href="/api/worker/script"
                download="m5_mlx_worker.py"
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Download m5_mlx_worker.py</span>
              </a>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              Runs all 4 dedicated models natively on your M5 processor via Apple MLX & PyTorch MPS, automatically clearing Metal cache when swapping experts so 16GB Unified Memory stays fast and private.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <div className="flex flex-1 items-center gap-2 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100">
                <Terminal className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="truncate">{installCommand}</span>
              </div>
              <button
                type="button"
                onClick={() => void copyText(installCommand, "cmd")}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                {copiedCmd ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copiedCmd ? "Copied" : "Copy"}</span>
              </button>
            </div>
          </div>

          {/* Optional 4-Digit LAN Access PIN */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950/60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-slate-700 dark:text-slate-300" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Optional 4-Digit LAN Access PIN
                </h3>
              </div>
              <span
                className={`font-mono text-xs font-medium ${
                  authStatus?.lanPinEnabled
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {authStatus?.lanPinEnabled ? "PIN Active" : "Open on Local Wi-Fi"}
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              Require a 4-digit passcode for remote phones/tablets on shared Wi-Fi before they can queue M5 GPU jobs or browse your output folder. Localhost on your Mac remains seamless.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="4-digit PIN"
                aria-label="New 4-digit LAN Access PIN"
                className="w-32 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-center font-mono text-xs tracking-widest text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                disabled={pinSaving || pinDraft.length !== 4}
                onClick={() => void handleConfigurePin(true)}
                className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                {authStatus?.lanPinEnabled ? "Update PIN" : "Enable PIN"}
              </button>
              {authStatus?.lanPinEnabled && (
                <button
                  type="button"
                  disabled={pinSaving}
                  onClick={() => void handleConfigurePin(false)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Disable PIN
                </button>
              )}
            </div>
            {pinNotice && (
              <p
                className={`mt-2 text-xs font-medium ${
                  pinNotice.isError
                    ? "text-red-600 dark:text-red-400"
                    : "text-emerald-700 dark:text-emerald-400"
                }`}
              >
                {pinNotice.text}
              </p>
            )}
          </div>

          {/* Local Runner Endpoints Configuration */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Connected Local Inference Backends
              </h3>
              <button
                type="button"
                onClick={onRefreshSystemInfo}
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Re-check Status
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  { key: "mlxWorkerUrl", label: "M5 MLX Worker", id: "mlx-worker" },
                  { key: "ollamaUrl", label: "Ollama", id: "ollama" },
                  { key: "openaiLocalUrl", label: "MLX / LM Studio", id: "openai-local" },
                  { key: "a1111Url", label: "A1111 / Forge", id: "a1111" },
                  { key: "comfyuiUrl", label: "ComfyUI", id: "comfyui" },
                ] as const
              ).map((item) => {
                const probe = systemInfo?.runners.find((r) => r.id === item.id);
                return (
                  <label
                    key={item.key}
                    className="block rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {item.label}
                      </span>
                      <span
                        className={`font-medium ${
                          probe?.online
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-slate-400 dark:text-slate-500"
                        }`}
                      >
                        {probe?.online ? "Online" : "Offline"}
                      </span>
                    </div>
                    <input
                      type="url"
                      value={draftEndpoints[item.key]}
                      onChange={(e) =>
                        setDraftEndpoints((prev) => ({
                          ...prev,
                          [item.key]: e.target.value,
                        }))
                      }
                      className="mt-1.5 w-full rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                  </label>
                );
              })}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  onSaveEndpoints(draftEndpoints);
                  onClose();
                }}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
              >
                Save Endpoints
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
