import { t } from './i18n.js';

const API_URL = 'https://nova.varandal.de/api/collections/shared_drills/records';

// Helper: Generate 3 Random Letters + 3 Random Digits
function generateCode() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const digits = "0123456789";
    
    let result = "";
    for (let i = 0; i < 3; i++) result += letters.charAt(Math.floor(Math.random() * letters.length));
    for (let i = 0; i < 3; i++) result += digits.charAt(Math.floor(Math.random() * digits.length));
    
    return result; // Returns like "ABC123"
}

export async function uploadDrill(drillPayload) {
    // 1. Generate a valid unique code
    let code = null;
    let retries = 0;

    while (!code && retries < 5) {
        const candidate = generateCode();
        const exists = await checkCodeExists(candidate);
        if (!exists) {
            code = candidate;
        }
        retries++;
    }

    if (!code) throw new Error(t("Could not generate unique code. Server busy?"));

    // 2. Upload Data
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            share_code: code,
            drill_data: drillPayload
        })
    });

    if (!response.ok) throw new Error(t("Upload failed"));
    return code;
}

export async function downloadDrill(code) {
    // Case-Insensitive Handling: Always convert to Uppercase
    const cleanCode = code.trim().toUpperCase();

    // PocketBase Filter
    const url = `${API_URL}?filter=(share_code='${cleanCode}')`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(t("Network error"));

    const json = await response.json();
    
    if (json.items && json.items.length > 0) {
        return json.items[0].drill_data;
    } else {
        return null; // Not found
    }
}

async function checkCodeExists(code) {
    try {
        const url = `${API_URL}?filter=(share_code='${code}')&fields=id`;
        const res = await fetch(url);
        const json = await res.json();
        return json.items && json.items.length > 0;
    } catch (e) {
        return true; 
    }
}

// Google Apps Script web app that writes into the shared Drive folder.
// The folder ID lives only in the script's properties (see docs/drive-share.md).
const DRIVE_UPLOAD_URL = 'https://script.google.com/macros/s/AKfycbzNVb1RUpjI4kSLLVlzrA2oOt-VmJIZsamODEQrSkJiEy7hLKMckw20yV9FpQSsK_Uj/exec';

export async function shareDrillToDrive({ name, author, description, csv }) {
    if (!DRIVE_UPLOAD_URL) throw new Error(t("Sharing is not configured"));

    // text/plain keeps this a CORS "simple request" (Apps Script cannot answer preflights).
    const response = await fetch(DRIVE_UPLOAD_URL, {
        method: 'POST',
        body: JSON.stringify({ name, author, description, csv })
    });
    if (!response.ok) throw new Error(t("Upload failed"));

    const result = await response.json();
    if (!result.ok) throw new Error(result.error || t("Upload failed"));
}