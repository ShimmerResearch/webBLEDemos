import { Shimmer3RClient, SensorBitmapShimmer3 } from "./shimmer3r.js";

// ===== Charts =====
const gsrCtx = document.getElementById('gsrChart').getContext('2d');
const ppgCtx = document.getElementById('ppgChart').getContext('2d');

const MAX_POINTS = 120; // capped for performance

const chartConfig = (color) => ({
  type: 'line',
  data: { labels: [], datasets: [{ data: [], borderColor: color, borderWidth: 2, fill: false, pointRadius: 0, tension: 0.25 }] },
  options: {
    animation: false,
    scales: { x: { display: false }, y: { display: false } },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    responsive: true, maintainAspectRatio: false, layout: { padding: 0 }
  }
});

const gsrChart = new Chart(gsrCtx, chartConfig('#4FC3F7'));
const ppgChart = new Chart(ppgCtx, chartConfig('#FF6B6B'));

const shimmer = new Shimmer3RClient({ debug: false });

// ===== State =====
let isStreaming = false; // device is streaming (live preview) — on from connect to disconnect
let isRecording = false; // logging to CSV/timeline/screenshots — toggled by the record button
let intentionalDisconnect = false;
let currentVideoTime = null; // null when the page has no <video> (e.g. virtual tours)
const videoTimeStr = (digits) => currentVideoTime == null ? "" : currentVideoTime.toFixed(digits);
let csvRows = [];
let screenshots = [];
let shotSeq = 0;  // image numbering; a settled shot reuses its click's number
let eventSeq = 0; // one id per click event, shared by its onset + settled shots
let screenshotInterval = null;

// throttled display buffers
let latestGsr = null, latestPpg = null;
let displayDirty = false;

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const body = document.body;

const headerStatus = $("headerStatus"), statusLabel = $("statusLabel");
const deviceStatus = $("deviceStatus"), deviceStatusText = $("deviceStatusText"), deviceNameLabel = $("deviceNameLabel");
const scanBtn = $("scanBtn");
const streamBtn = $("streamBtn"), streamBtnText = $("streamBtnText");
const gsrValLabel = $("gsrVal"), ppgValLabel = $("ppgVal");
const videoTimeLabel = $("videoTime");
const recTime = $("recTime");

const closeBtn = $("closeBtn"), minBtn = $("minBtn"), expandBtn = $("expandBtn");
const dragHeader = $("dragHeader"), dragHeaderMin = $("dragHeaderMin");
const minimizedTimeText = $("minimizedTimeText"), minStopBtn = $("minStopBtn");

const capPeriodic = $("capPeriodic"), capInterval = $("capInterval"), capClick = $("capClick");
const capSettled = $("capSettled"), settledRow = $("settledRow");
const capClickDelay = $("capClickDelay"), capClickDelayVal = $("capClickDelayVal");
const restEnable = $("restEnable"), restDelay = $("restDelay");
const immersiveEnable = $("immersiveEnable");

const tabLive = $("tabLive"), tabShots = $("tabShots");
const shotCount = $("shotCount"), shotsGrid = $("shotsGrid"), shotsEmpty = $("shotsEmpty");
const clearBtn = $("clearBtn"), downloadBtn = $("downloadBtn");
const lightbox = $("lightbox"), lightboxImg = $("lightboxImg"), lightboxClose = $("lightboxClose");
const lightboxMeta = $("lightboxMeta");
const lbStage = $("lbStage"), lbTopImg = $("lbTopImg"), lbDivider = $("lbDivider");
const lbTagL = $("lbTagL"), lbTagR = $("lbTagR");

// ===== Session timeline (whole-session GSR trend + snapshot markers) =====
// Colors validated for CVD separation and contrast on the overlay surface.
const REASON_COLORS = { click: "#9085e9", navigation: "#199e70", periodic: "#c98500" };
const timelineSection = $("timelineSection"), tlRange = $("tlRange");
const tlCanvas = $("timelineCanvas"), tlCtx = tlCanvas.getContext("2d");
const evPopover = $("evPopover"), evPopImg = $("evPopImg");
const evPopReason = $("evPopReason"), evPopTime = $("evPopTime");

const TL_BINS = 480;
let sessionStartMs = null;
let tlBinMs = 250; // doubles whenever the session outgrows the bin array
let tlSum = new Float64Array(TL_BINS), tlCount = new Uint32Array(TL_BINS);
let tlHoverShot = null;

