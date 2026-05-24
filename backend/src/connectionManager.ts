import { ClientSession } from "./types";
import crypto from "node:crypto";
import { RawData, WebSocket } from "ws";
import { RingBuffer } from "./staticRingBuffer";
import { sendToVadModel } from "./vad";

const sessions = new Map<string, ClientSession>();

export function addConnection(socket: WebSocket): ClientSession {
    const session: ClientSession = {
        id: crypto.randomUUID(),
        socket,
        connectedAt: Date.now(),
        lastChunkAt: 0,
        chunksRecieved: 0,
        bytesRecieved: 0,
        vadFramesSent: 0,
        vadBuffer: new RingBuffer(),
    };

    sessions.set(session.id, session);

    console.log(
        `[${session.id}] connected activeConnections=${sessions.size}`
    );

    return session;
}

export function removeConnection(session: ClientSession): void {
  sessions.delete(session.id);
  session.vadBuffer.clear();

  console.log(
    `[${session.id}] disconnected activeConnections=${sessions.size} ` +
      `chunks=${session.chunksRecieved} totalBytes=${session.bytesRecieved}` + 
      `vadFrames=${session.vadFramesSent}`
  );
}

export function handleAudio(session: ClientSession, data: RawData, isBinary: boolean) {
    if (!isBinary) {
        console.warn(`[${session.id}] ignored non-binary message`);
        return;
    }

    const audioChunk = toBuffer(data);

    session.chunksRecieved += 1;
    session.bytesRecieved += audioChunk.length;

    session.vadBuffer.append(audioChunk, (vadFrame) => {
      session.vadFramesSent += 1;
      sendToVadModel(session, vadFrame);
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

