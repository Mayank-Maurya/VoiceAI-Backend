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
import { generateLlmResponse } from "./vllmClient";

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

        const sttReplyBuffer = await rabbitRpcClient.request(STT_JOBS_QUEUE, wavFile, {
            timeoutMs: STAGE_TIMEOUT_MS,
            contentType: "audio/wav",
            headers: {
                sessionId: session.id,
                turnId,
                sampleRate: SAMPLE_RATE,
            },
        });

        const sttReply = JSON.parse(sttReplyBuffer.toString("utf8")) as SttReply;
        const userText = sttReply.text.trim();

        if (!userText) {
            console.log(`[${session.id}] turn=${turnId} Empty transcript`);
            return;
        }

        console.log(`[${session.id}] USER: ${userText}`);

        const aiText = await generateLlmResponse(userText);
        console.log(`[${session.id}] AI: ${aiText}`);

        const ttsRequest = Buffer.from(
            JSON.stringify({
                stage: "tts",
                sessionId: session.id,
                turnId,
                text: aiText,
            }),
            "utf8"
        );

        const ttsWavBuffer = await rabbitRpcClient.request(TTS_JOBS_QUEUE, ttsRequest, {
            timeoutMs: STAGE_TIMEOUT_MS,
            contentType: "application/json",
            headers: {
                sessionId: session.id,
                turnId,
            },
        });

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

        console.log(`[${session.id}] turn=${turnId} complete total=${Date.now() - startedAt}ms`);
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