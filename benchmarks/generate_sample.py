#!/usr/bin/env python3
"""Generate a fixed 16 kHz / mono / 16-bit WAV of real speech for benchmarking.

A fixed input keeps STT output (and therefore LLM/TTS work) consistent run to
run. Real speech is used because the orchestrator's WebRTC VAD only triggers on
speech-like audio.

Strategy (first that works wins):
  1. macOS `say` + `afconvert`  (no extra installs)
  2. `espeak`/`espeak-ng` + `ffmpeg`
Otherwise: drop your own 16 kHz mono WAV at the output path instead.
"""

import os
import shutil
import subprocess
import sys

TEXT = "Hello, can you tell me what the weather is like today in San Francisco?"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample.wav")


def via_macos_say() -> bool:
    if not (shutil.which("say") and shutil.which("afconvert")):
        return False
    aiff = OUT + ".aiff"
    subprocess.run(["say", "-o", aiff, TEXT], check=True)
    # LEI16@16000 = little-endian 16-bit PCM at 16 kHz; -c 1 = mono.
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, OUT],
        check=True,
    )
    os.remove(aiff)
    return True


def via_espeak() -> bool:
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    if not (espeak and shutil.which("ffmpeg")):
        return False
    raw = OUT + ".raw.wav"
    subprocess.run([espeak, "-w", raw, TEXT], check=True)
    subprocess.run(
        ["ffmpeg", "-y", "-i", raw, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", OUT],
        check=True,
    )
    os.remove(raw)
    return True


def main() -> int:
    for strategy in (via_macos_say, via_espeak):
        try:
            if strategy():
                size = os.path.getsize(OUT)
                print(f"Wrote {OUT} ({size} bytes) via {strategy.__name__}.")
                print(f'Text: "{TEXT}"')
                return 0
        except subprocess.CalledProcessError as exc:
            print(f"{strategy.__name__} failed: {exc}", file=sys.stderr)

    print(
        "No TTS tool found. Install one, or place your own 16 kHz mono 16-bit WAV "
        f"at:\n  {OUT}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