function fmtElapsed(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
           : `${m}:${String(sec).padStart(2, "0")}`;
}

function tlReset() {
  sessionStartMs = null;
  tlBinMs = 250;
  tlSum = new Float64Array(TL_BINS);
  tlCount = new Uint32Array(TL_BINS);
  tlHoverShot = null;
  timelineSection.hidden = true;
  evPopover.style.display = "none";
}

function tlFeed(tMs, gsr) {
  if (sessionStartMs === null) { sessionStartMs = tMs; timelineSection.hidden = false; }
  let idx = Math.floor((tMs - sessionStartMs) / tlBinMs);
  while (idx >= TL_BINS) {
    for (let i = 0; i < TL_BINS / 2; i++) {
      tlSum[i] = tlSum[2 * i] + tlSum[2 * i + 1];
      tlCount[i] = tlCount[2 * i] + tlCount[2 * i + 1];
    }
    tlSum.fill(0, TL_BINS / 2);
    tlCount.fill(0, TL_BINS / 2);
    tlBinMs *= 2;
    idx = Math.floor((tMs - sessionStartMs) / tlBinMs);
  }
  tlSum[idx] += gsr;
  tlCount[idx]++;
}

function tlXFor(tMs, width, spanMs) {
  return ((tMs - sessionStartMs) / spanMs) * (width - 2) + 1;
}

