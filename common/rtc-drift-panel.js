/**
 * Real-world-clock drift monitor: read the sensor's clock against this host's
 * on a timer, fit the slope in ppm, plot it, and export the series as CSV.
 *
 * Folded in from the standalone `rtc-drift-test` page, which this module
 * replaces. That page owned its own connect buttons, log and dark-only CSS;
 * everything that actually measured anything is here, unchanged in substance:
 * the two read paths, the round-trip-midpoint host timestamps, the one-sample-
 * at-a-time guard, the quarter-hour clock-base detection, the least-squares
 * plot, the screen wake lock and the BOM'd CSV.
 *
 * Why the measurement is worth having: the Shimmer3R real-world clock is
 * driven by the 32 kHz LSE crystal, so the crystal's error shows up here
 * directly. That is the LSE-only ground truth the firmware self-test cannot
 * give on its own — its crystal check measures the LSE against the HSE, and a
 * differential of two oscillators cannot say which one is off. First hardware
 * runs (2026-08-10, docked): a stock 12 pF Shimmer3R came out at about
 * -9 ppm — near spec, unlike the Verisense, whose identical BOM ran +40 to
 * +65 ppm fast — while a 22 pF-reworked unit came out at about -98 ppm, i.e.
 * over-loaded. Docked units read a few ppm low from charge self-heating, so a
 * battery/BLE run at ambient is the spec-comparable figure. A usable estimate
 * takes 1-2 hours; longer runs tighten it.
 *
 * Prefer a wired link when there is one: dock/USB round trips jitter far less
 * than BLE, and the midpoint estimate below is only as good as the assumption
 * that the two halves of a round trip take the same time.
 *
 * The panel emits no `.card` of its own — unlike `sd-browser.js`, which is a
 * whole tab, this one is a section inside the mounting page's card, so the
 * page keeps its heading and its explanatory note.
 *
 * Nothing here touches `document` at import time.
 *
 *   import { createRtcDriftPanel } from "../common/rtc-drift-panel.js";
 */

import { el, downloadBlob, fmtDuration } from "./ui-chrome.js";
import { onThemeChange } from "./theme.js";
import { readDeviceRwc, canReadRwc } from "./device-clock.js";
/* The whole namespace rather than destructured names: a vendored bundle that
   predates `RtcDriftMonitor` then degrades to a banner from
   `createRtcDriftPanel()` instead of throwing at import time and taking the
   whole page with it. */
import * as sdk from "../vendor/shimmer-web-sdk.esm.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sampling interval bounds and default, in seconds. */
const MIN_INTERVAL_S = 2;
const MAX_INTERVAL_S = 600;
const DEFAULT_INTERVAL_S = 30;

/** The real-world clock counts 32768 Hz ticks, on both read paths. */
const TICKS_PER_SEC = 32768;

/**
 * Clock-base detection grid. Every civil time zone in use is a whole number of
 * quarter-hours from UTC, and so is every time-set convention worth absorbing,
 * so a device-minus-host offset that lands within {@link CLOCK_BASE_SLACK_S}
 * of a 900 s multiple is a base rather than an error.
 */
const CLOCK_BASE_GRID_S = 900;
const CLOCK_BASE_SLACK_S = 120;

/** Beyond this the fit is called out as out of spec. */
const PPM_BAD = 25;

/** Below this the series is too short for the slope to mean anything. */
const MIN_FIT_MINUTES = 2;

/** Logical plot height. Mirrors `.drift-plot` in `common/theme.css`. */
const PLOT_HEIGHT_PX = 180;
const PLOT_PAD_PX = 26;

/** Backing-store cap: past 3x the plot costs memory for no visible gain. */
const MAX_PLOT_DPR = 3;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asGetter(value, fallback = null) {
  if (typeof value === "function") return value;
  return () => value ?? fallback;
}

/** `+1.23` / `-0.40` — a leading sign, because these are all differences. */
function signed(value, digits) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/** A clock base as `+9:00 h`. */
function fmtClockBase(sec) {
  const sign = sec < 0 ? "-" : "+";
  const abs = Math.abs(sec);
  const minutes = String(Math.round((abs % 3600) / 60)).padStart(2, "0");
  return `${sign}${Math.floor(abs / 3600)}:${minutes} h`;
}

