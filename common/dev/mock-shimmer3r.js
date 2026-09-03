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
 * does not model timing, power or most error paths. What it IS good for:
 * exercising the config form, the plot, the CSV recorder, the stats strip,
 * the SD-card browser — it serves a small synthetic card, see
 * {@link buildSyntheticCard} — and, with `framed: false`, the SDK's
 * byte-stream re-framing.
 */

import {
  BRAND_PLATFORM,
  BRAND_RECORD_HOST_OFFSET,
  BRAND_RECORD_SIZE,
  LoopbackTransport,
  SD_ATTR_DIR,
  SD_STATUS,
  SD_TRANSFER_OPCODES,
  SD_XFER,
  buildBrandRecord,
  parseBrandRecord,
  sdCrc16,
} from "../../shimmer-extension/vendor/shimmer-web-sdk.esm.js";

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
  SET_DAUGHTER_CARD_MEM: 0x67,
  DAUGHTER_CARD_MEM_RESPONSE: 0x68,
  GET_DAUGHTER_CARD_MEM: 0x69,
  START_SDBT: 0x70,
  STATUS_RESPONSE: 0x71,
  GET_STATUS: 0x72,
  SET_DATA_RATE_TEST: 0xa4,
  DATA_RATE_TEST_RESPONSE: 0xa5,
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
  SET_FEATURE: 0xb7,
});

