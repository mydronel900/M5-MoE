import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const DEFAULT_ENDPOINTS = {
  mlxWorkerUrl: process.env.M5_MLX_WORKER_URL || "http://127.0.0.1:8787",
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  openaiLocalUrl: process.env.OPENAI_LOCAL_URL || "http://127.0.0.1:8080",
  a1111Url: process.env.A1111_URL || "http://127.0.0.1:7860",
  comfyuiUrl: process.env.COMFYUI_URL || "http://127.0.0.1:8188",
};

const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), "M5-MoE-Outputs");
const STUDIO_CONFIG_DIR = path.join(os.homedir(), ".m5-moe-studio");
const STORAGE_CONFIG_FILE = path.join(STUDIO_CONFIG_DIR, "storage.json");
const WORKSPACE_STATE_FILE = path.join(STUDIO_CONFIG_DIR, "workspace_state.json");
const SECURITY_CONFIG_FILE = path.join(STUDIO_CONFIG_DIR, "security.json");

// Ephemeral fallback signing key when LAN_SESSION_SECRET env is unset (never hardcoded)
const SESSION_SIGNING_SECRET =
  process.env.LAN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");

interface PersistedStorageConfig {
  outputDir: string;
  autoSaveToDisk: boolean;
}

interface PersistedSecurityConfig {
  enabled: boolean;
  salt: string;
  pinHash: string;
  updatedAt: string;
}

interface SavedOutputMetadata {
  feature: "text-to-image" | "image-to-image" | "image-to-video";
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

interface GeneratedMediaItem {
  id: string;
  feature: "text-to-image" | "image-to-image" | "image-to-video";
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

interface SyncedWorkspaceState {
  experts?: Record<string, unknown>;
  endpoints?: typeof DEFAULT_ENDPOINTS;
  swapStrategy?: "auto-swap" | "resident";
  executionMode?: "local" | "cloud-preview";
  chatMessages?: Array<Record<string, unknown>>;
  t2iHistory?: GeneratedMediaItem[];
  i2iHistory?: GeneratedMediaItem[];
  i2vHistory?: GeneratedMediaItem[];
  updatedAt: string;
}

interface RenderJob {
  id: string;
  type: "text-to-image" | "image-to-image" | "image-to-video" | "chain-pipeline";
  label: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
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
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function resolveUserPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return DEFAULT_OUTPUT_DIR;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function loadStorageConfig(): PersistedStorageConfig {
  try {
    if (fs.existsSync(STORAGE_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORAGE_CONFIG_FILE, "utf-8")) as Partial<PersistedStorageConfig>;
      return {
        outputDir: raw.outputDir ? resolveUserPath(raw.outputDir) : DEFAULT_OUTPUT_DIR,
        autoSaveToDisk: raw.autoSaveToDisk !== false,
      };
    }
  } catch {
    // ignore corrupt config and fall back to defaults
  }
  return {
    outputDir: DEFAULT_OUTPUT_DIR,
    autoSaveToDisk: true,
  };
}

function writeStorageConfig(config: PersistedStorageConfig): void {
  fs.mkdirSync(STUDIO_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STORAGE_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function loadSecurityConfig(): PersistedSecurityConfig {
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, "utf-8")) as Partial<PersistedSecurityConfig>;
      if (raw.enabled && raw.salt && raw.pinHash) {
        return {
          enabled: true,
          salt: raw.salt,
          pinHash: raw.pinHash,
          updatedAt: raw.updatedAt || new Date().toISOString(),
        };
      }
    }
  } catch {
    // ignore
  }
  return { enabled: false, salt: "", pinHash: "", updatedAt: "" };
}

function writeSecurityConfig(cfg: PersistedSecurityConfig): void {
  fs.mkdirSync(STUDIO_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SECURITY_CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600, encoding: "utf-8" });
}

function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 64).toString("hex");
}

function verifyPinHash(pin: string, cfg: PersistedSecurityConfig): boolean {
  if (!cfg.enabled || !cfg.salt || !cfg.pinHash) return false;
  const candidate = Buffer.from(hashPin(pin, cfg.salt), "hex");
  const expected = Buffer.from(cfg.pinHash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function createLanSessionToken(pinVersion: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: pinVersion,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
      nonce: crypto.randomBytes(8).toString("hex"),
    }),
    "utf-8"
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SIGNING_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function verifyLanSessionToken(token: string | undefined, expectedPinVersion: string): boolean {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".", 2);
  if (!payload || !sig) return false;
  const expectedSig = crypto
    .createHmac("sha256", SESSION_SIGNING_SECRET)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
      v?: string;
      exp?: number;
    };
    if (!parsed.exp || Date.now() > parsed.exp) return false;
    return parsed.v === expectedPinVersion;
  } catch {
    return false;
  }
}

function isLocalhostReq(req: Request): boolean {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return false;
  const addr = req.socket.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function extractRequestToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  if (typeof req.query.token === "string" && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return undefined;
}

// Simple rate limiter for PIN verification (10 attempts per 5 minutes per IP)
const pinAttempts = new Map<string, { count: number; resetAt: number }>();

function checkPinRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = pinAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    pinAttempts.set(ip, { count: 0, resetAt: now + 5 * 60 * 1000 });
    return true;
  }
  return entry.count < 10;
}

function recordPinFailure(ip: string): void {
  const now = Date.now();
  const entry = pinAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    pinAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
  } else {
    entry.count += 1;
  }
}

function ensureOutputDir(dirPath: string): { exists: boolean; writable: boolean } {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK);
    return { exists: true, writable: true };
  } catch {
    return { exists: fs.existsSync(dirPath), writable: false };
  }
}

const ALLOWED_MEDIA_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".webm"]);

function getStorageStats(config: PersistedStorageConfig) {
  const status = ensureOutputDir(config.outputDir);
  let fileCount = 0;
  let totalBytes = 0;
  if (status.exists) {
    try {
      for (const entry of fs.readdirSync(config.outputDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_MEDIA_EXTS.has(ext)) continue;
        fileCount++;
        try {
          totalBytes += fs.statSync(path.join(config.outputDir, entry.name)).size;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return {
    outputDir: config.outputDir,
    defaultOutputDir: DEFAULT_OUTPUT_DIR,
    autoSaveToDisk: config.autoSaveToDisk,
    exists: status.exists,
    writable: status.writable,
    fileCount,
    totalSizeMb: Math.round((totalBytes / 1024 ** 2) * 100) / 100,
  };
}

// Compute CRC32 for PNG tEXt chunk embedding
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function embedPngTextMetadata(pngBuffer: Buffer, keyword: string, textValue: string): Buffer {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (pngBuffer.length < 24 || !pngBuffer.subarray(0, 8).equals(PNG_SIG)) {
    return pngBuffer;
  }
  // Locate IEND chunk near the end
  const iendIndex = pngBuffer.lastIndexOf(Buffer.from("IEND"));
  if (iendIndex < 12) return pngBuffer;
  const insertPos = iendIndex - 4; // 4 bytes length prefix before IEND

  const keyBuf = Buffer.from(keyword, "latin1");
  const valBuf = Buffer.from(textValue, "utf-8");
  const dataBuf = Buffer.concat([keyBuf, Buffer.from([0]), valBuf]);
  const typeBuf = Buffer.from("tEXt", "ascii");

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([
    pngBuffer.subarray(0, insertPos),
    lenBuf,
    typeBuf,
    dataBuf,
    crcBuf,
    pngBuffer.subarray(insertPos),
  ]);
}

function saveMediaDataUrlToDisk(
  dataUrl: string,
  feature: "text-to-image" | "image-to-image" | "image-to-video",
  outputDir: string,
  metadata?: SavedOutputMetadata
): { savedPath: string; fileName: string; downloadUrl: string; publicUrl: string } | null {
  try {
    ensureOutputDir(outputDir);
    const { mimeType, data } = parseDataUrl(dataUrl);
    const ext = mimeType.includes("mp4") || feature === "image-to-video"
      ? "mp4"
      : mimeType.includes("jpeg") || mimeType.includes("jpg")
      ? "jpg"
      : mimeType.includes("webp")
      ? "webp"
      : "png";
    const prefix =
      feature === "text-to-image"
        ? "t2i"
        : feature === "image-to-image"
        ? "i2i"
        : "i2v";
    const now = new Date();
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 15);
    const rand = Math.random().toString(36).slice(2, 6);
    const fileName = `${prefix}-${stamp}-${rand}.${ext}`;
    const savedPath = path.join(outputDir, fileName);

    let fileBuf: Buffer = Buffer.from(data, "base64");
    if (ext === "png" && metadata) {
      fileBuf = embedPngTextMetadata(fileBuf, "M5-MoE-Metadata", JSON.stringify(metadata));
    }
    fs.writeFileSync(savedPath, fileBuf);

    if (metadata) {
      const metaPath = `${savedPath}.meta.json`;
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
    }

    const encoded = encodeURIComponent(fileName);
    return {
      savedPath,
      fileName,
      publicUrl: `/api/outputs/file?name=${encoded}`,
      downloadUrl: `/api/outputs/file?name=${encoded}&download=1`,
    };
  } catch {
    return null;
  }
}

function loadWorkspaceState(): SyncedWorkspaceState {
  try {
    if (fs.existsSync(WORKSPACE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(WORKSPACE_STATE_FILE, "utf-8")) as SyncedWorkspaceState;
    }
  } catch {
    // ignore corrupt state
  }
  return { updatedAt: new Date(0).toISOString() };
}

function sanitizeMediaHistory(items?: GeneratedMediaItem[]): GeneratedMediaItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return items.slice(0, 30).map((item) => {
    const cleanOutputUrl =
      item.savedFileName
        ? `/api/outputs/file?name=${encodeURIComponent(item.savedFileName)}`
        : item.outputUrl;
    return {
      ...item,
      outputUrl: cleanOutputUrl,
      // Avoid bloating workspace_state.json with multi-MB source images when stored in history
      sourceImageUrl:
        item.sourceImageUrl && item.sourceImageUrl.length > 200_000
          ? undefined
          : item.sourceImageUrl,
    };
  });
}

function sanitizeChatMessages(msgs?: Array<Record<string, unknown>>): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(msgs)) return undefined;
  return msgs.slice(-60).map((m) => {
    const img = m.imageDataUrl;
    if (typeof img === "string" && img.length > 400_000) {
      const copy = { ...m };
      delete copy.imageDataUrl;
      return copy;
    }
    return m;
  });
}

