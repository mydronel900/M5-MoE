#!/usr/bin/env python3
"""
M5 MacBook Air (16GB Unified Memory) Local MoE Inference Worker
================================================================
Serves all 4 Mixture-of-Experts slots locally over Apple Silicon Metal (MLX + MPS):
  1. Chat & Image-to-Prompt (mlx-lm / mlx-vlm)
  2. Text-to-Image (mflux / diffusers MPS)
  3. Image-to-Image (diffusers MPS)
  4. Image-to-Video (diffusers LTX-Video / SVD MPS)

Designed for 16GB Unified Memory:
  Automatically unloads the previous expert and clears MLX/MPS Metal cache
  before loading a different expert model, preventing out-of-memory errors.

Install dependencies on your M5 MacBook Air:
  pip install fastapi uvicorn pillow pydantic huggingface_hub mlx-lm mlx-vlm mflux diffusers transformers accelerate torch

Run:
  python3 m5_mlx_worker.py
"""

import base64
import gc
import io
import os
import tempfile
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

app = FastAPI(title="M5 Local MoE Worker", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active expert state (single-resident strategy for 16GB Unified Memory)
_ACTIVE_SLOT: Optional[str] = None
_ACTIVE_MODEL_ID: Optional[str] = None
_ACTIVE_PIPELINE: Any = None


def clear_apple_silicon_memory() -> None:
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
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


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": "apple-silicon-mps-mlx",
        "activeSlot": _ACTIVE_SLOT,
        "activeModel": _ACTIVE_MODEL_ID,
    }


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


@app.post("/pull")
def pull_model(payload: PullPayload):
    try:
        from huggingface_hub import snapshot_download
        local_dir = snapshot_download(repo_id=payload.modelId)
        return {"status": "downloaded", "modelId": payload.modelId, "path": local_dir}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/chat")
def run_chat(payload: ChatPayload):
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
    t0 = time.time()
    try:
        if payload.imageDataUrl:
            # Multimodal Vision / Image-to-Prompt via mlx-vlm
            from mlx_vlm import generate as vlm_generate, load as vlm_load
            from mlx_vlm.prompt_utils import apply_chat_template

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
            return {"text": text.strip(), "elapsedMs": int((time.time() - t0) * 1000)}

        # Text-only Chat / Prompt Generation via mlx-lm
        from mlx_lm import generate as lm_generate, load as lm_load

        if _ACTIVE_SLOT != "lm" or _ACTIVE_MODEL_ID != payload.model:
            clear_apple_silicon_memory()
            model, tokenizer = lm_load(payload.model)
            _ACTIVE_PIPELINE = (model, tokenizer)
            _ACTIVE_SLOT = "lm"
            _ACTIVE_MODEL_ID = payload.model

        model, tokenizer = _ACTIVE_PIPELINE
        chat_msgs = []
        if payload.systemPrompt:
            chat_msgs.append({"role": "system", "content": payload.systemPrompt})
        chat_msgs.extend(payload.messages)

        if hasattr(tokenizer, "apply_chat_template"):
            prompt = tokenizer.apply_chat_template(chat_msgs, tokenize=False, add_generation_prompt=True)
        else:
            prompt = "\n".join(f"{m['role']}: {m['content']}" for m in chat_msgs) + "\nassistant:"

        text = lm_generate(model, tokenizer, prompt=prompt, max_tokens=payload.maxTokens, verbose=False)
        return {"text": text.strip(), "elapsedMs": int((time.time() - t0) * 1000)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"MLX Chat failed: {exc}")


@app.post("/text-to-image")
def run_t2i(payload: TextToImagePayload):
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
    t0 = time.time()
    try:
        import torch
        from diffusers import AutoPipelineForText2Image

        if _ACTIVE_SLOT != "t2i" or _ACTIVE_MODEL_ID != payload.model:
            clear_apple_silicon_memory()
            pipe = AutoPipelineForText2Image.from_pretrained(
                payload.model,
                torch_dtype=torch.float16,
            ).to("mps")
            pipe.enable_attention_slicing()
            _ACTIVE_PIPELINE = pipe
            _ACTIVE_SLOT = "t2i"
            _ACTIVE_MODEL_ID = payload.model

        pipe = _ACTIVE_PIPELINE
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


@app.post("/image-to-image")
def run_i2i(payload: ImageToImagePayload):
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
    t0 = time.time()
    try:
        import torch
        from diffusers import AutoPipelineForImage2Image

        if _ACTIVE_SLOT != "i2i" or _ACTIVE_MODEL_ID != payload.model:
            clear_apple_silicon_memory()
            pipe = AutoPipelineForImage2Image.from_pretrained(
                payload.model,
                torch_dtype=torch.float16,
            ).to("mps")
            pipe.enable_attention_slicing()
            _ACTIVE_PIPELINE = pipe
            _ACTIVE_SLOT = "i2i"
            _ACTIVE_MODEL_ID = payload.model

        pipe = _ACTIVE_PIPELINE
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


@app.post("/image-to-video")
def run_i2v(payload: ImageToVideoPayload):
    global _ACTIVE_SLOT, _ACTIVE_MODEL_ID, _ACTIVE_PIPELINE
    t0 = time.time()
    try:
        import torch
        from diffusers import DiffusionPipeline
        from diffusers.utils import export_to_video

        if _ACTIVE_SLOT != "i2v" or _ACTIVE_MODEL_ID != payload.model:
            clear_apple_silicon_memory()
            pipe = DiffusionPipeline.from_pretrained(
                payload.model,
                torch_dtype=torch.float16,
            ).to("mps")
            if hasattr(pipe, "enable_attention_slicing"):
                pipe.enable_attention_slicing()
            _ACTIVE_PIPELINE = pipe
            _ACTIVE_SLOT = "i2v"
            _ACTIVE_MODEL_ID = payload.model

        pipe = _ACTIVE_PIPELINE
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8787)
