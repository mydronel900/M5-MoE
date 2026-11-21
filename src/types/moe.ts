export type ExpertFeatureId =
  | 'chat'
  | 'text-to-image'
  | 'image-to-image'
  | 'image-to-video';

export type ModelSource = 'huggingface' | 'local';

export type RunnerBackend =
  | 'mlx-worker'
  | 'ollama'
  | 'openai-local'
  | 'a1111'
  | 'comfyui';

export type ExecutionMode = 'local' | 'cloud-preview';

export interface AssignedModel {
  id: string;
  name: string;
  source: ModelSource;
  runner: RunnerBackend;
  quantization: string;
  estimatedRamGb: number;
  localPath?: string;
  pipelineTag: string;
  notes?: string;
}

export type ExpertConfigMap = Record<ExpertFeatureId, AssignedModel>;

export interface RunnerEndpoints {
  mlxWorkerUrl: string;
  ollamaUrl: string;
  openaiLocalUrl: string;
  a1111Url: string;
  comfyuiUrl: string;
}

export interface RunnerStatus {
  id: RunnerBackend;
  label: string;
  url: string;
  online: boolean;
  detail?: string;
}

export interface WorkerHealthInfo {
  online: boolean;
  activeSlot: string | null;
  activeModel: string | null;
  idleTimeoutSeconds: number;
  idleSecondsRemaining: number | null;
  activeMemoryGb: number | null;
  busy: boolean;
}

export interface LanAddress {
  interfaceName: string;
  address: string;
  url: string;
}

export interface SystemInfoResponse {
  hostname: string;
  mdnsUrl: string;
  port: number;
  platform: string;
  arch: string;
  cpuModel: string;
  totalMemoryGb: number;
  freeMemoryGb: number;
  lanAddresses: LanAddress[];
  runners: RunnerStatus[];
  defaultEndpoints?: RunnerEndpoints;
  defaultOutputDir?: string;
  workerHealth?: WorkerHealthInfo | null;
  geminiPreviewAvailable: boolean;
}

export interface HuggingFaceModelItem {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  pipelineTag: string;
  tags: string[];
  quantization: string;
  estimatedRamGb: number;
  fits16Gb: 'comfortable' | 'tight' | 'exceeds';
  lastModified?: string;
  recommendedFor?: ExpertFeatureId;
}

export interface LocalModelItem {
  id: string;
  name: string;
  path: string;
  runner: RunnerBackend;
  sizeGb: number | null;
  sourceType: 'ollama' | 'hf-cache' | 'mlx-worker' | 'directory';
}

export type ChatSubMode = 'chat' | 'prompt-gen' | 'image-to-prompt';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageDataUrl?: string;
  mode: ChatSubMode;
  modelUsed: string;
  engineUsed: string;
  elapsedMs?: number;
  createdAt: string;
}

export interface SavedOutputMetadata {
  feature: 'text-to-image' | 'image-to-image' | 'image-to-video';
  prompt: string;
  negativePrompt?: string;
  modelUsed: string;
  runnerUsed: string;
  width?: number;
  height?: number;
  steps?: number;
  guidanceScale?: number;
  strength?: number;
  numFrames?: number;
  fps?: number;
  seed?: number;
  elapsedMs?: number;
  createdAt: string;
}

export interface GeneratedMediaItem {
  id: string;
  feature: 'text-to-image' | 'image-to-image' | 'image-to-video';
  prompt: string;
  negativePrompt?: string;
  outputUrl: string;
  sourceImageUrl?: string;
  mimeType: string;
  modelUsed: string;
  runnerUsed: string;
  width?: number;
  height?: number;
  steps?: number;
  guidanceScale?: number;
  strength?: number;
  numFrames?: number;
  fps?: number;
  seed?: number;
  elapsedMs: number;
  savedPath?: string;
  savedFileName?: string;
  downloadUrl?: string;
  createdAt: string;
}

export interface StorageConfig {
  outputDir: string;
  defaultOutputDir: string;
  autoSaveToDisk: boolean;
  exists: boolean;
  writable: boolean;
  fileCount: number;
  totalSizeMb: number;
}

export interface SavedDiskFile {
  name: string;
  feature: 'text-to-image' | 'image-to-image' | 'image-to-video' | 'other';
  mimeType: string;
  isVideo: boolean;
  sizeBytes: number;
  createdAt: string;
  url: string;
  downloadUrl: string;
  fullPath: string;
  metadata?: SavedOutputMetadata;
}

export type RenderJobType =
  | 'text-to-image'
  | 'image-to-image'
  | 'image-to-video'
  | 'chain-pipeline';

export type RenderJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ChainPipelineMode =
  | 'prompt-to-image-to-video'
  | 'image-to-prompt-to-video'
  | 'image-to-prompt-to-i2i-video';

export interface RenderJob {
  id: string;
  type: RenderJobType;
  label: string;
  status: RenderJobStatus;
  position: number;
  progressPercent: number;
  currentStep: number;
  totalSteps: number;
  stepLabel: string;
  previewUrl?: string;
  error?: string;
  isOffline?: boolean;
  result?: GeneratedMediaItem;
  chainArtifacts?: {
    generatedPrompt?: string;
    intermediateImage?: GeneratedMediaItem;
    finalVideo?: GeneratedMediaItem;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PullProgressEvent {
  status: string;
  modelId?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  speedMbps?: number;
  message: string;
  command?: string;
  code?: string;
  done?: boolean;
  error?: string;
}

export interface SyncedWorkspaceState {
  experts: ExpertConfigMap;
  endpoints: RunnerEndpoints;
  swapStrategy: 'auto-swap' | 'resident';
  executionMode: ExecutionMode;
  chatMessages: ChatMessage[];
  t2iHistory: GeneratedMediaItem[];
  i2iHistory: GeneratedMediaItem[];
  i2vHistory: GeneratedMediaItem[];
  updatedAt: string;
}

export interface LanAuthStatus {
  lanPinEnabled: boolean;
  authenticated: boolean;
  isLocalhost: boolean;
  requiresPin: boolean;
}
