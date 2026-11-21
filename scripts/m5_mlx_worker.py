#!/usr/bin/env python3
"""
M5 MacBook Air (16GB Unified Memory) Local MoE Inference Worker
================================================================
Serves all 4 Mixture-of-Experts slots locally over Apple Silicon Metal (MLX + MPS):
  1. Chat & Image-to-Prompt (mlx-lm / mlx-vlm) with SSE token streaming
  2. Text-to-Image (diffusers MPS) with VAE tiling & progressive step previews
  3. Image-to-Image (diffusers MPS) with VAE tiling & progressive step previews
  4. Image-to-Video (diffusers LTX-Video / SVD MPS) with VAE tiling & step previews

Designed for 16GB Unified Memory:
  - Single-resident expert loading with explicit Metal/MPS cache clearing
  - Idle Auto-Unload Watchdog (default 300s) releases wired RAM after inactivity
  - VAE slicing/tiling minimizes peak memory spikes during 1024px+ & video decoding
  - Live Hugging Face snapshot download byte progress streaming

Install dependencies on your M5 MacBook Air:
  pip install fastapi uvicorn pillow pydantic huggingface_hub mlx-lm mlx-vlm mflux diffusers transformers accelerate torch

Run:
  python3 m5_mlx_worker.py
"""

import base64
import gc
import io
import json
import os
import queue
import tempfile
import threading
import time
from typing import Any, Dict, Generator, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel

