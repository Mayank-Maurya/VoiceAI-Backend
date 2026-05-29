import crypto from "node:crypto";
import { RawData, WebSocket } from "ws";
import VAD from "node-vad";
import type { ClientSession } from "../types/session";
import { VAD_FRAME_BYTES, VAD_MODE } from "../config";
import { RingBuffer } from "../audio/ringBuffer";
import { sendToVadModel } from "../vad/speechDetector";

const sessions = new Map<string, ClientSession>();

export function addConnection(socket: WebSocket): ClientSession {
    const session: ClientSession = {
        id: crypto.randomUUID(),
        socket,
        connectedAt: Date.now(),
        chunksReceived: 0,
        bytesReceived: 0,
        vadFramesSent: 0,
        vadBuffer: new RingBuffer(VAD_FRAME_BYTES),
        vad: new VAD(VAD_MODE),
        vadWork: Promise.resolve(),
        isSpeaking: false,
        utteranceBuffer: Buffer.alloc(0),
        speechFrames: 0,
        silenceFrames: 0,
        voiceFrameCount: 0,
    };

    sessions.set(session.id, session);
    console.log(`[${session.id}] connected activeConnections=${sessions.size}`);

    return session;
}

export function removeConnection(session: ClientSession): void {
    sessions.delete(session.id);
    session.vadBuffer.clear();

    console.log(
        `[${session.id}] disconnected activeConnections=${sessions.size} ` +
            `chunks=${session.chunksReceived} totalBytes=${session.bytesReceived} ` +
            `vadFrames=${session.vadFramesSent}`
    );
}

export function handleAudio(session: ClientSession, data: RawData, isBinary: boolean): void {
    // Non-binary frames are JSON control/metadata messages, not audio.
    if (!isBinary) {
        try {
            const message = JSON.parse(data.toString());
            console.log(`[${session.id}] metadata`, message);
        } catch {
            console.log(`[${session.id}] ignored text message`);
        }
        return;
    }

    const audioChunk = toBuffer(data);
    session.chunksReceived += 1;
    session.bytesReceived += audioChunk.length;

    // Buffer the chunk; once a full VAD frame is ready, queue it on the
    // per-session work chain so frames are processed one at a time, in order.
    session.vadBuffer.append(audioChunk, (vadFrame) => {
        session.vadFramesSent += 1;
        session.vadWork = session.vadWork
            .then(() => sendToVadModel(session, vadFrame))
            .catch((error) => {
                console.error(`[${session.id}] VAD processing failed`, error);
            });
    });
}

export function getActiveConnectionCount(): number {
    return sessions.size;
}

/** Normalizes the various shapes `ws` can hand us into a single Buffer. */
function toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }
    return Buffer.from(String(data));
}