function drawTimeline() {
  if (sessionStartMs === null) return;
  const w = tlCanvas.clientWidth, h = tlCanvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (tlCanvas.width !== Math.round(w * dpr) || tlCanvas.height !== Math.round(h * dpr)) {
    tlCanvas.width = Math.round(w * dpr);
    tlCanvas.height = Math.round(h * dpr);
  }
  tlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tlCtx.clearRect(0, 0, w, h);

  const spanMs = Math.max(30000, Date.now() - sessionStartMs);
  const laneH = 16; // marker lane at the top; the trend renders below it
  const plotY = laneH + 3, plotH = h - plotY - 3;

  // GSR trend — context only, deliberately de-emphasized under the markers
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < TL_BINS; i++) {
    if (!tlCount[i]) continue;
    const v = tlSum[i] / tlCount[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (isFinite(mn)) {
    if (mn === mx) { mn -= 1; mx += 1; }
    const pad = (mx - mn) * 0.12;
    mn -= pad; mx += pad;
    tlCtx.save();
    tlCtx.globalAlpha = 0.55;
    tlCtx.strokeStyle = "#4FC3F7";
    tlCtx.lineWidth = 1.5;
    tlCtx.lineJoin = "round";
    tlCtx.beginPath();
    let started = false;
    for (let i = 0; i < TL_BINS; i++) {
      if (!tlCount[i]) { started = false; continue; } // gap = recording paused
      const v = tlSum[i] / tlCount[i];
      const x = tlXFor(sessionStartMs + (i + 0.5) * tlBinMs, w, spanMs);
      const y = plotY + plotH - ((v - mn) / (mx - mn)) * plotH;
      if (!started) { tlCtx.moveTo(x, y); started = true; }
      else tlCtx.lineTo(x, y);
    }
    tlCtx.stroke();
    tlCtx.restore();
  }

  // snapshot markers: hairline through the trend + dot in the lane
  // (settled shots draw as hollow rings tied back to their click)
  const laneMid = laneH / 2 + 1;
  for (const s of screenshots) {
    if (s.tMs == null) continue;
    const x = tlXFor(s.tMs, w, spanMs);
    const c = REASON_COLORS[s.reason] || "#9BA4B5";
    tlCtx.save();
    tlCtx.globalAlpha = 0.3;
    tlCtx.strokeStyle = c;
    tlCtx.lineWidth = 1;
    tlCtx.beginPath();
    tlCtx.moveTo(x, plotY);
    tlCtx.lineTo(x, h - 2);
    tlCtx.stroke();
    tlCtx.restore();
    const r = tlHoverShot === s ? 6 : 4.5;
    if (s.kind === 'settled') {
      if (s.clickTMs != null) { // lane connector back to the click
        const x0 = tlXFor(s.clickTMs, w, spanMs);
        tlCtx.save();
        tlCtx.globalAlpha = 0.35;
        tlCtx.strokeStyle = c;
        tlCtx.lineWidth = 1;
        tlCtx.beginPath(); tlCtx.moveTo(x0, laneMid); tlCtx.lineTo(x, laneMid); tlCtx.stroke();
        tlCtx.restore();
      }
      tlCtx.beginPath(); tlCtx.arc(x, laneMid, r + 2, 0, Math.PI * 2); tlCtx.fillStyle = "#1C1F26"; tlCtx.fill();
      tlCtx.beginPath(); tlCtx.arc(x, laneMid, r - 1, 0, Math.PI * 2); tlCtx.strokeStyle = c; tlCtx.lineWidth = 2; tlCtx.stroke();
    } else {
      tlCtx.beginPath(); tlCtx.arc(x, laneMid, r + 2, 0, Math.PI * 2); tlCtx.fillStyle = "#1C1F26"; tlCtx.fill();
      tlCtx.beginPath(); tlCtx.arc(x, laneMid, r, 0, Math.PI * 2); tlCtx.fillStyle = c; tlCtx.fill();
    }
  }

  tlRange.textContent = fmtElapsed((Date.now() - sessionStartMs) / 1000);
}

function tlShotAt(e) {
  if (sessionStartMs === null || screenshots.length === 0) return null;
  const rect = tlCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const spanMs = Math.max(30000, Date.now() - sessionStartMs);
  let best = null, bestD = 14; // hit target well beyond the dot itself
  for (const s of screenshots) {
    if (s.tMs == null) continue;
    const d = Math.abs(px - tlXFor(s.tMs, rect.width, spanMs));
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

tlCanvas.addEventListener("mousemove", (e) => {
  const s = tlShotAt(e);
  if (s !== tlHoverShot) { tlHoverShot = s; drawTimeline(); }
  if (!s) {
    tlCanvas.style.cursor = "default";
    evPopover.style.display = "none";
    return;
  }
  tlCanvas.style.cursor = "pointer";
  evPopImg.src = s.dataUrl;
  evPopReason.querySelector("i").style.background = REASON_COLORS[s.reason] || "#9BA4B5";
  evPopReason.querySelector("span").textContent = s.kind === 'settled' ? 'settled' : s.reason;
  let tStr = fmtElapsed((s.tMs - sessionStartMs) / 1000);
  if (s.clickTMs != null && s.tMs - s.clickTMs >= 1000) {
    tStr += ` (clicked ${fmtElapsed((s.clickTMs - sessionStartMs) / 1000)})`;
  }
  evPopTime.textContent = tStr + (s.videoTime ? ` · ${s.videoTime}s` : "");
  evPopover.style.display = "block";
  const pw = 190, ph = evPopover.offsetHeight || 150;
  let x = e.clientX + 12;
  if (x + pw > window.innerWidth - 6) x = e.clientX - pw - 12;
  x = Math.max(6, x);
  let y = e.clientY - ph - 10;
  if (y < 6) y = Math.min(e.clientY + 14, window.innerHeight - ph - 6);
  evPopover.style.left = x + "px";
  evPopover.style.top = y + "px";
});
tlCanvas.addEventListener("mouseleave", () => {
  tlHoverShot = null;
  evPopover.style.display = "none";
  drawTimeline();
});
tlCanvas.addEventListener("click", (e) => {
  const s = tlShotAt(e);
  if (s) openLightbox(s);
});
new ResizeObserver(() => drawTimeline()).observe(tlCanvas);

// ===== Connection state machine =====
function setConn(state, label) {
  // state: offline | connecting | online | error
  headerStatus.dataset.state = state;
  statusLabel.textContent = label;
  const devState = state === 'online' ? 'online' : (state === 'error' ? 'error' : 'offline');
  deviceStatus.dataset.state = devState;
}

setConn('offline', 'Offline');

// ===== Window controls =====
closeBtn.onclick = () => window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*');

function toggleMinimize() {
  window.parent.postMessage({ type: 'MINIMIZE_OVERLAY' }, '*');
  body.classList.toggle('is-minimized');
}
// Collapse/expand to a known state (toggleMinimize alone would flip whichever
// way the user last left it).
function setMinimized(want) {
  if (body.classList.contains('is-minimized') === want) return;
  toggleMinimize();
}

minBtn.onclick = toggleMinimize;
expandBtn.onclick = toggleMinimize;
minStopBtn.onclick = () => streamBtn.click();

// ===== Drag (movement handled in content.js) =====
function bindDrag(el) {
  if (!el) return;
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    window.parent.postMessage({ type: 'DRAG_START' }, '*');
  });
}
bindDrag(dragHeader);
bindDrag(dragHeaderMin);

// ===== Resize (8-direction; movement handled in content.js) =====
document.querySelectorAll('.rz').forEach((h) => {
  h.addEventListener('mousedown', (e) => {
    e.preventDefault();
    window.parent.postMessage({ type: 'RESIZE_START', edges: h.dataset.edges }, '*');
  });
});

// ===== Tabs =====
function activateTab(tabBtn) {
  [tabLive, tabShots].forEach((t) => {
    const on = t === tabBtn;
    t.classList.toggle('active', on);
    $(t.dataset.panel).hidden = !on;
  });
}
tabLive.onclick = () => activateTab(tabLive);
tabShots.onclick = () => activateTab(tabShots);

// ===== Screenshots =====
// Chrome throttles captureVisibleTab (~2 calls/s), so captures are serialized
// with spacing and one retry — click bursts don't silently drop shots.
const captureQueue = [];
let captureBusy = false;

function captureScreenshot(reason, meta = {}) {
  // meta: { clickTMs, eventId, kind } — kind 'onset' | 'settled' for click events
  if (!isRecording) return;
  captureQueue.push({ reason, meta, retried: false });
  pumpCaptureQueue();
}

function pumpCaptureQueue() {
  if (captureBusy) return;
  const job = captureQueue.shift();
  if (!job) return;
  captureBusy = true;
  chrome.runtime.sendMessage({ type: "TAKE_SCREENSHOT" }, (response) => {
    const ok = !chrome.runtime.lastError && response?.ok && response.dataUrl;
    if (ok && isRecording) recordShot(job, response.dataUrl);
    else if (!ok && !job.retried) { job.retried = true; captureQueue.unshift(job); }
    else if (!ok) console.error("Screenshot failed:", chrome.runtime.lastError?.message || response?.error);
    setTimeout(() => { captureBusy = false; pumpCaptureQueue(); }, 600);
  });
}

function pairOf(shot, kind) {
  if (shot.eventId == null) return null;
  return screenshots.find(s => s !== shot && s.eventId === shot.eventId && s.kind === kind) || null;
}

function recordShot(job, dataUrl) {
  const { reason, meta } = job;
  const now = new Date();
  const onset = meta.kind === 'settled'
    ? screenshots.find(s => s.eventId === meta.eventId && s.kind === 'onset')
    : null;
  const num = onset ? onset.num : ++shotSeq;
  const shot = {
    timestamp: now.toISOString(),
    tMs: now.getTime(),
    clickTMs: meta.clickTMs ?? null, // stimulus onset; ~tMs unless the shot was deferred
    eventId: meta.eventId ?? null,
    kind: meta.kind ?? null,
    num,
    videoTime: videoTimeStr(3),
    title: ($("videoTitleLabel").textContent || "").trim(),
    reason,
    file: `shot_${String(num).padStart(3, "0")}_${reason}${meta.kind === 'settled' ? '_settled' : ''}.jpg`,
    dataUrl
  };
  screenshots.push(shot);
  appendShot(shot);
  drawTimeline();
}

function appendShot(shot) {
  shotsEmpty.style.display = 'none';
  const el = document.createElement('div');
  el.className = 'shot';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = shot.dataUrl;
  const meta = document.createElement('div');
  meta.className = 'shot-meta';
  const reasonEl = document.createElement('span');
  reasonEl.className = 'shot-reason';
  reasonEl.textContent = shot.reason;
  reasonEl.style.color = REASON_COLORS[shot.reason] || 'var(--brand-hover)';
  const timeEl = document.createElement('span');
  timeEl.textContent = shot.videoTime ? shot.videoTime + 's'
    : (sessionStartMs != null && shot.tMs != null ? fmtElapsed((shot.tMs - sessionStartMs) / 1000) : '');
  meta.appendChild(reasonEl);
  if (shot.kind === 'settled') {
    const chip = document.createElement('span');
    chip.className = 'settle-chip';
    chip.textContent = shot.clickTMs != null ? `+${((shot.tMs - shot.clickTMs) / 1000).toFixed(1)}s` : 'settled';
    meta.appendChild(chip);
  }
  meta.appendChild(timeEl);
  el.appendChild(img);
  el.appendChild(meta);
  el.onclick = () => openLightbox(shot);
  shotsGrid.appendChild(el);
  shotCount.textContent = String(screenshots.length);
}

// Click + settled pairs open as a before/after comparison: the settled view
// underneath, the click view on top clipped to the left of a draggable divider.
let lbDragging = false;

function lbSetSplit(pct) {
  pct = Math.max(0, Math.min(100, pct));
  lbTopImg.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  lbDivider.style.left = pct + "%";
}
function lbSplitFromEvent(e) {
  const r = lbStage.getBoundingClientRect();
  return ((e.clientX - r.left) / r.width) * 100;
}
lbStage.addEventListener('mousedown', (e) => {
  if (lbTopImg.hidden) return;
  e.preventDefault();
  lbDragging = true;
  lbSetSplit(lbSplitFromEvent(e));
});
window.addEventListener('mousemove', (e) => { if (lbDragging) lbSetSplit(lbSplitFromEvent(e)); });
window.addEventListener('mouseup', () => { lbDragging = false; });

function openLightbox(shot) {
  const onset = shot.kind === 'settled' ? pairOf(shot, 'onset') : (shot.kind === 'onset' ? shot : null);
  const settled = shot.kind === 'onset' ? pairOf(shot, 'settled') : (shot.kind === 'settled' ? shot : null);
  const compare = !!(onset && settled);

  lightboxImg.src = compare ? settled.dataUrl : shot.dataUrl;
  lbTopImg.hidden = lbDivider.hidden = lbTagL.hidden = lbTagR.hidden = !compare;
  lbStage.classList.toggle('comparing', compare);
  if (compare) { lbTopImg.src = onset.dataUrl; lbSetSplit(50); }

  lightboxMeta.hidden = false;
  lightboxMeta.textContent = '';
  const dot = document.createElement('i');
  dot.style.background = REASON_COLORS[shot.reason] || '#9BA4B5';
  lightboxMeta.appendChild(dot);
  const el = (ms) => fmtElapsed((ms - sessionStartMs) / 1000);
  const parts = [];
  if (compare) {
    parts.push('click');
    if (sessionStartMs != null) {
      parts.push(`clicked ${el(onset.tMs)}`);
      parts.push(`settled ${el(settled.tMs)}`);
    }
    if (shot.videoTime) parts.push(`media ${shot.videoTime}s`);
  } else {
    parts.push(shot.kind === 'settled' ? 'settled' : shot.reason);
    if (sessionStartMs != null && shot.tMs != null) parts.push(el(shot.tMs));
    if (sessionStartMs != null && shot.clickTMs != null && shot.tMs - shot.clickTMs >= 1000) {
      parts.push(`clicked ${el(shot.clickTMs)}`);
    }
    if (shot.videoTime) parts.push(`media ${shot.videoTime}s`);
  }
  lightboxMeta.appendChild(document.createTextNode(parts.join(' · ')));
  lightbox.classList.add('open');
}
lightboxClose.onclick = () => lightbox.classList.remove('open');
lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.classList.remove('open'); };

