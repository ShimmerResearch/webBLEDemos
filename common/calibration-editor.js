/**
 * Calibration: read, show and edit the per-sensor kinematic calibration a
 * Shimmer3 or Shimmer3R holds — offset, sensitivity and alignment, per sensor
 * and per range — instead of the hex blob the page used to print.
 *
 * Modelled on the Verisense console's calibration tab
 * (`verisense-device-console/console.js:6537-6610`, `renderCalibTab`): one
 * card per sensor, each with the sensor name, a range selector, an "as of"
 * timestamp and labelled grids. Two things are deliberately NOT copied from
 * it:
 *
 *   - the console renders sensitivity as a 3x3 grid, which suits the ASM
 *     calibration blob it edits. A Shimmer3 21-byte kinematic block stores
 *     sensitivity as a DIAGONAL of three i16s, so nine cells here would offer
 *     six edits the format cannot store. Offset is 3x1, sensitivity is 3x1,
 *     alignment is 3x3.
 *   - the console's sensor list is fixed. Here availability is three-state —
 *     shown, shown-but-disabled with a reason, or hidden — because a Shimmer3
 *     has no ADXL371 alt-accel and no LIS3MDL alt-mag, and offering them would
 *     say the sensor could be calibrated when it does not exist.
 *
 * WHICH STORE THIS EDITS
 * ----------------------
 * Two different things on the device hold calibration:
 *
 *   the CALIBRATION DUMP — a TLV of records keyed by sensor id AND range, each
 *     with its own timestamp, read with GET_CALIB_DUMP (0x9A) and written with
 *     SET_CALIB_DUMP (0x98) + UPD_CALIB_DUMP (0x9B). It is the only store that
 *     can answer "which range is this calibration for, and when was it taken",
 *     so it is the one this panel EDITS wherever the link offers it.
 *
 *   the INFOMEM BLOCKS — six 21-byte blocks in the configuration image, one
 *     per sensor, for whichever range is configured right now. No range, no
 *     date. The dock/USB link and the classic `Shimmer3Client` have no dump
 *     commands at all, so on those links this panel falls back to SHOWING
 *     those blocks, read-only, and says so on screen. It does not write them:
 *     the configuration image belongs to the configuration form, which holds
 *     its own unsaved edits and its own write-and-verify, and a second writer
 *     racing it would silently drop whichever change lost.
 *
 * Whichever store is in play is named in the header card, in the write
 * confirmation and in the log line, so a Write is never ambiguous.
 *
 * AND THE ORDER THAT MATTERS. The firmware regenerates its whole dump FROM the
 * configuration bytes whenever InfoMem page D (page C on a Shimmer3R) is
 * written — `ShimCalib_configBytes0To127ToCalibDumpBytes`,
 * `Calibration/shimmer_calibration.c:932-953`, called from
 * `Comms/shimmer_bt_uart.c` on a config write. So a configuration write AFTER
 * a calibration write throws the calibration away. The panel says that in the
 * header rather than only in a comment.
 *
 * The panel builds its own markup inside the host element and owns the
 * `disabled` state of every control in it, so a page mounts it with one
 * `<div>` and one call. It holds no page-specific ids and reads no page
 * globals — which is what lets a combined Verisense + Shimmer3 application
 * mount it unchanged.
 *
 * Nothing here touches `document` at import time.
 *
 *   import { createCalibrationEditor } from "../common/calibration-editor.js";
 */

import { el, downloadBlob } from "./ui-chrome.js";
/* The whole namespace rather than destructured names: a vendored bundle that
   predates one of the calibration exports then degrades to a message from
   `mount()` instead of breaking the importing page. */
import * as sdk from "../shimmer-extension/vendor/shimmer-web-sdk.esm.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hardware ids, as GET_DEVICE_VERSION reports them. */
const HW_ID = Object.freeze({ SHIMMER3: 3, SHIMMER3R: 10 });

/** Bytes in one kinematic calibration block (SC_DATA_LEN_STD_IMU_CALIB). */
const BLOCK_BYTES = 21;

/** RTC tick rate. The dump timestamp is a 64-bit tick count, not seconds. */
const RTC_TICKS_PER_SECOND = 32768;

/**
 * Plausibility window for a decoded calibration date, as Unix milliseconds.
 *
 * The timestamp is whatever the device's real-world clock read when the
 * calibration was stored (`RTC_getRwcTime()`,
 * `Calibration/shimmer_calibration.c:1054`). A sensor whose clock has never
 * been set stamps a tick count measured from boot, which decodes to 1970 —
 * a date that is not wrong so much as meaningless, and printing it as
 * "calibrated 1970-01-01" reads as a fact. Anything outside this window is
 * reported as an unset clock instead.
 */
const STAMP_MIN_MS = Date.UTC(2010, 0, 1);
const STAMP_MAX_MS = Date.UTC(2100, 0, 1);

/**
 * Calibration-domain sensor ids, from the firmware the dump comes from:
 * `SC_SENSOR_*` in log-and-stream-common `Calibration/shimmer_calibration.h`.
 *
 * NOT the SDK's `CalibSensorId`, which is the Verisense/ASM domain and
 * disagrees on two values — there 40 is an LSM6DS3 accel and 41 an LSM6DS3
 * gyro, whereas Shimmer3R firmware uses 40 for the ADXL371 high-g accel and
 * 41 for the LIS3MDL alt-mag. Reading a Shimmer3R dump through that table
 * mislabels two of its six sensors.
 */
const SC_SENSOR = Object.freeze({
  ANALOG_ACCEL: 2,
  MPU9X50_GYRO: 30,
  LSM303_ACCEL: 31,
  LSM303_MAG: 32,
  MPU9X50_ACCEL: 33,
  MPU9X50_MAG: 34,
  BMP180_PRESSURE: 36,
  LSM6DSV_ACCEL: 37,
  LSM6DSV_GYRO: 38,
  LIS2DW12_ACCEL: 39,
  ADXL371_ACCEL: 40,
  LIS3MDL_MAG: 41,
  LIS2MDL_MAG: 42,
  BMP390_PRESSURE: 43,
});

/**
 * Every sensor the panel can name, in the order the cards appear.
 *
 * `group` is the SDK's `InertialGroup`, which is what keys both
 * `getGroupDefaults` and the InfoMem calibration blocks. A row with no
 * `group` (the pressure sensors) is a sensor whose calibration is a
 * chip-specific coefficient block rather than a kinematic one: it is shown,
 * disabled, with the reason — not hidden, because the device really does hold
 * a calibration for it and a panel that omitted it would look like the dump
 * had fewer records than it has.
 *
 * `rangesKey` names the SDK option table with the human range labels. Absent
 * where the SDK has no table (the Kionix low-noise accel has exactly one
 * range), and the range value is then shown as itself.
 */
