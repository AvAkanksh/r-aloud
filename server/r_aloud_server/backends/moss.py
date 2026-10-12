"""MOSS-TTS-Realtime backend.

Follows the single-turn streaming recipe from the official
`moss_tts_realtime/example_llm_stream_to_tts.py`:
codec.streaming -> push_text -> end_text -> drain -> flush.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import threading
from pathlib import Path
from typing import Iterator

import numpy as np

from ..config import DATA_DIR
from .base import Backend, SynthesisCancelled, Voice

MOSS_TTS_DIR = Path(os.getenv("MOSS_TTS_DIR", DATA_DIR / "MOSS-TTS")).expanduser()
REALTIME_DIR = MOSS_TTS_DIR / "moss_tts_realtime"
MODEL_PATH = os.getenv("R_ALOUD_MOSS_MODEL", "OpenMOSS-Team/MOSS-TTS-Realtime")
CODEC_PATH = os.getenv("R_ALOUD_MOSS_CODEC", "OpenMOSS-Team/MOSS-Audio-Tokenizer")
# "auto" picks CUDA only when the GPU can actually hold model + codec.
DEVICE = os.getenv("R_ALOUD_MOSS_DEVICE", "auto")
MIN_CUDA_BYTES = 11 * 1024**3
# "auto": bf16/fp16 on CUDA, fp32 on CPU. bfloat16 on CPU halves RAM (~8 GB) at a speed cost.
DTYPE = os.getenv("R_ALOUD_MOSS_DTYPE", "auto")
# Reference clips for voice cloning: the bundled demo prompts plus anything
# the user drops into ~/.local/share/r-aloud/voices.
VOICE_DIRS = [REALTIME_DIR / "audio", DATA_DIR / "voices"]
VOICE_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
# Not usable as speaker prompts (they are user-side dialogue clips).
SKIP_VOICES = {"user1", "user2"}

# Recommended decoding hyperparameters from the MOSS-TTS-Realtime model card.
GEN = dict(temperature=0.8, top_p=0.6, top_k=30, repetition_penalty=1.1, repetition_window=50)
PROMPT_CHUNK_DURATION = 0.24
MAX_LENGTH = 3000


class MossBackend(Backend):
    name = "moss"
    label = "MOSS-TTS-Realtime (needs big GPU)"
    sample_rate = 24000
    supports_speed = False

    def __init__(self) -> None:
        super().__init__()
        self._state = None
        self._load_lock = threading.Lock()
        self._prompt_cache: dict[str, np.ndarray] = {}

    def availability(self) -> tuple[bool, str]:
        if importlib.util.find_spec("torch") is None:
            return False, "torch not installed (uv sync --extra moss)"
        if not (REALTIME_DIR / "mossttsrealtime").is_dir():
            return False, f"MOSS-TTS repo not found at {MOSS_TTS_DIR} (set MOSS_TTS_DIR)"
        return True, ""

    @property
    def loaded(self) -> bool:
        return self._state is not None

    def _voice_files(self) -> dict[str, Path]:
        found: dict[str, Path] = {}
        for d in VOICE_DIRS:
            if d.is_dir():
                for p in sorted(d.iterdir()):
                    if p.suffix.lower() in VOICE_EXTS and p.stem not in SKIP_VOICES:
                        found[p.stem] = p
        return found

    def voices(self) -> list[Voice]:
        out = [Voice("default", "Default (no reference)", "multi")]
        out += [Voice(k, f"Clone: {k}", "multi") for k in self._voice_files()]
        return out

    def default_voice(self) -> str:
        return "prompt_audio1" if "prompt_audio1" in self._voice_files() else "default"

    def load(self) -> None:
        with self._load_lock:
            if self._state is not None:
                return
            ok, reason = self.availability()
            if not ok:
                raise RuntimeError(reason)
            if str(REALTIME_DIR) not in sys.path:
                sys.path.insert(0, str(REALTIME_DIR))

            import torch
            from transformers import AutoModel, AutoTokenizer
            from mossttsrealtime.modeling_mossttsrealtime import MossTTSRealtime
            from mossttsrealtime.processing_mossttsrealtime import MossTTSRealtimeProcessor

            device = DEVICE
            if device == "auto":
                device = "cpu"
                if torch.cuda.is_available():
                    free, _ = torch.cuda.mem_get_info()
                    if free >= MIN_CUDA_BYTES:
                        device = "cuda:0"
            device = torch.device(device)
            if device.type == "cuda":
                dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
                attn = "sdpa"
            else:
                dtype = torch.float32
                attn = "sdpa"
            if DTYPE != "auto":
                dtype = getattr(torch, DTYPE)

            # The model repo ships custom code; avoid the interactive trust prompt.
            tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True)
            processor = MossTTSRealtimeProcessor(tokenizer)
            model = MossTTSRealtime.from_pretrained(
                MODEL_PATH, attn_implementation=attn, torch_dtype=dtype
            ).to(device)
            model.eval()
            codec = AutoModel.from_pretrained(CODEC_PATH, trust_remote_code=True).eval().to(device)
            if DTYPE != "auto":
                codec = codec.to(dtype)
            self._state = dict(
                torch=torch, tokenizer=tokenizer, processor=processor,
                model=model, codec=codec, device=device, dtype=dtype,
            )

    def _autocast(self):
        # The codec casts some activations back to float32 internally; autocast
        # lets reduced-precision weights (R_ALOUD_MOSS_DTYPE) work with that.
        s = self._state
        torch = s["torch"]
        reduced = DTYPE != "auto" and s["dtype"] != torch.float32
        return torch.autocast(s["device"].type, dtype=s["dtype"], enabled=reduced)

    def _prompt_tokens(self, voice: str) -> np.ndarray | None:
        if voice in ("", "default"):
            return None
        path = self._voice_files().get(voice)
        if path is None:
            raise ValueError(f"unknown moss voice {voice!r}")
        key = f"{path}:{path.stat().st_mtime_ns}"
        if key not in self._prompt_cache:
            # librosa rather than torchaudio.load: the latter needs torchcodec,
            # which is picky about the system FFmpeg version.
            import librosa

            torch = self._state["torch"]
            samples, _ = librosa.load(str(path), sr=self.sample_rate, mono=True)
            wav = torch.from_numpy(samples).unsqueeze(0)
            with torch.inference_mode(), self._autocast():
                res = self._state["codec"].encode(
                    wav.unsqueeze(0).to(self._state["device"]),
                    chunk_duration=PROMPT_CHUNK_DURATION,
                )
            self._prompt_cache[key] = res["audio_codes"].cpu().numpy().squeeze(1)
        return self._prompt_cache[key]

    def synthesize(
        self, text: str, voice: str, speed: float, cancel: threading.Event
    ) -> Iterator[np.ndarray]:
        self.load()
        from mossttsrealtime.streaming_mossttsrealtime import (
            AudioStreamDecoder,
            MossTTSRealtimeInference,
            MossTTSRealtimeStreamingSession,
        )

        s = self._state
        torch, tokenizer, processor, codec = s["torch"], s["tokenizer"], s["processor"], s["codec"]
        prompt_tokens = self._prompt_tokens(voice)

        inferencer = MossTTSRealtimeInference(s["model"], tokenizer, max_length=MAX_LENGTH)
        inferencer.reset_generation_state(keep_cache=False)
        session = MossTTSRealtimeStreamingSession(
            inferencer,
            processor,
            codec=codec,
            codec_sample_rate=self.sample_rate,
            codec_encode_kwargs={"chunk_duration": PROMPT_CHUNK_DURATION},
            prefill_text_len=processor.delay_tokens_len,
            do_sample=True,
            **GEN,
        )
        if prompt_tokens is not None:
            session.set_voice_prompt_tokens(prompt_tokens)
        else:
            session.clear_voice_prompt()

        system_prompt = processor.make_ensemble(prompt_tokens)
        prefix_ids = tokenizer.encode("<|im_end|>\n<|im_start|>assistant\n")
        prefix = np.full((len(prefix_ids), system_prompt.shape[1]), processor.audio_channel_pad, dtype=np.int64)
        prefix[:, 0] = prefix_ids
        session.reset_turn(
            input_ids=np.concatenate([system_prompt, prefix], axis=0),
            include_system_prompt=False,
            reset_cache=True,
        )

        decoder = AudioStreamDecoder(
            codec, chunk_frames=3, overlap_frames=0,
            decode_kwargs={"chunk_duration": -1}, device=s["device"],
        )
        codebook_size = int(getattr(codec, "codebook_size", 1024))
        audio_eos = int(getattr(inferencer, "audio_eos_token", 1026))

        def decode(frames) -> Iterator[np.ndarray]:
            for tokens in frames:
                if cancel.is_set():
                    raise SynthesisCancelled()
                if tokens.dim() == 3:
                    tokens = tokens[0]
                tokens = _sanitize(tokens, codebook_size, audio_eos)
                if tokens.numel() == 0:
                    continue
                decoder.push_tokens(tokens.detach())
                for wav in decoder.audio_chunks():
                    if wav.numel():
                        yield wav.detach().float().cpu().numpy().reshape(-1)

        with torch.inference_mode(), self._autocast(), codec.streaming(batch_size=1):
            yield from decode(session.push_text(text))
            yield from decode(session.end_text())
            while not cancel.is_set():
                frames = session.drain(max_steps=1)
                if not frames:
                    break
                yield from decode(frames)
                if session.inferencer.is_finished:
                    break
            if cancel.is_set():
                raise SynthesisCancelled()
            final = decoder.flush()
            if final is not None and final.numel():
                yield final.detach().float().cpu().numpy().reshape(-1)


def _sanitize(tokens, codebook_size: int, audio_eos: int):
    """Cut the frame sequence at EOS or the first out-of-range code (as upstream)."""
    if tokens.dim() == 1:
        tokens = tokens.unsqueeze(0)
    if tokens.numel() == 0:
        return tokens
    stop = None
    eos_rows = (tokens[:, 0] == audio_eos).nonzero(as_tuple=False)
    if eos_rows.numel():
        stop = int(eos_rows[0].item())
    invalid = ((tokens < 0) | (tokens >= codebook_size)).any(dim=1)
    if invalid.any():
        idx = int(invalid.nonzero(as_tuple=False)[0].item())
        stop = idx if stop is None else min(stop, idx)
    return tokens if stop is None else tokens[:stop]
