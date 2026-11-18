import { currentDrills, selectedLevel, runMode, appStats, setLastPlayed } from './state.js';
import { sendPacket, packBall, bleState } from './bluetooth.js';
import { log, showToast, clamp, toggleBodyScroll } from './utils.js';
import { updateStatsUI, updateLastPlayedHighlight } from './ui.js';
import { t } from './i18n.js';

let isRunning = false;
let isPaused = false;
let currentCount = 0;
let targetCount = 0;
let remainingTime = 0;
let showingGo = false;

// Timers
let pauseTimer = null;
let countdownTimer = null;
let runTimer = null;
let startTimeout = null; // --- ADDED: Track the start delay

let activeDrillParams = null;
let activeDrillRandom = false;
// Settings of the run in progress (null when idle): { drill, level, mode, reps, timeSec, pauseSec, source }.
let runConfig = null;

// Keep the screen on while a countdown or run is active. If the phone dims or locks, the
// browser suspends this page and the run stalls (the robot then just sits idle).
let wakeLock = null;

async function acquireWakeLock() {
    if (wakeLock) return;
    try {
        if (!navigator.wakeLock) throw new Error('not supported by this browser');
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (error) {
        log(t('Screen wake lock unavailable: {error}', { error: error.message }));
    }
}

function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    lock?.release().catch(() => {});
}

// The browser drops the lock whenever the page is hidden; take it again when it returns.
document.addEventListener('visibilitychange', () => {
    if (!runConfig) return;
    if (document.hidden) log('Page hidden during run: the browser may suspend it');
    else acquireWakeLock();
});

// UI Elements (Cached for performance)
const ui = {
    overlay: document.getElementById('run-overlay'),
    display: document.getElementById('run-display'),
    label: document.getElementById('run-label'),
    progress: document.getElementById('run-progress'),
    btnPause: document.getElementById('btn-pause')
};

document.addEventListener('language-changed', () => {
    if (!ui.overlay.classList.contains('open')) return;
    ui.label.textContent = t(isRunning ? "REMAINING" : "GET READY");
    ui.btnPause.textContent = t(isPaused ? "RESUME" : "PAUSE");
    if (!isRunning && showingGo) ui.display.textContent = t("GO!");
});

// Run settings taken from the local controls.
export function localRunConfig() {
    const pauseInput = parseFloat(document.getElementById('input-pause').value);
    return {
        level: selectedLevel,
        mode: runMode,
        reps: parseInt(document.getElementById('input-reps').value) || 1,
        timeSec: parseInt(document.getElementById('input-time').value),
        pauseSec: isNaN(pauseInput) ? 1.0 : pauseInput,
        source: 'local'
    };
}

// 'local', 'remote', or null when no countdown or run is in progress.
export function activeRunSource() {
    return runConfig ? runConfig.source : null;
}

// Returns true when the countdown started.
export function startDrillSequence(drillName, config = localRunConfig()) {
    const rawParams = Object.hasOwn(currentDrills, drillName) ? currentDrills[drillName][config.level] : null;
    if(!rawParams) {
         log(t("Drill data not found: {name}", { name: drillName }));
         return false;
    }

    // --- FILTER INACTIVE STEPS ---
    const executableSteps = rawParams.filter(step => {
        const isActive = step[0][6]; 
        return isActive === undefined || isActive === 1;
    });

    if (executableSteps.length === 0) {
        showToast(t("no active balls to play"));
        document.querySelectorAll('.btn-drill').forEach(b => b.classList.remove('running'));
        return false;
    }
    
    runConfig = { ...config, drill: drillName };
    activeDrillParams = executableSteps;
    activeDrillRandom = !!currentDrills[drillName].random;
    
    // --- NEW: SAVE LAST PLAYED STATE ---
    setLastPlayed(drillName);
    updateLastPlayedHighlight();

    // --- LOCK SCROLL ON START ---
    toggleBodyScroll(true);
    acquireWakeLock();
    ui.overlay.classList.add('open');
    
    showingGo = false;
    let count = 4;
    ui.display.textContent = count;
    ui.label.textContent = t("GET READY");
    ui.btnPause.style.display = 'none';
    
    ui.progress.style.transition = 'none';
    ui.progress.style.strokeDashoffset = '0';
    void ui.progress.offsetWidth; 
    
    requestAnimationFrame(() => {
        ui.progress.style.transition = 'stroke-dashoffset 4s linear';
        ui.progress.style.strokeDashoffset = '565'; 
    });

    countdownTimer = setInterval(() => {
        count--;
        if (count > 0) {
            ui.display.textContent = count;
        } else {
            clearInterval(countdownTimer);
            showingGo = true;
            ui.display.textContent = t("GO!");
            // --- UPDATED: Store timeout to allow cancelling ---
            startTimeout = setTimeout(beginDrillExecution, 800);
        }
    }, 1000);
    return true;
}

