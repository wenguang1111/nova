import { t } from './i18n.js';

// Google Apps Script web app in front of the shared Drive folder.
// The folder ID and download password live only in the script's properties
// (see docs/drive-share.md).
const DRIVE_URL = 'https://script.google.com/macros/s/AKfycbxUvKjcJ4tIIKSS20U9QUMmtQdgQWQDo2hFlqseySEIcDwlHYEnKIvTmT5gc3xnZ9Vv/exec';

async function callDrive(payload) {
    if (!DRIVE_URL) throw new Error(t("Sharing is not configured"));

    // text/plain keeps this a CORS "simple request" (Apps Script cannot answer preflights).
    const response = await fetch(DRIVE_URL, { method: 'POST', body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(t("Network error"));

    const result = await response.json();
    if (!result.ok) throw new Error(result.error || t("Network error"));
    return result;
}

export async function shareDrillToDrive({ name, author, description, csv }) {
    await callDrive({ action: 'upload', name, author, description, csv });
}

// Resolves to [{ id, name, author, description, date }], newest first.
export async function listSharedDrills(password) {
    return (await callDrive({ action: 'list', password })).drills;
}

// Resolves to [{ id, name, csv }].
export async function fetchSharedDrills(password, ids) {
    return (await callDrive({ action: 'get', password, ids })).drills;
}
