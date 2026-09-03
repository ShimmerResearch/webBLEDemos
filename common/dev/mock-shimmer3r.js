/**
 * A scripted Shimmer3R "firmware" for developing the pages in this repo
 * without hardware on the desk.
 *
 * Built on the SDK's `LoopbackTransport`, which preserves notification chunk
 * boundaries, so the same client code and the same re-framing paths run
 * against it as against a real link. Follows the scripting pattern the SDK's
 * own tests use (`tests/shimmer3r/unframed-transport.test.ts`,
 * `tests/infomem/client.test.ts`): set an `onWrite` handler, inspect the
 * outgoing command, answer with `notify()`.
 *
 *     import { createMockShimmer3RTransport, mockEnabledFromUrl } from "../common/dev/mock-shimmer3r.js";
 *
 *     const transport = mockEnabledFromUrl() ? createMockShimmer3RTransport() : undefined;
 *     const client = new Shimmer3RClient({ transport });   // undefined → real link
 *
 * This is a development aid, not a firmware simulator. It answers the
 * commands these pages send, with plausible values and correct framing; it
 * does not model timing, power, the SD card or error paths. What it IS good
 * for: exercising the config form, the plot, the CSV recorder and the stats
 * strip, and — with `framed: false` — the SDK's byte-stream re-framing.
 */

import { LoopbackTransport } from "../../shimmer-extension/vendor/shimmer-web-sdk.esm.js";

// ---------------------------------------------------------------------------
// Protocol constants (LiteProtocol). Repeated here rather than imported so
// this file reads as the firmware side of the wire.
// ---------------------------------------------------------------------------

const ACK = 0xff;
const NACK = 0xfe;

const CMD = Object.freeze({
  DATA_PACKET: 0x00,
  INQUIRY: 0x01,
  INQUIRY_RESPONSE: 0x02,
  SET_SAMPLING_RATE: 0x05,
  TOGGLE_LED: 0x06,
  START_STREAMING: 0x07,
  SET_SENSORS: 0x08,
  SET_WR_ACCEL_RANGE: 0x09,
  SET_CONFIG_SETUP_BYTES: 0x0e,
  STOP_STREAMING: 0x20,
  SET_GSR_RANGE: 0x21,
  DEVICE_VERSION_RESPONSE: 0x25,
  GET_FW_VERSION: 0x2e,
  FW_VERSION_RESPONSE: 0x2f,
  GET_DEVICE_VERSION: 0x3f,
  SET_GYRO_RANGE: 0x49,
  SET_ALT_ACCEL_RANGE: 0x4f,
  SET_INTERNAL_EXP_POWER_ENABLE: 0x5e,
  SET_EXG_REGS: 0x61,
  EXG_REGS_RESPONSE: 0x62,
  GET_EXG_REGS: 0x63,
  START_SDBT: 0x70,
  STATUS_RESPONSE: 0x71,
  GET_STATUS: 0x72,
  INSTREAM_CMD_RESPONSE: 0x8a,
  SET_INFOMEM: 0x8c,
  INFOMEM_RESPONSE: 0x8d,
  GET_INFOMEM: 0x8e,
  SET_RWC: 0x8f,
  RWC_RESPONSE: 0x90,
  GET_RWC: 0x91,
  VBATT_RESPONSE: 0x94,
  GET_VBATT: 0x95,
  STOP_SDBT: 0x97,
});

/** SET_* commands that are accepted, remembered and otherwise inert. */
const REMEMBERED_SETS = Object.freeze({
  [CMD.SET_WR_ACCEL_RANGE]: "wrAccelRange",
  [CMD.SET_GYRO_RANGE]: "gyroRange",
  [CMD.SET_ALT_ACCEL_RANGE]: "altAccelRange",
  [CMD.SET_GSR_RANGE]: "gsrRange",
  [CMD.SET_INTERNAL_EXP_POWER_ENABLE]: "expPowerEnabled",
});

