import type { ClientSession } from "../types/session";
import {
    MIN_UTTERANCE_BYTES,
    SAMPLE_RATE,
    STAGE_TIMEOUT_MS,
    STT_JOBS_QUEUE,
    TTS_JOBS_QUEUE,
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

        const llmStart = Date.now();
        let firstTokenAt: number | null = null;
        const sentences: string[] = [];

        for await(const sentence of sentenceBuffer(streamLlmResponse(userText))) {
            if (firstTokenAt === null) {
                firstTokenAt = Date.now();
            }
            sentences.push(sentence);
        }

        const aiText = sentences.join("");

        const llmMs = Date.now() - llmStart;
        const ttftMs = firstTokenAt ? firstTokenAt - llmStart : 0;
        console.log(`[${session.id}] AI: ${aiText}`);
        console.log(
            `[${session.id}] turn=${turnId} LLM streaming: ` +
            `first_sentence=${ttftMs}ms total=${llmMs}ms sentences=${sentences.length}`
        );

        const ttsRequest = Buffer.from(
            JSON.stringify({
                stage: "tts",
                sessionId: session.id,
                turnId,
                text: aiText,
            }),
            "utf8"
        );

        const ttsStart = Date.now();
        const ttsWavBuffer = await rabbitRpcClient.request(TTS_JOBS_QUEUE, ttsRequest, {
            timeoutMs: STAGE_TIMEOUT_MS,
            contentType: "application/json",
            headers: {
                sessionId: session.id,
                turnId,
            },
        });
        const ttsMs = Date.now() - ttsStart;

        if (!isWav(ttsWavBuffer)) {
            console.error(
                `[${session.id}] turn=${turnId} TTS returned non-WAV: ` +
                ttsWavBuffer.toString("utf8").slice(0, 500)
            );
            return;
        }

        if (session.socket.readyState === session.socket.OPEN) {
            session.socket.send(ttsWavBuffer);
        }

        const totalMs = Date.now() - startedAt;
        console.log(
            `[${session.id}] turn=${turnId} complete ` +
            `STT=${sttMs}ms LLM=${llmMs}ms TTS=${ttsMs}ms total=${totalMs}ms`
        );
    } catch (error) {
        console.error(`[${session.id}] turn=${turnId} failed`, error);
    }
}

function isWav(buffer: Buffer): boolean {
    return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WAVE"
    );
}