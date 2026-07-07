function cleanTitle(t) {
  if (!t) return "";
  return t
    .replace(/\s*\|\s*Netflix\s*$/i, "")
    .replace(/\s*-\s*Netflix\s*$/i, "")
    .replace(/^Netflix\s*-\s*/i, "")
    .trim();
}

function getNetflixTitle() {
  // Player overlay title (most important for /watch)
  const t1 = document.querySelector('[data-uia="video-title"]')?.textContent?.trim();
  // Often episode name / extra context
  const sub1 = document.querySelector('[data-uia="video-subtitle"]')?.textContent?.trim();
  const sub2 = document.querySelector('[data-uia="video-title"] [data-uia="video-subtitle"]')?.textContent?.trim();

  const title = cleanTitle(t1);
  const subtitle = cleanTitle(sub1 || sub2);

  if (title && subtitle) return `${title} — ${subtitle}`;
  if (title) return title;

  // Non-player pages (details pages etc.)
  const t2 = document.querySelector('[data-uia="title-info-title"]')?.textContent?.trim();
  if (t2) return cleanTitle(t2);

  // Meta fallback (sometimes present, sometimes not on /watch)
  const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
  if (og && cleanTitle(og).toLowerCase() !== "netflix") return cleanTitle(og);

  // Last resort
  return cleanTitle(document.title) || "Unknown";
}

function getYouTubeTitle() {
  const yt1 = document.querySelector('ytd-watch-metadata h1 yt-formatted-string')?.textContent?.trim();
  if (yt1) return yt1;

  const yt2 = document.querySelector('#title h1 yt-formatted-string')?.textContent?.trim();
  if (yt2) return yt2;

  const yt3 = document.querySelector('h1.title yt-formatted-string')?.textContent?.trim();
  if (yt3) return yt3;

  const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
  if (og) return og;

  return cleanTitle(document.title) || "Unknown";
}

function getTitle() {
  const host = location.hostname;
  if (host.includes("netflix.com")) return getNetflixTitle();
  if (host.includes("youtube.com")) return getYouTubeTitle();

  const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
  return cleanTitle(og || document.title) || "Unknown";
}

function broadcastData() {
	
  const video = document.querySelector('video');
  const isAdShowing = document.querySelector('.ad-showing, .ad-interrupting') !== null;

  try {
    chrome.runtime.sendMessage({
      type: "VIDEO_UPDATE",
      // Pages without a <video> (e.g. virtual tours) still report their title;
      // time is null so the companion knows there is no playback position.
      time: video ? video.currentTime : null,
      title: getTitle(),
      isPaused: video ? video.paused : true,
      isAd: isAdShowing
    });
  } catch (err) {
    // Ignore extension context invalidated error which happens when extension reloads
    // without refreshing the tab.
  }
}


// The content script is injected on every page, so stay idle until the
// companion overlay is first opened — no polling or DOM observation before then.
let broadcasting = false;
function startBroadcasting() {
  if (broadcasting) return;
  broadcasting = true;
  setInterval(broadcastData, 200);
  const observer = new MutationObserver(broadcastData);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

// === OVERLAY INJECTION ===
let overlayIframe = null;
let captureOverlay = null; // transparent full-page layer for smooth drag/resize

const DEFAULT_W = 360, DEFAULT_H = 640;
const MIN_W = 300, MIN_H = 200, MINIMIZED_H = 52;

function createOverlay() {
  startBroadcasting();
  overlayIframe = document.createElement('iframe');
  overlayIframe.src = chrome.runtime.getURL('shimmercompanion.html');
  const top = 20;
  const left = Math.max(20, window.innerWidth - DEFAULT_W - 20);
  Object.assign(overlayIframe.style, {
    position: 'fixed', top: top + 'px', left: left + 'px',
    width: DEFAULT_W + 'px', height: DEFAULT_H + 'px',
    border: 'none', borderRadius: '18px',
    boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
    zIndex: '2147483647', background: 'transparent', colorScheme: 'normal'
  });
  overlayIframe.allow = 'bluetooth';
  overlayIframe.dataset.fullHeight = String(DEFAULT_H);
  overlayIframe.dataset.minimized = 'false';
  document.body.appendChild(overlayIframe);
}

function toggleOverlay() {
  if (!overlayIframe) { createOverlay(); return; }
  overlayIframe.style.display = overlayIframe.style.display === 'none' ? 'block' : 'none';
}

// ---- Smooth drag / resize via a page-level capture layer ----
// Handling movement here (not inside the iframe) avoids lost events when the
// cursor leaves the iframe, removing the jitter/lag of the old approach.
const CURSORS = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize'
};

