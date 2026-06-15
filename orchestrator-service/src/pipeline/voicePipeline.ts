import type { ClientSession } from "../types/session";
import {
    MIN_UTTERANCE_BYTES,
    SAMPLE_RATE,
    STAGE_TIMEOUT_MS,
    STT_JOBS_QUEUE,
    TTS_JOBS_QUEUE,
    TTS_STREAM_URL,
} from "../config";
import { generateWavHeader } from "../audio/wav";
import { rabbitRpcClient } from "../messaging/rabbitRpcClient";
import { generateLlmResponse, streamLlmResponse } from "./vllmClient";
import { sentenceBuffer } from "./sentenceBuffer";

type SttReply = {
    stage: "stt";
    text: string;
};

export async function runVoicePipeline(session: ClientSession, rawPcm: Buffer): Promise<void> {
    if (rawPcm.length < MIN_UTTERANCE_BYTES) {
        console.log(`[${session.id}] Audio too short, discarding.`);
        return;
    }

    const turnId = crypto.randomUUID();
    const startedAt = Date.now();

    try {
        const wavFile = Buffer.concat([generateWavHeader(rawPcm.length, SAMPLE_RATE), rawPcm]);

        console.log(`[${session.id}] turn=${turnId} STT queued`);

        const sttStart = Date.now();
        const sttReplyBuffer = await rabbitRpcClient.request(STT_JOBS_QUEUE, wavFile, {
            timeoutMs: STAGE_TIMEOUT_MS,
            contentType: "audio/wav",
            headers: {
                sessionId: session.id,
                turnId,
                sampleRate: SAMPLE_RATE,
            },
        });
        const sttMs = Date.now() - sttStart;

        const sttReply = JSON.parse(sttReplyBuffer.toString("utf8")) as SttReply;
        const userText = sttReply.text.trim();

        if (!userText) {
            console.log(`[${session.id}] turn=${turnId} Empty transcript`);
            return;
        }

        console.log(`[${session.id}] USER: ${userText}`);

        // ── LLM streaming → sentence buffer → TTS streaming → browser ──
        await streamTurnToClient(session, turnId, userText, sttMs, startedAt);
        
    } catch (error) {
        console.error(`[${session.id}] turn=${turnId} failed`, error);
    }
}

async function streamTurnToClient(
    session: ClientSession,
    turnId: string,
    userText: string,
    sttMs: number,
    startedAt: number
): Promise<void> {
    const llmStart = Date.now();
    let firstSentenceAt: number | null = null;
    let firstAudioAt: number | null = null;
    let sentenceCount = 0;
    let audioStartSent = false;

    // Send audio_start control message before first audio chunk.
    const sendAudioStart = () => {
        if (audioStartSent) return;
        audioStartSent = true;
        if (session.socket.readyState === session.socket.OPEN) {
            session.socket.send(JSON.stringify({
                type: "audio_start",
                sampleRate: 24000,
                turnId,
            }));
        }
    };


    for await(const sentence of sentenceBuffer(streamLlmResponse(userText))) {
        sentenceCount++;
        if (firstSentenceAt === null) {
            firstSentenceAt = Date.now();
        }
        console.log(`[${session.id}] turn=${turnId} TTS sentence ${sentenceCount}: "${sentence}"`);

        await streamTtsToClient(session, sentence, () => {
            sendAudioStart();
            if (firstAudioAt === null) {
                firstAudioAt = Date.now();
            }
        });
    }

    if (audioStartSent && session.socket.readyState === session.socket.OPEN) {
        session.socket.send(JSON.stringify({ type: "audio_end", turnId }));
    }

    const totalMs = Date.now() - startedAt;
    const ttfsMs = firstSentenceAt ? firstSentenceAt - llmStart : 0;
    const ttfaMs = firstAudioAt ? firstAudioAt - startedAt : 0;

    console.log(
        `[${session.id}] turn=${turnId} complete ` +
        `STT=${sttMs}ms TTFS=${ttfsMs}ms TTFA=${ttfaMs}ms ` +
        `sentences=${sentenceCount} total=${totalMs}ms`
    );
}

/**
 * POST text to the TTS streaming service, read length-prefixed PCM16 chunks,
 * and forward each chunk to the browser WebSocket as a binary frame.
 */
async function streamTtsToClient(
    session: ClientSession,
    text: string,
    onFirstChunk: () => void,
): Promise<void> {
    const response = await fetch(`${TTS_STREAM_URL}/tts/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
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
            const { done, value } = await reader.read();
            if (done) break;

            pending = Buffer.concat([pending, Buffer.from(value)]);

            // Parse length-prefixed chunks: [4-byte LE uint32 length][PCM16 bytes]
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


function isWav(buffer: Buffer): boolean {
    return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WAVE"
    );
}