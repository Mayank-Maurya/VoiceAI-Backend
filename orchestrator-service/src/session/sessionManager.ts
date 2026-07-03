import crypto from "node:crypto";
import { RawData, WebSocket as BrowserSocket } from "ws";
import WebSocket from "ws";
import type { ClientSession } from "../types/session";
import { VAD_FRAME_BYTES, STT_WS_URL } from "../config";
import { RingBuffer } from "../audio/ringBuffer";
import { processAudioFrame } from "../vad/speechDetector";
import { cancelCurrentTurn, streamTurnToClient } from "../pipeline/voicePipeline";

const sessions = new Map<string, ClientSession>();

export function addConnection(socket: BrowserSocket): ClientSession {
    const session: ClientSession = {
        id: crypto.randomUUID(),
        socket,
        connectedAt: Date.now(),
        chunksReceived: 0,
        bytesReceived: 0,
        vadBuffer: new RingBuffer(VAD_FRAME_BYTES),
        sttSocket: null,
        silenceFrames: 0,
        silenceSent: false,
        lastVoiceAt: 0,
        history: [],
        turnAbort: null,
    };

    sessions.set(session.id, session);
    console.log(`[${session.id}] connected activeConnections=${sessions.size}`);

    connectStt(session);

    return session;
}

function connectStt(session: ClientSession): void {
    const ws = new WebSocket(`${STT_WS_URL}/ws/stt`);

    ws.on("open", () => {
        console.log(`[${session.id}] STT WebSocket connected`);
        session.sttSocket = ws;
    });

    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.is_final && msg.text) {
                const tone = msg.emotion ? ` (${msg.emotion})` : "";
                console.log(`[${session.id}] USER${tone}: ${msg.text}`);

                if (session.turnAbort) {
                    console.log(`[${session.id}] Barge-in detected, cancelling current turn`);
                    cancelCurrentTurn(session);
                }

                streamTurnToClient(session, msg.text, msg.emotion).catch((err) => {
                    console.error(`[${session.id}] Pipeline error:`, err);
                });
            } else if (msg.text) {
                console.log(`[${session.id}] STT partial: ${msg.text}`);
            }
        } catch {
            console.error(`[${session.id}] Failed to parse STT message`);
        }
    });

    ws.on("error", (err) => {
        console.error(`[${session.id}] STT WebSocket error:`, err.message);
    });

    ws.on("close", () => {
        console.log(`[${session.id}] STT WebSocket closed`);
        session.sttSocket = null;
    });
}

export function removeConnection(session: ClientSession): void {
    sessions.delete(session.id);
    session.vadBuffer.clear();

    if (session.turnAbort) {
        session.turnAbort.abort();
        session.turnAbort = null;
    }

    if (session.sttSocket) {
        session.sttSocket.close();
        session.sttSocket = null;
    }

    console.log(
        `[${session.id}] disconnected activeConnections=${sessions.size} ` +
            `chunks=${session.chunksReceived} totalBytes=${session.bytesReceived}`
    );
}

export function handleAudio(session: ClientSession, data: RawData, isBinary: boolean): void {
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

    session.vadBuffer.append(audioChunk, (frame) => {
        processAudioFrame(session, frame);
    });
}

export function getActiveConnectionCount(): number {
    return sessions.size;
}

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
