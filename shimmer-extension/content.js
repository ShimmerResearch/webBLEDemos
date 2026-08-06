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

// True until the extension is reloaded/updated/disabled out from under this
// tab, at which point chrome.runtime.id becomes undefined.
function contextAlive() {
  return Boolean(chrome.runtime?.id);
}

function broadcastData() {
  if (!contextAlive()) { stopBroadcasting(); return; }

  const video = document.querySelector('video');
  const isAdShowing = document.querySelector('.ad-showing, .ad-interrupting') !== null;

  try {
    // No callback, so this returns a Promise: an invalidated context surfaces
    // as a rejection, not a throw, and needs its own handler.
    const p = chrome.runtime.sendMessage({
      type: "VIDEO_UPDATE",
      // Pages without a <video> (e.g. virtual tours) still report their title;
      // time is null so the companion knows there is no playback position.
      time: video ? video.currentTime : null,
      title: getTitle(),
      isPaused: video ? video.paused : true,
      ended: video ? video.ended : false,
      isAd: isAdShowing
    });
    if (p && typeof p.catch === 'function') p.catch(stopBroadcasting);
  } catch (err) {
    // Extension context invalidated / no receiving end: stop trying.
    stopBroadcasting();
  }
}


// The content script is injected on every page, so stay idle until the
// companion overlay is first opened — no polling or DOM observation before then.
let broadcasting = false;
let broadcastTimer = null;
let broadcastObserver = null;

function startBroadcasting() {
  if (broadcasting) return;
  broadcasting = true;
  broadcastTimer = setInterval(broadcastData, 200);
  broadcastObserver = new MutationObserver(broadcastData);
  broadcastObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// Called once the extension context dies; otherwise the interval and the
// (very chatty on YouTube) observer would keep re-raising the same error.
function stopBroadcasting() {
  if (!broadcasting) return;
  broadcasting = false;
  clearInterval(broadcastTimer);
  broadcastTimer = null;
  broadcastObserver?.disconnect();
  broadcastObserver = null;
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
  overlayIframe.allow = 'bluetooth; camera';
  overlayIframe.dataset.fullHeight = String(DEFAULT_H);
  overlayIframe.dataset.minimized = 'false';
  document.body.appendChild(overlayIframe);
}

function toggleOverlay() {
  if (!overlayIframe) { createOverlay(); return; }
  overlayIframe.style.display = overlayIframe.style.display === 'none' ? 'block' : 'none';
}

// === IMMERSIVE MODE ===
// Fullscreen is entered on the Start Recording click — never at video onset.
// An abrupt fullscreen transition elicits a non-specific SCR of its own, so it
// must not coincide with the stimulus; the resting baseline runs behind a
// neutral field and the video fades in once it elapses.
const NEUTRAL_FIELD = '#808080'; // mid-grey, near the mean luminance of video
const FADE_MS = 700;

let baselineCover = null;

// The player container rather than the bare <video>: keeps the site's own
// controls usable, and gives us an element to parent the cover to.
function getPlayerRoot() {
  const video = document.querySelector('video');
  if (!video) return null;
  return video.closest(
    '#movie_player, .html5-video-player, .watch-video, [data-uia="video-canvas"]'
  ) || video.parentElement || video;
}

// In fullscreen only the fullscreen element's subtree is painted, so the cover
// has to live inside it — and the overlay iframe is hidden for free.
function showBaselineCover(parent, seconds) {
  hideBaselineCover();
  baselineCover = document.createElement('div');
  Object.assign(baselineCover.style, {
    position: 'absolute', inset: '0', zIndex: '2147483647',
    background: NEUTRAL_FIELD, opacity: '1',
    transition: `opacity ${FADE_MS}ms linear`,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    font: '400 14px system-ui, sans-serif', color: 'rgba(0,0,0,0.55)',
    userSelect: 'none', pointerEvents: 'none'
  });

  // Fixation cross: holds gaze centrally and limits mind-wandering, which
  // would otherwise add spontaneous SCRs to the "resting" period.
  const cross = document.createElement('div');
  cross.textContent = '+';
  Object.assign(cross.style, { font: '300 40px system-ui, sans-serif', lineHeight: '1' });

  const note = document.createElement('div');
  note.dataset.role = 'countdown';
  Object.assign(note.style, { marginTop: '18px', letterSpacing: '0.04em' });
  note.textContent = seconds > 0 ? `Please relax and stay still — ${seconds}s` : 'Please relax and stay still';

  baselineCover.append(cross, note);
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  parent.appendChild(baselineCover);
}

function updateBaselineCover(seconds) {
  const note = baselineCover?.querySelector('[data-role="countdown"]');
  if (note) note.textContent = `Please relax and stay still — ${seconds}s`;
}

// Fade rather than cut: a hard grey→video step is a luminance transient that
// contaminates the first seconds of the stimulus response.
function fadeOutBaselineCover() {
  if (!baselineCover) return;
  const cover = baselineCover;
  baselineCover = null;
  cover.style.opacity = '0';
  setTimeout(() => cover.remove(), FADE_MS + 50);
}

function hideBaselineCover() {
  baselineCover?.remove();
  baselineCover = null;
}

function enterImmersive(restSeconds) {
  const root = getPlayerRoot();
  if (!root) return;
  // Cover first, so nothing is briefly revealed as fullscreen animates in.
  showBaselineCover(root, restSeconds);
  // A click inside the overlay iframe grants the parent transient activation
  // too, but only for a few seconds — hence entering here and not at onset.
  root.requestFullscreen?.().catch(() => {
    // Blocked (activation expired, or permissions-policy): the neutral field
    // and baseline still work windowed, just not fullscreen.
  });
}

function exitImmersive() {
  hideBaselineCover();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

// Escape / the player's own control leaves fullscreen without telling us; the
// cover would then be stranded over the windowed player.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) hideBaselineCover();
});

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
  // Only the extension iframe may control the injected overlay or host page.
  // Without this check, the host page could spoof immersive/play/resize commands.
  if (event.source !== overlayIframe?.contentWindow) return;
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
    case 'ENTER_IMMERSIVE':
      enterImmersive(d.restSeconds || 0);
      break;
    case 'REST_TICK':
      updateBaselineCover(d.remaining);
      break;
    case 'EXIT_IMMERSIVE':
      exitImmersive();
      break;
    case 'PLAY_VIDEO': {
      // Fired by the companion once the resting-baseline delay elapses.
      // Fade starts with playback so onset of sound and picture coincide.
      fadeOutBaselineCover();
      const video = document.querySelector('video');
      if (video && video.paused) {
        video.play().catch(() => {
          // Autoplay policy may block a programmatic play after the activation
          // gesture has expired; fall back to clicking the player's play button.
          document.querySelector(
            '.ytp-play-button, button[data-uia="control-play-pause-play"], button[title="Play"], button[aria-label="Play"]'
          )?.click();
        });
      }
      break;
    }
  }
});

document.addEventListener('click', () => {
  if (!overlayIframe || !contextAlive()) return;
  const p = chrome.runtime.sendMessage({ type: 'PAGE_CLICK' });
  if (p && typeof p.catch === 'function') p.catch(() => {});
});
