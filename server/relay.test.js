import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelay } from './relay.js';
import { PROTOCOL_VERSION, admitHostCommand, validateCommand, drillWithinLimits } from '../js/remote-protocol.js';

const ORIGIN = 'https://nova.example';

async function startRelay(options = {}) {
    const relay = createRelay({ allowedOrigins: [ORIGIN], minStartIntervalMs: 0, ...options });
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    const url = `ws://127.0.0.1:${relay.server.address().port}/ws`;
    return { relay, url };
}

// Client wrapper that queues messages so tests can await them in order.
async function connect(url, origin = ORIGIN) {
    const ws = new WebSocket(url, { origin });
    const queue = [];
    const waiters = [];
    ws.on('message', data => {
        const message = JSON.parse(data.toString());
        const waiter = waiters.shift();
        if (waiter) waiter(message); else queue.push(message);
    });
    const closed = once(ws, 'close').then(([code]) => code);
    await once(ws, 'open');
    return {
        ws,
        closed,
        send: message => ws.send(JSON.stringify(message)),
        next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve))
    };
}

async function pair(url) {
    const host = await connect(url);
    host.send({ type: 'host_create', version: PROTOCOL_VERSION });
    const created = await host.next();
    assert.equal(created.type, 'session_created');
    const controller = await connect(url);
    controller.send({ type: 'join', version: PROTOCOL_VERSION, sessionId: created.sessionId, invite: created.invite });
    assert.equal((await controller.next()).type, 'joined');
    assert.equal((await host.next()).type, 'controller_joined');
    return { host, controller, created };
}

const run = (overrides = {}) => ({ name: 'run_drill', drill: 'forehand-drive', level: 1, mode: 'reps', reps: 5, pauseSec: 1, ...overrides });

test('relay forwards validated commands, catalog and status between paired roles', async t => {
    const { relay, url } = await startRelay();
    t.after(() => relay.close());
    const { host, controller } = await pair(url);

    host.send({ type: 'catalog', drills: [{ key: 'forehand-drive', label: 'Forehand Drive', levels: [1, 2] }] });
    assert.deepEqual(await controller.next(), { type: 'catalog', drills: [{ key: 'forehand-drive', label: 'Forehand Drive', levels: [1, 2] }] });

    controller.send({ type: 'command', seq: 1, command: run() });
    assert.deepEqual(await controller.next(), { type: 'ack', seq: 1 });
    const forwarded = await host.next();
    assert.equal(forwarded.type, 'command');
    assert.equal(forwarded.seq, 1);
    assert.deepEqual(forwarded.command, run());
    assert.ok(forwarded.ttlMs > 0);

    host.send({ type: 'status', state: 'running', seq: 1, drill: 'forehand-drive' });
    assert.deepEqual(await controller.next(), { type: 'status', state: 'running', seq: 1, drill: 'forehand-drive' });
});

test('invite is single-use and wrong invites are rejected', async t => {
    const { relay, url } = await startRelay();
    t.after(() => relay.close());
    const { created } = await pair(url);

    const intruder = await connect(url);
    intruder.send({ type: 'join', version: PROTOCOL_VERSION, sessionId: created.sessionId, invite: created.invite });
    assert.deepEqual(await intruder.next(), { type: 'error', code: 'invalid_invite' });
    assert.equal(await intruder.closed, 4001);

    const host2 = await connect(url);
    host2.send({ type: 'host_create', version: PROTOCOL_VERSION });
    const created2 = await host2.next();
    const guesser = await connect(url);
    guesser.send({ type: 'join', version: PROTOCOL_VERSION, sessionId: created2.sessionId, invite: 'x'.repeat(43) });
    assert.equal((await guesser.next()).code, 'invalid_invite');
});

