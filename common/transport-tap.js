/**
 * A raw-byte tap for a `ShimmerTransport`: a decorator that logs the bytes
 * crossing the link in each direction and delegates everything else to the
 * transport it wraps.
 *
 * Why a transport decorator and not a client hook. The Verisense demo taps the
 * bytes by reassigning `dev.writeBytes` and `dev._feedStreamBytes`
 * (`Verisense/index.html`, `installRawByteHooks`). Both are client internals —
 * one of them literally spelled with a leading underscore — so the hook is one
 * SDK refactor away from silently logging nothing. `ShimmerTransport` is the
 * published interface (`kind`, `capabilities`, `deviceName`, `connect`,
 * `disconnect`, `write`, `onNotify`, `onDisconnect`), every client accepts one
 * through `connect(transport)` or its constructor, and `write`/`onNotify` are
 * by definition the only two places bytes cross it.
 *
 * Why a Proxy rather than a hand-written forwarding object. Concrete
 * transports carry more than the interface, and the SDK reads it: the clients
 * do `if (t instanceof WebBluetoothTransport) this.device = t.device`, and
 * `common/connect-ui.js`'s `logPortIdentity` reads `transport.port` off a
 * `WebSerialTransport`. A Proxy forwards the prototype (so `instanceof` stays
 * true), every getter (so `capabilities.maxWriteBytes`, which is only
 * populated once connected, stays live rather than being snapshotted at wrap
 * time) and anything a later SDK adds. The two tapped methods are the only
 * ones this file overrides.
 *
 * Two things matter more than the plumbing:
 *
 *  - It is OFF until asked. Raw bytes are a diagnostic; a page that produced
 *    them always would spend its whole line budget on them.
 *  - Data packets are excluded by default. A Shimmer3R at 1024 Hz emits a
 *    packet per millisecond, which is 1000 log lines a second, and the log's
 *    own rAF batching does not save a page from formatting them. So a chunk
 *    that starts with the DATA preamble is counted rather than printed unless
 *    the caller opts in, and everything else is capped per second with a
 *    single summary line when the cap bites.
 *
 * Nothing here touches `document`.
 *
 *   import { createTransportTap } from "../common/transport-tap.js";
 */

/**
 * First byte of a Shimmer3/Shimmer3R streaming frame (`OPCODES.DATA_PACKET`).
 * Hard-coded rather than read off the SDK namespace so the tap keeps working
 * against a bundle that renames the opcode table; the value is fixed by the
 * wire protocol, not by the SDK.
 */
export const DATA_PACKET_OPCODE = 0x00;

/** Bytes printed per line before the rest is summarised. */
export const MAX_BYTES_PER_LINE_DEFAULT = 32;

/** Lines a second the tap will print before it starts coalescing. */
export const MAX_LINES_PER_SECOND_DEFAULT = 100;

/** Coalescing window. */
const WINDOW_MS = 1000;

/**
 * Lowercase hex, space separated, truncated to `max` bytes.
 *
 * Lowercase because the whole point is to be scanned quickly for a known
 * opcode, and lowercase hex has more distinct letter shapes than uppercase.
 * The direction word stays upper case: `classifyLogLine` matches `\bTX\b` and
 * `\bRX\b`, which is what routes these lines to the log's TX/RX filter.
 *
 * @param {Uint8Array} bytes
 * @param {number} max
 * @returns {string}
 */
export function formatHexLine(bytes, max) {
  const n = Math.min(bytes.length, max);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += (i ? " " : "") + bytes[i].toString(16).padStart(2, "0");
  }
  if (bytes.length > n) out += ` … +${bytes.length - n} of ${bytes.length}`;
  return out;
}

/**
 * Wrap `transport` in a raw-byte tap.
 *
 * @param {object} transport any `ShimmerTransport`
 * @param {object} [opts]
 * @param {{log: Function, warn?: Function, error?: Function}|Function} [opts.log]
 *   a `createLog()` handle, or a bare `log(line)` function. Lines are emitted
 *   at info level and classified as tx/rx by their text, exactly as every
 *   other line on the page is.
 * @param {boolean} [opts.enabled=false] produce lines from the start
 * @param {boolean} [opts.includeDataPackets=false] print streaming frames too
 * @param {number} [opts.maxBytesPerLine=32]
 * @param {number} [opts.maxLinesPerSecond=100]
 * @param {number} [opts.dataPacketOpcode=0x00] first byte that marks a
 *   streaming frame
 * @returns {object} the wrapped transport. Everything delegates; the extra
 *   `tap` property is the control surface:
 *   `{setEnabled, setIncludeDataPackets, enabled, includeDataPackets, flush,
 *     stats}`.
 */
