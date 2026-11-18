import { DEFAULT_DRILLS, RPM_MIN, RPM_MAX, SPIN_LIMITS, CATEGORIES } from './constants.js';
import { showToast } from './utils.js';
import { t } from './i18n.js';

export let currentDrills = {};
export let userCustomDrills = { "custom-a": [], "custom-b": [], "custom-c": [] };
export let drillOrder = JSON.parse(JSON.stringify(CATEGORIES)); 
export let selectedLevel = 1;
export let runMode = "reps";
export let appStats = { balls: 0, drills: 0 };

// --- NEW: Session Summary State ---
let sessionSnapshot = { balls: 0, drills: 0 };
let sessionStartTime = 0;

export function startSession() {
    sessionSnapshot.balls = appStats.balls;
    sessionSnapshot.drills = appStats.drills;
    sessionStartTime = Date.now();
}

export function getSessionSummary() {
    const durationMs = sessionStartTime > 0 ? (Date.now() - sessionStartTime) : 0;
    
    return {
        balls: appStats.balls - sessionSnapshot.balls,
        drills: appStats.drills - sessionSnapshot.drills,
        duration: durationMs
    };
}
// ----------------------------------

// --- NEW: Last Played State ---
export let lastPlayedDrill = localStorage.getItem('nova_last_played');

export function setLastPlayed(key) {
    lastPlayedDrill = key;
    localStorage.setItem('nova_last_played', key);
}
// ------------------------------

export function initData() {
    const savedTheme = localStorage.getItem('nova_theme_pref');
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
    const savedStats = localStorage.getItem('nova_stats');
    if (savedStats) { try { appStats = JSON.parse(savedStats); } catch(e){} }

    const savedDrills = localStorage.getItem('custom_drills');
    const userDefaults = localStorage.getItem('user_defaults');
    const customData = localStorage.getItem('custom_data');
    
    const savedOrder = localStorage.getItem('drill_order');
    if (savedOrder) {
        try {
            const parsedOrder = JSON.parse(savedOrder);
            ['basic', 'combined', 'complex'].forEach(cat => {
                if(parsedOrder[cat]) drillOrder[cat] = parsedOrder[cat];
            });
        } catch(e) { console.error(t("Error loading drill order"), e); }
    }

    currentDrills = savedDrills ? JSON.parse(savedDrills) : 
                   (userDefaults ? JSON.parse(userDefaults) : JSON.parse(JSON.stringify(DEFAULT_DRILLS)));
    if (customData) userCustomDrills = JSON.parse(customData);
    normalizeDrills();
}

function normalizeDrills() {
    for (let key in currentDrills) {
        if(key === 'random') continue; 
        for (let lvl = 1; lvl <= 3; lvl++) {
            if (currentDrills[key] && currentDrills[key][lvl]) {
                const steps = currentDrills[key][lvl];
                currentDrills[key][lvl] = steps.map(step => {
                    if (step.length > 0 && typeof step[0] === 'number') return [step];
                    return step;
                });
            }
        }
    }
}

export function setLevel(lvl) { selectedLevel = lvl; }
export function setMode(mode) { runMode = mode; }
export function saveDrillsToStorage() { localStorage.setItem('custom_drills', JSON.stringify(currentDrills)); }

export function saveDrillOrder() {
    localStorage.setItem('drill_order', JSON.stringify(drillOrder));
}