app = FastAPI(title="M5 Local MoE Worker", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active expert state (single-resident strategy for 16GB Unified Memory)
_STATE_LOCK = threading.RLock()
_ACTIVE_SLOT: Optional[str] = None
_ACTIVE_MODEL_ID: Optional[str] = None
_ACTIVE_PIPELINE: Any = None
_LAST_ACTIVE_TS: float = time.time()
_BUSY_COUNT: int = 0
_IDLE_TIMEOUT_SECONDS: int = int(os.environ.get("IDLE_UNLOAD_SECONDS", "300"))


def _touch_activity() -> None:
    global _LAST_ACTIVE_TS
    _LAST_ACTIVE_TS = time.time()


def clear_apple_silicon_memory() -> None:
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
    with _STATE_LOCK:
        _ACTIVE_PIPELINE = None
        _ACTIVE_SLOT = None
        _ACTIVE_MODEL_ID = None
    gc.collect()
    try:
        import mlx.core as mx
        mx.metal.clear_cache()
    except Exception:
        pass
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


def _idle_watchdog_loop() -> None:
    while True:
        time.sleep(10)
        try:
            with _STATE_LOCK:
                timeout = _IDLE_TIMEOUT_SECONDS
                has_pipeline = _ACTIVE_PIPELINE is not None
                is_busy = _BUSY_COUNT > 0
                idle_elapsed = time.time() - _LAST_ACTIVE_TS
            if timeout > 0 and has_pipeline and not is_busy and idle_elapsed >= timeout:
                clear_apple_silicon_memory()
        except Exception:
            pass


_WATCHDOG_THREAD = threading.Thread(target=_idle_watchdog_loop, daemon=True)
_WATCHDOG_THREAD.start()


def _get_active_memory_gb() -> Optional[float]:
    try:
        import mlx.core as mx
        if hasattr(mx.metal, "get_active_memory"):
            return round(mx.metal.get_active_memory() / (1024 ** 3), 2)
    except Exception:
        pass
    try:
        import torch
        if torch.backends.mps.is_available() and hasattr(torch.mps, "current_allocated_memory"):
            return round(torch.mps.current_allocated_memory() / (1024 ** 3), 2)
    except Exception:
        pass
    return None


def _enable_memory_savers(pipe: Any) -> None:
    for method in ("enable_attention_slicing", "enable_vae_slicing", "enable_vae_tiling"):
        fn = getattr(pipe, method, None)
        if callable(fn):
            try:
                fn()
            except Exception:
                pass
    vae = getattr(pipe, "vae", None)
    if vae is not None:
        for method in ("enable_slicing", "enable_tiling"):
            fn = getattr(vae, method, None)
            if callable(fn):
                try:
                    fn()
                except Exception:
                    pass


def decode_data_url(data_url: str) -> Image.Image:
    if "," in data_url:
        _, encoded = data_url.split(",", 1)
    else:
        encoded = data_url
    raw = base64.b64decode(encoded)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def encode_pil_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{b64}"


def encode_pil_preview_jpeg(img: Image.Image, max_size: int = 320) -> str:
    thumb = img.copy()
    thumb.thumbnail((max_size, max_size))
    buf = io.BytesIO()
    thumb.save(buf, format="JPEG", quality=72)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return f"data:image/jpeg;base64,{b64}"


def _decode_latent_preview(pipe: Any, latents: Any) -> Optional[str]:
    """Best-effort compact JPEG preview from intermediate diffusion latents."""
    try:
        import torch

        if latents is None:
            return None
        vae = getattr(pipe, "vae", None)
        if vae is None:
            return None

        # Handle 5D video latents [B, C, T, H, W] or [B, T, C, H, W] by taking frame 0
        sample = latents
        if sample.ndim == 5:
            if sample.shape[1] in (4, 16):
                sample = sample[:, :, 0, :, :]
            else:
                sample = sample[:, 0, :, :, :]
        if sample.ndim != 4:
            return None

        scaling = getattr(vae.config, "scaling_factor", 0.18215)
        shift = getattr(vae.config, "shift_factor", 0.0) or 0.0
        with torch.no_grad():
            decoded = vae.decode(sample[:1] / scaling + shift, return_dict=False)[0]
            decoded = (decoded / 2 + 0.5).clamp(0, 1)
            arr = (decoded[0].permute(1, 2, 0).float().cpu().numpy() * 255).astype("uint8")
            img = Image.fromarray(arr)
            return encode_pil_preview_jpeg(img)
    except Exception:
        return None


def _sse_event(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


class ChatPayload(BaseModel):
    model: str
    messages: List[Dict[str, str]]
    imageDataUrl: Optional[str] = None
    mode: str = "chat"
    systemPrompt: Optional[str] = None
    maxTokens: int = 768


class TextToImagePayload(BaseModel):
    model: str
    prompt: str
    negativePrompt: Optional[str] = ""
    width: int = 1024
    height: int = 1024
    steps: int = 4
    guidanceScale: float = 3.5
    seed: Optional[int] = None


class ImageToImagePayload(BaseModel):
    model: str
    prompt: str
    negativePrompt: Optional[str] = ""
    imageDataUrl: str
    strength: float = 0.65
    steps: int = 20
    guidanceScale: float = 7.0
    seed: Optional[int] = None


class ImageToVideoPayload(BaseModel):
    model: str
    prompt: str
    imageDataUrl: str
    numFrames: int = 25
    fps: int = 12
    seed: Optional[int] = None


class PullPayload(BaseModel):
    modelId: str


class IdleConfigPayload(BaseModel):
    idleTimeoutSeconds: int


@app.get("/health")
def health():
    with _STATE_LOCK:
        idle_elapsed = max(0, int(time.time() - _LAST_ACTIVE_TS))
        remaining = (
            max(0, _IDLE_TIMEOUT_SECONDS - idle_elapsed)
            if (_IDLE_TIMEOUT_SECONDS > 0 and _ACTIVE_PIPELINE is not None)
            else None
        )
        return {
            "status": "ok",
            "device": "apple-silicon-mps-mlx",
            "activeSlot": _ACTIVE_SLOT,
            "activeModel": _ACTIVE_MODEL_ID,
            "idleTimeoutSeconds": _IDLE_TIMEOUT_SECONDS,
            "idleSecondsRemaining": remaining,
            "activeMemoryGb": _get_active_memory_gb(),
            "busy": _BUSY_COUNT > 0,
        }


@app.post("/unload")
def manual_unload():
    prev_slot = _ACTIVE_SLOT
    prev_model = _ACTIVE_MODEL_ID
    clear_apple_silicon_memory()
    return {
        "status": "unloaded",
        "previousSlot": prev_slot,
        "previousModel": prev_model,
        "activeMemoryGb": _get_active_memory_gb(),
    }


@app.post("/config/idle")
def configure_idle(payload: IdleConfigPayload):
    global _IDLE_TIMEOUT_SECONDS
    with _STATE_LOCK:
        _IDLE_TIMEOUT_SECONDS = max(0, min(3600, payload.idleTimeoutSeconds))
        _touch_activity()
    return {"idleTimeoutSeconds": _IDLE_TIMEOUT_SECONDS}


@app.get("/models")
def list_cached_models():
    hub_dir = os.path.expanduser("~/.cache/huggingface/hub")
    items = []
    if os.path.isdir(hub_dir):
        for entry in sorted(os.listdir(hub_dir)):
            if entry.startswith("models--"):
                repo_id = entry.replace("models--", "").replace("--", "/")
                items.append({"id": repo_id, "path": os.path.join(hub_dir, entry)})
    return {"models": items, "activeModel": _ACTIVE_MODEL_ID}


def _hf_repo_cache_dir(repo_id: str) -> str:
    safe = repo_id.replace("/", "--")
    return os.path.expanduser(f"~/.cache/huggingface/hub/models--{safe}")


def _dir_size_bytes(path: str) -> int:
    total = 0
    if not os.path.exists(path):
        return 0
    for root, _, files in os.walk(path):
        for fname in files:
            try:
                fpath = os.path.join(root, fname)
                if not os.path.islink(fpath):
                    total += os.path.getsize(fpath)
            except OSError:
                pass
    return total


@app.post("/pull")
def pull_model(payload: PullPayload):
    try:
        from huggingface_hub import snapshot_download
        local_dir = snapshot_download(repo_id=payload.modelId)
        return {"status": "downloaded", "modelId": payload.modelId, "path": local_dir}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/pull/stream")
def pull_model_stream(payload: PullPayload):
    def generate_events() -> Generator[str, None, None]:
        from huggingface_hub import HfApi, snapshot_download

        total_bytes = 0
        try:
            info = HfApi().model_info(repo_id=payload.modelId, files_metadata=True)
            total_bytes = sum((s.size or 0) for s in (info.siblings or []))
        except Exception:
            total_bytes = 0

        cache_dir = _hf_repo_cache_dir(payload.modelId)
        start_bytes = _dir_size_bytes(cache_dir)
        result_box: Dict[str, Any] = {"done": False, "error": None, "path": None}

        def worker():
            try:
                result_box["path"] = snapshot_download(repo_id=payload.modelId)
            except Exception as exc:
                result_box["error"] = str(exc)
            finally:
                result_box["done"] = True

        t = threading.Thread(target=worker, daemon=True)
        t.start()

        t0 = time.time()
        last_ts = t0
        last_bytes = start_bytes
        yield _sse_event({
            "status": "starting",
            "modelId": payload.modelId,
            "downloadedBytes": start_bytes,
            "totalBytes": total_bytes,
            "percent": 0 if total_bytes == 0 else min(99, int((start_bytes / total_bytes) * 100)),
            "speedMbps": 0.0,
            "message": f"Resolving {payload.modelId} on Hugging Face Hub...",
        })

        while not result_box["done"]:
            time.sleep(0.45)
            now = time.time()
            cur_bytes = _dir_size_bytes(cache_dir)
            dt = max(0.1, now - last_ts)
            delta = max(0, cur_bytes - last_bytes)
            speed_mbps = round((delta / (1024 * 1024)) / dt, 2)
            last_ts = now
            last_bytes = cur_bytes

            pct = (
                min(99, round((cur_bytes / total_bytes) * 100, 1))
                if total_bytes > 0
                else 0
            )
            yield _sse_event({
                "status": "downloading",
                "modelId": payload.modelId,
                "downloadedBytes": cur_bytes,
                "totalBytes": total_bytes,
                "percent": pct,
                "speedMbps": speed_mbps,
                "message": f"Downloading weights ({pct}%)" if total_bytes > 0 else "Downloading weights...",
            })

        if result_box["error"]:
            yield _sse_event({"status": "error", "error": result_box["error"], "done": True})
        else:
            final_bytes = _dir_size_bytes(cache_dir)
            yield _sse_event({
                "status": "downloaded",
                "modelId": payload.modelId,
                "downloadedBytes": final_bytes,
                "totalBytes": max(total_bytes, final_bytes),
                "percent": 100,
                "speedMbps": 0.0,
                "path": result_box["path"],
                "message": f"Cached {payload.modelId} locally on M5.",
                "done": True,
            })

    return StreamingResponse(generate_events(), media_type="text/event-stream")


def _prepare_lm_prompt(tokenizer: Any, payload: ChatPayload) -> str:
    chat_msgs = []
    if payload.systemPrompt:
        chat_msgs.append({"role": "system", "content": payload.systemPrompt})
    chat_msgs.extend(payload.messages)

    if hasattr(tokenizer, "apply_chat_template"):
        return tokenizer.apply_chat_template(chat_msgs, tokenize=False, add_generation_prompt=True)
    return "\n".join(f"{m['role']}: {m['content']}" for m in chat_msgs) + "\nassistant:"


@app.post("/chat")
def run_chat(payload: ChatPayload):
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE, _BUSY_COUNT
    t0 = time.time()
    _BUSY_COUNT += 1
    _touch_activity()
    try:
        if payload.imageDataUrl:
            from mlx_vlm import generate as vlm_generate, load as vlm_load
            from mlx_vlm.prompt_utils import apply_chat_template

            with _STATE_LOCK:
                if _ACTIVE_SLOT != "vlm" or _ACTIVE_MODEL_ID != payload.model:
                    clear_apple_silicon_memory()
                    model, processor = vlm_load(payload.model)
                    _ACTIVE_PIPELINE = (model, processor)
                    _ACTIVE_SLOT = "vlm"
                    _ACTIVE_MODEL_ID = payload.model
                model, processor = _ACTIVE_PIPELINE

            img = decode_data_url(payload.imageDataUrl)
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                img.save(tmp.name)
                tmp_path = tmp.name

            try:
                user_text = payload.messages[-1]["content"] if payload.messages else "Describe this image as an AI image generation prompt."
                if payload.systemPrompt:
                    user_text = f"{payload.systemPrompt}\n\n{user_text}"
                formatted = apply_chat_template(processor, model.config, user_text, num_images=1)
                output = vlm_generate(model, processor, formatted, [tmp_path], max_tokens=payload.maxTokens, verbose=False)
                text = output.text if hasattr(output, "text") else str(output)
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            _touch_activity()
            return {"text": text.strip(), "elapsedMs": int((time.time() - t0) * 1000)}

        from mlx_lm import generate as lm_generate, load as lm_load

        with _STATE_LOCK:
            if _ACTIVE_SLOT != "lm" or _ACTIVE_MODEL_ID != payload.model:
                clear_apple_silicon_memory()
                model, tokenizer = lm_load(payload.model)
                _ACTIVE_PIPELINE = (model, tokenizer)
                _ACTIVE_SLOT = "lm"
                _ACTIVE_MODEL_ID = payload.model
            model, tokenizer = _ACTIVE_PIPELINE

        prompt = _prepare_lm_prompt(tokenizer, payload)
        text = lm_generate(model, tokenizer, prompt=prompt, max_tokens=payload.maxTokens, verbose=False)
        _touch_activity()
        return {"text": text.strip(), "elapsedMs": int((time.time() - t0) * 1000)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"MLX Chat failed: {exc}")
    finally:
        _BUSY_COUNT = max(0, _BUSY_COUNT - 1)
        _touch_activity()


@app.post("/chat/stream")
def run_chat_stream(payload: ChatPayload):
    def generate_events() -> Generator[str, None, None]:
        global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE, _BUSY_COUNT
        t0 = time.time()
        _BUSY_COUNT += 1
        _touch_activity()
        try:
            if payload.imageDataUrl:
                from mlx_vlm import generate as vlm_generate, load as vlm_load
                from mlx_vlm.prompt_utils import apply_chat_template

                with _STATE_LOCK:
                    if _ACTIVE_SLOT != "vlm" or _ACTIVE_MODEL_ID != payload.model:
                        clear_apple_silicon_memory()
                        model, processor = vlm_load(payload.model)
                        _ACTIVE_PIPELINE = (model, processor)
                        _ACTIVE_SLOT = "vlm"
                        _ACTIVE_MODEL_ID = payload.model
                    model, processor = _ACTIVE_PIPELINE

                img = decode_data_url(payload.imageDataUrl)
                with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                    img.save(tmp.name)
                    tmp_path = tmp.name

                try:
                    user_text = payload.messages[-1]["content"] if payload.messages else "Describe this image as an AI image generation prompt."
                    if payload.systemPrompt:
                        user_text = f"{payload.systemPrompt}\n\n{user_text}"
                    formatted = apply_chat_template(processor, model.config, user_text, num_images=1)
                    try:
                        from mlx_vlm import stream_generate as vlm_stream_generate
                        full_text = ""
                        for chunk in vlm_stream_generate(model, processor, formatted, [tmp_path], max_tokens=payload.maxTokens):
                            token = chunk.text if hasattr(chunk, "text") else str(chunk)
                            if token:
                                full_text += token
                                yield _sse_event({"type": "delta", "text": token})
                        yield _sse_event({
                            "type": "done",
                            "text": full_text.strip(),
                            "elapsedMs": int((time.time() - t0) * 1000),
                        })
                        return
                    except ImportError:
                        output = vlm_generate(model, processor, formatted, [tmp_path], max_tokens=payload.maxTokens, verbose=False)
                        text = (output.text if hasattr(output, "text") else str(output)).strip()
                        yield _sse_event({"type": "delta", "text": text})
                        yield _sse_event({
                            "type": "done",
                            "text": text,
                            "elapsedMs": int((time.time() - t0) * 1000),
                        })
                        return
                finally:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)

            from mlx_lm import load as lm_load
            with _STATE_LOCK:
                if _ACTIVE_SLOT != "lm" or _ACTIVE_MODEL_ID != payload.model:
                    clear_apple_silicon_memory()
                    model, tokenizer = lm_load(payload.model)
                    _ACTIVE_PIPELINE = (model, tokenizer)
                    _ACTIVE_SLOT = "lm"
                    _ACTIVE_MODEL_ID = payload.model
                model, tokenizer = _ACTIVE_PIPELINE

            prompt = _prepare_lm_prompt(tokenizer, payload)
            try:
                from mlx_lm import stream_generate as lm_stream_generate
                full_text = ""
                for response in lm_stream_generate(model, tokenizer, prompt=prompt, max_tokens=payload.maxTokens):
                    token = response.text if hasattr(response, "text") else str(response)
                    if token:
                        full_text += token
                        yield _sse_event({"type": "delta", "text": token})
                yield _sse_event({
                    "type": "done",
                    "text": full_text.strip(),
                    "elapsedMs": int((time.time() - t0) * 1000),
                })
            except ImportError:
                from mlx_lm import generate as lm_generate
                text = lm_generate(model, tokenizer, prompt=prompt, max_tokens=payload.maxTokens, verbose=False).strip()
                yield _sse_event({"type": "delta", "text": text})
                yield _sse_event({
                    "type": "done",
                    "text": text,
                    "elapsedMs": int((time.time() - t0) * 1000),
                })
        except Exception as exc:
            yield _sse_event({"type": "error", "error": f"MLX Chat stream failed: {exc}"})
        finally:
            _BUSY_COUNT = max(0, _BUSY_COUNT - 1)
            _touch_activity()

    return StreamingResponse(generate_events(), media_type="text/event-stream")


def _load_t2i_pipeline(model_id: str) -> Any:
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
    import torch
    from diffusers import AutoPipelineForText2Image

    with _STATE_LOCK:
        if _ACTIVE_SLOT != "t2i" or _ACTIVE_MODEL_ID != model_id:
            clear_apple_silicon_memory()
            pipe = AutoPipelineForText2Image.from_pretrained(
                model_id,
                torch_dtype=torch.float16,
            ).to("mps")
            _enable_memory_savers(pipe)
            _ACTIVE_PIPELINE = pipe
            _ACTIVE_SLOT = "t2i"
            _ACTIVE_MODEL_ID = model_id
        return _ACTIVE_PIPELINE


def _load_i2i_pipeline(model_id: str) -> Any:
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
    import torch
    from diffusers import AutoPipelineForImage2Image

    with _STATE_LOCK:
        if _ACTIVE_SLOT != "i2i" or _ACTIVE_MODEL_ID != model_id:
            clear_apple_silicon_memory()
            pipe = AutoPipelineForImage2Image.from_pretrained(
                model_id,
                torch_dtype=torch.float16,
            ).to("mps")
            _enable_memory_savers(pipe)
            _ACTIVE_PIPELINE = pipe
            _ACTIVE_SLOT = "i2i"
            _ACTIVE_MODEL_ID = model_id
        return _ACTIVE_PIPELINE


def _load_i2v_pipeline(model_id: str) -> Any:
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
    import torch
    from diffusers import DiffusionPipeline

    with _STATE_LOCK:
        if _ACTIVE_SLOT != "i2v" or _ACTIVE_MODEL_ID != model_id:
            clear_apple_silicon_memory()
            pipe = DiffusionPipeline.from_pretrained(
                model_id,
                torch_dtype=torch.float16,
            ).to("mps")
            _enable_memory_savers(pipe)
            _ACTIVE_PIPELINE = pipe
            _ACTIVE_SLOT = "i2v"
            _ACTIVE_MODEL_ID = model_id
        return _ACTIVE_PIPELINE


@app.post("/text-to-image")
def run_t2i(payload: TextToImagePayload):
    global _BUSY_COUNT
    t0 = time.time()
    _BUSY_COUNT += 1
    _touch_activity()
    try:
        import torch
        pipe = _load_t2i_pipeline(payload.model)
        generator = torch.Generator(device="mps").manual_seed(payload.seed) if payload.seed is not None else None
        result = pipe(
            prompt=payload.prompt,
            negative_prompt=payload.negativePrompt or None,
            width=payload.width,
            height=payload.height,
            num_inference_steps=payload.steps,
            guidance_scale=payload.guidanceScale,
            generator=generator,
        )
        image = result.images[0]
        return {
            "imageDataUrl": encode_pil_png(image),
            "elapsedMs": int((time.time() - t0) * 1000),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"T2I MPS failed: {exc}")
    finally:
        _BUSY_COUNT = max(0, _BUSY_COUNT - 1)
        _touch_activity()


@app.post("/text-to-image/stream")
def run_t2i_stream(payload: TextToImagePayload):
    def generate_events() -> Generator[str, None, None]:
        global _BUSY_COUNT
        t0 = time.time()
        _BUSY_COUNT += 1
        _touch_activity()
        q: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()

        def worker():
            try:
                import torch
                q.put({"type": "step", "step": 0, "total": payload.steps, "stage": "Loading T2I weights with VAE tiling..."})
                pipe = _load_t2i_pipeline(payload.model)
                generator = torch.Generator(device="mps").manual_seed(payload.seed) if payload.seed is not None else None

                def on_step_end(p, step_index, _timestep, callback_kwargs):
                    latents = callback_kwargs.get("latents")
                    preview = _decode_latent_preview(p, latents)
                    q.put({
                        "type": "step",
                        "step": step_index + 1,
                        "total": payload.steps,
                        "previewDataUrl": preview,
                        "stage": f"Denoising step {step_index + 1}/{payload.steps}",
                    })
                    return callback_kwargs

                kwargs: Dict[str, Any] = {
                    "prompt": payload.prompt,
                    "negative_prompt": payload.negativePrompt or None,
                    "width": payload.width,
                    "height": payload.height,
                    "num_inference_steps": payload.steps,
                    "guidance_scale": payload.guidanceScale,
                    "generator": generator,
                }
                try:
                    result = pipe(**kwargs, callback_on_step_end=on_step_end)
                except TypeError:
                    result = pipe(**kwargs)

                image = result.images[0]
                q.put({
                    "type": "done",
                    "imageDataUrl": encode_pil_png(image),
                    "elapsedMs": int((time.time() - t0) * 1000),
                })
            except Exception as exc:
                q.put({"type": "error", "error": f"T2I MPS failed: {exc}"})
            finally:
                q.put(None)

        threading.Thread(target=worker, daemon=True).start()
        try:
            while True:
                item = q.get()
                if item is None:
                    break
                yield _sse_event(item)
        finally:
            _BUSY_COUNT = max(0, _BUSY_COUNT - 1)
            _touch_activity()

    return StreamingResponse(generate_events(), media_type="text/event-stream")


@app.post("/image-to-image")
def run_i2i(payload: ImageToImagePayload):
    global _BUSY_COUNT
    t0 = time.time()
    _BUSY_COUNT += 1
    _touch_activity()
    try:
        import torch
        pipe = _load_i2i_pipeline(payload.model)
        init_image = decode_data_url(payload.imageDataUrl)
        generator = torch.Generator(device="mps").manual_seed(payload.seed) if payload.seed is not None else None
        result = pipe(
            prompt=payload.prompt,
            negative_prompt=payload.negativePrompt or None,
            image=init_image,
            strength=payload.strength,
            num_inference_steps=payload.steps,
            guidance_scale=payload.guidanceScale,
            generator=generator,
        )
        image = result.images[0]
        return {
            "imageDataUrl": encode_pil_png(image),
            "elapsedMs": int((time.time() - t0) * 1000),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"I2I MPS failed: {exc}")
    finally:
        _BUSY_COUNT = max(0, _BUSY_COUNT - 1)
        _touch_activity()


@app.post("/image-to-image/stream")
def run_i2i_stream(payload: ImageToImagePayload):
    def generate_events() -> Generator[str, None, None]:
        global _BUSY_COUNT
        t0 = time.time()
        _BUSY_COUNT += 1
        _touch_activity()
        q: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()

        def worker():
            try:
                import torch
                q.put({"type": "step", "step": 0, "total": payload.steps, "stage": "Loading I2I weights with VAE tiling..."})
                pipe = _load_i2i_pipeline(payload.model)
                init_image = decode_data_url(payload.imageDataUrl)
                generator = torch.Generator(device="mps").manual_seed(payload.seed) if payload.seed is not None else None
                effective_total = max(1, int(payload.steps * payload.strength))

                def on_step_end(p, step_index, _timestep, callback_kwargs):
                    latents = callback_kwargs.get("latents")
                    preview = _decode_latent_preview(p, latents)
                    q.put({
                        "type": "step",
                        "step": min(effective_total, step_index + 1),
                        "total": effective_total,
                        "previewDataUrl": preview,
                        "stage": f"Restyling step {step_index + 1}/{effective_total}",
                    })
                    return callback_kwargs

                kwargs: Dict[str, Any] = {
                    "prompt": payload.prompt,
                    "negative_prompt": payload.negativePrompt or None,
                    "image": init_image,
                    "strength": payload.strength,
                    "num_inference_steps": payload.steps,
                    "guidance_scale": payload.guidanceScale,
                    "generator": generator,
                }
                try:
                    result = pipe(**kwargs, callback_on_step_end=on_step_end)
                except TypeError:
                    result = pipe(**kwargs)

                image = result.images[0]
                q.put({
                    "type": "done",
                    "imageDataUrl": encode_pil_png(image),
                    "elapsedMs": int((time.time() - t0) * 1000),
                })
            except Exception as exc:
                q.put({"type": "error", "error": f"I2I MPS failed: {exc}"})
            finally:
                q.put(None)

        threading.Thread(target=worker, daemon=True).start()
        try:
            while True:
                item = q.get()
                if item is None:
                    break
                yield _sse_event(item)
        finally:
            _BUSY_COUNT = max(0, _BUSY_COUNT - 1)
            _touch_activity()

    return StreamingResponse(generate_events(), media_type="text/event-stream")


@app.post("/image-to-video")
def run_i2v(payload: ImageToVideoPayload):
    global _BUSY_COUNT
    t0 = time.time()
    _BUSY_COUNT += 1
    _touch_activity()
    try:
        import torch
        from diffusers.utils import export_to_video

        pipe = _load_i2v_pipeline(payload.model)
        init_image = decode_data_url(payload.imageDataUrl)
        generator = torch.Generator(device="mps").manual_seed(payload.seed) if payload.seed is not None else None
        output = pipe(
            image=init_image,
            prompt=payload.prompt,
            num_frames=payload.numFrames,
            generator=generator,
        )
        frames = output.frames[0]
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            video_path = tmp.name
        try:
            export_to_video(frames, video_path, fps=payload.fps)
            with open(video_path, "rb") as f:
                video_b64 = base64.b64encode(f.read()).decode("utf-8")
        finally:
            if os.path.exists(video_path):
                os.remove(video_path)

        return {
            "videoDataUrl": f"data:video/mp4;base64,{video_b64}",
            "elapsedMs": int((time.time() - t0) * 1000),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"I2V MPS failed: {exc}")
    finally:
        _BUSY_COUNT = max(0, _BUSY_COUNT - 1)
        _touch_activity()


@app.post("/image-to-video/stream")
def run_i2v_stream(payload: ImageToVideoPayload):
    def generate_events() -> Generator[str, None, None]:
        global _BUSY_COUNT
        t0 = time.time()
        _BUSY_COUNT += 1
        _touch_activity()
        q: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()

        def worker():
            try:
                import torch
                from diffusers.utils import export_to_video

                est_steps = 25
                q.put({"type": "step", "step": 0, "total": est_steps, "stage": "Loading I2V pipeline with VAE tiling..."})
                pipe = _load_i2v_pipeline(payload.model)
                init_image = decode_data_url(payload.imageDataUrl)
                generator = torch.Generator(device="mps").manual_seed(payload.seed) if payload.seed is not None else None

                def on_step_end(p, step_index, _timestep, callback_kwargs):
                    latents = callback_kwargs.get("latents")
                    preview = _decode_latent_preview(p, latents)
                    q.put({
                        "type": "step",
                        "step": step_index + 1,
                        "total": est_steps,
                        "previewDataUrl": preview,
                        "stage": f"Animating video step {step_index + 1}",
                    })
                    return callback_kwargs

                kwargs: Dict[str, Any] = {
                    "image": init_image,
                    "prompt": payload.prompt,
                    "num_frames": payload.numFrames,
                    "generator": generator,
                }
                try:
                    output = pipe(**kwargs, callback_on_step_end=on_step_end)
                except TypeError:
                    output = pipe(**kwargs)

                frames = output.frames[0]
                q.put({"type": "step", "step": est_steps, "total": est_steps, "stage": "Encoding MP4..."})
                with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
                    video_path = tmp.name
                try:
                    export_to_video(frames, video_path, fps=payload.fps)
                    with open(video_path, "rb") as f:
                        video_b64 = base64.b64encode(f.read()).decode("utf-8")
                finally:
                    if os.path.exists(video_path):
                        os.remove(video_path)

                q.put({
                    "type": "done",
                    "videoDataUrl": f"data:video/mp4;base64,{video_b64}",
                    "elapsedMs": int((time.time() - t0) * 1000),
                })
            except Exception as exc:
                q.put({"type": "error", "error": f"I2V MPS failed: {exc}"})
            finally:
                q.put(None)

        threading.Thread(target=worker, daemon=True).start()
        try:
            while True:
                item = q.get()
                if item is None:
                    break
                yield _sse_event(item)
        finally:
            _BUSY_COUNT = max(0, _BUSY_COUNT - 1)
            _touch_activity()

    return StreamingResponse(generate_events(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8787)
