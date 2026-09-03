/**
 * Shimmer3 / Shimmer3R glue between the SDK's declarative InfoMem field
 * schema and a page that renders it with `common/config-form.js`.
 *
 * The generic form knows nothing about Shimmer3: it renders whatever fields
 * it is given and edits bytes. Everything that is specific to this device
 * family — which capabilities a client actually has, which settings ALSO have
 * an immediate-effect Bluetooth setter, the order the firmware needs a config
 * write performed in, the ExG mode presets, and the friendly sensor grouping
 * — lives here, in one module, so a page is left with layout and wiring.
 *
 * NO OPTION TABLES LIVE HERE. The value/label pairs (accel ranges, mag rates,
 * GSR ranges, baud rates …) are currently inline in the SDK's
 * `devices/infomem/schema.ts` behind a `TODO(next PR)` that moves them to
 * `devices/shimmer3/sensorOptions.ts`. They are transcribed there from the
 * Java `Listof…ConfigValues` pairs with a citation per table. Duplicating any
 * of them here would create a second, silently divergent source of truth for
 * what a register code means, so this module deliberately holds none and the
 * page takes them from the schema it already has.
 *
 * Nothing here touches `document`, and nothing here imports the SDK: a client
 * object is passed in and feature-detected.
 *
 *   import {
 *     describeShimmer3Caps, LIVE_OVERLAYS, buildApplyPlan, EXG_MODES,
 *     SENSOR_GROUPS,
 *   } from "../common/shimmer3-config-schema.js";
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What the connected client can actually do, feature-detected.
 *
 * Detected from the client object rather than from a firmware version table
 * because the SDK is the thing that gained (or has not yet gained) each
 * method: a page vendored against an older bundle then degrades to a greyed
 * control with a reason, instead of throwing when the user presses it.
 *
 * The keys are exactly the `data-cap` values `createGate` in `ui-chrome.js`
 * consumes, so a page tags a control once in the markup and never gates it
 * again in JS:
 *
 *   <button data-requires="idle" data-cap="infomem">Read configuration</button>
 *
 * ONE KEY HERE IS ONLY HALF THE ANSWER. `sdTransfer` reports that this client
 * and this link CAN carry SD file transfer; it cannot report whether the
 * connected firmware transfers files intact, because that needs a firmware
 * version read and this function is synchronous. A caller that offers a
 * download must narrow it afterwards with the client's own asynchronous gate:
 *
 *   caps.sdTransfer = caps.sdTransfer && (await client.supportsSdTransfer());
 *
 * v1.01.009 and v1.01.010 speak the protocol and corrupt every block, so
 * skipping that step hands the user silently wrong data.
 *
 * @param {object|null} client a Shimmer3Client / Shimmer3RClient / wired client
 * @param {"ble"|"rfcomm"|"usb"|string} [mode] the link the client is on
 * @returns {{
 *   stream: boolean, sdbt: boolean, infomem: boolean, sdlog: boolean,
 *   calib: boolean, calibration: boolean, rtc: boolean, ranges: boolean,
 *   exg: boolean, sensors: boolean, battery: boolean, status: boolean,
 *   sdTransfer: boolean, branding: boolean,
 * }}
 */