export function saveAsDefault() {
    if(confirm(t("Save current settings as your new personal default?"))) {
        localStorage.setItem('user_defaults', JSON.stringify(currentDrills));
        showToast(t("Saved as Default"));
    }
}
export function resetToDefault() {
    const hasUserDefault = localStorage.getItem('user_defaults');
    if(confirm(t(hasUserDefault ? "Restore saved defaults?" : "Restore factory settings?"))) {
        currentDrills = hasUserDefault ? JSON.parse(hasUserDefault) : JSON.parse(JSON.stringify(DEFAULT_DRILLS));
        drillOrder = JSON.parse(JSON.stringify(CATEGORIES));
        localStorage.removeItem('drill_order');
        normalizeDrills();
        localStorage.setItem('custom_drills', JSON.stringify(currentDrills));
        showToast(t("Restored"));
        document.dispatchEvent(new CustomEvent('drills-updated'));
    }
}
export function factoryReset() {
    if(confirm(t("WARNING: Delete ALL saved data and return to original factory state?"))) {
        localStorage.clear();
        location.reload();
    }
}
export function resetStats() {
    if(confirm(t("Reset stats?"))) {
        appStats.balls = 0; appStats.drills = 0;
        localStorage.setItem('nova_stats', JSON.stringify(appStats));
        showToast(t("Statistics Reset"));
        document.dispatchEvent(new CustomEvent('stats-updated'));
    }
}

// --- Helper Functions ---

function calculateRPMs(speed, spin, type) {
    const baseSpeed = 970 + (630.5 * speed);
    const spinFactor = 342 * spin;
    let top, bot;
    if (type === 'top') { top = baseSpeed + spinFactor; bot = baseSpeed - spinFactor; } 
    else { top = baseSpeed - spinFactor; bot = baseSpeed + spinFactor; }
    return { top: Math.max(RPM_MIN, Math.min(RPM_MAX, Math.round(top))), bot: Math.max(RPM_MIN, Math.min(RPM_MAX, Math.round(bot))) };
}

function reverseCalculate(top, bot) {
    const type = top >= bot ? 'top' : 'back';
    const baseSpeed = (top + bot) / 2;
    const speedRaw = (baseSpeed - 970) / 630.5;
    const diff = Math.abs(top - bot) / 2;
    const spinRaw = diff / 342;
    return { speed: Math.round(speedRaw * 2) / 2, spin: Math.round(spinRaw * 2) / 2, type: type };
}

