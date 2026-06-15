# Streaming Voice Pipeline — Remove VAD, Stream Everything

## Context

The current V2 architecture is batch/sequential: VAD collects a complete utterance (adding 300-800ms of dead silence), sends the full WAV to STT via RabbitMQ, waits for a complete transcript, sends it to vLLM (non-streaming), waits for a complete response, sends full text to TTS via RabbitMQ, waits for complete WAV, then sends it to the browser.

Total latency at 1 user: **~1450ms** (plus 500-800ms VAD hangover the benchmark doesn't measure because it blasts frames).

Goal: **sub-500ms TTFT** (time to first audio byte at the browser) by streaming all stages and overlapping them.

---

## Target Architecture

```
Browser PCM16 frames (100ms)
  |
  v
Node Orchestrator ──WS──> STT Service (faster-whisper medium, int8)
  <──WS── partial transcripts
  |
  | [utterance-complete heuristic: stable transcript + 300ms silence]
  v
vLLM SSE stream ──> token by token
  |
  | [sentence buffer: accumulate until ". " or "? " or "! " or 150+ chars]
  v
POST /tts/stream ──> TTS Service (Kokoro-82M)
  <── streaming PCM16 chunks
  |
  v
Browser WebSocket ──> WebAudio jitter buffer ──> speaker
```

Key insight: stages overlap. STT runs continuously while user speaks. LLM starts on first final transcript. TTS starts on first complete sentence from LLM. Browser plays first audio chunk while LLM/TTS are still generating the rest.

---

## Decisions Made

- **STT model**: faster-whisper `medium` in int8 (~0.8GB VRAM). Replaces Canary/SALM which can't stream.
- **Transport**: Separate processes for STT and TTS. Each gets its own HTTP/WS server (no more RabbitMQ on the hot path). RabbitMQ stays in the codebase for future horizontal scaling.
- **LLM**: Same vLLM + Qwen-0.5B, just enable `stream: true`.
- **TTS**: Same Kokoro-82M, new streaming HTTP endpoint.
- **Browser**: WebAudio API with jitter buffer replaces Blob URL + `new Audio()`.

VRAM budget: ~0.8GB (STT) + ~0.2GB (TTS) + ~1GB (vLLM) = **~2GB** of 12GB used.

---

## Phase 1: LLM Streaming + Sentence Buffer

**Goal**: Stream vLLM tokens and split into sentences. Still uses batch STT/TTS — just proves the LLM streaming path.

### Changes

**`orchestrator-service/src/pipeline/vllmClient.ts`**
- Keep existing `generateLlmResponse()` for backward compat
- Add `streamLlmResponse(userText: string): AsyncGenerator<string>` that:
  - Sends `stream: true` in the request body
  - Reads `response.body` as a Node.js ReadableStream
  - Parses SSE lines (`data: {...}`)
  - Yields `choices[0].delta.content` tokens
  - Handles `data: [DONE]`

**`orchestrator-service/src/pipeline/sentenceBuffer.ts`** (new file)
- Class `SentenceBuffer` that accumulates tokens and emits complete sentences
- Emits at: `. `, `? `, `! `, or after 150 chars without punctuation (flush timeout)
- Returns `AsyncGenerator<string>` of sentences

**`orchestrator-service/src/pipeline/voicePipeline.ts`**
- Phase 1 only: collect all sentences from the LLM stream, join them, pass to TTS via RabbitMQ as before
- Add timing: log time-to-first-LLM-token vs total LLM time

### Benchmark
- Compare: old total LLM time vs new time-to-first-token
- No end-to-end improvement yet (TTS still waits for full text), but proves the streaming infra

---

## Phase 2: TTS Streaming (new HTTP service, streaming audio to browser)

**Goal**: Kokoro yields audio chunks as they're generated. Stream them to the browser immediately.

### Changes

**`processing-engine/app/models/tts.py`**
- Add `generate_audio_chunks(text: str) -> Generator[bytes, None, None]` that yields raw PCM16 bytes per Kokoro chunk (instead of concatenating into one WAV)

**New file: `processing-engine/tts_service.py`** (separate FastAPI process)
- `POST /tts/stream` — accepts `{"text": "...", "sampleRate": 24000}`
- Returns `StreamingResponse` of length-prefixed PCM16 chunks
- Each chunk: `4-byte LE uint32 length` + `PCM16 bytes`
- Loads Kokoro on startup, processes one request at a time (asyncio.Lock for GPU)

**`orchestrator-service/src/pipeline/voicePipeline.ts`** (rewrite for streaming)
- New function `runStreamingPipeline(session, transcript)`:
  1. Start LLM stream via `streamLlmResponse()`
  2. Feed tokens into `SentenceBuffer`
  3. For each complete sentence, fire `fetch(TTS_STREAM_URL, {body: sentence})` 
  4. Read TTS response stream, forward each PCM chunk to `session.socket.send(chunk)` as binary
  5. Send JSON control messages: `{"type":"audio_start","sampleRate":24000}` before first chunk, `{"type":"audio_end"}` after last
  6. Maintain sentence ordering (sentence N+1 audio waits until sentence N audio is fully sent)

**`orchestrator-service/src/config.ts`**
- Add `TTS_STREAM_URL` (default `http://192.168.1.9:7002`)

**`client/app.js`** — streaming audio playback
- New `StreamingPlayer` class using WebAudio API:
  - Creates `AudioContext` at Kokoro's output sample rate (24kHz)
  - Uses `AudioWorkletNode` for gapless playback from a ring buffer
  - On `audio_start` JSON message: initialize playback context
  - On binary frames: decode PCM16 to Float32, push into ring buffer
  - On `audio_end`: drain buffer, then restore "listening" state
  - 200ms pre-buffer before playback starts (prevents underruns)
- Modify `handleSocketMessage()` to detect JSON control messages vs binary audio chunks

**`client/audio-playback-worklet.js`** (new file)
- AudioWorklet processor that pulls from a SharedArrayBuffer ring buffer
- Outputs silence when buffer is empty (graceful underrun)

### Benchmark
- Measure TTFT: time from transcript ready to first audio byte at browser
- Should see major improvement since TTS streams first sentence while LLM generates second

---

## Phase 3: STT Streaming (replace Canary, remove VAD gating)

**Goal**: Audio flows continuously to STT. No VAD silence wait. Utterance completion detected by transcript stability + short silence.

### Changes

**`processing-engine/app/models/stt.py`** (rewrite)
- Replace `SttRuntime` with `StreamingSttRuntime`:
  - Loads `faster_whisper.WhisperModel("medium", device="cuda", compute_type="int8")`
  - Method `transcribe_buffer(audio_np: np.ndarray) -> str` — transcribes accumulated audio
  - No file I/O — works directly on numpy arrays

**New file: `processing-engine/stt_service.py`** (separate FastAPI + WebSocket process)
- WebSocket endpoint `GET /ws/stt`:
  - Receives binary PCM16 frames from the orchestrator
  - Accumulates frames in a numpy buffer
  - Every 500ms (or when triggered by silence signal), runs `transcribe_buffer()` on accumulated audio
  - Sends JSON back: `{"text": "hello how are", "is_final": false}` (partial) or `{"text": "hello how are you?", "is_final": true}` (final)
  - Final detection heuristic: transcript unchanged for 300ms AND (ends with sentence punctuation OR orchestrator sent a `{"silence": true}` signal)
- Load model on startup, `asyncio.Lock` for GPU access

**`orchestrator-service/src/vad/speechDetector.ts`** (simplify to energy gate)
- Remove VAD model (`node-vad`) entirely
- Keep only RMS energy check: if frame energy > threshold, forward to STT WebSocket
- Send `{"silence": true}` JSON to STT WebSocket after 200ms of low-energy frames
- No more utterance buffering, no speech start/end state machine

**`orchestrator-service/src/session/sessionManager.ts`**
- On connection: open a WebSocket to `ws://<STT_SERVICE>/ws/stt`
- Add `sttSocket` to `ClientSession`
- On each audio frame from browser: forward to `sttSocket` if energy passes threshold
- On STT `is_final` message: trigger `runStreamingPipeline(session, text)`
- On disconnect: close `sttSocket`

**`orchestrator-service/src/types/session.ts`**
- Add to `ClientSession`: `sttSocket: WebSocket | null`, `currentTranscript: string`, `lastTranscriptAt: number`
- Remove: `vad`, `vadWork`, `isSpeaking`, `utteranceBuffer`, `speechFrames`, `silenceFrames`, `voiceFrameCount` (all VAD state)

**`orchestrator-service/src/config.ts`**
- Add `STT_WS_URL` (default `ws://192.168.1.9:7003`)
- Remove/deprecate: `VAD_MODE`, `SPEECH_END_SILENCE_FRAMES`, `SPEECH_START_FRAMES`, `MIN_SPEECH_FRAMES`, `SHORT_UTTERANCE_*`, `LONG_UTTERANCE_*`

**`processing-engine/requirements.txt`**
- Add `faster-whisper`
- Can remove `nemo_toolkit[asr]` (saves a huge dependency tree)

### Benchmark
- Measure: user finishes speaking -> first audio byte at browser
- This is the full TTFT metric. Target: sub-500ms

---

## Phase 4: Integration, Barge-in, Cleanup

**Goal**: Polish the streaming pipeline, add interruption support, clean up dead code.

### Changes
- **Barge-in**: When user speaks while AI audio is streaming, cancel LLM stream (abort controller) + stop TTS requests + send `{"type":"audio_cancel"}` to browser
- **Conversation history**: Add `messages[]` to `ClientSession`, append each turn, cap at last 10 turns, pass full history to vLLM
- **Remove dead code**: RabbitMQ workers (`stt-worker.py`, `tts-worker.py`), `rabbitRpcClient.ts`, old `voicePipeline.ts` batch path, `node-vad` dependency
- **Update benchmark**: Modify `bench.py` to measure TTFT (time to first binary WS frame) in addition to total latency
- **Docker compose**: Add compose file for STT service, TTS service, vLLM

---

## Verification Plan

After each phase:
1. Run `benchmarks/bench.py` with `--levels 1,5,10` and compare to V2 baseline
2. Check orchestrator logs for per-stage timings (`STT=Xms LLM=Xms TTS=Xms`)
3. Test manually with the browser client — speak, verify audio plays back
4. Check `nvidia-smi` to confirm VRAM usage is within budget
5. After Phase 3: measure true TTFT (add timing to bench.py for first binary frame)

## Implementation Order

Phase 1 first (LLM streaming) — smallest change, proves streaming infra.
Then Phase 2 (TTS streaming) — biggest latency win, first time browser gets streaming audio.
Then Phase 3 (STT streaming) — removes VAD, completes the streaming pipeline.
Phase 4 last — cleanup and polish.