function manageInterval() {
  if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null; }
  if (isRecording && capPeriodic.checked) {
    let ms = parseInt(capInterval.value) * 1000;
    if (isNaN(ms) || ms < 1000) ms = 1000;
    screenshotInterval = setInterval(() => captureScreenshot("periodic"), ms);
  }
}
capPeriodic.onchange = manageInterval;
capInterval.onchange = manageInterval;

// ===== Video/context messages =====
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "VIDEO_UPDATE") return;
  if (message.isAd) {
    videoTimeLabel.textContent = "ad";
    videoTimeLabel.style.color = "var(--warn)";
  } else {
    videoTimeLabel.style.color = "var(--brand)";
    currentVideoTime = message.time;
    videoTimeLabel.textContent = videoTimeStr(2) || "—";
    recTime.textContent = videoTimeStr(2) ? videoTimeStr(2) + "s" : "—";
    // While resting, the countdown owns the minimized time slot.
    if (restRemaining === null) {
      minimizedTimeText.textContent = videoTimeStr(2) ? videoTimeStr(2) + "s" : "—";
    }
  }

  const titleEl = $("videoTitleLabel");
  titleEl.textContent = message.isAd ? "Advertisement Playing" : message.title;
});

// ===== Capture-on-click (relayed from content script) =====
// Every click captures immediately (stimulus onset, as always). Optionally a
// second "settled" shot fires after the view stops moving (gallery fly-to
// animations, texture loads). Rapid clicks restart the settle timer, so one
// settled shot is taken, paired to the LAST click.
let settleTimer = null;
let pendingSettle = null; // { eventId, clickTMs } for the deferred settled shot

