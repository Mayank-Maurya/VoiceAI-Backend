import crypto from "node:crypto";
import type { ClientSession, ChatMessage } from "../types/session";
import { LLM_SYSTEM_PROMPT, TTS_STREAM_URL } from "../config";
import { streamLlmResponse } from "./vllmClient";
import { sentenceBuffer } from "./sentenceBuffer";

const MAX_HISTORY_TURNS = 10;

// Map a detected user emotion to a spoken tone tag for emotion-capable TTS
// (rumik). Mirror positive energy; soften negatives to a calm, empathetic voice.
// Providers that don't support tags simply ignore it.
function mapEmotionToTone(emotion?: string): string | undefined {
    if (!emotion) return undefined;
    switch (emotion.toLowerCase()) {
        case "happy": return "happy";
        case "excited":
        case "surprised": return "excited";
        case "sad":
        case "angry":
        case "frustrated":
        case "fearful":
        case "disgust": return "calm";
        case "neutral":
        case "calm": return "neutral";
        default: return undefined;
    }
}

export function cancelCurrentTurn(session: ClientSession): void {
    if (session.turnAbort) {
        session.turnAbort.abort();
        session.turnAbort = null;
    }

    if (session.socket.readyState === session.socket.OPEN) {
        session.socket.send(JSON.stringify({ type: "audio_cancel" }));
    }
}

export async function streamTurnToClient(
    session: ClientSession,
    userText: string,
    emotion?: string,
): Promise<void> {
    // Guard: never barge-in over a live reply or commit an empty turn to history.
    if (!userText || !userText.trim()) {
        return;
    }

    if (session.turnAbort) {
        cancelCurrentTurn(session);
    }

    const abort = new AbortController();
    session.turnAbort = abort;

    const turnId = crypto.randomUUID();
    const startedAt = Date.now();
    // Snapshot when the user actually stopped speaking (last voiced frame),
    // captured now so a later barge-in frame can't move the reference.
    const speechEndedAt = session.lastVoiceAt;
    let firstSentenceAt: number | null = null;
    let firstAudioAt: number | null = null;
    let sentenceCount = 0;
    let audioStartSent = false;
    let fullResponse = "";

    session.history.push({ role: "user", content: userText });

    const messages: ChatMessage[] = [
        { role: "system", content: LLM_SYSTEM_PROMPT },
        ...session.history.slice(-MAX_HISTORY_TURNS * 2),
    ];

    // Annotate ONLY this turn's copy with the detected tone — a fresh object so
    // the stored history stays clean (no emotion tags accumulating in memory).
    if (emotion) {
        messages[messages.length - 1] = {
            role: "user",
            content: `${userText}\n\n[The user sounds ${emotion}. Respond with fitting empathy; do not mention that you detected their tone.]`,
        };
    }

    const sendAudioStart = () => {
        if (audioStartSent || abort.signal.aborted) return;
        audioStartSent = true;
        if (session.socket.readyState === session.socket.OPEN) {
            session.socket.send(JSON.stringify({
                type: "audio_start",
                sampleRate: 24000,
                turnId,
            }));
        }
    };

    const tone = mapEmotionToTone(emotion);

    console.log(`[${session.id}] turn=${turnId} streaming LLM+TTS for: "${userText}"`);

    try {
        for await (const sentence of sentenceBuffer(streamLlmResponse(messages, abort.signal))) {
            if (abort.signal.aborted) break;

            sentenceCount++;
            fullResponse += (fullResponse ? " " : "") + sentence;

            if (firstSentenceAt === null) {
                firstSentenceAt = Date.now();
            }
            console.log(`[${session.id}] turn=${turnId} TTS sentence ${sentenceCount}: "${sentence}"`);

            await streamTtsToClient(session, sentence, tone, abort.signal, () => {
                sendAudioStart();
                if (firstAudioAt === null) {
                    firstAudioAt = Date.now();
                }
            });
        }
    } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
            console.log(`[${session.id}] turn=${turnId} interrupted (barge-in)`);
        } else {
            throw err;
        }
    }

    if (fullResponse) {
        session.history.push({ role: "assistant", content: fullResponse });
    }

    if (audioStartSent && !abort.signal.aborted && session.socket.readyState === session.socket.OPEN) {
        session.socket.send(JSON.stringify({ type: "audio_end", turnId }));
    }

    if (session.turnAbort === abort) {
        session.turnAbort = null;
    }

    const totalMs = Date.now() - startedAt;
    const ttfsMs = firstSentenceAt ? firstSentenceAt - startedAt : 0;
    const ttfaMs = firstAudioAt ? firstAudioAt - startedAt : 0;

    // Perceived latency: speech-end -> first audio = endpointing + response.
    //   endpoint = speech-end -> final transcript received (the STT lag)
    //   response = final transcript -> first audio byte (LLM + TTS)
    const endpointMs = speechEndedAt ? startedAt - speechEndedAt : 0;
    const perceivedMs = firstAudioAt && speechEndedAt ? firstAudioAt - speechEndedAt : 0;

    console.log(
        `[${session.id}] turn=${turnId} complete | ` +
        `PERCEIVED=${perceivedMs}ms (speech-end -> first audio) = ` +
        `endpoint=${endpointMs}ms + response=${ttfaMs}ms | ` +
        `TTFS=${ttfsMs}ms sentences=${sentenceCount} total=${totalMs}ms`
    );
}

async function streamTtsToClient(
    session: ClientSession,
    text: string,
    tone: string | undefined,
    signal: AbortSignal,
    onFirstChunk: () => void,
): Promise<void> {
    const response = await fetch(`${TTS_STREAM_URL}/tts/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, tone }),
        signal,
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`TTS stream failed: ${response.status} ${body}`);
    }

    if (!response.body) {
        throw new Error("TTS returned no response body");
    }

    const reader = response.body.getReader();
    let pending = Buffer.alloc(0);
    let isFirst = true;

    try {
        while (true) {
            if (signal.aborted) break;

            const { done, value } = await reader.read();
            if (done) break;

            pending = Buffer.concat([pending, Buffer.from(value)]);

            while (pending.length >= 4) {
                const chunkLen = pending.readUInt32LE(0);
                if (pending.length < 4 + chunkLen) break;

                const pcmChunk = pending.subarray(4, 4 + chunkLen);
                pending = pending.subarray(4 + chunkLen);

                if (isFirst) {
                    isFirst = false;
                    onFirstChunk();
                }

                if (session.socket.readyState === session.socket.OPEN) {
                    session.socket.send(pcmChunk);
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
