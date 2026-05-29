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
        const response = await fetch(`${PROCESSING_ENGINE_URL}/voice-chat`, {
            method: "POST",
            headers: { "Content-Type": "audio/wav" },
            body: wavFile,
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const ttsWavBuffer = Buffer.from(await response.arrayBuffer());
        if (ttsWavBuffer.length > 0) {
            session.socket.send(ttsWavBuffer);
            console.log(`✨ [${session.id}] Dispatched AI voice response (${ttsWavBuffer.length} bytes) back to user.`);
        }
    } catch (error) {
        console.error(`❌ [${session.id}] Processing engine request failed:`, error);
    }
}
