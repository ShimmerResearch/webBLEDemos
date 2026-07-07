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
let isStreaming = false;
let intentionalDisconnect = false;
let currentVideoTime = 0;
let csvRows = [];
let screenshots = [];
let screenshotInterval = null;
let lastVideoTitle = "";

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

const capPeriodic = $("capPeriodic"), capInterval = $("capInterval"), capClick = $("capClick"), capNav = $("capNav");

const tabLive = $("tabLive"), tabShots = $("tabShots");
const shotCount = $("shotCount"), shotsGrid = $("shotsGrid"), shotsEmpty = $("shotsEmpty");
const clearBtn = $("clearBtn"), downloadBtn = $("downloadBtn");
const lightbox = $("lightbox"), lightboxImg = $("lightboxImg"), lightboxClose = $("lightboxClose");

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
function captureScreenshot(reason) {
  if (!isStreaming) return;
  chrome.runtime.sendMessage({ type: "TAKE_SCREENSHOT" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      console.error("Screenshot failed:", chrome.runtime.lastError?.message || response?.error);
      return;
    }
    if (!response.dataUrl) return;
    const shot = {
      timestamp: new Date().toISOString(),
      videoTime: currentVideoTime.toFixed(3),
      reason,
      dataUrl: response.dataUrl
    };
    screenshots.push(shot);
    appendShot(shot);
  });
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
  const timeEl = document.createElement('span');
  timeEl.textContent = shot.videoTime + 's';
  meta.appendChild(reasonEl);
  meta.appendChild(timeEl);
  el.appendChild(img);
  el.appendChild(meta);
  el.onclick = () => openLightbox(shot.dataUrl);
  shotsGrid.appendChild(el);
  shotCount.textContent = String(screenshots.length);
}

function openLightbox(src) { lightboxImg.src = src; lightbox.classList.add('open'); }
lightboxClose.onclick = () => lightbox.classList.remove('open');
lightbox.onclick = (e) => { if (e.target === lightbox) lightbox.classList.remove('open'); };

function manageInterval() {
  if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null; }
  if (isStreaming && capPeriodic.checked) {
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
    videoTimeLabel.textContent = currentVideoTime.toFixed(2);
    minimizedTimeText.textContent = currentVideoTime.toFixed(2) + "s";
    recTime.textContent = currentVideoTime.toFixed(2) + "s";
  }

  const titleEl = $("videoTitleLabel");
  const newTitle = message.isAd ? "Advertisement Playing" : message.title;
  if (capNav.checked && lastVideoTitle && lastVideoTitle !== newTitle && !message.isAd) {
    captureScreenshot("navigation");
  }
  lastVideoTitle = newTitle;
  titleEl.textContent = newTitle;
});

// capture-on-click relayed from content script
window.addEventListener('message', (event) => {
  if (event.data?.type === 'PAGE_CLICK' && isStreaming && capClick.checked) {
    captureScreenshot("click");
  }
});

// ===== Connect / Disconnect =====
scanBtn.onclick = async () => {
  const connected = shimmer.device?.gatt?.connected;
  if (connected) {
    // Disconnect WITHOUT re-opening the pairing chooser.
    intentionalDisconnect = true;
    if (isStreaming) await stopStreaming().catch(() => {});
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
  if (isStreaming) stopStreamingUI();
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

// ===== Streaming =====
async function startStreaming() {
  await shimmer.setSamplingRate(128);
  await shimmer.setInternalExpPower(1);
  await shimmer.setGSRRange(4); // auto range
  // GSR (0x04) + PPG/INT_A1 (0x100)
  await shimmer.setSensors(SensorBitmapShimmer3.SENSOR_GSR | SensorBitmapShimmer3.SENSOR_INT_A1);
  await shimmer.startStreaming();
  shimmer.onStreamFrame = onFrame;

  isStreaming = true;
  body.classList.add('is-recording', 'has-shots');
  streamBtnText.textContent = "Stop Recording";
  setConn('online', 'Recording');
  manageInterval();
}

async function stopStreaming() {
  await shimmer.stopStreaming();
  stopStreamingUI();
}

function stopStreamingUI() {
  isStreaming = false;
  body.classList.remove('is-recording');
  streamBtnText.textContent = "Start Recording";
  if (shimmer.device?.gatt?.connected) setConn('online', 'Online');
  manageInterval();
}

streamBtn.onclick = async () => {
  if (!shimmer.device?.gatt?.connected) return;
  try {
    if (!isStreaming) await startStreaming();
    else await stopStreaming();
  } catch (err) {
    console.error("Stream error:", err);
    setConn('error', 'Stream error');
  }
};

// ===== Frame handling =====
function onFrame(oc) {
  if (!isStreaming) return;

  const gsr = oc.get('GSR', 'cal')?.value;
  if (gsr === undefined || gsr === null) return;

  const ppg = oc.get('PPG', 'raw')?.value;

  csvRows.push({
    timestamp: new Date().toISOString(),
    videoTitle: ($("videoTitleLabel").textContent || "").replace(/,/g, ""),
    videoTime: currentVideoTime.toFixed(3),
    gsr, ppg
  });

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
  if (!isStreaming) {
    body.classList.remove('has-shots');
    activateTab(tabLive); // Shots tab is now hidden; don't strand its panel
  }
};

// ===== Export =====
downloadBtn.onclick = async () => {
  if (csvRows.length === 0) { alert("No data recorded yet."); return; }

  const header = ["Timestamp", "Video Title", "Video Time (s)", "GSR (uS)", "PPG (Raw)"];
  const csvContent = [
    header.join(","),
    ...csvRows.map(r => `${r.timestamp},${r.videoTitle},${r.videoTime},${r.gsr},${r.ppg}`)
  ].join("\n");

  try {
    const zip = new JSZip();
    zip.file("results.csv", csvContent);
    if (screenshots.length > 0) {
      const folder = zip.folder("screenshots");
      screenshots.forEach((s) => {
        const base64 = s.dataUrl.split(',')[1];
        const name = `shot_${s.timestamp.replace(/[:.]/g, '-')}_${s.videoTime}s_${s.reason}.jpg`;
        folder.file(name, base64, { base64: true });
      });
    }
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
