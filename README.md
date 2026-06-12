# VoiceAI Backend — real-time, low-latency voice assistant

![Node.js](https://img.shields.io/badge/Node.js-orchestrator-339933?logo=node.js&logoColor=white)
![WebSockets](https://img.shields.io/badge/transport-WebSockets-blue)
![RabbitMQ](https://img.shields.io/badge/queue-RabbitMQ-FF6600?logo=rabbitmq&logoColor=white)
![vLLM](https://img.shields.io/badge/LLM%20serving-vLLM-5A2D81)
![GPU](https://img.shields.io/badge/GPU-12GB%20VRAM-76B900?logo=nvidia&logoColor=white)

A full **speech-to-speech** voice assistant: the browser streams raw mic audio to a Node.js
WebSocket orchestrator, which segments speech with **VAD** and runs each utterance through
**STT → LLM → TTS**, then streams synthesized audio back over the same connection — all on a
single **12 GB** GPU.

The interesting part is the **architecture evolution**: a monolithic, lock-serialized GPU pipeline
(V1) was re-architected into **queue-backed worker services** behind RabbitMQ with **vLLM** serving
the LLM (V2) — letting STT/TTS scale independently and cutting latency under load by **>50%**.

### ⚡ Results at a glance

Median end-to-end latency (end-of-upload → first audio reply), measured with the included benchmark
harness ([`benchmarks/`](benchmarks/)):

| Concurrent users | V1 (monolith) | V2 (queue + vLLM) | Improvement |
| ---: | ---: | ---: | ---: |
| 1 | 2192 ms | 1447 ms | **34% faster** |
| 5 | 7006 ms | 3271 ms | **53% faster** |
| 10 | 11627 ms | 5318 ms | **54% faster** |

### Highlights

- **Streaming voice loop** over a single WebSocket — VAD-gated STT → LLM → TTS → audio back.
- **Queue-backed inference** (RabbitMQ `stt.jobs` / `tts.jobs` + reply queues, matched by `correlationId`).
- **vLLM** serving the LLM via an OpenAI-compatible API; STT (Canary) and TTS (Kokoro) as dedicated GPU workers.
- **Designed for one GPU PC** — bounded queues, one worker per heavy model, no duplicate model copies.
- **Reproducible benchmarks** at 1/5/10 concurrency with per-stage (STT/LLM/TTS) compute-vs-wait timing.

## Current Goal

The project is transitioning from a single monolithic GPU processing service
to a queue-backed V2 architecture that can use one GPU PC more efficiently
today and scale into service pools later.

The current local target machine is intentionally modest:

- NVIDIA GPU with 12 GB VRAM
- 16 GB system RAM
- AMD CPU
- RabbitMQ, STT worker, TTS worker, and vLLM running on the GPU PC
- Node orchestrator may run on the same machine or another machine on the LAN

The main rule for this machine is simple: do not create multiple heavy GPU model
copies. Use one worker per heavy model, bounded queues, and vLLM's internal LLM
scheduler.

## Architecture Overview

### V1: Monolithic Processing Engine

V1 used one FastAPI processing service for the whole voice turn:

```text
Browser Client
  -> Node Orchestrator
  -> Processing Engine /voice-chat
     -> STT
     -> LLM
     -> TTS
  -> WAV response
```

The processing engine loaded all models on startup:

- STT: NVIDIA Canary / SALM
- LLM: Llama 3.2 via Transformers, loaded in 4-bit
- TTS: Kokoro

This was a good first version because it proved end-to-end voice interaction.
The tradeoff was concurrency. Each model stage was protected by locks, so
concurrent users queued behind a single sequential pipeline.

### V2: Queue-Backed Services + vLLM

V2 separates model execution into stage-specific services:

```text
Browser Client
  |
  | PCM16 audio over WebSocket
  v
Node Orchestrator
  |
  | complete WAV utterance
  v
RabbitMQ stt.jobs
  |
  v
STT Worker
  |
  | transcript reply
  v
orchestrator.replies
  |
  v
Node Orchestrator
  |
  | chat completion request
  v
vLLM Server
  |
  | assistant text
  v
Node Orchestrator
  |
  | text to synthesize
  v
RabbitMQ tts.jobs
  |
  v
TTS Worker
  |
  | WAV reply
  v
orchestrator.replies
  |
  v
Node Orchestrator
  |
  | WAV/audio over WebSocket
  v
Browser Client
```

In V2:

- `stt.jobs` is a RabbitMQ request queue for STT work.
- `tts.jobs` is a RabbitMQ request queue for TTS work.
- `orchestrator.replies.<instanceId>` is a temporary reply queue consumed by
  the orchestrator instance that sent the request.
- The orchestrator uses `correlationId` to match worker replies to the active
  voice turn.
- vLLM serves the LLM through an OpenAI-compatible HTTP API.

For the current 12 GB VRAM machine, the worker pool size is intentionally one:

```text
stt.jobs -> STT worker 1
tts.jobs -> TTS worker 1
vLLM     -> one LLM server
```

Later, the same queue contract can scale out:

```text
stt.jobs -> STT worker 1
         -> STT worker 2
         -> STT worker 3
```

## Repository Layout

```text
client/
  Browser client that captures microphone audio and plays returned WAV audio.

orchestrator-service/
  Node.js + TypeScript WebSocket server.
  Owns sessions, VAD endpointing, RabbitMQ RPC, vLLM calls, and client replies.

processing-engine/
  V1 FastAPI processing engine plus V2 STT/TTS worker code.
  The monolithic /voice-chat path is kept for comparison and rollback.

benchmarks/
  WebSocket benchmark harness, fixed sample audio, and V1/V2 benchmark CSVs.
```

## Runtime Components

### Node Orchestrator

Responsibilities:

- Accept WebSocket audio from the browser.
- Re-frame PCM audio into 100 ms VAD frames.
- Detect speech start and speech end.
- Publish STT jobs to RabbitMQ.
- Call vLLM for LLM inference.
- Publish TTS jobs to RabbitMQ.
- Send WAV audio replies back to the browser.

Important files:

- `orchestrator-service/src/index.ts`
- `orchestrator-service/src/session/sessionManager.ts`
- `orchestrator-service/src/vad/speechDetector.ts`
- `orchestrator-service/src/pipeline/voicePipeline.ts`
- `orchestrator-service/src/messaging/rabbitRpcClient.ts`
- `orchestrator-service/src/pipeline/vllmClient.ts`

### RabbitMQ

RabbitMQ provides bounded job queues and backpressure between the orchestrator
and model workers.

Queues:

```text
stt.jobs
tts.jobs
orchestrator.replies.<instanceId>
```

`stt.jobs` and `tts.jobs` are durable shared queues. Reply queues are exclusive,
auto-delete queues owned by a single orchestrator instance.

### STT Worker

The STT worker loads the STT model once, consumes `stt.jobs`, transcribes WAV
audio, and publishes JSON transcript replies.

File:

```text
processing-engine/app/workers/stt-worker.py
```

Current model default:

```text
nvidia/canary-qwen-2.5b
```

### vLLM Server

vLLM replaces the old in-process Transformers LLM path. It owns LLM scheduling,
KV cache management, and request batching.

Current practical model for the 12 GB VRAM machine:

```text
Qwen/Qwen2.5-0.5B-Instruct
```

The previous Llama 3.2 1B model can work, but it is gated and heavier when
served by vLLM in bf16. The old V1 LLM path used 4-bit quantization, so the
raw vLLM memory profile is not identical.

### TTS Worker

The TTS worker loads Kokoro once, consumes `tts.jobs`, synthesizes audio, and
publishes WAV bytes back to the orchestrator reply queue.

File:

```text
processing-engine/app/workers/tts-worker.py
```

Current TTS default:

```text
Kokoro-82M
```

## Setup

### 1. Start RabbitMQ On The GPU PC

```bash
docker run -d \
  --name voiceai-rabbitmq \
  --hostname voiceai-rabbitmq \
  -e RABBITMQ_DEFAULT_USER=voiceai \
  -e RABBITMQ_DEFAULT_PASS=voiceai_password \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:4-management
```

Dashboard:

```text
http://<GPU_PC_IP>:15672
```

AMQP URL:

```text
amqp://voiceai:voiceai_password@<GPU_PC_IP>:5672
```

### 2. Start vLLM On The GPU PC

For the current machine, start with a small model and conservative GPU memory:

```bash
docker rm -f voiceai-vllm

docker run -d \
  --name voiceai-vllm \
  --runtime nvidia \
  --gpus all \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -p 8000:8000 \
  --ipc=host \
  vllm/vllm-openai:latest \
  Qwen/Qwen2.5-0.5B-Instruct \
  --host 0.0.0.0 \
  --port 8000 \
  --gpu-memory-utilization 0.20 \
  --max-model-len 2048 \
  --max-num-seqs 1 \
  --max-num-batched-tokens 512
```

Check readiness:

```bash
curl http://127.0.0.1:8000/v1/models
```

Test generation:

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-0.5B-Instruct",
    "messages": [
      { "role": "user", "content": "Say hello in one short sentence." }
    ],
    "max_tokens": 32
  }'
```

### 3. Start STT Worker On The GPU PC

```bash
cd processing-engine

RABBITMQ_URL="amqp://voiceai:voiceai_password@127.0.0.1:5672" \
HF_HOME="$PWD/models/huggingface" \
TRANSFORMERS_CACHE="$PWD/models/huggingface" \
NEMO_CACHE_DIR="$PWD/models/nemo" \
PYTHONPATH=. \
python3 app/workers/stt-worker.py
```

If the machine has only 16 GB RAM and the process is killed during model load,
stop vLLM, load STT alone, and consider adding swap or using a smaller STT
model. A plain `Killed` message without a Python traceback usually means the
Linux OOM killer terminated the process.

### 4. Start TTS Worker On The GPU PC

```bash
cd processing-engine

RABBITMQ_URL="amqp://voiceai:voiceai_password@127.0.0.1:5672" \
PYTHONPATH=. \
python3 app/workers/tts-worker.py
```

### 5. Start The Orchestrator

```bash
cd orchestrator-service
npm install
npm run dev
```

Example `.env`:

```env
PORT=3000
RABBITMQ_URL=amqp://voiceai:voiceai_password@<GPU_PC_IP>:5672
VLLM_BASE_URL=http://<GPU_PC_IP>:8000
VLLM_MODEL_ID=Qwen/Qwen2.5-0.5B-Instruct
STAGE_TIMEOUT_MS=30000
```

If the orchestrator runs on the GPU PC, `127.0.0.1` can be used for RabbitMQ
and vLLM. If it runs on another machine, use the GPU PC LAN IP.

### 6. Open The Client

Open:

```text
client/index.html
```

The browser sends PCM16, 16 kHz, mono audio over WebSocket to:

```text
ws://<ORCHESTRATOR_HOST>:3000/ws/audio
```

## Benchmarking

The benchmark harness simulates browser clients over WebSocket. It sends the
same fixed WAV sample and waits for the first binary WAV reply.

```bash
cd benchmarks
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

python bench.py \
  --url ws://localhost:3000/ws/audio \
  --wav sample.wav \
  --levels 1,5,10 \
  --timeout 180 \
  --csv v2_bench.csv \
  --label split-rabbit-vllm
```

Existing benchmark files:

```text
benchmarks/v1_bench.csv
benchmarks/v2_bench.csv
```

### Benchmark Results

Latency is measured from end-of-upload to first audio reply.

| Concurrent users | V1 median latency | V2 median latency | Improvement |
| ---: | ---: | ---: | ---: |
| 1 | 2192 ms | 1447 ms | 34.0% faster |
| 5 | 7006 ms | 3271 ms | 53.3% faster |
| 10 | 11627 ms | 5318 ms | 54.3% faster |

Detailed V2 run:

| Concurrent users | Success | Median | Mean | p95 | Max | Throughput |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 | 1447 ms | 1447 ms | 1447 ms | 1447 ms | 0.69 replies/sec |
| 5 | 5/5 | 3271 ms | 3310 ms | 4358 ms | 4574 ms | 1.09 replies/sec |
| 10 | 10/10 | 5318 ms | 5474 ms | 8129 ms | 8342 ms | 1.19 replies/sec |

The improvement is strongest under concurrency because V2 removes the single
monolithic voice-turn bottleneck and lets STT/TTS queue independently while
vLLM handles LLM serving.

## V1 To V2 Transition Status

Completed:

- RabbitMQ request/reply path added for STT and TTS.
- STT worker consumes `stt.jobs`.
- TTS worker consumes `tts.jobs`.
- Orchestrator now owns the voice turn workflow.
- vLLM is used for LLM inference through `/v1/chat/completions`.
- Browser client receives the final WAV reply through the existing WebSocket.
- V2 benchmark completed successfully at 1, 5, and 10 concurrent users.

Still kept for rollback:

- V1 FastAPI processing engine files.
- Old `/voice-chat` route and monolithic STT -> LLM -> TTS pipeline.

Next steps:

- Add per-stage timing logs for V2: STT queue wait, STT compute, LLM latency,
  TTS queue wait, TTS compute, total turn time.
- Add stale-turn cancellation so older turns are dropped when the user speaks
  again.
- Add queue max length and tighter TTLs for live audio jobs.
- Rename worker files from `stt-worker.py` / `tts-worker.py` to Python module
  friendly names if we want to run them with `python -m`.
- Evaluate smaller STT models for the 12 GB VRAM machine.
- Add health endpoints or heartbeat logs for workers.
- Add service scripts or Compose files once the single-machine flow is stable.

## Operational Notes

- `stt.jobs` and `tts.jobs` should be durable queues on RabbitMQ 4.
- Reply queues should be exclusive and auto-delete.
- TTS replies must be valid WAV bytes. The orchestrator checks the `RIFF/WAVE`
  header before sending audio to the browser.
- Avoid sending JSON error payloads to the browser as audio.
- Keep `STT_PREFETCH=1` and `TTS_PREFETCH=1` on the current GPU PC.
- Start with small vLLM limits on 12 GB VRAM and increase only after checking
  `nvidia-smi`.
- The LLM can answer stale factual questions if it has no fresh context. Add
  current-date prompting or retrieval/tooling before treating factual answers
  as authoritative.

## Troubleshooting

### RabbitMQ rejects transient queues

RabbitMQ 4 rejects shared non-durable, non-exclusive queues by default. Use
durable queues for `stt.jobs` and `tts.jobs`.

```text
stt.jobs: durable=true
tts.jobs: durable=true
reply queues: exclusive=true, autoDelete=true
```

### STT gets queued and nothing happens

Check consumers:

```bash
docker exec -it voiceai-rabbitmq rabbitmqctl list_queues \
  name messages_ready messages_unacknowledged consumers durable
```

If `stt.jobs` has `consumers=0`, the STT worker is not connected.

### STT worker cannot import app modules

Run with `PYTHONPATH=.` from `processing-engine`:

```bash
PYTHONPATH=. python3 app/workers/stt-worker.py
```

### Hugging Face cache permission errors

Use project-local caches:

```bash
HF_HOME="$PWD/models/huggingface" \
TRANSFORMERS_CACHE="$PWD/models/huggingface" \
NEMO_CACHE_DIR="$PWD/models/nemo"
```

### Process prints `Killed`

This is usually the Linux OOM killer. Stop vLLM, load STT alone, check memory,
and consider adding swap:

```bash
free -h
nvidia-smi
dmesg -T | grep -i -E "killed process|out of memory|oom" | tail -20
```

### Browser cannot play AI audio

The browser likely received non-WAV bytes. Check the orchestrator log for:

```text
TTS returned non-WAV
```

Then inspect the TTS worker error. A valid WAV reply starts with:

```text
RIFF....WAVE
```