function startInteraction(kind, edges) {
  endInteraction();
  captureOverlay = document.createElement('div');
  captureOverlay.dataset.kind = kind;
  captureOverlay.dataset.edges = edges || '';
  Object.assign(captureOverlay.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647',
    cursor: kind === 'drag' ? 'grabbing' : (CURSORS[edges] || 'default'),
    background: 'transparent'
  });
  document.body.appendChild(captureOverlay);
  captureOverlay.addEventListener('mousemove', onCaptureMove);
  window.addEventListener('mouseup', endInteraction, { once: true });
}

function onCaptureMove(e) {
  if (!overlayIframe) return;
  const dx = e.movementX, dy = e.movementY;
  const kind = captureOverlay.dataset.kind;
  const minimized = overlayIframe.dataset.minimized === 'true';
  let top = parseFloat(overlayIframe.style.top) || 0;
  let left = parseFloat(overlayIframe.style.left) || 0;
  let w = parseFloat(overlayIframe.style.width) || DEFAULT_W;
  let h = parseFloat(overlayIframe.style.height) || DEFAULT_H;

  if (kind === 'drag') {
    left += dx; top += dy;
  } else {
    const edges = captureOverlay.dataset.edges;
    if (edges.includes('e')) w = Math.max(MIN_W, w + dx);
    if (edges.includes('w')) { const nw = w - dx; if (nw >= MIN_W) { w = nw; left += dx; } }
    if (!minimized && edges.includes('s')) h = Math.max(MIN_H, h + dy);
    if (!minimized && edges.includes('n')) { const nh = h - dy; if (nh >= MIN_H) { h = nh; top += dy; } }
  }

  // Keep a grab-able strip on screen.
  left = Math.min(Math.max(left, 40 - w), window.innerWidth - 48);
  top = Math.min(Math.max(top, 0), window.innerHeight - 40);

  overlayIframe.style.left = left + 'px';
  overlayIframe.style.top = top + 'px';
  overlayIframe.style.width = w + 'px';
  if (!minimized) {
    overlayIframe.style.height = h + 'px';
    overlayIframe.dataset.fullHeight = String(h);
  }
}

function endInteraction() {
  if (!captureOverlay) return;
  captureOverlay.removeEventListener('mousemove', onCaptureMove);
  captureOverlay.remove();
  captureOverlay = null;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TOGGLE_OVERLAY') toggleOverlay();
});

window.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || !overlayIframe) return;

  switch (d.type) {
    case 'CLOSE_OVERLAY':
      overlayIframe.style.display = 'none';
      break;
    case 'MINIMIZE_OVERLAY':
      if (overlayIframe.dataset.minimized === 'true') {
        overlayIframe.style.height = (overlayIframe.dataset.fullHeight || DEFAULT_H) + 'px';
        overlayIframe.dataset.minimized = 'false';
      } else {
        overlayIframe.dataset.fullHeight = String(parseFloat(overlayIframe.style.height) || DEFAULT_H);
        overlayIframe.style.height = MINIMIZED_H + 'px';
        overlayIframe.dataset.minimized = 'true';
      }
      break;
    case 'DRAG_START':
      startInteraction('drag');
      break;
    case 'RESIZE_START':
      startInteraction('resize', d.edges);
      break;
  }
});

document.addEventListener('click', () => {
  if (overlayIframe && overlayIframe.contentWindow) {
    overlayIframe.contentWindow.postMessage({ type: 'PAGE_CLICK' }, '*');
  }
});