function formatNameForKey(key) {
    return key.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// --- IMPORT FUNCTION (Closes Menu on Success) ---
export function importCustomDrills(csvText) {
    try {
        const lines = csvText.split(/\r?\n/);
        const newCustomData = { "custom-a": [], "custom-b": [], "custom-c": [] };
        
        for (let cat in userCustomDrills) {
            userCustomDrills[cat].forEach(drill => { if (currentDrills[drill.key]) delete currentDrills[drill.key]; });
        }

        const customBuilder = {}; 
        const factoryBuilder = {}; 

        const getCatKey = (val) => {
            val = val.trim().toUpperCase();
            if(val === 'A') return 'custom-a';
            if(val === 'B') return 'custom-b';
            if(val === 'C') return 'custom-c';
            if(val === 'BASIC') return 'basic';
            if(val === 'COMBINED') return 'combined';
            if(val === 'COMPLEX') return 'complex';
            return null;
        };

        lines.forEach((line, index) => {
            if (!line.trim() || (index === 0 && line.toLowerCase().includes('speed;spin'))) return;
            const parts = line.split(line.includes(';') ? ';' : ',');
            if (parts.length < 10) return;

            const setVal = parts[0].trim();
            const category = getCatKey(setVal);
            if (!category) return;

            const ballNum = parseFloat(parts[1]); 
            let nameRaw = parts[2].trim();
            
            const speed = parseFloat(parts[3]);
            let spin = parseFloat(parts[4]);
            const type = parts[5].trim().toLowerCase(); 

            const maxAllowed = SPIN_LIMITS[speed.toString()] ?? 10;
            if (spin > maxAllowed) spin = maxAllowed;

            const height = parseInt(parts[6]);
            const drop = parseFloat(parts[7]);
            
            const bpm = parseInt(parts[8]);
            const freqPercent = (bpm - 30) / 0.6;
            
            const reps = parseInt(parts[9]);

            const motors = calculateRPMs(speed, spin, type);
            const params = [motors.top, motors.bot, height, drop, freqPercent, reps, 1, speed, spin, type];

            if (category.startsWith('custom')) {
                const name = nameRaw.substring(0, 40);
                const key = `cust_${category.split('-')[1].toUpperCase()}_${name.replace(/\s+/g, '_')}`;

                if (!customBuilder[key]) {
                    let exists = newCustomData[category].find(d => d.key === key);
                    
                    // UPDATED LIMIT: 100
                    if (!exists && newCustomData[category].length < 100) {
                        newCustomData[category].push({ name: name, key: key });
                    }
                    
                    customBuilder[key] = { 1: {}, 2: {}, 3: {} }; 
                }
                for(let lvl=1; lvl<=3; lvl++) {
                    if (!customBuilder[key][lvl]) customBuilder[key][lvl] = {};
                    if (!customBuilder[key][lvl][ballNum]) customBuilder[key][lvl][ballNum] = [];
                    customBuilder[key][lvl][ballNum].push(params);
                }
            } else {
                const lvlMatch = nameRaw.match(/\(Lvl (\d)\)$/i);
                let level = 1;
                let realName = nameRaw;
                
                if (lvlMatch) {
                    level = parseInt(lvlMatch[1]);
                    realName = nameRaw.replace(lvlMatch[0], '').trim();
                }
                const key = realName.toLowerCase().replace(/ /g, '-');
                
                if (!factoryBuilder[key]) factoryBuilder[key] = {};
                if (!factoryBuilder[key][level]) factoryBuilder[key][level] = {};
                
                if (!factoryBuilder[key][level][ballNum]) factoryBuilder[key][level][ballNum] = [];
                factoryBuilder[key][level][ballNum].push(params);
            }
        });

        for (let key in customBuilder) {
            currentDrills[key] = {};
            for(let lvl=1; lvl<=3; lvl++) {
                const sortedBalls = Object.keys(customBuilder[key][lvl]).sort((a,b) => parseFloat(a)-parseFloat(b));
                currentDrills[key][lvl] = sortedBalls.map(bKey => customBuilder[key][lvl][bKey]);
            }
        }
        userCustomDrills = newCustomData;

        for (let key in factoryBuilder) {
            if (!currentDrills[key]) currentDrills[key] = {};
            for (let lvl in factoryBuilder[key]) {
                const ballsObj = factoryBuilder[key][lvl];
                const sortedBalls = Object.keys(ballsObj).sort((a,b) => parseFloat(a)-parseFloat(b));
                currentDrills[key][lvl] = sortedBalls.map(bKey => ballsObj[bKey]);
            }
        }

        localStorage.setItem('custom_data', JSON.stringify(userCustomDrills));
        saveDrillsToStorage();
        showToast(t("Imported Successfully"));
        
        // --- NEW: CLOSE MENU ON SUCCESS ---
        const menu = document.getElementById('theme-menu');
        if(menu) menu.classList.remove('open');
        
        return true;
    } catch(e) { console.error(e); showToast(t("Import Failed")); return false; }
}

// --- EXPORT FUNCTION (Closes Menu on Success) ---
export const CSV_HEADER = "Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps\n";

export function drillToCsvRows(setLabel, name, sequence) {
    let rows = "";
    sequence.forEach((stepOptions, stepIndex) => {
        const ballNum = stepIndex + 1;
        stepOptions.forEach(ball => {
            let speed = ball[7], spin = ball[8], type = ball[9];
            if (speed === undefined) {
                const rev = reverseCalculate(ball[0], ball[1]);
                speed = rev.speed; spin = rev.spin; type = rev.type;
            }
            const bpm = Math.round(30 + (ball[4] * 0.6));
            rows += [setLabel, ballNum, name, speed, spin, type, ball[2], ball[3], bpm, ball[5]].join(";") + "\n";
        });
    });
    return rows;
}

export function exportCustomDrills() {
    let csvContent = CSV_HEADER;

    const appendDrillToCSV = (setLabel, name, sequence) => {
        csvContent += drillToCsvRows(setLabel, name, sequence);
    };

    ['basic', 'combined', 'complex'].forEach(cat => {
        const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
        if (drillOrder[cat]) {
            drillOrder[cat].forEach(key => {
                if (!currentDrills[key]) return;
                for(let lvl=1; lvl<=3; lvl++) {
                    if (currentDrills[key][lvl] && currentDrills[key][lvl].length > 0) {
                        const nameWithLevel = `${formatNameForKey(key)} (Lvl ${lvl})`;
                        appendDrillToCSV(catLabel, nameWithLevel, currentDrills[key][lvl]);
                    }
                }
            });
        }
    });

    const cats = { 'custom-a': 'A', 'custom-b': 'B', 'custom-c': 'C' };
    for (let catKey in cats) {
        const setLabel = cats[catKey];
        const drillList = userCustomDrills[catKey];
        if(drillList && drillList.length > 0) {
            drillList.forEach(drill => {
                const sequence = currentDrills[drill.key] ? currentDrills[drill.key][1] : null; 
                if (sequence) {
                    appendDrillToCSV(setLabel, drill.name, sequence);
                }
            });
        }
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "nova_drills_full.csv";
    link.click();
    
    // --- NEW: CLOSE MENU ON SUCCESS ---
    const menu = document.getElementById('theme-menu');
    if(menu) menu.classList.remove('open');
}

// --- IMPORT SHARED DRILLS (from the Drive collection) ---

const finite = (v, min, max) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

// Parses one shared CSV (same format as export) into a ball sequence. Values come from
// an untrusted source, so every field is clamped to the editor's own limits.
function parseSharedCsv(csv) {
    const steps = new Map();
    csv.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim() || index === 0) return;
        const parts = line.split(';');
        if (parts.length < 10) return;
        const ballNum = parseInt(parts[1]);
        const type = parts[5].trim().toLowerCase() === 'back' ? 'back' : 'top';
        const speed = finite(parseFloat(parts[3]), 0, 10);
        const spin = Math.min(finite(parseFloat(parts[4]), 0, 10), SPIN_LIMITS[speed.toString()] ?? 10);
        const height = finite(parseInt(parts[6]), -50, 100);
        const drop = finite(parseFloat(parts[7]), -10, 10);
        const freqPercent = finite((parseInt(parts[8]) - 30) / 0.6, 0, 100);
        const reps = finite(parseInt(parts[9]), 1, 200);
        const motors = calculateRPMs(speed, spin, type);
        if (!steps.has(ballNum)) steps.set(ballNum, []);
        steps.get(ballNum).push([motors.top, motors.bot, height, drop, freqPercent, reps, 1, speed, spin, type]);
    });
    return [...steps.keys()].sort((a, b) => a - b).map(k => steps.get(k));
}

