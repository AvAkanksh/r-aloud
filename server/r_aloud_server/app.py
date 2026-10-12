from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import logging
import os
import re
import threading
import wave
from pathlib import Path
from typing import AsyncIterator, Literal

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import config
from .backends.base import Backend, SynthesisCancelled
from .backends.kokoro import KokoroBackend
from .backends.moss import MossBackend

log = logging.getLogger("r_aloud")

BACKENDS: dict[str, Backend] = {b.name: b for b in (KokoroBackend(), MossBackend())}

# Only browser extensions may call the server from a page context; an arbitrary
# website you visit should not be able to drive your local TTS.
ORIGIN_REGEX = os.getenv(
    "R_ALOUD_CORS_ORIGIN_REGEX", r"^(chrome-extension|moz-extension)://[A-Za-z0-9\-]+$"
)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    for name in config.PRELOAD:
        backend = BACKENDS.get(name)
        if backend and backend.availability()[0]:
            log.info("preloading %s", name)
            await asyncio.to_thread(backend.load)
    yield


app = FastAPI(title="r-aloud TTS server", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=ORIGIN_REGEX,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    max_age=600,
    expose_headers=["X-Sample-Rate", "X-Backend", "X-Voice"],
)


class SpeechRequest(BaseModel):
    # OpenAI-compatible shape: `model` selects the backend.
    input: str
    model: str = Field(default_factory=lambda: config.DEFAULT_BACKEND)
    voice: str | None = None
    speed: float = 1.0
    response_format: Literal["wav", "pcm"] = "wav"


def _backend(name: str) -> Backend:
    # Accept OpenAI-style names like "tts-1" by falling back to the default.
    backend = BACKENDS.get(name) or BACKENDS.get(config.DEFAULT_BACKEND)
    ok, reason = backend.availability()
    if not ok:
        raise HTTPException(503, f"backend {backend.name!r} unavailable: {reason}")
    return backend


def _clean(text: str) -> str:
    text = text.replace("\r", "")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def _pcm16(chunk: np.ndarray) -> bytes:
    return (np.clip(chunk, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def _wav(pcm: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


async def _stream(backend: Backend, text: str, voice: str, speed: float) -> AsyncIterator[bytes]:
    """Run synthesis on a worker thread and relay PCM16 chunks as they appear."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    cancel = threading.Event()
    done = object()

    def worker() -> None:
        try:
            with backend.lock:
                for chunk in backend.synthesize(text, voice, speed, cancel):
                    if cancel.is_set():
                        break
                    loop.call_soon_threadsafe(queue.put_nowait, _pcm16(chunk))
        except SynthesisCancelled:
            pass
        except Exception as exc:  # surfaced to the consumer below
            log.exception("synthesis failed")
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, done)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    try:
        while True:
            item = await queue.get()
            if item is done:
                return
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        # Client went away (stop/skip) or we finished: let the worker bail out.
        cancel.set()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "default_backend": config.DEFAULT_BACKEND,
        "backends": [b.info() for b in BACKENDS.values()],
    }


@app.get("/v1/voices")
async def voices(backend: str = config.DEFAULT_BACKEND):
    b = _backend(backend)
    try:
        vs = await asyncio.to_thread(b.voices)
    except Exception as exc:
        raise HTTPException(503, f"could not list voices: {exc}") from exc
    return {"backend": b.name, "default": b.default_voice(), "voices": [v.to_dict() for v in vs]}


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    backend = _backend(req.model)
    text = _clean(req.input)
    if not text:
        raise HTTPException(400, "input is empty")
    if len(text) > config.MAX_INPUT_CHARS:
        raise HTTPException(413, f"input longer than {config.MAX_INPUT_CHARS} characters")
    voice = req.voice or backend.default_voice()
    if not 0.25 <= req.speed <= 4.0:
        raise HTTPException(400, "speed must be between 0.25 and 4.0")
    if not backend.loaded:
        await asyncio.to_thread(backend.load)
    if voice not in {v.id for v in await asyncio.to_thread(backend.voices)}:
        raise HTTPException(400, f"unknown voice {voice!r} for backend {backend.name!r}")

    headers = {
        "X-Sample-Rate": str(backend.sample_rate),
        "X-Backend": backend.name,
        "X-Voice": voice,
        "Cache-Control": "no-store",
    }
    stream = _stream(backend, text, voice, req.speed)
    if req.response_format == "pcm":
        return StreamingResponse(stream, media_type="audio/pcm", headers=headers)
    try:
        pcm = b"".join([c async for c in stream])
    except Exception as exc:
        raise HTTPException(500, f"synthesis failed: {exc}") from exc
    return Response(_wav(pcm, backend.sample_rate), media_type="audio/wav", headers=headers)


@app.get("/v1/local-pdf")
def local_pdf(path: str, x_r_aloud: str | None = Header(default=None)):
    """Serve a local PDF to the extension's reader.

    Firefox never lets extensions read file:// URLs, so the reader asks the
    server (which runs as you) instead. Only real PDF files are served, and the
    custom header forces a CORS preflight that only extension origins pass.
    """
    if not config.ALLOW_LOCAL_PDF:
        raise HTTPException(403, "local PDF access is disabled (R_ALOUD_ALLOW_LOCAL_PDF=0)")
    if x_r_aloud != "1":
        raise HTTPException(403, "missing X-R-Aloud header")
    p = Path(path)
    if not p.is_absolute():
        raise HTTPException(400, "path must be absolute")
    try:
        p = p.resolve(strict=True)
        with p.open("rb") as f:
            magic = f.read(1024)
    except (OSError, RuntimeError):
        raise HTTPException(404, "file not found or not readable") from None
    if not p.is_file() or b"%PDF-" not in magic:
        raise HTTPException(415, "not a PDF file")
    if p.stat().st_size > config.MAX_PDF_BYTES:
        raise HTTPException(413, "PDF too large")
    return FileResponse(p, media_type="application/pdf", headers={"Cache-Control": "no-store"})


def main() -> None:
    import uvicorn

    p = argparse.ArgumentParser(description="r-aloud local TTS server")
    p.add_argument("--host", default=config.HOST)
    p.add_argument("--port", type=int, default=config.PORT)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
