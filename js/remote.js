// Onsite (host) side of a remote control session. The phone connected to the robot opens an
// outbound WebSocket to the relay, shares a single-use invite, and executes only allowlisted,
// locally re-validated and onsite-confirmed drill requests.
import { PROTOCOL_VERSION, REMOTE_LIMITS, admitHostCommand, drillWithinLimits, parseRelayUrl } from './remote-protocol.js';
import { REJECT_MESSAGES, SESSION_END_MESSAGES } from './locales/remote.js';
import { currentDrills, userCustomDrills, drillOrder } from './state.js';
import { RPM_MIN, RPM_MAX } from './constants.js';
import { bleState } from './bluetooth.js';
import { startDrillSequence, stopRun, activeRunSource } from './runner.js';
import { formatDrillName } from './ui.js';
import { log, showToast, clamp } from './utils.js';
import { t } from './i18n.js';

const RELAY_URL_KEY = 'nova_remote_relay';
const LIMITS_KEY = 'nova_remote_limits';

// Active session state, or null. Only one session at a time.
let session = null;
let statusKey = 'Remote control is off';

const $ = id => document.getElementById(id);

function loadLimits() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LIMITS_KEY)) || {}; } catch {}
    return {
        maxRpm: clamp(Number(saved.maxRpm) || RPM_MAX, RPM_MIN, RPM_MAX),
        maxFrequency: clamp(Number.isFinite(saved.maxFrequency) ? saved.maxFrequency : 100, 0, 100)
    };
}

let limits = loadLimits();

function send(message) {
    if (session?.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(message));
}

function sendStatus(state, extra = {}) {
    send({ type: 'status', state, ...extra });
}

function setStatus(key) {
    statusKey = key;
    renderStatus();
}

function renderStatus() {
    $('remote-status').textContent = t(statusKey);
    const active = session !== null;
    $('btn-remote-start').classList.toggle('hidden', active);
    $('btn-remote-end').classList.toggle('hidden', !active);
    $('remote-relay-url').disabled = active;
    $('remote-banner').classList.toggle('hidden', !active);
    $('remote-invite').classList.toggle('hidden', !session?.inviteUrl || session.controllerJoined);
    $('remote-invite-link').value = session?.inviteUrl || '';
}

function buildCatalog() {
    const entries = [];
    const add = (key, label) => {
        if (!Object.hasOwn(currentDrills, key) || entries.length >= REMOTE_LIMITS.catalogMaxEntries) return;
        const levels = REMOTE_LIMITS.levels.filter(level => drillWithinLimits(currentDrills[key][level], limits));
        if (levels.length === 0) return;
        if (key.length > REMOTE_LIMITS.drillKeyMaxLength) return;
        entries.push({ key, label: (label || key).slice(0, REMOTE_LIMITS.drillLabelMaxLength), levels });
    };
    for (const category of ['basic', 'combined', 'complex']) {
        for (const key of drillOrder[category] || []) add(key, formatDrillName(key));
    }
    for (const category of ['custom-a', 'custom-b', 'custom-c']) {
        for (const item of userCustomDrills[category] || []) add(item.key, item.name);
    }
    return entries;
}

function sendCatalog() {
    if (session?.sessionId) send({ type: 'catalog', drills: buildCatalog() });
}

function reject(seq, reason) {
    sendStatus('rejected', Number.isSafeInteger(seq) ? { seq, reason } : { reason });
    log(t('Remote request rejected: {reason}', { reason: t(REJECT_MESSAGES[reason]) }));
}

function describeCommand(command) {
    const label = buildCatalog().find(entry => entry.key === command.drill)?.label || command.drill;
    const amount = command.mode === 'reps'
        ? t('{reps} reps', { reps: command.reps })
        : t('{seconds} s', { seconds: command.timeSec });
    return t('{drill} · level {level} · {amount} · pause {pause} s', {
        drill: label, level: command.level, amount, pause: command.pauseSec
    });
}