function settleDelayMs() {
  const s = parseFloat(capClickDelay.value);
  return isNaN(s) ? 3000 : s * 1000;
}

function updateSettleUI() {
  capClickDelayVal.textContent = (settleDelayMs() / 1000).toFixed(1) + " s";
  settledRow.classList.toggle('disabled', !capClick.checked);
  capClickDelay.disabled = !(capClick.checked && capSettled.checked);
}
capClickDelay.oninput = updateSettleUI;
updateSettleUI();

function cancelPendingSettle() {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  pendingSettle = null;
  shotCount.classList.remove('pending');
}
restEnable.onchange = () => { restDelay.disabled = !restEnable.checked; };
restDelay.disabled = !restEnable.checked;
capClick.onchange = () => { if (!capClick.checked) cancelPendingSettle(); updateSettleUI(); };
capSettled.onchange = () => { if (!capSettled.checked) cancelPendingSettle(); updateSettleUI(); };

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'PAGE_CLICK' || !isRecording || !capClick.checked) return;
  const eventId = ++eventSeq;
  const clickTMs = Date.now();
  captureScreenshot("click", { clickTMs, eventId, kind: 'onset' });
  if (!capSettled.checked) return;
  if (settleTimer) clearTimeout(settleTimer);
  pendingSettle = { eventId, clickTMs };
  shotCount.classList.add('pending');
  settleTimer = setTimeout(() => {
    const p = pendingSettle;
    cancelPendingSettle();
    captureScreenshot("click", { clickTMs: p.clickTMs, eventId: p.eventId, kind: 'settled' });
  }, settleDelayMs());
});

