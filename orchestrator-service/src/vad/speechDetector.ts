import VAD from "node-vad";
import type { ClientSession } from "../types/session";
import {
    MIN_SPEECH_FRAMES,
    RMS_SPEECH_THRESHOLD,
    SAMPLE_RATE,
    SPEECH_END_SILENCE_FRAMES,
    SPEECH_START_FRAMES,
} from "../config";
import { computeRms } from "../audio/energy";
import { runVoicePipeline } from "../pipeline/voicePipeline";

/**
 * Runs one frame through the speech endpointer.
 *
 * Rather than trusting a single VAD frame, this debounces both ends of an
 * utterance: speech must be sustained for several frames to START, and trailing
 * silence must persist for several frames to END. An energy gate and a minimum
 * voice-frame requirement reject the brief, low-level noise blips that would
 * otherwise be transcribed as phantom "Mm" / "Ooh" utterances.
 */
export async function sendToVadModel(session: ClientSession, frame: Buffer): Promise<void> {
    const vadResult = await session.vad.processAudio(frame, SAMPLE_RATE);

    // A frame counts as speech only when the VAD agrees AND it carries enough
    // energy. The energy gate rejects ambient noise that auto-gain amplifies.
    const isVoice = vadResult === VAD.Event.VOICE && computeRms(frame) >= RMS_SPEECH_THRESHOLD;

    if (!session.isSpeaking) {
        handlePotentialStart(session, frame, isVoice);
    } else {
        handleOngoingSpeech(session, frame, isVoice);
    }
}

/** Before speech is confirmed: require several sustained voice frames to begin. */
function handlePotentialStart(session: ClientSession, frame: Buffer, isVoice: boolean): void {
    if (!isVoice) {
        // The onset wasn't sustained — drop any tentatively buffered lead-in.
        if (session.speechFrames > 0) {
            resetSpeechState(session);
        }
        return;
    }

    // Tentatively buffer the lead-in so we don't clip the start of the utterance.
    session.speechFrames += 1;
    session.voiceFrameCount += 1;
    session.utteranceBuffer = Buffer.concat([session.utteranceBuffer, frame]);

    if (session.speechFrames >= SPEECH_START_FRAMES) {
        session.isSpeaking = true;
        session.silenceFrames = 0;
        console.log(`🗣️  [${session.id}] Speech STARTED`);
    }
}

/** During speech: keep buffering until enough trailing silence ends the utterance. */
function handleOngoingSpeech(session: ClientSession, frame: Buffer, isVoice: boolean): void {
    session.utteranceBuffer = Buffer.concat([session.utteranceBuffer, frame]);

    if (isVoice) {
        session.voiceFrameCount += 1;
        session.silenceFrames = 0;
        return;
    }

    session.silenceFrames += 1;
    if (session.silenceFrames < SPEECH_END_SILENCE_FRAMES) {
        return;
    }

    // Enough trailing silence: the utterance is complete.
    const completedAudio = session.utteranceBuffer;
    const voiceFrames = session.voiceFrameCount;
    resetSpeechState(session);

    if (voiceFrames < MIN_SPEECH_FRAMES) {
        console.log(`[${session.id}] Discarded utterance: only ${voiceFrames} voice frames.`);
        return;
    }

    console.log(
        `🛑 [${session.id}] Speech ENDED. ${completedAudio.length} bytes, ${voiceFrames} voice frames.`
    );

    // Fire-and-forget so we never block the WebSocket read loop.
    runVoicePipeline(session, completedAudio).catch((error) => {
        console.error(`[${session.id}] Pipeline error:`, error);
    });
}

function resetSpeechState(session: ClientSession): void {
    session.isSpeaking = false;
    session.utteranceBuffer = Buffer.alloc(0);
    session.speechFrames = 0;
    session.silenceFrames = 0;
    session.voiceFrameCount = 0;
}
