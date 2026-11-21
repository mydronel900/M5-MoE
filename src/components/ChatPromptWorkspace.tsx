import {
  ArrowRight,
  Check,
  Copy,
  ImagePlus,
  Send,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { STUDIO_SAMPLE_IMAGES } from "../data/moeDefaults";
import {
  AssignedModel,
  ChatMessage,
  ChatSubMode,
  ExecutionMode,
  RunnerEndpoints,
} from "../types/moe";
import { fileToDataUrl, formatDurationMs, urlToDataUrl } from "../utils/imageHelpers";

interface ChatPromptWorkspaceProps {
  model: AssignedModel;
  executionMode: ExecutionMode;
  endpoints: RunnerEndpoints;
  messages: ChatMessage[];
  onAppendMessage: (msg: ChatMessage) => void;
  onClearMessages: () => void;
  onOpenModelPicker: () => void;
  onOpenLanModal: () => void;
  onSwitchExecutionMode: (mode: ExecutionMode) => void;
  onSendPromptToT2I: (prompt: string) => void;
  onSendPromptToI2V: (prompt: string) => void;
  pendingImageForAnalysis: string | null;
  onConsumePendingImage: () => void;
}

const SUB_MODES: Array<{ id: ChatSubMode; label: string; placeholder: string }> = [
  {
    id: "chat",
    label: "General Chat",
    placeholder: "Ask anything or brainstorm ideas locally on M5...",
  },
  {
    id: "prompt-gen",
    label: "Prompt Architect",
    placeholder: "Describe a scene (e.g. brutalist concrete library in morning rain)...",
  },
  {
    id: "image-to-prompt",
    label: "Image to Prompt",
    placeholder: "Attach an image and ask for a detailed generation prompt...",
  },
];

export function ChatPromptWorkspace({
  model,
  executionMode,
  endpoints,
  messages,
  onAppendMessage,
  onClearMessages,
  onOpenModelPicker,
  onOpenLanModal,
  onSwitchExecutionMode,
  onSendPromptToT2I,
  onSendPromptToI2V,
  pendingImageForAnalysis,
  onConsumePendingImage,
}: ChatPromptWorkspaceProps) {
  const [subMode, setSubMode] = useState<ChatSubMode>(
    pendingImageForAnalysis ? "image-to-prompt" : "chat"
  );
  const [input, setInput] = useState("");
  const [attachedImage, setAttachedImage] = useState<string | null>(
    pendingImageForAnalysis
  );
  const [isSending, setIsSending] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{
    message: string;
    isOffline?: boolean;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (pendingImageForAnalysis && attachedImage !== pendingImageForAnalysis) {
    setAttachedImage(pendingImageForAnalysis);
    setSubMode("image-to-prompt");
    onConsumePendingImage();
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      setAttachedImage(dataUrl);
      if (subMode === "chat") {
        setSubMode("image-to-prompt");
      }
    } catch {
      setErrorBanner({ message: "Could not read selected image file." });
    }
    e.target.value = "";
  }

  async function handleSelectSample(url: string) {
    try {
      const dataUrl = await urlToDataUrl(url);
      setAttachedImage(dataUrl);
      setSubMode("image-to-prompt");
    } catch {
      setErrorBanner({ message: "Could not load sample image." });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const defaultPrompt =
      subMode === "image-to-prompt" && attachedImage
        ? "Analyze this image and write a detailed, structured prompt for local Text-to-Image and Image-to-Video models."
        : "";
    const content = input.trim() || defaultPrompt;
    if (!content && !attachedImage) return;

    setErrorBanner(null);
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content,
      imageDataUrl: attachedImage || undefined,
      mode: subMode,
      modelUsed: model.name,
      engineUsed: executionMode,
      createdAt: new Date().toISOString(),
    };
    onAppendMessage(userMsg);
    setInput("");
    const currentImage = attachedImage;
    setAttachedImage(null);
    setIsSending(true);

    try {
      const historyPayload = [...messages.slice(-8), userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await fetch("/api/infer/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: historyPayload,
          imageDataUrl: currentImage || undefined,
          mode: subMode,
          model: model.id,
          runner: model.runner,
          executionMode,
          endpoints,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorBanner({
          message: data.error || "Inference failed",
          isOffline: data.code === "LOCAL_RUNNER_OFFLINE",
        });
      } else {
        onAppendMessage({
          id: `a-${Date.now()}`,
          role: "assistant",
          content: data.text || "(Empty response)",
          mode: subMode,
          modelUsed: data.modelUsed || model.name,
          engineUsed: data.engineUsed || executionMode,
          elapsedMs: data.elapsedMs,
          createdAt: new Date().toISOString(),
        });
      }
    } catch {
      setErrorBanner({ message: "Network error reaching backend API." });
    } finally {
      setIsSending(false);
    }
  }

  async function copyPrompt(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // ignore
    }
  }

  const activeModeMeta = SUB_MODES.find((m) => m.id === subMode)!;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Workspace Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">
            01. Chat & Prompt Architect
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

        <div className="flex flex-wrap items-center gap-2">
          {/* Sub-mode segmented tabs */}
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            {SUB_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSubMode(m.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  subMode === m.id
                    ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onOpenModelPicker}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Change Model</span>
          </button>

          {messages.length > 0 && (
            <button
              type="button"
              onClick={onClearMessages}
              title="Clear conversation"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Message Feed */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-4xl space-y-5">
          {messages.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Multi-Mode Conversation, Prompt Crafting & Image-to-Prompt
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                Use this expert for everyday conversation, expanding rough concepts into detailed visual prompts, or uploading an image to reverse-engineer a generation prompt for Text-to-Image and Image-to-Video.
              </p>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    setSubMode("prompt-gen");
                    setInput(
                      "A minimalist Japanese cedar reading cabin in foggy redwood forest, natural soft light, 35mm architectural photography"
                    );
                  }}
                  className="rounded-lg border border-slate-200 p-3.5 text-left transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
                >
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Prompt Architect Example
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Expand a short concept into a rich Flux / LTX-Video prompt
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => void handleSelectSample(STUDIO_SAMPLE_IMAGES[0].url)}
                  className="rounded-lg border border-slate-200 p-3.5 text-left transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
                >
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Try Image to Prompt with Sample
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Attach Cedar Forest Pavilion and extract its visual prompt
                  </p>
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-xl border p-4 ${
                  msg.role === "user"
                    ? "border-slate-200 bg-slate-100/70 dark:border-slate-800 dark:bg-slate-900/70"
                    : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    {msg.role === "user" ? "You" : msg.modelUsed}
                  </span>
                  <span className="tabular-nums">
                    {msg.mode}
                    {msg.elapsedMs ? ` · ${formatDurationMs(msg.elapsedMs)}` : ""}
                  </span>
                </div>

                {msg.imageDataUrl && (
                  <img
                    src={msg.imageDataUrl}
                    alt="Attached input for prompt extraction"
                    referrerPolicy="no-referrer"
                    className="mt-3 max-h-60 rounded-lg border border-slate-200 object-contain dark:border-slate-700"
                  />
                )}

                <div className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-200">
                  {msg.content}
                </div>

                {msg.role === "assistant" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <button
                      type="button"
                      onClick={() => void copyPrompt(msg.id, msg.content)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      {copiedId === msg.id ? (
                        <Check className="h-3 w-3 text-emerald-600" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>{copiedId === msg.id ? "Copied" : "Copy"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onSendPromptToT2I(msg.content)}
                      className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-500"
                    >
                      <span>Send to Text to Image</span>
                      <ArrowRight className="h-3 w-3" />
                    </button>

                    <button
                      type="button"
                      onClick={() => onSendPromptToI2V(msg.content)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <span>Send to Image to Video</span>
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            ))
          )}

          {isSending && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              Running {executionMode === "local" ? model.name : "Cloud Preview (Gemini 4 Hydrogen)"}...
            </div>
          )}

          {errorBanner && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-medium">{errorBanner.message}</p>
              {errorBanner.isOffline && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={onOpenLanModal}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 dark:bg-blue-600"
                  >
                    Open M5 Worker Setup
                  </button>
                  <button
                    type="button"
                    onClick={() => onSwitchExecutionMode("cloud-preview")}
                    className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-slate-900 dark:text-amber-200"
                  >
                    Switch to Cloud Preview (Gemini)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="mx-auto max-w-4xl space-y-3">
          {attachedImage && (
            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-950">
              <img
                src={attachedImage}
                alt="Attached preview"
                referrerPolicy="no-referrer"
                className="h-14 w-14 rounded object-cover"
              />
              <div className="flex-1 text-xs text-slate-600 dark:text-slate-400">
                Image attached for multimodal prompt extraction
              </div>
              <button
                type="button"
                onClick={() => setAttachedImage(null)}
                aria-label="Remove attached image"
                className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>Quick attach sample:</span>
            {STUDIO_SAMPLE_IMAGES.map((sample) => (
              <button
                key={sample.id}
                type="button"
                onClick={() => void handleSelectSample(sample.url)}
                className="rounded border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {sample.label}
              </button>
            ))}
          </div>

          <div className="flex items-end gap-2">
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
              title="Attach image for Image-to-Prompt"
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <ImagePlus className="h-4 w-4" />
              <span className="hidden sm:inline">Image</span>
            </button>

            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit(e);
                }
              }}
              placeholder={activeModeMeta.placeholder}
              className="flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:bg-slate-900"
            />

            <button
              type="submit"
              disabled={isSending || (!input.trim() && !attachedImage)}
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap"
            >
              <Send className="h-4 w-4" />
              <span>Run</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