// ===== Connect / Disconnect =====
scanBtn.onclick = async () => {
  const connected = shimmer.device?.gatt?.connected;
  if (connected) {
    // Disconnect WITHOUT re-opening the pairing chooser.
    intentionalDisconnect = true;
    if (isRecording) stopRecording();
    if (isStreaming) { isStreaming = false; await shimmer.stopStreaming().catch(() => {}); }
    await shimmer.disconnect().catch(() => {});
    resetToOffline();
    return;
  }

  try {
    setConn('connecting', 'Connecting…');
    deviceStatusText.textContent = "Connecting…";
    scanBtn.textContent = "…";
    scanBtn.disabled = true;

    await shimmer.connect();
    intentionalDisconnect = false;

    if (shimmer.device?.name) deviceNameLabel.textContent = shimmer.device.name;
    shimmer.device?.addEventListener('gattserverdisconnected', onUnexpectedDisconnect);

    // live preview begins immediately; logging waits for the record button
    await startStreaming();

    setConn('online', 'Online');
    deviceStatusText.textContent = "Connected";
    scanBtn.textContent = "Disconnect";
    streamBtn.disabled = false;
  } catch (err) {
    setConn('error', 'Connection failed');
    deviceStatusText.textContent = "Not Connected";
    scanBtn.textContent = "Connect";
    if (err.name !== 'NotFoundError') console.error("Connection error:", err);
  } finally {
    scanBtn.disabled = false;
  }
};

function onUnexpectedDisconnect() {
  if (intentionalDisconnect) return;
  if (isRecording) stopRecording();
  isStreaming = false;
  setConn('error', 'Disconnected');
  deviceStatusText.textContent = "Connection lost";
  scanBtn.textContent = "Reconnect";
  streamBtn.disabled = true;
}

function resetToOffline() {
  setConn('offline', 'Offline');
  deviceNameLabel.textContent = "No Device";
  deviceStatusText.textContent = "Not Connected";
  scanBtn.textContent = "Connect";
  streamBtn.disabled = true;
}

// ===== Streaming (live preview; runs from connect to disconnect) =====
async function startStreaming() {
  await shimmer.setSamplingRate(128);
  await shimmer.setInternalExpPower(1);
  await shimmer.setGSRRange(4); // auto range
  // GSR (0x04) + PPG/INT_A1 (0x100)
  await shimmer.setSensors(SensorBitmapShimmer3.SENSOR_GSR | SensorBitmapShimmer3.SENSOR_INT_A1);
  await shimmer.startStreaming();
  shimmer.onStreamFrame = onFrame;
  isStreaming = true;
}