export function beginDrillExecution() {
    isRunning = true;
    isPaused = false;
    
    // --- FIX: Increment Drill Count ONCE per session, not per rep ---
    appStats.drills += 1;
    localStorage.setItem('nova_stats', JSON.stringify(appStats));
    updateStatsUI();
    // ---------------------------------------------------------------

    ui.btnPause.style.display = 'block';
    ui.btnPause.textContent = t("PAUSE");
    ui.btnPause.classList.remove('pulse-anim');
    ui.label.textContent = t("REMAINING");

    ui.progress.style.transition = 'none';
    ui.progress.style.strokeDashoffset = '0';

    if (runConfig.mode === 'time') {
        remainingTime = runConfig.timeSec;
        ui.display.textContent = formatTime(remainingTime);
        
        requestAnimationFrame(() => {
             if(isRunning && !isPaused) {
                 ui.progress.style.transition = `stroke-dashoffset ${remainingTime}s linear`;
                 ui.progress.style.strokeDashoffset = '565';
             }
        });

        runTimer = setInterval(() => {
            if (!isPaused) {
                remainingTime--;
                ui.display.textContent = formatTime(remainingTime);
                if (remainingTime <= 0) stopRun('finished');
            }
        }, 1000);
    } else {
        targetCount = runConfig.reps;
        currentCount = 0;
        ui.display.textContent = targetCount;
        ui.progress.style.transition = 'stroke-dashoffset 0.5s ease';
    }
    
    runIteration();
}

async function runIteration() {
    if(!isRunning || isPaused) return;

    if (runConfig.mode === 'reps') {
        const remaining = targetCount - currentCount;
        ui.display.textContent = remaining;
        
        const fractionCompleted = currentCount / targetCount;
        ui.progress.style.strokeDashoffset = 565 * fractionCompleted;
        currentCount++;
    }

    let sequence = activeDrillParams; 
    if (activeDrillRandom) {
        sequence = [...activeDrillParams]; 
        for (let i = sequence.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
        }
    }

    const balls = [];
    sequence.forEach((stepOptions, i) => {
        const chosenOption = stepOptions[Math.floor(Math.random() * stepOptions.length)];
        const tempBall = [...chosenOption];

        const scatter = tempBall[10] || 0;
        if (scatter > 0) {
            const currentDrop = tempBall[3];
            const minDrop = currentDrop - scatter;
            const maxDrop = currentDrop + scatter;
            const span = maxDrop - minDrop;
            const steps = Math.floor(span / 0.5);
            
            if (steps > 0) {
                const randomStep = Math.floor(Math.random() * (steps + 1));
                let newDrop = minDrop + (randomStep * 0.5);
                newDrop = clamp(newDrop, -10, 10);
                tempBall[3] = newDrop;
                log(t("Scatter Active: Base {base} ±{scatter} -> {drop}", { base: currentDrop, scatter, drop: newDrop }));
            }
        }

        log(t("TX Ball {number}: {values}", { number: i + 1, values: tempBall.join(' ') }));
        balls.push(packBall(...tempBall));
    });

    // --- FIX: Only increment BALLS here ---
    appStats.balls += balls.length;
    localStorage.setItem('nova_stats', JSON.stringify(appStats));
    updateStatsUI();
    // --------------------------------------

    const packet = buildPacket(balls);
    await sendPacket(packet);
}

