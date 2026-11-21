import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import express, { Request, Response } from "express";
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

interface PersistedStorageConfig {
  outputDir: string;
  autoSaveToDisk: boolean;
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

function saveMediaDataUrlToDisk(
  dataUrl: string,
  feature: "text-to-image" | "image-to-image" | "image-to-video",
  outputDir: string
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
    fs.writeFileSync(savedPath, Buffer.from(data, "base64"));
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

async function probeUrl(url: string, pathSuffix: string, timeoutMs = 1100): Promise<{ online: boolean; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cleanBase = url.replace(/\/+$/, "");
    const res = await fetch(`${cleanBase}${pathSuffix}`, { signal: controller.signal });
    if (res.ok) {
      return { online: true, detail: `HTTP ${res.status}` };
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

  // Extract parameter size like 3b, 7b, 8b, 14b, 32b, 1.3b, 0.5b from modelId first
  const paramRegex = /(?:^|[-_/\s])(\d+(?:\.\d+)?)b(?:[-_/\s]|$)/;
  const match = modelId.toLowerCase().match(paramRegex) || lower.match(paramRegex);
  let paramB = match ? parseFloat(match[1]) : 0;

  if (!paramB) {
    if (lower.includes("flux")) paramB = lower.includes("schnell") || lower.includes("4bit") ? 12 : 12;
    else if (lower.includes("sdxl")) paramB = 3.5;
    else if (lower.includes("sd-turbo") || lower.includes("sd15") || lower.includes("1.5")) paramB = 1.1;
    else if (lower.includes("ltx-video")) paramB = 2.0;
    else if (lower.includes("svd") || lower.includes("stable-video")) paramB = 1.5;
    else if (lower.includes("wan2.1") && lower.includes("1.3")) paramB = 1.3;
    else paramB = 4.0;
  }

  const bytesPerParam =
    quantization.includes("4-bit") ? 0.58 : quantization.includes("8-bit") ? 1.08 : 2.1;

  // Include ~1.2GB KV-cache / activation overhead
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

async function createServer() {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // Health & System + LAN Discovery
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

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
        { id: "mlx-worker", label: "M5 MLX Worker", url: mlxWorkerUrl, ...mlxProbe },
        { id: "ollama", label: "Ollama", url: ollamaUrl, ...ollamaProbe },
        { id: "openai-local", label: "MLX / LM Studio", url: openaiLocalUrl, ...openaiProbe },
        { id: "a1111", label: "A1111 / Forge", url: a1111Url, ...a1111Probe },
        { id: "comfyui", label: "ComfyUI", url: comfyuiUrl, ...comfyProbe },
      ],
      geminiPreviewAvailable: Boolean(getGeminiClient()),
    });
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
    const { dataUrl, feature } = req.body as {
      dataUrl?: string;
      feature?: "text-to-image" | "image-to-image" | "image-to-video";
    };
    if (!dataUrl || !feature) {
      res.status(400).json({ error: "dataUrl and feature are required" });
      return;
    }
    const cfg = loadStorageConfig();
    const saved = saveMediaDataUrlToDisk(dataUrl, feature, cfg.outputDir);
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

  // Scan Local Models (HF cache, Ollama, LM Studio, ~/Models, M5 Worker)
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

    // 1. Scan ~/.cache/huggingface/hub
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
        // ignore permission errors
      }
    }

    // 2. Scan ~/Models or ~/.lmstudio/models
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

    // 3. Query Ollama /api/tags
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

    // 4. Query M5 MLX Worker /models
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

  // Trigger model pull on local M5 Worker or Ollama
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

    // Try M5 MLX Worker /pull
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

  // Feature 1: General Chat, Prompt Generation, and Image-to-Prompt
  app.post("/api/infer/chat", async (req: Request, res: Response) => {
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

    const systemPrompts: Record<string, string> = {
      chat: "You are a helpful, concise, privacy-first AI assistant running in an Apple Silicon M5 local MoE workspace.",
      "prompt-gen":
        "You are an expert visual prompt architect for local diffusion and video models (Flux, SDXL, LTX-Video, Wan2.1). Convert the user's idea into a vivid, comma-separated or structured prompt covering subject, composition, lighting, lens/camera, materials, and atmosphere. Provide one clean ready-to-paste prompt block.",
      "image-to-prompt":
        "You are an expert multimodal vision-to-prompt analyst. Inspect the attached image carefully and output a detailed, reproducible prompt suitable for Text-to-Image and Image-to-Video models. Describe subject, pose/geometry, materials, color palette, lighting direction, camera angle/focal length, and mood.",
    };

    const systemPrompt = systemPrompts[mode] || systemPrompts.chat;

    // Optional Cloud Preview Path (explicitly chosen by user when away from local M5 Mac)
    if (executionMode === "cloud-preview") {
      const ai = getGeminiClient();
      if (!ai) {
        res.status(500).json({
          error: "GEMINI_API_KEY is not configured in environment secrets for Preview Mode.",
        });
        return;
      }
      try {
        const lastMessage = messages[messages.length - 1]?.content || "Describe this image as a generation prompt.";
        const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

        if (imageDataUrl) {
          const parsed = parseDataUrl(imageDataUrl);
          parts.push({
            inlineData: {
              mimeType: parsed.mimeType,
              data: parsed.data,
            },
          });
        }

        const conversationContext =
          messages.length > 1
            ? messages
                .slice(0, -1)
                .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
                .join("\n") + `\nUser: ${lastMessage}`
            : lastMessage;

        parts.push({ text: conversationContext });

        const response = await ai.models.generateContent({
          model: "gemini-4-hydrogen",
          contents: { parts },
          config: {
            systemInstruction: systemPrompt,
          },
        });

        res.json({
          text: response.text || "",
          modelUsed: "gemini-4-hydrogen (Cloud Preview)",
          engineUsed: "cloud-preview",
          elapsedMs: Date.now() - t0,
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Gemini request failed";
        res.status(500).json({ error: message });
        return;
      }
    }

    // Local M5 Private Mode
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
          body: JSON.stringify({
            model,
            messages: ollamaMessages,
            stream: false,
          }),
        });
        if (!oRes.ok) {
          const errText = await oRes.text();
          res.status(oRes.status).json({ error: `Ollama error: ${errText}` });
          return;
        }
        const oData = (await oRes.json()) as { message?: { content?: string } };
        res.json({
          text: oData.message?.content || "",
          modelUsed: model,
          engineUsed: "ollama-local",
          elapsedMs: Date.now() - t0,
        });
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
          body: JSON.stringify({ model, messages: oaMessages }),
        });
        if (!oaRes.ok) {
          const errText = await oaRes.text();
          res.status(oaRes.status).json({ error: `Local OpenAI server error: ${errText}` });
          return;
        }
        const oaData = (await oaRes.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        res.json({
          text: oaData.choices?.[0]?.message?.content || "",
          modelUsed: model,
          engineUsed: "openai-local",
          elapsedMs: Date.now() - t0,
        });
        return;
      }

      // Default: M5 MLX Worker (:8787)
      const wRes = await fetch(`${eps.mlxWorkerUrl.replace(/\/+$/, "")}/chat`, {
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
      const wData = (await wRes.json()) as { text?: string; detail?: string; elapsedMs?: number };
      if (!wRes.ok) {
        res.status(wRes.status).json({ error: wData.detail || "M5 MLX Worker error" });
        return;
      }
      res.json({
        text: wData.text || "",
        modelUsed: model,
        engineUsed: "m5-mlx-worker",
        elapsedMs: wData.elapsedMs || Date.now() - t0,
      });
    } catch {
      res.status(503).json({
        code: "LOCAL_RUNNER_OFFLINE",
        error: `Could not connect to local ${runner} runner. Start your local M5 inference worker (or switch to Preview Mode in the sidebar to test Chat & Image-to-Prompt).`,
      });
    }
  });

  // Feature 2: Text-to-Image (Dedicated Local Model)
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
        const imgB64 = aData.images?.[0];
        if (!imgB64) {
          res.status(500).json({ error: "A1111 returned no image" });
          return;
        }
        const dataUrl = `data:image/png;base64,${imgB64}`;
        const storageCfg = loadStorageConfig();
        const saved = storageCfg.autoSaveToDisk
          ? saveMediaDataUrlToDisk(dataUrl, "text-to-image", storageCfg.outputDir)
          : null;
        res.json({
          outputUrl: dataUrl,
          mimeType: "image/png",
          modelUsed: model,
          runnerUsed: "a1111",
          elapsedMs: Date.now() - t0,
          savedPath: saved?.savedPath,
          savedFileName: saved?.fileName,
          downloadUrl: saved?.downloadUrl,
        });
        return;
      }

      // Default: M5 MLX Worker (:8787)
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
      const storageCfg = loadStorageConfig();
      const saved = storageCfg.autoSaveToDisk
        ? saveMediaDataUrlToDisk(wData.imageDataUrl, "text-to-image", storageCfg.outputDir)
        : null;
      res.json({
        outputUrl: wData.imageDataUrl,
        mimeType: "image/png",
        modelUsed: model,
        runnerUsed: "m5-mlx-worker",
        elapsedMs: wData.elapsedMs || Date.now() - t0,
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

  // Feature 3: Image-to-Image (Dedicated Local Model)
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
        const imgB64 = aData.images?.[0];
        if (!imgB64) {
          res.status(500).json({ error: "A1111 returned no image" });
          return;
        }
        const dataUrl = `data:image/png;base64,${imgB64}`;
        const storageCfg = loadStorageConfig();
        const saved = storageCfg.autoSaveToDisk
          ? saveMediaDataUrlToDisk(dataUrl, "image-to-image", storageCfg.outputDir)
          : null;
        res.json({
          outputUrl: dataUrl,
          mimeType: "image/png",
          modelUsed: model,
          runnerUsed: "a1111",
          elapsedMs: Date.now() - t0,
          savedPath: saved?.savedPath,
          savedFileName: saved?.fileName,
          downloadUrl: saved?.downloadUrl,
        });
        return;
      }

      // Default: M5 MLX Worker (:8787)
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
      const storageCfg = loadStorageConfig();
      const saved = storageCfg.autoSaveToDisk
        ? saveMediaDataUrlToDisk(wData.imageDataUrl, "image-to-image", storageCfg.outputDir)
        : null;
      res.json({
        outputUrl: wData.imageDataUrl,
        mimeType: "image/png",
        modelUsed: model,
        runnerUsed: "m5-mlx-worker",
        elapsedMs: wData.elapsedMs || Date.now() - t0,
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

  // Feature 4: Image-to-Video (Dedicated Local Model)
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
      const storageCfg = loadStorageConfig();
      const saved = storageCfg.autoSaveToDisk
        ? saveMediaDataUrlToDisk(wData.videoDataUrl, "image-to-video", storageCfg.outputDir)
        : null;
      res.json({
        outputUrl: wData.videoDataUrl,
        mimeType: "video/mp4",
        modelUsed: model,
        runnerUsed: runner || "m5-mlx-worker",
        elapsedMs: wData.elapsedMs || Date.now() - t0,
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