/** Feature ids for SET_FEATURE, mirroring the SDK's `BT_FEATURE`. */
const FEATURE = Object.freeze({
  RN4678_ERROR_LEDS: 1,
  REBOOT_ON_DISCONNECT: 2,
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

/**
 * Backing store for GET/SET_DAUGHTER_CARD_MEM: the expansion-board EEPROM as
 * the HOST sees it. Firmware maps host offset 0 past the first (hardware
 * details) EEPROM page, so host offsets 0..2031 are absolute bytes 16..2047 —
 * which is why this is 2032 and not 2048, and why an offset past the end is
 * refused rather than wrapped.
 */
const EEPROM_HOST_BYTES = 2032;

/** Firmware's ceiling on one daughter-card read or write. */
const EEPROM_MAX_PER_CALL = 128;

/** How long the mock waits before answering, in ms. */
const REPLY_DELAY_MS = 0;

/** Streaming is delivered in bursts on this cadence, like a real BLE link. */
const STREAM_TICK_MS = 20;

/** Default dribble chunk size on an unframed transport. */
const DEFAULT_DRIBBLE_BYTES = 3;

// ---------------------------------------------------------------------------
// The synthetic SD card
// ---------------------------------------------------------------------------

/**
 * Capacity reported by SD_FREE_SPACE, in KB — a nominal 32 GB card after
 * formatting. `RESERVED` is everything on the card that is not under `data/`
 * (the FAT itself, the firmware's own files), so free space is neither the
 * whole card nor exactly capacity-minus-data.
 */
const SD_TOTAL_KB = 31_166_976;
const SD_RESERVED_KB = 12_845;

/**
 * Entries the mock returns per SD_LIST_DIR page.
 *
 * The firmware caps at {@link SD_LIST_MAX_ENTRIES} (16) AND at the response
 * byte budget, so a short page with `hasMore` set is normal behaviour rather
 * than an edge case. Two here, deliberately: it makes every directory listing
 * exercise the client's paging loop instead of leaving it untested.
 */
const SD_ENTRIES_PER_PAGE = 2;

/** FatFs result codes the mock returns. Raw FRESULTs, as the firmware does. */
const FR_NO_FILE = 4;
const FR_NO_PATH = 5;
const FR_DENIED = 7;

/** Cadence of streamed SD blocks and data-rate-test packets. */
const SD_TICK_MS = 20;

/**
 * Default streamed throughput, in KB/s.
 *
 * Faster than a real BLE link (~10 KB/s) so a demo is not a coffee break,
 * but slow enough that a 128 KB read window takes about a second — which is
 * what a rolling-throughput readout and an ETA need in order to have
 * anything to show.
 */
const SD_DEFAULT_KBPS = 120;

/** Default raw link speed reported by the data-rate test, in KB/s. */
const LINK_DEFAULT_KBPS = 180;

/**
 * Build the card contents: one trial folder holding two session folders.
 *
 * Sizes are deliberately not round, and `000` in the first session is large
 * enough to span three 128 KB read windows, so a download exercises the
 * window loop, the resume arithmetic and the progress/ETA maths rather than
 * finishing inside a single window.
 *
 * @param {string} shimmerName e.g. `Shimmer_8091`
 * @returns {{path: string, size: number, seed: number, fdate: number,
 *   ftime: number}[]}
 */
function buildSyntheticCard(shimmerName) {
  const trial = "data/DefaultTrial_5f2c1a90";
  const spec = [
    [`${trial}/${shimmerName}-000/000`, 293_117],
    [`${trial}/${shimmerName}-000/001`, 41_983],
    [`${trial}/${shimmerName}-001/000`, 17_622],
    [`${trial}/${shimmerName}-001/001`, 6_145],
    [`${trial}/${shimmerName}-001/002`, 931],
  ];
  // A fixed base date, so a listing shows the same timestamps every reload.
  const base = new Date(2026, 7, 14, 10, 23, 44);
  return spec.map(([path, size], i) => {
    const when = new Date(base.getTime() + i * 137_000);
    const [fdate, ftime] = fatStamp(when);
    return { path, size, seed: (i * 61 + 7) & 0xff, fdate, ftime };
  });
}

/** Pack a Date into the FAT date/time pair the card stores. */
function fatStamp(d) {
  const fdate =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const ftime =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return [fdate & 0xffff, ftime & 0xffff];
}

/**
 * The byte a synthetic file holds at absolute offset `at`.
 *
 * Position-dependent on purpose: the v1.01.009/.010 firmware bug this
 * transfer path exists to work around shifted every block by three bytes,
 * and a file full of a repeating pattern would have hidden it.
 *
 * @param {number} seed
 * @param {number} at
 * @returns {number}
 */
function syntheticByte(seed, at) {
  return (seed + at * 7 + (at >> 8) * 31 + (at >> 16) * 131) & 0xff;
}

/**
 * The factory brand record for a platform, as firmware seeds it at first
 * boot: the names in BRAND_DEFAULT_* in log-and-stream-common
 * `EEPROM/shimmer_eeprom.h`.
 *
 * Serialised by the SDK's own `buildBrandRecord` rather than by a byte table
 * here, so the mock cannot drift from the parser it is feeding — the magic,
 * the layout version, the length bytes and the CRC all come from one place,
 * and a change to the record layout breaks both sides at once instead of
 * leaving them agreeing with each other and with nothing else.
 *
 * @param {number|null} hardwareVersion
 * @returns {Uint8Array} BRAND_RECORD_SIZE bytes
 */
function buildStockBrandRecord(hardwareVersion) {
  const isShimmer3 = hardwareVersion === 3;
  return buildBrandRecord({
    btClassic: isShimmer3 ? "Shimmer3" : "Shimmer3R",
    ble: isShimmer3 ? "S3BLE" : "Shimmer3R",
    usbProduct: "Shimmer",
    usbManufacturer: "Shimmer Research Ltd.",
    seededPlatform: isShimmer3
      ? BRAND_PLATFORM.SHIMMER3
      : BRAND_PLATFORM.SHIMMER3R,
  });
}

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
 * @param {{major: number, minor: number, patch: number}} [opts.firmware]
 *   version reported by GET_FW_VERSION. Defaults to v1.01.012, which is above
 *   the SD-transfer gate; pass v1.01.010 to exercise a page's refusal path.
 * @param {number|null} [opts.hardwareVersion=10] what GET_DEVICE_VERSION
 *   reports. Pass `null` to NACK it instead, which is how a page's
 *   "hardware not positively identified" path gets exercised — the one a
 *   defaulted hardware version silently defeats.
 * @param {number} [opts.sdKBps=120] throughput of streamed SD file blocks
 * @param {number} [opts.linkKBps=180] throughput reported by the firmware
 *   data-rate test (SET_DATA_RATE_TEST)
 * @param {boolean} [opts.debug=false] console.log every command
 * @returns {LoopbackTransport} pass it to `new Shimmer3RClient({ transport })`.
 *   `transport.emitDisconnect()` simulates a dropped link;
 *   `transport.writes` is every command the page sent; `transport.sdCard`
 *   is the synthetic card, with a `bytes(path)` that returns exactly what a
 *   download of that file should produce; and `transport.eeprom` is the
 *   expansion-board EEPROM, with the brand record and the restart bookkeeping.
 */
export function createMockShimmer3RTransport(opts = {}) {
  const framed = opts.framed !== false;
  const dribbleBytes = Math.max(1, opts.dribbleBytes ?? DEFAULT_DRIBBLE_BYTES);
  const debug = !!opts.debug;
  const mac = (opts.mac ?? "000666668091").replace(/[^0-9a-fA-F]/g, "");
  const fw = { major: 1, minor: 1, patch: 12, ...(opts.firmware ?? {}) };
  const hardwareVersion =
    opts.hardwareVersion === undefined ? 10 : opts.hardwareVersion;
  const sdKBps = Math.max(1, opts.sdKBps ?? SD_DEFAULT_KBPS);
  const linkKBps = Math.max(1, opts.linkKBps ?? LINK_DEFAULT_KBPS);

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
    /** A soft restart has been armed for the next disconnect. */
    rebootArmed: false,
    /** How many times the armed restart has actually fired. */
    reboots: 0,
  };

  const infoMem = new Uint8Array(INFOMEM_STORE_BYTES);
  seedInfoMem();

  /* An erased EEPROM with one record written into it, which is what a
     provisioned board actually holds — everything the firmware has not
     claimed reads 0xFF. Leaving bytes 0..15 erased also keeps
     `parseExpansionBoard` returning null, i.e. "no expansion board", which is
     the truth about a bare Shimmer3R. */
  const eeprom = new Uint8Array(EEPROM_HOST_BYTES).fill(0xff);
  const stockBrand = buildStockBrandRecord(hardwareVersion);
  eeprom.set(stockBrand, BRAND_RECORD_HOST_OFFSET);

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
  // Expansion-board EEPROM and the soft restart
  // -------------------------------------------------------------------------

  /**
   * Fire an armed soft restart, if one is armed.
   *
   * Firmware skips the restart while sensing, so an armed request can never
   * truncate an active SD recording, and clears the request either way — it
   * is strictly one-shot and never carries into a later disconnect.
   *
   * The restart is where an erased brand record becomes the factory one
   * again: firmware validates the record at boot and re-seeds the platform
   * defaults when it does not check out. Modelling that here is what makes a
   * page's "restore factory names" path provable end to end, rather than only
   * up to the erase.
   */
  function applyPendingReboot() {
    if (!state.rebootArmed) return;
    state.rebootArmed = false;
    if (state.streaming) {
      if (debug) console.warn("[mock] restart skipped: still sensing");
      return;
    }
    state.reboots++;
    const record = eeprom.subarray(
      BRAND_RECORD_HOST_OFFSET,
      BRAND_RECORD_HOST_OFFSET + BRAND_RECORD_SIZE,
    );
    /* Judged by the SDK's own parser, for the same anti-drift reason the
       record is built with the SDK's builder: the firmware and this mock then
       agree on what "does not check out" means. */
    if (!parseBrandRecord(record).valid) {
      eeprom.set(stockBrand, BRAND_RECORD_HOST_OFFSET);
      if (debug) console.log("[mock] brand record re-seeded at boot");
    }
  }

  /**
   * The EEPROM, exposed for development and for tests: `brandBytes()` is what
   * a page's write actually left behind, `stockBrandBytes()` is what the
   * factory record should look like, and `reboots` counts the armed restarts
   * that fired.
   */
  transport.eeprom = {
    read: (offset, length) => eeprom.slice(offset, offset + length),
    brandBytes: () =>
      eeprom.slice(
        BRAND_RECORD_HOST_OFFSET,
        BRAND_RECORD_HOST_OFFSET + BRAND_RECORD_SIZE,
      ),
    stockBrandBytes: () => stockBrand.slice(),
    get rebootArmed() {
      return state.rebootArmed;
    },
    get reboots() {
      return state.reboots;
    },
  };

  /* A normal disconnect does NOT fire LoopbackTransport's onDisconnect
     callbacks — only `emitDisconnect` does — so the restart is hooked on both
     paths. `applyPendingReboot` is one-shot, so being reached twice is
     harmless. */
  const transportDisconnect = transport.disconnect.bind(transport);
  transport.disconnect = async () => {
    applyPendingReboot();
    await transportDisconnect();
  };

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

  // -------------------------------------------------------------------------
  // SD card: the file model
  // -------------------------------------------------------------------------

  /* Mutable, because SD_DELETE removes from it. Files are the source of
     truth; the directory list is derived, so an emptied session folder still
     lists (and still needs deleting) exactly as it does on a real card. */
  let sdFiles = buildSyntheticCard(`Shimmer_${mac.slice(-4).toUpperCase()}`);
  let sdDirs = derivedDirs(sdFiles);

  /** Every directory implied by the file paths, parents before children. */
  function derivedDirs(files) {
    const seen = new Set(["data"]);
    for (const f of files) {
      const parts = f.path.split("/");
      for (let n = 1; n < parts.length; n++)
        seen.add(parts.slice(0, n).join("/"));
    }
    return Array.from(seen).sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    );
  }

  const parentOf = (path) => {
    const at = path.lastIndexOf("/");
    return at < 0 ? "" : path.slice(0, at);
  };
  const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);
  const sdFileAt = (path) => sdFiles.find((f) => f.path === path) ?? null;

  /** The bytes a download of `path` should produce, for a test to compare. */
  function sdFileBytes(path) {
    const file = sdFileAt(path);
    if (!file) return null;
    return sdFileSlice(file, 0, file.size);
  }

  function sdFileSlice(file, at, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = syntheticByte(file.seed, at + i);
    return out;
  }

  /**
   * The synthetic card, exposed for development and for tests: `bytes(path)`
   * is the ground truth a downloaded file must match, and `files` shrinks as
   * SD_DELETE removes entries.
   */
  transport.sdCard = {
    get files() {
      return sdFiles.map((f) => ({ path: f.path, size: f.size }));
    },
    get dirs() {
      return [...sdDirs];
    },
    bytes: sdFileBytes,
  };

  // -------------------------------------------------------------------------
  // SD card: response framing
  // -------------------------------------------------------------------------

  /* The frame CRC comes from the SDK's own `sdCrc16` rather than a copy of
     the firmware's ShimSwCrc: the mock and the decoder then cannot drift, and
     a CRC bug shows up as a failing page rather than as two implementations
     that agree with each other and with nothing else. */

  /** `[0x8A][0xC5][sess][seq u16][len u16][payload][crc16]` */
  function sdReplyData(session, seq, payload) {
    const out = new Uint8Array(7 + payload.length + 2);
    out[0] = CMD.INSTREAM_CMD_RESPONSE;
    out[1] = SD_TRANSFER_OPCODES.FILE_DATA_RESPONSE;
    out[2] = session & 0xff;
    out[3] = seq & 0xff;
    out[4] = (seq >> 8) & 0xff;
    out[5] = payload.length & 0xff;
    out[6] = (payload.length >> 8) & 0xff;
    out.set(payload, 7);
    const crc = sdCrc16(out, 7 + payload.length);
    out[7 + payload.length] = crc & 0xff;
    out[8 + payload.length] = (crc >> 8) & 0xff;
    // Bulk data, so delivered like stream data: chunked on an unframed
    // transport but never spread over macrotasks, or a 293 KB file would be
    // a hundred thousand timers.
    replyStream(out);
  }

  /** `[0x8A][0xC6][sess][status][nextOffset u32][crc16]` */
  function sdReplyStatus(session, status, nextOffset) {
    const out = new Uint8Array(10);
    out[0] = CMD.INSTREAM_CMD_RESPONSE;
    out[1] = SD_TRANSFER_OPCODES.FILE_STATUS_RESPONSE;
    out[2] = session & 0xff;
    out[3] = status & 0xff;
    new DataView(out.buffer).setUint32(4, nextOffset >>> 0, true);
    const crc = sdCrc16(out, 8);
    out[8] = crc & 0xff;
    out[9] = (crc >> 8) & 0xff;
    replyStream(out);
  }

  // -------------------------------------------------------------------------
  // SD card: the read window
  // -------------------------------------------------------------------------

  /** Session ids increment per read, as the firmware's do. */
  let sdSession = 0;
  /** The read window in flight, or null. */
  let sdRead = null;

  function sdFinishRead(status, nextOffset) {
    if (!sdRead) return;
    clearInterval(sdRead.timer);
    const session = sdRead.session;
    sdRead = null;
    sdReplyStatus(session, status, nextOffset);
  }

  /**
   * Serve one SD_FILE_READ window.
   *
   * Paced at `sdKBps` rather than emitted in one go: a download that
   * completes in a single macrotask never exercises a progress readout, an
   * ETA or an abort, which are most of what there is to get wrong here.
   */
  function sdStartRead(path, offset, windowLen, blockLen) {
    // A second read supersedes the first, exactly as the firmware's single
    // window does — and the stale session id is how the host tells the
    // leftover frames apart.
    if (sdRead) sdFinishRead(SD_XFER.SUPERSEDED, sdRead.offset + sdRead.sent);
    const session = (sdSession = (sdSession + 1) & 0xff);
    const file = sdFileAt(path);
    if (!file) {
      sdReplyStatus(session, SD_XFER.NOT_FOUND, offset);
      return;
    }
    if (state.streaming) {
      sdReplyStatus(session, SD_XFER.DENIED, offset);
      return;
    }
    const want = Math.max(0, Math.min(windowLen, file.size - offset));
    if (want === 0) {
      sdReplyStatus(session, SD_XFER.EOF, file.size);
      return;
    }

    const perTick = Math.max(
      blockLen,
      Math.round((sdKBps * 1024 * SD_TICK_MS) / 1000),
    );
    sdRead = { file, offset, want, sent: 0, seq: 0, session, timer: null };
    sdRead.timer = setInterval(() => {
      const r = sdRead;
      if (!r) return;
      let budget = perTick;
      while (r.sent < r.want && budget > 0) {
        const n = Math.min(blockLen, r.want - r.sent);
        sdReplyData(
          r.session,
          r.seq++,
          sdFileSlice(r.file, r.offset + r.sent, n),
        );
        r.sent += n;
        budget -= n;
      }
      if (r.sent >= r.want) {
        const nextOffset = r.offset + r.sent;
        sdFinishRead(
          nextOffset >= r.file.size ? SD_XFER.EOF : SD_XFER.WINDOW_COMPLETE,
          nextOffset,
        );
      }
    }, SD_TICK_MS);
  }

  // -------------------------------------------------------------------------
  // SD card: the one-shot responses
  // -------------------------------------------------------------------------

  /**
   * `[0xC1][status][startIdx u16][entriesLen u16][nEntries][flags][entries…]`
   * with one entry as `[attr][size u32][fdate u16][ftime u16][nameLen][name]`.
   *
   * NOTE the directory attribute is 0x01 ({@link SD_ATTR_DIR}) — the
   * firmware's own flag, not FAT's 0x10. Getting that wrong makes every
   * folder list as a zero-byte file.
   */
  function sdListDirResponse(path, startIdx, maxEntries) {
    const header = (status, entries, hasMore) => {
      const body = entries.length
        ? entries.reduce((n, e) => n + e.length, 0)
        : 0;
      const out = new Uint8Array(8 + body);
      out[0] = SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE;
      out[1] = status;
      out[2] = startIdx & 0xff;
      out[3] = (startIdx >> 8) & 0xff;
      out[4] = body & 0xff;
      out[5] = (body >> 8) & 0xff;
      out[6] = entries.length;
      out[7] = hasMore ? 0x01 : 0x00;
      let at = 8;
      for (const e of entries) {
        out.set(e, at);
        at += e.length;
      }
      return out;
    };

    if (state.streaming) return header(SD_STATUS.BUSY, [], false);
    if (!sdDirs.includes(path)) return header(FR_NO_PATH, [], false);

    // Directories before files, which is the order a freshly written card
    // hands them back and the order the tree reads best in.
    const children = [
      ...sdDirs
        .filter((d) => parentOf(d) === path)
        .map((d) => ({ path: d, dir: true })),
      ...sdFiles
        .filter((f) => parentOf(f.path) === path)
        .map((f) => ({ ...f, dir: false })),
    ];
    const page = children.slice(
      startIdx,
      startIdx + Math.min(maxEntries || 1, SD_ENTRIES_PER_PAGE),
    );
    const encoded = page.map((c) => {
      const name = nameOf(c.path);
      const entry = new Uint8Array(10 + name.length);
      entry[0] = c.dir ? SD_ATTR_DIR : 0x00;
      new DataView(entry.buffer).setUint32(1, c.dir ? 0 : c.size, true);
      new DataView(entry.buffer).setUint16(5, c.dir ? 0 : c.fdate, true);
      new DataView(entry.buffer).setUint16(7, c.dir ? 0 : c.ftime, true);
      entry[9] = name.length;
      for (let i = 0; i < name.length; i++) entry[10 + i] = name.charCodeAt(i);
      return entry;
    });
    return header(
      SD_STATUS.OK,
      encoded,
      startIdx + page.length < children.length,
    );
  }

  /** `[0xC3][status][size u32][fdate u16][ftime u16][attr]` */
  function sdStatResponse(path) {
    const out = new Uint8Array(11);
    out[0] = SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE;
    const file = sdFileAt(path);
    const isDir = sdDirs.includes(path);
    if (state.streaming) {
      out[1] = SD_STATUS.BUSY;
      return out;
    }
    if (!file && !isDir) {
      out[1] = FR_NO_FILE;
      return out;
    }
    out[1] = SD_STATUS.OK;
    const view = new DataView(out.buffer);
    view.setUint32(2, file ? file.size : 0, true);
    view.setUint16(6, file ? file.fdate : 0, true);
    view.setUint16(8, file ? file.ftime : 0, true);
    out[10] = isDir ? SD_ATTR_DIR : 0x00;
    return out;
  }

  /** `[0xC9][status][freeKB u32][totalKB u32]` */
  function sdFreeSpaceResponse() {
    const out = new Uint8Array(10);
    out[0] = SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE;
    out[1] = state.streaming ? SD_STATUS.BUSY : SD_STATUS.OK;
    const usedKB = Math.ceil(sdFiles.reduce((n, f) => n + f.size, 0) / 1024);
    const view = new DataView(out.buffer);
    view.setUint32(2, SD_TOTAL_KB - SD_RESERVED_KB - usedKB, true);
    view.setUint32(6, SD_TOTAL_KB, true);
    return out;
  }

  /**
   * `[0xCB][status]`
   *
   * The firmware only permits paths strictly under `data/`, and refuses a
   * directory that still holds something — which is what makes the SDK's
   * "delete the emptied folders afterwards, deepest first" pass necessary.
   */
  function sdDeleteResponse(path) {
    const out = new Uint8Array([SD_TRANSFER_OPCODES.DELETE_RESPONSE, 0]);
    if (state.streaming) {
      out[1] = SD_STATUS.BUSY;
      return out;
    }
    if (!path.startsWith("data/")) {
      out[1] = SD_STATUS.BAD_ARGS;
      return out;
    }
    if (sdFileAt(path)) {
      sdFiles = sdFiles.filter((f) => f.path !== path);
      out[1] = SD_STATUS.OK;
      return out;
    }
    if (sdDirs.includes(path)) {
      const populated =
        sdFiles.some((f) => f.path.startsWith(path + "/")) ||
        sdDirs.some((d) => d !== path && d.startsWith(path + "/"));
      if (populated) {
        out[1] = FR_DENIED;
        return out;
      }
      sdDirs = sdDirs.filter((d) => d !== path);
      out[1] = SD_STATUS.OK;
      return out;
    }
    out[1] = FR_NO_FILE;
    return out;
  }

  /**
   * Every SD-transfer command. Returns true when `cmd` was one of them.
   *
   * Dispatched ahead of the main switch rather than as cases inside it so the
   * whole feature reads as one block.
   */
  function handleSdCommand(cmd) {
    switch (cmd[0]) {
      case SD_TRANSFER_OPCODES.LIST_DIR_COMMAND: {
        // [0xCC][startIdx u16][maxEntries u8][pathLen u8][path]
        const startIdx = (cmd[1] ?? 0) | ((cmd[2] ?? 0) << 8);
        const maxEntries = cmd[3] ?? 0;
        const path = ascii(cmd, 5, cmd[4] ?? 0);
        reply(concat([ACK], sdListDirResponse(path, startIdx, maxEntries)));
        return true;
      }

      case SD_TRANSFER_OPCODES.FILE_STAT_COMMAND:
        // [0xC2][pathLen u8][path]
        reply(concat([ACK], sdStatResponse(ascii(cmd, 2, cmd[1] ?? 0))));
        return true;

      case SD_TRANSFER_OPCODES.FILE_READ_COMMAND: {
        // [0xC4][offset u32][windowLen u32][blockPayloadLen u16][pathLen][path]
        const view = new DataView(cmd.buffer, cmd.byteOffset, cmd.byteLength);
        const offset = view.getUint32(1, true);
        const windowLen = view.getUint32(5, true);
        const blockLen = view.getUint16(9, true);
        const path = ascii(cmd, 12, cmd[11] ?? 0);
        reply([ACK]);
        sdStartRead(path, offset, windowLen, blockLen);
        return true;
      }

      case SD_TRANSFER_OPCODES.TRANSFER_ABORT_COMMAND:
        // The host has already given up on the window by the time this
        // arrives; the closing frame is sent anyway, because the firmware
        // does, and a mock that skipped it would hide a host that mishandled
        // a late frame from the previous session.
        reply([ACK]);
        if (sdRead)
          sdFinishRead(SD_XFER.HOST_ABORT, sdRead.offset + sdRead.sent);
        return true;

      case SD_TRANSFER_OPCODES.FREE_SPACE_COMMAND:
        reply(concat([ACK], sdFreeSpaceResponse()));
        return true;

      case SD_TRANSFER_OPCODES.DELETE_COMMAND:
        reply(concat([ACK], sdDeleteResponse(ascii(cmd, 2, cmd[1] ?? 0))));
        return true;

      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Data-rate test (SET_DATA_RATE_TEST 0xA4)
  // -------------------------------------------------------------------------

  let rateTimer = null;
  let rateCounter = 0;

  function stopRateTest() {
    if (!rateTimer) return;
    clearInterval(rateTimer);
    rateTimer = null;
  }

  /**
   * The firmware free-runs 5-byte counter packets — `[0xA5][counter u32]` — as
   * fast as the link drains them, and the host times how many bytes arrive.
   * Paced at `linkKBps` here, in one burst per tick, which is how a real link
   * delivers them anyway.
   */
  function handleDataRateTest(cmd) {
    if (cmd[0] !== CMD.SET_DATA_RATE_TEST) return false;
    stopRateTest();
    // ACK first: `reply` defers by a macrotask, so the first burst cannot
    // bury the acknowledgement the host is waiting for.
    reply([ACK]);
    if (!cmd[1]) return true;
    rateCounter = 0;
    const perTick = Math.max(
      5,
      Math.round((linkKBps * 1024 * SD_TICK_MS) / 1000),
    );
    rateTimer = setInterval(() => {
      const count = Math.floor(perTick / 5);
      const out = new Uint8Array(count * 5);
      const view = new DataView(out.buffer);
      for (let i = 0; i < count; i++) {
        out[i * 5] = CMD.DATA_RATE_TEST_RESPONSE;
        view.setUint32(i * 5 + 1, rateCounter++ >>> 0, true);
      }
      replyStream(out);
    }, SD_TICK_MS);
    return true;
  }

  // Stop the timers when the link goes away, or a "disconnected" mock keeps
  // pushing frames at a client that is no longer listening.
  transport.onDisconnect(() => {
    /* Before `state.streaming` is cleared below: firmware skips an armed
       restart while sensing, and a restart that read the flag afterwards
       would always think the sensor was idle. */
    applyPendingReboot();
    stopStreaming();
    stopRateTest();
    if (sdRead) {
      clearInterval(sdRead.timer);
      sdRead = null;
    }
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

    /* SD file transfer and the link-speed test, both dispatched as blocks of
       their own — see the SD card section above. */
    if (handleSdCommand(cmd)) return;
    if (handleDataRateTest(cmd)) return;

    switch (op) {
      case CMD.INQUIRY:
        reply(concat([ACK], inquiryResponse()));
        return;

      case CMD.GET_FW_VERSION:
        // fwId u16 LE = 3 (LogAndStream), major u16 LE, then minor and patch
        reply([
          ACK,
          CMD.FW_VERSION_RESPONSE,
          3,
          0,
          fw.major & 0xff,
          (fw.major >> 8) & 0xff,
          fw.minor & 0xff,
          fw.patch & 0xff,
        ]);
        return;

      case CMD.GET_DEVICE_VERSION:
        /* 10 = Shimmer3R. A null `hardwareVersion` NACKs instead, which is
           what a page sees from a sensor it cannot identify — and the state
           every "assume a Shimmer3R" default quietly papers over. */
        if (hardwareVersion == null) {
          reply([NACK]);
          return;
        }
        reply([ACK, CMD.DEVICE_VERSION_RESPONSE, hardwareVersion & 0xff]);
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
        if (
          chip > 1 ||
          start + len > IM.exgBankLength ||
          cmd.length < 4 + len
        ) {
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

      case CMD.GET_DAUGHTER_CARD_MEM: {
        // [0x69][len][offsetLo][offsetHi] → [0x68][len][data…]
        const len = cmd[1] ?? 0;
        const off = (cmd[2] ?? 0) | ((cmd[3] ?? 0) << 8);
        if (len < 1 || len > EEPROM_MAX_PER_CALL || off + len > eeprom.length) {
          reply([NACK]);
          return;
        }
        const out = new Uint8Array(2 + len);
        out[0] = CMD.DAUGHTER_CARD_MEM_RESPONSE;
        out[1] = len;
        out.set(eeprom.subarray(off, off + len), 2);
        reply(concat([ACK], out));
        return;
      }

      case CMD.SET_DAUGHTER_CARD_MEM: {
        // [0x67][len][offsetLo][offsetHi][data…]
        const len = cmd[1] ?? 0;
        const off = (cmd[2] ?? 0) | ((cmd[3] ?? 0) << 8);
        /* The 128-byte ceiling is the firmware's, not an arbitrary limit: the
           command has to fit one receive buffer. A page that asked for more
           gets the NACK a real sensor would send, rather than a mock that
           silently accepts a write no device would. */
        if (
          len < 1 ||
          len > EEPROM_MAX_PER_CALL ||
          off + len > eeprom.length ||
          cmd.length < 4 + len
        ) {
          reply([NACK]);
          return;
        }
        eeprom.set(cmd.subarray(4, 4 + len), off);
        reply([ACK]);
        return;
      }

      case CMD.SET_FEATURE: {
        // [0xB7][featureId][value]
        if (cmd[1] === FEATURE.REBOOT_ON_DISCONNECT) {
          state.rebootArmed = !!cmd[2];
          reply([ACK]);
          return;
        }
        /* Every other feature id is NACKed, which is also how firmware built
           before a feature existed answers — the path a page's fallback to
           "power-cycle it by hand" depends on. */
        if (debug) {
          console.warn(`[mock] unknown SET_FEATURE id ${cmd[1]}`);
        }
        reply([NACK]);
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

/** `len` bytes of `buf` from `at`, as ASCII — how card paths arrive. */
function ascii(buf, at, len) {
  return String.fromCharCode(...buf.subarray(at, at + len));
}
