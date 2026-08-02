// --- NeuroLynQ cloud sync -------------------------------------------------
// Signs the participant in against the Verisense API, then uploads a recording
// session's files individually to S3 via presigned PUT URLs.
//
// Files land under:
//   {trial}/{participant}/{deviceMac}/neurolynq/{contentHash}/raw/{type}/{file}
//
// Trial, participant and destination bucket are resolved server-side from the
// access token, so nothing about identity is asserted by this client.

const STORAGE_KEY = 'neurolynqAuth';
// Local docker maps the admin portal to 5001 and the REST API to 5002; the API is a
// separate app from the web portal (deployed behind *api.verisense.net).
const DEFAULT_API_BASE = 'http://localhost:5002';

// ---- storage -------------------------------------------------------------

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get([key], (r) => resolve(r?.[key] ?? null)));
}

function storageSet(key, value) {
  return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, () => resolve()));
}

// ---- content hash --------------------------------------------------------

/**
 * Reduce a URL to a stable key for the content being viewed, so the same video or
 * page yields the same hash for every participant. Known platforms collapse to their
 * content id; everything else falls back to host + path (query and fragment dropped).
 */
export function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  let u;
  try { u = new URL(rawUrl); } catch { return String(rawUrl).trim().toLowerCase(); }

  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v) return `youtube:${v}`;
    const embed = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/);
    if (embed) return `youtube:${embed[1]}`;
  }
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '').split('/')[0];
    if (id) return `youtube:${id}`;
  }
  if (host === 'vimeo.com') {
    const id = u.pathname.match(/^\/(\d+)/);
    if (id) return `vimeo:${id[1]}`;
  }

  const path = u.pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

export async function hashContent(canonical) {
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

// ---- helpers -------------------------------------------------------------

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** Session file-name stamp: yyMMdd_HHmmss */
function stamp(date) {
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

function getPageInfo() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO' }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) { resolve({ url: '', title: '' }); return; }
        resolve({ url: response.url, title: response.title });
      });
    } catch { resolve({ url: '', title: '' }); }
  });
}

// ---- API -----------------------------------------------------------------

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok && !payload) {
    const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
    const hint = res.status === 404 ? ' — endpoint not found on this server (is it deployed?)' : '';
    throw new Error(`${res.status} on ${path}${hint}`);
  }
  return payload;
}

/** Case-insensitive property lookup, tolerant of PascalCase/camelCase responses. */
function pick(obj, ...names) {
  if (!obj) return undefined;
  const wanted = names.map(n => n.toLowerCase());
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.includes(key.toLowerCase()) && value != null && value !== '') return value;
  }
  return undefined;
}

export async function signIn(apiBase, login, password) {
  const base = apiBase.replace(/\/+$/, '');
  const result = await postJson(`${base}/api/auth/sign_in`, { Login: login, Password: password });

  // The API returns its own envelope; surface whatever error it gives us.
  const error = pick(result, 'error');
  if (error) throw new Error(error);

  // NOTE: the API's DTO spells this "AccesToken" (single 's' — typo in
  // BaseStationAuthResult), so accept both spellings and either casing.
  const token = pick(result, 'accesToken', 'accessToken', 'openIdConnectToken');
  if (!token) throw new Error('Sign-in did not return an access token.');

  const auth = {
    apiBase: base,
    login,
    token,
    participantId: pick(result, 'participantId') || null,
    isTemporaryPassword: !!pick(result, 'isTemporaryPassword'),
    signedInAt: Date.now(),
  };
  await storageSet(STORAGE_KEY, auth);
  return auth;
}

export async function getAuth() { return storageGet(STORAGE_KEY); }
export async function signOut() { await storageSet(STORAGE_KEY, null); }

async function requestUploadUrls(auth, deviceMac, contentHash, files) {
  const result = await postJson(`${auth.apiBase}/api/neurolynq/upload_urls`, {
    Token: auth.token,
    DeviceMac: deviceMac,
    ContentHash: contentHash,
    Files: files.map(f => ({ FileName: f.name, Type: f.type })),
  });

  const ok = result?.isSuccess ?? result?.IsSuccess;
  if (!ok) throw new Error(result?.error || result?.Error || 'Could not get upload URLs.');

  const entity = result.entity ?? result.Entity;
  const list = entity?.files ?? entity?.Files ?? [];
  const byName = new Map(list.map(f => [f.fileName ?? f.FileName, f.uploadUrl ?? f.UploadUrl]));
  return { byName, entity };
}

// ---- session -> files ----------------------------------------------------

