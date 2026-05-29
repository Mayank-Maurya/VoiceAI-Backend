import type { ClientSession } from "../types/session";
import { MIN_UTTERANCE_BYTES, PROCESSING_ENGINE_URL, SAMPLE_RATE } from "../config";
import { generateWavHeader } from "../audio/wav";

/**
 * Sends a completed utterance to the processing engine (STT -> LLM -> TTS) and
 * streams the synthesized WAV response back to the client over the WebSocket.
 */
export async function runVoicePipeline(session: ClientSession, rawPcm: Buffer): Promise<void> {
    if (rawPcm.length < MIN_UTTERANCE_BYTES) {
        console.log(`[${session.id}] Audio too short, discarding.`);
        return;
    }

    const wavFile = Buffer.concat([generateWavHeader(rawPcm.length, SAMPLE_RATE), rawPcm]);
    console.log(`🚀 [${session.id}] Sending ${wavFile.length} bytes to processing engine...`);

    try {
        const startedAt = Date.now();
        const response = await fetch(`${PROCESSING_ENGINE_URL}/voice-chat`, {
            method: "POST",
            headers: { "Content-Type": "audio/wav" },
            body: wavFile,
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const roundTripMs = Date.now() - startedAt;
        const ttsWavBuffer = Buffer.from(await response.arrayBuffer());

        // Log the per-stage breakdown the engine reports (compute vs lock-wait),
        // plus the round trip measured here (includes network + HTTP overhead).
        const h = (name: string) => response.headers.get(name) ?? "?";
        console.log(
            `⏱️  [${session.id}] compute STT=${h("X-Timing-STT-Compute-Ms")} ` +
                `LLM=${h("X-Timing-LLM-Compute-Ms")} TTS=${h("X-Timing-TTS-Compute-Ms")}ms | ` +
                `wait STT=${h("X-Timing-STT-Wait-Ms")} LLM=${h("X-Timing-LLM-Wait-Ms")} ` +
                `TTS=${h("X-Timing-TTS-Wait-Ms")}ms | total=${h("X-Timing-Total-Ms")}ms ` +
                `roundTrip=${roundTripMs}ms`
        );

        if (ttsWavBuffer.length > 0) {
            session.socket.send(ttsWavBuffer);
            console.log(`✨ [${session.id}] Dispatched AI voice response (${ttsWavBuffer.length} bytes) back to user.`);
        }
    } catch (error) {
        console.error(`❌ [${session.id}] Processing engine request failed:`, error);
    }
}