function closeConfirmation() {
    $('remote-confirm-modal').classList.remove('open');
}

function cancelPending() {
    if (!session?.pending) return null;
    const pending = session.pending;
    clearInterval(pending.timer);
    session.pending = null;
    closeConfirmation();
    return pending;
}

function renderCountdown() {
    const pending = session?.pending;
    if (!pending) return;
    const seconds = Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000));
    $('remote-confirm-countdown').textContent = t('Expires in {seconds} s', { seconds });
    if (seconds === 0) {
        cancelPending();
        reject(pending.seq, 'timeout');
    }
}

function handleStop() {
    cancelPending();
    if (activeRunSource()) stopRun();
    sendStatus('ready');
    showToast(t('Stopped by remote controller'));
}

function handleCommand(message) {
    const admitted = admitHostCommand(session.gate, message, Date.now());
    if (!admitted.ok) return reject(message.seq, admitted.error);
    if (admitted.command.name === 'stop') return handleStop();

    const { command, seq, deadline } = admitted;
    if (session.pending || activeRunSource()) return reject(seq, 'busy');
    if (!bleState.isConnected) return reject(seq, 'not_connected');
    if (!Object.hasOwn(currentDrills, command.drill) || !currentDrills[command.drill][command.level]) {
        return reject(seq, 'unknown_drill');
    }
    if (!drillWithinLimits(currentDrills[command.drill][command.level], limits)) return reject(seq, 'limit_exceeded');

    session.pending = { seq, command, deadline, timer: setInterval(renderCountdown, 250) };
    $('remote-confirm-details').textContent = describeCommand(command);
    renderCountdown();
    $('remote-confirm-modal').classList.add('open');
    sendStatus('pending', { seq, drill: command.drill });
}

function acceptPending() {
    const pending = cancelPending();
    if (!pending) return;
    if (Date.now() > pending.deadline) return reject(pending.seq, 'timeout');
    if (activeRunSource()) return reject(pending.seq, 'busy');
    if (!bleState.isConnected) return reject(pending.seq, 'not_connected');
    const { drill, level, mode, reps, timeSec, pauseSec } = pending.command;
    if (!Object.hasOwn(currentDrills, drill) || !drillWithinLimits(currentDrills[drill][level], limits)) {
        return reject(pending.seq, 'limit_exceeded');
    }
    if (!startDrillSequence(drill, { level, mode, reps, timeSec, pauseSec, source: 'remote' })) {
        return reject(pending.seq, 'invalid');
    }
    session.runSeq = pending.seq;
    sendStatus('running', { seq: pending.seq, drill });
}

function declinePending() {
    const pending = cancelPending();
    if (pending) reject(pending.seq, 'declined');
}

async function acquireWakeLock() {
    try {
        const lock = await navigator.wakeLock?.request('screen');
        if (session && lock) session.wakeLock = lock;
        else lock?.release();
    } catch (error) {
        log(t('Screen wake lock unavailable: {error}', { error: error.message }));
    }
}

// Ends the local side of the session: drops pending requests and stops any remotely started run.
function teardown(reasonKey) {
    if (!session) return;
    const ended = session;
    cancelPending();
    session = null;
    if (activeRunSource() === 'remote') stopRun();
    ended.wakeLock?.release().catch(() => {});
    if (ended.ws.readyState === WebSocket.CONNECTING || ended.ws.readyState === WebSocket.OPEN) ended.ws.close();
    setStatus(reasonKey);
    showToast(t(reasonKey));
}

function handleMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    switch (message.type) {
        case 'session_created': {
            const invite = new URL('remote.html', location.href);
            invite.hash = new URLSearchParams({ relay: session.relayUrl, session: message.sessionId, invite: message.invite }).toString();
            session.sessionId = message.sessionId;
            session.inviteUrl = invite.href;
            setStatus('Waiting for remote controller');
            sendCatalog();
            break;
        }
        case 'controller_joined':
            session.controllerJoined = true;
            setStatus('Remote controller connected');
            showToast(t('Remote controller connected'));
            sendStatus('ready');
            break;
        case 'command':
            handleCommand(message);
            break;
        case 'session_ended':
            teardown(SESSION_END_MESSAGES[message.reason] || 'Remote session ended');
            break;
        case 'error':
            log(t('Relay error: {code}', { code: message.code }));
            break;
    }
}

function startSession() {
    if (session) return;
    const relayUrl = parseRelayUrl($('remote-relay-url').value);
    if (!relayUrl) {
        showToast(t('Enter a wss:// relay URL'));
        return;
    }
    localStorage.setItem(RELAY_URL_KEY, relayUrl);

    const ws = new WebSocket(relayUrl);
    session = {
        ws, relayUrl, sessionId: null, inviteUrl: null, controllerJoined: false,
        gate: { lastSeq: 0 }, pending: null, runSeq: null, wakeLock: null
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'host_create', version: PROTOCOL_VERSION }));
    ws.onmessage = handleMessage;
    ws.onclose = () => { if (session?.ws === ws) teardown('Relay connection lost'); };
    setStatus('Connecting to relay…');
    acquireWakeLock();
}

export function endRemoteSession() {
    if (!session) return;
    send({ type: 'end' });
    teardown('Remote session ended');
}

async function copyInvite() {
    if (!session?.inviteUrl) return;
    try {
        if (navigator.share) {
            await navigator.share({ title: t('Nova remote control'), url: session.inviteUrl });
        } else {
            await navigator.clipboard.writeText(session.inviteUrl);
            showToast(t('Invite link copied'));
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            $('remote-invite-link').select();
            showToast(t('Copy the link manually'));
        }
    }
}

function applyLimitInputs() {
    limits = {
        maxRpm: clamp(parseInt($('remote-max-rpm').value) || RPM_MAX, RPM_MIN, RPM_MAX),
        maxFrequency: clamp(parseInt($('remote-max-freq').value), 0, 100) || 0
    };
    $('remote-max-rpm').value = limits.maxRpm;
    $('remote-max-freq').value = limits.maxFrequency;
    localStorage.setItem(LIMITS_KEY, JSON.stringify(limits));
    sendCatalog();
}

export function openRemoteModal() {
    $('remote-modal').classList.add('open');
}

export function initRemoteHost() {
    $('remote-relay-url').value = localStorage.getItem(RELAY_URL_KEY) || '';
    $('remote-max-rpm').value = limits.maxRpm;
    $('remote-max-freq').value = limits.maxFrequency;
    $('remote-max-rpm').onchange = applyLimitInputs;
    $('remote-max-freq').onchange = applyLimitInputs;
    $('btn-remote-start').onclick = startSession;
    $('btn-remote-end').onclick = endRemoteSession;
    $('btn-remote-banner-end').onclick = endRemoteSession;
    $('btn-remote-copy').onclick = copyInvite;
    $('btn-remote-accept').onclick = acceptPending;
    $('btn-remote-decline').onclick = declinePending;
    $('remote-modal-close').onclick = () => $('remote-modal').classList.remove('open');

    document.addEventListener('run-ended', event => {
        if (event.detail.source !== 'remote' || !session) return;
        sendStatus('ended', { seq: session.runSeq, reason: event.detail.reason, drill: event.detail.drill });
        session.runSeq = null;
    });
    document.addEventListener('drills-updated', sendCatalog);
    document.addEventListener('language-changed', () => {
        renderStatus();
        sendCatalog();
    });
    // A backgrounded page may be suspended and unable to deliver a stop, so leaving it ends the session.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && session) {
            send({ type: 'end' });
            teardown('Remote session ended because the page was hidden');
        }
    });
    renderStatus();
}