/**
 * Build the individual files for a session. Signals are split per-channel so the
 * signal type is visible in the file name.
 */
export async function buildSessionFiles({ csvRows, screenshots, reportHtml, deviceMac, pageInfo, canonical }) {
  if (!csvRows?.length) throw new Error('No data recorded yet.');

  const t0ms = csvRows[0].tMs;
  const started = new Date(t0ms);
  const ts = stamp(started);
  const files = [];

  const elapsed = (ms) => ((ms - t0ms) / 1000).toFixed(3);

  const signalCsv = (label, pick) => [
    ['Timestamp', 'Elapsed (s)', label].join(','),
    ...csvRows.map(r => [csvEscape(r.timestamp), elapsed(r.tMs), csvEscape(pick(r) ?? '')].join(',')),
  ].join('\n');

  files.push({
    name: `${ts}_GSR_00001.csv`,
    type: 'signals',
    blob: new Blob([signalCsv('GSR (uS)', r => (typeof r.gsr === 'number' ? r.gsr : ''))], { type: 'text/csv' }),
  });

  if (csvRows.some(r => typeof r.ppg === 'number')) {
    files.push({
      name: `${ts}_PPG_00001.csv`,
      type: 'signals',
      blob: new Blob([signalCsv('PPG (Raw)', r => (typeof r.ppg === 'number' ? r.ppg : ''))], { type: 'text/csv' }),
    });
  }

  if (screenshots?.length) {
    const header = ['Timestamp', 'Elapsed (s)', 'Click Elapsed (s)', 'Event', 'Kind', 'Video Time (s)', 'Reason', 'Page Title', 'Filename'];
    const eventsCsv = [
      header.join(','),
      ...screenshots.map(s => [
        csvEscape(s.timestamp),
        elapsed(s.tMs ?? t0ms),
        s.clickTMs != null ? elapsed(s.clickTMs) : '',
        csvEscape(s.eventId ?? ''),
        csvEscape(s.kind ?? ''),
        csvEscape(s.videoTime ?? ''),
        csvEscape(s.reason ?? ''),
        csvEscape(s.title ?? ''),
        csvEscape(s.file ?? ''),
      ].join(',')),
    ].join('\n');

    files.push({ name: `${ts}_Events_00001.csv`, type: 'events', blob: new Blob([eventsCsv], { type: 'text/csv' }) });

    screenshots.forEach((s) => {
      if (!s.dataUrl) return;
      files.push({ name: s.file, type: 'screenshots', blob: dataUrlToBlob(s.dataUrl) });
    });
  }

  if (reportHtml) {
    files.push({ name: `${ts}_report.html`, type: 'report', blob: new Blob([reportHtml], { type: 'text/html' }) });
  }

  // The manifest is the only place the plaintext URL is stored — the S3 key itself
  // carries only the opaque hash.
  const manifest = {
    schema: 'neurolynq/session/v1',
    startedAt: started.toISOString(),
    endedAt: new Date(csvRows[csvRows.length - 1].tMs).toISOString(),
    deviceMac,
    content: { canonical, url: pageInfo?.url || '', title: pageInfo?.title || '' },
    sampleCount: csvRows.length,
    screenshotCount: screenshots?.length ?? 0,
    files: files.map(f => ({ name: f.name, type: f.type })),
  };
  files.push({
    name: `${ts}_manifest.json`,
    type: 'manifest',
    blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
  });

  return files;
}

// ---- upload --------------------------------------------------------------

export async function uploadSession({ auth, deviceMac, session, onProgress }) {
  const pageInfo = await getPageInfo();
  const canonical = canonicalizeUrl(pageInfo.url);
  if (!canonical) throw new Error('Could not determine the page being viewed.');

  const contentHash = await hashContent(canonical);
  const files = await buildSessionFiles({ ...session, deviceMac, pageInfo, canonical });

  onProgress?.({ done: 0, total: files.length, message: 'Requesting upload URLs…' });
  const { byName } = await requestUploadUrls(auth, deviceMac, contentHash, files);

  let done = 0;
  for (const file of files) {
    const url = byName.get(file.name);
    if (!url) throw new Error(`No upload URL returned for ${file.name}.`);

    const res = await fetch(url, { method: 'PUT', body: file.blob });
    if (!res.ok) throw new Error(`Upload failed for ${file.name} (${res.status}).`);

    done += 1;
    onProgress?.({ done, total: files.length, message: file.name });
  }

  return { uploaded: done, contentHash, files: files.map(f => f.name) };
}

export { DEFAULT_API_BASE };
