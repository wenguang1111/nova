// Remote controller page: joins a session with a single-use invite and sends allowlisted commands.
import { PROTOCOL_VERSION, REMOTE_LIMITS, parseRelayUrl, validateCommand } from './remote-protocol.js';
import { REJECT_MESSAGES, SESSION_END_MESSAGES, RELAY_ERROR_MESSAGES } from './locales/remote.js';
import { initLanguage, t } from './i18n.js';
import { log, showToast } from './utils.js';

const $ = id => document.getElementById(id);

let ws = null;
let joined = false;
let ended = false;
let busy = false;
let seq = 0;
let catalog = [];
let status = { key: 'Connecting to relay…', values: {} };

function setStatus(key, values = {}) {
    status = { key, values };
    $('controller-status').textContent = t(key, values);
    log(t(key, values));
}

function updateControls() {
    const open = joined && !ended && ws?.readyState === WebSocket.OPEN;
    $('ctl-stop').disabled = !open;
    $('ctl-request').disabled = !open || busy || catalog.length === 0;
}

function labelFor(key) {
    return catalog.find(entry => entry.key === key)?.label || key;
}

function renderLevels() {
    const entry = catalog.find(item => item.key === $('ctl-drill').value);
    const select = $('ctl-level');
    const previous = Number(select.value);
    select.replaceChildren(...(entry?.levels || []).map(level => {
        const option = document.createElement('option');
        option.value = String(level);
        option.textContent = String(level);
        return option;
    }));
    if (entry?.levels.includes(previous)) select.value = String(previous);
}

function renderCatalog(drills) {
    catalog = drills;
    const select = $('ctl-drill');
    const previous = select.value;
    select.replaceChildren(...drills.map(entry => {
        const option = document.createElement('option');
        option.value = entry.key;
        option.textContent = entry.label;
        return option;
    }));
    if (drills.some(entry => entry.key === previous)) select.value = previous;
    renderLevels();
    updateControls();
}

function renderMode() {
    const time = $('ctl-mode').value === 'time';
    $('ctl-reps-field').classList.toggle('hidden', time);
    $('ctl-time-field').classList.toggle('hidden', !time);
}

function send(command) {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    seq += 1;
    ws.send(JSON.stringify({ type: 'command', seq, command }));
    return true;
}

function requestStart() {
    const mode = $('ctl-mode').value;
    const command = {
        name: 'run_drill',
        drill: $('ctl-drill').value,
        level: Number($('ctl-level').value),
        mode,
        pauseSec: Number($('ctl-pause').value)
    };
    if (mode === 'reps') command.reps = Number($('ctl-reps').value);
    else command.timeSec = Number($('ctl-time').value);

    const result = validateCommand(command);
    if (!result.ok) {
        showToast(t('Values out of range: count {repsMin}-{repsMax}, time {timeMin}-{timeMax} s, pause {pauseMin}-{pauseMax} s', {
            repsMin: REMOTE_LIMITS.repsMin, repsMax: REMOTE_LIMITS.repsMax,
            timeMin: REMOTE_LIMITS.timeSecMin, timeMax: REMOTE_LIMITS.timeSecMax,
            pauseMin: REMOTE_LIMITS.pauseSecMin, pauseMax: REMOTE_LIMITS.pauseSecMax
        }));
        return;
    }
    if (send(result.command)) {
        busy = true;
        setStatus('Request sent');
        updateControls();
    }
}

function handleStatus(message) {
    const drill = message.drill ? labelFor(message.drill) : '';
    switch (message.state) {
        case 'ready':
            busy = false;
            setStatus('Robot ready');
            break;
        case 'pending':
            busy = true;
            setStatus('Waiting for onsite confirmation: {drill}', { drill });
            break;
        case 'rejected':
            busy = false;
            setStatus(REJECT_MESSAGES[message.reason] || 'Invalid request');
            break;
        case 'running':
            busy = true;
            setStatus('Running: {drill}', { drill });
            break;
        case 'ended':
            busy = false;
            setStatus(message.reason === 'finished' ? 'Drill finished: {drill}' : 'Drill stopped: {drill}', { drill });
            break;
    }
    updateControls();
}

function handleMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    switch (message.type) {
        case 'joined':
            joined = true;
            setStatus('Connected. Waiting for the robot phone…');
            break;
        case 'catalog':
            if (Array.isArray(message.drills)) renderCatalog(message.drills);
            break;
        case 'status':
            handleStatus(message);
            break;
        case 'error':
            if (message.code !== 'invalid_invite') busy = false;
            setStatus(RELAY_ERROR_MESSAGES[message.code] || 'Relay error: {code}', { code: message.code });
            break;
        case 'session_ended':
            ended = true;
            setStatus(SESSION_END_MESSAGES[message.reason] || 'Remote session ended');
            break;
    }
    updateControls();
}

function connect() {
    const params = new URLSearchParams(location.hash.slice(1));
    // Drop the invite from the address bar and history; it only lives in memory from here on.
    history.replaceState(null, '', location.pathname + location.search);
    const relayUrl = parseRelayUrl(params.get('relay') || '');
    const sessionId = params.get('session');
    const invite = params.get('invite');
    if (!relayUrl || !sessionId || !invite) {
        setStatus('Invalid invite link');
        return;
    }
    setStatus('Connecting to relay…');
    ws = new WebSocket(relayUrl);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', version: PROTOCOL_VERSION, sessionId, invite }));
    ws.onmessage = handleMessage;
    ws.onclose = () => {
        if (!ended) {
            ended = true;
            setStatus(joined ? 'Connection lost. Ask the onsite person for a new invite.' : 'Could not join. The invite may be used or expired.');
        }
        updateControls();
    };
}

document.addEventListener('DOMContentLoaded', () => {
    initLanguage();
    $('ctl-drill').onchange = renderLevels;
    $('ctl-mode').onchange = renderMode;
    $('ctl-request').onclick = requestStart;
    $('ctl-stop').onclick = () => {
        if (send({ name: 'stop' })) setStatus('Stop sent');
    };
    document.addEventListener('language-changed', () => {
        $('controller-status').textContent = t(status.key, status.values);
    });
    renderMode();
    connect();
});