export function describeShimmer3Caps(client, mode) {
  const has = (name) => typeof client?.[name] === "function";

  // The dock/wired client carries the whole 384-byte image in one call
  // (readInfoMemBytes); the radio clients expose the paged primitive
  // (readInfoMem(address, length)) and the page assembles the three pages.
  // Either is enough to drive the form, so accept both.
  const infomemRead = has("readInfoMemBytes") || has("readInfoMem");
  const infomemWrite = has("writeInfoMemBytes") || has("writeInfoMem");

  return {
    // Streaming is radio-only: the wired dock link is a configuration and
    // file-transfer channel, it does not carry a sample stream.
    stream: has("startStreaming") && mode !== "usb",
    sdbt: has("startStreamingAndLogging") && mode !== "usb",
    infomem: infomemRead && infomemWrite,
    // The 0x9C SD-header rebuild. A separate capability from `infomem`
    // because an older bundle can read and write the image without being able
    // to ask the firmware to regenerate the card's configuration file.
    sdlog: has("updateSdLogConfig"),
    calib: has("readCalibration"),
    /* The whole-dump calibration path: the store that keeps a record per
       sensor AND range, each with the date it was taken, which is what
       `common/calibration-editor.js` edits. Both commands are required, not
       just the read — a page that could read the dump but not write it would
       offer an editor with nowhere to send the result. UPD_CALIB_DUMP (0x9B)
       is deliberately NOT part of the gate: `writeCalibDump` issues it itself
       unless asked not to, so the panel never calls it directly, and naming
       it here would disable the editor on a bundle that applies the dump
       without exposing the step as its own method.
       Deliberately NOT link-gated. It is method detection that decides this
       one: the dock/USB client and the classic `Shimmer3Client` genuinely do
       not carry these commands, so the panel falls back to showing the
       InfoMem calibration blocks read-only there — and naming a link would
       claim the reason is the protocol when it is the client. */
    calibration: has("readCalibDump") && has("writeCalibDump"),
    rtc: has("setRtcTime") && has("getRtcTime"),
    ranges: has("setWrAccelRange") && has("setGyroRange"),
    exg: has("enableEMG16Bit") && has("enableECG16Bit"),
    sensors: has("setSensors"),
    battery: has("readBattery") || has("getBattery"),
    status: has("readStatus") || has("getStatus"),
    /* SD file transfer, and radio-only for the same reason streaming is: the
       Shimmer3R's USB-C port speaks the DOCK protocol, which has no
       SD_LIST_DIR/SD_FILE_READ at all — the wired client therefore does not
       carry these methods either, but naming the link keeps the reason
       visible rather than making it an accident of feature detection. */
    sdTransfer: has("sdListDir") && has("sdReadFileWindow") && mode !== "usb",
    /* The expansion-board EEPROM, which is where the brand record lives — the
       names a sensor advertises over classic Bluetooth and BLE, and presents
       over USB. Deliberately NOT link-gated, unlike `sdTransfer` and
       `stream`: every client carries these two calls and every link reaches
       the same EEPROM, because the dock protocol has a daughter-card memory
       property of its own (`UART_PROP.DAUGHTER_CARD.CARD_MEM`) that takes the
       same host offsets. A docked sensor is in fact the easiest one to
       rebrand — no pairing needed. */
    branding: has("readDaughterCardMem") && has("writeDaughterCardMem"),
  };
}

// ---------------------------------------------------------------------------
// Live overlays
// ---------------------------------------------------------------------------

/**
 * Settings that exist BOTH in the InfoMem and as an immediate-effect
 * Bluetooth setter, keyed by the schema field's `configKey`.
 *
 * Writing the InfoMem alone is not enough for these: the running firmware
 * holds its own copy of the sampling rate, sensor bitmap and sensor ranges,
 * and only reloads them from the InfoMem on a reboot. A page that wrote the
 * image and then started streaming would stream at the OLD rate. So after the
 * image is written, the dirty subset that appears here is replayed through the
 * corresponding setter — the "live overlay" over the stored configuration.
 *
 * `arg(value)` adapts the schema's stored encoding to what the setter wants.
 * The only one that is not the identity is `samplingRateHz`: the InfoMem
 * stores the 32768 Hz divider, `setSamplingRate` takes hertz.
 *
 * ONE KEY HERE IS NOT A SCHEMA FIELD. `enabledSensors` has no entry in the
 * InfoMem field schema on purpose — the schema's scope note excludes the
 * Sensors0-4 bitmaps, because they are per-channel enable maps rather than
 * scalar settings and get their own checkbox grid ({@link SENSOR_GROUPS}). So
 * the form's dirty set can never contain it: the page's sensor grid must pass
 * `sensorsChanged: true` to {@link buildApplyPlan}, or add the key to the
 * dirty list itself. Every other key here is a real `configKey`.
 *
 * @type {Readonly<Record<string, {method: string, arg: (v: number) => number,
 *   label: string}>>}
 */