// Callback from bluetooth.js when robot finishes
export function handleDone() {
    if(!isRunning) return;
    
    log(`BLE: robot done (rep ${currentCount}/${targetCount})`);
    if (runConfig.mode === 'reps' && currentCount >= targetCount) {
        stopRun('finished');
        return;
    }
    
    const pauseMs = runConfig.pauseSec * 1000;

    if (!isPaused) {
         // A repeated "done" notification must not schedule a second iteration.
         clearTimeout(pauseTimer);
         pauseTimer = setTimeout(() => { 
             if(isRunning && !isPaused) runIteration(); 
         }, pauseMs);
    }
}

export function togglePause() {
    if (isPaused) {
        isPaused = false;
        ui.btnPause.textContent = t("PAUSE");
        ui.btnPause.classList.remove('pulse-anim');
        
        if(runMode === 'time') {
             ui.progress.style.transition = `stroke-dashoffset ${remainingTime}s linear`;
             ui.progress.style.strokeDashoffset = '565';
        }
        runIteration(); 
    } else {
        isPaused = true;
        ui.btnPause.textContent = t("RESUME");
        ui.btnPause.classList.add('pulse-anim');
        clearTimeout(pauseTimer);
        
        const computedStyle = window.getComputedStyle(ui.progress);
        const currentOffset = computedStyle.getPropertyValue('stroke-dashoffset');
        ui.progress.style.transition = 'none';
        ui.progress.style.strokeDashoffset = currentOffset;
        
        sendPacket([0x80,1,0,1]); 
    }
}

// `reason` is 'finished' when the run completed on its own, otherwise 'stopped'.
export function stopRun(reason = 'stopped') {
    const endedRun = runConfig;
    runConfig = null;
    isRunning = false;
    isPaused = false;
    clearInterval(countdownTimer);
    clearInterval(runTimer);
    clearTimeout(pauseTimer);
    clearTimeout(startTimeout); // --- ADDED: Clear start delay on stop
    
    // --- UNLOCK SCROLL ON STOP ---
    toggleBodyScroll(false);
    releaseWakeLock();
    ui.overlay.classList.remove('open');
    document.querySelectorAll('.btn-drill').forEach(b => b.classList.remove('running'));
    
    sendPacket([0x80,1,0,1]).catch(() => {}); // Stop command (rejects if the robot already disconnected)
    log(t("Drill Stopped"));
    if (endedRun) {
        document.dispatchEvent(new CustomEvent('run-ended', {
            detail: { source: endedRun.source, drill: endedRun.drill, reason }
        }));
    }
}

// --- NEW FUNCTION: Skip Countdown ---
export function skipCountdown() {
    // Only execute if NOT running and overlay IS open (i.e., we are in countdown state)
    if (isRunning) return;
    if (!ui.overlay.classList.contains('open')) return;
    
    // Cancel any pending start mechanisms
    clearInterval(countdownTimer);
    clearTimeout(startTimeout);
    
    // Visual feedback
    showingGo = true;
    ui.display.textContent = t("GO!");
    
    // Start immediately
    beginDrillExecution();
}

function formatTime(s) {
    return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;
}

function buildPacket(balls) {
    const b = new ArrayBuffer(7 + balls.length*24);
    const v = new DataView(b);
    v.setUint8(0, 0x81); v.setUint16(1, 4+balls.length*24, true);
    v.setUint8(3, 1); v.setUint16(4, 1, true); v.setUint8(6, 0);
    const u = new Uint8Array(b);
    let off = 7;
    balls.forEach(ba => { u.set(ba, off); off+=24; });
    return u;
}