/** Read a CSS custom property off an element, with a fallback. */
function cssVar(node, name, fallback) {
  try {
    const value = getComputedStyle(node).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    /* A detached node has no computed style; the fallback still draws. */
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Mount the clock-drift monitor inside `host`.
 *
 * @param {HTMLElement} host a container; its contents are replaced
 * @param {object} [opts]
 * @param {object|(() => object|null)} [opts.client] the connected client, or a
 *   getter for it. Pass the GETTER form from a page whose client comes and
 *   goes with the link — the panel is mounted once and then reads whatever is
 *   current, so it can never hold a stale client.
 * @param {string|(() => string|null)} [opts.mode] `"ble"`, `"rfcomm"` or
 *   `"usb"`; a getter for the same reason. Only `"usb"` changes behaviour: it
 *   selects the dock read and the dock clock write.
 * @param {{log: Function, warn: Function, error: Function}} [opts.log]
 * @param {(message: string, kind?: string) => void} [opts.toast]
 * @param {() => string|null} [opts.canSample] the mounting page's reason to
 *   skip this tick — "the sensor is streaming", "a self-test is running" —
 *   or null to go ahead. Asked once per tick BEFORE the link is touched,
 *   because a page that refuses a busy link by toasting would otherwise toast
 *   on every tick of a long run.
 * @param {(fn: () => Promise<unknown>) => Promise<unknown>} [opts.withLink]
 *   run one round trip under the page's busy flag. Defaults to calling `fn`
 *   directly. A page wrapper that tolerates failures by resolving `undefined`
 *   (`withDevice(..., {tolerate: true})`) is handled: that is a skipped
 *   sample, not a reading.
 * @param {(utcMs: number) => number} [opts.hostToDeviceMillis] convert host
 *   Unix ms to whatever the sensor's clock counts. Defaults to the identity,
 *   which is correct for Shimmer3/3R: the firmware's real-world clock is a
 *   true Unix epoch, as Consensys and the Java dock driver write it. The one
 *   hook exists so a page whose sensors follow the other convention (civil
 *   local time) can shift the write in ONE place instead of scattering
 *   timezone arithmetic through the panel.
 * @param {() => void} [opts.onClockWritten] called after a successful Sync, so
 *   the page can refresh whatever it shows about the sensor's clock.
 * @param {string|(() => string|null)} [opts.fileNamePrefix="shimmer"] leading
 *   part of the exported CSV's name; a getter, so a page can name the file
 *   after a sensor that was not connected when the panel was mounted.
 * @param {string|(() => string|null)} [opts.deviceLabel] what to record as the
 *   device in the CSV preamble.
 * @returns {{
 *   start: () => boolean,
 *   stop: () => boolean,
 *   sample: () => Promise<boolean>,
 *   sync: () => Promise<boolean>,
 *   rebaseline: () => void,
 *   noteClockWritten: () => void,
 *   running: () => boolean,
 *   sampling: () => boolean,
 *   monitor: () => object|null,
 *   clockBaseSec: () => number|null,
 *   supports: (client?: object|null, mode?: string|null) => boolean,
 *   setEnabled: (enabled: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createRtcDriftPanel(host, opts = {}) {
  const getClient = asGetter(opts.client);
  const getMode = asGetter(opts.mode);
  const log = opts.log ?? { log() {}, warn() {}, error() {} };
  const toast = opts.toast ?? (() => {});
  const canSample = opts.canSample ?? (() => null);
  const withLink = opts.withLink ?? ((fn) => fn());
  const hostToDeviceMillis = opts.hostToDeviceMillis ?? ((utcMs) => utcMs);
  const onClockWritten = opts.onClockWritten ?? (() => {});
  const getFilePrefix = asGetter(opts.fileNamePrefix, "shimmer");
  const getDeviceLabel = asGetter(opts.deviceLabel);

  /* A vendored bundle from before the drift monitor shipped: say so here,
     once, rather than throwing from the first Start. Only the monitor is
     required — the dock time property below is optional, and its absence
     costs the wired read path, not the panel. */
  if (typeof sdk.RtcDriftMonitor !== "function") {
    host.replaceChildren(
      el(
        "div",
        { class: "banner err" },
        "This page is running an SDK bundle with no clock-drift support (missing RtcDriftMonitor). Re-vendor the SDK to measure the sensor's clock against this host.",
      ),
    );
    log.error(
      "clock drift unavailable: the vendored SDK has no RtcDriftMonitor",
    );
    return inertDriftPanel();
  }

  const monitor = new sdk.RtcDriftMonitor();

  /** Non-null only while sampling on a timer. */
  let timer = null;
  /** One read is in flight. */
  let sampleInFlight = false;
  /** The screen wake lock, while it is held. */
  let wakeLock = null;
  /** The visibilitychange listener, while sampling. */
  let onVisibility = null;
  /**
   * Whole-quarter-hour base between the sensor's clock and this host's,
   * detected from the first sample of a series; null until then, 0 once
   * detection has run and found none.
   */
  let clockBase = null;
  /** The raw device-minus-host offset detection ran on, for the base line. */
  let clockBaseRawSec = null;
  /** The last skip reason logged, so a recurring one is not logged per tick. */
  let lastSkipReason = null;
  /** The client the base was detected against. */
  let lastClient = null;
  /** The host page's floor: is this link able to read a clock at all? */
  let enabled = false;
  /** CSS width the plot was last sized to, so a resize is a real change. */
  let lastPlotWidth = 0;
  let destroyed = false;

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  /* `data-drift-role` and `data-drift-stat` on everything the panel owns. Not
     decoration: it is how a mounting application (or a test) addresses one of
     these without the panel having to plant ids that would collide if it were
     mounted twice on one page. */

  const intervalInput = el("input", {
    type: "number",
    min: String(MIN_INTERVAL_S),
    max: String(MAX_INTERVAL_S),
    value: String(DEFAULT_INTERVAL_S),
    dataset: { driftRole: "interval" },
    "aria-label": "Sampling interval in seconds",
  });

  const btnStart = el(
    "button",
    { type: "button", class: "primary", dataset: { driftRole: "start" } },
    "Start",
  );
  const btnStop = el(
    "button",
    { type: "button", dataset: { driftRole: "stop" } },
    "Stop",
  );
  const btnSample = el(
    "button",
    { type: "button", dataset: { driftRole: "sample" } },
    "Sample now",
  );
  const btnSync = el(
    "button",
    {
      type: "button",
      dataset: { driftRole: "sync" },
      title:
        "Write this host's clock to the sensor and restart the fit from the next sample",
    },
    "Sync clock to host",
  );
  const btnRebaseline = el(
    "button",
    {
      type: "button",
      dataset: { driftRole: "rebaseline" },
      title: "Drop the collected samples and restart the fit",
    },
    "Reset baseline",
  );
  const btnCsv = el(
    "button",
    { type: "button", dataset: { driftRole: "csv" } },
    "Save CSV",
  );
  const wakePill = el(
    "span",
    { class: "pill", dataset: { driftRole: "wake" } },
    "wake lock off",
  );

  const statusLine = el(
    "div",
    { class: "field-hint", dataset: { driftRole: "status" } },
    "Not sampling.",
  );
  const baseLine = el("div", {
    class: "field-hint",
    dataset: { driftRole: "base" },
  });

  const stat = (key, label) =>
    el(
      "div",
      {},
      el("span", { class: "stat-label" }, label),
      el("span", { class: "stat-value", dataset: { driftStat: key } }, "–"),
    );

  const statsStrip = el(
    "div",
    { class: "stats" },
    stat("samples", "Samples"),
    stat("elapsed", "Elapsed"),
    stat("ppm", "Drift fit"),
    stat("perDay", "Per day"),
    stat("offset", "Offset (sensor − host)"),
    stat("rtt", "Last round trip"),
    stat("deviceSteps", "Sensor clock steps"),
    stat("hostSteps", "Host clock steps"),
  );

  const statNode = (key) =>
    statsStrip.querySelector(`[data-drift-stat="${key}"]`);
  const setStat = (key, text) => {
    const node = statNode(key);
    if (node) node.textContent = text;
  };

  const canvas = el("canvas", {
    class: "drift-plot",
    dataset: { driftRole: "plot" },
    "aria-label": "Clock offset drift since the first sample",
  });
  /* The canvas sits in a wrapper and is measured through it. A canvas with no
     stylesheet rule takes its layout size from the width/height attributes,
     so measuring the canvas itself would make every draw multiply its own
     width by devicePixelRatio. The wrapper is a plain block box, so its width
     is the container's and cannot run away. */
  const plotBox = el("div", {}, canvas);

  host.replaceChildren(
    el(
      "div",
      { class: "row" },
      el("label", { class: "muted" }, "Sample every ", intervalInput, " s"),
      btnStart,
      btnStop,
      btnSample,
      btnSync,
      btnRebaseline,
      btnCsv,
      wakePill,
    ),
    statusLine,
    baseLine,
    statsStrip,
    plotBox,
    el(
      "div",
      { class: "field-hint" },
      "Offset drift since the first sample (dots) with its least-squares fit (line).",
    ),
  );

  intervalInput.addEventListener("change", () => {
    intervalInput.value = String(intervalSeconds());
  });
  btnStart.addEventListener("click", () => start());
  btnStop.addEventListener("click", () => {
    if (stop()) log.log("clock drift: sampling stopped");
  });
  btnSample.addEventListener("click", () => {
    sample();
  });
  btnSync.addEventListener("click", () => {
    sync();
  });
  btnRebaseline.addEventListener("click", () => rebaseline());
  btnCsv.addEventListener("click", () => saveCsv());

  // -------------------------------------------------------------------------
  // Capability
  // -------------------------------------------------------------------------

  /**
   * Can this client, on this link, have its clock read at all?
   *
   * `canReadRwc` is the same predicate `readDeviceSeconds` acts on, from the
   * same module — so a panel that says yes here never fails at the first
   * sample with "undefined is not a function". They used to be two copies of
   * the rule side by side, which is survivable; the page's third copy was not
   * (see `common/device-clock.js`).
   *
   * @param {object|null} [client]
   * @param {string|null} [mode]
   * @returns {boolean}
   */
  function supports(client = getClient(), mode = getMode()) {
    return canReadRwc(client, mode);
  }

  /** Can the sensor's clock be WRITTEN over this link? Sync needs this. */
  function supportsWrite(client = getClient(), mode = getMode()) {
    if (!client) return false;
    const wired = mode === "usb" || typeof client.setRtcTime !== "function";
    if (!wired) return true;
    return typeof client.writeRtcFromHostTime === "function";
  }

  // -------------------------------------------------------------------------
  // Reading the sensor's clock
  // -------------------------------------------------------------------------

  /**
   * One clock reading, in seconds, RAW — no epoch assumed.
   *
   * Different tools set the real-world clock from different bases: the Java
   * dock driver and Consensys write UTC ms x 32.768, while the Verisense
   * console writes local civil time. The clock-base detection below absorbs
   * whichever base the sensor in front of us happens to carry, so the offset
   * readout always shows the true clock error — but only if this function
   * hands it the reading unmodified.
   */
  async function readDeviceSeconds() {
    /* Which of the two reads works is a property of the LINK, and that
       knowledge now lives in `common/device-clock.js` — this panel had it
       first and was the only place that did, which is how the page's own
       clock readouts came to give up over USB on a link that can in fact
       answer. Ticks rather than `unixMs` so the seconds keep their full
       resolution through the division. */
    const { ticks } = await readDeviceRwc(getClient(), getMode());
    return Number(ticks) / TICKS_PER_SEC;
  }

  /**
   * A sensor swap (or a reconnect) may bring a different clock base — a unit
   * set by a tool that writes civil local time, say. Re-detect it from the
   * next sample rather than carrying the previous sensor's base over.
   */
  function noteClientChange() {
    const client = getClient() ?? null;
    if (client === lastClient) return;
    lastClient = client;
    clockBase = null;
    clockBaseRawSec = null;
    paintBase();
  }

  /** The page's reason to skip, then the panel's own floor. */
  function skipReason() {
    const pageReason = canSample();
    if (pageReason) return pageReason;
    if (!supports())
      return "this link cannot read the sensor's real-world clock";
    return null;
  }

  function noteSkipped(reason) {
    setStatus(`Sample skipped — ${reason}`);
    /* Once per distinct reason. A 30 s tick against a link that is busy for
       an hour would otherwise write 120 identical lines into a shared log. */
    if (reason !== lastSkipReason) {
      lastSkipReason = reason;
      log.log(`clock drift: sample skipped — ${reason}`);
    }
  }

  /**
   * Take one reading and fold it into the fit.
   *
   * @returns {Promise<boolean>} true when a sample was actually recorded
   */
  async function sample() {
    /* One sample at a time: a read slower than the interval (BLE latency,
       retries) must not overlap the next tick and interleave monitor
       updates. */
    if (sampleInFlight || destroyed) return false;
    noteClientChange();
    const reason = skipReason();
    if (reason) {
      noteSkipped(reason);
      return false;
    }
    sampleInFlight = true;
    try {
      return await sampleInner();
    } finally {
      sampleInFlight = false;
      paintControls();
    }
  }

  async function sampleInner() {
    let rttMs = 0;
    let hostEndMs = 0;
    let perfMs = 0;
    let devSec;
    try {
      devSec = await withLink(async () => {
        /* Timestamped INSIDE the link wrapper, around the round trip itself:
           a page's withLink also flips its busy flag and re-gates its
           controls, and folding that DOM work into the measurement would bias
           the midpoint by however long the re-gate took. */
        const p0 = performance.now();
        const seconds = await readDeviceSeconds();
        const p1 = performance.now();
        rttMs = p1 - p0;
        hostEndMs = Date.now();
        perfMs = p0 + rttMs / 2;
        return seconds;
      });
    } catch (err) {
      const message = err?.message ?? String(err);
      setStatus(`Sample failed — ${message}`);
      log.warn(`clock drift: sample failed: ${message}`);
      return false;
    }
    if (!Number.isFinite(devSec)) {
      /* A page's withLink can refuse or tolerate a round trip and resolve
         with undefined rather than throwing. That is a skipped sample, not a
         reading of zero. */
      noteSkipped("the link was busy with another command");
      return false;
    }

    /* Host wall time at the MIDPOINT of the round trip. The reading was taken
       somewhere inside the round trip, so pairing it with either end would
       bias every sample by up to a whole round trip; the midpoint bounds the
       error to +/- rtt/2 and, being symmetric, averages out of the slope. */
    const hostSec = (hostEndMs - rttMs / 2) / 1000;

    if (clockBase === null) {
      const raw = devSec - hostSec;
      const base = Math.round(raw / CLOCK_BASE_GRID_S) * CLOCK_BASE_GRID_S;
      /* Only treat the quarter-hour multiple as a timezone / time-set
         convention when the residual is small: a genuinely wrong clock (more
         than ~2 min off the grid) must SHOW as wrong, not be folded into the
         base — otherwise a 10-minute error would display as its rounding
         remainder and read as a healthy sensor. */
      clockBaseRawSec = raw;
      if (base !== 0 && Math.abs(raw - base) <= CLOCK_BASE_SLACK_S) {
        clockBase = base;
        log.log(
          `clock drift: clock base ${fmtClockBase(base)} detected (timezone or time-set convention) — offsets are shown relative to it`,
        );
      } else {
        clockBase = 0;
        if (Math.abs(raw) > CLOCK_BASE_SLACK_S) {
          log.warn(
            `clock drift: the sensor's clock is ${signed(raw, 0)} s off this host's, too far off the quarter-hour grid to be a timezone — consider "Sync clock to host" before a long run (the drift fit itself is unaffected)`,
          );
        }
      }
      paintBase();
    }
    devSec -= clockBase;

    const event = monitor.addSample({
      hostSec,
      devSec,
      rttMs: Math.round(rttMs),
      perfMs,
    });
    if (event.kind === "host-step") {
      log.warn(
        `clock drift: THIS HOST's clock stepped ${event.hostStepSec.toFixed(2)} s (NTP?) — the fit was rebaselined and the series restarts from this sample`,
      );
    } else if (event.kind === "device-step") {
      log.warn(
        `clock drift: the SENSOR's clock stepped ${event.deltaSec.toFixed(2)} s — something wrote it mid-run`,
      );
    }

    lastSkipReason = null;
    setStatus(
      timer
        ? `Sampling every ${intervalSeconds()} s — ${monitor.samples.length} sample${monitor.samples.length === 1 ? "" : "s"} in this series.`
        : `Sampled — ${monitor.samples.length} sample${monitor.samples.length === 1 ? "" : "s"} in this series.`,
    );
    render();
    return true;
  }

  // -------------------------------------------------------------------------
  // Sampling control
  // -------------------------------------------------------------------------

  function intervalSeconds() {
    const raw = Number(intervalInput.value);
    const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_S;
    return Math.min(
      MAX_INTERVAL_S,
      Math.max(MIN_INTERVAL_S, Math.round(seconds)),
    );
  }

  /**
   * Start sampling on a timer, with one immediate sample so the run is not a
   * blank plot for the first interval.
   *
   * @returns {boolean} true when this call started it
   */
  function start() {
    if (timer || destroyed) return false;
    const seconds = intervalSeconds();
    intervalInput.value = String(seconds);
    timer = setInterval(() => {
      sample();
    }, seconds * 1000);
    subscribeVisibility();
    acquireWakeLock();
    log.log(
      `clock drift: sampling the sensor's clock every ${seconds} s — leave it running (1-2 h for a first estimate, longer is tighter)`,
    );
    setStatus(`Sampling every ${seconds} s.`);
    paintControls();
    sample();
    return true;
  }

  /**
   * Stop the timer and release the wake lock. Idempotent, and deliberately
   * NOT gated on {@link setEnabled}: whatever made the page disable the panel,
   * the user must still be able to stop a run.
   *
   * @returns {boolean} true when this call stopped a run
   */
  function stop() {
    const wasRunning = !!timer;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    unsubscribeVisibility();
    releaseWakeLock();
    if (wasRunning) setStatus("Not sampling.");
    paintControls();
    return wasRunning;
  }

  // -------------------------------------------------------------------------
  // Wake lock
  // -------------------------------------------------------------------------

  async function acquireWakeLock() {
    try {
      if (!("wakeLock" in navigator)) return;
      const lock = await navigator.wakeLock.request("screen");
      if (destroyed || !timer) {
        /* The run ended while the request was in flight. */
        lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      paintWake();
      lock.addEventListener("release", () => {
        /* Clear the handle: the UA releases the lock whenever the tab is
           backgrounded, and re-acquisition below is gated on !wakeLock. */
        wakeLock = null;
        paintWake();
      });
    } catch {
      /* Not fatal. A run without a wake lock still measures — the host may
         just sleep and leave a gap in the series, which the fit survives
         because it uses real host timestamps rather than a tick count. */
    }
  }

  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    paintWake();
  }

  /* Subscribed only while sampling, so a mounted-but-idle panel is not a
     permanent document listener on a page that mounts several of these. */
  function subscribeVisibility() {
    if (onVisibility) return;
    onVisibility = () => {
      if (document.visibilityState === "visible" && timer && !wakeLock)
        acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibility);
  }

  function unsubscribeVisibility() {
    if (!onVisibility) return;
    document.removeEventListener("visibilitychange", onVisibility);
    onVisibility = null;
  }

  // -------------------------------------------------------------------------
  // Writing the sensor's clock
  // -------------------------------------------------------------------------

  /**
   * Write this host's clock to the sensor and restart the fit.
   *
   * @returns {Promise<boolean>} true when the write succeeded
   */
  async function sync() {
    const client = getClient();
    if (!client) {
      toast("Connect a sensor first.", "warn");
      return false;
    }
    if (!supportsWrite(client)) {
      toast("This link has no command to set the sensor's clock.", "warn");
      return false;
    }
    /* The convention lives in this ONE hook. By default the value written is
       plain Unix ms, which is what the Shimmer3/3R firmware keeps: a true
       epoch, the same thing Consensys and the Java dock driver write. */
    const deviceMs = hostToDeviceMillis(Date.now());
    try {
      await withLink(async () => {
        if (getMode() === "usb" || typeof client.setRtcTime !== "function") {
          /* Wired: the clock is SET by writing RTC_CFG_TIME. CURR_LOCAL_TIME,
             the property the read path uses, is read-only and answers a write
             with BAD_CMD. */
          await client.writeRtcFromHostTime(deviceMs);
        } else {
          await client.setRtcTime(deviceMs);
        }
      });
    } catch (err) {
      const message = err?.message ?? String(err);
      log.error(`clock drift: setting the sensor's clock failed: ${message}`);
      toast(`Setting the sensor's clock failed: ${message}`, "err");
      return false;
    }
    resetSeries(
      "clock drift: the sensor's clock was set from this host — the fit was rebaselined and the clock base will be re-detected",
    );
    onClockWritten();
    return true;
  }

  /**
   * Drop the samples and re-detect the clock base, without writing anything.
   * The Reset baseline button, and what {@link noteClockWritten} does.
   */
  function resetSeries(message) {
    monitor.rebaseline();
    /* A time write moves the epoch under the series, so the previously
       detected base belongs to the old epoch. Null, not 0: the next sample
       re-runs detection. */
    clockBase = null;
    clockBaseRawSec = null;
    paintBase();
    log.log(message);
    setStatus(
      timer
        ? `Sampling every ${intervalSeconds()} s — the fit restarts from the next sample.`
        : "Baseline reset — the fit restarts from the next sample.",
    );
    render();
  }

  function rebaseline() {
    resetSeries("clock drift: baseline reset — the fit restarts from scratch");
  }

  /**
   * The mounting page wrote the sensor's clock with its own control: same
   * bookkeeping as Sync, without the write. Without this the fit would
   * straddle the discontinuity and report a slope that is really one step.
   */
  function noteClockWritten() {
    resetSeries(
      "clock drift: the sensor's clock was written — the fit was rebaselined and the clock base will be re-detected",
    );
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  function saveCsv() {
    if (!monitor.samples.length) {
      toast("No samples to save yet.", "warn");
      return false;
    }
    const ppm = monitor.ppmFit();
    const rows = monitor.toCsvRows({
      device: getDeviceLabel() ?? "unknown",
      link: getMode() ?? "unknown",
      exported: new Date().toISOString(),
      ppm_fit: ppm === null ? "n/a" : ppm.toFixed(2),
      device_steps: monitor.deviceSteps,
      host_steps: monitor.hostSteps,
      clock_base_s: clockBase ?? 0,
      interval_s: intervalSeconds(),
    });
    const prefix = String(getFilePrefix() ?? "shimmer").replace(
      /[^\w.-]+/g,
      "_",
    );
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    /* UTF-8 BOM as an explicit escape, never a literal character, so a
       formatter or an editor cannot silently strip it: without it Excel opens
       the file as ANSI and the preamble's non-ASCII characters render as
       mojibake. */
    downloadBlob(
      `${prefix}_rtc-drift_${stamp}.csv`,
      new Blob(["\ufeff", rows.join("\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    log.log(`clock drift: saved ${monitor.samples.length} samples as CSV`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function setStatus(text) {
    statusLine.textContent = text;
  }

  function paintWake() {
    wakePill.textContent = wakeLock ? "wake lock on" : "wake lock off";
    wakePill.classList.toggle("on", !!wakeLock);
  }

  function paintBase() {
    if (clockBase === null) {
      baseLine.textContent =
        "Clock base: not yet detected — it is read from the first sample of a run.";
      return;
    }
    if (clockBase !== 0) {
      baseLine.textContent = `Clock base: ${fmtClockBase(clockBase)} (local civil time, or another time-set convention) — offsets are shown relative to it.`;
      return;
    }
    if (
      clockBaseRawSec !== null &&
      Math.abs(clockBaseRawSec) > CLOCK_BASE_SLACK_S
    ) {
      baseLine.textContent = `Clock base: none — the sensor's clock is ${signed(clockBaseRawSec, 0)} s off this host's, too far off the quarter-hour grid to be a timezone. Sync it before a long run; the drift fit itself is unaffected.`;
      return;
    }
    /* "None" means no whole-quarter-hour base was detected — NOT that the two
       clocks agree. Anything inside the slack window lands here, so the sensor
       can still be a minute or so out, and the offset readout is the thing
       that says by how much. Claiming they are in step would contradict the
       stat beside it. */
    baseLine.textContent =
      "Clock base: none — no timezone-shaped offset, so the sensor's clock is compared with this host's directly. See the offset for how far apart they are.";
  }

  function paintControls() {
    const readable = enabled && !destroyed && supports();
    intervalInput.disabled = !!timer;
    btnStart.disabled = !readable || !!timer;
    /* Stop and Save CSV are never gated by the page's floor: whatever made it
       withdraw the link, stopping a run and keeping the data collected so far
       must stay possible. */
    btnStop.disabled = !timer;
    btnSample.disabled = !readable;
    btnSync.disabled = !enabled || destroyed || !supportsWrite();
    btnRebaseline.disabled = monitor.samples.length === 0;
    btnCsv.disabled = monitor.samples.length === 0;
  }

  function render() {
    const samples = monitor.samples;
    setStat("samples", String(samples.length));
    setStat(
      "elapsed",
      samples.length ? fmtDuration(monitor.elapsedMinutes() * 60000) : "–",
    );
    setStat("deviceSteps", String(monitor.deviceSteps));
    setStat("hostSteps", String(monitor.hostSteps));

    if (samples.length) {
      const last = samples[samples.length - 1];
      setStat("offset", `${signed(last.offsetSec, 3)} s`);
      setStat("rtt", `${Math.round(last.rttMs)} ms`);
    } else {
      setStat("offset", "–");
      setStat("rtt", "–");
    }

    const ppm = monitor.ppmFit();
    const ppmNode = statNode("ppm");
    /* Under a couple of minutes the slope is mostly round-trip noise, so the
       number is withheld rather than shown and disbelieved. */
    if (ppm === null || monitor.elapsedMinutes() < MIN_FIT_MINUTES) {
      setStat("ppm", samples.length >= 2 ? "collecting…" : "–");
      setStat("perDay", "–");
      ppmNode?.classList.remove("bad");
    } else {
      setStat("ppm", `${signed(ppm, 1)} ppm`);
      setStat("perDay", `${signed((ppm * 86400) / 1e6, 2)} s/day`);
      ppmNode?.classList.toggle("bad", Math.abs(ppm) > PPM_BAD);
    }

    drawPlot();
    paintControls();
  }

  /**
   * Offset drift since the first sample, with the least-squares fit.
   *
   * Colours are read from CSS custom properties AT DRAW TIME rather than
   * baked in: the page this now lives on has a light theme as well as a dark
   * one, and the standalone page's hard-coded hex was invisible on white.
   */
  function drawPlot() {
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;

    const cssWidth = Math.round(plotBox.clientWidth);
    /* Zero while the panel sits in a display:none tab, which is where it is
       mounted. The ResizeObserver below brings the first real width. */
    if (cssWidth <= 0) return;
    const dpr = Math.min(MAX_PLOT_DPR, window.devicePixelRatio || 1);
    const backingWidth = Math.round(cssWidth * dpr);
    const backingHeight = Math.round(PLOT_HEIGHT_PX * dpr);
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    lastPlotWidth = cssWidth;

    /* Draw in CSS pixels and let the transform handle the backing store, so
       the line widths and the 11 px labels are the same size on every
       display and merely sharper on a dense one. */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cssWidth;
    const H = PLOT_HEIGHT_PX;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = cssVar(canvas, "--surface-2", "#fafbfc");
    ctx.fillRect(0, 0, W, H);

    const samples = monitor.samples;
    if (samples.length < 2) return;

    const t0 = samples[0].hostSec;
    const y0 = samples[0].offsetSec;
    const xs = samples.map((p) => p.hostSec - t0);
    const ys = samples.map((p) => p.offsetSec - y0);
    const xMax = Math.max(xs[xs.length - 1], 1);
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    /* A series that has not moved yet would divide by zero; give it a 10 ms
       window so the dots sit on a line rather than on top of each other. */
    if (yMax - yMin < 0.01) {
      yMax += 0.005;
      yMin -= 0.005;
    }
    const X = (x) => PLOT_PAD_PX + (x / xMax) * (W - 2 * PLOT_PAD_PX);
    const Y = (y) =>
      H - PLOT_PAD_PX - ((y - yMin) / (yMax - yMin)) * (H - 2 * PLOT_PAD_PX);

    // Zero line and axis labels.
    ctx.strokeStyle = cssVar(canvas, "--line-strong", "#d3dce0");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PLOT_PAD_PX, Y(0));
    ctx.lineTo(W - PLOT_PAD_PX, Y(0));
    ctx.stroke();
    ctx.fillStyle = cssVar(canvas, "--muted", "#64747e");
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`${(yMax * 1000).toFixed(0)} ms`, 4, Y(yMax) + 4);
    ctx.fillText(`${(yMin * 1000).toFixed(0)} ms`, 4, Y(yMin) + 4);
    const spanLabel = fmtDuration(xMax * 1000);
    ctx.fillText(
      spanLabel,
      Math.max(PLOT_PAD_PX, W - PLOT_PAD_PX - ctx.measureText(spanLabel).width),
      H - 8,
    );

    // Fit line.
    const ppm = monitor.ppmFit();
    if (ppm !== null) {
      ctx.strokeStyle = cssVar(canvas, "--accent", "#fe5000");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      ctx.lineTo(X(xMax), Y((ppm / 1e6) * xMax));
      ctx.stroke();
    }

    // Samples.
    ctx.fillStyle = cssVar(canvas, "--accent-2", "#17506e");
    for (let i = 0; i < xs.length; i++) {
      ctx.beginPath();
      ctx.arc(X(xs[i]), Y(ys[i]), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* Width only. This callback resizes the canvas, and the canvas drives the
     wrapper's height, so redrawing on a height change would observe its own
     write and loop. */
  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver((entries) => {
      const width = Math.round(
        entries[0]?.contentRect?.width ?? plotBox.clientWidth,
      );
      if (width <= 0 || width === lastPlotWidth) return;
      drawPlot();
    });
    resizeObserver.observe(plotBox);
  }

  const detachTheme = onThemeChange(() => drawPlot());

  // -------------------------------------------------------------------------
  // Initial paint
  // -------------------------------------------------------------------------

  paintBase();
  paintWake();
  render();

  return {
    start,
    stop,
    sample,
    sync,
    rebaseline,
    noteClockWritten,
    running: () => !!timer,
    sampling: () => sampleInFlight,
    monitor: () => monitor,
    clockBaseSec: () => clockBase,
    supports,
    setEnabled(next) {
      enabled = !!next;
      noteClientChange();
      /* Deliberately does NOT stop a running monitor. A page withdraws the
         link for all sorts of transient reasons — a self-test, an SD
         download — and each tick then skips with that page's own reason and
         the series simply has a gap. Throwing away an hour of samples
         because the user started a download would be the worse answer. */
      paintControls();
    },
    destroy() {
      destroyed = true;
      stop();
      resizeObserver?.disconnect();
      detachTheme();
      host.replaceChildren();
    },
  };
}

/**
 * The same surface, doing nothing, for a bundle with no drift monitor.
 *
 * Returned rather than throwing so a page can mount the panel unconditionally
 * and get a banner where the monitor would have been, instead of losing every
 * tab that happens to be built after this one.
 */
function inertDriftPanel() {
  return {
    start: () => false,
    stop: () => false,
    sample: async () => false,
    sync: async () => false,
    rebaseline() {},
    noteClockWritten() {},
    running: () => false,
    sampling: () => false,
    monitor: () => null,
    clockBaseSec: () => null,
    supports: () => false,
    setEnabled() {},
    destroy() {},
  };
}
