/**
 * Live stream plotting for the webBLEDemos pages: one Chart.js line panel per
 * sensor group, fed from ring buffers, redrawn on an animation frame at a
 * self-limiting frame rate.
 *
 * Extracted and generalised from:
 *   - video-ppg/index.html — the Chart.js configuration that survives a live
 *     stream (`parsing:false`, `normalized:true`, `animation:false`, linear x,
 *     min-max decimation) at L462-486 and L527-537, and its ~30 fps rAF gate;
 *   - verisense-device-console/console.js — `SHIMMER_TRACE_PALETTE`
 *     (L1383-1394) and `padRange` (L4454).
 *
 * Chart.js is NOT imported. It is read off the global `Chart`, which the page
 * loads first:
 *
 *     <script src="../common/vendor/chart.umd.min.js"></script>
 *
 * The global is read lazily (inside `createStreamPlot`), so this module still
 * imports cleanly on a page that never loads the script.
 *
 *   import { createStreamPlot, groupForField } from "../common/plot.js";
 */

import { onThemeChange } from "./theme.js";

/**
 * Standard Shimmer brand trace colours, ordered so the first few traces stay
 * easy to tell apart (orange / blue / grey lead, since the triaxial panels use
 * indices 0-2). A panel assigns these to its traces in order; any trace beyond
 * the list gets a random (but readable) colour. No sensor group has more than
 * six traces, so the random path is a safety net.
 *
 * Copied verbatim from console.js L1383-1394.
 */
export const SHIMMER_TRACE_PALETTE = Object.freeze([
  "#F15D22", // Shimmer orange  (241, 93, 34)
  "#0081C6", // Shimmer blue    (0, 129, 198)
  "#77787C", // Shimmer grey    (119, 120, 124)
  "#00994C", // green           (0, 153, 76)
  "#660000", // maroon          (102, 0, 0)
  "#6600CC", // purple          (102, 0, 204)
  "#009999", // cyan / aqua     (0, 153, 153)
  "#994C00", // brown           (153, 76, 0)
]);

/** Panel order and titles. `OTHER` collects anything unrecognised. */
export const PLOT_GROUPS = Object.freeze([
  { id: "LN_ACCEL", label: "Low-noise accelerometer" },
  { id: "WR_ACCEL", label: "Wide-range accelerometer" },
  { id: "HG_ACCEL", label: "High-g accelerometer" },
  { id: "GYRO", label: "Gyroscope" },
  { id: "MAG", label: "Magnetometer" },
  { id: "EXG", label: "ExG" },
  { id: "GSR", label: "GSR" },
  { id: "PPG", label: "PPG" },
  { id: "OTHER", label: "Other channels" },
]);

/**
 * Fields that are never a trace. TIMESTAMP is the x axis — `push()` takes the
 * time as its own argument, so plotting it would draw a straight ramp across
 * whichever panel it landed in.
 */
const NOT_A_TRACE = new Set(["TIMESTAMP"]);

/** Hard ceiling on ring length, whatever the rate × window works out to. */
const MAX_RING = 65536;

/** Above this rate the window is capped (see `setWindow`). */
const HIGH_RATE_HZ = 512;
/** …to this many seconds. */
const HIGH_RATE_WINDOW_SEC = 10;

/** Redraw budget. A slower update than this halves the frame rate. */
const SLOW_UPDATE_MS = 25;
/** Floor for the self-limiting frame rate. */
const MIN_FPS = 5;

/** Fallback ring length when the caller does not say what rate to expect. */
const ASSUMED_RATE_HZ = 128;

/**
 * Which panel a signal belongs in.
 *
 * @param {string} name e.g. `"LN_ACCEL_X"`, `"Exg1_CH2_24Bit"`
 * @returns {string} one of the `PLOT_GROUPS` ids
 */
export function groupForField(name) {
  const n = String(name ?? "");
  if (n.startsWith("LN_ACCEL")) return "LN_ACCEL";
  if (n.startsWith("WR_ACCEL")) return "WR_ACCEL";
  if (n.startsWith("HG_ACCEL")) return "HG_ACCEL";
  if (n.startsWith("GYRO")) return "GYRO";
  if (n.startsWith("MAG")) return "MAG";
  // The ExG status byte is a register readback, not a signal, so it is not an
  // ExG trace — it falls through to OTHER with the rest of the odds and ends.
  if ((n.startsWith("Exg1_") || n.startsWith("Exg2_")) && !n.endsWith("_Status"))
    return "EXG";
  if (n.startsWith("GSR")) return "GSR";
  if (n.startsWith("PPG")) return "PPG";
  return "OTHER";
}