export const LIVE_OVERLAYS = Object.freeze({
  samplingRateHz: {
    method: "setSamplingRate",
    // The stored value is the divider (32768 / divider = Hz); the setter takes
    // hertz and re-derives the divider itself. Guard against a zero divider
    // rather than handing the setter Infinity.
    arg: (v) => (v > 0 ? 32768 / v : 0),
    label: "sampling rate",
  },
  enabledSensors: {
    method: "setSensors",
    arg: (v) => v,
    label: "enabled sensors",
  },
  "imu.wrAccelRange": {
    method: "setWrAccelRange",
    arg: (v) => v,
    label: "wide-range accel range",
  },
  "imu.gyroRange": {
    method: "setGyroRange",
    arg: (v) => v,
    label: "gyro range",
  },
  gsrRange: {
    method: "setGSRRange",
    arg: (v) => v,
    label: "GSR range",
  },
  expPowerEnabled: {
    method: "setInternalExpPower",
    arg: (v) => (v ? 1 : 0),
    label: "expansion-board power",
  },
});

/**
 * Order the live setters must run in. Later entries depend on earlier ones
 * having already been applied:
 *
 *   sensors       first, because it decides which channels exist at all, and
 *                 because the ExG helper below reads the current bitmap and
 *                 ORs its own bits into it
 *   sampling rate next, because the ExG oversampling ratio is DERIVED from it
 *   ranges        then, since a range only means anything for a sensor that
 *                 is enabled
 *   exp power     last of the plain setters — it switches a rail, so it is the
 *                 one most worth doing once everything else has settled
 */
const LIVE_ORDER = Object.freeze([
  "enabledSensors",
  "samplingRateHz",
  "imu.wrAccelRange",
  "imu.gyroRange",
  "gsrRange",
  "expPowerEnabled",
]);

// ---------------------------------------------------------------------------
// ExG mode presets
// ---------------------------------------------------------------------------

/**
 * The ExG configurations the SDK can install, as a single-choice preset.
 *
 * The ADS1292R register banks are 10 opaque bytes per chip. The schema
 * surfaces them as raw fields so they survive round-trip, but nobody
 * configures an ExG front end by typing register values: the SDK ships three
 * known-good banks and this list is the control that picks one.
 *
 * Choosing a mode also changes the sensor bitmap — `_writeExgPages` ORs
 * SENSOR_EXG1_16BIT | SENSOR_EXG2_16BIT into the current mask and calls
 * `setSensors` itself. That is why the ExG bits are excluded from
 * {@link SENSOR_GROUPS}: two controls owning the same bits would fight.
 *
 * `off` has no method — it means "leave the register banks alone", which is
 * what the raw ExG fields in the form are for.
 *
 * @type {readonly {id: string, label: string, method: string|null}[]}
 */
export const EXG_MODES = Object.freeze([
  { id: "off", label: "Leave ExG registers as stored", method: null },
  { id: "emg16", label: "EMG, 16-bit", method: "enableEMG16Bit" },
  { id: "ecg16", label: "ECG, 16-bit", method: "enableECG16Bit" },
  {
    id: "test16",
    label: "Test signal, 16-bit",
    method: "enableEXGTestSignal16Bit",
  },
]);

// ---------------------------------------------------------------------------
// Sensor grouping
// ---------------------------------------------------------------------------

