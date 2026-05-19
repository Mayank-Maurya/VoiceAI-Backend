import { ClientSession } from "./types";
import crypto from "node:crypto";
import { RawData, WebSocket } from "ws";

const sessions = new Map<string, ClientSession>();

export function addConnection(socket: WebSocket): ClientSession {
    const session: ClientSession = {
        id: crypto.randomUUID(),
        socket,
        connectedAt: Date.now(),
        lastChunkAt: 0,
        chunksRecieved: 0,
        bytesRecieved: 0
    };

    sessions.set(session.id, session);

    console.log(
        `[${session.id}] connected activeConnections=${sessions.size}`
    );

    return session;
}

export function removeConnection(session: ClientSession): void {
  sessions.delete(session.id);

  console.log(
    `[${session.id}] disconnected activeConnections=${sessions.size} ` +
      `chunks=${session.chunksRecieved} totalBytes=${session.bytesRecieved}`
  );
}

export function handleAudio(session: ClientSession, data: RawData, isBinary: boolean) {
    if (!isBinary) {
        console.warn(`[${session.id}] ignored non-binary message`);
        return;
    }

    const now = Date.now();
    const chunkSize = getChunkSize(data);
    const sinceConnectedMs = now - session.connectedAt;
    const sinceLastChunkMs =
        session.lastChunkAt === 0 ? 0 : now - session.lastChunkAt;

    session.lastChunkAt = now;
    session.chunksRecieved += 1;
    session.bytesRecieved += chunkSize;

    console.log(
        `[${session.id}] chunk=${session.chunksRecieved} ` +
        `size=${chunkSize}B ` +
        `at=${new Date(now).toISOString()} ` +
        `sinceConnected=${sinceConnectedMs}ms ` +
        `sinceLastChunk=${sinceLastChunkMs}ms ` +
        `total=${session.bytesRecieved}B`
    );
}

export function getActiveConnectionCount(): number {
  return sessions.size;
}

function getChunkSize(data: RawData): number {
  if (Buffer.isBuffer(data)) {
    return data.length;
  }

  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }

  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.length, 0);
  }

  return Buffer.byteLength(String(data));
}