const SENSOR_ROWS = Object.freeze({
  "shimmer3-old": Object.freeze([
    {
      group: "lnAccel",
      id: SC_SENSOR.ANALOG_ACCEL,
      label: "Low-noise accelerometer",
      chip: "KXRB5-2042",
    },
    {
      group: "gyro",
      id: SC_SENSOR.MPU9X50_GYRO,
      label: "Gyroscope",
      chip: "MPU9x50 / ICM20948",
      rangesKey: "SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS",
    },
    {
      group: "wrAccel",
      id: SC_SENSOR.LSM303_ACCEL,
      label: "Wide-range accelerometer",
      chip: "LSM303DLHC",
      rangesKey: "SHIMMER3_LSM303DLHC_ACCEL_RANGE_OPTIONS",
    },
    {
      group: "mag",
      id: SC_SENSOR.LSM303_MAG,
      label: "Magnetometer",
      chip: "LSM303DLHC",
      rangesKey: "SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS",
    },
    {
      id: SC_SENSOR.BMP180_PRESSURE,
      label: "Pressure / temperature",
      chip: "BMP180",
      unmodelled: true,
    },
  ]),
  "shimmer3-new": Object.freeze([
    {
      group: "lnAccel",
      id: SC_SENSOR.ANALOG_ACCEL,
      label: "Low-noise accelerometer",
      chip: "KXRB5-2042",
    },
    {
      group: "gyro",
      id: SC_SENSOR.MPU9X50_GYRO,
      label: "Gyroscope",
      chip: "MPU9x50 / ICM20948",
      rangesKey: "SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS",
    },
    {
      group: "wrAccel",
      id: SC_SENSOR.LSM303_ACCEL,
      label: "Wide-range accelerometer",
      chip: "LSM303AHTR",
      rangesKey: "SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS",
    },
    {
      group: "mag",
      id: SC_SENSOR.LSM303_MAG,
      label: "Magnetometer",
      chip: "LSM303AHTR",
      rangesKey: "SHIMMER3_LSM303AH_MAG_RANGE_OPTIONS",
    },
    {
      id: SC_SENSOR.BMP180_PRESSURE,
      label: "Pressure / temperature",
      chip: "BMP180 / BMP280",
      unmodelled: true,
    },
  ]),
  shimmer3r: Object.freeze([
    {
      group: "lnAccel",
      id: SC_SENSOR.LSM6DSV_ACCEL,
      label: "Low-noise accelerometer",
      chip: "LSM6DSV",
      rangesKey: "SHIMMER3_LSM6DSV_ACCEL_RANGE_OPTIONS",
    },
    {
      group: "gyro",
      id: SC_SENSOR.LSM6DSV_GYRO,
      label: "Gyroscope",
      chip: "LSM6DSV",
      rangesKey: "SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS",
    },
    {
      group: "wrAccel",
      id: SC_SENSOR.LIS2DW12_ACCEL,
      label: "Wide-range accelerometer",
      chip: "LIS2DW12",
      rangesKey: "SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS",
    },
    {
      group: "mag",
      id: SC_SENSOR.LIS2MDL_MAG,
      label: "Magnetometer",
      chip: "LIS2MDL",
      rangesKey: "SHIMMER3_LIS2MDL_MAG_RANGE_OPTIONS",
    },
    {
      group: "altAccel",
      id: SC_SENSOR.ADXL371_ACCEL,
      label: "High-g accelerometer",
      chip: "ADXL371",
      rangesKey: "SHIMMER3_ADXL371_ACCEL_RANGE_OPTIONS",
    },
    {
      group: "altMag",
      id: SC_SENSOR.LIS3MDL_MAG,
      label: "Alternate magnetometer",
      chip: "LIS3MDL",
      rangesKey: "SHIMMER3_LIS3MDL_ALT_MAG_RANGE_OPTIONS",
    },
    {
      id: SC_SENSOR.BMP390_PRESSURE,
      label: "Pressure / temperature",
      chip: "BMP390 / BMP581",
      unmodelled: true,
    },
  ]),
});

/** Axis labels down the side of every grid. */
const AXES = Object.freeze(["x", "y", "z"]);

/**
 * What the three parts of a block can hold, straight out of the byte layout
 * that `generateKinematicCalibBlock` writes:
 *
 *   offset       3 x i16 big-endian, stored verbatim (Java truncates a
 *                fraction with an `(int)` cast, so a fractional offset is
 *                refused here rather than silently losing its fraction)
 *   sensitivity  3 x i16 big-endian, stored as round(value x scale). The
 *                scale is 100 for gyro and 1 for everything else, so the
 *                bound depends on the sensor.
 *   alignment    9 x i8, stored as round(value x 100)
 */
