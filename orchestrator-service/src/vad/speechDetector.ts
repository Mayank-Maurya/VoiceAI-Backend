import type { ClientSession } from "../types/session";
import { RMS_SPEECH_THRESHOLD } from "../config";
import { computeRms } from "../audio/energy";

const SILENCE_FRAMES_TO_SIGNAL = 2;

export function processAudioFrame(session: ClientSession, frame: Buffer): void {
    const rms = computeRms(frame);
    const isVoice = rms >= RMS_SPEECH_THRESHOLD;

    if (isVoice) {
        session.silenceFrames = 0;
        session.silenceSent = false;
        session.lastVoiceAt = Date.now();

        if (session.sttSocket && session.sttSocket.readyState === session.sttSocket.OPEN) {
            session.sttSocket.send(frame);
        }
    } else {
        session.silenceFrames += 1;

        if (
            session.silenceFrames >= SILENCE_FRAMES_TO_SIGNAL &&
            !session.silenceSent &&
            session.sttSocket &&
            session.sttSocket.readyState === session.sttSocket.OPEN
        ) {
            session.sttSocket.send(JSON.stringify({ silence: true }));
            session.silenceSent = true;
        }
    }
}
