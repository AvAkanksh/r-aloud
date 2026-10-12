from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Iterator

import numpy as np


class SynthesisCancelled(Exception):
    pass


@dataclass
class Voice:
    id: str
    name: str
    lang: str

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "lang": self.lang}


class Backend:
    """A TTS engine. Implementations yield mono float32 chunks at `sample_rate`."""

    name: str = ""
    label: str = ""
    sample_rate: int = 24000
    supports_speed: bool = False

    def __init__(self) -> None:
        # Engines here are not safe (or not efficient) to run concurrently.
        self.lock = threading.Lock()

    def availability(self) -> tuple[bool, str]:
        """Return (usable, reason). Must be cheap and must not load the model."""
        raise NotImplementedError

    @property
    def loaded(self) -> bool:
        raise NotImplementedError

    def load(self) -> None:
        raise NotImplementedError

    def voices(self) -> list[Voice]:
        raise NotImplementedError

    def default_voice(self) -> str:
        raise NotImplementedError

    def synthesize(
        self, text: str, voice: str, speed: float, cancel: threading.Event
    ) -> Iterator[np.ndarray]:
        raise NotImplementedError

    def info(self) -> dict:
        ok, reason = self.availability()
        return {
            "name": self.name,
            "label": self.label,
            "available": ok,
            "reason": reason,
            "loaded": self.loaded,
            "sample_rate": self.sample_rate,
            "supports_speed": self.supports_speed,
        }
