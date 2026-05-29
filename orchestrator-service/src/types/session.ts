import type { WebSocket } from "ws";
import { RingBuffer } from "../audio/ringBuffer";
import VAD from "node-vad";

/**
 * Per-connection state for a single client streaming audio over the WebSocket.
 */
export type ClientSession = {
    id: string;
    socket: WebSocket;
    connectedAt: number;

    // Running totals, useful for logging on disconnect.
    chunksReceived: number;
    bytesReceived: number;
    vadFramesSent: number;

    // Re-chunks incoming audio into fixed-size frames for the VAD.
    vadBuffer: RingBuffer;

    // Voice Activity Detection model and a promise chain that serializes
    // VAD work so frames are processed strictly in order.
    vad: VAD;
    vadWork: Promise<void>;

    // Speech state machine: whether the user is currently speaking and the
    // audio captured for the in-progress utterance.
    isSpeaking?: boolean;
    utteranceBuffer?: Buffer;
};