function writeWorkspaceState(partial: Partial<SyncedWorkspaceState>): SyncedWorkspaceState {
  const existing = loadWorkspaceState();
  const next: SyncedWorkspaceState = {
    ...existing,
    ...(partial.experts !== undefined ? { experts: partial.experts } : {}),
    ...(partial.endpoints !== undefined ? { endpoints: partial.endpoints } : {}),
    ...(partial.swapStrategy !== undefined ? { swapStrategy: partial.swapStrategy } : {}),
    ...(partial.executionMode !== undefined ? { executionMode: partial.executionMode } : {}),
    ...(partial.chatMessages !== undefined
      ? { chatMessages: sanitizeChatMessages(partial.chatMessages) }
      : {}),
    ...(partial.t2iHistory !== undefined
      ? { t2iHistory: sanitizeMediaHistory(partial.t2iHistory) }
      : {}),
    ...(partial.i2iHistory !== undefined
      ? { i2iHistory: sanitizeMediaHistory(partial.i2iHistory) }
      : {}),
    ...(partial.i2vHistory !== undefined
      ? { i2vHistory: sanitizeMediaHistory(partial.i2vHistory) }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(STUDIO_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WORKSPACE_STATE_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function appendMediaItemToSyncedState(item: GeneratedMediaItem): SyncedWorkspaceState {
  const current = loadWorkspaceState();
  if (item.feature === "text-to-image") {
    return writeWorkspaceState({
      t2iHistory: [item, ...(current.t2iHistory || [])].slice(0, 30),
    });
  }
  if (item.feature === "image-to-image") {
    return writeWorkspaceState({
      i2iHistory: [item, ...(current.i2iHistory || [])].slice(0, 30),
    });
  }
  return writeWorkspaceState({
    i2vHistory: [item, ...(current.i2vHistory || [])].slice(0, 30),
  });
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function getLanAddresses(port: number) {
  const interfaces = os.networkInterfaces();
  const results: Array<{ interfaceName: string; address: string; url: string }> = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        results.push({
          interfaceName: name,
          address: addr.address,
          url: `http://${addr.address}:${port}`,
        });
      }
    }
  }
  return results;
}

async function probeUrl(url: string, pathSuffix: string, timeoutMs = 1100): Promise<{ online: boolean; detail?: string; body?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cleanBase = url.replace(/\/+$/, "");
    const res = await fetch(`${cleanBase}${pathSuffix}`, { signal: controller.signal });
    if (res.ok) {
      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        // non-JSON ok
      }
      return { online: true, detail: `HTTP ${res.status}`, body };
    }
    return { online: false, detail: `HTTP ${res.status}` };
  } catch {
    return { online: false, detail: "Not running" };
  } finally {
    clearTimeout(timer);
  }
}

function estimateModelSpecs(modelId: string, tags: string[] = []): {
  quantization: string;
  estimatedRamGb: number;
  fits16Gb: "comfortable" | "tight" | "exceeds";
} {
  const lower = `${modelId} ${tags.join(" ")}`.toLowerCase();

  let quantization = "FP16";
  if (lower.includes("4bit") || lower.includes("q4_") || lower.includes("int4") || lower.includes("4-bit")) {
    quantization = "4-bit MLX/GGUF";
  } else if (lower.includes("8bit") || lower.includes("q8_") || lower.includes("fp8")) {
    quantization = "8-bit";
  } else if (lower.includes("bf16") || lower.includes("bfloat16")) {
    quantization = "BF16";
  } else if (lower.includes("mlx")) {
    quantization = "4-bit MLX";
  }

  const paramRegex = /(?:^|[-_/\s])(\d+(?:\.\d+)?)b(?:[-_/\s]|$)/;
  const match = modelId.toLowerCase().match(paramRegex) || lower.match(paramRegex);
  let paramB = match ? parseFloat(match[1]) : 0;

  if (!paramB) {
    if (lower.includes("flux")) paramB = 12;
    else if (lower.includes("sdxl")) paramB = 3.5;
    else if (lower.includes("sd-turbo") || lower.includes("sd15") || lower.includes("1.5")) paramB = 1.1;
    else if (lower.includes("ltx-video")) paramB = 2.0;
    else if (lower.includes("svd") || lower.includes("stable-video")) paramB = 1.5;
    else if (lower.includes("wan2.1") && lower.includes("1.3")) paramB = 1.3;
    else paramB = 4.0;
  }

  const bytesPerParam =
    quantization.includes("4-bit") ? 0.58 : quantization.includes("8-bit") ? 1.08 : 2.1;

  const estimatedRamGb = Math.round((paramB * bytesPerParam + 1.2) * 10) / 10;

  let fits16Gb: "comfortable" | "tight" | "exceeds" = "comfortable";
  if (estimatedRamGb > 12.2) {
    fits16Gb = "exceeds";
  } else if (estimatedRamGb > 8.8) {
    fits16Gb = "tight";
  }

  return { quantization, estimatedRamGb, fits16Gb };
}

function getDirSizeGb(dirPath: string): number | null {
  try {
    let totalBytes = 0;
    const stack = [dirPath];
    let visited = 0;
    while (stack.length > 0 && visited < 400) {
      const current = stack.pop()!;
      visited++;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            totalBytes += fs.statSync(full).size;
          } catch {
            // ignore broken symlinks
          }
        }
      }
    }
    return Math.round((totalBytes / 1024 ** 3) * 100) / 100;
  } catch {
    return null;
  }
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: "image/png", data: dataUrl };
}

function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

const SYSTEM_PROMPTS: Record<string, string> = {
  chat: "You are a helpful, concise, privacy-first AI assistant running in an Apple Silicon M5 local MoE workspace.",
  "prompt-gen":
    "You are an expert visual prompt architect for local diffusion and video models (Flux, SDXL, LTX-Video, Wan2.1). Convert the user's idea into a vivid, comma-separated or structured prompt covering subject, composition, lighting, lens/camera, materials, and atmosphere. Provide one clean ready-to-paste prompt block.",
  "image-to-prompt":
    "You are an expert multimodal vision-to-prompt analyst. Inspect the attached image carefully and output a detailed, reproducible prompt suitable for Text-to-Image and Image-to-Video models. Describe subject, pose/geometry, materials, color palette, lighting direction, camera angle/focal length, and mood.",
};

async function runChatOnce(params: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  imageDataUrl?: string;
  mode: "chat" | "prompt-gen" | "image-to-prompt";
  model: string;
  runner: string;
  executionMode: "local" | "cloud-preview";
  endpoints?: Partial<typeof DEFAULT_ENDPOINTS>;
  signal?: AbortSignal;
}): Promise<{ text: string; modelUsed: string; engineUsed: string; elapsedMs: number }> {
  const t0 = Date.now();
  const eps = { ...DEFAULT_ENDPOINTS, ...params.endpoints };
  const systemPrompt = SYSTEM_PROMPTS[params.mode] || SYSTEM_PROMPTS.chat;

  if (params.executionMode === "cloud-preview") {
    const ai = getGeminiClient();
    if (!ai) {
      throw Object.assign(new Error("GEMINI_API_KEY is not configured in environment secrets for Preview Mode."), { statusCode: 500 });
    }
    const lastMessage = params.messages[params.messages.length - 1]?.content || "Describe this image as a generation prompt.";
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    if (params.imageDataUrl) {
      const parsed = parseDataUrl(params.imageDataUrl);
      parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
    }
    const conversationContext =
      params.messages.length > 1
        ? params.messages
            .slice(0, -1)
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
            .join("\n") + `\nUser: ${lastMessage}`
        : lastMessage;
    parts.push({ text: conversationContext });

    const response = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: { parts },
      config: { systemInstruction: systemPrompt },
    });
    return {
      text: response.text || "",
      modelUsed: "gemini-4-hydrogen (Cloud Preview)",
      engineUsed: "cloud-preview",
      elapsedMs: Date.now() - t0,
    };
  }

  if (params.runner === "ollama") {
    const ollamaMessages = [
      { role: "system", content: systemPrompt },
      ...params.messages.map((m, idx) => {
        const isLastUser = idx === params.messages.length - 1 && m.role === "user" && params.imageDataUrl;
        return {
          role: m.role,
          content: m.content,
          ...(isLastUser ? { images: [stripDataUrlPrefix(params.imageDataUrl!)] } : {}),
        };
      }),
    ];
    const oRes = await fetch(`${eps.ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: params.model, messages: ollamaMessages, stream: false }),
      signal: params.signal,
    });
    if (!oRes.ok) {
      throw Object.assign(new Error(`Ollama error: ${await oRes.text()}`), { statusCode: oRes.status });
    }
    const oData = (await oRes.json()) as { message?: { content?: string } };
    return {
      text: oData.message?.content || "",
      modelUsed: params.model,
      engineUsed: "ollama-local",
      elapsedMs: Date.now() - t0,
    };
  }

  if (params.runner === "openai-local") {
    const lastIdx = params.messages.length - 1;
    const oaMessages = [
      { role: "system", content: systemPrompt },
      ...params.messages.map((m, idx) => {
        if (idx === lastIdx && m.role === "user" && params.imageDataUrl) {
          return {
            role: "user",
            content: [
              { type: "text", text: m.content },
              { type: "image_url", image_url: { url: params.imageDataUrl } },
            ],
          };
        }
        return { role: m.role, content: m.content };
      }),
    ];
    const oaRes = await fetch(`${eps.openaiLocalUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: params.model, messages: oaMessages }),
      signal: params.signal,
    });
    if (!oaRes.ok) {
      throw Object.assign(new Error(`Local OpenAI server error: ${await oaRes.text()}`), { statusCode: oaRes.status });
    }
    const oaData = (await oaRes.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return {
      text: oaData.choices?.[0]?.message?.content || "",
      modelUsed: params.model,
      engineUsed: "openai-local",
      elapsedMs: Date.now() - t0,
    };
  }

  const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      imageDataUrl: params.imageDataUrl || null,
      mode: params.mode,
      systemPrompt,
    }),
    signal: params.signal,
  });
  const wData = (await wRes.json()) as { text?: string; detail?: string; elapsedMs?: number };
  if (!wRes.ok) {
    throw Object.assign(new Error(wData.detail || "M5 MLX Worker error"), { statusCode: wRes.status });
  }
  return {
    text: wData.text || "",
    modelUsed: params.model,
    engineUsed: "m5-mlx-worker",
    elapsedMs: wData.elapsedMs || Date.now() - t0,
  };
}

