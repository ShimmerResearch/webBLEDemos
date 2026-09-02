/**
 * CSV recording for the webBLEDemos pages: turn a live ObjectCluster stream
 * into a file on the host.
 *
 * Generalised from ShimmerCapture/index.html, which built a header row from
 * the chart's datasets (L248-261), pushed one joined row per frame (L389) and
 * dumped the whole thing through a Blob at the end (L366). Two changes to
 * that: cells go through the SDK's `csvCell` so a unit or a device name
 * containing a comma cannot shift every following column, and rows stream to
 * disk through the File System Access API instead of being held in memory
 * until the user stops — a 512 Hz session with 12 channels is tens of
 * megabytes of string, and the in-memory version loses all of it if the tab
 * is closed.
 *
 *   import { createCsvRecorder } from "../common/csv-recorder.js";
 *
 * No DOM access at import time.
 */

import { csvCell } from "../shimmer-extension/vendor/shimmer-web-sdk.esm.js";
import { downloadBlob } from "./ui-chrome.js";

/** How often buffered rows are handed to the writable stream. */
const FLUSH_INTERVAL_MS = 1000;

const encoder = new TextEncoder();

/** `shimmer-capture-2026-09-02_141530.csv` */
function defaultFileName() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return (
    `shimmer-capture-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.csv`
  );
}

/**
 * Create a CSV recorder.
 *
 * @param {object} [opts]
 * @param {() => string} [opts.fileNameFn] names the file; called once per
 *   `start()`, so a name can carry the device id or a trial name
 * @param {boolean} [opts.preferFileSystemAccess=true] stream to a file the
 *   user picks. Set false, or run in a browser without
 *   `showSaveFilePicker`, to buffer in memory and download on `stop()`
 * @param {boolean} [opts.unitsRow=true] emit a second header row of units
 * @param {boolean} [opts.hostTimeColumn=true] emit a leading `HostTime_ms`
 * @param {{warn?: Function, log?: Function}|Function} [opts.log]
 * @returns {{
 *   start: (columns: {name: string, kind?: string|null, unit?: string|null, header?: string}[]) => Promise<boolean>,
 *   push: (hostMs: number, oc: {fields: {name: string, value: number, kind: string|null}[]}) => boolean,
 *   stop: () => Promise<{rows: number, bytes: number, fileName: string}>,
 *   readonly active: boolean,
 * }}
 */
