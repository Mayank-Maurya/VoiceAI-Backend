#!/usr/bin/env python3
"""End-to-end WebSocket latency benchmark for the VoiceAI orchestrator.

Simulates browser clients: each one connects to the orchestrator, streams a WAV
as PCM frames, then waits for the synthesized WAV reply. Runs the scenario at
several concurrency levels (default 1, 5, 10) and prints a latency summary.

Per-stage model timings (STT/LLM/TTS) are NOT visible to the WebSocket client;
read those from the orchestrator / processing-engine logs (they are logged per
request). This script measures what a user actually experiences end to end.

Usage:
    python bench.py --url ws://localhost:3000/ws/audio --wav sample.wav
    python bench.py --levels 1,5,10 --timeout 180 --realtime
"""

import argparse
import asyncio
import csv
import json
import os
import statistics
import time
import wave
from datetime import datetime, timezone

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
FRAME_MS = 100
FRAME_BYTES = (SAMPLE_RATE // 1000) * FRAME_MS * BYTES_PER_SAMPLE  # 3200


def load_pcm(path: str) -> bytes:
    """Read raw PCM bytes from a 16 kHz / mono / 16-bit WAV file."""
    with wave.open(path, "rb") as wav:
        rate, channels, width = wav.getframerate(), wav.getnchannels(), wav.getsampwidth()
        if (rate, channels, width) != (SAMPLE_RATE, 1, BYTES_PER_SAMPLE):
            raise SystemExit(
                f"{path} must be 16 kHz mono 16-bit, got "
                f"{rate} Hz / {channels} ch / {width * 8}-bit. "
                "Regenerate with generate_sample.py."
            )
        return wav.readframes(wav.getnframes())


def build_frames(pcm: bytes, trailing_silence_frames: int) -> list[bytes]:
    """Split PCM into 100 ms frames and append silence to trigger VAD end-of-speech."""
    frames = [pcm[i : i + FRAME_BYTES] for i in range(0, len(pcm), FRAME_BYTES)]
    frames.extend([b"\x00" * FRAME_BYTES] * trailing_silence_frames)
    return frames


async def run_one(url: str, frames: list[bytes], timeout: float, realtime: bool) -> dict:
    """Drive a single simulated client; return its latency measurements.

    Handles both the old protocol (single binary WAV reply) and the new
    streaming protocol (JSON audio_start → binary PCM chunks → JSON audio_end).
    """
    try:
        import websockets
    except ImportError:
        raise SystemExit("Missing dependency. Run: pip install -r requirements.txt")

    start_msg = json.dumps({
        "type": "start",
        "format": "pcm_s16le",
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "frameDurationMs": FRAME_MS,
    })

    try:
        async with websockets.connect(url, max_size=None) as ws:
            await ws.send(start_msg)

            send_start = time.perf_counter()
            for frame in frames:
                await ws.send(frame)
                if realtime:
                    await asyncio.sleep(FRAME_MS / 1000)
            send_done = time.perf_counter()

            first_audio_at = None
            total_audio_bytes = 0
            deadline = time.perf_counter() + timeout

            while True:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    return {"ok": False, "error": "timeout"}
                msg = await asyncio.wait_for(ws.recv(), timeout=remaining)

                if isinstance(msg, (bytes, bytearray)):
                    if first_audio_at is None:
                        first_audio_at = time.perf_counter()
                    total_audio_bytes += len(msg)
                elif isinstance(msg, str):
                    try:
                        ctrl = json.loads(msg)
                        if ctrl.get("type") == "audio_end":
                            break
                    except json.JSONDecodeError:
                        pass

            recv_done = time.perf_counter()

            if first_audio_at is None:
                return {"ok": False, "error": "no audio received"}

            return {
                "ok": True,
                "reply_bytes": total_audio_bytes,
                "ttfa_ms": (first_audio_at - send_done) * 1000,
                "latency_ms": (recv_done - send_done) * 1000,
                "total_ms": (recv_done - send_start) * 1000,
            }
    except Exception as exc:  # noqa: BLE001 - report any client failure as a failed run
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


async def run_level(url, frames, n, timeout, realtime) -> tuple[list[dict], float]:
    """Run n clients concurrently; return their results and the wall-clock span."""
    wall_start = time.perf_counter()
    results = await asyncio.gather(*(run_one(url, frames, timeout, realtime) for _ in range(n)))
    return results, time.perf_counter() - wall_start


def summarize(level: int, results: list[dict], wall: float) -> None:
    ok = [r for r in results if r["ok"]]
    failed = [r for r in results if not r["ok"]]
    print(f"\n=== {level} concurrent user(s) ===")
    print(f"  success: {len(ok)}/{len(results)}   wall: {wall:.2f}s")

    if ok:
        ttfa = sorted(r["ttfa_ms"] for r in ok if "ttfa_ms" in r)
        lat = sorted(r["latency_ms"] for r in ok)

        if ttfa:
            print(
                "  TTFA (end-of-upload -> first audio byte): "
                f"min={ttfa[0]:.0f}  median={statistics.median(ttfa):.0f}  "
                f"mean={statistics.mean(ttfa):.0f}  p95={percentile(ttfa, 95):.0f}  "
                f"max={ttfa[-1]:.0f}  (ms)"
            )
        print(
            "  latency (end-of-upload -> last audio byte): "
            f"min={lat[0]:.0f}  median={statistics.median(lat):.0f}  "
            f"mean={statistics.mean(lat):.0f}  p95={percentile(lat, 95):.0f}  "
            f"max={lat[-1]:.0f}  (ms)"
        )
        print(f"  throughput: {len(ok) / wall:.2f} replies/sec")
    if failed:
        reasons = ", ".join(sorted({r["error"] for r in failed}))
        print(f"  failures: {len(failed)} ({reasons})")


CSV_FIELDS = [
    "timestamp", "label", "level", "request", "ok", "ttfa_ms", "latency_ms", "total_ms", "reply_bytes", "error"
]


def append_csv(path: str, label: str, level: int, results: list[dict]) -> None:
    """Append one row per request, writing a header if the file is new."""
    new_file = not os.path.exists(path) or os.path.getsize(path) == 0
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with open(path, "a", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        if new_file:
            writer.writeheader()
        for i, r in enumerate(results):
            writer.writerow({
                "timestamp": timestamp,
                "label": label,
                "level": level,
                "request": i,
                "ok": r["ok"],
                "ttfa_ms": f"{r['ttfa_ms']:.1f}" if r.get("ttfa_ms") else "",
                "latency_ms": f"{r['latency_ms']:.1f}" if r["ok"] else "",
                "total_ms": f"{r['total_ms']:.1f}" if r["ok"] else "",
                "reply_bytes": r.get("reply_bytes", ""),
                "error": r.get("error", ""),
            })


def percentile(sorted_values: list[float], pct: float) -> float:
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    rank = (pct / 100) * (len(sorted_values) - 1)
    low = int(rank)
    high = min(low + 1, len(sorted_values) - 1)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (rank - low)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://localhost:3000/ws/audio")
    parser.add_argument("--wav", default="sample.wav")
    parser.add_argument("--levels", default="1,5,10", help="comma-separated concurrency levels")
    parser.add_argument("--timeout", type=float, default=180.0, help="per-request timeout (s)")
    parser.add_argument("--trailing-silence", type=int, default=15,
                        help="silence frames appended to end the utterance")
    parser.add_argument("--realtime", action="store_true",
                        help="pace frames at 100ms each (realistic) instead of blasting")
    parser.add_argument("--no-warmup", action="store_true",
                        help="skip the warmup request (first inference is often slower)")
    parser.add_argument("--csv", default=None,
                        help="append per-request results to this CSV file (for diffing baselines)")
    parser.add_argument("--label", default="",
                        help="tag rows in the CSV (e.g. 'baseline', 'after-batching')")
    args = parser.parse_args()

    pcm = load_pcm(args.wav)
    frames = build_frames(pcm, args.trailing_silence)
    levels = [int(x) for x in args.levels.split(",") if x.strip()]

    print(f"Target:  {args.url}")
    print(f"Audio:   {args.wav}  ({len(pcm)} PCM bytes, {len(frames)} frames, "
          f"{'realtime' if args.realtime else 'blast'} send)")

    if not args.no_warmup:
        print("\nWarming up (one request, not measured)...")
        warm = await run_one(args.url, frames, args.timeout, args.realtime)
        print(f"  warmup: {'ok' if warm['ok'] else warm['error']}")

    for n in levels:
        results, wall = await run_level(args.url, frames, n, args.timeout, args.realtime)
        summarize(n, results, wall)
        if args.csv:
            append_csv(args.csv, args.label, n, results)

    if args.csv:
        print(f"\nResults appended to {args.csv}" + (f" (label='{args.label}')" if args.label else ""))
    print("Note: per-stage STT/LLM/TTS timings are in the orchestrator/engine logs.")


if __name__ == "__main__":
    asyncio.run(main())
