// Backend for the Nova web app's drill sharing. Every request is a POST with
// { action: 'upload' | 'list' | 'get', ... } (text/plain body, so no CORS preflight).
//
// Script Properties (never in source, this repo is public):
//   FOLDER_ID          Drive folder that stores the shared drill CSV files
//   DOWNLOAD_PASSWORD  password required for 'list' and 'get'

const MAX_BODY_CHARS = 60000;
const MAX_ROWS = 600;
const MAX_UPLOADS_PER_DAY = 200;
const MAX_LIST = 300;            // newest files returned by 'list'
const MAX_FETCH = 30;            // files per 'get' request
const MAX_PASSWORD_FAILS_PER_HOUR = 30;
const HEADER = 'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps';
const NAME_RE = /^[\p{L}\p{M}\p{N}.\-#\[\]><+)( ]{1,40}$/u;
const AUTHOR_RE = /^[\p{L}\p{M}\p{N}._\- ]{1,30}$/u;
const NUM = '-?\\d{1,3}(?:\\.\\d{1,2})?';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return reply(handle(e));
  } catch (err) {
    return reply({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function handle(e) {
  const body = e && e.postData && e.postData.contents;
  if (!body || body.length > MAX_BODY_CHARS) throw new Error('Bad size');
  const data = JSON.parse(body);

  switch (data.action || 'upload') {
    case 'upload': return upload(data);
    case 'list': requirePassword(data.password); return list();
    case 'get': requirePassword(data.password); return get(data.ids);
    default: throw new Error('Bad action');
  }
}

function folder() {
  const folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!folderId) throw new Error('Not configured');
  return DriveApp.getFolderById(folderId);
}

// --- upload ---

function upload({ name, author, description, csv }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('Bad name');
  if (typeof author !== 'string' || !AUTHOR_RE.test(author)) throw new Error('Bad author');
  if (typeof description !== 'string' || description.length < 1 || description.length > 100) throw new Error('Bad description');
  if (typeof csv !== 'string') throw new Error('Bad csv');

  // Strict row validation: only numbers and fixed words, so nothing that Sheets/Excel
  // could read as a formula ends up in the file.
  const rowRe = new RegExp(
    '^A;\\d{1,3};' + escapeRe(name) + ';' + NUM + ';' + NUM + ';(?:top|back);' +
    NUM + ';' + NUM + ';\\d{1,3};\\d{1,3}$');
  const lines = csv.split(/\r?\n/).filter(l => l !== '');
  if (lines[0] !== HEADER) throw new Error('Bad header');
  if (lines.length < 2 || lines.length > MAX_ROWS + 1) throw new Error('Bad row count');
  for (let i = 1; i < lines.length; i++) {
    if (!rowRe.test(lines[i])) throw new Error('Bad row ' + i);
  }

  checkDailyQuota();

  const dir = folder();
  const stamp = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd-HHmmss');
  const suffix = Utilities.getUuid().slice(0, 4);
  const file = dir.createFile(stamp + '-' + suffix + '_' + author + '_' + name + '.csv',
                              lines.join('\n') + '\n', MimeType.CSV);
  const cleanDesc = description.replace(/[\u0000-\u001f\u007f]/g, ' ');
  file.setDescription('Author: ' + author + '\nDrill: ' + name + '\nDescription: ' + cleanDesc);
  return { ok: true };
}

function checkDailyQuota() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd');
  const [day, count] = (props.getProperty('QUOTA') || '').split(':');
  const used = day === today ? Number(count) : 0;
  if (used >= MAX_UPLOADS_PER_DAY) throw new Error('Daily limit reached');
  props.setProperty('QUOTA', today + ':' + (used + 1));
}

// --- download ---

// There is no per-client identity here, so failed attempts are counted globally per hour.
function requirePassword(given) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('DOWNLOAD_PASSWORD');
  if (!expected) throw new Error('Not configured');

  const hour = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  const [h, count] = (props.getProperty('FAILS') || '').split(':');
  const fails = h === hour ? Number(count) : 0;
  if (fails >= MAX_PASSWORD_FAILS_PER_HOUR) throw new Error('Too many attempts');

  if (typeof given !== 'string' || given !== expected) {
    props.setProperty('FAILS', hour + ':' + (fails + 1));
    throw new Error('Wrong password');
  }
}

// Files without the 'Drill:' description line (e.g. manual test files) are not listed.
function parseDescription(text) {
  const out = {};
  String(text || '').split('\n').forEach(line => {
    const i = line.indexOf(': ');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 2);
  });
  return out.Author && out.Drill ? out : null;
}

function list() {
  const items = [];
  const files = folder().getFiles();
  while (files.hasNext()) {
    const f = files.next();
    items.push({ f, t: f.getDateCreated().getTime() });
  }
  items.sort((a, b) => b.t - a.t);

  const drills = [];
  for (const { f, t } of items) {
    if (drills.length >= MAX_LIST) break;
    const d = parseDescription(f.getDescription());
    if (!d) continue;
    drills.push({ id: f.getId(), name: d.Drill, author: d.Author, description: d.Description || '', date: t });
  }
  return { ok: true, drills };
}

function get(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_FETCH) throw new Error('Bad ids');
  const folderId = folder().getId();
  const drills = ids.map(id => {
    if (typeof id !== 'string' || !/^[\w-]{10,80}$/.test(id)) throw new Error('Bad id');
    const f = DriveApp.getFileById(id);
    // Only files inside the shared folder may be read.
    const parents = f.getParents();
    let inside = false;
    while (parents.hasNext()) if (parents.next().getId() === folderId) inside = true;
    if (!inside) throw new Error('Not found');
    const d = parseDescription(f.getDescription());
    if (!d) throw new Error('Not found');
    return { id, name: d.Drill, csv: f.getBlob().getDataAsString() };
  });
  return { ok: true, drills };
}

// --- helpers ---

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