/**
 * `SensorBitmapShimmer3` keys arranged for a checkbox grid.
 *
 * The bitmap itself is the SDK's; only the grouping and the wording are here.
 * A page reads the numeric masks from `SensorBitmapShimmer3` and uses these
 * lists purely for layout, so a bit that is added to the SDK and not to this
 * table simply does not get a checkbox — it never gets a wrong one.
 *
 * The four ExG bits (SENSOR_EXG1/2_16BIT, SENSOR_EXG1/2_24BIT) are
 * deliberately absent: {@link EXG_MODES} owns them (see above).
 *
 * @type {readonly {id: string, title: string, keys: readonly string[]}[]}
 */
export const SENSOR_GROUPS = Object.freeze([
  {
    id: "inertial",
    title: "Inertial",
    keys: [
      "SENSOR_A_ACCEL",
      "SENSOR_D_ACCEL",
      "SENSOR_ACCEL_ALT",
      "SENSOR_GYRO",
      "SENSOR_MAG",
      "SENSOR_MAG_ALT",
    ],
  },
  {
    id: "environment",
    title: "Environment and power",
    keys: ["SENSOR_PRESSURE", "SENSOR_VBATT"],
  },
  {
    id: "bio",
    title: "Biophysical",
    keys: ["SENSOR_GSR", "SENSOR_BRIDGE_AMP"],
  },
  {
    id: "external",
    title: "External ADC (expansion connector)",
    keys: ["SENSOR_EXT_A0", "SENSOR_EXT_A1", "SENSOR_EXT_A2"],
  },
  {
    id: "internal",
    title: "Internal ADC",
    keys: ["SENSOR_INT_A0", "SENSOR_INT_A1", "SENSOR_INT_A2", "SENSOR_INT_A3"],
  },
]);

/** Friendly label per bitmap key, for the checkbox next to it. */
export const SENSOR_LABELS = Object.freeze({
  SENSOR_A_ACCEL: "Low-noise accelerometer",
  SENSOR_D_ACCEL: "Wide-range accelerometer",
  SENSOR_ACCEL_ALT: "Alt accelerometer (high-g)",
  SENSOR_GYRO: "Gyroscope",
  SENSOR_MAG: "Magnetometer",
  SENSOR_MAG_ALT: "Alt magnetometer",
  SENSOR_PRESSURE: "Pressure / temperature",
  SENSOR_VBATT: "Battery voltage",
  SENSOR_GSR: "GSR",
  SENSOR_BRIDGE_AMP: "Bridge amplifier",
  SENSOR_EXT_A0: "External ADC A0",
  SENSOR_EXT_A1: "External ADC A1",
  SENSOR_EXT_A2: "External ADC A2",
  SENSOR_INT_A0: "Internal ADC A0",
  SENSOR_INT_A1: "Internal ADC A1",
  SENSOR_INT_A2: "Internal ADC A2",
  SENSOR_INT_A3: "Internal ADC A3",
});

// ---------------------------------------------------------------------------
// Apply plan
// ---------------------------------------------------------------------------

/*
 * Step names are the SDK client's own method names, so a caller dispatches on
 * them directly (`await client[step]()`) instead of maintaining a second
 * lookup table that can drift from this list.
 *
 * The two InfoMem steps name the WHOLE-IMAGE methods, because the working
 * document is the whole 384-byte image. A bundle old enough to expose only the
 * paged `readInfoMem(address, length)` / `writeInfoMem(address, data)`
 * primitives has no `readInfoMemBytes`, so `describeShimmer3Caps` reports
 * `infomem` from the paged pair and the page assembles the three pages itself
 * — the step name then reads as the operation, not as a callable method.
 *
 * `updateSdLogConfig` is command 0x9C (`UPD_SDLOG_CFG_COMMAND`), which makes
 * the firmware regenerate the SD configuration file from the config bytes it
 * has just been given. `exgMode` is the only name here that is NOT a client
 * method: the ExG preset picks one of {@link EXG_MODES}, whose `method` field
 * carries the actual helper to call.
 */
const STEP_INFOMEM = "writeInfoMemBytes";
const STEP_SDLOG = "updateSdLogConfig";
const STEP_EXG = "exgMode";
const STEP_INQUIRY = "inquiry";
const STEP_REREAD = "readInfoMemBytes";

