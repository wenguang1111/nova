// Shared by the browser host/controller pages and the Node relay (server/relay.js).
// Keep this module free of DOM and Node APIs.

export const PROTOCOL_VERSION = 1;

export const REMOTE_LIMITS = Object.freeze({
    levels: Object.freeze([1, 2, 3]),
    modes: Object.freeze(['reps', 'time']),
    repsMin: 1,
    repsMax: 30,
    timeSecMin: 10,
    timeSecMax: 300,
    pauseSecMin: 0.5,
    pauseSecMax: 5,
    drillKeyMaxLength: 128,
    drillLabelMaxLength: 80,
    catalogMaxEntries: 200,
    // A start request must be confirmed onsite within this window, otherwise it is dropped.
    commandTtlMs: 30_000,
    minStartIntervalMs: 3_000,
    maxMessageBytes: 16_384,
    sessionTtlMs: 30 * 60_000
});

export const HOST_STATES = Object.freeze(['ready', 'pending', 'rejected', 'running', 'ended']);
export const REJECT_REASONS = Object.freeze([
    'declined', 'timeout', 'busy', 'not_connected', 'unknown_drill', 'limit_exceeded', 'invalid', 'replay'
]);
export const END_REASONS = Object.freeze(['finished', 'stopped']);

// Only TLS relays are accepted, except a loopback relay for local development.
export function parseRelayUrl(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { return null; }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'wss:' || (url.protocol === 'ws:' && loopback)) return url.href;
    return null;
}

const fail = error => ({ ok: false, error });

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(object, allowed) {
    return Object.keys(object).every(key => allowed.includes(key));
}

function isIntInRange(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
}

// Custom drill keys embed user-chosen names, so any printable text is allowed; hosts must look keys up with Object.hasOwn.
function isDrillKey(value) {
    return typeof value === 'string' && value.length > 0 &&
        value.length <= REMOTE_LIMITS.drillKeyMaxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

// Validates a controller command and returns a normalized copy with no extra fields.
export function validateCommand(command) {
    if (!isPlainObject(command)) return fail('invalid');
    if (command.name === 'stop') {
        return hasOnlyKeys(command, ['name']) ? { ok: true, command: { name: 'stop' } } : fail('invalid');
    }
    if (command.name !== 'run_drill') return fail('invalid');

    const L = REMOTE_LIMITS;
    if (!hasOnlyKeys(command, ['name', 'drill', 'level', 'mode', 'reps', 'timeSec', 'pauseSec'])) return fail('invalid');
    if (!isDrillKey(command.drill)) return fail('invalid');
    if (!L.levels.includes(command.level)) return fail('invalid');
    if (typeof command.pauseSec !== 'number' || !Number.isFinite(command.pauseSec)) return fail('invalid');
    const pauseSec = Math.round(command.pauseSec * 10) / 10;
    if (pauseSec < L.pauseSecMin || pauseSec > L.pauseSecMax) return fail('limit_exceeded');

    const normalized = { name: 'run_drill', drill: command.drill, level: command.level, mode: command.mode, pauseSec };
    if (command.mode === 'reps') {
        if (command.timeSec !== undefined || !Number.isInteger(command.reps)) return fail('invalid');
        if (!isIntInRange(command.reps, L.repsMin, L.repsMax)) return fail('limit_exceeded');
        normalized.reps = command.reps;
    } else if (command.mode === 'time') {
        if (command.reps !== undefined || !Number.isInteger(command.timeSec)) return fail('invalid');
        if (!isIntInRange(command.timeSec, L.timeSecMin, L.timeSecMax)) return fail('limit_exceeded');
        normalized.timeSec = command.timeSec;
    } else {
        return fail('invalid');
    }
    return { ok: true, command: normalized };
}

export function validateCatalog(drills) {
    const L = REMOTE_LIMITS;
    if (!Array.isArray(drills) || drills.length > L.catalogMaxEntries) return fail('invalid');
    const normalized = [];
    for (const entry of drills) {
        if (!isPlainObject(entry) || !hasOnlyKeys(entry, ['key', 'label', 'levels'])) return fail('invalid');
        if (!isDrillKey(entry.key)) return fail('invalid');
        if (typeof entry.label !== 'string' || entry.label.length === 0 || entry.label.length > L.drillLabelMaxLength) return fail('invalid');
        if (!Array.isArray(entry.levels) || entry.levels.length === 0 ||
            !entry.levels.every(level => L.levels.includes(level))) return fail('invalid');
        normalized.push({ key: entry.key, label: entry.label, levels: [...new Set(entry.levels)].sort() });
    }
    return { ok: true, drills: normalized };
}

// Host -> controller status reports.
export function validateStatus(message) {
    if (!isPlainObject(message) || !hasOnlyKeys(message, ['type', 'state', 'seq', 'reason', 'drill'])) return fail('invalid');
    if (!HOST_STATES.includes(message.state)) return fail('invalid');
    if (message.seq !== undefined && !Number.isSafeInteger(message.seq)) return fail('invalid');
    if (message.drill !== undefined && !isDrillKey(message.drill)) return fail('invalid');
    if (message.reason !== undefined &&
        !(message.state === 'rejected' ? REJECT_REASONS : END_REASONS).includes(message.reason)) return fail('invalid');
    const status = { type: 'status', state: message.state };
    for (const key of ['seq', 'reason', 'drill']) if (message[key] !== undefined) status[key] = message[key];
    return { ok: true, status };
}

// Host-side gate for commands forwarded by the relay. Re-validates everything locally,
// rejects replayed or out-of-order sequence numbers, and turns the relay TTL into a local deadline.
// `stop` is always admitted: stopping must never be blocked by sequencing or expiry.
export function admitHostCommand(gate, message, now) {
    if (!isPlainObject(message) || message.type !== 'command') return fail('invalid');
    const validated = validateCommand(message.command);
    if (validated.ok && validated.command.name === 'stop') return { ok: true, command: validated.command, seq: message.seq };
    if (!Number.isSafeInteger(message.seq) || message.seq <= gate.lastSeq) return fail('replay');
    gate.lastSeq = message.seq;
    if (!validated.ok) return validated;
    if (!isIntInRange(message.ttlMs, 1, REMOTE_LIMITS.commandTtlMs)) return fail('invalid');
    return { ok: true, command: validated.command, seq: message.seq, deadline: now + message.ttlMs };
}

// Ball parameter layout: [topRpm, bottomRpm, height, drop, frequency, reps, active, ...].
export function drillWithinLimits(steps, { maxRpm, maxFrequency }) {
    if (!Array.isArray(steps) || steps.length === 0) return false;
    return steps.every(options => Array.isArray(options) && options.every(ball =>
        Array.isArray(ball) && ball[0] <= maxRpm && ball[1] <= maxRpm && ball[4] <= maxFrequency));
}
