// Receives a shared drill CSV from the Nova web app and stores it in a Drive folder.
// The folder ID is read from Script Properties (key: FOLDER_ID), never from source,
// so it stays out of this public repository and out of the browser.

const MAX_BODY_CHARS = 60000;
const MAX_ROWS = 600;
const MAX_UPLOADS_PER_DAY = 200;
const HEADER = 'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps';
const NAME_RE = /^[\p{L}\p{M}\p{N}.\-#\[\]><+)( ]{1,40}$/u;
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

  const { name, csv } = JSON.parse(body);
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('Bad name');
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

  const folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!folderId) throw new Error('Not configured');
  const stamp = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd-HHmmss');
  const suffix = Utilities.getUuid().slice(0, 4);
  DriveApp.getFolderById(folderId)
    .createFile(stamp + '-' + suffix + '_' + name + '.csv', lines.join('\n') + '\n', MimeType.CSV);
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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