/**
 * Turn a set of dirty field keys into the ordered list of operations that
 * actually applies them to a sensor.
 *
 * ORDER IS NOT COSMETIC — every step below is placed where the firmware needs
 * it (verified against `log-and-stream-common`):
 *
 *  1. `writeInfoMem` — the whole 384-byte image, page by page
 *     (SET_INFOMEM_COMMAND 0x8C). This is the stored configuration, the one
 *     that survives a reboot and that the SD header is built from.
 *  2. `updateSdLogConfig` — 0x9C. `ShimBt_processGeneralCmd` answers it with
 *     `ShimTask_set(TASK_SDLOG_CFG_UPDATE)` (shimmer_bt_uart.c:1099-1103), so
 *     the firmware rewrites the SD header from the bytes just written. Always
 *     run when the client has the method (it is harmless when nothing the
 *     header carries changed), and dropped when it does not.
 *  3. the live setters, in {@link LIVE_ORDER} — sensors, then sampling rate,
 *     then ranges, then expansion power. These overwrite the RUNNING config;
 *     without them the stored image and the streaming behaviour disagree
 *     until the next reboot.
 *  4. `exgMode` LAST of the setters, because `_writeExgPages` derives the
 *     ADS1292R oversampling ratio from `client.samplingRateHz`
 *     (getOversamplingRatioADS1292R) and then ORs the ExG bits into the
 *     current sensor mask. Run before the rate is set and it bakes in the old
 *     rate's ratio; run before `setSensors` and its bits are overwritten.
 *  5. `inquiry` then a fresh InfoMem read — so the page's channel schema and
 *     its baseline image both come from the device rather than from what the
 *     page believes it wrote.
 *
 * SET COMMANDS ARE NACKED WHILE SENSING. `ShimBt_processPacket` blocks every
 * command in `ShimBt_isCmdBlockedWhileSensing` while `shimmerStatus.sensing`
 * is set (shimmer_bt_uart.c:770-771), and that list contains SET_INFOMEM
 * (0x8C), UPD_SDLOG_CFG (0x9C), SET_SENSORS (0x08), SET_SAMPLING_RATE (0x05),
 * every range setter and SET_EXG_REGS (0x61) — i.e. every step of this plan.
 * So a plan built while the sensor is streaming or logging comes back
 * `blocked` with a reason instead of throwing: the caller shows the reason and
 * disables the Apply button, which is a better answer than a run that NACKs
 * halfway and leaves the stored and running configurations disagreeing.
 *
 * @param {readonly string[]} dirtyKeys schema field `configKey`s that changed
 *   (the form's `dirtyKeys()` returns field KEYS; map them through
 *   `field.configKey` before calling this)
 * @param {object} ctx
 * @param {Record<string, boolean>} [ctx.caps] from {@link describeShimmer3Caps}
 * @param {"ble"|"rfcomm"|"usb"|string} [ctx.mode]
 * @param {boolean} [ctx.streaming] sensor is streaming right now
 * @param {boolean} [ctx.recording] sensor is logging to the card right now
 * @param {boolean} [ctx.exgModeChanged] the ExG preset control was changed
 * @param {boolean} [ctx.sensorsChanged] the sensor checkbox grid was changed.
 *   Needed as its own flag because the sensor bitmap is not a schema field, so
 *   it can never appear in the form's dirty set (see {@link LIVE_OVERLAYS})
 * @param {boolean} [ctx.samplingRateChanged] force the rate overlay even when
 *   the rate field itself is not dirty (an ExG mode change needs the ratio
 *   re-derived from the current rate)
 * @returns {{
 *   steps: {step: string, label: string, kind: "infomem"|"live"|"refresh"}[],
 *   blocked: string|null,
 * }}
 */