// ===== Resting baseline (record a baseline, then auto-play the video) =====
// Logging starts the moment recording begins so the resting period lands in the
// same CSV; the video is only triggered once the delay elapses.
let restTimer = null;
let restRemaining = null; // seconds left while resting; null when not resting

function showRest(remaining) {
  streamBtnText.textContent = `Resting… ${remaining}s`;
  minimizedTimeText.textContent = `${remaining}s`;
}

function cancelRest() {
  if (restTimer) { clearInterval(restTimer); restTimer = null; }
  restRemaining = null;
}

// Seconds of resting baseline, or 0 when the baseline is off / misconfigured.
function restSeconds() {
  const secs = Math.round(parseFloat(restDelay.value));
  if (!restEnable.checked || isNaN(secs) || secs <= 0) return 0;
  return secs;
}

function startRest() {
  cancelRest();
  const secs = restSeconds();
  if (!secs) return; // play manually
  restRemaining = secs;
  showRest(restRemaining);
  restTimer = setInterval(() => {
    restRemaining -= 1;
    if (restRemaining > 0) {
      showRest(restRemaining);
      // The widget is hidden by fullscreen, so the countdown the participant
      // sees is the one drawn on the neutral field by the content script.
      window.parent.postMessage({ type: 'REST_TICK', remaining: restRemaining }, '*');
      return;
    }
    cancelRest();
    streamBtnText.textContent = "Stop Recording";
    window.parent.postMessage({ type: 'PLAY_VIDEO' }, '*');
  }, 1000);
}

// ===== Recording (logging to CSV/timeline/screenshots) =====
function startRecording() {
  isRecording = true;
  body.classList.add('is-recording', 'has-shots');
  streamBtnText.textContent = "Stop Recording";
  setConn('online', 'Recording');
  manageInterval();

  // Fullscreen must be requested inside this click's activation window, before
  // the baseline — not at video onset, where the transition would confound the
  // stimulus response.
  if (immersiveEnable.checked) {
    window.parent.postMessage({ type: 'ENTER_IMMERSIVE', restSeconds: restSeconds() }, '*');
    setMinimized(true);
  }

  startRest();
}

function stopRecording() {
  isRecording = false;
  cancelRest(); // don't auto-play after the session ended
  cancelPendingSettle(); // don't fire a deferred shot after the session ended
  captureQueue.length = 0;
  body.classList.remove('is-recording');
  streamBtnText.textContent = "Start Recording";
  window.parent.postMessage({ type: 'EXIT_IMMERSIVE' }, '*');
  setMinimized(false);
  if (shimmer.device?.gatt?.connected) setConn('online', 'Online');
  manageInterval();
}

streamBtn.onclick = () => {
  if (!isStreaming) return;
  if (!isRecording) startRecording();
  else stopRecording();
};

// ===== Frame handling =====
function onFrame(oc) {
  if (!isStreaming) return;

  const gsr = oc.get('GSR', 'cal')?.value;
  if (gsr === undefined || gsr === null) return;

  const ppg = oc.get('PPG', 'raw')?.value;

  // live preview always updates; the session log only grows while recording
  if (isRecording) {
    const now = new Date();
    csvRows.push({
      timestamp: now.toISOString(),
      tMs: now.getTime(),
      videoTitle: ($("videoTitleLabel").textContent || "").replace(/,/g, ""),
      videoTime: videoTimeStr(3),
      gsr, ppg
    });
    tlFeed(now.getTime(), gsr);
  }

  latestGsr = gsr;
  if (ppg !== undefined) latestPpg = ppg;

  pushPoint(gsrChart, gsr);
  if (ppg !== undefined) pushPoint(ppgChart, ppg);

  scheduleDisplay();
}

function pushPoint(chart, value) {
  const ds = chart.data.datasets[0].data;
  ds.push(value);
  chart.data.labels.push("");
  if (ds.length > MAX_POINTS) { ds.shift(); chart.data.labels.shift(); }
}

// Throttle DOM + chart repaint to one rAF (~display refresh), not 128/s.
function scheduleDisplay() {
  if (displayDirty) return;
  displayDirty = true;
  requestAnimationFrame(() => {
    displayDirty = false;
    gsrValLabel.textContent = latestGsr != null ? latestGsr.toFixed(2) : "—";
    ppgValLabel.textContent = latestPpg != null ? latestPpg.toFixed(0) : "—";
    gsrChart.update('none');
    ppgChart.update('none');
    drawTimeline();
  });
}

