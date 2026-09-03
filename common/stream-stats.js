/**
 * Live stream statistics strip for the webBLEDemos pages: achieved rate,
 * expected rate, packet loss, throughput, frame count and duration.
 *
 * A thin wrapper over the SDK's `StreamStatsTracker`, which already owns the
 * hard parts — loss derived from gaps in the *device* clock rather than host
 * receive time (host Bluetooth buffering bunches packets together and would
 * otherwise invent gaps), and throughput measured over a sliding window of
 * host receive time. This module's job is to turn one Shimmer3/Shimmer3R
 * frame into the one `recordPacket` call the tracker wants, and to render the
 * snapshot.
 *
 *   import { createStreamStats } from "../common/stream-stats.js";
 *
 * No DOM access at import time.
 */

import { StreamStatsTracker } from "../vendor/shimmer-web-sdk.esm.js";
import { el, fmtDuration, fmtHz } from "./ui-chrome.js";

/**
 * Device clock: the Shimmer3/Shimmer3R stream timestamp counts 32.768 kHz
 * ticks, so one tick is 1/32.768 ms.
 */
const TICKS_PER_MS = 32.768;

/** The stream timestamp is 24-bit, so it wraps every 2^24 ticks (512 s). */
const TIMESTAMP_MODULO = 1 << 24;

/**
 * Half the modulo. A backwards step larger than this is a wrap; a smaller one
 * is an out-of-order or duplicated frame, which must NOT add 512 s to the
 * clock — that would read as a colossal gap and drive loss to 100%.
 */
const WRAP_THRESHOLD = TIMESTAMP_MODULO / 2;

/** Redraw cadence. Faster than this is unreadable and costs frame time. */
const RENDER_INTERVAL_MS = 500;

/**
 * The tracker keys sub-streams so a multi-FIFO sensor can be accounted for
 * separately. A Shimmer3 frame is one interleaved packet carrying exactly one
 * sample of everything, so there is a single sub-stream.
 */
const STREAM_KEY = "shimmer3";
const STREAM_LABEL = "Shimmer3";
const SENSOR_ID = 0;

const CELLS = [
  { key: "rate", label: "Rate" },
  { key: "expected", label: "Expected" },
  { key: "loss", label: "Loss" },
  { key: "throughput", label: "Throughput" },
  { key: "frames", label: "Frames" },
  { key: "duration", label: "Duration" },
];

/**
 * Create the stats strip.
 *
 * @param {HTMLElement} container a `.stats` element; its cells are built here
 * @param {object} [opts]
 * @param {number} [opts.windowMillis=2000] sliding window for rate/throughput
 * @returns {{
 *   reset: (rateHz?: number|null, frameBytes?: number) => void,
 *   onFrame: (oc: {fields: {name: string, value: number}[], raw?: Uint8Array|null}, recvMillis?: number) => void,
 *   render: () => void,
 *   snapshot: () => object,
 * }}
 */