export function buildApplyPlan(dirtyKeys, ctx = {}) {
  const dirty = new Set(dirtyKeys ?? []);
  const caps = ctx.caps ?? {};
  const steps = [];

  const blocked = applyBlockedReason(ctx, caps);

  // 1-2. Stored configuration.
  steps.push({
    step: STEP_INFOMEM,
    label: "Write the configuration image (InfoMem pages D, C, B)",
    kind: "infomem",
  });
  if (caps.sdlog !== false) {
    steps.push({
      step: STEP_SDLOG,
      label: "Rebuild the SD header from the new configuration (0x9C)",
      kind: "infomem",
    });
  }

  // 3. Live overlays, in firmware-mandated order, for the dirty subset only.
  for (const configKey of LIVE_ORDER) {
    const overlay = LIVE_OVERLAYS[configKey];
    if (!overlay) continue;
    const needed =
      dirty.has(configKey) ||
      (configKey === "samplingRateHz" && ctx.samplingRateChanged) ||
      (configKey === "enabledSensors" && ctx.sensorsChanged);
    if (!needed) continue;
    // A setter the vendored SDK does not have is dropped from the plan rather
    // than queued to fail: the stored image still carries the setting, so it
    // takes effect on the next reboot.
    if (configKey === "enabledSensors" && caps.sensors === false) continue;
    if (
      (configKey === "imu.wrAccelRange" || configKey === "imu.gyroRange") &&
      caps.ranges === false
    ) {
      continue;
    }
    steps.push({
      step: overlay.method,
      label: `Apply the ${overlay.label} to the running configuration`,
      kind: "live",
    });
  }

  // 4. ExG last — it reads the sampling rate and the sensor mask set above.
  if (ctx.exgModeChanged && caps.exg !== false) {
    steps.push({
      step: STEP_EXG,
      label:
        "Install the ExG register banks (oversampling ratio derived from the " +
        "sampling rate just applied)",
      kind: "live",
    });
  }

  // 5. Read back what the device now says, rather than trusting the write.
  steps.push({
    step: STEP_INQUIRY,
    label: "Re-inquire the channel list and rate",
    kind: "refresh",
  });
  steps.push({
    step: STEP_REREAD,
    label: "Re-read the configuration image and re-baseline the form",
    kind: "refresh",
  });

  return { steps, blocked };
}

/**
 * Why this plan cannot run right now, or null.
 *
 * Separate from the step list on purpose: the caller still wants to SHOW the
 * plan while it is blocked ("this is what Apply would do, and here is why it
 * is greyed out"), which a thrown error would not allow.
 */
function applyBlockedReason(ctx, caps) {
  if (caps.infomem === false) {
    return "this SDK build cannot read and write the configuration memory";
  }
  if (ctx.streaming) {
    return (
      "the sensor is streaming — it NACKs configuration commands while " +
      "sensing, so stop the stream first"
    );
  }
  if (ctx.recording) {
    return (
      "the sensor is logging to its card — it NACKs configuration commands " +
      "while sensing, so stop logging first"
    );
  }
  return null;
}

/**
 * Map the form's dirty FIELD keys to the `configKey`s {@link buildApplyPlan}
 * expects, using the same field definitions the form was given.
 *
 * Two fields can share a `configKey` (each part generation declares its own
 * `wrAccelRate`, all writing `imu.wrAccelRate`), which is exactly why the plan
 * is keyed on `configKey` and not on the field key.
 *
 * @param {readonly string[]} dirtyFieldKeys
 * @param {readonly {key: string, configKey: string}[]} fields
 * @returns {string[]} unique config keys, in the order the fields declare them
 */
export function configKeysForDirtyFields(dirtyFieldKeys, fields) {
  const wanted = new Set(dirtyFieldKeys ?? []);
  const out = [];
  for (const f of fields ?? []) {
    if (!wanted.has(f.key)) continue;
    if (!out.includes(f.configKey)) out.push(f.configKey);
  }
  return out;
}
