import { useCallback, useEffect, useRef, useState } from "react";
import { ChainPipelineModal } from "./components/ChainPipelineModal";
import { ChatPromptWorkspace } from "./components/ChatPromptWorkspace";
import { HeaderBar } from "./components/HeaderBar";
import { ImageToImageWorkspace } from "./components/ImageToImageWorkspace";
import { ImageToVideoWorkspace } from "./components/ImageToVideoWorkspace";
import { LanAccessModal } from "./components/LanAccessModal";
import { LanPinGate } from "./components/LanPinGate";
import { ModelPickerModal } from "./components/ModelPickerModal";
import { RenderQueuePanel } from "./components/RenderQueuePanel";
import { SidebarExperts } from "./components/SidebarExperts";
import { StorageFolderModal } from "./components/StorageFolderModal";
import { TextToImageWorkspace } from "./components/TextToImageWorkspace";
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_EXPERTS,
  EXPERT_META,
} from "./data/moeDefaults";
import {
  AssignedModel,
  ChainPipelineMode,
  ChatMessage,
  ExecutionMode,
  ExpertConfigMap,
  ExpertFeatureId,
  GeneratedMediaItem,
  LanAuthStatus,
  RenderJob,
  RunnerEndpoints,
  SavedDiskFile,
  SavedOutputMetadata,
  StorageConfig,
  SyncedWorkspaceState,
  SystemInfoResponse,
} from "./types/moe";
import { apiFetch, setLanSessionToken, withLanTokenUrl } from "./utils/apiClient";

const DARK_MODE_KEY = "m5_moe_dark_v1";

const FEATURES: ExpertFeatureId[] = [
  "chat",
  "text-to-image",
  "image-to-image",
  "image-to-video",
];

