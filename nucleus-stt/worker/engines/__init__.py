"""Engine registry for the nucleus-stt worker.

Copy-forked from aunshin-phone (bead nucleus-phone-rgja.4). The eval-only
engines (faster-whisper, moonshine-v2) are NOT shipped here — nucleus-stt runs
moonshine for the live tier and whisper.cpp for batch. See worker/README or the
plan (~/.claude/plans/stateful-bubbling-llama.md).
"""

from .base import STTEngine
from .moonshine_engine import MoonshineEngine
from .whisper_cpp_engine import WhisperCppEngine

__all__ = ["STTEngine", "MoonshineEngine", "WhisperCppEngine"]
