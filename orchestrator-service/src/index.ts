import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { PORT, WS_PATH } from "./config";
import { addConnection, handleAudio, removeConnection } from "./session/sessionManager";

// Serve the browser client from this same origin so the page and the WebSocket
// share one host. That keeps getUserMedia happy (it requires a secure context)
// whether the app is reached over http://localhost or a single HTTPS tunnel.
const CLIENT_DIR = path.resolve(process.env.CLIENT_DIR ?? path.join(process.cwd(), "..", "client"));

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const raw = new URL(req.url || "/", "http://localhost").pathname;
    const rel = decodeURIComponent(raw).replace(/^\/+/, "") || "index.html";
    const filePath = path.resolve(CLIENT_DIR, rel);

    // Stay inside CLIENT_DIR and never serve dotfiles (e.g. client/.env).
    const inside = filePath === CLIENT_DIR || filePath.startsWith(CLIENT_DIR + path.sep);
    if (!inside || path.basename(filePath).startsWith(".")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
            return;
        }
        res.writeHead(200, {
            "content-type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        });
        res.end(req.method === "HEAD" ? undefined : data);
    });
}

const server = http.createServer((req, res) => {
    if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
        serveStatic(req, res);
        return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    if (url.pathname !== WS_PATH) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});

wss.on("connection", (socket) => {
    const session = addConnection(socket);

    socket.on("message", (data, isBinary) => {
        handleAudio(session, data, isBinary);
    });

    socket.on("close", () => {
        removeConnection(session);
    });

    socket.on("error", (error) => {
        console.error(`[${session.id}] websocket error`, error);
    });
});

server.listen(PORT, () => {
    console.log(`HTTP server listening on http://localhost:${PORT}`);
    console.log(`WebSocket endpoint ready at ws://localhost:${PORT}${WS_PATH}`);
});
