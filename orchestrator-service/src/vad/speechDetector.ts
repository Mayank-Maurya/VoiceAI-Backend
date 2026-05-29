import VAD from "node-vad";
import type { ClientSession } from "../types/session";
import { SAMPLE_RATE } from "../config";
import { runVoicePipeline } from "../pipeline/processingEngineClient";

/**
 * Runs one VAD frame through the speech detector and drives the per-session
 * speech state machine: accumulate audio while the user speaks, and on the
 * trailing silence hand the completed utterance off to the processing engine.
 */
export async function sendToVadModel(session: ClientSession, frame: Buffer): Promise<void> {
    const result = await session.vad.processAudio(frame, SAMPLE_RATE);

    // Lazily initialize the speech state on the first frame.
    if (session.isSpeaking === undefined) session.isSpeaking = false;
    if (!session.utteranceBuffer) session.utteranceBuffer = Buffer.alloc(0);

    switch (result) {
        case VAD.Event.VOICE:
            if (!session.isSpeaking) {
                console.log(`🗣️  [${session.id}] Speech STARTED`);
                session.isSpeaking = true;
            }
            session.utteranceBuffer = Buffer.concat([session.utteranceBuffer, frame]);
            break;

        case VAD.Event.SILENCE:
        case VAD.Event.NOISE:
        case VAD.Event.ERROR:
            // Silence after speech marks the end of an utterance.
            if (session.isSpeaking) {
                console.log(`🛑 [${session.id}] Speech ENDED. Captured ${session.utteranceBuffer.length} bytes.`);
                session.isSpeaking = false;

                // Take the completed utterance and reset the buffer for the next one.
                const completedAudio = session.utteranceBuffer;
                session.utteranceBuffer = Buffer.alloc(0);

                // Fire-and-forget so we never block the WebSocket read loop.
                runVoicePipeline(session, completedAudio).catch((error) => {
                    console.error(`[${session.id}] Pipeline error:`, error);
                });
            }
            break;
    }
}