export function createCsvRecorder(opts = {}) {
  const fileNameFn = opts.fileNameFn ?? defaultFileName;
  const preferFsa = opts.preferFileSystemAccess !== false;
  const unitsRow = opts.unitsRow !== false;
  const hostTimeColumn = opts.hostTimeColumn !== false;

  const logger = typeof opts.log === "function" ? { log: opts.log } : (opts.log ?? {});
  const warn = (m) => (logger.warn ?? logger.log)?.(String(m));

  let active = false;
  let fileName = "";
  /** @type {{name: string, kind: string|null, header: string}[]} */
  let columns = [];
  /** `name|kind` → column index. Built once, so `push` is a single pass. */
  let routeByKey = new Map();
  /** Frame width the file was opened for; a change means the schema moved. */
  let expectedFieldCount = null;
  let widthWarned = false;

  let rows = 0;
  let bytes = 0;
  /** @type {string[]} */
  let pending = [];
  let lastFlushMs = 0;

  /** @type {FileSystemWritableFileStream|null} */
  let writable = null;
  /**
   * Serialises writes. `push()` is synchronous, so a flush is kicked off and
   * chained rather than awaited; `stop()` awaits the tail.
   */
  let writeChain = Promise.resolve();
  /** In-memory fallback (and the buffer for the Blob download). */
  let memory = [];

  function row(cells) {
    return cells.map(csvCell).join(",") + "\r\n";
  }

  /** Queue text; the caller decides when to flush. */
  function emit(text) {
    pending.push(text);
  }

  /**
   * Hand everything buffered to the sink. Returns a promise, but callers on
   * the hot path deliberately do not await it.
   */
  function flush() {
    if (!pending.length) return writeChain;
    const chunk = pending.join("");
    pending = [];
    const encoded = encoder.encode(chunk);
    bytes += encoded.byteLength;
    if (writable) {
      writeChain = writeChain
        .then(() => writable.write(encoded))
        .catch((e) => {
          // A failed write means the file is now short. Say so loudly and
          // stop pretending to record.
          warn(`CSV write failed: ${e?.message ?? e}`);
          writable = null;
        });
    } else {
      memory.push(chunk);
    }
    lastFlushMs = performance.now();
    return writeChain;
  }

  /**
   * Open a file and write the header.
   *
   * Must be called from a user gesture when `preferFileSystemAccess` is on:
   * `showSaveFilePicker` is gesture-gated, so calling it from a stream
   * callback throws and silently drops the recording to the in-memory path.
   *
   * @param {{name: string, kind?: string|null, unit?: string|null, header?: string}[]} cols
   *   the data columns, in file order. The page derives them from the first
   *   frame; `TIMESTAMP` is written separately and should not appear here.
   * @returns {Promise<boolean>} false if the user cancelled the picker
   */
  async function start(cols) {
    if (active) {
      warn("CSV recorder already running");
      return false;
    }
    columns = (cols ?? [])
      .filter((c) => c?.name && c.name !== "TIMESTAMP")
      .map((c) => ({
        name: c.name,
        kind: c.kind ?? null,
        unit: c.unit ?? "",
        header: c.header ?? (c.kind ? `${c.name}_${c.kind}` : c.name),
      }));
    if (!columns.length) {
      warn("CSV recorder: nothing to record (no columns)");
      return false;
    }
    routeByKey = new Map(
      columns.map((c, i) => [`${c.name}|${c.kind ?? ""}`, i]),
    );

    fileName = fileNameFn();
    rows = 0;
    bytes = 0;
    pending = [];
    memory = [];
    writable = null;
    writeChain = Promise.resolve();
    expectedFieldCount = null;
    widthWarned = false;

    if (preferFsa && typeof globalThis.showSaveFilePicker === "function") {
      try {
        const handle = await globalThis.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
        });
        writable = await handle.createWritable();
        fileName = handle.name ?? fileName;
      } catch (e) {
        // AbortError is the user closing the picker — that is a "no", not a
        // reason to start recording somewhere they did not ask for.
        if (e?.name === "AbortError") return false;
        warn(
          `file picker unavailable (${e?.message ?? e}) — buffering in memory instead`,
        );
        writable = null;
      }
    }

    const head = [];
    if (hostTimeColumn) head.push("HostTime_ms");
    head.push("TIMESTAMP");
    for (const c of columns) head.push(c.header);
    emit(row(head));

    if (unitsRow) {
      const units = [];
      if (hostTimeColumn) units.push("ms");
      units.push("ticks");
      for (const c of columns) units.push(c.unit ?? "");
      emit(row(units));
    }

    active = true;
    lastFlushMs = performance.now();
    flush();
    return true;
  }

  /**
   * Append one frame.
   *
   * @param {number} hostMs host receive time in milliseconds
   * @param {{fields: {name: string, value: number, kind: string|null}[]}} oc
   * @returns {boolean} false when the row was refused
   */
  function push(hostMs, oc) {
    if (!active) return false;
    const fields = oc?.fields;
    if (!fields) return false;

    /* Rectangularity is the whole value of a CSV. If the device's schema
     * changes mid-recording (a reconfigure, or a second stream starting) the
     * frame width moves, and appending those rows under the old header
     * silently misaligns every column. Refuse them and say so once — a
     * thousand identical warnings at 512 Hz would bury the log. */
    if (expectedFieldCount === null) {
      expectedFieldCount = fields.length;
    } else if (fields.length !== expectedFieldCount) {
      if (!widthWarned) {
        widthWarned = true;
        warn(
          `CSV: frame has ${fields.length} fields, file was opened for ${expectedFieldCount} — rows refused until the stream is restarted`,
        );
      }
      return false;
    }

    const cells = new Array(
      columns.length + 1 + (hostTimeColumn ? 1 : 0),
    ).fill("");
    let at = 0;
    if (hostTimeColumn) cells[at++] = Math.round(hostMs);
    const tsAt = at++;
    const base = at;
    for (const f of fields) {
      if (f.name === "TIMESTAMP") {
        cells[tsAt] = f.value;
        continue;
      }
      const idx = routeByKey.get(`${f.name}|${f.kind ?? ""}`);
      if (idx !== undefined) cells[base + idx] = f.value;
    }
    emit(row(cells));
    rows++;

    if (performance.now() - lastFlushMs >= FLUSH_INTERVAL_MS) flush();
    return true;
  }

  /**
   * Close the file (or download the buffer) and report the totals.
   * Idempotent: calling it again returns the same numbers without writing.
   *
   * @returns {Promise<{rows: number, bytes: number, fileName: string}>}
   */
  async function stop() {
    if (!active) return { rows, bytes, fileName };
    active = false;
    await flush();
    if (writable) {
      try {
        await writable.close();
      } catch (e) {
        warn(`closing the CSV failed: ${e?.message ?? e}`);
      }
      writable = null;
    } else if (memory.length) {
      downloadBlob(
        fileName,
        new Blob(memory, { type: "text/csv;charset=utf-8" }),
      );
    }
    memory = [];
    return { rows, bytes, fileName };
  }

  return {
    start,
    push,
    stop,
    get active() {
      return active;
    },
  };
}
