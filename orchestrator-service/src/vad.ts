import type { ClientSession } from "./types";
import VAD from "node-vad";

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const VAD_FRAME_MS = 100;
export const VAD_FRAME_SAMPLES = (SAMPLE_RATE / 1000) * VAD_FRAME_MS;
export const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * BYTES_PER_SAMPLE;

// 1. The WAV Header Generator (Required for the Python STT Server)
function generateWavHeader(dataLength: number, sampleRate = 16000): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}

export async function sendToVadModel(session: ClientSession, frame: Buffer): Promise<void> {
    const result = await session.vad.processAudio(frame, SAMPLE_RATE);

    // Initialize session state if this is the first frame
    if (session.isSpeaking === undefined) session.isSpeaking = false;
    if (!session.utteranceBuffer) session.utteranceBuffer = Buffer.alloc(0);

    // 2. The State Machine
    switch (result) {
        case VAD.Event.VOICE:
            if (!session.isSpeaking) {
                console.log(`🗣️ [${session.id}] Speech STARTED`);
                session.isSpeaking = true;
            }
            // Append the 100ms frame to the growing sentence buffer
            session.utteranceBuffer = Buffer.concat([session.utteranceBuffer, frame]);
            break;

        case VAD.Event.SILENCE:
        case VAD.Event.NOISE:
        case VAD.Event.ERROR:
            // If they were speaking and just stopped
            if (session.isSpeaking) {
                console.log(`🛑 [${session.id}] Speech ENDED. Captured ${session.utteranceBuffer.length} bytes.`);
                session.isSpeaking = false;

                // Grab the complete sentence and clear the session buffer for the next one
                const completedAudio = session.utteranceBuffer;
                session.utteranceBuffer = Buffer.alloc(0);

                // 3. Dispatch to the STT microservice without blocking the WebSocket loop
                dispatchToSTT(session.id, completedAudio).catch(err => {
                    console.error(`[${session.id}] Dispatch Error:`, err);
                });
            }
            break;
    }
}

// 4. The Network Dispatcher
async function dispatchToSTT(sessionId: string, rawPcm: Buffer) {
    // Prevent sending empty or impossibly short files
    if (rawPcm.length < VAD_FRAME_BYTES * 3) {
        console.log(`[${sessionId}] Audio too short, discarding.`);
        return;
    }

    // Wrap the raw PCM bytes in a valid WAV file structure
    const wavHeader = generateWavHeader(rawPcm.length, SAMPLE_RATE);
    const fullWavFile = Buffer.concat([wavHeader, rawPcm]);

    console.log(`🚀 [${sessionId}] Sending ${fullWavFile.length} bytes to STT Worker...`);

    try {
        // NOTE: Ensure your PC IP matches what you got from `ip addr`
        const response = await fetch('http://192.168.1.3:7001/transcribe', {
            method: 'POST',
            headers: {
                'Content-Type': 'audio/wav'
            },
            body: fullWavFile
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log(data);
        
        // console.log(`\n💬 [${sessionId}] TRANSCRIBED: "${data.text}"`);
        // console.log(`⏱️  [${sessionId}] Inference Time: ${data.compute_time_ms.toFixed(2)} ms\n`);

        // --> TODO: Route `data.text` to your LLM here <--

    } catch (error) {
        console.error(`❌ [${sessionId}] STT Request Failed:`, error);
    }
}

// Helper: Inspect Audio Integrity
export function inspectPcm16(frame: Buffer): { min: number; max: number; rms: number; } {
    let min = 32767;
    let max = -32768;
    let sumSquares = 0;

    for (let i = 0; i < frame.length; i += BYTES_PER_SAMPLE) {
        const sample = frame.readInt16LE(i);
        min = Math.min(min, sample);
        max = Math.max(max, sample);
        sumSquares += sample * sample;
    }

    const sampleCount = frame.length / BYTES_PER_SAMPLE;
    const rms = Math.sqrt(sumSquares / sampleCount);

    return { min, max, rms };
}