import type { ClientSession } from "../types/session";
import { RMS_SPEECH_THRESHOLD, SILENCE_TAIL_FRAMES } from "../config";
import { computeRms } from "../audio/energy";

const SILENCE_FRAMES_TO_SIGNAL = 2;

export function processAudioFrame(session: ClientSession, frame: Buffer): void {
    const rms = computeRms(frame);
    const isVoice = rms >= RMS_SPEECH_THRESHOLD;

    const sock = session.sttSocket;
    const open = Boolean(sock && sock.readyState === sock.OPEN);

    if (isVoice) {
        // Transition out of signaled silence → tell the STT speech resumed, so
        // it cancels any pending finalize. (The STT no longer infers this from
        // byte arrival, because we also forward trailing-silence frames.)
        if (session.silenceSent && open) {
            sock!.send(JSON.stringify({ speech: true }));
        }

        session.silenceFrames = 0;
        session.silenceSent = false;
        session.lastVoiceAt = Date.now();

        if (open) sock!.send(frame);
    } else {
        session.silenceFrames += 1;

        // Forward a short trailing tail of silence so Smart Turn can hear how
        // the utterance trails off. After the tail we stop forwarding so the
        // buffer doesn't fill with dead air.
        if (session.silenceFrames <= SILENCE_TAIL_FRAMES && open) {
            sock!.send(frame);
        }

        if (session.silenceFrames >= SILENCE_FRAMES_TO_SIGNAL && !session.silenceSent && open) {
            sock!.send(JSON.stringify({ silence: true }));
            session.silenceSent = true;
        }
    }
}