const I16_MIN = -32768;
const I16_MAX = 32767;
const I8_MIN = -128;
const I8_MAX = 127;

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Mount the calibration editor inside `host`.
 *
 * @param {HTMLElement} host an empty container; its contents are replaced
 * @param {object} opts
 * @param {object|(() => object|null)} opts.client the connected client, or a
 *   getter for it. Pass the GETTER form from a page whose client comes and
 *   goes with the link — the panel is mounted once and then reads whatever is
 *   current, so it can never hold a stale client.
 * @param {string|null|(() => string|null)} [opts.generation] the value
 *   `inferShimmer3Generation` returned: `"shimmer3r"`, `"shimmer3-new-imu"` or
 *   `"shimmer3-old-imu"`. Decides which sensors exist and which default
 *   calibration tables apply. Pass nothing (or null) when the sensor could not
 *   be identified: the panel then takes the hardware id out of the dump's own
 *   version header, and only if that fails too does it disable every card with
 *   the reason.
 * @param {number|null|(() => number|null)} [opts.hardwareVersion] the hardware
 *   id the sensor actually reported, used only as a fallback for
 *   `opts.generation`. Never pass a defaulted one.
 * @param {object|null|(() => object|null)} [opts.activeRanges] the ranges the
 *   sensor is configured for, as `{lnAccel, wrAccel, gyro, mag, altAccel,
 *   altMag}`. Only used to mark one option "configured" and to open each card
 *   on the range that is actually in use; entirely optional.
 * @param {object|null|(() => object|null)} [opts.infoMemBlocks] the six
 *   21-byte InfoMem calibration blocks (`parseInfoMem(...).calibration`), for
 *   the read-only fallback on a link with no calibration-dump commands. A
 *   getter, so the panel always reads the image the page holds NOW.
 * @param {() => Promise<unknown>} [opts.readInfoMem] how the host page
 *   re-reads its configuration image, for the fallback's Read button.
 * @param {{log: Function, warn: Function, error: Function}} [opts.log]
 * @param {(busy: boolean) => void} [opts.onBusyChange] called when a
 *   calibration read or write starts and finishes. A host page folds this into
 *   its own busy state, so everything that shares the link is refused while a
 *   calibration write is in flight.
 * @param {(message: string, kind?: string) => void} [opts.toast]
 * @param {(text: string) => boolean} [opts.confirm] defaults to
 *   `window.confirm`
 * @param {string|(() => string|null)} [opts.fileNamePrefix="shimmer"] leading
 *   part of the saved dump's file name; a getter, so a page can name the file
 *   after a sensor that was not connected when the panel was mounted
 * @returns {{
 *   read: () => Promise<object|null>,
 *   write: () => Promise<boolean>,
 *   save: () => boolean,
 *   load: (bytes: Uint8Array) => boolean,
 *   restoreDefaults: (group: string) => boolean,
 *   dump: () => object|null,
 *   bytes: () => Uint8Array|null,
 *   store: () => "dump"|"infomem"|"none",
 *   family: () => string|null,
 *   changes: () => {group: string, sensorId: number, range: number,
 *                   label: string, was: Uint8Array|null, now: Uint8Array}[],
 *   problems: () => string[],
 *   setEnabled: (enabled: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createCalibrationEditor(host, opts = {}) {
  const getClient =
    typeof opts.client === "function" ? opts.client : () => opts.client ?? null;
  const log = opts.log ?? { log() {}, warn() {}, error() {} };
  const toast = opts.toast ?? (() => {});
  const ask = opts.confirm ?? ((text) => window.confirm(text));
  const getGeneration = asGetter(opts.generation);
  const getHardware = asGetter(opts.hardwareVersion);
  const getActiveRanges = asGetter(opts.activeRanges);
  const getInfoMemBlocks = asGetter(opts.infoMemBlocks);
  /* A getter as well as a value: a page names the file after the sensor, and
     the sensor is not connected when the panel is mounted. */
  const getFilePrefix = asGetter(opts.fileNamePrefix);

  /* A vendored bundle from before the calibration codec shipped: say so once,
     here, rather than throwing from the first button press. */
  const missing = [
    "parseCalibDump",
    "generateCalibDump",
    "parseKinematicCalibBlock",
    "generateKinematicCalibBlock",
    "getGroupDefaults",
    "getDefaultCalibration",
  ].filter((name) => typeof sdk[name] !== "function");
  if (missing.length) {
    host.replaceChildren(
      el(
        "div",
        { class: "banner err" },
        `This page is running an SDK bundle with no calibration support (missing ${missing.join(", ")}). Re-vendor the SDK to read or change what this sensor is calibrated to.`,
      ),
    );
    log.error(
      `calibration unavailable: the vendored SDK has no ${missing.join(", ")}`,
    );
    return inertPanel();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** The dump exactly as the device last handed it over, or as loaded. */
  let dumpBytes = null;
  /** Its parsed form. */
  let dumpParsed = null;
  /** `${sensorId}:${range}` -> CalibDumpRecord, from `dumpParsed`. */
  let records = new Map();
  /** True when `dumpBytes` came from a file rather than from the sensor. */
  let fromFile = false;
  /** The InfoMem blocks last shown by the read-only fallback, or null. */
  let infoMemShown = null;
  /**
   * Edited values, keyed `${group}:${range}`, each `{offset[3], sens[3],
   * align[9]}` of the strings that are in the boxes. Kept per range so
   * switching ranges and back does not lose an edit in progress.
   */
  const edited = new Map();
  /** The range each card is currently showing. */
  const shownRange = new Map();
  /** A calibration read or write is in flight. */
  let busy = false;
  /** The floor the host page sets: can this link do calibration at all? */
  let enabled = false;
  let destroyed = false;
  /** Set once the cards have been built, so a rebuild can be detected. */
  let builtFamily = null;

  // -------------------------------------------------------------------------
  // Markup — the header card
  // -------------------------------------------------------------------------

  const storePill = el(
    "span",
    { class: "pill", dataset: { calRole: "storePill" } },
    "not read",
  );
  const btnRead = el(
    "button",
    { type: "button", dataset: { calRole: "read" } },
    "Read from sensor",
  );
  const btnWrite = el(
    "button",
    { type: "button", class: "warn", dataset: { calRole: "write" } },
    "Write to sensor",
  );
  const btnSave = el(
    "button",
    { type: "button", dataset: { calRole: "save" } },
    "Save dump",
  );
  const btnLoad = el(
    "button",
    { type: "button", dataset: { calRole: "load" } },
    "Load dump",
  );
  const fileInput = el("input", {
    type: "file",
    accept: ".bin,application/octet-stream",
    hidden: true,
    dataset: { calRole: "file" },
    onchange: onFilePicked,
  });
  const storeBanner = el("div", {
    class: "banner",
    dataset: { calRole: "storeBanner" },
  });
  const storeNote = el("div", {
    class: "field-hint",
    dataset: { calRole: "storeNote" },
  });
  const changeNote = el("div", {
    class: "field-hint",
    dataset: { calRole: "changeNote" },
  });

  const headerCard = el(
    "div",
    { class: "card" },
    el("div", { class: "card-title" }, "Calibration store ", storePill),
    storeBanner,
    el("div", { class: "row" }, btnRead, btnWrite, btnSave, btnLoad, fileInput),
    changeNote,
    storeNote,
    el(
      "div",
      { class: "field-hint" },
      "The firmware rebuilds its whole calibration dump from the configuration " +
        "bytes every time a configuration image is written, so a configuration " +
        "write AFTER this one throws these values away. Apply a configuration " +
        "first, then write calibration.",
    ),
  );

  /** Where the per-sensor cards go. Rebuilt when the hardware family changes. */
  const sensorHost = el("div", { dataset: { calRole: "sensors" } });

  host.replaceChildren(headerCard, sensorHost);

  // -------------------------------------------------------------------------
  // Hardware family
  // -------------------------------------------------------------------------

  /**
   * The SDK `ImuFamily` this sensor belongs to, or null when nothing has said.
   *
   * Three sources, in order of how much they actually know: what the page
   * identified, the hardware id the page read, and — last — the hardware id
   * written into the dump's own version header, which is the device's own
   * statement about what produced these records. That last one is why a
   * sensor that refuses GET_DEVICE_VERSION still gets a usable tab.
   */
  function family() {
    const gen = getGeneration();
    if (gen === "shimmer3r") return "shimmer3r";
    if (gen === "shimmer3-new-imu") return "shimmer3-new";
    if (gen === "shimmer3-old-imu") return "shimmer3-old";
    const hw = getHardware() ?? dumpParsed?.version?.hardwareId ?? null;
    if (hw === HW_ID.SHIMMER3R) return "shimmer3r";
    /* A Shimmer3 with no expansion-board read is old-IMU by the same rule
       `inferShimmer3Generation` uses when it is handed no board. */
    if (hw === HW_ID.SHIMMER3) return "shimmer3-old";
    return null;
  }

  /**
   * Which store is in play: the calibration dump, the InfoMem blocks, or
   * neither.
   *
   * Decided by the CLIENT first, because that is what decides where a Write
   * would land — a link with `readCalibDump`/`writeCalibDump` edits the dump,
   * any other link can only be shown the InfoMem blocks. With nothing
   * connected it follows whatever is on screen, so a dump loaded from a file
   * can still be read, edited and saved with no sensor on the desk.
   */
  function store() {
    const client = getClient();
    if (client) {
      return typeof client.readCalibDump === "function" &&
        typeof client.writeCalibDump === "function"
        ? "dump"
        : "infomem";
    }
    if (dumpBytes) return "dump";
    return infoMemShown ? "infomem" : "none";
  }

  const STORE_LABEL = Object.freeze({
    dump: "calibration dump",
    infomem: "configuration image (InfoMem)",
    none: "no calibration store",
  });

  // -------------------------------------------------------------------------
  // Number formatting and validation
  // -------------------------------------------------------------------------

  /** A number as short as it can be written without changing it. */
  function num(v) {
    if (!Number.isFinite(v)) return "";
    /* Six decimals is past anything the byte layout can hold (a sensitivity
       resolves to 1/100 and an alignment to 1/100), so this only ever trims
       floating-point dust. */
    return String(Number(v.toFixed(6)));
  }

  /**
   * What one box may hold, as the byte layout sees it.
   *
   * Returns `{min, max, step, describe}` in the units shown on screen, so the
   * refusal names the number the user typed rather than the integer it would
   * have been scaled to.
   */
  function limitsFor(part, sensitivityScale) {
    if (part === "offset") {
      return {
        scale: 1,
        min: I16_MIN,
        max: I16_MAX,
        describe: `a whole number from ${I16_MIN} to ${I16_MAX}`,
      };
    }
    if (part === "sens") {
      const scale = sensitivityScale || 1;
      return {
        scale,
        min: I16_MIN / scale,
        max: I16_MAX / scale,
        describe:
          scale === 1
            ? `a whole number from ${I16_MIN} to ${I16_MAX}`
            : `${num(I16_MIN / scale)} to ${num(I16_MAX / scale)} in steps of ${num(1 / scale)}`,
      };
    }
    return {
      scale: 100,
      min: I8_MIN / 100,
      max: I8_MAX / 100,
      describe: `${num(I8_MIN / 100)} to ${num(I8_MAX / 100)} in steps of 0.01`,
    };
  }

  /**
   * Validate one typed value against what the format can hold.
   *
   * Deliberately refuses rather than clamping. A silently clamped offset is a
   * calibration nobody asked for, written under the name of one somebody did.
   *
   * @returns {{value: number}|{problem: string}}
   */
  function checkValue(text, part, sensitivityScale) {
    const raw = String(text ?? "").trim();
    if (!raw) return { problem: "needs a value" };
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
      return { problem: "not a number" };
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) return { problem: "not a number" };
    const lim = limitsFor(part, sensitivityScale);
    if (v < lim.min || v > lim.max) {
      return { problem: `out of range — ${lim.describe}` };
    }
    /* The encoder rounds sensitivity and alignment and TRUNCATES offset. A
       value that would not survive that round trip is refused here, so the
       number in the box is always the number on the device. */
    const settled = Math.round(v * lim.scale) / lim.scale;
    if (Math.abs(settled - v) > 1e-9) {
      return {
        problem:
          lim.scale === 1
            ? "must be a whole number"
            : `must be a multiple of ${num(1 / lim.scale)}`,
      };
    }
    return { value: v };
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  /** group (or `id:<n>` for an unmodelled sensor) -> the card's parts. */
  const cards = new Map();

  /** Range options for one row: `[value, label]` pairs, always non-empty. */
  function rangesFor(row, fam) {
    const table = row.rangesKey ? sdk[row.rangesKey] : null;
    const known = row.group ? sdk.getGroupDefaults(fam, row.group) : null;
    const fromDefaults = known ? Object.keys(known.byRange).map(Number) : [];
    if (Array.isArray(table) && table.length) {
      const labels = new Map(table.map(([v, l]) => [Number(v), String(l)]));
      /* The union, so a range the defaults table knows but the option table
         does not (and the other way round) still appears rather than becoming
         a range the user cannot select a stored record for. */
      const values = [...new Set([...labels.keys(), ...fromDefaults])].sort(
        (a, b) => a - b,
      );
      return values.map((v) => [v, labels.get(v) ?? `range ${v}`]);
    }
    if (fromDefaults.length) {
      return fromDefaults.sort((a, b) => a - b).map((v) => [v, `range ${v}`]);
    }
    return [[0, "range 0"]];
  }

  function makeInput(group, part, index, onEdit) {
    return el("input", {
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      spellcheck: "false",
      class: "cal-cell",
      "aria-label": `${part} ${AXES[index % 3]}`,
      dataset: { calInput: `${group}:${part}:${index}` },
      oninput: onEdit,
      onchange: onEdit,
    });
  }

  /** One labelled grid: a title, an optional unit, and n boxes. */
  function makeGrid(group, part, title, unitNode, count, onEdit) {
    const cells = [];
    const body = el("div", {
      class: count === 9 ? "cal-matrix cols-3" : "cal-matrix cols-1",
    });
    for (let r = 0; r < 3; r++) {
      body.appendChild(el("div", { class: "cal-axis" }, AXES[r]));
      for (let c = 0; c < count / 3; c++) {
        const i = r * (count / 3) + c;
        const input = makeInput(group, part, i, onEdit);
        cells.push(input);
        body.appendChild(input);
      }
    }
    return {
      cells,
      node: el(
        "div",
        { class: "cal-block" },
        el("div", { class: "cal-block-title" }, title, unitNode),
        body,
      ),
    };
  }

  function buildCards() {
    const fam = family();
    builtFamily = fam;
    cards.clear();
    edited.clear();
    shownRange.clear();

    if (!fam) {
      /* Nothing has said what this sensor is — not the page, not the dump.
         The three-state rule applies to the whole list rather than to one
         card: showing a Shimmer3R's six sensors on what might be a Shimmer3
         would offer two that do not exist. */
      const connected = !!getClient();
      sensorHost.replaceChildren(
        el(
          "div",
          { class: "card", dataset: { calRole: "unknownHardware" } },
          el("div", { class: "card-title" }, "Sensors"),
          el(
            "div",
            { class: connected ? "banner warn" : "banner" },
            connected
              ? "This sensor has not said what hardware it is, and no " +
                  "calibration has been read from it, so which sensors it " +
                  "carries is unknown. Read from sensor to find out — the " +
                  "dump names the hardware that wrote it."
              : "Which sensors appear here depends on the hardware. Connect a " +
                  "sensor, or load a saved dump — a dump names the hardware " +
                  "that wrote it.",
          ),
        ),
      );
      return;
    }

    const nodes = [];
    for (const row of SENSOR_ROWS[fam]) {
      const key = row.group ?? `id:${row.id}`;
      const ranges = rangesFor(row, fam);
      const groupDefaults = row.group
        ? sdk.getGroupDefaults(fam, row.group)
        : null;
      const sensitivityScale = groupDefaults?.sensitivityScale ?? 1;

      const statePill = el(
        "span",
        { class: "pill", dataset: { calState: key } },
        "not read",
      );
      const rangeSel = el("select", {
        dataset: { calRange: key },
        "aria-label": `${row.label} range`,
        onchange: () => onRangeChanged(key),
      });
      for (const [value, label] of ranges) {
        rangeSel.appendChild(
          el("option", { value: String(value) }, `${label} (${value})`),
        );
      }
      const asOf = el(
        "span",
        { class: "muted", dataset: { calAsOf: key } },
        "–",
      );
      const btnDefaults = el(
        "button",
        {
          type: "button",
          class: "secondary",
          dataset: { calDefaults: key },
          title:
            "Fill the boxes with the factory default calibration for this " +
            "sensor and range. Nothing is written until Write to sensor.",
        },
        "Restore defaults",
      );
      const errorNode = el("div", {
        class: "cal-error",
        dataset: { calError: key },
        hidden: true,
      });
      const noteNode = el("div", {
        class: "field-hint",
        dataset: { calNote: key },
      });

      const onEdit = () => onCellEdited(key);
      const unit = groupDefaults?.unit ?? "";
      const offsetGrid = row.group
        ? makeGrid(
            key,
            "offset",
            "Offset",
            el("span", { class: "cal-unit" }, "raw counts"),
            3,
            onEdit,
          )
        : null;
      const sensGrid = row.group
        ? makeGrid(
            key,
            "sens",
            "Sensitivity",
            el(
              "span",
              { class: "cal-unit" },
              unit ? `counts per ${unit}` : "counts per unit",
            ),
            3,
            onEdit,
          )
        : null;
      const alignGrid = row.group
        ? makeGrid(
            key,
            "align",
            "Alignment",
            el("span", { class: "cal-unit" }, "unitless, −1.28…1.27"),
            9,
            onEdit,
          )
        : null;

      const card = el(
        "div",
        {
          class: "card",
          dataset: {
            calSensor: key,
            calSensorId: String(row.id),
            calAvailability: row.unmodelled ? "disabled" : "editable",
          },
        },
        el(
          "div",
          { class: "card-title" },
          row.label,
          el("span", { class: "cal-chip" }, row.chip),
          statePill,
        ),
        row.unmodelled
          ? el(
              "div",
              { class: "banner", dataset: { calReason: key } },
              `The ${row.chip} calibration is a chip-specific coefficient ` +
                "block, not the offset / sensitivity / alignment set the " +
                "sensors above use, so this page shows that a calibration " +
                "exists but cannot edit it.",
            )
          : null,
        row.unmodelled
          ? null
          : el(
              "div",
              { class: "row" },
              el("label", { class: "cal-range" }, "Range", rangeSel),
              asOf,
              /* Pushed to the far end of the row rather than sitting next to
                 the range: it acts on the whole card, and a destructive-ish
                 button beside the selector reads as if it acted on the
                 selector. */
              el("span", { class: "cal-push" }),
              btnDefaults,
            ),
        row.unmodelled
          ? null
          : el(
              "div",
              { class: "cal-grids" },
              offsetGrid.node,
              sensGrid.node,
              alignGrid.node,
            ),
        errorNode,
        noteNode,
      );

      cards.set(key, {
        row,
        key,
        ranges,
        sensitivityScale,
        card,
        statePill,
        rangeSel,
        asOf,
        btnDefaults,
        errorNode,
        noteNode,
        cells: row.unmodelled
          ? null
          : {
              offset: offsetGrid.cells,
              sens: sensGrid.cells,
              align: alignGrid.cells,
            },
      });
      if (!row.unmodelled) shownRange.set(key, ranges[0][0]);
      btnDefaults.addEventListener("click", () => restoreDefaults(key));
      nodes.push(card);
    }
    sensorHost.replaceChildren(...nodes);
  }

  /** Rebuild the cards if what the page knows about the hardware has moved. */
  function ensureCards() {
    if (builtFamily !== family() || !cards.size) buildCards();
  }

  // -------------------------------------------------------------------------
  // Reading values into the cards
  // -------------------------------------------------------------------------

  const recordKey = (sensorId, range) => `${sensorId}:${range}`;
  const editKey = (key, range) => `${key}:${range}`;

  /**
   * The 21-byte block stored for this sensor at this range, or null.
   *
   * A block that is all-0xFF or all-zero counts as NOT stored, because that
   * is exactly what those two patterns mean (`UtilShimmer.isAllFF` /
   * `isAllZeros`, which is why `parseKinematicCalibBlock` answers null for
   * them). A record can exist and say nothing — a Shimmer3R ships with one
   * like that for its alternate magnetometer — and the difference between
   * "never calibrated" and "calibrated to 65535" is the whole point of
   * showing calibration at all.
   */
  function storedBlock(entry, range) {
    const usable = (block) =>
      block &&
      block.length >= BLOCK_BYTES &&
      sdk.parseKinematicCalibBlock(block, {
        sensitivityScale: entry.sensitivityScale,
      })
        ? block
        : null;
    if (store() === "infomem") {
      /* One block per sensor, for whatever range is configured. Showing it
         under another range would claim the device holds something it does
         not. */
      if (!infoMemShown) return null;
      if (range !== configuredRange(entry)) return null;
      return usable(infoMemShown[entry.row.group]);
    }
    return usable(records.get(recordKey(entry.row.id, range))?.calibBytes);
  }

  /** The dump record for this sensor at this range, or null. */
  function storedRecord(entry, range) {
    if (store() === "infomem") return null;
    return records.get(recordKey(entry.row.id, range)) ?? null;
  }

  /** The range the device is configured for, when the page said. */
  function configuredRange(entry) {
    const active = getActiveRanges();
    const v = active?.[entry.row.group];
    return Number.isFinite(v) ? Number(v) : null;
  }

  /** The SDK default calibration for this sensor at this range, or null. */
  function defaultsFor(entry, range) {
    if (!entry.row.group) return null;
    const fam = family();
    if (!fam) return null;
    return sdk.getDefaultCalibration(fam, entry.row.group, range);
  }

  /** The 21 bytes the SDK defaults encode to for this sensor and range. */
  function defaultBlock(entry, range) {
    const d = defaultsFor(entry, range);
    if (!d) return null;
    return sdk.generateKinematicCalibBlock(
      d.calibration.offset,
      d.calibration.sensitivity,
      d.calibration.alignment,
      { sensitivityScale: d.sensitivityScale },
    );
  }

  /** Strings for the boxes, from a parsed calibration. */
  function valuesFromCalibration(cal) {
    return {
      offset: cal.offset.map(num),
      sens: cal.sensitivity.map(num),
      align: cal.alignment.map(num),
    };
  }

  /** Strings for the boxes, from a stored 21-byte block, or null. */
  function valuesFromBlock(entry, block) {
    if (!block) return null;
    const cal = sdk.parseKinematicCalibBlock(block, {
      sensitivityScale: entry.sensitivityScale,
    });
    /* An all-0xFF or all-zero block parses to null: the SDK's way of saying
       "nothing stored". That is a state of its own — see `paintCard`. */
    return cal ? valuesFromCalibration(cal) : null;
  }

  /** What is in the boxes right now, as strings. */
  function readCells(entry) {
    return {
      offset: entry.cells.offset.map((i) => i.value),
      sens: entry.cells.sens.map((i) => i.value),
      align: entry.cells.align.map((i) => i.value),
    };
  }

  /** Put strings into the boxes; `null` empties them. */
  function writeCells(entry, values) {
    for (const part of ["offset", "sens", "align"]) {
      entry.cells[part].forEach((input, i) => {
        input.value = values ? (values[part][i] ?? "") : "";
      });
    }
  }

  /** Placeholders show the defaults when nothing is stored and nothing typed. */
  function setPlaceholders(entry, range) {
    const d = defaultsFor(entry, range);
    const values = d ? valuesFromCalibration(d.calibration) : null;
    for (const part of ["offset", "sens", "align"]) {
      entry.cells[part].forEach((input, i) => {
        input.placeholder = values ? (values[part][i] ?? "") : "";
      });
    }
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * What the record's 8-byte stamp says: a `Date`, `"none"` or `"unset"`.
   *
   * The three are genuinely different and none of them is the others:
   *
   *   a Date   the sensor's real-world clock when the calibration was stored
   *   "none"   an all-zero stamp — the firmware's mark for a calibration it
   *            seeded itself rather than one anybody measured
   *   "unset"  a stamp that decodes to a date nobody could have calibrated
   *            on, which happens when the sensor's clock had never been set:
   *            the tick count is then measured from boot and lands in 1970
   *
   * Note the unit. This is a 64-bit count of 32768 Hz ticks
   * (`RTC_getRwcTime()`, `Calibration/shimmer_calibration.c:1054`), NOT the
   * Unix seconds the SDK's `calibTsBytesToUnixSeconds` decodes for the
   * Verisense blob — reading it as seconds puts every calibration about 1.8
   * million years into the future.
   */
  function readStamp(ticks) {
    if (!ticks || ticks.length < 8) return "none";
    let v = 0;
    for (let i = 7; i >= 0; i--) v = v * 256 + (ticks[i] & 0xff);
    if (v === 0) return "none";
    const ms = (v / RTC_TICKS_PER_SECOND) * 1000;
    if (!Number.isFinite(ms) || ms < STAMP_MIN_MS || ms > STAMP_MAX_MS) {
      return "unset";
    }
    return new Date(ms);
  }

  function formatStamp(date) {
    const p2 = (n) => String(n).padStart(2, "0");
    return (
      `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} ` +
      `${p2(date.getHours())}:${p2(date.getMinutes())}`
    );
  }

  /**
   * The 21 bytes the boxes currently describe, or a list of problems.
   *
   * @returns {{bytes: Uint8Array}|{problems: {part: string, index: number,
   *   problem: string}[]}|{empty: true}}
   */
  function blockFromCells(entry) {
    return blockFromValues(entry, readCells(entry));
  }

  /**
   * The 21 bytes one set of typed strings describes.
   *
   * A card with every box empty is `{empty: true}` rather than fifteen "needs
   * a value" problems: nothing typed is not the same as something wrong, and
   * it is the state a never-calibrated sensor starts in.
   */
  function blockFromValues(entry, values) {
    const parts = ["offset", "sens", "align"];
    if (parts.every((p) => values[p].every((v) => String(v).trim() === ""))) {
      return { empty: true };
    }
    const problems = [];
    const nums = { offset: [], sens: [], align: [] };
    for (const part of parts) {
      values[part].forEach((raw, index) => {
        const r = checkValue(raw, part, entry.sensitivityScale);
        if (r.problem) problems.push({ part, index, problem: r.problem });
        else nums[part].push(r.value);
      });
    }
    if (problems.length) return { problems };
    return {
      bytes: sdk.generateKinematicCalibBlock(
        nums.offset,
        nums.sens,
        nums.align,
        { sensitivityScale: entry.sensitivityScale },
      ),
    };
  }

  /** Repaint one card from the store plus whatever is typed into it. */
  function paintCard(entry) {
    if (entry.row.unmodelled) {
      const rec =
        records.get(recordKey(entry.row.id, 0)) ?? firstRecordFor(entry.row.id);
      if (rec) {
        const stamp = readStamp(rec.timestampTicks);
        entry.statePill.textContent =
          stamp instanceof Date
            ? `stored ${formatStamp(stamp)}`
            : "stored, no date";
        entry.statePill.className = "pill";
        entry.noteNode.textContent = `${rec.calibLen} bytes at range ${rec.range}.`;
        entry.card.dataset.calState = "unmodelled";
      } else {
        entry.statePill.textContent = "no record";
        entry.statePill.className = "pill";
        entry.noteNode.textContent = "";
        entry.card.dataset.calState = "unmodelled";
      }
      return;
    }

    const range = shownRange.get(entry.key);
    const stored = storedBlock(entry, range);
    const def = defaultBlock(entry, range);
    const rec = storedRecord(entry, range);
    setPlaceholders(entry, range);

    const built = blockFromCells(entry);
    const typed = built.bytes ?? null;
    /* Empty boxes are never "dirty": there is nothing to write, so saying so
       would light up a Write that is refused. Emptying them is how a reader
       clears the editor and goes back to what the sensor holds. */
    const dirty = !!typed && !bytesEqual(typed, stored);

    // ---- the "as of" readout
    const stamp = rec ? readStamp(rec.timestampTicks) : "none";
    const date = stamp instanceof Date ? stamp : null;
    if (store() === "infomem") {
      entry.asOf.textContent = stored
        ? "no date — the configuration image stores no calibration date"
        : "";
    } else if (!stored) {
      entry.asOf.textContent = "";
    } else if (date) {
      entry.asOf.textContent = `as of ${formatStamp(date)}`;
    } else if (stamp === "unset") {
      entry.asOf.textContent =
        "date unreadable — the sensor's clock had not been set when this was stored";
    } else {
      entry.asOf.textContent = "no date — the firmware seeded this itself";
    }

    // ---- the state pill: never calibrated / defaults / this device's own
    let pill = "";
    let pillClass = "pill";
    let note = "";
    if (!stored) {
      pill = "never calibrated";
      pillClass = "pill warn";
      if (store() !== "infomem") {
        note =
          "Nothing is stored for this sensor at this range, so the sensor " +
          "falls back to the factory defaults shown greyed below. That is " +
          "not a fault — most sensors leave the factory with defaults for " +
          "every range but the one they were calibrated at.";
      } else {
        const cfg = configuredRange(entry);
        note =
          "The configuration image holds no calibration for this sensor" +
          (cfg !== null && range !== cfg
            ? " at this range — it stores one range at a time, and the sensor " +
              "is configured for another."
            : ".") +
          " The values shown greyed are the factory defaults it falls back to.";
      }
    } else if (def && bytesEqual(stored, def)) {
      pill = "factory defaults";
      note =
        "What is stored is byte-for-byte the factory default for this range, " +
        "so this sensor has no calibration of its own here.";
    } else if (date) {
      pill = `calibrated ${formatStamp(date)}`;
      pillClass = "pill on";
      note = "";
    } else {
      pill = "this sensor's own values, no date";
      pillClass = "pill on";
      note =
        store() === "infomem"
          ? "Values that are not the factory defaults. The configuration " +
            "image keeps no calibration date, so when they were measured is " +
            "not recorded there."
          : "Values that are not the factory defaults, but with no usable " +
            "calibration date — either seeded by the firmware or stored " +
            "while the sensor's clock had never been set.";
    }
    if (built.problems?.length) {
      pill = "value out of range";
      pillClass = "pill err";
    } else if (dirty) {
      pill = "edited, not written";
      pillClass = "pill warn";
    }
    entry.statePill.textContent = pill;
    entry.statePill.className = pillClass;

    // ---- validation
    const bad = new Map();
    for (const p of built.problems ?? []) bad.set(`${p.part}:${p.index}`, p);
    for (const part of ["offset", "sens", "align"]) {
      entry.cells[part].forEach((input, i) => {
        const p = bad.get(`${part}:${i}`);
        input.classList.toggle("bad", !!p);
        input.setAttribute("aria-invalid", p ? "true" : "false");
      });
    }
    if (built.problems?.length) {
      const first = built.problems[0];
      const partName =
        first.part === "sens"
          ? "Sensitivity"
          : first.part === "align"
            ? "Alignment"
            : "Offset";
      const where =
        first.part === "align"
          ? `row ${AXES[Math.floor(first.index / 3)]}, column ${AXES[first.index % 3]}`
          : AXES[first.index];
      entry.errorNode.textContent =
        `${partName} ${where}: ${first.problem}.` +
        (built.problems.length > 1
          ? built.problems.length === 2
            ? " One other value also needs attention."
            : ` ${built.problems.length - 1} other values also need attention.`
          : "") +
        " Nothing is written while a value is out of range.";
      entry.errorNode.hidden = false;
    } else {
      entry.errorNode.textContent = "";
      entry.errorNode.hidden = true;
    }
    entry.noteNode.textContent = note;
    entry.card.dataset.calDirty = dirty ? "true" : "false";
    entry.card.dataset.calState = built.problems?.length
      ? "invalid"
      : !stored
        ? "never"
        : def && bytesEqual(stored, def)
          ? "defaults"
          : "device";
  }

  /** The first record for a sensor id at any range, for the unmodelled cards. */
  function firstRecordFor(sensorId) {
    for (const rec of records.values())
      if (rec.sensorId === sensorId) return rec;
    return null;
  }

  /** Load the boxes for one card from the store or from an edit in progress. */
  function loadCard(entry) {
    if (entry.row.unmodelled) return;
    const range = shownRange.get(entry.key);
    const key = editKey(entry.key, range);
    if (edited.has(key)) writeCells(entry, edited.get(key));
    else writeCells(entry, valuesFromBlock(entry, storedBlock(entry, range)));
  }

  function onRangeChanged(key) {
    const entry = cards.get(key);
    if (!entry) return;
    /* Keep whatever is typed for the range being left, so flicking between
       ranges to compare them does not throw an edit away. */
    stashEdit(entry);
    shownRange.set(key, Number(entry.rangeSel.value));
    loadCard(entry);
    paintCard(entry);
    paintHeader();
  }

  function onCellEdited(key) {
    const entry = cards.get(key);
    if (!entry) return;
    stashEdit(entry);
    paintCard(entry);
    paintHeader();
  }

  /** Remember (or forget) what is typed for the range on screen. */
  function stashEdit(entry) {
    const range = shownRange.get(entry.key);
    const key = editKey(entry.key, range);
    const values = readCells(entry);
    const stored = valuesFromBlock(entry, storedBlock(entry, range));
    const same =
      stored &&
      ["offset", "sens", "align"].every((part) =>
        values[part].every((v, i) => String(v) === String(stored[part][i])),
      );
    const blank = ["offset", "sens", "align"].every((part) =>
      values[part].every((v) => String(v).trim() === ""),
    );
    if (same || (blank && !stored)) edited.delete(key);
    else edited.set(key, values);
  }

  // -------------------------------------------------------------------------
  // The header
  // -------------------------------------------------------------------------

  /**
   * Every sensor+range whose boxes now differ from what the store holds.
   *
   * @returns {{group: string, sensorId: number, range: number, label: string,
   *   was: Uint8Array|null, now: Uint8Array}[]}
   */
  function changes() {
    const out = [];
    for (const entry of cards.values()) {
      if (entry.row.unmodelled) continue;
      for (const [value] of entry.ranges) {
        const key = editKey(entry.key, value);
        if (!edited.has(key)) continue;
        const saved = edited.get(key);
        const isOnScreen = shownRange.get(entry.key) === value;
        const built = isOnScreen
          ? blockFromCells(entry)
          : blockFromValues(entry, saved);
        if (!built.bytes) continue;
        const was = storedBlock(entry, value);
        if (bytesEqual(built.bytes, was)) continue;
        out.push({
          group: entry.row.group,
          sensorId: entry.row.id,
          range: value,
          label: `${entry.row.label} (${entry.row.chip}) at ${rangeLabel(entry, value)}`,
          was: was ? Uint8Array.from(was) : null,
          now: built.bytes,
        });
      }
    }
    return out;
  }

  function rangeLabel(entry, value) {
    const found = entry.ranges.find(([v]) => v === value);
    return found ? found[1] : `range ${value}`;
  }

  /** Every validation problem on the page, as plain sentences. */
  function problems() {
    const out = [];
    for (const entry of cards.values()) {
      if (entry.row.unmodelled) continue;
      const built = blockFromCells(entry);
      for (const p of built.problems ?? []) {
        out.push(
          `${entry.row.label}: ${p.part} ${AXES[p.index % 3]} ${p.problem}`,
        );
      }
      for (const [value] of entry.ranges) {
        if (value === shownRange.get(entry.key)) continue;
        const key = editKey(entry.key, value);
        if (!edited.has(key)) continue;
        const b = blockFromValues(entry, edited.get(key));
        for (const p of b.problems ?? []) {
          out.push(
            `${entry.row.label} at ${rangeLabel(entry, value)}: ${p.part} ${AXES[p.index % 3]} ${p.problem}`,
          );
        }
      }
    }
    return out;
  }

  function paintHeader() {
    const which = store();
    const bad = problems();
    const changed = changes();

    storePill.textContent =
      which === "none"
        ? "not connected"
        : dumpBytes
          ? `${dumpBytes.length} bytes ${fromFile ? "loaded" : "read"}`
          : infoMemShown
            ? "read from the configuration image"
            : "not read";
    storePill.className = dumpBytes || infoMemShown ? "pill on" : "pill";

    if (which === "dump") {
      const v = dumpParsed?.version;
      storeBanner.className = "banner info";
      storeBanner.textContent =
        "This tab reads and writes the sensor's CALIBRATION DUMP — the store " +
        "that keeps one record per sensor and range, each with the date it " +
        "was calibrated. Write to sensor sends SET_CALIB_DUMP and then asks " +
        "the firmware to apply it." +
        (v
          ? ` The dump on this sensor was written by hardware id ${v.hardwareId}, firmware ${v.firmwareMajor}.${v.firmwareMinor}.${v.firmwareInternal}, and holds ${dumpParsed.records.length} record${dumpParsed.records.length === 1 ? "" : "s"}.`
          : "");
    } else if (which === "infomem") {
      storeBanner.className = "banner warn";
      storeBanner.textContent =
        "This link has no calibration-dump commands, so the values below come " +
        "from the CONFIGURATION IMAGE (InfoMem) instead — one block per " +
        "sensor, for the range configured right now, with no calibration " +
        "date. They are shown read-only: the configuration image belongs to " +
        "the Configure tab, which holds its own unsaved edits, and two " +
        "writers on one image would silently drop whichever change lost. " +
        "Connect over Bluetooth to change calibration.";
    } else {
      storeBanner.className = "banner";
      storeBanner.textContent =
        "Connect a sensor to read the calibration it holds.";
    }

    storeNote.textContent =
      which === "dump" && fromFile
        ? "These values came from a file on this host, not from the sensor. Nothing has been written yet."
        : "";

    if (bad.length) {
      changeNote.textContent =
        `${bad.length} value${bad.length === 1 ? "" : "s"} the calibration format cannot hold — ` +
        `${bad[0]}. Write is refused until every box is in range.`;
    } else if (changed.length) {
      changeNote.textContent =
        `${changed.length} calibration${changed.length === 1 ? "" : "s"} edited and not yet written: ` +
        changed.map((c) => c.label).join("; ") +
        ".";
    } else if (dumpBytes && !fromFile) {
      changeNote.textContent = "No changes since the dump was read.";
    } else {
      changeNote.textContent = "";
    }

    sync();
  }

  // -------------------------------------------------------------------------
  // Enablement
  // -------------------------------------------------------------------------

  function sync() {
    if (destroyed) return;
    const which = store();
    const live = enabled && !busy && !!getClient();
    const editable = which === "dump";
    btnRead.disabled = !live;
    btnSave.disabled = !dumpBytes;
    /* Loading a dump works with nothing connected — inspecting and editing a
       saved dump is half of what saving one is for. It is refused only on a
       link whose store is the configuration image, where a loaded dump would
       be values with nowhere to go. */
    btnLoad.disabled = busy || which === "infomem";
    btnWrite.disabled =
      !live ||
      !editable ||
      !dumpBytes ||
      problems().length > 0 ||
      changes().length === 0;

    /* A sensor that is connected but gated — sensing, or another panel
       holding the link — locks the boxes: an edit made now could not be
       written, and a box that accepts a value it cannot send is a lie. With
       NOTHING connected they stay open, because editing a dump loaded from a
       file and saving it back is half of what saving one is for. */
    const linkFree = !getClient() || enabled;
    for (const entry of cards.values()) {
      if (entry.row.unmodelled) continue;
      entry.rangeSel.disabled = busy || which === "none";
      entry.btnDefaults.disabled = busy || !editable || !linkFree;
      for (const part of ["offset", "sens", "align"]) {
        for (const input of entry.cells[part]) {
          input.disabled = busy || !editable || !linkFree;
          input.readOnly = !editable;
        }
      }
      entry.card.dataset.calAvailability = editable ? "editable" : "readonly";
    }
  }

  function setBusy(next) {
    if (busy === next) return;
    busy = next;
    sync();
    try {
      opts.onBusyChange?.(next);
    } catch (err) {
      log.warn(`calibration busy handler failed: ${err?.message ?? err}`);
    }
  }

  /**
   * The connected client, or null with the reason logged.
   *
   * Same shape as the device-naming panel's: a refusal that names what was
   * being attempted reads far better than a button that does nothing.
   */
  function clientFor(what) {
    const client = getClient();
    if (!client) {
      log.warn(`Connect a sensor before ${what}.`);
      return null;
    }
    if (!enabled) {
      log.warn(
        `Not ${what}: calibration cannot be reached over this link right now.`,
      );
      return null;
    }
    if (busy) {
      log.warn("A calibration operation is already running.");
      return null;
    }
    return client;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Index the parsed dump by sensor and range. */
  function indexRecords() {
    records = new Map();
    for (const rec of dumpParsed?.records ?? []) {
      records.set(recordKey(rec.sensorId, rec.range), rec);
    }
  }

  /**
   * Open each card on the range worth looking at first: the one the sensor is
   * configured for when it holds a record, else any range that holds one, else
   * the configured range, else the group's own fallback.
   */
  function chooseRanges() {
    for (const entry of cards.values()) {
      if (entry.row.unmodelled) continue;
      const configured = configuredRange(entry);
      const withRecord = entry.ranges
        .map(([v]) => v)
        .filter((v) => !!storedBlock(entry, v));
      let pick;
      if (configured !== null && withRecord.includes(configured))
        pick = configured;
      else if (withRecord.length) pick = withRecord[0];
      else if (
        configured !== null &&
        entry.ranges.some(([v]) => v === configured)
      )
        pick = configured;
      else {
        const g = entry.row.group
          ? sdk.getGroupDefaults(family(), entry.row.group)
          : null;
        pick =
          g && entry.ranges.some(([v]) => v === g.fallbackRange)
            ? g.fallbackRange
            : entry.ranges[0][0];
      }
      shownRange.set(entry.key, pick);
      entry.rangeSel.value = String(pick);
    }
  }

  function repaintAll() {
    ensureCards();
    chooseRanges();
    for (const entry of cards.values()) {
      loadCard(entry);
      paintCard(entry);
    }
    paintHeader();
  }

  /**
   * Read the calibration the sensor holds and show it.
   *
   * @returns {Promise<object|null>} the parsed dump (or the InfoMem blocks) or
   *   null on failure
   */
  async function read() {
    const which = store();
    if (which === "infomem") return readInfoMemFallback();
    const client = clientFor("reading its calibration");
    if (!client) return null;
    setBusy(true);
    try {
      log.log("reading the calibration dump (GET_CALIB_DUMP, 128-byte pages)…");
      const { bytes, dump } = await client.readCalibDump();
      adopt(bytes, dump, false);
      log.log(
        `calibration dump: ${bytes.length} bytes, ${dump.records.length} record(s) — ` +
          (dump.records.length
            ? dump.records
                .map((r) => `${sensorName(r.sensorId)} range ${r.range}`)
                .join(", ")
            : "none"),
      );
      return dump;
    } catch (err) {
      const message = `Reading the calibration failed: ${err?.message ?? err}`;
      log.error(message);
      toast(message, "err");
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** The read-only path: the six InfoMem blocks the page already holds. */
  async function readInfoMemFallback() {
    const client = clientFor("reading its calibration");
    if (!client) return null;
    setBusy(true);
    try {
      if (typeof opts.readInfoMem === "function") {
        log.log(
          "this link has no calibration-dump commands — reading the calibration blocks out of the configuration image instead…",
        );
        await opts.readInfoMem();
      }
      infoMemShown = getInfoMemBlocks();
      if (!infoMemShown) {
        const message =
          "The configuration image could not be read, so there is no calibration to show.";
        log.error(message);
        toast(message, "err");
        return null;
      }
      dumpBytes = null;
      dumpParsed = null;
      records = new Map();
      fromFile = false;
      repaintAll();
      log.log("calibration read from the configuration image (read-only here)");
      return infoMemShown;
    } catch (err) {
      const message = `Reading the calibration failed: ${err?.message ?? err}`;
      log.error(message);
      toast(message, "err");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function adopt(bytes, dump, loaded) {
    dumpBytes = Uint8Array.from(bytes);
    dumpParsed = dump;
    fromFile = !!loaded;
    infoMemShown = null;
    indexRecords();
    edited.clear();
    repaintAll();
  }

  function sensorName(id) {
    for (const rows of Object.values(SENSOR_ROWS)) {
      const row = rows.find((r) => r.id === id);
      if (row) return `${row.label} (${row.chip})`;
    }
    return `sensor id ${id}`;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /** The dump bytes the edits describe, or null when there is nothing to send. */
  function buildDump() {
    if (!dumpParsed) return null;
    const changed = changes();
    if (!changed.length) return null;
    /* Every record the device sent, in the order it sent them, with the
       edited ones replaced and any brand-new sensor+range appended. Rewriting
       the whole dump is not a choice: SET_CALIB_DUMP takes the total length
       from the first chunk and counts forward, so a partial write is a
       different dump, not a patch. */
    const out = dumpParsed.records.map((r) => ({
      sensorId: r.sensorId,
      range: r.range,
      calibLen: r.calibLen,
      timestampTicks: Uint8Array.from(r.timestampTicks),
      calibBytes: Uint8Array.from(r.calibBytes),
      isDefault: r.isDefault,
    }));
    const stamp = hostStamp();
    for (const c of changed) {
      const found = out.find(
        (r) => r.sensorId === c.sensorId && r.range === c.range,
      );
      if (found) {
        found.calibBytes = c.now;
        found.calibLen = c.now.length;
        found.timestampTicks = stamp;
        found.isDefault = false;
      } else {
        out.push({
          sensorId: c.sensorId,
          range: c.range,
          calibLen: c.now.length,
          timestampTicks: stamp,
          calibBytes: c.now,
          isDefault: false,
        });
      }
    }
    return sdk.generateCalibDump(dumpParsed.version, out);
  }

  /**
   * Now, as the 8-byte tick stamp the firmware writes.
   *
   * Local civil time rather than UTC, deliberately: the device's real-world
   * clock is local civil time (DEV-900), so a UTC stamp here would read back
   * an hour or more out against every other date the sensor produces.
   */
  function hostStamp() {
    const nowMs = Date.now() - new Date().getTimezoneOffset() * 60000;
    let ticks = BigInt(Math.round((nowMs / 1000) * RTC_TICKS_PER_SECOND));
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      out[i] = Number(ticks & 0xffn);
      ticks >>= 8n;
    }
    return out;
  }

  /**
   * Write the edits to the sensor, then read the dump back and byte-compare.
   *
   * @returns {Promise<boolean>} true when the write verified
   */
  async function write() {
    if (store() !== "dump") {
      log.warn(
        "Not writing: this link has no calibration-dump commands, and this tab does not write the configuration image.",
      );
      return false;
    }
    const client = clientFor("writing its calibration");
    if (!client) return false;

    const bad = problems();
    if (bad.length) {
      const message = `Not writing: ${bad.length} value${bad.length === 1 ? "" : "s"} the calibration format cannot hold (${bad[0]}).`;
      log.error(message);
      toast(message, "err");
      return false;
    }
    const changed = changes();
    if (!changed.length) {
      log.warn("Nothing to write — no calibration value has been changed.");
      return false;
    }
    const bytes = buildDump();
    if (!bytes) return false;

    if (!ask(buildConfirmation(changed, bytes))) {
      log.log("calibration write cancelled");
      return false;
    }

    setBusy(true);
    try {
      log.log(
        `writing the calibration dump (${bytes.length} bytes, ${changed.length} changed record(s)) with SET_CALIB_DUMP, then UPD_CALIB_DUMP…`,
      );
      await client.writeCalibDump(bytes);
      /* Read back and compare, like every other write on these pages. The
         dump is small and the read is paged at 128 bytes, so this costs two
         round trips and is the only thing that proves the sensor took it. */
      const back = await client.readCalibDump();
      const same = bytesEqual(bytes, back.bytes);
      adopt(back.bytes, back.dump, false);
      if (same) {
        log.log(
          "calibration written and verified — the dump read back byte-identical",
        );
        toast("Calibration written and verified", "ok");
        return true;
      }
      const at = firstDifference(bytes, back.bytes);
      const message =
        `The calibration read back differently from what was written` +
        (at >= 0
          ? ` (first difference at byte ${at})`
          : ` (${bytes.length} bytes out, ${back.bytes.length} back)`) +
        ". The sensor may have rebuilt its dump from the configuration bytes.";
      log.error(message);
      toast(message, "err");
      return false;
    } catch (err) {
      const message = `Writing the calibration failed: ${err?.message ?? err}`;
      log.error(message);
      toast(message, "err");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function firstDifference(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
  }

  /** What the confirmation shows: the store, and every value that moves. */
  function buildConfirmation(changed, bytes) {
    const lines = changed.map((c) => {
      const entry = cards.get(c.group);
      const before = c.was
        ? describeBlock(entry, c.was)
        : "nothing stored (the sensor was using the factory defaults)";
      return `  ${c.label}\n      was  ${before}\n      now  ${describeBlock(entry, c.now)}`;
    });
    return (
      `Write calibration to the sensor's CALIBRATION DUMP?\n\n` +
      `${changed.length} record${changed.length === 1 ? "" : "s"} change; the whole ${bytes.length}-byte dump is rewritten ` +
      `because the firmware takes the dump's length from the first chunk.\n\n` +
      `${lines.join("\n")}\n\n` +
      `The changed records are stamped with this host's clock.\n\n` +
      `NOTE: writing a configuration image afterwards makes the firmware rebuild ` +
      `the dump from the configuration bytes, which discards this. Apply a ` +
      `configuration first, then write calibration.`
    );
  }

  function describeBlock(entry, block) {
    const cal = sdk.parseKinematicCalibBlock(block, {
      sensitivityScale: entry?.sensitivityScale ?? 1,
    });
    if (!cal) return "an empty block";
    return (
      `offset [${cal.offset.map(num).join(", ")}]  ` +
      `sensitivity [${cal.sensitivity.map(num).join(", ")}]  ` +
      `alignment [${cal.alignment.map(num).join(", ")}]`
    );
  }

  // -------------------------------------------------------------------------
  // Defaults, save and load
  // -------------------------------------------------------------------------

  /**
   * Fill one sensor's boxes with the SDK's factory defaults for the range on
   * screen. Nothing is sent; the user still has to Write.
   *
   * @returns {boolean} true when defaults for that sensor and range exist
   */
  function restoreDefaults(group) {
    const entry = cards.get(group);
    if (!entry || entry.row.unmodelled) return false;
    const range = shownRange.get(entry.key);
    const d = defaultsFor(entry, range);
    if (!d) {
      log.warn(
        `No factory default calibration is known for ${entry.row.label} at ${rangeLabel(entry, range)}.`,
      );
      return false;
    }
    writeCells(entry, valuesFromCalibration(d.calibration));
    stashEdit(entry);
    paintCard(entry);
    paintHeader();
    log.log(
      `${entry.row.label}: boxes filled with the factory defaults for ${rangeLabel(entry, range)} — not written yet`,
    );
    return true;
  }

  /**
   * Save the dump to a file — the edits included.
   *
   * Deliberately what is ON SCREEN rather than what was read: a file that
   * silently dropped the edits above it would be the one thing on this page
   * that did not mean what it showed.
   */
  function save() {
    if (!dumpBytes) return false;
    const edits = problems().length ? null : buildDump();
    const bytes = edits ?? dumpBytes;
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    downloadBlob(
      `${getFilePrefix() ?? "shimmer"}-calibration-${stamp}.bin`,
      new Blob([bytes], { type: "application/octet-stream" }),
    );
    log.log(
      `calibration dump saved (${bytes.length} bytes${edits ? ", including the edits on screen" : ""})`,
    );
    return true;
  }

  /** Adopt a dump from a file. */
  function load(bytes) {
    try {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const dump = sdk.parseCalibDump(u8);
      if (!dump.records.length) {
        toast(
          "That file parsed as a calibration dump but holds no records.",
          "warn",
        );
      }
      adopt(u8, dump, true);
      log.log(
        `calibration dump loaded from a file: ${u8.length} bytes, ${dump.records.length} record(s)`,
      );
      return true;
    } catch (err) {
      const message = `That file is not a calibration dump: ${err?.message ?? err}`;
      log.error(message);
      toast(message, "err");
      return false;
    }
  }

  async function onFilePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    load(new Uint8Array(await file.arrayBuffer()));
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  btnRead.addEventListener("click", () => {
    read().catch(() => {});
  });
  btnWrite.addEventListener("click", () => {
    write().catch(() => {});
  });
  btnSave.addEventListener("click", () => save());
  btnLoad.addEventListener("click", () => fileInput.click());

  buildCards();
  paintHeader();

  return {
    read,
    write,
    save,
    load,
    restoreDefaults,
    dump: () => dumpParsed,
    bytes: () => (dumpBytes ? Uint8Array.from(dumpBytes) : null),
    store,
    family,
    changes,
    problems,
    setEnabled(next) {
      const was = enabled;
      enabled = !!next;
      /* Cleared when the LINK has gone, not merely when the panel has been
         gated: keeping the last sensor's values would let the next one be
         judged calibrated on numbers that were never its own, but throwing
         away a read because somebody started a stream would be losing work
         for nothing. (The device-naming panel clears on every falling edge;
         it can afford to, because a name is two round trips to read again.
         A dump is a paged read and a screen of numbers.)
         This runs on every re-gate, so it must not fire while already
         disabled or it would wipe the panel continuously.
         NOTE for the host page: do NOT fold this panel's own busy state back
         into what you pass here, or the read-back that follows a write clears
         the values the write just verified. */
      if (was && !enabled && !getClient()) {
        dumpBytes = null;
        dumpParsed = null;
        records = new Map();
        infoMemShown = null;
        fromFile = false;
        edited.clear();
        repaintAll();
        return;
      }
      /* A new link can mean new hardware, and the cards are built per family. */
      ensureCards();
      paintHeader();
    },
    destroy() {
      destroyed = true;
      host.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accept a value or a getter for it, and always return a getter. */
function asGetter(value) {
  return typeof value === "function" ? value : () => value ?? null;
}

/**
 * The API shape, with every operation refusing, for an SDK bundle that has no
 * calibration support. A host page then gates and mounts exactly as it always
 * does and gets a message on screen instead of a thrown import.
 */
function inertPanel() {
  return {
    read: async () => null,
    write: async () => false,
    save: () => false,
    load: () => false,
    restoreDefaults: () => false,
    dump: () => null,
    bytes: () => null,
    store: () => "none",
    family: () => null,
    changes: () => [],
    problems: () => [],
    setEnabled() {},
    destroy() {},
  };
}
