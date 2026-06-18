# Voice AI Backend: System Architecture & Agent Configuration

## 1. What We Are Building
A highly concurrent, low-latency Voice AI system: a thin browser client streams raw mic audio over a persistent WebSocket to a Node.js orchestrator, which runs a **fully streaming** speech-to-speech pipeline (streaming STT → streaming LLM → streaming TTS) and streams synthesized audio back. The frontend is a pass-through (capture + playback); all coordination lives in the orchestrator and the GPU inference services.

## 2. Why We Are Building It (north star)
The long-term ambition is enterprise-scale conversational AI — a design target of ~470B tokens/day (~5.4M tokens/sec). That target drives the *direction* (event-driven I/O, horizontally scalable stateless services, no synchronous REST on the hot path) but is **not** the current deployment. Today the system is a single-GPU prototype benchmarked on an RTX 3060 12GB. Build for that scaling direction, but do not assume scale-out infrastructure exists yet.

## 3. Current Architecture (V3 — what actually exists)

> ⚠️ Agents: this section is ground truth. Sections 2 and 6's "future target" stack is aspirational and **not implemented** — do not write code against it without being asked.

End-to-end flow of one turn:
```
Browser (PCM16 100ms frames)
  → Orchestrator (Node): energy gate (RMS) forwards voiced frames, signals silence
    → STT service (faster-whisper, WebSocket :7003): partial + final transcripts
  → Orchestrator: push to 10-turn history, then stream the LLM
    → vLLM (Qwen2.5-0.5B-Instruct, OpenAI API :8000): token stream (SSE)
  → Orchestrator: sentence buffer emits complete sentences
    → TTS service (Kokoro-82M, HTTP :7002): length-prefixed PCM16 chunks
  → Browser: AudioWorklet ring buffer → speaker (gapless, supports barge-in)
```
The three "decision points" where realtime feel is won/lost: **(1) the energy gate**, **(2) the STT finalize heuristic**, **(3) the sentence buffer**. See `docs/realtime-voice-roadmap.md` for the active plan to improve turn detection, context capture, and memory.

**Current stack (real):**
- **Orchestrator:** Node.js + TypeScript, WebSocket (`ws`). Dependency-light on purpose — only `dotenv` + `ws`. RabbitMQ, `node-vad`, and `openai` were removed; do not reintroduce them without cause.
- **STT:** `faster-whisper` (CTranslate2) `medium` int8 on CUDA, streaming over WebSocket. `num_workers` for concurrency.
- **LLM:** vLLM, OpenAI-compatible API, continuous batching, `stream: true`.
- **TTS:** Kokoro-82M (PyTorch), streaming PCM16.
- **Transport:** WebSocket (browser↔orchestrator, orchestrator↔STT) and HTTP/SSE (orchestrator↔vLLM/TTS). No gRPC, no Kafka.
- **State:** in-memory per-session (`ClientSession`), including 10-turn conversation history. No Postgres/Redis yet.
- **Services run on the GPU PC** (`REMOTE_IP`); the orchestrator may run elsewhere on the LAN. Don't assume colocation.

**Future target stack (aspirational, NOT built):** Kafka for decoupling at scale, Postgres for durable session/user data, Redis for hot session state, gRPC for typed internal RPC, service replication behind a load balancer. Treat these as direction, not current dependencies.

## 4. Repo Layout & Key Files
- `orchestrator-service/` — Node hub. Hot files: `session/sessionManager.ts`, `vad/speechDetector.ts` (energy gate), `pipeline/voicePipeline.ts`, `pipeline/sentenceBuffer.ts`, `pipeline/vllmClient.ts`, `types/session.ts`.
- `processing-engine/` — GPU services: `stt_service.py`, `tts-service.py`, `app/models/{stt,tts}.py`, `app/config.py`.
- `client/` — browser client (`app.js`, `audio-playback-worklet.js`, `config.js`).
- `benchmarks/` — `bench.py` + CSVs (`v1_bench.csv`, `v2_bench.csv`, `results.csv`).
- `docs/realtime-voice-roadmap.md` — the current phased plan.

## 5. Global Agent Rules
*Apply to all coding/architecture work on this repo.*

- **The GPU is the bottleneck, not Node.** The orchestrator is I/O-bound and far from saturating a core. Optimize GPU contention (batching, concurrency, fewer redundant inferences) before touching the orchestrator for "performance."
- **Never block the Node event loop.** Offload CPU-heavy work; keep the audio path async and streaming. Don't accumulate whole utterances/responses in memory when you can stream.
- **Keep the orchestrator dependency-light.** Two runtime deps today (`dotenv`, `ws`). Justify any addition.
- **Stream, don't buffer-then-send.** STT, LLM, and TTS are all streaming; preserve the overlap (sentence N plays while N+1 is generated).
- **Respect the three decision points.** Changes to turn-taking belong in the energy gate (`speechDetector.ts`) and STT finalize (`stt_service.py`); changes to first-audio latency often belong in the sentence buffer.
- **Resilient I/O.** Network drops, malformed chunks, and disconnects are expected. Handle them gracefully; remove event listeners and close sockets to avoid leaks. Barge-in must always be able to abort an in-flight turn.
- **Measure the right metric.** Optimize **end-of-speech → first audio** (perceived latency), not `TTFA-from-upload`. Validate changes with `benchmarks/bench.py --realtime`.
- **Follow the roadmap.** Before architectural changes to turn detection / STT / memory, check `docs/realtime-voice-roadmap.md` and keep phases in order (fix upstream before downstream).

<claude-mem-context>
# Memory Context

# [VoiceAI-Backend] recent context, 2026-06-01 3:01pm GMT+5:30

No previous sessions found.
</claude-mem-context>