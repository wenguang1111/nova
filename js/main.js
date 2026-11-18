import { 
    initData, 
    setLevel, 
    setMode, 
    resetStats, 
    importCustomDrills, 
    importSharedDrills, 
    exportCustomDrills, 
    saveAsDefault, 
    resetToDefault, 
    factoryReset,
    appStats,
    userCustomDrills,
    currentDrills,
    saveDrillsToStorage,
    selectedLevel 
} from './state.js';

import { 
    connectDevice, 
    disconnectDevice, 
    bleState 
} from './bluetooth.js';

import { 
    openEditor, 
    closeEditor, 
    saveDrillChanges 
} from './editor.js';

import { 
    renderDrillButtons, 
    updateDrillButtonStates, 
    setTheme, 
    toggleMenu, 
    switchTab, 
    updateStatsUI,
    showSessionSummary 
} from './ui.js';

import { showToast } from './utils.js';

import { 
    startDrillSequence, 
    stopRun, 
    togglePause,
    skipCountdown // <--- ADDED IMPORT
} from './runner.js';

import { listSharedDrills, fetchSharedDrills } from './cloud.js';
import { initLanguage, t } from './i18n.js';
import { initRemoteHost, openRemoteModal } from './remote.js';

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
    initLanguage();
    initData();
    renderDrillButtons();
    updateStatsUI();
    setupEventListeners();
    initRemoteHost();
    console.log("Nova Drill Control: Modules Loaded");
});

// --- Event Listeners Setup ---

function setupEventListeners() {
    const btnConnect = document.getElementById('btn-connect');
    if (btnConnect) {
        btnConnect.onclick = () => {
            if (bleState.isConnected) {
                disconnectDevice();
                showSessionSummary(); 
            }
            else connectDevice();
        };
    }

    const inputPause = document.getElementById('input-pause');
    if (inputPause) {
        inputPause.onchange = (e) => {
            // Updated Logic: Seconds (0.0 - 5.0) with 0.1 step
            let val = parseFloat(e.target.value);
            if(isNaN(val)) val = 1.0;
            
            // Allow down to 0, max 5
            if(val < 0) val = 0; 
            if(val > 5.0) val = 5.0;
            
            e.target.value = val.toFixed(1);
        };
    }

    // --- NEW: Tap to Skip Countdown ---
    const runDisplay = document.getElementById('run-display');
    if (runDisplay) {
        runDisplay.onclick = () => {
            skipCountdown();
        };
    }
    // ----------------------------------

    document.addEventListener('click', (e) => {
        const menu = document.getElementById('theme-menu');
        if (menu && menu.classList.contains('open') && 
            !menu.contains(e.target) && 
            !e.target.closest('.menu-btn')) {
            menu.classList.remove('open');
        }
    });

    document.addEventListener('drills-updated', () => {
        renderDrillButtons();
        updateDrillButtonStates();
    });
    
    // --- ADDED: Listen for stats reset ---
    document.addEventListener('stats-updated', () => {
        updateStatsUI();
    });
    
    document.addEventListener('connection-changed', () => {
        updateDrillButtonStates();
        const editorModal = document.getElementById('editor-modal');
        if(editorModal && editorModal.classList.contains('open')) {
            const testBtns = document.querySelectorAll('.btn-act-test');
            testBtns.forEach(b => b.disabled = !bleState.isConnected);
        }
    });
}

// --- Window Binding for HTML Compatibility ---

window.toggleMenu = toggleMenu;
window.setTheme = setTheme;
window.switchTab = switchTab;
window.openRemoteModal = () => {
    toggleMenu();
    openRemoteModal();
};

window.setLevel = (lvl, btn) => {
    setLevel(lvl);
    document.querySelectorAll('.lvl-dot').forEach(d => d.classList.remove('active'));
    if(btn) btn.classList.add('active');
};

window.setMode = (mode, btn) => {
    setMode(mode);
    document.querySelectorAll('.mode-option').forEach(d => d.classList.remove('active'));
    if(btn) btn.classList.add('active');
    
    const uiReps = document.getElementById('ui-reps');
    const uiTime = document.getElementById('ui-time');
    if(mode === 'reps') {
        uiReps?.classList.remove('hidden');
        uiTime?.classList.add('hidden');
    } else {
        uiReps?.classList.add('hidden');
        uiTime?.classList.remove('hidden');
    }
};

window.resetStats = resetStats;
window.saveAsDefault = saveAsDefault;
window.resetToDefault = resetToDefault;
window.factoryReset = factoryReset;
window.exportCustomDrills = exportCustomDrills;

window.handleCSVUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) { 
        const success = importCustomDrills(e.target.result);
        if(success) {
            renderDrillButtons();
            toggleMenu(); 
        }
    };
    reader.readAsText(file);
    event.target.value = '';
};

window.openEditor = openEditor;
window.closeEditor = closeEditor;
window.saveDrillChanges = saveDrillChanges;
window.togglePause = togglePause;
window.stopRun = stopRun;

