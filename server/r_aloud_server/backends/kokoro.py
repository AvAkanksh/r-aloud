from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Iterator

import numpy as np

from ..config import DATA_DIR
from .base import Backend, SynthesisCancelled, Voice

MODEL_DIR = Path(os.getenv("R_ALOUD_KOKORO_DIR", DATA_DIR / "models"))
MODEL_FILE = os.getenv("R_ALOUD_KOKORO_MODEL", "kokoro-v1.0.onnx")
VOICES_FILE = os.getenv("R_ALOUD_KOKORO_VOICES", "voices-v1.0.bin")
RELEASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

# Kokoro voice ids are "<lang><gender>_<name>", e.g. "af_heart".
LANGS = {
    "a": ("en-us", "American English"),
    "b": ("en-gb", "British English"),
    "e": ("es", "Spanish"),
    "f": ("fr-fr", "French"),
    "h": ("hi", "Hindi"),
    "i": ("it", "Italian"),
    "j": ("ja", "Japanese"),
    "p": ("pt-br", "Brazilian Portuguese"),
    "z": ("cmn", "Mandarin Chinese"),
}


SENTENCE_END_RE = re.compile(r"[.!?…。！？]+[\"'”’)\]]*(?=\s)")
CLAUSE_RE = re.compile(r"(?<=[,;:—])\s+")
LONG_SENTENCE = 120
MIN_CLAUSE = 40
SENTENCE_PAUSE = 0.25
CLAUSE_PAUSE = 0.1


def split_for_streaming(text: str) -> list[tuple[str, float]]:
    """Split into (piece, pause_after) at paragraph, sentence and, for long
    sentences, clause boundaries. Smaller pieces mean faster first audio."""
    out: list[tuple[str, float]] = []
    for para in (p.strip() for p in text.split("\n")):
        cuts = [0, *(m.end() for m in SENTENCE_END_RE.finditer(para)), len(para)]
        for sentence in (para[a:b].strip() for a, b in zip(cuts, cuts[1:])):
            if not sentence:
                continue
            if len(sentence) <= LONG_SENTENCE:
                out.append((sentence, SENTENCE_PAUSE))
                continue
            buf = ""
            for clause in CLAUSE_RE.split(sentence):
                buf = f"{buf} {clause}".strip()
                if len(buf) >= MIN_CLAUSE:
                    out.append((buf, CLAUSE_PAUSE))
                    buf = ""
            if buf:
                if out and out[-1][1] == CLAUSE_PAUSE and len(buf) < MIN_CLAUSE:
                    out[-1] = (f"{out[-1][0]} {buf}", CLAUSE_PAUSE)
                else:
                    out.append((buf, CLAUSE_PAUSE))
            out[-1] = (out[-1][0], SENTENCE_PAUSE)
    if out:
        out[-1] = (out[-1][0], 0.0)
    return out


def _lang_for(voice: str) -> str:
    return LANGS.get(voice[:1], LANGS["a"])[0]


class KokoroBackend(Backend):
    name = "kokoro"
    label = "Kokoro-82M (fast, CPU)"
    sample_rate = 24000
    supports_speed = True

    def __init__(self) -> None:
        super().__init__()
        self._kokoro = None
        self._load_lock = threading.Lock()

    @property
    def model_path(self) -> Path:
        return MODEL_DIR / MODEL_FILE

    @property
    def voices_path(self) -> Path:
        return MODEL_DIR / VOICES_FILE

    def availability(self) -> tuple[bool, str]:
        missing = [p.name for p in (self.model_path, self.voices_path) if not p.is_file()]
        if missing:
            return False, (
                f"missing {', '.join(missing)} in {MODEL_DIR} (download from {RELEASE_URL})"
            )
        return True, ""

    @property
    def loaded(self) -> bool:
        return self._kokoro is not None

    def load(self) -> None:
        with self._load_lock:
            if self._kokoro is not None:
                return
            ok, reason = self.availability()
            if not ok:
                raise RuntimeError(reason)
            from kokoro_onnx import Kokoro

            self._kokoro = Kokoro(str(self.model_path), str(self.voices_path))

    def voices(self) -> list[Voice]:
        self.load()
        out = []
        for vid in sorted(self._kokoro.get_voices()):
            lang_name = LANGS.get(vid[:1], ("", "Other"))[1]
            gender = {"f": "female", "m": "male"}.get(vid[1:2], "")
            pretty = vid.split("_", 1)[-1].replace("_", " ").title()
            out.append(Voice(vid, f"{pretty} ({lang_name}, {gender})", _lang_for(vid)))
        return out

    def default_voice(self) -> str:
        return "af_heart"

    def synthesize(
        self, text: str, voice: str, speed: float, cancel: threading.Event
    ) -> Iterator[np.ndarray]:
        self.load()
        if voice not in self._kokoro.voices:
            raise ValueError(f"unknown kokoro voice {voice!r}")
        speed = float(min(2.0, max(0.5, speed)))
        lang = _lang_for(voice)
        # Synthesize piece by piece so audio starts streaming early and
        # cancellation is noticed between pieces.
        for piece, pause in split_for_streaming(text):
            if cancel.is_set():
                raise SynthesisCancelled()
            try:
                audio, _ = self._kokoro.create(piece, voice=voice, speed=speed, lang=lang)
            except ValueError as exc:
                # Pieces that are pure punctuation/symbols produce no phonemes.
                if "phonemes" in str(exc):
                    continue
                raise
            audio = np.asarray(audio, dtype=np.float32)
            if pause:
                audio = np.concatenate([audio, np.zeros(int(pause / speed * self.sample_rate), np.float32)])
            yield audio