export default function App() {
  const [authStatus, setAuthStatus] = useState<LanAuthStatus | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [activeFeature, setActiveFeature] = useState<ExpertFeatureId>("chat");
  const [experts, setExperts] = useState<ExpertConfigMap>(DEFAULT_EXPERTS);
  const [endpoints, setEndpoints] = useState<RunnerEndpoints>(DEFAULT_ENDPOINTS);
  const [swapStrategy, setSwapStrategy] = useState<"auto-swap" | "resident">("auto-swap");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("local");
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DARK_MODE_KEY) === "true";
    } catch {
      return false;
    }
  });

  const [systemInfo, setSystemInfo] = useState<SystemInfoResponse | null>(null);
  const [isRefreshingSystem, setIsRefreshingSystem] = useState(false);
  const [isUnloadingWorker, setIsUnloadingWorker] = useState(false);
  const [storageConfig, setStorageConfig] = useState<StorageConfig | null>(null);

  const [pickerFeature, setPickerFeature] = useState<ExpertFeatureId | null>(null);
  const [lanModalOpen, setLanModalOpen] = useState(false);
  const [storageModalOpen, setStorageModalOpen] = useState(false);
  const [chainModalOpen, setChainModalOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Synced feature states & cross-feature handoff payloads
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [pendingChatImage, setPendingChatImage] = useState<string | null>(null);

  const [t2iHistory, setT2iHistory] = useState<GeneratedMediaItem[]>([]);
  const [t2iInitialPrompt, setT2iInitialPrompt] = useState("");
  const [t2iRemix, setT2iRemix] = useState<SavedOutputMetadata | null>(null);

  const [i2iHistory, setI2iHistory] = useState<GeneratedMediaItem[]>([]);
  const [i2iInitialImage, setI2iInitialImage] = useState<string | null>(null);
  const [i2iInitialPrompt, setI2iInitialPrompt] = useState("");
  const [i2iRemix, setI2iRemix] = useState<SavedOutputMetadata | null>(null);

  const [i2vHistory, setI2vHistory] = useState<GeneratedMediaItem[]>([]);
  const [i2vInitialImage, setI2vInitialImage] = useState<string | null>(null);
  const [i2vInitialPrompt, setI2vInitialPrompt] = useState("");
  const [i2vRemix, setI2vRemix] = useState<SavedOutputMetadata | null>(null);

  // FIFO render queue jobs
  const [queueJobs, setQueueJobs] = useState<RenderJob[]>([]);
  const lastStateSyncRef = useRef<string>("");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    try {
      localStorage.setItem(DARK_MODE_KEY, String(darkMode));
    } catch {
      // ignore
    }
  }, [darkMode]);

  const applySyncedState = useCallback((state: Partial<SyncedWorkspaceState>) => {
    if (state.updatedAt && state.updatedAt === lastStateSyncRef.current) return;
    if (state.updatedAt) lastStateSyncRef.current = state.updatedAt;
    if (state.experts) setExperts({ ...DEFAULT_EXPERTS, ...state.experts });
    if (state.endpoints) setEndpoints({ ...DEFAULT_ENDPOINTS, ...state.endpoints });
    if (state.swapStrategy) setSwapStrategy(state.swapStrategy);
    if (state.executionMode) setExecutionMode(state.executionMode);
    if (Array.isArray(state.chatMessages)) setChatMessages(state.chatMessages);
    if (Array.isArray(state.t2iHistory)) setT2iHistory(state.t2iHistory);
    if (Array.isArray(state.i2iHistory)) setI2iHistory(state.i2iHistory);
    if (Array.isArray(state.i2vHistory)) setI2vHistory(state.i2vHistory);
  }, []);

  const persistHostState = useCallback(async (patch: Partial<SyncedWorkspaceState>) => {
    try {
      const res = await apiFetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const saved = (await res.json()) as SyncedWorkspaceState;
        if (saved.updatedAt) lastStateSyncRef.current = saved.updatedAt;
      }
    } catch {
      // ignore transient network error
    }
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/auth/status");
      if (res.ok) {
        setAuthStatus((await res.json()) as LanAuthStatus);
      }
    } catch {
      // ignore
    } finally {
      setAuthReady(true);
    }
  }, []);

  useEffect(() => {
    void checkAuthStatus();
  }, [checkAuthStatus]);

  const fetchSystemInfo = useCallback(async () => {
    setIsRefreshingSystem(true);
    try {
      const params = new URLSearchParams({
        mlxWorkerUrl: endpoints.mlxWorkerUrl,
        ollamaUrl: endpoints.ollamaUrl,
        openaiLocalUrl: endpoints.openaiLocalUrl,
        a1111Url: endpoints.a1111Url,
        comfyuiUrl: endpoints.comfyuiUrl,
      });
      const res = await apiFetch(`/api/system/info?${params.toString()}`);
      if (res.ok) {
        setSystemInfo((await res.json()) as SystemInfoResponse);
      }
    } catch {
      // ignore transient network failures
    } finally {
      setIsRefreshingSystem(false);
    }
  }, [endpoints]);

  const fetchStorageConfig = useCallback(async () => {
    try {
      const res = await apiFetch("/api/storage/config");
      if (res.ok) {
        setStorageConfig((await res.json()) as StorageConfig);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchHostState = useCallback(async () => {
    try {
      const res = await apiFetch("/api/state");
      if (res.ok) {
        const data = (await res.json()) as Partial<SyncedWorkspaceState>;
        applySyncedState(data);
      }
    } catch {
      // ignore
    }
  }, [applySyncedState]);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await apiFetch("/api/queue");
      if (res.ok) {
        const data = (await res.json()) as { jobs?: RenderJob[] };
        setQueueJobs(data.jobs || []);
      }
    } catch {
      // ignore
    }
  }, []);

  // Load synced state, system health, storage, and subscribe to live SSE hub once authenticated
  useEffect(() => {
    if (!authReady || authStatus?.requiresPin) return;

    void fetchHostState();
    void fetchSystemInfo();
    void fetchStorageConfig();
    void fetchQueue();

    const es = new EventSource(withLanTokenUrl("/api/events"));
    es.addEventListener("queue:update", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { jobs?: RenderJob[] };
        if (Array.isArray(data.jobs)) {
          setQueueJobs(data.jobs);
          // Refresh storage stats whenever a job completes
          if (data.jobs.some((j) => j.status === "completed")) {
            void fetchStorageConfig();
          }
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener("state:update", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as Partial<SyncedWorkspaceState>;
        applySyncedState(data);
      } catch {
        // ignore
      }
    });

    return () => {
      es.close();
    };
  }, [
    authReady,
    authStatus?.requiresPin,
    fetchHostState,
    fetchSystemInfo,
    fetchStorageConfig,
    fetchQueue,
    applySyncedState,
  ]);

  function handleAssignModel(feature: ExpertFeatureId, model: AssignedModel) {
    setExperts((prev) => {
      const next = { ...prev, [feature]: model };
      void persistHostState({ experts: next });
      return next;
    });
  }

  function handleSaveEndpoints(nextEndpoints: RunnerEndpoints) {
    setEndpoints(nextEndpoints);
    void persistHostState({ endpoints: nextEndpoints });
  }

  function handleChangeSwapStrategy(strategy: "auto-swap" | "resident") {
    setSwapStrategy(strategy);
    void persistHostState({ swapStrategy: strategy });
  }

  function handleChangeExecutionMode(mode: ExecutionMode) {
    setExecutionMode(mode);
    void persistHostState({ executionMode: mode });
  }

  function handleAppendChatMessage(msg: ChatMessage) {
    setChatMessages((prev) => {
      const next = [...prev, msg].slice(-60);
      void persistHostState({ chatMessages: next });
      return next;
    });
  }

  function handleClearChatMessages() {
    setChatMessages([]);
    void persistHostState({ chatMessages: [] });
  }

  async function handleUnloadWorker() {
    setIsUnloadingWorker(true);
    try {
      await apiFetch("/api/worker/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mlxWorkerUrl: endpoints.mlxWorkerUrl }),
      });
      await fetchSystemInfo();
    } catch {
      // ignore
    } finally {
      setIsUnloadingWorker(false);
    }
  }

  async function enqueueRenderJob(
    type: RenderJob["type"],
    label: string,
    payload: Record<string, unknown>
  ) {
    const res = await apiFetch("/api/queue/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, label, payload }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not enqueue render job");
    }
    if (data.queue?.jobs) {
      setQueueJobs(data.queue.jobs);
    }
  }

  async function handleCancelJob(jobId: string) {
    const res = await apiFetch(`/api/queue/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    });
    if (res.ok) {
      const data = await res.json();
      if (data.jobs) setQueueJobs(data.jobs);
    }
  }

  async function handleClearCompletedJobs() {
    const res = await apiFetch("/api/queue/clear-completed", { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      if (data.jobs) setQueueJobs(data.jobs);
    }
  }

  async function handleEnqueueChain(params: {
    mode: ChainPipelineMode;
    prompt: string;
    sourceImageDataUrl?: string;
    numFrames: number;
    fps: number;
    steps: number;
    strength: number;
  }) {
    const labelMap: Record<ChainPipelineMode, string> = {
      "prompt-to-image-to-video": "Chain: Prompt → T2I → I2V",
      "image-to-prompt-to-video": "Chain: Image → Prompt → I2V",
      "image-to-prompt-to-i2i-video": "Chain: Image → Prompt → I2I → I2V",
    };
    await enqueueRenderJob("chain-pipeline", labelMap[params.mode], {
      ...params,
      experts,
      endpoints,
      chatExecutionMode: executionMode,
    });
    setActiveFeature("image-to-video");
  }

  function handleRemixFile(file: SavedDiskFile) {
    if (!file.metadata) return;
    const meta = file.metadata;
    if (meta.feature === "text-to-image") {
      setT2iRemix(meta);
      setActiveFeature("text-to-image");
    } else if (meta.feature === "image-to-image") {
      setI2iRemix(meta);
      setI2iInitialImage(withLanTokenUrl(file.url));
      setActiveFeature("image-to-image");
    } else if (meta.feature === "image-to-video") {
      setI2vRemix(meta);
      setActiveFeature("image-to-video");
    }
  }

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-xs text-slate-500 dark:bg-slate-950 dark:text-slate-400">
        Connecting to M5 MoE Studio...
      </div>
    );
  }

  if (authStatus?.requiresPin) {
    return (
      <LanPinGate
        onUnlocked={(token) => {
          setLanSessionToken(token);
          setAuthStatus((prev) =>
            prev ? { ...prev, authenticated: true, requiresPin: false } : prev
          );
        }}
      />
    );
  }

  const latestJobFor = (type: RenderJob["type"]) =>
    queueJobs.find((j) => j.type === type && (j.status === "running" || j.status === "queued" || j.status === "failed")) ||
    null;

  return (
    <div id="top" className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <HeaderBar
        activeFeature={activeFeature}
        onSelectFeature={setActiveFeature}
        onOpenLanModal={() => setLanModalOpen(true)}
        onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
      />

      {/* Mobile workspace switcher (compact, only on small viewports) */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900 md:hidden">
        {FEATURES.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveFeature(id)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
              activeFeature === id
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {EXPERT_META[id].shortLabel}
          </button>
        ))}
      </div>

      <div className="flex">
        <SidebarExperts
          activeFeature={activeFeature}
          onSelectFeature={setActiveFeature}
          experts={experts}
          onConfigureExpert={(feat) => setPickerFeature(feat)}
          onOpenChainModal={() => setChainModalOpen(true)}
          onUnloadWorker={() => void handleUnloadWorker()}
          isUnloadingWorker={isUnloadingWorker}
          swapStrategy={swapStrategy}
          onChangeSwapStrategy={handleChangeSwapStrategy}
          executionMode={executionMode}
          onChangeExecutionMode={handleChangeExecutionMode}
          systemInfo={systemInfo}
          onRefreshSystemInfo={() => void fetchSystemInfo()}
          isRefreshingSystem={isRefreshingSystem}
          storageConfig={storageConfig}
          onOpenStorageModal={() => setStorageModalOpen(true)}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((prev) => !prev)}
          mobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
        />

        <main className="min-w-0 flex-1">
          <RenderQueuePanel
            jobs={queueJobs}
            onCancelJob={(id) => void handleCancelJob(id)}
            onClearCompleted={() => void handleClearCompletedJobs()}
          />

          {activeFeature === "chat" && (
            <ChatPromptWorkspace
              model={experts.chat}
              executionMode={executionMode}
              endpoints={endpoints}
              messages={chatMessages}
              onAppendMessage={handleAppendChatMessage}
              onClearMessages={handleClearChatMessages}
              onOpenModelPicker={() => setPickerFeature("chat")}
              onOpenLanModal={() => setLanModalOpen(true)}
              onSwitchExecutionMode={handleChangeExecutionMode}
              onSendPromptToT2I={(prompt) => {
                setT2iInitialPrompt(prompt);
                setActiveFeature("text-to-image");
              }}
              onSendPromptToI2V={(prompt) => {
                setI2vInitialPrompt(prompt);
                setActiveFeature("image-to-video");
              }}
              pendingImageForAnalysis={pendingChatImage}
              onConsumePendingImage={() => setPendingChatImage(null)}
            />
          )}

          {activeFeature === "text-to-image" && (
            <TextToImageWorkspace
              model={experts["text-to-image"]}
              endpoints={endpoints}
              storageConfig={storageConfig}
              initialPrompt={t2iInitialPrompt}
              remixSeed={t2iRemix}
              activeQueueJob={latestJobFor("text-to-image")}
              history={t2iHistory}
              onEnqueueT2I={(payload) =>
                enqueueRenderJob(
                  "text-to-image",
                  `T2I: ${payload.prompt.slice(0, 38)}`,
                  payload
                )
              }
              onRefreshStorage={() => void fetchStorageConfig()}
              onOpenModelPicker={() => setPickerFeature("text-to-image")}
              onOpenLanModal={() => setLanModalOpen(true)}
              onOpenStorageModal={() => setStorageModalOpen(true)}
              onSendToI2I={(imageUrl, prompt) => {
                setI2iInitialImage(imageUrl);
                setI2iInitialPrompt(prompt);
                setActiveFeature("image-to-image");
              }}
              onSendToI2V={(imageUrl, prompt) => {
                setI2vInitialImage(imageUrl);
                setI2vInitialPrompt(prompt);
                setActiveFeature("image-to-video");
              }}
            />
          )}

          {activeFeature === "image-to-image" && (
            <ImageToImageWorkspace
              model={experts["image-to-image"]}
              endpoints={endpoints}
              storageConfig={storageConfig}
              initialImageUrl={i2iInitialImage}
              initialPrompt={i2iInitialPrompt}
              remixSeed={i2iRemix}
              activeQueueJob={latestJobFor("image-to-image")}
              history={i2iHistory}
              onEnqueueI2I={(payload) =>
                enqueueRenderJob(
                  "image-to-image",
                  `I2I: ${payload.prompt.slice(0, 38)}`,
                  payload
                )
              }
              onRefreshStorage={() => void fetchStorageConfig()}
              onOpenModelPicker={() => setPickerFeature("image-to-image")}
              onOpenLanModal={() => setLanModalOpen(true)}
              onOpenStorageModal={() => setStorageModalOpen(true)}
              onSendToI2V={(imageUrl, prompt) => {
                setI2vInitialImage(imageUrl);
                setI2vInitialPrompt(prompt);
                setActiveFeature("image-to-video");
              }}
              onSendToChatPrompt={(imageUrl) => {
                setPendingChatImage(imageUrl);
                setActiveFeature("chat");
              }}
            />
          )}

          {activeFeature === "image-to-video" && (
            <ImageToVideoWorkspace
              model={experts["image-to-video"]}
              endpoints={endpoints}
              storageConfig={storageConfig}
              initialImageUrl={i2vInitialImage}
              initialPrompt={i2vInitialPrompt}
              remixSeed={i2vRemix}
              activeQueueJob={
                latestJobFor("image-to-video") || latestJobFor("chain-pipeline")
              }
              history={i2vHistory}
              onEnqueueI2V={(payload) =>
                enqueueRenderJob(
                  "image-to-video",
                  `I2V: ${payload.prompt.slice(0, 38)}`,
                  payload
                )
              }
              onRefreshStorage={() => void fetchStorageConfig()}
              onOpenModelPicker={() => setPickerFeature("image-to-video")}
              onOpenLanModal={() => setLanModalOpen(true)}
              onOpenStorageModal={() => setStorageModalOpen(true)}
            />
          )}
        </main>
      </div>

      <ModelPickerModal
        feature={pickerFeature}
        currentModel={pickerFeature ? experts[pickerFeature] : null}
        endpoints={endpoints}
        onClose={() => setPickerFeature(null)}
        onAssignModel={handleAssignModel}
      />

      <LanAccessModal
        open={lanModalOpen}
        onClose={() => setLanModalOpen(false)}
        systemInfo={systemInfo}
        endpoints={endpoints}
        onSaveEndpoints={handleSaveEndpoints}
        onRefreshSystemInfo={() => void fetchSystemInfo()}
        authStatus={authStatus}
        onUpdateAuthStatus={(nextStatus, token) => {
          if (token !== undefined) setLanSessionToken(token);
          setAuthStatus(nextStatus);
        }}
      />

      <StorageFolderModal
        open={storageModalOpen}
        onClose={() => setStorageModalOpen(false)}
        storageConfig={storageConfig}
        onUpdateStorageConfig={setStorageConfig}
        onSendImageToI2I={(imageUrl) => {
          setI2iInitialImage(imageUrl);
          setActiveFeature("image-to-image");
        }}
        onSendImageToI2V={(imageUrl) => {
          setI2vInitialImage(imageUrl);
          setActiveFeature("image-to-video");
        }}
        onRemixFile={handleRemixFile}
      />

      <ChainPipelineModal
        open={chainModalOpen}
        onClose={() => setChainModalOpen(false)}
        experts={experts}
        endpoints={endpoints}
        executionMode={executionMode}
        onEnqueueChain={handleEnqueueChain}
      />
    </div>
  );
}