// ===== Clear =====
clearBtn.onclick = () => {
  if (csvRows.length === 0 && screenshots.length === 0) return;
  if (!confirm("Clear all recorded data and screenshots for this session?")) return;

  csvRows = [];
  screenshots = [];
  shotsGrid.innerHTML = "";
  shotCount.textContent = "0";
  shotsEmpty.style.display = "";
  gsrChart.data.labels = []; gsrChart.data.datasets[0].data = []; gsrChart.update('none');
  ppgChart.data.labels = []; ppgChart.data.datasets[0].data = []; ppgChart.update('none');
  latestGsr = latestPpg = null;
  gsrValLabel.textContent = "—";
  ppgValLabel.textContent = "—";
  cancelPendingSettle();
  captureQueue.length = 0;
  shotSeq = 0;
  eventSeq = 0;
  tlReset();
  if (!isRecording) {
    body.classList.remove('has-shots');
    activateTab(tabLive); // Shots tab is now hidden; don't strand its panel
  }
};

// ===== Export =====
async function buildReport(t0ms) {
  const round3 = (x) => Math.round(x * 1000) / 1000;
  const titles = [...new Set(csvRows.map(r => r.videoTitle).filter(t => t && t !== "Waiting for media…" && t !== "Unknown"))];
  const payload = {
    exportedAt: new Date().toISOString(),
    device: shimmer.device?.name || null,
    titles,
    t: csvRows.map(r => round3((r.tMs - t0ms) / 1000)),
    gsr: csvRows.map(r => (typeof r.gsr === "number" ? round3(r.gsr) : null)),
    ppg: csvRows.map(r => (typeof r.ppg === "number" ? r.ppg : null)),
    events: screenshots.map(s => ({
      t: round3(((s.tMs ?? t0ms) - t0ms) / 1000),
      clickT: s.clickTMs != null ? round3((s.clickTMs - t0ms) / 1000) : null,
      event: s.eventId ?? null,
      kind: s.kind ?? null,
      iso: s.timestamp,
      reason: s.reason,
      videoTime: s.videoTime || "",
      title: s.title || "",
      file: s.file,
    })),
  };
  const tpl = await fetch(chrome.runtime.getURL("report_template.html")).then(r => r.text());
  // <-escape so titles containing "</script>" can't break out of the inline block
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return tpl.replace('"__SHIMMER_SESSION_DATA__"', json);
}

downloadBtn.onclick = async () => {
  if (csvRows.length === 0) { alert("No data recorded yet."); return; }

  const t0ms = csvRows[0].tMs;
  const header = ["Timestamp", "Elapsed (s)", "Video Title", "Video Time (s)", "GSR (uS)", "PPG (Raw)"];
  const csvContent = [
    header.join(","),
    ...csvRows.map(r => `${r.timestamp},${((r.tMs - t0ms) / 1000).toFixed(3)},${r.videoTitle},${r.videoTime},${r.gsr},${r.ppg ?? ""}`)
  ].join("\n");

  try {
    const zip = new JSZip();
    zip.file("results.csv", csvContent);
    if (screenshots.length > 0) {
      const evHeader = ["Timestamp", "Elapsed (s)", "Click Elapsed (s)", "Event", "Kind", "Video Time (s)", "Reason", "Page Title", "Filename"];
      const eventsCsv = [
        evHeader.join(","),
        ...screenshots.map(s =>
          `${s.timestamp},${(((s.tMs ?? t0ms) - t0ms) / 1000).toFixed(3)},${s.clickTMs != null ? ((s.clickTMs - t0ms) / 1000).toFixed(3) : ""},${s.eventId ?? ""},${s.kind ?? ""},${s.videoTime},${s.reason},${(s.title || "").replace(/,/g, "")},${s.file}`)
      ].join("\n");
      zip.file("events.csv", eventsCsv);
      const folder = zip.folder("screenshots");
      screenshots.forEach((s) => folder.file(s.file, s.dataUrl.split(',')[1], { base64: true }));
    }
    zip.file("report.html", await buildReport(t0ms));
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `shimmer_session_${Date.now()}.zip`);
  } catch (e) {
    console.error("ZIP export failed, falling back to CSV:", e);
    triggerDownload(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), `results_${Date.now()}.csv`);
  }
};

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
