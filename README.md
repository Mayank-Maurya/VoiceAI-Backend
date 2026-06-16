# VoiceAI Backend — real-time, low-latency voice assistant

![Node.js](https://img.shields.io/badge/Node.js-orchestrator-339933?logo=node.js&logoColor=white)
![WebSockets](https://img.shields.io/badge/transport-WebSockets-blue)
![faster-whisper](https://img.shields.io/badge/STT-faster--whisper-orange)
![vLLM](https://img.shields.io/badge/LLM%20serving-vLLM-5A2D81)
![Kokoro](https://img.shields.io/badge/TTS-Kokoro--82M-22c55e)
![GPU](https://img.shields.io/badge/GPU-12GB%20VRAM-76B900?logo=nvidia&logoColor=white)

A full **speech-to-speech** voice assistant. The browser streams raw mic audio to a Node.js
WebSocket orchestrator, which runs a **fully streaming** pipeline — **streaming STT → streaming
LLM → streaming TTS** — and plays synthesized audio back over the same connection while the rest
of the response is still being generated. Everything runs on a single **12 GB** GPU.

The interesting part is the **architecture evolution**:

- **V1** — a monolithic, lock-serialized GPU pipeline (one FastAPI service, STT→LLM→TTS sequential).
- **V2** — re-architected into queue-backed worker services behind RabbitMQ with **vLLM** serving the LLM. ~50% lower latency under load.
- **V3** — **end-to-end streaming**. VAD removed, RabbitMQ removed from the hot path, STT replaced with streaming faster-whisper. Every stage overlaps, so the user hears the first words while the LLM is still generating the rest.

### ⚡ Results at a glance

V3 is a streaming system, so the metric that matters is **TTFA — Time To First Audio byte** (how
long until the user starts *hearing* the reply), not end-to-end time for the whole reply.

| Metric | V1 (monolith) | V2 (queue + vLLM) | V3 (streaming) |
| --- | ---: | ---: | ---: |
| Endpointing | VAD (~800 ms tax) | VAD (~800 ms tax) | **energy gate (no model)** |
| STT | Canary (batch) | Canary (queued) | **faster-whisper (streaming)** |
| Latency metric | end-to-end | end-to-end | **TTFA** |
| 1-user latency | 2192 ms | 1447 ms | **~165 ms TTFA** |
| 10-user throughput | 0.65 rps | 1.19 rps | **1.53 rps** |

At 1 user, time-to-first-audio dropped roughly **10×** versus V1's end-to-end latency — the win
comes from streaming overlap plus deleting the 800 ms VAD hangover, not from a hardware upgrade.

### Highlights

- **Fully streaming voice loop** over a single WebSocket — energy-gated audio → streaming STT → streaming LLM (SSE) → sentence-buffered streaming TTS → gapless browser playback.
- **No VAD model** — a simple RMS energy gate forwards audio to the STT service and signals silence; the STT decides utterance boundaries from transcript stability.
- **Barge-in** — speak while the assistant is talking and the current turn is cancelled mid-stream (LLM + TTS aborted, browser playback stopped).
- **Conversation memory** — last 10 turns are passed to the LLM each turn.
- **vLLM** serving the LLM via an OpenAI-compatible API with continuous batching.
- **Designed for one GPU PC** — three lightweight services (~5 GB VRAM total on a 12 GB card), no duplicate model copies.

## Target Machine

The local target machine is intentionally modest:

- NVIDIA GPU with 12 GB VRAM (benchmarked on an RTX 3060)
- 16 GB system RAM
- STT service, TTS service, and vLLM run on the GPU PC
- The Node orchestrator runs on the same machine or another machine on the LAN

VRAM budget (observed via `nvidia-smi`): **~5 GB of 12 GB** — STT ~0.8 GB, vLLM ~1 GB
(tunable), TTS ~0.2 GB, plus CUDA context overhead. Plenty of headroom for concurrency tuning.

## Architecture Overview

### V3: Fully Streaming Pipeline (current)

```text
Browser (mic, PCM16 100ms frames)
  |
  |  WebSocket  ws://<orch>:3000/ws/audio
  v
Node Orchestrator
  |  - energy gate (RMS): forward voiced frames, signal silence
  |  - per-session WebSocket to the STT service
  |  - sentence buffer over the LLM token stream
  |  - barge-in via AbortController, 10-turn history
  |
  +--WS--> STT Service  :7003   faster-whisper medium int8
  |  <--   partial + final transcripts
  |
  |  on final transcript:
  +--SSE-> vLLM          :8000   Qwen2.5-0.5B-Instruct (token stream)
  |  <--   tokens -> sentence buffer
  |
  |  per complete sentence:
  +--HTTP-> TTS Service  :7002   Kokoro-82M (length-prefixed PCM16 chunks)
  |  <--   PCM16 audio chunks
  |
  v
Browser (AudioWorklet ring buffer, gapless streaming playback)
```

The stages **overlap**: STT runs continuously while the user speaks; the LLM starts on the first
final transcript; TTS starts on the first complete sentence; the browser plays the first chunk
while later sentences are still being synthesized. This overlap is what produces the low TTFA.

### Architecture history

- **V1 — Monolith.** One FastAPI `/voice-chat` endpoint loaded STT (Canary), LLM (Llama 3.2, 4-bit), and TTS (Kokoro). Each stage was lock-protected, so concurrent users queued behind one sequential pipeline. Proved end-to-end voice; poor concurrency.
- **V2 — Queue-backed + vLLM.** STT and TTS became RabbitMQ workers (`stt.jobs` / `tts.jobs` + reply queues matched by `correlationId`); vLLM took over the LLM. STT/TTS scaled independently; >50% latency reduction under load. Still batch (each stage waited for the previous to fully finish) and still VAD-gated.
- **V3 — Streaming.** Removed VAD (energy gate instead), removed RabbitMQ from the hot path (direct WS/HTTP), replaced Canary with streaming faster-whisper, enabled token streaming from vLLM, and added a sentence buffer + streaming TTS + AudioWorklet playback. Added barge-in and conversation history.

> Horizontal scaling (V2's original goal) returns later as **service replication behind a load
> balancer / queue** — the streaming services are stateless per request, so this is additive.

## Repository Layout

```text
client/
  Browser client: captures mic audio, streams PCM16, plays streaming PCM16
  playback through an AudioWorklet ring buffer. Supports barge-in.

orchestrator-service/
  Node.js + TypeScript WebSocket server. Owns sessions, the energy gate,
  the per-session STT WebSocket, the sentence buffer, vLLM streaming,
  TTS streaming, barge-in, and conversation history.

processing-engine/
  Python services for the GPU box:
    stt_service.py        - FastAPI + WebSocket streaming STT (faster-whisper)
    tts-service.py        - FastAPI streaming TTS (Kokoro)
    app/models/stt.py     - faster-whisper runtime
    app/models/tts.py     - Kokoro runtime (streaming PCM16 chunks)
    app/config.py         - STT/TTS configuration

benchmarks/
  WebSocket benchmark harness, fixed sample audio, and V1/V2/V3 CSVs.
```

## Runtime Components

### Node Orchestrator

- Accepts WebSocket audio from the browser and re-frames it into 100 ms frames.
- **Energy gate**: forwards voiced frames (RMS over threshold) to that session's STT WebSocket; after a short silence, sends a `{ "silence": true }` signal.
- Opens a **dedicated STT WebSocket per session** and triggers a turn on the final transcript.
- Streams the LLM response from vLLM (SSE), feeds tokens into a **sentence buffer**, and fires each complete sentence to the TTS service.
- Forwards TTS PCM16 chunks to the browser, framed by `audio_start` / `audio_end` control messages.
- **Barge-in**: a new final transcript aborts the in-flight turn (`AbortController`) and sends `audio_cancel`.

Important files:

- `orchestrator-service/src/index.ts`
- `orchestrator-service/src/session/sessionManager.ts`
- `orchestrator-service/src/vad/speechDetector.ts` (energy gate)
- `orchestrator-service/src/pipeline/voicePipeline.ts`
- `orchestrator-service/src/pipeline/sentenceBuffer.ts`
- `orchestrator-service/src/pipeline/vllmClient.ts`

### STT Service (`:7003`)

Standalone FastAPI + WebSocket server. Each orchestrator session opens `ws://<gpu>:7003/ws/stt`,
streams PCM16 frames, and receives partial/final transcripts as JSON. Final detection: transcript
stable for ~300 ms **and** a silence signal from the orchestrator.

- Model: `faster-whisper medium`, int8, on CUDA.
- `STT_NUM_WORKERS` (default 4) allows concurrent transcriptions on separate CUDA streams.
- Partials transcribe only a trailing window (avoids O(n²) re-decoding of the growing buffer).

File: `processing-engine/stt_service.py`

### vLLM Server (`:8000`)

Serves the LLM with continuous batching over an OpenAI-compatible HTTP API. The orchestrator calls
`/v1/chat/completions` with `stream: true`.

Default model: `Qwen/Qwen2.5-0.5B-Instruct`.

### TTS Service (`:7002`)

Standalone FastAPI server. `POST /tts/stream` accepts `{ "text": "..." }` and returns a stream of
length-prefixed PCM16 chunks (`4-byte LE length` + PCM bytes).

Default model: `Kokoro-82M`, 24 kHz output.

File: `processing-engine/tts-service.py`

## Setup

Run the three GPU services on the GPU PC, the orchestrator anywhere on the LAN, and open the client
in a browser.

### 1. Start vLLM on the GPU PC

```bash
docker rm -f voiceai-vllm

docker run -d \
  --name voiceai-vllm \
  --runtime nvidia --gpus all \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -p 8000:8000 --ipc=host \
  vllm/vllm-openai:latest \
  Qwen/Qwen2.5-0.5B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --gpu-memory-utilization 0.45 \
  --max-model-len 2048 \
  --max-num-seqs 64
```

Check: `curl http://127.0.0.1:8000/v1/models`

### 2. Start the STT service on the GPU PC

```bash
cd processing-engine
pip install -r requirements.txt

PYTHONPATH=. python3 stt_service.py
# listens on 0.0.0.0:7003, WebSocket at /ws/stt
```

First run downloads the faster-whisper `medium` weights (~1.5 GB) and caches them under
`~/.cache/huggingface`. Tune concurrency with `STT_NUM_WORKERS`.

### 3. Start the TTS service on the GPU PC

```bash
cd processing-engine

PYTHONPATH=. python3 tts-service.py
# listens on 0.0.0.0:7002, endpoint POST /tts/stream
```

### 4. Start the orchestrator

```bash
cd orchestrator-service
npm install
npm run dev
```

Example `.env` (all service URLs default to `REMOTE_IP`):

```env
REMOTE_IP=192.168.1.6
PORT=3000
RMS_SPEECH_THRESHOLD=600
# STT_WS_URL=ws://192.168.1.6:7003
# TTS_STREAM_URL=http://192.168.1.6:7002
# VLLM_BASE_URL=http://192.168.1.6:8000
VLLM_MODEL_ID=Qwen/Qwen2.5-0.5B-Instruct
LLM_MAX_NEW_TOKENS=256
LLM_TEMPERATURE=0.6
```

Wait for:

```text
HTTP server listening on http://localhost:3000
WebSocket endpoint ready at ws://localhost:3000/ws/audio
```

### 5. Open the client

Set the WebSocket target in `client/config.js`, then serve the folder:

```bash
cd client
python3 -m http.server 8080 --bind 0.0.0.0
```

Open `http://localhost:3000/health` to confirm the orchestrator is up, then open the client at
`http://localhost:8080`. The browser streams PCM16, 16 kHz, mono audio over WebSocket.

#### Using the client from a phone on the same network

1. In `client/config.js`, set `WS_URL` to `ws://<MAC_LAN_IP>:3000/ws/audio`.
2. Serve the client bound to `0.0.0.0` (as above) and browse to `http://<MAC_LAN_IP>:8080`.
3. **Microphone needs a secure context.** Over plain `http://<ip>` the browser blocks `getUserMedia`. On Android Chrome, add the origin to `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (e.g. `http://192.168.1.4:8080`), set it to **Enabled**, and relaunch. For iOS or a cleaner setup, put both the client and orchestrator behind HTTPS/WSS (e.g. an `ngrok` tunnel) and use a `wss://` URL.

## Benchmarking

The harness simulates browser clients over WebSocket, sends a fixed WAV sample, and now measures
**TTFA** (first audio byte) in addition to full-reply latency. See `benchmarks/`.

```bash
cd benchmarks
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

python bench.py \
  --url ws://localhost:3000/ws/audio \
  --wav sample.wav \
  --levels 1,5,10 \
  --realtime \
  --timeout 180 \
  --csv results.csv \
  --label v3
```

Use `--realtime` for V3: it paces frames at 100 ms each (like a real mic), which the streaming STT
needs to detect utterance boundaries. CSVs: `v1_bench.csv`, `v2_bench.csv`, `results.csv`.

> Note: because V3 can begin responding *before* the upload finishes, the benchmark's
> "end-of-upload" timing reference understates TTFA in some rows. The honest single-turn TTFA is
> ~165 ms. Endpointing tuning (avoiding early finalization on mid-sentence pauses) is in progress.

## Troubleshooting

### `/health` works but the mic doesn't

`getUserMedia` requires a secure context. On `localhost` it works; over a LAN IP it does not. Use
the Android Chrome insecure-origin flag or an HTTPS/WSS tunnel (see the phone section above).

### Connection opens but there's no audio reply

The orchestrator's per-session STT WebSocket connects to the GPU box on demand. Make sure the STT
service (`:7003`), TTS service (`:7002`), and vLLM (`:8000`) are all running and reachable at
`REMOTE_IP`. Check the orchestrator log for `STT WebSocket connected`.

### Audio cuts off or won't play in the browser

The client buffers streaming PCM16 in an AudioWorklet ring buffer and drains on `audio_end`. If
`audio_end` arrives before the worklet finishes initializing, the drain is deferred until init
completes. Hard-refresh (Cmd/Ctrl+Shift+R) to clear a cached `app.js`.

### Transcripts get cut off mid-sentence

The energy gate finalizes on a short silence. If it cuts people off during natural pauses, raise
the silence-to-finalize threshold in `orchestrator-service/src/vad/speechDetector.ts` (and/or the
stability window in `stt_service.py`).

### Process prints `Killed` while loading a model

Usually the Linux OOM killer on a 16 GB box. Load services one at a time, check `free -h` /
`nvidia-smi`, and add swap if needed.