async function consumeSseStream(
  response: globalThis.Response,
  onEvent: (data: Record<string, unknown>) => void
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const rawJson = trimmed.slice(5).trim();
          if (rawJson && rawJson !== "[DONE]") {
            try {
              onEvent(JSON.parse(rawJson) as Record<string, unknown>);
            } catch {
              // ignore malformed fragment
            }
          }
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // SSE clients for live LAN queue & workspace state sync
  const sseClients = new Set<Response>();

  function broadcastSse(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  // LAN Access PIN middleware
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health" || req.path.startsWith("/auth/")) {
      next();
      return;
    }
    const sec = loadSecurityConfig();
    if (!sec.enabled || isLocalhostReq(req)) {
      next();
      return;
    }
    const token = extractRequestToken(req);
    if (verifyLanSessionToken(token, sec.updatedAt)) {
      next();
      return;
    }
    res.status(401).json({
      code: "LAN_PIN_REQUIRED",
      error: "A 4-digit LAN Access PIN is required to use this M5 MoE Studio host over Wi-Fi.",
    });
  });

  // Health & Auth Status
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/auth/status", (req: Request, res: Response) => {
    const sec = loadSecurityConfig();
    const localhost = isLocalhostReq(req);
    const token = extractRequestToken(req);
    const authenticated = !sec.enabled || localhost || verifyLanSessionToken(token, sec.updatedAt);
    res.json({
      lanPinEnabled: sec.enabled,
      authenticated,
      isLocalhost: localhost,
      requiresPin: sec.enabled && !authenticated,
    });
  });

  app.post("/api/auth/verify-pin", (req: Request, res: Response) => {
    const ip = req.socket.remoteAddress || "unknown";
    if (!checkPinRateLimit(ip)) {
      res.status(429).json({ error: "Too many PIN attempts. Try again in 5 minutes." });
      return;
    }
    const { pin } = req.body as { pin?: string };
    const sec = loadSecurityConfig();
    if (!sec.enabled) {
      res.json({ authenticated: true, token: "" });
      return;
    }
    if (!pin || !/^\d{4}$/.test(pin) || !verifyPinHash(pin, sec)) {
      recordPinFailure(ip);
      res.status(401).json({ error: "Incorrect 4-digit PIN." });
      return;
    }
    const token = createLanSessionToken(sec.updatedAt);
    res.json({ authenticated: true, token });
  });

  app.post("/api/auth/configure-pin", (req: Request, res: Response) => {
    const { enabled, pin, currentPin } = req.body as {
      enabled?: boolean;
      pin?: string;
      currentPin?: string;
    };
    const sec = loadSecurityConfig();
    const localhost = isLocalhostReq(req);
    const token = extractRequestToken(req);
    const sessionOk = verifyLanSessionToken(token, sec.updatedAt);

    if (sec.enabled && !localhost && !sessionOk) {
      if (!currentPin || !verifyPinHash(currentPin, sec)) {
        res.status(403).json({ error: "Current PIN or host session required to update LAN PIN." });
        return;
      }
    }

    if (enabled) {
      if (!pin || !/^\d{4}$/.test(pin)) {
        res.status(400).json({ error: "PIN must be exactly 4 digits (0-9)." });
        return;
      }
      const salt = crypto.randomBytes(16).toString("hex");
      const updatedAt = new Date().toISOString();
      const next: PersistedSecurityConfig = {
        enabled: true,
        salt,
        pinHash: hashPin(pin, salt),
        updatedAt,
      };
      writeSecurityConfig(next);
      const newToken = createLanSessionToken(updatedAt);
      res.json({
        lanPinEnabled: true,
        authenticated: true,
        isLocalhost: localhost,
        requiresPin: false,
        token: newToken,
      });
      return;
    }

    const next: PersistedSecurityConfig = {
      enabled: false,
      salt: "",
      pinHash: "",
      updatedAt: new Date().toISOString(),
    };
    writeSecurityConfig(next);
    res.json({
      lanPinEnabled: false,
      authenticated: true,
      isLocalhost: localhost,
      requiresPin: false,
      token: "",
    });
  });

  // Live SSE Event Hub
  app.get("/api/events", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    sseClients.add(res);
    res.write(`event: queue:update\ndata: ${JSON.stringify(getQueueSnapshot())}\n\n`);

    const keepalive = setInterval(() => {
      try {
        res.write(":keepalive\n\n");
      } catch {
        clearInterval(keepalive);
        sseClients.delete(res);
      }
    }, 20000);

    req.on("close", () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  });

  // Host Synced Workspace State
  app.get("/api/state", (_req: Request, res: Response) => {
    res.json(loadWorkspaceState());
  });

  app.put("/api/state", (req: Request, res: Response) => {
    const updated = writeWorkspaceState(req.body as Partial<SyncedWorkspaceState>);
    broadcastSse("state:update", updated);
    res.json(updated);
  });

  // System & Worker Health
  app.get("/api/system/info", async (req: Request, res: Response) => {
    const mlxWorkerUrl = String(req.query.mlxWorkerUrl || DEFAULT_ENDPOINTS.mlxWorkerUrl);
    const ollamaUrl = String(req.query.ollamaUrl || DEFAULT_ENDPOINTS.ollamaUrl);
    const openaiLocalUrl = String(req.query.openaiLocalUrl || DEFAULT_ENDPOINTS.openaiLocalUrl);
    const a1111Url = String(req.query.a1111Url || DEFAULT_ENDPOINTS.a1111Url);
    const comfyuiUrl = String(req.query.comfyuiUrl || DEFAULT_ENDPOINTS.comfyuiUrl);

    const [mlxProbe, ollamaProbe, openaiProbe, a1111Probe, comfyProbe] = await Promise.all([
      probeUrl(mlxWorkerUrl, "/health"),
      probeUrl(ollamaUrl, "/api/tags"),
      probeUrl(openaiLocalUrl, "/v1/models"),
      probeUrl(a1111Url, "/sdapi/v1/sd-models"),
      probeUrl(comfyuiUrl, "/system_stats"),
    ]);

    const hostname = os.hostname().replace(/\.local$/, "");
    const cpus = os.cpus();
    const mlxBody = (mlxProbe.body || {}) as Record<string, unknown>;

    res.json({
      hostname,
      mdnsUrl: `http://${hostname}.local:${PORT}`,
      port: PORT,
      platform: os.platform(),
      arch: os.arch(),
      cpuModel: cpus[0]?.model || "Apple Silicon / Host CPU",
      totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      freeMemoryGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
      lanAddresses: getLanAddresses(PORT),
      runners: [
        { id: "mlx-worker", label: "M5 MLX Worker", url: mlxWorkerUrl, online: mlxProbe.online, detail: mlxProbe.detail },
        { id: "ollama", label: "Ollama", url: ollamaUrl, online: ollamaProbe.online, detail: ollamaProbe.detail },
        { id: "openai-local", label: "MLX / LM Studio", url: openaiLocalUrl, online: openaiProbe.online, detail: openaiProbe.detail },
        { id: "a1111", label: "A1111 / Forge", url: a1111Url, online: a1111Probe.online, detail: a1111Probe.detail },
        { id: "comfyui", label: "ComfyUI", url: comfyuiUrl, online: comfyProbe.online, detail: comfyProbe.detail },
      ],
      workerHealth: mlxProbe.online
        ? {
            online: true,
            activeSlot: (mlxBody.activeSlot as string | null) ?? null,
            activeModel: (mlxBody.activeModel as string | null) ?? null,
            idleTimeoutSeconds: Number(mlxBody.idleTimeoutSeconds ?? 300),
            idleSecondsRemaining:
              mlxBody.idleSecondsRemaining !== null && mlxBody.idleSecondsRemaining !== undefined
                ? Number(mlxBody.idleSecondsRemaining)
                : null,
            activeMemoryGb:
              mlxBody.activeMemoryGb !== null && mlxBody.activeMemoryGb !== undefined
                ? Number(mlxBody.activeMemoryGb)
                : null,
            busy: Boolean(mlxBody.busy),
          }
        : null,
      geminiPreviewAvailable: Boolean(getGeminiClient()),
    });
  });

  app.post("/api/worker/unload", async (req: Request, res: Response) => {
    const mlxWorkerUrl = String(req.body?.mlxWorkerUrl || DEFAULT_ENDPOINTS.mlxWorkerUrl);
    try {
      const wRes = await fetch(`${mlxWorkerUrl.replace(/\/+$/, "")}/unload`, { method: "POST" });
      if (!wRes.ok) {
        res.status(wRes.status).json({ error: await wRes.text() });
        return;
      }
      res.json(await wRes.json());
    } catch {
      res.status(503).json({
        code: "LOCAL_RUNNER_OFFLINE",
        error: `M5 MLX Worker is not running at ${mlxWorkerUrl}.`,
      });
    }
  });

  app.post("/api/worker/idle-config", async (req: Request, res: Response) => {
    const mlxWorkerUrl = String(req.body?.mlxWorkerUrl || DEFAULT_ENDPOINTS.mlxWorkerUrl);
    const idleTimeoutSeconds = Number(req.body?.idleTimeoutSeconds ?? 300);
    try {
      const wRes = await fetch(`${mlxWorkerUrl.replace(/\/+$/, "")}/config/idle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idleTimeoutSeconds }),
      });
      if (!wRes.ok) {
        res.status(wRes.status).json({ error: await wRes.text() });
        return;
      }
      res.json(await wRes.json());
    } catch {
      res.status(503).json({
        code: "LOCAL_RUNNER_OFFLINE",
        error: `M5 MLX Worker is not running at ${mlxWorkerUrl}.`,
      });
    }
  });

  // Downloadable local M5 Apple Silicon Python worker script
  app.get("/api/worker/script", (_req: Request, res: Response) => {
    const scriptPath = path.resolve(__dirname, "scripts", "m5_mlx_worker.py");
    if (!fs.existsSync(scriptPath)) {
      res.status(404).json({ error: "Worker script not found" });
      return;
    }
    res.setHeader("Content-Disposition", 'attachment; filename="m5_mlx_worker.py"');
    res.setHeader("Content-Type", "text/x-python; charset=utf-8");
    res.sendFile(scriptPath);
  });

  // Local Drive Output Folder Config & Saved Files Browser
  app.get("/api/storage/config", (_req: Request, res: Response) => {
    const cfg = loadStorageConfig();
    res.json(getStorageStats(cfg));
  });

  app.post("/api/storage/config", (req: Request, res: Response) => {
    const { outputDir, autoSaveToDisk } = req.body as {
      outputDir?: string;
      autoSaveToDisk?: boolean;
    };
    const current = loadStorageConfig();
    const nextDir =
      typeof outputDir === "string" && outputDir.trim()
        ? resolveUserPath(outputDir)
        : current.outputDir;

    const status = ensureOutputDir(nextDir);
    if (!status.exists || !status.writable) {
      res.status(400).json({
        error: `Cannot create or write to folder: ${nextDir}. Check macOS folder permissions.`,
      });
      return;
    }

    const updated: PersistedStorageConfig = {
      outputDir: nextDir,
      autoSaveToDisk:
        typeof autoSaveToDisk === "boolean"
          ? autoSaveToDisk
          : current.autoSaveToDisk,
    };
    writeStorageConfig(updated);
    res.json(getStorageStats(updated));
  });

  app.get("/api/outputs/list", (_req: Request, res: Response) => {
    const cfg = loadStorageConfig();
    const status = ensureOutputDir(cfg.outputDir);
    if (!status.exists) {
      res.json({ outputDir: cfg.outputDir, files: [] });
      return;
    }
    try {
      const files = fs
        .readdirSync(cfg.outputDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && ALLOWED_MEDIA_EXTS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => {
          const fullPath = path.join(cfg.outputDir, entry.name);
          const stat = fs.statSync(fullPath);
          const ext = path.extname(entry.name).toLowerCase();
          const isVideo = ext === ".mp4" || ext === ".mov" || ext === ".webm";
          const feature = entry.name.startsWith("t2i-")
            ? "text-to-image"
            : entry.name.startsWith("i2i-")
            ? "image-to-image"
            : entry.name.startsWith("i2v-")
            ? "image-to-video"
            : "other";
          const mimeType =
            ext === ".mp4"
              ? "video/mp4"
              : ext === ".mov"
              ? "video/quicktime"
              : ext === ".webm"
              ? "video/webm"
              : ext === ".jpg" || ext === ".jpeg"
              ? "image/jpeg"
              : ext === ".webp"
              ? "image/webp"
              : "image/png";
          const encoded = encodeURIComponent(entry.name);

          let metadata: SavedOutputMetadata | undefined;
          const metaPath = `${fullPath}.meta.json`;
          if (fs.existsSync(metaPath)) {
            try {
              metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as SavedOutputMetadata;
            } catch {
              // ignore corrupt sidecar
            }
          }

          return {
            name: entry.name,
            feature,
            mimeType,
            isVideo,
            sizeBytes: stat.size,
            createdAt: stat.mtime.toISOString(),
            url: `/api/outputs/file?name=${encoded}`,
            downloadUrl: `/api/outputs/file?name=${encoded}&download=1`,
            fullPath,
            metadata,
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 120);

      res.json({ outputDir: cfg.outputDir, files });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to list outputs";
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/outputs/file", (req: Request, res: Response) => {
    const rawName = String(req.query.name || "");
    const safeName = path.basename(rawName);
    if (!safeName || safeName !== rawName || !ALLOWED_MEDIA_EXTS.has(path.extname(safeName).toLowerCase())) {
      res.status(400).json({ error: "Invalid file name" });
      return;
    }
    const cfg = loadStorageConfig();
    const baseDir = path.resolve(cfg.outputDir);
    const targetPath = path.resolve(baseDir, safeName);
    if (!targetPath.startsWith(baseDir + path.sep) || !fs.existsSync(targetPath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    if (req.query.download === "1") {
      res.download(targetPath, safeName);
      return;
    }
    res.sendFile(targetPath);
  });

  app.post("/api/outputs/save", (req: Request, res: Response) => {
    const { dataUrl, feature, metadata } = req.body as {
      dataUrl?: string;
      feature?: "text-to-image" | "image-to-image" | "image-to-video";
      metadata?: SavedOutputMetadata;
    };
    if (!dataUrl || !feature) {
      res.status(400).json({ error: "dataUrl and feature are required" });
      return;
    }
    const cfg = loadStorageConfig();
    const saved = saveMediaDataUrlToDisk(dataUrl, feature, cfg.outputDir, metadata);
    if (!saved) {
      res.status(500).json({ error: `Failed to write file to ${cfg.outputDir}` });
      return;
    }
    res.json(saved);
  });

  app.delete("/api/outputs/file", (req: Request, res: Response) => {
    const rawName = String(req.query.name || "");
    const safeName = path.basename(rawName);
    if (!safeName || safeName !== rawName || !ALLOWED_MEDIA_EXTS.has(path.extname(safeName).toLowerCase())) {
      res.status(400).json({ error: "Invalid file name" });
      return;
    }
    const cfg = loadStorageConfig();
    const baseDir = path.resolve(cfg.outputDir);
    const targetPath = path.resolve(baseDir, safeName);
    if (!targetPath.startsWith(baseDir + path.sep) || !fs.existsSync(targetPath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    fs.unlinkSync(targetPath);
    const sidecarPath = `${targetPath}.meta.json`;
    if (sidecarPath.startsWith(baseDir + path.sep) && fs.existsSync(sidecarPath)) {
      try {
        fs.unlinkSync(sidecarPath);
      } catch {
        // ignore sidecar removal errors
      }
    }
    res.json({ deleted: safeName });
  });

  // Live Hugging Face Hub Search
  app.get("/api/hf/search", async (req: Request, res: Response) => {
    const q = String(req.query.q || "").trim();
    const feature = String(req.query.feature || "chat");
    const limit = Math.min(Number(req.query.limit || 20), 40);

    const pipelineMap: Record<string, string> = {
      chat: "",
      "text-to-image": "text-to-image",
      "image-to-image": "image-to-image",
      "image-to-video": "image-to-video",
    };

    const params = new URLSearchParams();
    if (q) {
      params.set("search", q);
    } else if (feature === "chat") {
      params.set("search", "mlx-community 4bit");
    }
    const pipelineTag = pipelineMap[feature];
    if (pipelineTag) {
      params.set("pipeline_tag", pipelineTag);
    }
    params.set("sort", "downloads");
    params.set("direction", "-1");
    params.set("limit", String(limit));

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const hfRes = await fetch(`https://huggingface.co/api/models?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timer);

      if (!hfRes.ok) {
        res.status(hfRes.status).json({
          error: `Hugging Face Hub returned HTTP ${hfRes.status}`,
        });
        return;
      }

      const rawModels = (await hfRes.json()) as Array<{
        id: string;
        downloads?: number;
        likes?: number;
        pipeline_tag?: string;
        tags?: string[];
        lastModified?: string;
      }>;

      const models = rawModels.map((m) => {
        const parts = m.id.split("/");
        const author = parts.length > 1 ? parts[0] : "community";
        const name = parts.length > 1 ? parts.slice(1).join("/") : m.id;
        const specs = estimateModelSpecs(m.id, m.tags || []);
        return {
          id: m.id,
          author,
          name,
          downloads: m.downloads ?? 0,
          likes: m.likes ?? 0,
          pipelineTag: m.pipeline_tag || pipelineTag || "text-generation",
          tags: (m.tags || []).slice(0, 6),
          lastModified: m.lastModified,
          ...specs,
        };
      });

      res.json({ models });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reach Hugging Face Hub";
      res.status(502).json({ error: msg });
    }
  });

  // Scan Local Models
  app.get("/api/local/models", async (req: Request, res: Response) => {
    const mlxWorkerUrl = String(req.query.mlxWorkerUrl || DEFAULT_ENDPOINTS.mlxWorkerUrl);
    const ollamaUrl = String(req.query.ollamaUrl || DEFAULT_ENDPOINTS.ollamaUrl);

    const found: Array<{
      id: string;
      name: string;
      path: string;
      runner: string;
      sizeGb: number | null;
      sourceType: string;
    }> = [];

    const hfHubDir = path.join(os.homedir(), ".cache", "huggingface", "hub");
    if (fs.existsSync(hfHubDir)) {
      try {
        for (const entry of fs.readdirSync(hfHubDir)) {
          if (entry.startsWith("models--")) {
            const repoId = entry.replace("models--", "").replace(/--/g, "/");
            const fullPath = path.join(hfHubDir, entry);
            found.push({
              id: repoId,
              name: repoId.split("/").pop() || repoId,
              path: fullPath,
              runner: "mlx-worker",
              sizeGb: getDirSizeGb(fullPath),
              sourceType: "hf-cache",
            });
          }
        }
      } catch {
        // ignore
      }
    }

    const customDirs = [
      path.join(os.homedir(), "Models"),
      path.join(os.homedir(), ".lmstudio", "models"),
    ];
    for (const baseDir of customDirs) {
      if (fs.existsSync(baseDir)) {
        try {
          for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
            if (entry.isDirectory() || entry.name.endsWith(".gguf") || entry.name.endsWith(".safetensors")) {
              const fullPath = path.join(baseDir, entry.name);
              found.push({
                id: fullPath,
                name: entry.name,
                path: fullPath,
                runner: "mlx-worker",
                sizeGb: entry.isDirectory() ? getDirSizeGb(fullPath) : Math.round((fs.statSync(fullPath).size / 1024 ** 3) * 100) / 100,
                sourceType: "directory",
              });
            }
          }
        } catch {
          // ignore
        }
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      const oRes = await fetch(`${ollamaUrl.replace(/\/+$/, "")}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (oRes.ok) {
        const data = (await oRes.json()) as { models?: Array<{ name: string; size?: number }> };
        for (const m of data.models || []) {
          found.push({
            id: m.name,
            name: m.name,
            path: `ollama://${m.name}`,
            runner: "ollama",
            sizeGb: m.size ? Math.round((m.size / 1024 ** 3) * 100) / 100 : null,
            sourceType: "ollama",
          });
        }
      }
    } catch {
      // Ollama offline
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      const wRes = await fetch(`${mlxWorkerUrl.replace(/\/+$/, "")}/models`, { signal: controller.signal });
      clearTimeout(timer);
      if (wRes.ok) {
        const data = (await wRes.json()) as { models?: Array<{ id: string; path: string }> };
        for (const m of data.models || []) {
          if (!found.some((x) => x.id === m.id)) {
            found.push({
              id: m.id,
              name: m.id.split("/").pop() || m.id,
              path: m.path,
              runner: "mlx-worker",
              sizeGb: null,
              sourceType: "mlx-worker",
            });
          }
        }
      }
    } catch {
      // Worker offline
    }

    res.json({ models: found });
  });

  // Model Pull (legacy JSON + Streaming SSE)
  app.post("/api/models/pull", async (req: Request, res: Response) => {
    const { modelId, runner, endpoints } = req.body as {
      modelId: string;
      runner: string;
      endpoints?: Partial<typeof DEFAULT_ENDPOINTS>;
    };
    if (!modelId) {
      res.status(400).json({ error: "modelId is required" });
      return;
    }

    const eps = { ...DEFAULT_ENDPOINTS, ...endpoints };

    if (runner === "ollama") {
      try {
        const oRes = await fetch(`${eps.ollamaUrl.replace(/\/+$/, "")}/api/pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: modelId, stream: false }),
        });
        const text = await oRes.text();
        if (!oRes.ok) {
          res.status(oRes.status).json({ error: text });
          return;
        }
        res.json({ status: "pulled", modelId, detail: text });
        return;
      } catch {
        res.status(503).json({
          code: "LOCAL_RUNNER_OFFLINE",
          error: `Ollama is not reachable at ${eps.ollamaUrl}. Run \`ollama pull ${modelId}\` in Terminal on your M5 Mac.`,
          command: `ollama pull ${modelId}`,
        });
        return;
      }
    }

    try {
      const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = await wRes.json();
      if (!wRes.ok) {
        res.status(wRes.status).json({ error: data.detail || "Pull failed" });
        return;
      }
      res.json(data);
    } catch {
      res.status(503).json({
        code: "LOCAL_RUNNER_OFFLINE",
        error: `M5 MLX Worker is not running at ${eps.mlxWorkerUrl}. Download it manually in Terminal on your M5 Mac.`,
        command: `huggingface-cli download ${modelId}`,
      });
    }
  });

  app.post("/api/models/pull/stream", async (req: Request, res: Response) => {
    const { modelId, runner, endpoints } = req.body as {
      modelId?: string;
      runner?: string;
      endpoints?: Partial<typeof DEFAULT_ENDPOINTS>;
    };
    if (!modelId) {
      res.status(400).json({ error: "modelId is required" });
      return;
    }

    const eps = { ...DEFAULT_ENDPOINTS, ...endpoints };
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const sendEvent = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    if (runner === "ollama") {
      try {
        const oRes = await fetch(`${eps.ollamaUrl.replace(/\/+$/, "")}/api/pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: modelId, stream: true }),
        });
        if (!oRes.ok || !oRes.body) {
          sendEvent({
            status: "error",
            error: `Ollama pull failed (HTTP ${oRes.status})`,
            done: true,
          });
          res.end();
          return;
        }
        const reader = oRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastTs = Date.now();
        let lastBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line) as {
                status?: string;
                completed?: number;
                total?: number;
                error?: string;
              };
              if (obj.error) {
                sendEvent({ status: "error", error: obj.error, done: true });
                res.end();
                return;
              }
              const completed = obj.completed || 0;
              const total = obj.total || 0;
              const now = Date.now();
              const dt = Math.max(0.1, (now - lastTs) / 1000);
              const speedMbps =
                completed >= lastBytes
                  ? Math.round(((completed - lastBytes) / (1024 * 1024) / dt) * 100) / 100
                  : 0;
              lastTs = now;
              lastBytes = completed;
              const percent = total > 0 ? Math.round((completed / total) * 1000) / 10 : 0;
              sendEvent({
                status: obj.status || "downloading",
                modelId,
                downloadedBytes: completed,
                totalBytes: total,
                percent,
                speedMbps,
                message: obj.status || "Pulling Ollama layers...",
                done: obj.status === "success",
              });
            } catch {
              // ignore fragment
            }
          }
        }
        sendEvent({
          status: "downloaded",
          modelId,
          percent: 100,
          message: `Pulled ${modelId} via Ollama.`,
          done: true,
        });
        res.end();
        return;
      } catch {
        sendEvent({
          status: "error",
          code: "LOCAL_RUNNER_OFFLINE",
          error: `Ollama is not reachable at ${eps.ollamaUrl}. Run \`ollama pull ${modelId}\` in Terminal on your M5 Mac.`,
          command: `ollama pull ${modelId}`,
          done: true,
        });
        res.end();
        return;
      }
    }

    // M5 MLX Worker /pull/stream
    try {
      const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/pull/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      if (!wRes.ok || !wRes.body) {
        sendEvent({
          status: "error",
          error: `M5 Worker pull failed (HTTP ${wRes.status})`,
          done: true,
        });
        res.end();
        return;
      }
      await consumeSseStream(wRes, (evt) => {
        sendEvent(evt);
      });
      res.end();
    } catch {
      sendEvent({
        status: "error",
        code: "LOCAL_RUNNER_OFFLINE",
        error: `M5 MLX Worker is not running at ${eps.mlxWorkerUrl}. Download it manually in Terminal on your M5 Mac.`,
        command: `huggingface-cli download ${modelId}`,
        done: true,
      });
      res.end();
    }
  });

  // Feature 1: Chat & Prompt Generation (non-stream + SSE stream)
  app.post("/api/infer/chat", async (req: Request, res: Response) => {
    const body = req.body as {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      imageDataUrl?: string;
      mode: "chat" | "prompt-gen" | "image-to-prompt";
      model: string;
      runner: string;
      executionMode: "local" | "cloud-preview";
      endpoints?: Partial<typeof DEFAULT_ENDPOINTS>;
    };
    try {
      const result = await runChatOnce(body);
      res.json(result);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status) {
        res.status(status).json({ error: (err as Error).message });
      } else {
        res.status(503).json({
          code: "LOCAL_RUNNER_OFFLINE",
          error: `Could not connect to local ${body.runner} runner. Start your local M5 inference worker (or switch to Preview Mode in the sidebar to test Chat & Image-to-Prompt).`,
        });
      }
    }
  });

  app.post("/api/infer/chat/stream", async (req: Request, res: Response) => {
    const t0 = Date.now();
    const {
      messages,
      imageDataUrl,
      mode,
      model,
      runner,
      executionMode,
      endpoints,
    } = req.body as {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      imageDataUrl?: string;
      mode: "chat" | "prompt-gen" | "image-to-prompt";
      model: string;
      runner: string;
      executionMode: "local" | "cloud-preview";
      endpoints?: Partial<typeof DEFAULT_ENDPOINTS>;
    };

    const eps = { ...DEFAULT_ENDPOINTS, ...endpoints };
    const systemPrompt = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.chat;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const sendEvent = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    if (executionMode === "cloud-preview") {
      const ai = getGeminiClient();
      if (!ai) {
        sendEvent({
          type: "error",
          error: "GEMINI_API_KEY is not configured in environment secrets for Preview Mode.",
        });
        res.end();
        return;
      }
      try {
        const lastMessage = messages[messages.length - 1]?.content || "Describe this image as a generation prompt.";
        const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
        if (imageDataUrl) {
          const parsed = parseDataUrl(imageDataUrl);
          parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
        }
        const conversationContext =
          messages.length > 1
            ? messages
                .slice(0, -1)
                .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
                .join("\n") + `\nUser: ${lastMessage}`
            : lastMessage;
        parts.push({ text: conversationContext });

        const stream = await ai.models.generateContentStream({
          model: "gemini-4-hydrogen",
          contents: { parts },
          config: { systemInstruction: systemPrompt },
        });

        let fullText = "";
        for await (const chunk of stream) {
          const delta = chunk.text || "";
          if (delta) {
            fullText += delta;
            sendEvent({ type: "delta", text: delta });
          }
        }
        sendEvent({
          type: "done",
          text: fullText,
          modelUsed: "gemini-4-hydrogen (Cloud Preview)",
          engineUsed: "cloud-preview",
          elapsedMs: Date.now() - t0,
        });
        res.end();
        return;
      } catch (err) {
        sendEvent({
          type: "error",
          error: err instanceof Error ? err.message : "Gemini stream failed",
        });
        res.end();
        return;
      }
    }

    try {
      if (runner === "ollama") {
        const ollamaMessages = [
          { role: "system", content: systemPrompt },
          ...messages.map((m, idx) => {
            const isLastUser = idx === messages.length - 1 && m.role === "user" && imageDataUrl;
            return {
              role: m.role,
              content: m.content,
              ...(isLastUser ? { images: [stripDataUrlPrefix(imageDataUrl!)] } : {}),
            };
          }),
        ];
        const oRes = await fetch(`${eps.ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: ollamaMessages, stream: true }),
        });
        if (!oRes.ok || !oRes.body) {
          sendEvent({ type: "error", error: `Ollama error: ${await oRes.text()}` });
          res.end();
          return;
        }
        const reader = oRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line) as { message?: { content?: string } };
              const delta = obj.message?.content || "";
              if (delta) {
                fullText += delta;
                sendEvent({ type: "delta", text: delta });
              }
            } catch {
              // ignore
            }
          }
        }
        sendEvent({
          type: "done",
          text: fullText,
          modelUsed: model,
          engineUsed: "ollama-local",
          elapsedMs: Date.now() - t0,
        });
        res.end();
        return;
      }

      if (runner === "openai-local") {
        const lastIdx = messages.length - 1;
        const oaMessages = [
          { role: "system", content: systemPrompt },
          ...messages.map((m, idx) => {
            if (idx === lastIdx && m.role === "user" && imageDataUrl) {
              return {
                role: "user",
                content: [
                  { type: "text", text: m.content },
                  { type: "image_url", image_url: { url: imageDataUrl } },
                ],
              };
            }
            return { role: m.role, content: m.content };
          }),
        ];
        const oaRes = await fetch(`${eps.openaiLocalUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: oaMessages, stream: true }),
        });
        if (!oaRes.ok || !oaRes.body) {
          sendEvent({ type: "error", error: `Local OpenAI server error: ${await oaRes.text()}` });
          res.end();
          return;
        }
        let fullText = "";
        await consumeSseStream(oaRes, (evt) => {
          const choices = evt.choices as Array<{ delta?: { content?: string } }> | undefined;
          const delta = choices?.[0]?.delta?.content || "";
          if (delta) {
            fullText += delta;
            sendEvent({ type: "delta", text: delta });
          }
        });
        sendEvent({
          type: "done",
          text: fullText,
          modelUsed: model,
          engineUsed: "openai-local",
          elapsedMs: Date.now() - t0,
        });
        res.end();
        return;
      }

      // M5 MLX Worker /chat/stream
      const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          imageDataUrl: imageDataUrl || null,
          mode,
          systemPrompt,
        }),
      });
      if (!wRes.ok || !wRes.body) {
        sendEvent({ type: "error", error: `M5 MLX Worker stream error (HTTP ${wRes.status})` });
        res.end();
        return;
      }
      let fullText = "";
      await consumeSseStream(wRes, (evt) => {
        if (evt.type === "delta" && typeof evt.text === "string") {
          fullText += evt.text;
          sendEvent({ type: "delta", text: evt.text });
        } else if (evt.type === "done") {
          sendEvent({
            type: "done",
            text: typeof evt.text === "string" ? evt.text : fullText,
            modelUsed: model,
            engineUsed: "m5-mlx-worker",
            elapsedMs: Number(evt.elapsedMs || Date.now() - t0),
          });
        } else if (evt.type === "error") {
          sendEvent({ type: "error", error: String(evt.error || "MLX stream failed") });
        }
      });
      res.end();
    } catch {
      sendEvent({
        type: "error",
        code: "LOCAL_RUNNER_OFFLINE",
        error: `Could not connect to local ${runner} runner. Start your local M5 inference worker (or switch to Preview Mode in the sidebar to test Chat & Image-to-Prompt).`,
      });
      res.end();
    }
  });

  // =========================================================================
  // Single-File FIFO Render Queue (LAN-Safe for M5 16GB Unified Memory)
  // =========================================================================
  const jobQueue: RenderJob[] = [];
  let activeAbortController: AbortController | null = null;
  let isQueueRunning = false;

  function recomputeQueuePositions() {
    let qPos = 1;
    for (const j of jobQueue) {
      if (j.status === "running") {
        j.position = 0;
      } else if (j.status === "queued") {
        j.position = qPos++;
      } else {
        j.position = -1;
      }
    }
  }

  function getQueueSnapshot() {
    recomputeQueuePositions();
    return {
      jobs: jobQueue.slice(0, 20).map(({ payload: _omit, ...rest }) => rest),
      activeCount: jobQueue.filter((j) => j.status === "running").length,
      queuedCount: jobQueue.filter((j) => j.status === "queued").length,
    };
  }

  function notifyQueueUpdate() {
    broadcastSse("queue:update", getQueueSnapshot());
  }

  async function executeTextToImage(
    job: RenderJob,
    p: Record<string, unknown>,
    signal: AbortSignal,
    stepScale: { startPct: number; endPct: number; stagePrefix?: string } = { startPct: 0, endPct: 100 }
  ): Promise<GeneratedMediaItem> {
    const t0 = Date.now();
    const model = String(p.model || "");
    const runner = String(p.runner || "mlx-worker");
    const prompt = String(p.prompt || "");
    const negativePrompt = String(p.negativePrompt || "");
    const width = Number(p.width || 1024);
    const height = Number(p.height || 1024);
    const steps = Number(p.steps || 4);
    const guidanceScale = Number(p.guidanceScale ?? 3.5);
    const seed = p.seed !== undefined && p.seed !== null ? Number(p.seed) : undefined;
    const eps = { ...DEFAULT_ENDPOINTS, ...((p.endpoints as Partial<typeof DEFAULT_ENDPOINTS>) || {}) };

    let dataUrl = "";
    let runnerUsed = runner;
    let elapsedMs = 0;

    if (runner === "a1111") {
      job.stepLabel = `${stepScale.stagePrefix || ""}Rendering via A1111...`;
      notifyQueueUpdate();
      const aRes = await fetch(`${eps.a1111Url.replace(/\/+$/, "")}/sdapi/v1/txt2img`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          negative_prompt: negativePrompt,
          width,
          height,
          steps,
          cfg_scale: guidanceScale,
          seed: seed ?? -1,
          override_settings: { sd_model_checkpoint: model },
        }),
        signal,
      });
      if (!aRes.ok) throw new Error(await aRes.text());
      const aData = (await aRes.json()) as { images?: string[] };
      if (!aData.images?.[0]) throw new Error("A1111 returned no image");
      dataUrl = `data:image/png;base64,${aData.images[0]}`;
      elapsedMs = Date.now() - t0;
    } else {
      runnerUsed = "m5-mlx-worker";
      const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/text-to-image/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          negativePrompt,
          width,
          height,
          steps,
          guidanceScale,
          seed: seed ?? null,
        }),
        signal,
      });
      if (!wRes.ok) {
        const errText = await wRes.text();
        throw new Error(errText || "M5 MLX T2I stream failed");
      }
      await consumeSseStream(wRes, (evt) => {
        if (evt.type === "step") {
          const s = Number(evt.step || 0);
          const tot = Math.max(1, Number(evt.total || steps));
          const span = stepScale.endPct - stepScale.startPct;
          job.currentStep = s;
          job.totalSteps = tot;
          job.progressPercent = Math.round(stepScale.startPct + (s / tot) * span);
          job.stepLabel = `${stepScale.stagePrefix || ""}${String(evt.stage || `Step ${s}/${tot}`)}`;
          if (typeof evt.previewDataUrl === "string") {
            job.previewUrl = evt.previewDataUrl;
          }
          job.updatedAt = new Date().toISOString();
          notifyQueueUpdate();
        } else if (evt.type === "done") {
          dataUrl = String(evt.imageDataUrl || "");
          elapsedMs = Number(evt.elapsedMs || Date.now() - t0);
        } else if (evt.type === "error") {
          throw new Error(String(evt.error || "T2I failed"));
        }
      });
    }

    if (!dataUrl) throw new Error("Worker returned empty image output");

    const nowIso = new Date().toISOString();
    const metadata: SavedOutputMetadata = {
      feature: "text-to-image",
      prompt,
      negativePrompt: negativePrompt || undefined,
      modelUsed: model,
      runnerUsed,
      width,
      height,
      steps,
      guidanceScale,
      seed,
      elapsedMs,
      createdAt: nowIso,
    };

    const storageCfg = loadStorageConfig();
    const saved = storageCfg.autoSaveToDisk
      ? saveMediaDataUrlToDisk(dataUrl, "text-to-image", storageCfg.outputDir, metadata)
      : null;

    const item: GeneratedMediaItem = {
      id: `t2i-${Date.now()}`,
      feature: "text-to-image",
      prompt,
      negativePrompt: negativePrompt || undefined,
      outputUrl: saved ? saved.publicUrl : dataUrl,
      mimeType: "image/png",
      modelUsed: model,
      runnerUsed,
      width,
      height,
      steps,
      guidanceScale,
      seed,
      elapsedMs,
      savedPath: saved?.savedPath,
      savedFileName: saved?.fileName,
      downloadUrl: saved?.downloadUrl,
      createdAt: nowIso,
    };
    const nextState = appendMediaItemToSyncedState(item);
    broadcastSse("state:update", nextState);
    // Return inline dataUrl for immediate canvas display while synced state stores file URL
    return { ...item, outputUrl: dataUrl };
  }

  async function executeImageToImage(
    job: RenderJob,
    p: Record<string, unknown>,
    signal: AbortSignal,
    stepScale: { startPct: number; endPct: number; stagePrefix?: string } = { startPct: 0, endPct: 100 }
  ): Promise<GeneratedMediaItem> {
    const t0 = Date.now();
    const model = String(p.model || "");
    const runner = String(p.runner || "mlx-worker");
    const prompt = String(p.prompt || "");
    const negativePrompt = String(p.negativePrompt || "");
    const imageDataUrl = String(p.imageDataUrl || "");
    const strength = Number(p.strength ?? 0.65);
    const steps = Number(p.steps || 12);
    const guidanceScale = Number(p.guidanceScale ?? 7.0);
    const seed = p.seed !== undefined && p.seed !== null ? Number(p.seed) : undefined;
    const eps = { ...DEFAULT_ENDPOINTS, ...((p.endpoints as Partial<typeof DEFAULT_ENDPOINTS>) || {}) };

    let dataUrl = "";
    let runnerUsed = runner;
    let elapsedMs = 0;

    if (runner === "a1111") {
      job.stepLabel = `${stepScale.stagePrefix || ""}Restyling via A1111...`;
      notifyQueueUpdate();
      const aRes = await fetch(`${eps.a1111Url.replace(/\/+$/, "")}/sdapi/v1/img2img`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          init_images: [stripDataUrlPrefix(imageDataUrl)],
          prompt,
          negative_prompt: negativePrompt,
          denoising_strength: strength,
          steps,
          cfg_scale: guidanceScale,
          seed: seed ?? -1,
          override_settings: { sd_model_checkpoint: model },
        }),
        signal,
      });
      if (!aRes.ok) throw new Error(await aRes.text());
      const aData = (await aRes.json()) as { images?: string[] };
      if (!aData.images?.[0]) throw new Error("A1111 returned no image");
      dataUrl = `data:image/png;base64,${aData.images[0]}`;
      elapsedMs = Date.now() - t0;
    } else {
      runnerUsed = "m5-mlx-worker";
      const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/image-to-image/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          negativePrompt,
          imageDataUrl,
          strength,
          steps,
          guidanceScale,
          seed: seed ?? null,
        }),
        signal,
      });
      if (!wRes.ok) throw new Error((await wRes.text()) || "M5 MLX I2I stream failed");
      await consumeSseStream(wRes, (evt) => {
        if (evt.type === "step") {
          const s = Number(evt.step || 0);
          const tot = Math.max(1, Number(evt.total || steps));
          const span = stepScale.endPct - stepScale.startPct;
          job.currentStep = s;
          job.totalSteps = tot;
          job.progressPercent = Math.round(stepScale.startPct + (s / tot) * span);
          job.stepLabel = `${stepScale.stagePrefix || ""}${String(evt.stage || `Step ${s}/${tot}`)}`;
          if (typeof evt.previewDataUrl === "string") {
            job.previewUrl = evt.previewDataUrl;
          }
          job.updatedAt = new Date().toISOString();
          notifyQueueUpdate();
        } else if (evt.type === "done") {
          dataUrl = String(evt.imageDataUrl || "");
          elapsedMs = Number(evt.elapsedMs || Date.now() - t0);
        } else if (evt.type === "error") {
          throw new Error(String(evt.error || "I2I failed"));
        }
      });
    }

    if (!dataUrl) throw new Error("Worker returned empty image output");

    const nowIso = new Date().toISOString();
    const metadata: SavedOutputMetadata = {
      feature: "image-to-image",
      prompt,
      negativePrompt: negativePrompt || undefined,
      modelUsed: model,
      runnerUsed,
      steps,
      guidanceScale,
      strength,
      seed,
      elapsedMs,
      createdAt: nowIso,
    };

    const storageCfg = loadStorageConfig();
    const saved = storageCfg.autoSaveToDisk
      ? saveMediaDataUrlToDisk(dataUrl, "image-to-image", storageCfg.outputDir, metadata)
      : null;

    const item: GeneratedMediaItem = {
      id: `i2i-${Date.now()}`,
      feature: "image-to-image",
      prompt,
      negativePrompt: negativePrompt || undefined,
      outputUrl: saved ? saved.publicUrl : dataUrl,
      sourceImageUrl: imageDataUrl,
      mimeType: "image/png",
      modelUsed: model,
      runnerUsed,
      steps,
      guidanceScale,
      strength,
      seed,
      elapsedMs,
      savedPath: saved?.savedPath,
      savedFileName: saved?.fileName,
      downloadUrl: saved?.downloadUrl,
      createdAt: nowIso,
    };
    const nextState = appendMediaItemToSyncedState(item);
    broadcastSse("state:update", nextState);
    return { ...item, outputUrl: dataUrl };
  }

  async function executeImageToVideo(
    job: RenderJob,
    p: Record<string, unknown>,
    signal: AbortSignal,
    stepScale: { startPct: number; endPct: number; stagePrefix?: string } = { startPct: 0, endPct: 100 }
  ): Promise<GeneratedMediaItem> {
    const t0 = Date.now();
    const model = String(p.model || "");
    const runner = String(p.runner || "mlx-worker");
    const prompt = String(p.prompt || "");
    const imageDataUrl = String(p.imageDataUrl || "");
    const numFrames = Number(p.numFrames || 25);
    const fps = Number(p.fps || 12);
    const seed = p.seed !== undefined && p.seed !== null ? Number(p.seed) : undefined;
    const eps = { ...DEFAULT_ENDPOINTS, ...((p.endpoints as Partial<typeof DEFAULT_ENDPOINTS>) || {}) };

    let videoDataUrl = "";
    let elapsedMs = 0;

    const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/image-to-video/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        imageDataUrl,
        numFrames,
        fps,
        seed: seed ?? null,
      }),
      signal,
    });
    if (!wRes.ok) throw new Error((await wRes.text()) || "M5 MLX I2V stream failed");
    await consumeSseStream(wRes, (evt) => {
      if (evt.type === "step") {
        const s = Number(evt.step || 0);
        const tot = Math.max(1, Number(evt.total || 25));
        const span = stepScale.endPct - stepScale.startPct;
        job.currentStep = s;
        job.totalSteps = tot;
        job.progressPercent = Math.round(stepScale.startPct + (s / tot) * span);
        job.stepLabel = `${stepScale.stagePrefix || ""}${String(evt.stage || `Animating step ${s}/${tot}`)}`;
        if (typeof evt.previewDataUrl === "string") {
          job.previewUrl = evt.previewDataUrl;
        }
        job.updatedAt = new Date().toISOString();
        notifyQueueUpdate();
      } else if (evt.type === "done") {
        videoDataUrl = String(evt.videoDataUrl || "");
        elapsedMs = Number(evt.elapsedMs || Date.now() - t0);
      } else if (evt.type === "error") {
        throw new Error(String(evt.error || "I2V failed"));
      }
    });

    if (!videoDataUrl) throw new Error("Worker returned empty video output");

    const nowIso = new Date().toISOString();
    const metadata: SavedOutputMetadata = {
      feature: "image-to-video",
      prompt,
      modelUsed: model,
      runnerUsed: runner || "m5-mlx-worker",
      numFrames,
      fps,
      seed,
      elapsedMs,
      createdAt: nowIso,
    };

    const storageCfg = loadStorageConfig();
    const saved = storageCfg.autoSaveToDisk
      ? saveMediaDataUrlToDisk(videoDataUrl, "image-to-video", storageCfg.outputDir, metadata)
      : null;

    const item: GeneratedMediaItem = {
      id: `i2v-${Date.now()}`,
      feature: "image-to-video",
      prompt,
      outputUrl: saved ? saved.publicUrl : videoDataUrl,
      sourceImageUrl: imageDataUrl,
      mimeType: "video/mp4",
      modelUsed: model,
      runnerUsed: runner || "m5-mlx-worker",
      numFrames,
      fps,
      seed,
      elapsedMs,
      savedPath: saved?.savedPath,
      savedFileName: saved?.fileName,
      downloadUrl: saved?.downloadUrl,
      createdAt: nowIso,
    };
    const nextState = appendMediaItemToSyncedState(item);
    broadcastSse("state:update", nextState);
    return { ...item, outputUrl: videoDataUrl };
  }

  async function processQueueLoop() {
    if (isQueueRunning) return;
    isQueueRunning = true;
    try {
      while (true) {
        const nextJob = jobQueue.find((j) => j.status === "queued");
        if (!nextJob) break;

        nextJob.status = "running";
        nextJob.progressPercent = 2;
        nextJob.updatedAt = new Date().toISOString();
        recomputeQueuePositions();
        notifyQueueUpdate();

        const controller = new AbortController();
        activeAbortController = controller;

        try {
          if (nextJob.type === "text-to-image") {
            nextJob.result = await executeTextToImage(nextJob, nextJob.payload, controller.signal);
          } else if (nextJob.type === "image-to-image") {
            nextJob.result = await executeImageToImage(nextJob, nextJob.payload, controller.signal);
          } else if (nextJob.type === "image-to-video") {
            nextJob.result = await executeImageToVideo(nextJob, nextJob.payload, controller.signal);
          } else if (nextJob.type === "chain-pipeline") {
            const chainMode = String(nextJob.payload.mode || "prompt-to-image-to-video");
            const userPrompt = String(nextJob.payload.prompt || "");
            const sourceImage = nextJob.payload.sourceImageDataUrl
              ? String(nextJob.payload.sourceImageDataUrl)
              : undefined;
            const experts = (nextJob.payload.experts || {}) as Record<string, { id: string; runner: string }>;
            const endpoints = (nextJob.payload.endpoints || {}) as Partial<typeof DEFAULT_ENDPOINTS>;
            const chatExecutionMode = (nextJob.payload.chatExecutionMode as "local" | "cloud-preview") || "local";

            // Stage 1: Expert 1 Prompt Architect or Image-to-Prompt
            nextJob.stepLabel = "Stage 1/3 · Expert 1 expanding prompt...";
            nextJob.progressPercent = 8;
            notifyQueueUpdate();

            const chatMode =
              chainMode === "prompt-to-image-to-video" ? "prompt-gen" : "image-to-prompt";
            const chatRes = await runChatOnce({
              messages: [
                {
                  role: "user",
                  content:
                    userPrompt ||
                    "Analyze this image and create a rich visual scene & camera motion prompt.",
                },
              ],
              imageDataUrl: chatMode === "image-to-prompt" ? sourceImage : undefined,
              mode: chatMode,
              model: experts.chat?.id || "mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
              runner: experts.chat?.runner || "mlx-worker",
              executionMode: chatExecutionMode,
              endpoints,
              signal: controller.signal,
            });
            const refinedPrompt = chatRes.text.trim() || userPrompt;
            nextJob.chainArtifacts = { generatedPrompt: refinedPrompt };
            nextJob.progressPercent = 20;
            notifyQueueUpdate();

            // Stage 2: Expert 2 (T2I) or Expert 3 (I2I) if selected, else keyframe directly
            let keyframeForVideo = sourceImage || "";
            if (chainMode === "prompt-to-image-to-video") {
              const t2iItem = await executeTextToImage(
                nextJob,
                {
                  model: experts["text-to-image"]?.id || "black-forest-labs/FLUX.1-schnell",
                  runner: experts["text-to-image"]?.runner || "mlx-worker",
                  prompt: refinedPrompt,
                  width: Number(nextJob.payload.width || 1024),
                  height: Number(nextJob.payload.height || 576),
                  steps: Number(nextJob.payload.steps || 4),
                  guidanceScale: 3.5,
                  endpoints,
                },
                controller.signal,
                { startPct: 20, endPct: 58, stagePrefix: "Stage 2/3 · T2I · " }
              );
              keyframeForVideo = t2iItem.outputUrl;
              nextJob.chainArtifacts.intermediateImage = t2iItem;
            } else if (chainMode === "image-to-prompt-to-i2i-video") {
              const i2iItem = await executeImageToImage(
                nextJob,
                {
                  model: experts["image-to-image"]?.id || "stabilityai/sdxl-turbo",
                  runner: experts["image-to-image"]?.runner || "mlx-worker",
                  prompt: refinedPrompt,
                  imageDataUrl: sourceImage,
                  strength: Number(nextJob.payload.strength ?? 0.55),
                  steps: Number(nextJob.payload.steps || 12),
                  guidanceScale: 7.0,
                  endpoints,
                },
                controller.signal,
                { startPct: 20, endPct: 58, stagePrefix: "Stage 2/3 · I2I · " }
              );
              keyframeForVideo = i2iItem.outputUrl;
              nextJob.chainArtifacts.intermediateImage = i2iItem;
            }

            // Stage 3: Expert 4 (Image-to-Video)
            const i2vItem = await executeImageToVideo(
              nextJob,
              {
                model: experts["image-to-video"]?.id || "Lightricks/LTX-Video",
                runner: experts["image-to-video"]?.runner || "mlx-worker",
                prompt: refinedPrompt,
                imageDataUrl: keyframeForVideo,
                numFrames: Number(nextJob.payload.numFrames || 25),
                fps: Number(nextJob.payload.fps || 12),
                endpoints,
              },
              controller.signal,
              { startPct: chainMode === "image-to-prompt-to-video" ? 25 : 58, endPct: 98, stagePrefix: "Stage 3/3 · I2V · " }
            );
            nextJob.chainArtifacts.finalVideo = i2vItem;
            nextJob.result = i2vItem;
          }

          if ((nextJob.status as string) !== "cancelled") {
            nextJob.status = "completed";
            nextJob.progressPercent = 100;
            nextJob.stepLabel = "Completed & synced";
          }
        } catch (err) {
          if (controller.signal.aborted || (nextJob.status as string) === "cancelled") {
            nextJob.status = "cancelled";
            nextJob.stepLabel = "Cancelled";
          } else {
            const msg = err instanceof Error ? err.message : "Job execution failed";
            const looksOffline =
              msg.includes("fetch failed") ||
              msg.includes("ECONNREFUSED") ||
              msg.includes("Failed to fetch");
            nextJob.status = "failed";
            nextJob.isOffline = looksOffline;
            nextJob.error = looksOffline
              ? `Local M5 runner is offline. Start \`python3 m5_mlx_worker.py\` on your M5 MacBook Air to process queued jobs locally.`
              : msg;
            nextJob.stepLabel = "Failed";
          }
        } finally {
          activeAbortController = null;
          nextJob.updatedAt = new Date().toISOString();
          recomputeQueuePositions();
          notifyQueueUpdate();
        }
      }
    } finally {
      isQueueRunning = false;
    }
  }

  app.get("/api/queue", (_req: Request, res: Response) => {
    res.json(getQueueSnapshot());
  });

  app.post("/api/queue/enqueue", (req: Request, res: Response) => {
    const { type, label, payload } = req.body as {
      type?: RenderJob["type"];
      label?: string;
      payload?: Record<string, unknown>;
    };
    if (!type || !payload) {
      res.status(400).json({ error: "type and payload are required" });
      return;
    }
    const nowIso = new Date().toISOString();
    const job: RenderJob = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      label: label || type,
      status: "queued",
      position: jobQueue.filter((j) => j.status === "queued").length + 1,
      progressPercent: 0,
      currentStep: 0,
      totalSteps: Number(payload.steps || 25),
      stepLabel: "Queued for M5 16GB slot...",
      payload,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    jobQueue.unshift(job);
    if (jobQueue.length > 30) {
      jobQueue.length = 30;
    }
    recomputeQueuePositions();
    notifyQueueUpdate();
    void processQueueLoop();

    const { payload: _omit, ...publicJob } = job;
    res.json({ job: publicJob, queue: getQueueSnapshot() });
  });

  app.post("/api/queue/:id/cancel", (req: Request, res: Response) => {
    const target = jobQueue.find((j) => j.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (target.status === "queued") {
      target.status = "cancelled";
      target.stepLabel = "Cancelled";
      target.updatedAt = new Date().toISOString();
    } else if (target.status === "running") {
      target.status = "cancelled";
      target.stepLabel = "Cancelling...";
      target.updatedAt = new Date().toISOString();
      activeAbortController?.abort();
    }
    recomputeQueuePositions();
    notifyQueueUpdate();
    res.json(getQueueSnapshot());
  });

  app.post("/api/queue/clear-completed", (_req: Request, res: Response) => {
    for (let i = jobQueue.length - 1; i >= 0; i--) {
      if (jobQueue[i].status !== "queued" && jobQueue[i].status !== "running") {
        jobQueue.splice(i, 1);
      }
    }
    recomputeQueuePositions();
    notifyQueueUpdate();
    res.json(getQueueSnapshot());
  });

  // Direct Inference Fallbacks (preserved for direct API compatibility)
  app.post("/api/infer/text-to-image", async (req: Request, res: Response) => {
    const t0 = Date.now();
    const {
      model,
      runner,
      prompt,
      negativePrompt,
      width,
      height,
      steps,
      guidanceScale,
      seed,
      endpoints,
    } = req.body as {
      model: string;
      runner: string;
      prompt: string;
      negativePrompt?: string;
      width: number;
      height: number;
      steps: number;
      guidanceScale: number;
      seed?: number;
      endpoints?: Partial<typeof DEFAULT_ENDPOINTS>;
    };

    const eps = { ...DEFAULT_ENDPOINTS, ...endpoints };

    try {
      let dataUrl = "";
      let runnerUsed = runner || "m5-mlx-worker";
      let elapsedMs = 0;

      if (runner === "a1111") {
        const aRes = await fetch(`${eps.a1111Url.replace(/\/+$/, "")}/sdapi/v1/txt2img`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            negative_prompt: negativePrompt || "",
            width,
            height,
            steps,
            cfg_scale: guidanceScale,
            seed: seed ?? -1,
            override_settings: { sd_model_checkpoint: model },
          }),
        });
        if (!aRes.ok) {
          res.status(aRes.status).json({ error: await aRes.text() });
          return;
        }
        const aData = (await aRes.json()) as { images?: string[] };
        if (!aData.images?.[0]) {
          res.status(500).json({ error: "A1111 returned no image" });
          return;
        }
        dataUrl = `data:image/png;base64,${aData.images[0]}`;
        elapsedMs = Date.now() - t0;
      } else {
        runnerUsed = "m5-mlx-worker";
        const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/text-to-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            negativePrompt,
            width,
            height,
            steps,
            guidanceScale,
            seed: seed ?? null,
          }),
        });
        const wData = (await wRes.json()) as { imageDataUrl?: string; detail?: string; elapsedMs?: number };
        if (!wRes.ok || !wData.imageDataUrl) {
          res.status(wRes.status || 500).json({ error: wData.detail || "M5 MLX T2I failed" });
          return;
        }
        dataUrl = wData.imageDataUrl;
        elapsedMs = wData.elapsedMs || Date.now() - t0;
      }

      const storageCfg = loadStorageConfig();
      const metadata: SavedOutputMetadata = {
        feature: "text-to-image",
        prompt,
        negativePrompt: negativePrompt || undefined,
        modelUsed: model,
        runnerUsed,
        width,
        height,
        steps,
        guidanceScale,
        seed,
        elapsedMs,
        createdAt: new Date().toISOString(),
      };
      const saved = storageCfg.autoSaveToDisk
        ? saveMediaDataUrlToDisk(dataUrl, "text-to-image", storageCfg.outputDir, metadata)
        : null;
      res.json({
        outputUrl: dataUrl,
        mimeType: "image/png",
        modelUsed: model,
        runnerUsed,
        elapsedMs,
        savedPath: saved?.savedPath,
        savedFileName: saved?.fileName,
        downloadUrl: saved?.downloadUrl,
      });
    } catch {
      res.status(503).json({
        code: "LOCAL_RUNNER_OFFLINE",
        error: `Local Text-to-Image runner (${runner}) is offline. Run \`python3 m5_mlx_worker.py\` on your M5 MacBook Air to process images locally on Apple Silicon.`,
      });
    }
  });

  app.post("/api/infer/image-to-image", async (req: Request, res: Response) => {
    const t0 = Date.now();
    const {
      model,
      runner,
      prompt,
      negativePrompt,
      imageDataUrl,
      strength,
      steps,
      guidanceScale,
      seed,
      endpoints,
    } = req.body as {
      model: string;
      runner: string;
      prompt: string;
      negativePrompt?: string;
      imageDataUrl: string;
      strength: number;
      steps: number;
      guidanceScale: number;
      seed?: number;
      endpoints?: Partial<typeof DEFAULT_ENDPOINTS>;
    };

    const eps = { ...DEFAULT_ENDPOINTS, ...endpoints };

    try {
      let dataUrl = "";
      let runnerUsed = runner || "m5-mlx-worker";
      let elapsedMs = 0;

      if (runner === "a1111") {
        const aRes = await fetch(`${eps.a1111Url.replace(/\/+$/, "")}/sdapi/v1/img2img`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            init_images: [stripDataUrlPrefix(imageDataUrl)],
            prompt,
            negative_prompt: negativePrompt || "",
            denoising_strength: strength,
            steps,
            cfg_scale: guidanceScale,
            seed: seed ?? -1,
            override_settings: { sd_model_checkpoint: model },
          }),
        });
        if (!aRes.ok) {
          res.status(aRes.status).json({ error: await aRes.text() });
          return;
        }
        const aData = (await aRes.json()) as { images?: string[] };
        if (!aData.images?.[0]) {
          res.status(500).json({ error: "A1111 returned no image" });
          return;
        }
        dataUrl = `data:image/png;base64,${aData.images[0]}`;
        elapsedMs = Date.now() - t0;
      } else {
        runnerUsed = "m5-mlx-worker";
        const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/image-to-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt,
            negativePrompt,
            imageDataUrl,
            strength,
            steps,
            guidanceScale,
            seed: seed ?? null,
          }),
        });
        const wData = (await wRes.json()) as { imageDataUrl?: string; detail?: string; elapsedMs?: number };
        if (!wRes.ok || !wData.imageDataUrl) {
          res.status(wRes.status || 500).json({ error: wData.detail || "M5 MLX I2I failed" });
          return;
        }
        dataUrl = wData.imageDataUrl;
        elapsedMs = wData.elapsedMs || Date.now() - t0;
      }

      const storageCfg = loadStorageConfig();
      const metadata: SavedOutputMetadata = {
        feature: "image-to-image",
        prompt,
        negativePrompt: negativePrompt || undefined,
        modelUsed: model,
        runnerUsed,
        steps,
        guidanceScale,
        strength,
        seed,
        elapsedMs,
        createdAt: new Date().toISOString(),
      };
      const saved = storageCfg.autoSaveToDisk
        ? saveMediaDataUrlToDisk(dataUrl, "image-to-image", storageCfg.outputDir, metadata)
        : null;
      res.json({
        outputUrl: dataUrl,
        mimeType: "image/png",
        modelUsed: model,
        runnerUsed,
        elapsedMs,
        savedPath: saved?.savedPath,
        savedFileName: saved?.fileName,
        downloadUrl: saved?.downloadUrl,
      });
    } catch {
      res.status(503).json({
        code: "LOCAL_RUNNER_OFFLINE",
        error: `Local Image-to-Image runner (${runner}) is offline. Run \`python3 m5_mlx_worker.py\` on your M5 MacBook Air to run local diffusion on MPS.`,
      });
    }
  });

  app.post("/api/infer/image-to-video", async (req: Request, res: Response) => {
    const t0 = Date.now();
    const {
      model,
      runner,
      prompt,
      imageDataUrl,
      numFrames,
      fps,
      seed,
      endpoints,
    } = req.body as {
      model: string;
      runner: string;
      prompt: string;
      imageDataUrl: string;
      numFrames: number;
      fps: number;
      seed?: number;
      endpoints?: Partial<typeof DEFAULT_ENDPOINTS>;
    };

    const eps = { ...DEFAULT_ENDPOINTS, ...endpoints };

    try {
      const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/image-to-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          imageDataUrl,
          numFrames,
          fps,
          seed: seed ?? null,
        }),
      });
      const wData = (await wRes.json()) as { videoDataUrl?: string; detail?: string; elapsedMs?: number };
      if (!wRes.ok || !wData.videoDataUrl) {
        res.status(wRes.status || 500).json({ error: wData.detail || "M5 MLX I2V failed" });
        return;
      }
      const elapsedMs = wData.elapsedMs || Date.now() - t0;
      const storageCfg = loadStorageConfig();
      const metadata: SavedOutputMetadata = {
        feature: "image-to-video",
        prompt,
        modelUsed: model,
        runnerUsed: runner || "m5-mlx-worker",
        numFrames,
        fps,
        seed,
        elapsedMs,
        createdAt: new Date().toISOString(),
      };
      const saved = storageCfg.autoSaveToDisk
        ? saveMediaDataUrlToDisk(wData.videoDataUrl, "image-to-video", storageCfg.outputDir, metadata)
        : null;
      res.json({
        outputUrl: wData.videoDataUrl,
        mimeType: "video/mp4",
        modelUsed: model,
        runnerUsed: runner || "m5-mlx-worker",
        elapsedMs,
        savedPath: saved?.savedPath,
        savedFileName: saved?.fileName,
        downloadUrl: saved?.downloadUrl,
      });
    } catch {
      res.status(503).json({
        code: "LOCAL_RUNNER_OFFLINE",
        error: `Local Image-to-Video runner (${runner}) is offline. Run \`python3 m5_mlx_worker.py\` on your M5 MacBook Air to animate images locally.`,
      });
    }
  });

  const httpServer = http.createServer(app);

  // Mount Vite middleware in development or serve static dist/ in production
  if (process.env.NODE_ENV === "production") {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const disableHmr =
      process.env.DISABLE_HMR === "true" || Boolean(process.env.APP_URL);
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: disableHmr ? false : { server: httpServer },
        watch: process.env.DISABLE_HMR === "true" ? null : undefined,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, HOST, () => {
    const lan = getLanAddresses(PORT);
    console.log(`M5 Local MoE Studio listening on http://localhost:${PORT}`);
    for (const addr of lan) {
      console.log(`LAN Access (${addr.interfaceName}): ${addr.url}`);
    }
  });
}

createServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