export function createTransportTap(transport, opts = {}) {
  const logger =
    typeof opts.log === "function" ? { log: opts.log } : (opts.log ?? {});
  const emit = (line) => logger.log?.(line);

  const maxBytes = opts.maxBytesPerLine ?? MAX_BYTES_PER_LINE_DEFAULT;
  const maxLines = opts.maxLinesPerSecond ?? MAX_LINES_PER_SECOND_DEFAULT;
  const dataOpcode = opts.dataPacketOpcode ?? DATA_PACKET_OPCODE;

  let enabled = !!opts.enabled;
  let includeDataPackets = !!opts.includeDataPackets;

  /* Coalescing state. One window at a time; the counters are what the summary
     line reports when the window closes. */
  let windowStart = 0;
  let printed = 0;
  /* Per direction, because the budget below is shared but the summary must
     not be: a run of chunked writes exhausts the same allowance a burst of
     notifications does, and reporting either as RX sends the reader looking
     down the wrong half of the link. */
  const cappedInWindow = { TX: 0, RX: 0 };
  let dataInWindow = 0;
  /** Totals since the tap was created, for `stats()`. */
  const totals = { printed: 0, capped: 0, data: 0 };

  /**
   * Close the current window if it has expired, reporting anything the window
   * held back. Driven off the arriving chunks rather than a timer: a link with
   * no traffic has nothing to report, and a timer would keep a page awake for
   * the privilege of saying so.
   */
  function rollWindow(now) {
    if (!windowStart) {
      windowStart = now;
      return;
    }
    if (now - windowStart < WINDOW_MS) return;
    flushWindow();
    windowStart = now;
  }

  function flushWindow() {
    if (dataInWindow) {
      /* Said as an RX line on purpose: it is about received bytes, and the
         reader who set the filter to TX / RX is the one who needs to know
         that a thousand frames a second are being held back. */
      emit(
        `RX — ${dataInWindow} data packet${dataInWindow === 1 ? "" : "s"} not shown ` +
          `(tick “include data packets” to see them)`,
      );
      dataInWindow = 0;
    }
    for (const dir of ["TX", "RX"]) {
      const n = cappedInWindow[dir];
      if (!n) continue;
      emit(
        `${dir} — raw byte logging capped: ${n} more chunk` +
          `${n === 1 ? " in" : "s in"} the last second ` +
          `${n === 1 ? "is" : "are"} not shown`,
      );
      cappedInWindow[dir] = 0;
    }
    printed = 0;
  }

  /**
   * Record one chunk in one direction.
   *
   * Wrapped in its own try/catch by both call sites: a tap that threw would
   * take the byte it was reporting on down with it.
   *
   * @param {"TX"|"RX"} dir
   * @param {Uint8Array|ArrayLike<number>} data
   */
  function record(dir, data) {
    if (!enabled) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const now = Date.now();
    rollWindow(now);

    /* A streaming frame is identified by its first byte, which is what the
       client itself does. On an unframed link (RFCOMM, the dock) a chunk is a
       slice of a byte stream rather than one frame, so this catches the ones
       that happen to start on a frame boundary and the per-second cap below
       catches the rest — the honest limit of tapping a pipe that has no
       message boundaries to tap. */
    if (
      !includeDataPackets &&
      bytes.length > 0 &&
      bytes[0] === dataOpcode &&
      dir === "RX"
    ) {
      dataInWindow++;
      totals.data++;
      return;
    }

    if (printed >= maxLines) {
      cappedInWindow[dir]++;
      totals.capped++;
      return;
    }
    printed++;
    totals.printed++;
    emit(`${dir} ${formatHexLine(bytes, maxBytes)}`);
  }

  // ---------------------------------------------------------------------------
  // The two tapped members
  // ---------------------------------------------------------------------------

  /* Logged BEFORE the write is issued, not after it resolves: a command that
     never completes is exactly the case this exists for, and a line that only
     appears on success would be missing from the log that matters most. */
  function write(data, writeOpts) {
    try {
      record("TX", data);
    } catch {
      /* never let the diagnostic break the link it reports on */
    }
    return transport.write(data, writeOpts);
  }

  function onNotify(cb) {
    return transport.onNotify((data) => {
      try {
        record("RX", data);
      } catch {
        /* as above */
      }
      cb(data);
    });
  }

  // ---------------------------------------------------------------------------
  // Control surface
  // ---------------------------------------------------------------------------

  const control = {
    setEnabled(on) {
      const next = !!on;
      if (next === enabled) return;
      /* Report what the window was holding before going quiet, or the reader
         is left with a count that never lands. */
      if (!next) flushWindow();
      enabled = next;
      windowStart = 0;
      printed = 0;
    },
    setIncludeDataPackets(on) {
      const next = !!on;
      if (next === includeDataPackets) return;
      if (next) flushWindow();
      includeDataPackets = next;
    },
    get enabled() {
      return enabled;
    },
    get includeDataPackets() {
      return includeDataPackets;
    },
    flush: flushWindow,
    stats: () => ({ ...totals }),
  };

  const overrides = { write, onNotify, tap: control };
  /**
   * Methods bound to the real transport, cached so repeated reads hand back
   * the same function. Keyed by the function rather than by the property name,
   * so a transport that swaps a method out is not served a stale wrapper.
   */
  const bound = new WeakMap();

  return new Proxy(transport, {
    get(target, prop) {
      if (Object.hasOwn(overrides, prop)) return overrides[prop];
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      /* Bound to the target, not to the proxy: a transport's own methods read
         and write its private fields, and routing those back through this
         trap would be pointless indirection at best. */
      if (!bound.has(value)) bound.set(value, value.bind(target));
      return bound.get(value);
    },
    has(target, prop) {
      return Object.hasOwn(overrides, prop) || Reflect.has(target, prop);
    },
  });
}