// Appends the drills to a custom bank. Existing drills are never replaced.
// Returns { added, skipped } where skipped counts drills that did not fit or were unreadable.
export function importSharedDrills(items, category) {
    const catChar = category.split('-')[1].toUpperCase();
    let added = 0, skipped = 0;

    items.forEach((item, i) => {
        const sequence = parseSharedCsv(item.csv);
        if (sequence.length === 0 || userCustomDrills[category].length >= 100) { skipped++; return; }

        const base = String(item.name).substring(0, 40);
        const taken = new Set(userCustomDrills[category].map(d => d.name));
        let name = base;
        for (let n = 1; taken.has(name); n++) {
            const suffix = n === 1 ? ' (Imp)' : ` (Imp${n})`;
            name = base.substring(0, 40 - suffix.length) + suffix;
        }

        const key = `cust_${catChar}_${name.replace(/\s+/g, '_')}_${Date.now()}_${i}`;
        userCustomDrills[category].push({ name, key });
        currentDrills[key] = { 1: sequence, 2: JSON.parse(JSON.stringify(sequence)), 3: JSON.parse(JSON.stringify(sequence)) };
        added++;
    });

    localStorage.setItem('custom_data', JSON.stringify(userCustomDrills));
    saveDrillsToStorage();
    document.dispatchEvent(new CustomEvent('drills-updated'));
    return { added, skipped };
}