test('relay rejects out-of-limit, malformed, replayed and throttled start commands but never stop', async t => {
    const { relay, url } = await startRelay({ minStartIntervalMs: 60_000 });
    t.after(() => relay.close());
    const { host, controller } = await pair(url);

    controller.send({ type: 'command', seq: 1, command: run({ reps: 1000 }) });
    assert.deepEqual(await controller.next(), { type: 'error', code: 'limit_exceeded', seq: 1 });
    controller.send({ type: 'command', seq: 2, command: { name: 'raw_ble', bytes: [0x81] } });
    assert.deepEqual(await controller.next(), { type: 'error', code: 'invalid', seq: 2 });
    controller.send({ type: 'command', seq: 3, command: run({ url: 'https://evil' }) });
    assert.deepEqual(await controller.next(), { type: 'error', code: 'invalid', seq: 3 });

    controller.send({ type: 'command', seq: 10, command: run() });
    assert.deepEqual(await controller.next(), { type: 'ack', seq: 10 });
    assert.equal((await host.next()).seq, 10);
    controller.send({ type: 'command', seq: 10, command: run() });
    assert.deepEqual(await controller.next(), { type: 'error', code: 'replay', seq: 10 });
    controller.send({ type: 'command', seq: 11, command: run() });
    assert.deepEqual(await controller.next(), { type: 'error', code: 'rate_limited', seq: 11 });

    controller.send({ type: 'command', seq: 5, command: { name: 'stop' } });
    assert.deepEqual(await controller.next(), { type: 'ack', seq: 5 });
    assert.deepEqual((await host.next()).command, { name: 'stop' });
});

test('either side leaving ends the session for both; reconnect cannot resume it', async t => {
    const { relay, url } = await startRelay();
    t.after(() => relay.close());

    const first = await pair(url);
    first.controller.ws.close();
    assert.deepEqual(await first.host.next(), { type: 'session_ended', reason: 'controller_left' });
    assert.equal(await first.host.closed, 4002);
    assert.equal(relay.sessions.size, 0);

    const second = await pair(url);
    second.host.send({ type: 'end' });
    assert.deepEqual(await second.controller.next(), { type: 'session_ended', reason: 'host_ended' });
    const rejoin = await connect(url);
    rejoin.send({ type: 'join', version: PROTOCOL_VERSION, sessionId: second.created.sessionId, invite: second.created.invite });
    assert.equal((await rejoin.next()).code, 'invalid_invite');
});

test('sessions expire', async t => {
    const { relay, url } = await startRelay({ sessionTtlMs: 50 });
    t.after(() => relay.close());
    const { host, controller } = await pair(url);
    assert.deepEqual(await controller.next(), { type: 'session_ended', reason: 'expired' });
    assert.deepEqual(await host.next(), { type: 'session_ended', reason: 'expired' });
});

test('upgrades from unknown origins are refused', async t => {
    const { relay, url } = await startRelay();
    t.after(() => relay.close());
    const ws = new WebSocket(url, { origin: 'https://evil.example' });
    const [error] = await once(ws, 'error');
    assert.match(error.message, /403/);
});

test('host gate admits stop unconditionally and rejects replays, bad TTLs and unvalidated payloads', () => {
    const gate = { lastSeq: 0 };
    const admitted = admitHostCommand(gate, { type: 'command', seq: 1, command: run(), ttlMs: 1000 }, 5000);
    assert.equal(admitted.ok, true);
    assert.equal(admitted.deadline, 6000);
    assert.deepEqual(admitHostCommand(gate, { type: 'command', seq: 1, command: run(), ttlMs: 1000 }, 5000), { ok: false, error: 'replay' });
    assert.deepEqual(admitHostCommand(gate, { type: 'command', seq: 2, command: run(), ttlMs: 10 ** 9 }, 5000), { ok: false, error: 'invalid' });
    assert.deepEqual(admitHostCommand(gate, { type: 'command', seq: 3, command: run({ timeSec: 60 }), ttlMs: 1000 }, 5000), { ok: false, error: 'invalid' });
    assert.equal(admitHostCommand(gate, { type: 'command', seq: 0, command: { name: 'stop' } }, 5000).ok, true);
    assert.equal(validateCommand(run({ mode: 'time', reps: undefined, timeSec: 301 })).error, 'limit_exceeded');
});

test('drillWithinLimits enforces local RPM and frequency caps', () => {
    const steps = [[[3000, 2000, 10, 0, 50, 1, 1]], [[4000, 1000, 10, 0, 60, 1, 1], [5000, 1000, 10, 0, 40, 1, 1]]];
    assert.equal(drillWithinLimits(steps, { maxRpm: 5000, maxFrequency: 60 }), true);
    assert.equal(drillWithinLimits(steps, { maxRpm: 4999, maxFrequency: 60 }), false);
    assert.equal(drillWithinLimits(steps, { maxRpm: 5000, maxFrequency: 59 }), false);
});