export function createStreamStats(container, opts = {}) {
  const tracker = new StreamStatsTracker({
    windowMillis: opts.windowMillis ?? 2000,
  });

  /** Configured rate, for the "Expected" cell and the tracker's loss maths. */
  let expectedHz = null;
  /** Fallback frame size when a frame does not carry its own bytes. */
  let defaultFrameBytes = 0;

  // Device-clock unwrapping state.
  let lastTicks = null;
  let wrapOffsetTicks = 0;

  let frames = 0;
  let lastRenderMs = 0;

  container.classList.add("stats");
  /** @type {Record<string, HTMLElement>} */
  const values = {};
  container.replaceChildren(
    ...CELLS.map((c) => {
      const value = el("div", { class: "stat-value", text: "–" });
      values[c.key] = value;
      return el(
        "div",
        null,
        el("div", { class: "stat-label", text: c.label }),
        value,
      );
    }),
  );

  /**
   * Clear all counters. Call whenever streaming (re)starts.
   *
   * @param {number|null} [rateHz] the configured rate; loss is measured
   *   against it, so without it the loss cell reads "–"
   * @param {number} [frameBytes] the schema's frame size, used when a frame
   *   arrives without its raw bytes attached
   */
  function reset(rateHz = null, frameBytes = 0) {
    tracker.reset();
    expectedHz = Number.isFinite(rateHz) && rateHz > 0 ? rateHz : null;
    defaultFrameBytes = Number.isFinite(frameBytes) ? frameBytes : 0;
    lastTicks = null;
    wrapOffsetTicks = 0;
    frames = 0;
    lastRenderMs = 0;
    render();
  }

  /**
   * Device time for this frame, in milliseconds on a monotonic clock.
   *
   * @param {number|undefined} ticks raw 24-bit TIMESTAMP value
   * @returns {number|null} null when the frame carries no timestamp
   */
  function deviceMillis(ticks) {
    if (!Number.isFinite(ticks)) return null;
    const raw = ticks % TIMESTAMP_MODULO;
    if (lastTicks !== null && raw < lastTicks - WRAP_THRESHOLD) {
      wrapOffsetTicks += TIMESTAMP_MODULO;
    }
    lastTicks = raw;
    return (wrapOffsetTicks + raw) / TICKS_PER_MS;
  }

  /**
   * Account for one decoded frame.
   *
   * @param {{fields: {name: string, value: number}[], raw?: Uint8Array|null}} oc
   * @param {number} [recvMillis] host receive time; defaults to `performance.now()`
   */
  function onFrame(oc, recvMillis) {
    const recv = Number.isFinite(recvMillis) ? recvMillis : performance.now();
    let ticks;
    for (const f of oc?.fields ?? []) {
      if (f.name === "TIMESTAMP") {
        ticks = f.value;
        break;
      }
    }
    const tsMillis = deviceMillis(ticks);
    const byteLength = oc?.raw?.byteLength ?? defaultFrameBytes;

    tracker.recordPacket({
      sensorId: SENSOR_ID,
      byteLength,
      // These pages read a Bluetooth stream with no per-frame CRC, so there
      // is nothing to check — null, not false, which would report every frame
      // as a CRC failure.
      crcOk: null,
      recvMillis: recv,
      contributions: [
        {
          key: STREAM_KEY,
          label: STREAM_LABEL,
          samplingRateHz: expectedHz,
          // One interleaved sample of every enabled channel per frame.
          sampleCount: 1,
          firstSampleMillis: tsMillis,
          lastSampleMillis: tsMillis,
        },
      ],
    });
    frames++;

    if (recv - lastRenderMs >= RENDER_INTERVAL_MS) render();
  }

  /**
   * Read the tracker's current numbers.
   *
   * @returns {object} a `StreamStatsSnapshot`
   */
  function snapshot() {
    return tracker.snapshot(performance.now());
  }

  /**
   * Paint the strip now. `onFrame` calls this at most every 500 ms; a page
   * should call it once more after stopping, so the final numbers are shown
   * rather than whatever the last throttled frame left behind.
   */
  function render() {
    lastRenderMs = performance.now();
    const snap = snapshot();
    const stream = snap.perSensor?.[SENSOR_ID]?.streams?.[0];

    values.rate.textContent = fmtHz(stream?.windowSampleRateHz ?? null);
    values.expected.textContent = fmtHz(expectedHz);

    // No expected rate means loss is unknowable, not zero — the tracker
    // reports 0 in that case, which would be a lie on screen.
    const lossKnown = expectedHz !== null && snap.totalPackets > 1;
    values.loss.textContent = lossKnown ? `${snap.lossPct.toFixed(1)} %` : "–";
    values.loss.classList.toggle("bad", lossKnown && snap.lossPct >= 5);
    values.loss.classList.toggle(
      "warn",
      lossKnown && snap.lossPct >= 1 && snap.lossPct < 5,
    );

    values.throughput.textContent = snap.throughputBps
      ? `${(snap.throughputBps / 1024).toFixed(1)} kB/s`
      : "–";
    values.frames.textContent = frames.toLocaleString();
    values.duration.textContent = frames
      ? fmtDuration(snap.durationMillis)
      : "–";
  }

  return { reset, onFrame, render, snapshot };
}