/**
 * Sensor enable bit → the channel IDs it puts in the stream, in the order the
 * firmware reports them. This is `channelIdToSensorBit()` from the SDK read
 * backwards; the IDs themselves come from `CHANNEL_FORMATS`.
 */
const SENSOR_CHANNELS = Object.freeze([
  { bit: 0x000080, label: "LN accel", ids: [0x00, 0x01, 0x02] },
  { bit: 0x001000, label: "WR accel", ids: [0x04, 0x05, 0x06] },
  { bit: 0x000020, label: "mag", ids: [0x07, 0x08, 0x09] },
  { bit: 0x000040, label: "gyro", ids: [0x0a, 0x0b, 0x0c] },
  { bit: 0x000100, label: "PPG", ids: [0x12] },
  { bit: 0x400000, label: "HG accel", ids: [0x14, 0x15, 0x16] },
  { bit: 0x000004, label: "GSR", ids: [0x1c] },
  // The ExG status byte (0x1d / 0x20) rides with either width, hence the
  // duplicates — they are deduplicated when the channel list is built.
  { bit: 0x000010, label: "ExG1 24-bit", ids: [0x1d, 0x1e, 0x1f] },
  { bit: 0x000008, label: "ExG2 24-bit", ids: [0x20, 0x21, 0x22] },
  { bit: 0x100000, label: "ExG1 16-bit", ids: [0x1d, 0x23, 0x24] },
  { bit: 0x080000, label: "ExG2 16-bit", ids: [0x20, 0x25, 0x26] },
]);

/**
 * Channel width and byte order, per channel ID. The same table the SDK's
 * parser uses (`CHANNEL_FORMATS`), so a frame this mock encodes cannot
 * disagree with the frame the client decodes.
 */
const CHANNEL_WIDTH = Object.freeze({
  0x00: { bytes: 2, be: false },
  0x01: { bytes: 2, be: false },
  0x02: { bytes: 2, be: false },
  0x04: { bytes: 2, be: false },
  0x05: { bytes: 2, be: false },
  0x06: { bytes: 2, be: false },
  0x07: { bytes: 2, be: false },
  0x08: { bytes: 2, be: false },
  0x09: { bytes: 2, be: false },
  0x0a: { bytes: 2, be: false },
  0x0b: { bytes: 2, be: false },
  0x0c: { bytes: 2, be: false },
  0x12: { bytes: 2, be: false },
  0x14: { bytes: 2, be: false },
  0x15: { bytes: 2, be: false },
  0x16: { bytes: 2, be: false },
  0x1c: { bytes: 2, be: false, unsigned: true },
  0x1d: { bytes: 1, be: false, unsigned: true },
  0x1e: { bytes: 3, be: true },
  0x1f: { bytes: 3, be: true },
  0x20: { bytes: 1, be: false, unsigned: true },
  0x21: { bytes: 3, be: true },
  0x22: { bytes: 3, be: true },
  0x23: { bytes: 2, be: true },
  0x24: { bytes: 2, be: true },
  0x25: { bytes: 2, be: true },
  0x26: { bytes: 2, be: true },
});

/** Sampling clock: rate = 32768 / divisor. */
const SAMPLING_CLOCK_HZ = 32768;

/** InfoMem field offsets (flat addressing), from `resolveInfoMemLayout`. */
const IM = Object.freeze({
  samplingRate: 0,
  bufferSize: 2,
  sensors0: 3,
  sensors1: 4,
  sensors2: 5,
  configSetupByte0: 6,
  configSetupByte3: 9,
  exg1: 10,
  exg2: 20,
  exgBankLength: 10,
  btCommBaudRate: 30,
  shimmerName: 187,
  expIdName: 199,
  configTime0: 211,
  macAddress: 224,
  nameLength: 12,
});

/**
 * Backing store for GET_INFOMEM / SET_INFOMEM. 512 bytes, deliberately larger
 * than the 384-byte InfoMem image the SDK models (`INFOMEM_SIZE`): the extra
 * space makes an over-long read return zeros rather than undefined, which is
 * what real flash does.
 */
