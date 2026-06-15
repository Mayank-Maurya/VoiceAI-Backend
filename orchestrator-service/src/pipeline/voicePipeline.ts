import crypto from "node:crypto";
import type { ClientSession } from "../types/session";
import { TTS_STREAM_URL } from "../config";
import { streamLlmResponse } from "./vllmClient";
import { sentenceBuffer } from "./sentenceBuffer";

export async function streamTurnToClient(
    session: ClientSession,
    userText: string,
): Promise<void> {
    const turnId = crypto.randomUUID();
    const startedAt = Date.now();
    let firstSentenceAt: number | null = null;
    let firstAudioAt: number | null = null;
    let sentenceCount = 0;
    let audioStartSent = false;

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

    console.log(`[${session.id}] turn=${turnId} streaming LLM+TTS for: "${userText}"`);

    for await (const sentence of sentenceBuffer(streamLlmResponse(userText))) {
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
    const ttfsMs = firstSentenceAt ? firstSentenceAt - startedAt : 0;
    const ttfaMs = firstAudioAt ? firstAudioAt - startedAt : 0;

    console.log(
        `[${session.id}] turn=${turnId} complete ` +
        `TTFS=${ttfsMs}ms TTFA=${ttfaMs}ms ` +
        `sentences=${sentenceCount} total=${totalMs}ms`
    );
}

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
