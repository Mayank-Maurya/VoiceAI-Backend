# Benchmarks

End-to-end latency benchmark for the voice pipeline. It drives the orchestrator
over WebSocket exactly like the browser does (stream PCM in, get WAV out) at
several concurrency levels, so you get a baseline to compare future changes
against.

## What you get

- **`bench.py`** — measures **client-perceived end-to-end latency** (time from
  finishing the audio upload to receiving the spoken reply) at 1, 5, and 10
  concurrent users, with min / median / mean / p95 / max and throughput.
- **Per-stage model timings (STT / LLM / TTS)** are printed in the
  **orchestrator and processing-engine logs** for every request — the WebSocket
  client can't see them, so read them there. Each stage is split into
  **`compute`** (GPU time) and **`wait`** (time queued behind other requests on
  the per-model lock), so under load you can tell the two apart:

  ```
  ⏱️  [id] compute STT=280 LLM=1200 TTS=150ms | wait STT=0 LLM=50 TTS=0ms | total=1680ms roundTrip=...
  ```

## Setup

```bash
cd benchmarks
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Generate the fixed test clip (16 kHz mono WAV).
python generate_sample.py
```

## Run

Start the processing engine and the orchestrator first, then:

```bash
# Defaults: ws://localhost:3000/ws/audio, sample.wav, levels 1,5,10
python bench.py

# Point at a remote orchestrator / tweak the run
python bench.py --url ws://192.168.1.5:3000/ws/audio --levels 1,5,10,20
python bench.py --realtime          # pace frames at 100ms (realistic upload)

# Save baselines to CSV for diffing over time (one row per request, appends)
python bench.py --csv runs.csv --label baseline
python bench.py --csv runs.csv --label after-batching
```

> **For stable, comparable numbers**, run the processing engine with
> `LLM_DETERMINISTIC=true`. The LLM then produces the same reply (and length)
> every run for a fixed input, so latency isn't skewed by random reply length.

## Reading the results

```
=== 5 concurrent user(s) ===
  success: 5/5   wall: 18.40s
  latency (end-of-upload -> reply): min=3600 median=7200 mean=7100 p95=11000 max=11200 (ms)
  throughput: 0.27 replies/sec
```

Expect latency to grow roughly linearly with users and throughput to stay flat:
the engine serializes each model behind an `asyncio.Lock`, so concurrent
requests queue on the single GPU rather than running in parallel. That is the
intended baseline to beat once batching / multi-worker is added.

## Notes & flags

- `--no-warmup` skips the initial (often slower) first inference.
- `--realtime` streams frames at real time instead of blasting them; use it for
  a realistic upload profile, omit it to isolate server-side compute.
- `latency_ms` excludes the client's own upload time; a real user additionally
  waits out the ~800 ms VAD end-of-speech hangover after they stop talking.
- The default `--timeout` is 180 s because high concurrency queues on one GPU.