/**
 * Widen a min/max pair by `factor` so a trace never rides the frame edge.
 * Source: console.js L4454.
 *
 * @param {number} minY
 * @param {number} maxY
 * @param {number} [factor=0.05]
 * @param {number} [minPad=0.1] used when the range is flat (min === max)
 * @returns {{minY: number, maxY: number}}
 */
export function padRange(minY, maxY, factor = 0.05, minPad = 0.1) {
  const pad = (maxY - minY) * factor || minPad;
  return { minY: minY - pad, maxY: maxY + pad };
}

/** i-th trace colour: brand palette in order, then a random readable hue. */
function traceColor(i, palette) {
  const list = palette ?? SHIMMER_TRACE_PALETTE;
  if (i < list.length) return list[i];
  return `hsl(${Math.floor(Math.random() * 360)}, 70%, 45%)`;
}

/** Read a CSS custom property off an element, with a fallback. */
function cssVar(node, name, fallback) {
  try {
    const v = getComputedStyle(node).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Create a stream plot inside `host`.
 *
 * @param {HTMLElement} host container; a `.plot-panels` grid is appended to it
 * @param {object} [opts]
 * @param {number} [opts.windowSec=10] visible span, in seconds
 * @param {number} [opts.maxFps=30] redraw ceiling; lowered automatically when
 *   a redraw costs more than 25 ms
 * @param {string[]} [opts.palette] trace colours, defaults to
 *   {@link SHIMMER_TRACE_PALETTE}
 * @param {number} [opts.rateHz] expected sample rate, used to size the rings.
 *   `setSchema(fields, rateHz)` overrides it once the real rate is known.
 * @returns {{
 *   setSchema: (fields: unknown[], rateHz?: number) => void,
 *   push: (oc: {fields: {name: string, value: number, kind: string|null}[]}, tSec: number) => void,
 *   setWindow: (sec: number) => number,
 *   setKind: (kind: "raw"|"cal") => void,
 *   pause: () => void,
 *   resume: () => void,
 *   clear: () => void,
 *   destroy: () => void,
 *   panels: Record<string, {id: string, label: string, wrap: HTMLElement, canvas: HTMLCanvasElement, chart: unknown}>,
 * }}
 */
export function createStreamPlot(host, opts = {}) {
  const ChartCtor = globalThis.Chart;
  if (!ChartCtor) {
    throw new Error(
      "Chart.js is not loaded — add <script src=\"../common/vendor/chart.umd.min.js\"></script> before importing common/plot.js",
    );
  }

  const palette = opts.palette ?? SHIMMER_TRACE_PALETTE;
  const maxFpsRequested = opts.maxFps ?? 30;
  let maxFps = maxFpsRequested;
  let windowSec = opts.windowSec ?? 10;
  let rateHz = opts.rateHz ?? ASSUMED_RATE_HZ;
  let preferredKind = "cal";
  let paused = false;
  let destroyed = false;

  const grid = document.createElement("div");
  grid.className = "plot-panels";
  host.appendChild(grid);

  /** @type {Record<string, object>} */
  const panels = {};
  /**
   * One entry per plotted signal name.
   * @type {{name: string, group: string, unit: string, kinds: Set<string|null>,
   *         kind: string|null, buf: Float32Array, pool: {x: number, y: number}[],
   *         dataset: object}[]}
   */
  let series = [];
  /** `name|kind` → series index, rebuilt whenever the schema or kind changes. */
  let routeByKey = new Map();

  // Shared time ring: every series is sampled from the same frame, so one
  // clock ring serves them all.
  let maxPoints = ringLength();
  let times = new Float64Array(maxPoints);
  let write = 0;
  let count = 0;

  let rafId = 0;
  let lastDrawMs = 0;
  let dirty = false;

  function ringLength() {
    return Math.max(
      64,
      Math.min(MAX_RING, Math.ceil((rateHz || ASSUMED_RATE_HZ) * windowSec)),
    );
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  function themeColors() {
    return {
      grid: cssVar(host, "--line", "#e2e8eb"),
      tick: cssVar(host, "--muted", "#64747e"),
      ink: cssVar(host, "--ink", "#17232a"),
    };
  }

  function makePanel(def) {
    const colors = themeColors();
    const wrap = document.createElement("div");
    wrap.className = "plot-panel";
    const canvas = document.createElement("canvas");
    // A canvas needs a role and a name to be anything but noise to a screen
    // reader; the live numbers live in the stats strip, not here.
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", def.label + " plot");
    wrap.appendChild(canvas);
    grid.appendChild(wrap);

    const chart = new ChartCtor(canvas.getContext("2d"), {
      type: "line",
      data: { datasets: [] },
      options: {
        // The fast path: no parsing (points are already {x,y}), no
        // normalisation pass (they are sorted ascending), no animation. All
        // three matter at 512 Hz — with animation on, Chart.js re-tweens the
        // whole window on every frame.
        parsing: false,
        normalized: true,
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        spanGaps: false,
        elements: { point: { radius: 0 }, line: { borderWidth: 1.4, tension: 0 } },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "Time (s)", color: colors.tick },
            grid: { color: colors.grid },
            ticks: { color: colors.tick, maxTicksLimit: 8 },
          },
          y: {
            grid: { color: colors.grid },
            ticks: { color: colors.tick, maxTicksLimit: 6 },
          },
        },
        plugins: {
          // min-max keeps the visible extremes of a decimated window, so a
          // spike survives the reduction instead of being averaged away.
          decimation: {
            enabled: true,
            algorithm: "min-max",
            samples: Math.max(64, canvas.width || 512),
          },
          legend: {
            display: true,
            position: "top",
            labels: { color: colors.ink, boxWidth: 10, boxHeight: 10 },
          },
          tooltip: { enabled: false },
          title: { display: true, text: def.label, color: colors.ink },
        },
      },
    });

    return { id: def.id, label: def.label, wrap, canvas, chart };
  }

  function applyTheme() {
    const colors = themeColors();
    for (const panel of Object.values(panels)) {
      const o = panel.chart.options;
      o.scales.x.grid.color = colors.grid;
      o.scales.x.ticks.color = colors.tick;
      o.scales.x.title.color = colors.tick;
      o.scales.y.grid.color = colors.grid;
      o.scales.y.ticks.color = colors.tick;
      o.plugins.legend.labels.color = colors.ink;
      o.plugins.title.color = colors.ink;
      panel.chart.update("none");
    }
  }

  const detachTheme = onThemeChange(() => {
    if (!destroyed) applyTheme();
  });

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  /**
   * Resolve which kind to plot for a name: the preferred kind when the device
   * offers it, else whatever it does offer. A raw-only channel (an ADC count
   * with no calibration) must still draw, and a page that asked for raw
   * should not lose a cal-only derived channel.
   */
  function resolveKind(kinds) {
    if (kinds.has(preferredKind)) return preferredKind;
    if (kinds.has("cal")) return "cal";
    if (kinds.has("raw")) return "raw";
    return kinds.values().next().value ?? null;
  }

  function rebuildRoutes() {
    routeByKey = new Map();
    series.forEach((s, i) => {
      s.kind = resolveKind(s.kinds);
      routeByKey.set(`${s.name}|${s.kind ?? ""}`, i);
      s.dataset.label = s.kind ? `${s.name} (${s.kind})` : s.name;
    });
    for (const panel of Object.values(panels)) panel.chart.update("none");
  }

  /**
   * Declare the signals to plot. Call once per stream, typically from the
   * first frame: `plot.setSchema(oc.fields, rateHz)`.
   *
   * `fields` may be field objects (`{name, unit, kind}` — an ObjectCluster's
   * `fields` array) or plain names. Duplicated names with different kinds
   * collapse into one trace whose kind `setKind()` selects.
   *
   * @param {unknown[]} fields
   * @param {number} [nextRateHz] expected sample rate, used to size the rings
   */
  function setSchema(fields, nextRateHz) {
    // Charts are rebuilt from scratch, so tear the old traces down first.
    for (const panel of Object.values(panels)) {
      panel.chart.destroy();
      panel.wrap.remove();
      delete panels[panel.id];
    }
    series = [];

    if (Number.isFinite(nextRateHz) && nextRateHz > 0) rateHz = nextRateHz;
    // Re-apply the high-rate cap now that the real rate is known.
    setWindow(windowSec);

    /** @type {Map<string, {unit: string, kinds: Set<string|null>}>} */
    const byName = new Map();
    for (const f of fields ?? []) {
      const name = typeof f === "string" ? f : f?.name;
      if (!name || NOT_A_TRACE.has(name)) continue;
      const kind = typeof f === "string" ? null : (f?.kind ?? null);
      const entry = byName.get(name) ?? { unit: "", kinds: new Set() };
      if (typeof f !== "string" && f?.unit) entry.unit = f.unit;
      entry.kinds.add(kind);
      byName.set(name, entry);
    }

    // Group first, so the panels appear in PLOT_GROUPS order regardless of
    // the order the device reported its channels in.
    /** @type {Map<string, string[]>} */
    const namesByGroup = new Map();
    for (const name of byName.keys()) {
      const g = groupForField(name);
      if (!namesByGroup.has(g)) namesByGroup.set(g, []);
      namesByGroup.get(g).push(name);
    }

    times = new Float64Array(maxPoints);
    write = 0;
    count = 0;

    for (const def of PLOT_GROUPS) {
      const names = namesByGroup.get(def.id);
      if (!names?.length) continue;
      const panel = makePanel(def);
      panels[def.id] = panel;
      names.forEach((name, i) => {
        const entry = byName.get(name);
        const pool = new Array(maxPoints);
        for (let k = 0; k < maxPoints; k++) pool[k] = { x: 0, y: 0 };
        const color = traceColor(i, palette);
        const dataset = {
          label: name,
          data: [],
          borderColor: color,
          backgroundColor: color,
          borderWidth: 1.4,
          pointRadius: 0,
          tension: 0,
        };
        panel.chart.data.datasets.push(dataset);
        series.push({
          name,
          group: def.id,
          unit: entry.unit,
          kinds: entry.kinds,
          kind: null,
          buf: new Float32Array(maxPoints),
          pool,
          dataset,
        });
      });
      const unit = byName.get(names[0])?.unit;
      if (unit) {
        panel.chart.options.scales.y.title = {
          display: true,
          text: unit,
          color: themeColors().tick,
        };
      }
    }

    rebuildRoutes();
  }

  // -------------------------------------------------------------------------
  // Data in
  // -------------------------------------------------------------------------

  /**
   * Append one decoded frame.
   *
   * @param {{fields: {name: string, value: number, kind: string|null}[]}} oc
   * @param {number} tSec frame time in seconds (device clock, unwrapped)
   */
  function push(oc, tSec) {
    if (destroyed || !series.length) return;
    const w = write;
    times[w] = tSec;
    // A channel absent from this frame reads NaN, which breaks the line
    // rather than drawing a straight segment across the gap (spanGaps:false).
    for (const s of series) s.buf[w] = NaN;
    const fields = oc?.fields;
    if (fields) {
      for (const f of fields) {
        const idx = routeByKey.get(`${f.name}|${f.kind ?? ""}`);
        if (idx === undefined) continue;
        series[idx].buf[w] = f.value;
      }
    }
    write = (w + 1) % maxPoints;
    if (count < maxPoints) count++;
    dirty = true;
    if (!paused) schedule();
  }

  // -------------------------------------------------------------------------
  // Redraw
  // -------------------------------------------------------------------------

  function schedule() {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(draw);
  }

  function draw() {
    rafId = 0;
    if (destroyed || paused || !dirty) return;
    const now = performance.now();
    const minGap = 1000 / maxFps;
    if (now - lastDrawMs < minGap) {
      // Too soon: come back next frame rather than dropping the update.
      schedule();
      return;
    }
    lastDrawMs = now;
    dirty = false;

    const tLast = times[(write - 1 + maxPoints) % maxPoints];
    const tMin = tLast - windowSec;

    // One pass per panel: fill each of its series' point arrays from the ring
    // and take the panel's y extent as we go.
    for (const panel of Object.values(panels)) {
      let minY = Infinity;
      let maxY = -Infinity;
      let points = 0;
      for (const s of series) {
        if (s.group !== panel.id) continue;
        const pool = s.pool;
        const data = s.dataset.data;
        let k = 0;
        for (let i = 0; i < count; i++) {
          const idx = (write - count + i + maxPoints) % maxPoints;
          const t = times[idx];
          if (t < tMin) continue;
          const v = s.buf[idx];
          const p = pool[k];
          p.x = t;
          p.y = v;
          if (data[k] !== p) data[k] = p;
          k++;
          if (v < minY) minY = v;
          if (v > maxY) maxY = v;
        }
        if (data.length !== k) data.length = k;
        points = Math.max(points, k);
      }
      const y = panel.chart.options.scales.y;
      if (Number.isFinite(minY) && Number.isFinite(maxY)) {
        const padded = padRange(minY, maxY);
        y.min = padded.minY;
        y.max = padded.maxY;
      } else {
        // Every sample in the window was NaN — let Chart.js pick, rather than
        // pinning the axis to a stale range.
        delete y.min;
        delete y.max;
      }
      const x = panel.chart.options.scales.x;
      if (points > 1) {
        x.min = tMin;
        x.max = tLast;
      }
      // Decimate to roughly one sample per device pixel; the canvas size is
      // only known after layout, and changes when the pane is resized.
      panel.chart.options.plugins.decimation.samples = Math.max(
        64,
        panel.canvas.width || 512,
      );
      panel.chart.update("none");
    }

    /* Self-limiting frame rate: on a slow host (or a very wide window) a
     * redraw can cost more than the frame it is drawn in, at which point the
     * page stops responding to clicks. Halving the target rate trades plot
     * smoothness — which nobody is measuring — for a UI that still works. */
    const cost = performance.now() - now;
    if (cost > SLOW_UPDATE_MS && maxFps > MIN_FPS) {
      maxFps = Math.max(MIN_FPS, Math.floor(maxFps / 2));
    }
    if (dirty) schedule();
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  /**
   * Set the visible span.
   *
   * Capped at 10 s above 512 Hz: a 60 s window at 1024 Hz is 61k points per
   * trace, which no amount of decimation makes affordable to refill 30 times
   * a second, and which nobody can read anyway.
   *
   * @param {number} sec
   * @returns {number} the span actually applied
   */
  function setWindow(sec) {
    let next = Number(sec);
    if (!Number.isFinite(next) || next <= 0) return windowSec;
    if (rateHz > HIGH_RATE_HZ) next = Math.min(next, HIGH_RATE_WINDOW_SEC);
    if (next === windowSec && maxPoints === ringLength()) return windowSec;
    windowSec = next;
    resizeRings(ringLength());
    return windowSec;
  }

  /** Re-allocate the rings, keeping the newest `min(count, next)` samples. */
  function resizeRings(next) {
    if (next === maxPoints) return;
    const keep = Math.min(count, next);
    const newTimes = new Float64Array(next);
    for (let i = 0; i < keep; i++) {
      newTimes[i] = times[(write - keep + i + maxPoints) % maxPoints];
    }
    for (const s of series) {
      const buf = new Float32Array(next);
      for (let i = 0; i < keep; i++) {
        buf[i] = s.buf[(write - keep + i + maxPoints) % maxPoints];
      }
      s.buf = buf;
      const pool = new Array(next);
      for (let k = 0; k < next; k++) pool[k] = s.pool[k] ?? { x: 0, y: 0 };
      s.pool = pool;
      s.dataset.data.length = 0;
    }
    times = newTimes;
    maxPoints = next;
    count = keep;
    write = keep % next;
    dirty = true;
  }

  /**
   * Choose raw or calibrated traces. Falls back per name to whatever the
   * device actually offers.
   *
   * @param {"raw"|"cal"} kind
   */
  function setKind(kind) {
    const next = kind === "raw" ? "raw" : "cal";
    if (next === preferredKind) return;
    preferredKind = next;
    // The buffered history is in the old units, so it cannot be re-labelled —
    // start the window again rather than splicing two scales into one trace.
    clear();
    rebuildRoutes();
  }

  /** Stop redrawing. Frames still buffer, so resume() shows the interval. */
  function pause() {
    paused = true;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  /** Resume redrawing, and restore the requested frame rate. */
  function resume() {
    paused = false;
    maxFps = maxFpsRequested;
    if (dirty) schedule();
  }

  /** Drop all buffered samples and empty the panels. */
  function clear() {
    write = 0;
    count = 0;
    times.fill(0);
    for (const s of series) {
      s.buf.fill(NaN);
      s.dataset.data.length = 0;
    }
    for (const panel of Object.values(panels)) {
      delete panel.chart.options.scales.y.min;
      delete panel.chart.options.scales.y.max;
      panel.chart.update("none");
    }
    dirty = false;
  }

  /** Tear down the charts, the DOM and the theme subscription. */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    detachTheme();
    for (const panel of Object.values(panels)) {
      panel.chart.destroy();
      delete panels[panel.id];
    }
    series = [];
    routeByKey = new Map();
    grid.remove();
  }

  return {
    setSchema,
    push,
    setWindow,
    setKind,
    pause,
    resume,
    clear,
    destroy,
    panels,
  };
}