const INFOMEM_STORE_BYTES = 512;

/** How long the mock waits before answering, in ms. */
const REPLY_DELAY_MS = 0;

/** Streaming is delivered in bursts on this cadence, like a real BLE link. */
const STREAM_TICK_MS = 20;

/** Default dribble chunk size on an unframed transport. */
const DEFAULT_DRIBBLE_BYTES = 3;

/**
 * True when the page URL asks for the mock (`?mock=1`).
 *
 * Deliberately opt-in and query-string-only: a demo page that reached for the
 * mock on its own — on a missing API, say — would quietly show fake data to
 * someone debugging real hardware, which is worse than an error.
 *
 * @returns {boolean}
 */
export function mockEnabledFromUrl() {
  try {
    return new URLSearchParams(location.search).get("mock") === "1";
  } catch {
    return false;
  }
}

/**
 * Build a mock Shimmer3R on a LoopbackTransport.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.framed=true] `true` behaves like BLE (each reply is
 *   one notification); `false` behaves like an RFCOMM byte stream, delivering
 *   every reply in small chunks so the SDK's re-framing is exercised
 * @param {number} [opts.rateHz=51.2] initial sampling rate
 * @param {number} [opts.sensors=0x00E0] initial sensor bitmap
 *   (default = LN accel | gyro | mag)
 * @param {number} [opts.dribbleBytes=3] chunk size when `framed` is false
 * @param {string} [opts.deviceName] advertised name
 * @param {string} [opts.mac="000666668091"] MAC, hex, no separators
 * @param {boolean} [opts.debug=false] console.log every command
 * @returns {LoopbackTransport} pass it to `new Shimmer3RClient({ transport })`.
 *   `transport.emitDisconnect()` simulates a dropped link;
 *   `transport.writes` is every command the page sent.
 */
