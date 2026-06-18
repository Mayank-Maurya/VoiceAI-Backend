# Roadmap — Making the Voice Agent Feel Real

> Status: planning. Created 2026-06-18.
> Goal: make VoiceAI-Backend (V3 streaming) feel genuinely real-time and human.
> Scope of this doc: turn-taking, understanding, and memory. Voice timbre (TTS
> naturalness) is explicitly deferred to the end.

## The three problems (user-reported)

1. **Turn detection** — it doesn't stop exactly when the user finishes speaking.
   It both **cuts off too early** (e.g. finalized "capital of" before "US") and
   **lags** (finalization was bound to a 700 ms polling tick).
2. **STT context capture** — longer / more complex utterances aren't captured
   fully or accurately (windowed partials, early finalization, `beam_size=1`).
3. **Conversation memory** — weak use of recent-turn context, so replies feel
   disconnected and don't really answer. Worsened by the tiny Qwen2.5-0.5B LLM
   and by history being polluted with truncated transcripts.

## Why the order matters (root-cause chain)

These problems are not independent — they cascade:

```
bad turn detection
      │  (truncated / partial utterance)
      ▼
STT emits an incomplete transcript
      │  (garbage in)
      ▼
LLM gets bad input  ──►  bad answer
      │
      ▼
history is polluted with garbage  ──►  later answers get worse
```

So we fix **upstream first**. Each phase cleans the input to the next.

## Current relevant architecture (what we're changing)

```
Browser ──PCM16 100ms frames──► Orchestrator (Node)
                                   │  energy gate (RMS): forward voiced frames,
                                   │  send {silence:true} after 2 quiet frames
                                   ▼
                                 STT service (faster-whisper, WS :7003)
                                   │  transcribe loop every 700ms;
                                   │  finalize when stable 300ms + silence
                                   ▼
                                 final transcript ──► Orchestrator
                                   │  push to 10-turn history
                                   ▼
                                 vLLM (Qwen2.5-0.5B, SSE) ──► tokens
                                   │  sentence buffer (waits for ". ")
                                   ▼
                                 TTS service (Kokoro, HTTP :7002) ──► PCM16
                                   ▼
                                 Browser (AudioWorklet ring buffer)
```

Key files:
- Endpointing (energy gate): `orchestrator-service/src/vad/speechDetector.ts`
- STT finalization: `processing-engine/stt_service.py`
- STT model: `processing-engine/app/models/stt.py`
- Turn pipeline + history: `orchestrator-service/src/pipeline/voicePipeline.ts`
- Session/history state: `orchestrator-service/src/types/session.ts`

---

## Phase 0 — Measure the right thing  (½ day · foundation)

You can't tune turn-taking without seeing it. The current benchmark measures
`end-of-upload → audio`, which **hides** the endpointing delay we actually feel.

- Add timing in `stt_service.py`: **last-voiced-frame → final-emitted**.
- Add timing in `voicePipeline.ts`: **final-received → first-audio-sent**.
- Log the real perceived metric: **end-of-speech → first audio**.

**Done when:** every turn logs a perceived-latency number we can compare across phases.

## Phase 1 — Fix the endpointing mechanics  (1 day · pure code)

Make the existing logic stop lagging and stop truncating, before adding a model.

- **Event-driven finalize:** trigger finalization immediately when the silence
  signal arrives and the transcript is stable, instead of waiting for the next
  700 ms tick. (Removes up to ~700 ms.)
- **Guarantee the final transcript is the full utterance:** always do a
  full-buffer pass at finalize; add a small trailing-audio pad so the last word
  isn't clipped. (Fixes the "capital of" → missing "US" bug.)
- **Tune the pair** `SILENCE_FRAMES_TO_SIGNAL` (energy gate) and
  `STABLE_DURATION` (STT) against the Phase 0 metric.

**Done when:** it stops within ~300–500 ms of the user finishing, and short
answers are never truncated.

## Phase 2 — Semantic turn detection  (2–3 days · the real fix)

Silence alone can't distinguish *"the capital of…"* (unfinished — keep listening)
from *"what's the capital of France?"* (done — answer now). This is the change
that makes turn-taking feel human; it's what Retell / Vapi / LiveKit use.

- Integrate **Smart Turn v2** (Pipecat, open-source, ONNX, audio-based, tens of
  ms) — or LiveKit's text-based turn detector as the alternative.
- New flow in `stt_service.py`: silence detected → run the turn model on recent
  audio → **complete** ⇒ finalize fast; **incomplete** ⇒ extend the grace window
  and keep listening.

**Done when:** the user can pause mid-thought without being interrupted, and the
agent responds quickly once a thought is actually finished.

## Phase 3 — STT accuracy / full context capture  (1 day)

So that "when I say that much," it captures all of it correctly.

- On the **final** pass, raise `beam_size` (1 → 5) for accuracy — one pass per
  turn, latency cost is acceptable.
- Re-check the partial window so long utterances don't lose their head.
- Optionally evaluate `large-v3` int8 (VRAM is available) vs `medium` on the
  user's own speech.

**Done when:** long, complex sentences transcribe accurately end-to-end.

## Phase 4 — LLM upgrade + memory hardening  (1–2 days · fixes "not answering")

Where contextual, relevant answers come from. Qwen-0.5B is the main reason
replies feel disconnected.

- **Upgrade the model** to a 3B-class instruct model (Qwen2.5-3B / Llama-3.2-3B);
  ~7 GB VRAM is free. Biggest jump in answer quality and context use.
- **Stop polluting history:** only commit a turn after clean endpointing (no
  empty/truncated transcripts).
- **Verify history wiring** in `session.ts` / `voicePipeline.ts` carries the last
  N turns; tune the system prompt for conversational continuity.
- Optional: rolling summary for long conversations.

**Done when:** it correctly answers follow-ups that depend on something said two
turns earlier.

## Phase 5 — Naturalness polish  (later · deferred)

Voice timbre / prosody: Kokoro ceiling, crossfade chunk boundaries, first-clause
TTS. Deferred per decision — understanding and turn-taking come first.

---

## Recommended sequence

1. **First push:** Phase 0 → 1 → 2. Directly kills "it doesn't stop when I'm
   done"; this is the core of feeling real. Phase 2 is the centerpiece; 0–1 make
   it measurable and stop the bleeding cheaply first.
2. **Second push:** Phase 3 → 4. Makes it understand and actually answer well.
3. **Later:** Phase 5 (voice quality).

## Guiding metric

Optimize **end-of-speech → first audio** (perceived latency), not
`TTFA-from-upload`. Target: well under ~500 ms for the agent to start replying,
with turn detection that doesn't cut the user off.
