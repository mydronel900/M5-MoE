import { useCallback, useEffect, useState } from "react";
import { ChatPromptWorkspace } from "./components/ChatPromptWorkspace";
import { HeaderBar } from "./components/HeaderBar";
import { ImageToImageWorkspace } from "./components/ImageToImageWorkspace";
import { ImageToVideoWorkspace } from "./components/ImageToVideoWorkspace";
import { LanAccessModal } from "./components/LanAccessModal";
import { ModelPickerModal } from "./components/ModelPickerModal";
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
  ChatMessage,
  ExecutionMode,
  ExpertConfigMap,
  ExpertFeatureId,
  GeneratedMediaItem,
  RunnerEndpoints,
  StorageConfig,
  SystemInfoResponse,
} from "./types/moe";

const STORAGE_KEYS = {
  experts: "m5_moe_experts_v1",
  endpoints: "m5_moe_endpoints_v1",
  darkMode: "m5_moe_dark_v1",
  swapStrategy: "m5_moe_swap_v1",
};

const FEATURES: ExpertFeatureId[] = [
  "chat",
  "text-to-image",
  "image-to-image",
  "image-to-video",
];

function loadSavedJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export default function App() {
  const [activeFeature, setActiveFeature] = useState<ExpertFeatureId>("chat");
  const [experts, setExperts] = useState<ExpertConfigMap>(() =>
    loadSavedJson<ExpertConfigMap>(STORAGE_KEYS.experts, DEFAULT_EXPERTS)
  );
  const [endpoints, setEndpoints] = useState<RunnerEndpoints>(() =>
    loadSavedJson<RunnerEndpoints>(STORAGE_KEYS.endpoints, DEFAULT_ENDPOINTS)
  );
  const [swapStrategy, setSwapStrategy] = useState<"auto-swap" | "resident">(
    () => {
      try {
        const val = localStorage.getItem(STORAGE_KEYS.swapStrategy);
        return val === "resident" ? "resident" : "auto-swap";
      } catch {
        return "auto-swap";
      }
    }
  );
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("local");
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.darkMode) === "true";
    } catch {
      return false;
    }
  });

  const [systemInfo, setSystemInfo] = useState<SystemInfoResponse | null>(null);
  const [isRefreshingSystem, setIsRefreshingSystem] = useState(false);
  const [storageConfig, setStorageConfig] = useState<StorageConfig | null>(null);

  const [pickerFeature, setPickerFeature] = useState<ExpertFeatureId | null>(null);
  const [lanModalOpen, setLanModalOpen] = useState(false);
  const [storageModalOpen, setStorageModalOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Feature states & cross-feature handoff payloads
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [pendingChatImage, setPendingChatImage] = useState<string | null>(null);

  const [t2iHistory, setT2iHistory] = useState<GeneratedMediaItem[]>([]);
  const [t2iInitialPrompt, setT2iInitialPrompt] = useState("");

  const [i2iHistory, setI2iHistory] = useState<GeneratedMediaItem[]>([]);
  const [i2iInitialImage, setI2iInitialImage] = useState<string | null>(null);
  const [i2iInitialPrompt, setI2iInitialPrompt] = useState("");

  const [i2vHistory, setI2vHistory] = useState<GeneratedMediaItem[]>([]);
  const [i2vInitialImage, setI2vInitialImage] = useState<string | null>(null);
  const [i2vInitialPrompt, setI2vInitialPrompt] = useState("");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    try {
      localStorage.setItem(STORAGE_KEYS.darkMode, String(darkMode));
    } catch {
      // ignore
    }
  }, [darkMode]);

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
      const res = await fetch(`/api/system/info?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as SystemInfoResponse;
        setSystemInfo(data);
      }
    } catch {
      // ignore transient network failures
    } finally {
      setIsRefreshingSystem(false);
    }
  }, [endpoints]);

  const fetchStorageConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/storage/config");
      if (res.ok) {
        setStorageConfig((await res.json()) as StorageConfig);
      }
    } catch {
      // ignore transient errors
    }
  }, []);

  useEffect(() => {
    void fetchSystemInfo();
    void fetchStorageConfig();
  }, [fetchSystemInfo, fetchStorageConfig]);

  function handleAssignModel(feature: ExpertFeatureId, model: AssignedModel) {
    setExperts((prev) => {
      const next = { ...prev, [feature]: model };
      try {
        localStorage.setItem(STORAGE_KEYS.experts, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

  function handleSaveEndpoints(nextEndpoints: RunnerEndpoints) {
    setEndpoints(nextEndpoints);
    try {
      localStorage.setItem(STORAGE_KEYS.endpoints, JSON.stringify(nextEndpoints));
    } catch {
      // ignore
    }
  }

  function handleChangeSwapStrategy(strategy: "auto-swap" | "resident") {
    setSwapStrategy(strategy);
    try {
      localStorage.setItem(STORAGE_KEYS.swapStrategy, strategy);
    } catch {
      // ignore
    }
  }

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
          swapStrategy={swapStrategy}
          onChangeSwapStrategy={handleChangeSwapStrategy}
          executionMode={executionMode}
          onChangeExecutionMode={setExecutionMode}
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
          {activeFeature === "chat" && (
            <ChatPromptWorkspace
              model={experts.chat}
              executionMode={executionMode}
              endpoints={endpoints}
              messages={chatMessages}
              onAppendMessage={(msg) => setChatMessages((prev) => [...prev, msg])}
              onClearMessages={() => setChatMessages([])}
              onOpenModelPicker={() => setPickerFeature("chat")}
              onOpenLanModal={() => setLanModalOpen(true)}
              onSwitchExecutionMode={setExecutionMode}
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
              history={t2iHistory}
              onAddOutput={(item) => setT2iHistory((prev) => [item, ...prev])}
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
              history={i2iHistory}
              onAddOutput={(item) => setI2iHistory((prev) => [item, ...prev])}
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
              history={i2vHistory}
              onAddOutput={(item) => setI2vHistory((prev) => [item, ...prev])}
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
      />
    </div>
  );
}
