import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
    PROTOCOL_VERSION,
    REMOTE_LIMITS,
    validateCatalog,
    validateCommand,
    validateStatus
} from '../js/remote-protocol.js';

const HELLO_TIMEOUT_MS = 10_000;
const FLOOD_WINDOW_MS = 10_000;
const FLOOD_MAX_MESSAGES = 40;
const CLOSE_INVALID_INVITE = 4001;
const CLOSE_SESSION_ENDED = 4002;
const CLOSE_POLICY = 1008;

const sha256 = value => createHash('sha256').update(value).digest();

function send(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

export function createRelay({
    allowedOrigins,
    sessionTtlMs = REMOTE_LIMITS.sessionTtlMs,
    heartbeatMs = 15_000,
    commandTtlMs = REMOTE_LIMITS.commandTtlMs,
    minStartIntervalMs = REMOTE_LIMITS.minStartIntervalMs
}) {
    const origins = new Set(allowedOrigins);
    if (origins.size === 0) throw new Error('allowedOrigins must not be empty');

    const sessions = new Map();
    const server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/healthz') {
            res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
            return;
        }
        res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: REMOTE_LIMITS.maxMessageBytes });

    server.on('upgrade', (req, socket, head) => {
        const path = new URL(req.url, 'http://relay').pathname;
        if (path !== '/ws' || !origins.has(req.headers.origin)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });

    function endSession(session, reason) {
        if (session.ended) return;
        session.ended = true;
        clearTimeout(session.expiryTimer);
        sessions.delete(session.id);
        for (const ws of [session.host, session.controller]) {
            send(ws, { type: 'session_ended', reason });
            ws?.close(CLOSE_SESSION_ENDED, reason);
        }
    }

    function createSession(conn) {
        const session = {
            id: randomBytes(16).toString('base64url'),
            ended: false,
            host: conn.ws,
            controller: null,
            inviteHash: null,
            catalog: null,
            lastSeq: 0,
            lastStartAt: -Infinity,
            expiresAt: Date.now() + sessionTtlMs,
            expiryTimer: null
        };
        const invite = randomBytes(32).toString('base64url');
        session.inviteHash = sha256(invite);
        session.expiryTimer = setTimeout(() => endSession(session, 'expired'), sessionTtlMs);
        sessions.set(session.id, session);
        conn.role = 'host';
        conn.session = session;
        send(conn.ws, { type: 'session_created', sessionId: session.id, invite, ttlMs: sessionTtlMs });
    }

    function joinSession(conn, message) {
        const session = typeof message.sessionId === 'string' ? sessions.get(message.sessionId) : undefined;
        const invite = typeof message.invite === 'string' ? sha256(message.invite) : null;
        // The invite is single-use: once a controller joined, inviteHash is null and every later join fails.
        if (!session || !session.inviteHash || !invite || !timingSafeEqual(invite, session.inviteHash)) {
            send(conn.ws, { type: 'error', code: 'invalid_invite' });
            conn.ws.close(CLOSE_INVALID_INVITE, 'invalid_invite');
            return;
        }
        session.inviteHash = null;
        session.controller = conn.ws;
        conn.role = 'controller';
        conn.session = session;
        send(conn.ws, { type: 'joined', ttlMs: Math.max(0, session.expiresAt - Date.now()) });
        if (session.catalog) send(conn.ws, { type: 'catalog', drills: session.catalog });
        send(session.host, { type: 'controller_joined' });
    }

    function handleHost(conn, message) {
        const session = conn.session;
        if (message.type === 'catalog') {
            const result = validateCatalog(message.drills);
            if (!result.ok) return send(conn.ws, { type: 'error', code: 'invalid_catalog' });
            session.catalog = result.drills;
            send(session.controller, { type: 'catalog', drills: result.drills });
        } else if (message.type === 'status') {
            const result = validateStatus(message);
            if (!result.ok) return send(conn.ws, { type: 'error', code: 'invalid_status' });
            send(session.controller, result.status);
        } else if (message.type === 'end') {
            endSession(session, 'host_ended');
        } else {
            send(conn.ws, { type: 'error', code: 'unknown_type' });
        }
    }

    function handleController(conn, message) {
        const session = conn.session;
        if (message.type !== 'command') return send(conn.ws, { type: 'error', code: 'unknown_type' });
        const seq = message.seq;
        if (!Number.isSafeInteger(seq)) return send(conn.ws, { type: 'error', code: 'invalid' });
        const result = validateCommand(message.command);
        if (!result.ok) return send(conn.ws, { type: 'error', code: result.error, seq });

        if (result.command.name === 'stop') {
            // Stop bypasses sequencing and throttling so it can never be held back.
            session.lastSeq = Math.max(session.lastSeq, seq);
        } else {
            if (seq <= session.lastSeq) return send(conn.ws, { type: 'error', code: 'replay', seq });
            session.lastSeq = seq;
            const now = Date.now();
            if (now - session.lastStartAt < minStartIntervalMs) {
                return send(conn.ws, { type: 'error', code: 'rate_limited', seq });
            }
            session.lastStartAt = now;
        }
        send(session.host, { type: 'command', seq, command: result.command, ttlMs: commandTtlMs });
        send(conn.ws, { type: 'ack', seq });
    }

    const connections = new WeakMap();

    wss.on('connection', ws => {
        const conn = { ws, role: null, session: null, alive: true, windowStart: Date.now(), windowCount: 0 };
        connections.set(ws, conn);
        const helloTimer = setTimeout(() => { if (!conn.role) ws.close(CLOSE_POLICY, 'hello_timeout'); }, HELLO_TIMEOUT_MS);

        ws.on('pong', () => { conn.alive = true; });
        ws.on('close', () => {
            clearTimeout(helloTimer);
            if (conn.session) endSession(conn.session, conn.role === 'host' ? 'host_left' : 'controller_left');
        });
        ws.on('error', () => ws.terminate());
        ws.on('message', (data, isBinary) => {
            const now = Date.now();
            if (now - conn.windowStart > FLOOD_WINDOW_MS) {
                conn.windowStart = now;
                conn.windowCount = 0;
            }
            if (++conn.windowCount > FLOOD_MAX_MESSAGES) return ws.close(CLOSE_POLICY, 'rate_limited');

            let message;
            try {
                if (isBinary) throw new Error('binary');
                message = JSON.parse(data.toString('utf8'));
            } catch {
                return ws.close(CLOSE_POLICY, 'malformed');
            }
            if (message === null || typeof message !== 'object') return ws.close(CLOSE_POLICY, 'malformed');

            if (!conn.role) {
                if (message.version !== PROTOCOL_VERSION) {
                    send(ws, { type: 'error', code: 'unsupported_version' });
                    return ws.close(CLOSE_POLICY, 'unsupported_version');
                }
                if (message.type === 'host_create') return createSession(conn);
                if (message.type === 'join') return joinSession(conn, message);
                return ws.close(CLOSE_POLICY, 'hello_required');
            }
            if (conn.session.ended) return;
            if (conn.role === 'host') handleHost(conn, message);
            else handleController(conn, message);
        });
    });

    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            const conn = connections.get(ws);
            if (!conn.alive) {
                ws.terminate();
                continue;
            }
            conn.alive = false;
            ws.ping();
        }
    }, heartbeatMs);

    function close() {
        clearInterval(heartbeat);
        for (const session of [...sessions.values()]) endSession(session, 'relay_shutdown');
        for (const ws of wss.clients) ws.terminate();
        return new Promise(resolve => server.close(resolve));
    }

    return { server, sessions, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
    if (allowedOrigins.length === 0) {
        console.error('Set ALLOWED_ORIGINS, e.g. ALLOWED_ORIGINS=https://wenguang1111.github.io');
        process.exit(1);
    }
    const port = Number(process.env.PORT || 8787);
    const host = process.env.HOST || '127.0.0.1';
    const relay = createRelay({ allowedOrigins });
    relay.server.listen(port, host, () => console.log(`Nova relay listening on ${host}:${port} for ${allowedOrigins.join(', ')}`));
    const shutdown = () => relay.close().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