window.handleDrillClick = (key, btn) => {
    if (!bleState.isConnected) {
        showToast(t("Device not connected"));
        return;
    }
    document.querySelectorAll('.btn-drill').forEach(b => b.classList.remove('running'));
    btn.classList.add('running');
    startDrillSequence(key);
};

// --- SHARED DRILLS DOWNLOAD MODAL ---

let selectedDownloadCat = 'custom-a';
let downloadPassword = '';
const MAX_DOWNLOAD_SELECTION = 30;

function setDownloadStep(loggedIn) {
    document.getElementById('dl-login').style.display = loggedIn ? 'none' : '';
    document.getElementById('dl-picker').style.display = loggedIn ? '' : 'none';
}

function downloadErrorMessage(e) {
    if (e.message === 'Wrong password') return t("Wrong password");
    if (e.message === 'Too many attempts') return t("Too many attempts, try again later");
    return t("Download Error");
}

// 1. Open the Modal
window.handleDownloadDialog = () => {
    // Close main menu if open
    const menu = document.getElementById('theme-menu');
    if(menu) menu.classList.remove('open');

    // Reset State
    selectedDownloadCat = 'custom-a';
    downloadPassword = '';
    const pwInput = document.getElementById('dl-password');
    pwInput.value = '';
    document.getElementById('dl-list').replaceChildren();
    setDownloadStep(false);

    // Reset Switch UI to default (A)
    const switchEl = document.getElementById('dl-cat-switch');
    if(switchEl) {
        Array.from(switchEl.children).forEach(c => c.classList.remove('active'));
        if(switchEl.children[0]) switchEl.children[0].classList.add('active'); 
    }

    document.getElementById('download-modal').classList.add('open');
    setTimeout(() => pwInput.focus(), 100);
};

// 2. Close the Modal
window.closeDownloadModal = () => {
    downloadPassword = '';
    document.getElementById('download-modal').classList.remove('open');
};

// 3. Handle Tab Switching inside Modal
window.selectDlCategory = (val, btn) => {
    selectedDownloadCat = val;
    if(btn && btn.parentElement) {
        Array.from(btn.parentElement.children).forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
    }
};

// Server-provided text is untrusted: build the list with textContent only.
function renderSharedList(drills) {
    const box = document.getElementById('dl-list');
    box.replaceChildren();
    if (drills.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dl-empty';
        empty.textContent = t("No shared drills yet");
        box.appendChild(empty);
        return;
    }
    drills.forEach(d => {
        const row = document.createElement('label');
        row.className = 'dl-item';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.value = d.id;
        const text = document.createElement('div');
        text.className = 'dl-text';
        const title = document.createElement('div');
        title.className = 'dl-name';
        title.textContent = d.name;
        const meta = document.createElement('div');
        meta.className = 'dl-meta';
        meta.textContent = `${d.author} · ${new Date(d.date).toLocaleDateString()}`;
        const desc = document.createElement('div');
        desc.className = 'dl-desc';
        desc.textContent = d.description;
        text.append(title, meta, desc);
        row.append(check, text);
        box.appendChild(row);
    });
}

// 4. Check the password and load the list
window.loadSharedList = async () => {
    const password = document.getElementById('dl-password').value;
    if (!password) { showToast(t("Enter the password")); return; }

    const btn = document.getElementById('btn-dl-load');
    btn.disabled = true;
    showToast(t("Loading..."));
    try {
        renderSharedList(await listSharedDrills(password));
        downloadPassword = password;
        setDownloadStep(true);
    } catch (e) {
        console.error(e);
        showToast(downloadErrorMessage(e));
    } finally {
        btn.disabled = false;
    }
};

// 5. Download the ticked drills and import them
window.performDownload = async () => {
    const ids = [...document.querySelectorAll('#dl-list input:checked')].map(c => c.value);
    if (ids.length === 0) { showToast(t("Select at least one drill")); return; }
    if (ids.length > MAX_DOWNLOAD_SELECTION) {
        showToast(t("Select up to {count} drills", { count: MAX_DOWNLOAD_SELECTION }));
        return;
    }

    const catChar = selectedDownloadCat.split('-')[1].toUpperCase();
    if (userCustomDrills[selectedDownloadCat].length >= 100) {
        showToast(t("Bank {category} is full!", { category: catChar }));
        return;
    }

    const btn = document.getElementById('btn-dl-import');
    btn.disabled = true;
    showToast(t("Loading..."));
    try {
        const items = await fetchSharedDrills(downloadPassword, ids);
        const { added, skipped } = importSharedDrills(items, selectedDownloadCat);

        window.closeDownloadModal();
        const tabBtn = document.querySelector(`.tab-btn[onclick*="${selectedDownloadCat}"]`);
        if (tabBtn) switchTab(selectedDownloadCat, tabBtn);

        showToast(skipped > 0
            ? t("Imported {count} to {category}, skipped {skipped}", { count: added, category: catChar, skipped })
            : t("Imported {count} to {category}", { count: added, category: catChar }));
    } catch (e) {
        console.error(e);
        showToast(downloadErrorMessage(e));
    } finally {
        btn.disabled = false;
    }
};