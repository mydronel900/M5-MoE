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
}