export function createMockShimmer3RTransport(opts = {}) {
  const framed = opts.framed !== false;
  const dribbleBytes = Math.max(1, opts.dribbleBytes ?? DEFAULT_DRIBBLE_BYTES);
  const debug = !!opts.debug;
  const mac = (opts.mac ?? "000666668091").replace(/[^0-9a-fA-F]/g, "");

  const state = {
    rateHz: opts.rateHz ?? 51.2,
    sensors: opts.sensors ?? 0x00e0,
    streaming: false,
    logging: false,
    wrAccelRange: 0,
    gyroRange: 3,
    altAccelRange: 0,
    gsrRange: 4,
    expPowerEnabled: 0,
    configSetupBytes: new Uint8Array(7),
    /** 64-bit RTC ticks, LSB first on the wire. */
    rwcTicks: 0n,
  };

  const infoMem = new Uint8Array(INFOMEM_STORE_BYTES);
  seedInfoMem();

  const transport = new LoopbackTransport({
    capabilities: { framed },
    deviceName:
      opts.deviceName ??
      `Shimmer3R-${mac.slice(-4).toUpperCase()}${framed ? "-BLE" : "-BT"}`,
  });

  let streamTimer = null;
  let streamTicks = 0;
  let streamStartMs = 0;
  let samplesEmitted = 0;

  // -------------------------------------------------------------------------
  // InfoMem
  // -------------------------------------------------------------------------

  function writeName(offset, text) {
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < IM.nameLength; i++) {
      infoMem[offset + i] = i < bytes.length ? bytes[i] : 0x00;
    }
  }

  function seedInfoMem() {
    // Sampling divisor, LSB first. 32768/640 = 51.2 Hz.
    const divisor = Math.max(
      1,
      Math.round(SAMPLING_CLOCK_HZ / (opts.rateHz ?? 51.2)),
    );
    infoMem[IM.samplingRate] = divisor & 0xff;
    infoMem[IM.samplingRate + 1] = (divisor >> 8) & 0xff;
    infoMem[IM.bufferSize] = 1;

    // The sensor bitmap is LSB-first BOTH on the wire (SET_SENSORS payload)
    // and in InfoMem (idxSensors0 holds bits 0-7). Getting these two out of
    // step is the trap here: a config form reading InfoMem would then show a
    // different sensor set than the inquiry reports.
    const sensors = opts.sensors ?? 0x00e0;
    infoMem[IM.sensors0] = sensors & 0xff;
    infoMem[IM.sensors1] = (sensors >> 8) & 0xff;
    infoMem[IM.sensors2] = (sensors >> 16) & 0xff;

    infoMem[IM.btCommBaudRate] = 9; // 1 Mbaud, the Shimmer3R default
    writeName(IM.shimmerName, `Shimmer_${mac.slice(-4).toUpperCase()}`);
    writeName(IM.expIdName, "DefaultTrial");

    // Config time, big-endian over 4 bytes — a plausible "last configured"
    // stamp rather than 0, so a page rendering it shows a real date.
    const configTime = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 4; i++) {
      infoMem[IM.configTime0 + i] = (configTime >>> ((3 - i) * 8)) & 0xff;
    }

    for (let i = 0; i < 6; i++) {
      infoMem[IM.macAddress + i] =
        parseInt(mac.slice(i * 2, i * 2 + 2), 16) || 0;
    }
  }

  /**
   * Map a wire address to a store offset. Older firmware addresses the three
   * InfoMem pages at 0x1800/0x1880/0x1900 while newer firmware and every
   * Shimmer3R uses flat 0/128/256, and a page may send either.
   */
  function pageOffset(addr) {
    return addr >= 0x1800 ? addr - 0x1800 : addr;
  }

  // -------------------------------------------------------------------------
  // Reply plumbing
  // -------------------------------------------------------------------------

  /**
   * Deliver one reply.
   *
   * Framed: a single notification, as a BLE characteristic notify would.
   * Unframed: `dribbleBytes` at a time on successive macrotasks — the
   * worst case a serial port can present, and the one the SDK's control-plane
   * re-framing exists for.
   */
  function reply(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (debug) console.log("[mock] ->", hex(u8));
    if (framed) {
      setTimeout(() => transport.notify(u8), REPLY_DELAY_MS);
      return;
    }
    let tick = REPLY_DELAY_MS;
    for (let off = 0; off < u8.length; off += dribbleBytes) {
      const chunk = u8.slice(off, off + dribbleBytes);
      setTimeout(() => transport.notify(chunk), tick++);
    }
  }

  /** Stream data: one buffer per burst, chunked but never spread over time. */
  function replyStream(u8) {
    if (framed || u8.length <= dribbleBytes) {
      transport.notify(u8);
      return;
    }
    for (let off = 0; off < u8.length; off += dribbleBytes) {
      transport.notify(u8.slice(off, off + dribbleBytes));
    }
  }

  function hex(u8) {
    return Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join(" ");
  }

  // -------------------------------------------------------------------------
  // Stream schema and synthetic data
  // -------------------------------------------------------------------------

  /** Enabled channel IDs, deduplicated, in firmware report order. */
  function channelIds() {
    const ids = [];
    for (const group of SENSOR_CHANNELS) {
      if (!(state.sensors & group.bit)) continue;
      for (const id of group.ids) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * INQUIRY_RESPONSE, Shimmer3R layout:
   *   [0x02][divisor u16 LE][7 config bytes][nCh][bufSize][channel IDs…]
   * The 7-byte config word is what distinguishes this from a Shimmer3's
   * 4-byte one, and is why the two clients cannot share an inquiry parser.
   */
  function inquiryResponse() {
    const ids = channelIds();
    const divisor = Math.max(1, Math.round(SAMPLING_CLOCK_HZ / state.rateHz));
    const out = new Uint8Array(12 + ids.length);
    out[0] = CMD.INQUIRY_RESPONSE;
    out[1] = divisor & 0xff;
    out[2] = (divisor >> 8) & 0xff;
    out.set(state.configSetupBytes.subarray(0, 7), 3);
    out[10] = ids.length;
    out[11] = 1; // buffer size: one sample per packet
    out.set(ids, 12);
    return out;
  }

  /**
   * One synthetic sample for `id` at sample index `n`.
   *
   * Sine waves at a few hertz, one per axis with a phase offset, scaled to a
   * fraction of full range. That is enough to tell a working plot from a
   * broken one at a glance, and to make an axis mix-up obvious.
   */
  function sampleFor(id, n) {
    const width = CHANNEL_WIDTH[id] ?? { bytes: 2, be: false };
    const full = width.unsigned
      ? (1 << (width.bytes * 8)) - 1
      : (1 << (width.bytes * 8 - 1)) - 1;
    const t = n / state.rateHz;
    const phase = ((id * 37) % 360) * (Math.PI / 180);
    const freq = 0.7 + (id % 5) * 0.4;
    const swing = Math.sin(2 * Math.PI * freq * t + phase);
    if (width.unsigned) return Math.round(full * (0.5 + 0.3 * swing));
    return Math.round(full * 0.45 * swing);
  }

  /** `[0x00][ts u24 LE][channel values…]` for one sample. */
  function dataFrame(ids, ticks, n) {
    let size = 1 + 3;
    for (const id of ids) size += CHANNEL_WIDTH[id]?.bytes ?? 2;
    const out = new Uint8Array(size);
    out[0] = CMD.DATA_PACKET;
    out[1] = ticks & 0xff;
    out[2] = (ticks >> 8) & 0xff;
    out[3] = (ticks >> 16) & 0xff;
    let at = 4;
    for (const id of ids) {
      const width = CHANNEL_WIDTH[id] ?? { bytes: 2, be: false };
      let v = sampleFor(id, n);
      if (!width.unsigned && v < 0) v += 1 << (width.bytes * 8);
      for (let i = 0; i < width.bytes; i++) {
        const shift = width.be ? (width.bytes - 1 - i) * 8 : i * 8;
        out[at + i] = (v >>> shift) & 0xff;
      }
      at += width.bytes;
    }
    return out;
  }

  function startStreaming() {
    if (streamTimer) return;
    const ids = channelIds();
    streamTicks = 0;
    samplesEmitted = 0;
    streamStartMs = performance.now();
    const ticksPerSample = SAMPLING_CLOCK_HZ / state.rateHz;
    streamTimer = setInterval(() => {
      // Emit whatever is due since the last tick rather than one frame per
      // timer callback: browsers clamp timers, so a fixed one-frame tick
      // would silently cap the rate at ~250 Hz.
      const elapsed = (performance.now() - streamStartMs) / 1000;
      const due = Math.floor(elapsed * state.rateHz) - samplesEmitted;
      for (let i = 0; i < due; i++) {
        replyStream(
          dataFrame(ids, Math.round(streamTicks) & 0xffffff, samplesEmitted),
        );
        streamTicks = (streamTicks + ticksPerSample) % 0x1000000;
        samplesEmitted++;
      }
    }, STREAM_TICK_MS);
  }

  function stopStreaming() {
    if (!streamTimer) return;
    clearInterval(streamTimer);
    streamTimer = null;
  }

  // Stop the timer when the link goes away, or a "disconnected" mock keeps
  // pushing frames at a client that is no longer listening.
  transport.onDisconnect(() => {
    stopStreaming();
    state.streaming = false;
    state.logging = false;
  });

  // -------------------------------------------------------------------------
  // Command handling
  // -------------------------------------------------------------------------

  transport.setOnWrite((bytes) => {
    const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!cmd.length) return;
    if (debug) console.log("[mock] <-", hex(cmd));
    const op = cmd[0];

    if (op in REMEMBERED_SETS) {
      state[REMEMBERED_SETS[op]] = cmd[1] ?? 0;
      reply([ACK]);
      return;
    }

    switch (op) {
      case CMD.INQUIRY:
        reply(concat([ACK], inquiryResponse()));
        return;

      case CMD.GET_FW_VERSION:
        // fwId u16 LE = 3 (LogAndStream), major u16 LE = 1, minor 1, patch 12
        reply([ACK, CMD.FW_VERSION_RESPONSE, 3, 0, 1, 0, 1, 12]);
        return;

      case CMD.GET_DEVICE_VERSION:
        // 10 = Shimmer3R
        reply([ACK, CMD.DEVICE_VERSION_RESPONSE, 10]);
        return;

      case CMD.GET_STATUS:
        // Status arrives wrapped in an in-stream response, because on real
        // firmware it can be answered mid-stream.
        reply([
          ACK,
          CMD.INSTREAM_CMD_RESPONSE,
          CMD.STATUS_RESPONSE,
          0x00,
          0x00,
        ]);
        return;

      case CMD.GET_VBATT: {
        // ~3.9 V on a Shimmer3R divider, discharging: a value a battery
        // gauge can render without looking like a fault.
        const adc = 2100;
        reply([
          ACK,
          CMD.INSTREAM_CMD_RESPONSE,
          CMD.VBATT_RESPONSE,
          adc & 0xff,
          (adc >> 8) & 0xff,
          0xc0, // charger status byte
        ]);
        return;
      }

      /* The two ADS1292R register banks. They live in the configuration image
         (bytes 10-19 and 20-29), and the live commands are a window onto the
         same ten bytes -- which is the point: a host that writes them live and
         then re-reads the image must see one answer, not two.

         Worth serving even though the page only ever wrote them: as of SDK
         0.1.24 the ExG helpers READ the current banks before writing, so a
         mock that only tolerated the write stopped serving the flow. */
      case CMD.GET_EXG_REGS: {
        // [0x63][chip][startAddr][len] -> ACK + [0x62][len][regs...]
        const chip = cmd[1] ?? 0;
        const start = cmd[2] ?? 0;
        const len = cmd[3] ?? 0;
        const base = chip === 0 ? IM.exg1 : IM.exg2;
        if (chip > 1 || start + len > IM.exgBankLength) {
          reply([NACK]);
          return;
        }
        reply(
          concat(
            [ACK, CMD.EXG_REGS_RESPONSE, len],
            infoMem.slice(base + start, base + start + len),
          ),
        );
        return;
      }

      case CMD.SET_EXG_REGS: {
        // [0x61][chip][startAddr][len][regs...]
        const chip = cmd[1] ?? 0;
        const start = cmd[2] ?? 0;
        const len = cmd[3] ?? 0;
        const base = chip === 0 ? IM.exg1 : IM.exg2;
        if (chip > 1 || start + len > IM.exgBankLength || cmd.length < 4 + len) {
          reply([NACK]);
          return;
        }
        for (let i = 0; i < len; i++) infoMem[base + start + i] = cmd[4 + i];
        reply([ACK]);
        return;
      }

      case CMD.GET_INFOMEM: {
        // Request is [0x8E][len][addrLo][addrHi]; the reply is
        // [0x8D][len][data…], length-prefixed so BLE reassembly can tell
        // when it has the whole thing.
        const len = Math.min(cmd[1] ?? 0, 128);
        const addr = (cmd[2] ?? 0) | ((cmd[3] ?? 0) << 8);
        const off = pageOffset(addr);
        const data = infoMem.slice(off, off + len);
        const out = new Uint8Array(2 + len);
        out[0] = CMD.INFOMEM_RESPONSE;
        out[1] = len;
        out.set(data, 2);
        reply(concat([ACK], out));
        return;
      }

      case CMD.SET_INFOMEM: {
        // [0x8C][len][addrLo][addrHi][data…]
        const len = cmd[1] ?? 0;
        const addr = (cmd[2] ?? 0) | ((cmd[3] ?? 0) << 8);
        const off = pageOffset(addr);
        infoMem.set(cmd.subarray(4, 4 + len), off);
        // Keep the live state in step with what was just written, so an
        // inquiry after a config write reports the new rate and sensors —
        // which is exactly what the firmware does on undock.
        if (off === 0 && len >= 6) {
          const divisor =
            infoMem[IM.samplingRate] | (infoMem[IM.samplingRate + 1] << 8);
          if (divisor > 0) state.rateHz = SAMPLING_CLOCK_HZ / divisor;
          state.sensors =
            infoMem[IM.sensors0] |
            (infoMem[IM.sensors1] << 8) |
            (infoMem[IM.sensors2] << 16);
        }
        reply([ACK]);
        return;
      }

      case CMD.GET_RWC: {
        const out = new Uint8Array(9);
        out[0] = CMD.RWC_RESPONSE;
        let ticks = state.rwcTicks || BigInt(Math.round(Date.now() * 32.768));
        for (let i = 0; i < 8; i++) {
          out[1 + i] = Number(ticks & 0xffn);
          ticks >>= 8n;
        }
        reply(concat([ACK], out));
        return;
      }

      case CMD.SET_RWC: {
        let ticks = 0n;
        for (let i = 8; i >= 1; i--)
          ticks = (ticks << 8n) | BigInt(cmd[i] ?? 0);
        state.rwcTicks = ticks;
        reply([ACK]);
        return;
      }

      case CMD.SET_SAMPLING_RATE: {
        const divisor = (cmd[1] ?? 0) | ((cmd[2] ?? 0) << 8);
        if (divisor > 0) state.rateHz = SAMPLING_CLOCK_HZ / divisor;
        infoMem[IM.samplingRate] = cmd[1] ?? 0;
        infoMem[IM.samplingRate + 1] = cmd[2] ?? 0;
        reply([ACK]);
        return;
      }

      case CMD.SET_SENSORS: {
        // Payload is three bytes of the 24-bit bitmap, LEAST-significant
        // first — the same order InfoMem stores them in, so the bytes go
        // straight through.
        state.sensors =
          (cmd[1] ?? 0) | ((cmd[2] ?? 0) << 8) | ((cmd[3] ?? 0) << 16);
        infoMem[IM.sensors0] = cmd[1] ?? 0;
        infoMem[IM.sensors1] = cmd[2] ?? 0;
        infoMem[IM.sensors2] = cmd[3] ?? 0;
        reply([ACK]);
        return;
      }

      case CMD.SET_CONFIG_SETUP_BYTES:
        state.configSetupBytes.set(cmd.subarray(1, 8));
        reply([ACK]);
        return;

      case CMD.START_STREAMING:
        state.streaming = true;
        reply([ACK]);
        startStreaming();
        return;

      case CMD.START_SDBT:
        state.streaming = true;
        state.logging = true;
        reply([ACK]);
        startStreaming();
        return;

      case CMD.STOP_STREAMING:
        state.streaming = false;
        // Logging outlives a stream stop on real firmware only via
        // STOP_SDBT; here a stop is a stop.
        state.logging = false;
        stopStreaming();
        reply([ACK]);
        return;

      case CMD.STOP_SDBT:
        state.streaming = false;
        state.logging = false;
        stopStreaming();
        reply([ACK]);
        return;

      case CMD.TOGGLE_LED:
        reply([ACK]);
        return;

      default:
        /* NACK rather than silence. A real Shimmer3R answers an unknown
         * opcode, and silence here would surface as a command timeout —
         * sending whoever is debugging the page looking for a link fault
         * instead of a missing mock command. */
        if (debug)
          console.warn(`[mock] unhandled command 0x${op.toString(16)}`);
        reply([NACK]);
        return;
    }
  });

  return transport;
}

function concat(a, b) {
  const first = a instanceof Uint8Array ? a : new Uint8Array(a);
  const second = b instanceof Uint8Array ? b : new Uint8Array(b);
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}
