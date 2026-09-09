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
  defaultTrialIdentity,
  generateCalibDump,
  generateKinematicCalibBlock,
  getDefaultCalibration,
  parseBrandRecord,
  sdCrc16,
  appendCrc,
} from "../../vendor/shimmer-web-sdk.esm.js";

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
  SET_DAUGHTER_CARD_ID: 0x64,
  DAUGHTER_CARD_ID_RESPONSE: 0x65,
  GET_DAUGHTER_CARD_ID: 0x66,
  SET_DAUGHTER_CARD_MEM: 0x67,
  DAUGHTER_CARD_MEM_RESPONSE: 0x68,
  GET_DAUGHTER_CARD_MEM: 0x69,
  START_SDBT: 0x70,
  STATUS_RESPONSE: 0x71,
  GET_STATUS: 0x72,
  SET_DATA_RATE_TEST: 0xa4,
  DATA_RATE_TEST_RESPONSE: 0xa5,
  GET_BT_VERSION_STR: 0xa1,
  BT_VERSION_STR_RESPONSE: 0xa2,
  SET_FACTORY_TEST: 0xa8,
  INSTREAM_CMD_RESPONSE: 0x8a,
  SET_CRC: 0x8b,
  SET_INFOMEM: 0x8c,
  INFOMEM_RESPONSE: 0x8d,
  GET_INFOMEM: 0x8e,
  SET_RWC: 0x8f,
  RWC_RESPONSE: 0x90,
  GET_RWC: 0x91,
  VBATT_RESPONSE: 0x94,
  GET_VBATT: 0x95,
  PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE: 0xa6,
  GET_PRESSURE_CALIBRATION_COEFFICIENTS: 0xa7,
  STOP_SDBT: 0x97,
  SET_CALIB_DUMP: 0x98,
  RSP_CALIB_DUMP: 0x99,
  GET_CALIB_DUMP: 0x9a,
  UPD_CALIB_DUMP: 0x9b,
  SET_FEATURE: 0xb7,
});

/**
 * The firmware's `factory_test_t` (log-and-stream-common
 * `Test/shimmer_test.h:21-27`), which is also SET_FACTORY_TEST's argument byte.
 */
const FACTORY_TEST_TYPE = Object.freeze({
  MAIN: 0,
  LEDS: 1,
  ICS: 2,
  LED_STATES: 3,
});
/** `FACTORY_TEST_COUNT` — the firmware ignores anything at or above it. */
const FACTORY_TEST_TYPE_COUNT = 4;

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
  /* The rest of what a real sensor can send. Absent until now, which meant the
     mock could not exercise the calibrated ADC, battery, pressure or
     bridge-amplifier paths at all. */
  { bit: 0x002000, label: "battery", ids: [0x03] },
  { bit: 0x200000, label: "alt mag", ids: [0x17, 0x18, 0x19] },
  { bit: 0x000002, label: "ext ADC 0", ids: [0x0d] },
  { bit: 0x000001, label: "ext ADC 1", ids: [0x0e] },
  { bit: 0x000800, label: "ext ADC 2", ids: [0x0f] },
  { bit: 0x000400, label: "int ADC 3", ids: [0x10] },
  { bit: 0x000200, label: "int ADC 0", ids: [0x11] },
  { bit: 0x800000, label: "int ADC 2", ids: [0x13] },
  /* Pressure and temperature are one enable bit and two channels, and the
     firmware emits them in the OPPOSITE order on the two generations —
     pressure first on a Shimmer3R, temperature first on a Shimmer3 — with
     different widths too. `sensorChannelsFor` picks the right pair. */
  { bit: 0x040000, label: "pressure/temperature", ids: [0x1b, 0x1a] },
  // Shimmer3 only: there is no Shimmer3R bridge-amplifier channel.
  { bit: 0x008000, label: "bridge amp", ids: [0x27, 0x28], shimmer3Only: true },
]);

/**
 * The channel table for one hardware generation.
 *
 * Two things differ. A Shimmer3 has no ADS7028 and its bridge amplifier is a
 * real expansion board, so `0x27`/`0x28` exist there and nowhere else; and the
 * BMP pair is emitted in the opposite order with different widths.
 */
function sensorChannelsFor(hardwareVersion) {
  const isShimmer3 = hardwareVersion === 3;
  return SENSOR_CHANNELS.filter((g) => isShimmer3 || !g.shimmer3Only).map(
    (g) => (g.bit === 0x040000 && isShimmer3 ? { ...g, ids: [0x1a, 0x1b] } : g),
  );
}

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
  0x03: { bytes: 2, be: false, unsigned: true },
  0x0d: { bytes: 2, be: false, unsigned: true },
  0x0e: { bytes: 2, be: false, unsigned: true },
  0x0f: { bytes: 2, be: false, unsigned: true },
  0x10: { bytes: 2, be: false, unsigned: true },
  0x11: { bytes: 2, be: false, unsigned: true },
  0x13: { bytes: 2, be: false, unsigned: true },
  0x17: { bytes: 2, be: false },
  0x18: { bytes: 2, be: false },
  0x19: { bytes: 2, be: false },
  0x27: { bytes: 2, be: false, unsigned: true },
  0x28: { bytes: 2, be: false, unsigned: true },
});

/**
 * The pressure/temperature widths, which are the one place the two generations
 * disagree about a channel's LAYOUT rather than its name: 3 little-endian bytes
 * each on a Shimmer3R, 2 big-endian temperature bytes plus 3 big-endian
 * pressure bytes on a Shimmer3 (`CHANNEL_FORMAT_OVERRIDES`).
 */
const BMP_WIDTH = Object.freeze({
  shimmer3: {
    0x1a: { bytes: 2, be: true, unsigned: true },
    0x1b: { bytes: 3, be: true, unsigned: true },
  },
  shimmer3r: {
    0x1a: { bytes: 3, be: false, unsigned: true },
    0x1b: { bytes: 3, be: false, unsigned: true },
  },
});

/**
 * Raw values that convert to something a person would believe.
 *
 * A full-scale sine is the right synthetic signal for an accelerometer axis,
 * where the point is to see the trace move. It is the wrong one for a channel
 * whose calibrated value is a physical quantity: 4095 counts of battery is
 * 6 V, and a BMP390 fed a sine reports the compensation clamp. These centres
 * and amplitudes are chosen so the CALIBRATED plot reads plausibly — about
 * 3.9 V of battery, room temperature, sea-level pressure, mid-scale ADC.
 */
const PLAUSIBLE_SAMPLES = Object.freeze({
  0x03: { centre: 2000, amplitude: 12 }, // battery ≈ 3.93 V after the ×2 divider
  0x0d: { centre: 2048, amplitude: 400 }, // ext ADC ≈ 1.5 V ± 0.3
  0x0e: { centre: 2048, amplitude: 400 },
  0x0f: { centre: 2048, amplitude: 400 },
  0x10: { centre: 2048, amplitude: 400 }, // int ADC
  0x11: { centre: 2048, amplitude: 400 },
  0x13: { centre: 2048, amplitude: 400 },
  0x12: { centre: 2048, amplitude: 600 }, // PPG
  0x1c: { centre: 2000, amplitude: 300 }, // GSR, inside range 0's window
  0x27: { centre: 2048, amplitude: 300 }, // bridge amp
  0x28: { centre: 2048, amplitude: 300 },
  /* The BMP390's raw registers, from the coefficient block below: about
     100.9 kPa and 23 °C. A Shimmer3 (BMP180/BMP280) reads differently through
     its own compensation, which is fine — it is still in range. */
  0x1b: { centre: 0x640d00, amplitude: 0x400 },
  0x1a: { centre: 0x7fba00, amplitude: 0x200 },
});

/**
 * What the mock answers `GET_PRESSURE_CALIBRATION_COEFFICIENTS` with.
 *
 * The BMP390 block is the vector in the Java driver's own
 * `CalibDetailsBmp390.main()`, so the kPa and °C this mock produces can be
 * checked against a number nobody here chose. The BMP180 block is the
 * datasheet's worked example (BST-BMP180-DS000 §3.5). A BMP581 sends no
 * coefficients at all — that is the part, not a fault.
 *
 * There is no BMP280 fixture: no public worked vector was to hand, and
 * inventing coefficients would produce a confident, unverifiable pressure.
 */
const PRESSURE_FIXTURES = Object.freeze({
  390: {
    id: 2,
    coeffs: [
      0xe7, 0x6b, 0xf0, 0x4a, 0xf9, 0xab, 0x1c, 0x9b, 0x15, 0x06, 0x01, 0xd2,
      0x49, 0x18, 0x5f, 0x03, 0xfa, 0x3a, 0x0f, 0x07, 0xf5,
    ],
  },
  581: { id: 3, coeffs: [] },
  180: {
    id: 0,
    // AC1..MD, big-endian pairs, from the datasheet's example.
    coeffs: [
      0x01, 0x98, 0xff, 0xb8, 0xc7, 0xd1, 0x7f, 0xe5, 0x7f, 0xf5, 0x5a, 0x71,
      0x18, 0x2e, 0x00, 0x04, 0x80, 0x00, 0xdd, 0xf9, 0x0b, 0x34,
    ],
  },
});

/** Width for one channel id, on one generation. */
function channelWidthFor(id, hardwareVersion) {
  const bmp = BMP_WIDTH[hardwareVersion === 3 ? "shimmer3" : "shimmer3r"][id];
  return bmp ?? CHANNEL_WIDTH[id] ?? { bytes: 2, be: false };
}

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
  /* Shimmer3R puts the later config bytes in the second segment, and byte 6 is
     not adjacent to byte 5 (resolveInfoMemLayout: 128, 129, 132). */
  configSetupByte4: 128,
  configSetupByte5: 129,
  configSetupByte6: 132,
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

/**
 * Firmware's ceiling on the Bluetooth module version string: the reply is
 * `strlen()` of `char btVerStrResponse[100]` in
 * `Comms/shimmer_bt_uart.c`, so 99 characters plus its terminator is the most
 * a real sensor can report.
 */
const BT_VERSION_MAX_BYTES = 99;

/** Firmware's ceiling on one daughter-card read or write. */
const EEPROM_MAX_PER_CALL = 128;

// ---------------------------------------------------------------------------
// Calibration dump
// ---------------------------------------------------------------------------

/**
 * Calibration RAM, `SHIMMER_CALIB_RAM_MAX` in log-and-stream-common
 * `Calibration/shimmer_calibration.h:16-20`. The dump lives at the front of
 * it and the rest reads as zeros, which is what a read past the end of a real
 * dump returns.
 */
const CALIB_RAM_BYTES = 1024;

/**
 * Bytes the firmware will move in one GET_CALIB_DUMP / SET_CALIB_DUMP
 * (`Comms/shimmer_bt_uart.c:2241-2249`). Bigger requests are refused rather
 * than served short, because the SDK sizes its pages against this.
 */
const CALIB_MAX_PER_CALL = 128;

/**
 * Calibration-domain sensor ids, `SC_SENSOR_*` in log-and-stream-common
 * `Calibration/shimmer_calibration.h:96-112`. NOT the SDK's `CalibSensorId`,
 * which is the Verisense domain and disagrees on 40 and 41.
 */
const SC_SENSOR = Object.freeze({
  ANALOG_ACCEL: 2,
  MPU9X50_GYRO: 30,
  LSM303_ACCEL: 31,
  LSM303_MAG: 32,
  BMP180_PRESSURE: 36,
  LSM6DSV_ACCEL: 37,
  LSM6DSV_GYRO: 38,
  LIS2DW12_ACCEL: 39,
  ADXL371_ACCEL: 40,
  LIS3MDL_MAG: 41,
  LIS2MDL_MAG: 42,
  BMP390_PRESSURE: 43,
});

/** 32768 Hz ticks, the unit `RTC_getRwcTime()` stamps a calibration with. */
function calibStamp(unixSeconds) {
  const out = new Uint8Array(8);
  let ticks = BigInt(Math.round(unixSeconds * 32768));
  for (let i = 0; i < 8; i++) {
    out[i] = Number(ticks & 0xffn);
    ticks >>= 8n;
  }
  return out;
}

/** The all-zero stamp the firmware writes for a seeded (default) calibration. */
const CALIB_STAMP_NONE = new Uint8Array(8);

/**
 * A 21-byte kinematic block built from the SDK's own defaults for a family,
 * group and range, optionally perturbed to stand in for a per-unit
 * calibration.
 *
 * Built through `generateKinematicCalibBlock` rather than typed out as bytes
 * so the fixture cannot drift away from the parser that reads it: if the
 * codec changes, this changes with it.
 */
function calibBlock(family, group, range, tweak) {
  const d = getDefaultCalibration(family, group, range);
  if (!d) return null;
  const offset = [...d.calibration.offset];
  const sensitivity = [...d.calibration.sensitivity];
  const alignment = [...d.calibration.alignment];
  if (tweak) {
    tweak.offset?.forEach((v, i) => (offset[i] = v));
    tweak.sensitivity?.forEach((v, i) => (sensitivity[i] = v));
    tweak.alignment?.forEach((v, i) => (alignment[i] = v));
  }
  return generateKinematicCalibBlock(offset, sensitivity, alignment, {
    sensitivityScale: d.sensitivityScale,
  });
}

function calibRecord(sensorId, range, bytes, ts) {
  return {
    sensorId,
    range,
    calibLen: bytes.length,
    timestampTicks: ts,
    calibBytes: bytes,
    isDefault: ts.every((b) => b === 0),
  };
}

/**
 * The synthetic calibration dump, mixed on purpose so every state the
 * calibration UI has to render is reachable without hardware:
 *
 *   - the low-noise accel and the magnetometer hold this unit's OWN values
 *     with a real calibration date;
 *   - the gyro and the wide-range accel hold the factory defaults, stamped
 *     all-zero exactly as the firmware seeds them;
 *   - the gyro's record is at ONE range only, so every other gyro range has
 *     no record at all — the "never calibrated" state, reached by moving the
 *     range selector rather than by finding a different sensor;
 *   - on a Shimmer3R the alt-magnetometer's record is an all-0xFF block (the
 *     other flavour of "nothing stored": a record that exists and says
 *     nothing) and the high-g accel has NO record at all;
 *   - the pressure sensor holds a 22-byte coefficient block, which is not a
 *     kinematic set and must not be offered as one.
 *
 * @param {number|null} hardwareVersion 3, 10, or null (treated as 10)
 * @param {{major: number, minor: number, patch: number}} fw
 */
function buildSyntheticCalibDump(hardwareVersion, fw) {
  const hw = hardwareVersion == null ? 10 : hardwareVersion;
  const version = {
    hardwareId: hw,
    firmwareId: 3, // LogAndStream
    firmwareMajor: fw.major,
    firmwareMinor: fw.minor,
    firmwareInternal: fw.patch,
  };
  /* Fixed civil dates so a screenshot and a test see the same thing every
     run. Midday, so a host time zone either side of UTC still reads the day
     the fixture names. */
  const CAL_A = Date.UTC(2026, 5, 11, 12, 0, 0) / 1000;
  const CAL_B = Date.UTC(2026, 3, 2, 12, 0, 0) / 1000;
  /* Not a kinematic block: the pressure chips' factory coefficients, which
     the calibration tab has to show as present-but-not-editable.

     A record no FIRMWARE would write, on purpose. `ShimCalib_findLength`
     returns 0 for id 43, so a Shimmer3R never creates one — but
     `SET_CALIB_DUMP` writes bytes straight into the blob at a host-chosen
     offset, so a host CAN put one there and the device will store and echo it
     without ever applying it. Serving one here keeps a host honest about that:
     a dump is not a statement of what the device understands. */
  const pressure = Uint8Array.from({ length: 22 }, (_, i) => 0x40 + i);

  if (hw === 3) {
    const family = "shimmer3-old";
    return generateCalibDump(version, [
      calibRecord(
        SC_SENSOR.ANALOG_ACCEL,
        0,
        calibBlock(family, "lnAccel", 0, {
          offset: [2051, 2043, 2049],
          sensitivity: [84, 83, 82],
        }),
        calibStamp(CAL_A),
      ),
      calibRecord(
        SC_SENSOR.MPU9X50_GYRO,
        3,
        calibBlock(family, "gyro", 3),
        CALIB_STAMP_NONE,
      ),
      calibRecord(
        SC_SENSOR.LSM303_ACCEL,
        0,
        calibBlock(family, "wrAccel", 0),
        CALIB_STAMP_NONE,
      ),
      calibRecord(
        SC_SENSOR.LSM303_MAG,
        1,
        calibBlock(family, "mag", 1, { sensitivity: [1104, 1098, 981] }),
        calibStamp(CAL_B),
      ),
      calibRecord(SC_SENSOR.BMP180_PRESSURE, 0, pressure, calibStamp(CAL_B)),
    ]);
  }

  const family = "shimmer3r";
  return generateCalibDump(version, [
    calibRecord(
      SC_SENSOR.LSM6DSV_ACCEL,
      0,
      calibBlock(family, "lnAccel", 0, {
        offset: [12, -30, 4],
        sensitivity: [1674, 1670, 1673],
      }),
      calibStamp(CAL_A),
    ),
    calibRecord(
      SC_SENSOR.LSM6DSV_GYRO,
      3,
      calibBlock(family, "gyro", 3),
      CALIB_STAMP_NONE,
    ),
    calibRecord(
      SC_SENSOR.LIS2DW12_ACCEL,
      0,
      calibBlock(family, "wrAccel", 0),
      CALIB_STAMP_NONE,
    ),
    calibRecord(
      SC_SENSOR.LIS2MDL_MAG,
      0,
      calibBlock(family, "mag", 0, {
        offset: [-6, 11, 2],
        sensitivity: [669, 664, 671],
      }),
      calibStamp(CAL_B),
    ),
    /* A record that exists and stores nothing — `parseKinematicCalibBlock`
       answers null for an all-0xFF block, and the UI must say "never
       calibrated" rather than printing 65535s. */
    calibRecord(
      SC_SENSOR.LIS3MDL_MAG,
      0,
      new Uint8Array(21).fill(0xff),
      CALIB_STAMP_NONE,
    ),
    calibRecord(SC_SENSOR.BMP390_PRESSURE, 0, pressure, calibStamp(CAL_B)),
    /* No ADXL371 record at all: deliberately absent. */
  ]);
}

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
 * @param {"390"|"581"|"180"|"nack"|"silent"} [opts.pressure] how the mock
 *   answers GET_PRESSURE_CALIBRATION_COEFFICIENTS (0xA7). Defaults to the part
 *   the hardware version implies — BMP390 on a Shimmer3R, BMP180 on a
 *   Shimmer3. `nack` refuses it, as firmware without the command does; `silent`
 *   answers nothing at all, as firmware old enough to lack even the refusal
 *   does. Either way pressure and temperature stream raw-only, which is a path
 *   worth being able to see.
 * @param {number} [opts.sdKBps=120] throughput of streamed SD file blocks
 * @param {number} [opts.linkKBps=180] throughput reported by the firmware
 *   data-rate test (SET_DATA_RATE_TEST)
 * @param {boolean} [opts.debug=false] console.log every command
 * @returns {LoopbackTransport} pass it to `new Shimmer3RClient({ transport })`.
 *   `transport.emitDisconnect()` simulates a dropped link;
 *   `transport.writes` is every command the page sent; `transport.sdCard`
 *   is the synthetic card, with a `bytes(path)` that returns exactly what a
 *   download of that file should produce; `transport.eeprom` is the
 *   expansion-board EEPROM, with the brand record and the restart
 *   bookkeeping; `transport.calib` is the calibration RAM, with the dump
 *   as it now stands and a count of the chunks the firmware dropped; and
 *   `transport.status` docks, undocks or pushes an unsolicited
 *   STATUS_RESPONSE, which is how the firmware tells a host about a change
 *   the host did not cause. `transport.factoryTest` is the self-test run
 *   count, whether a report is still printing and the exact text printed;
 *   `transport.rtc` exposes the sensor's own running clock.
 */
export function createMockShimmer3RTransport(opts = {}) {
  const framed = opts.framed !== false;
  const dribbleBytes = Math.max(1, opts.dribbleBytes ?? DEFAULT_DRIBBLE_BYTES);
  const debug = !!opts.debug;
  const mac = (opts.mac ?? "000666668091").replace(/[^0-9a-fA-F]/g, "");
  const fw = { major: 1, minor: 1, patch: 12, ...(opts.firmware ?? {}) };
  /* `undefined` means "not asked for" and gets the Shimmer3R default; `null`
     means "this sensor will not say", which NACKs GET_DEVICE_VERSION. Anything
     non-finite is neither -- it used to reach `hardwareVersion & 0xff` and
     answer 0, a fourth behaviour nobody asked for -- so it is read as the
     default, the same as not passing one. */
  const hardwareVersion =
    opts.hardwareVersion === undefined ||
    (opts.hardwareVersion !== null && !Number.isFinite(opts.hardwareVersion))
      ? 10
      : opts.hardwareVersion;

  /* Which pressure part this mock claims to carry. Defaults to the one the
     platform really would: a Shimmer3R has a BMP390 or BMP581, a Shimmer3 a
     BMP180 or BMP280. */
  const pressureMode = String(
    opts.pressure ?? (hardwareVersion === 3 ? "180" : "390"),
  );
  const sdKBps = Math.max(1, opts.sdKBps ?? SD_DEFAULT_KBPS);
  const linkKBps = Math.max(1, opts.linkKBps ?? LINK_DEFAULT_KBPS);

  /* A real-world clock that RUNS, and runs at a settable error. A frozen
     clock (what a stored tick count gives) reads back correctly but has no
     slope, so nothing that measures drift can be exercised against it.
     `clockBase: "local"` starts the sensor on this host's civil time instead
     of UTC, which is what a sensor set by a tool using the other convention
     looks like — the case a host's clock-base detection exists for. */
  const rtcOpts = opts.rtc ?? {};
  const rtcPpm = Number.isFinite(rtcOpts.ppm) ? Number(rtcOpts.ppm) : 0;
  const rtcClockBase = rtcOpts.clockBase === "local" ? "local" : "utc";
  /* `wrapInSec` puts the sensor's clock where its low 24 bits are about to
     roll over, so a short stream crosses a wrap. It moves the CLOCK, not the
     stream counter, because on a Shimmer3R the two are the same number (see
     `startStreaming`) and moving one without the other would model a sensor
     that does not exist. Up to 512 s of date shift is the price, and that is
     itself a legitimate sensor state. */
  const rtcWrapInSec = Number.isFinite(rtcOpts.wrapInSec)
    ? Math.max(0, Number(rtcOpts.wrapInSec))
    : null;
  const rtc = {
    devMsAtSet:
      Date.now() +
      (rtcClockBase === "local" ? -new Date().getTimezoneOffset() * 60000 : 0),
    setAtHostMs: Date.now(),
  };
  if (rtcWrapInSec != null) {
    const ticks = Math.round(rtc.devMsAtSet * 32.768);
    const target = 0x1000000 - Math.round(rtcWrapInSec * SAMPLING_CLOCK_HZ);
    // Forward to the next tick count whose low 24 bits are `target`, so the
    // clock never moves backwards past a reading a host may already hold.
    const ahead = (target - (ticks % 0x1000000) + 0x1000000) % 0x1000000;
    rtc.devMsAtSet = (ticks + ahead) / 32.768;
  }
  /** The sensor's clock now, in its own epoch, drifting at `rtcPpm`. */
  const deviceNowMs = () =>
    rtc.devMsAtSet + (Date.now() - rtc.setAtHostMs) * (1 + rtcPpm / 1e6);

  const state = {
    rateHz: opts.rateHz ?? 51.2,
    sensors: opts.sensors ?? 0x00e0,
    streaming: false,
    logging: false,
    /** Seated in a dock. Toggled through `transport.status`, which pushes. */
    docked: false,
    /** A card is in the slot — this mock serves one, see `buildSyntheticCard`. */
    sdInserted: true,
    /** The firmware could not open its log file. */
    sdBadFile: false,
    /** The clock has been set since the sensor last lost power. */
    rwcSet: false,
    /** The red LED, as TOGGLE_LED leaves it. */
    redLedOn: false,
    /** The USB rail — the Shimmer3R's second status byte. */
    usbPluggedIn: false,
    wrAccelRange: 0,
    gyroRange: 3,
    altAccelRange: 0,
    gsrRange: 4,
    expPowerEnabled: 0,
    /* Seeded to the firmware's own Shimmer3R defaults rather than zeros.
       Byte 1 is the whole LSM6DSV accel/gyro ODR, and zero means POWER-DOWN -
       so an all-zero default modelled a device whose IMU never produces a new
       sample, which is not a state a real sensor ships in. `shimmer_config.c`
       pairs the 51.2 Hz default packet rate with "next highest", 60 Hz
       (LSM6DSV_ODR_AT_60Hz = 5), and this follows it so the mock exercises a
       coherent configuration by default. */
    configSetupBytes: Uint8Array.of(0x02, 0x05, 0x01, 0x08, 0x00, 0x88, 0x10),
    /** 64-bit RTC ticks, LSB first on the wire. */
    rwcTicks: 0n,
    /** A soft restart has been armed for the next disconnect. */
    rebootArmed: false,
    /** How many times the armed restart has actually fired. */
    reboots: 0,
    /** Self-test bookkeeping, read through `transport.factoryTest`. */
    factoryTest: { runs: 0, running: false, lastType: null },
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

  /* The daughter-card ID page: the FIRST sixteen EEPROM bytes, which the
     card-memory store above deliberately does not cover. Firmware answers
     GET_DAUGHTER_CARD_ID from a copy it caches at boot rather than from the
     chip, which is why it is a separate array here too.

     Default `[48, 3, 0]` — a GSR+ board, SR48-3-0 — so the page has something
     to name. The two blank patterns are distinct and both worth modelling:
     `&srBoard=none` fills the page with 0xFF, an ERASED chip, and
     `&srBoard=0-0-0` leaves it all zeroes, a page that was NEVER WRITTEN. The
     SDK reads both as "no board". */
  const srBoardPage = new Uint8Array(16).fill(0xff);
  if (opts.srBoard !== "none") {
    const parts = String(opts.srBoard ?? "48-3-0")
      .split("-")
      .map((n) => Number.parseInt(n, 10));
    const triple = [
      Number.isFinite(parts[0]) ? parts[0] & 0xff : 48,
      Number.isFinite(parts[1]) ? parts[1] & 0xff : 3,
      Number.isFinite(parts[2]) ? parts[2] & 0xff : 0,
    ];
    /* An all-zero SR code means the page was never written, so the WHOLE page
       is zero - not three zeroes in front of the 0xFF fill above, which is
       neither pattern and would misrepresent the state to anything that
       looked past the first three bytes. A real board's remaining bytes hold
       other hardware details, so those stay 0xFF. */
    if (triple.every((v) => v === 0)) srBoardPage.fill(0x00);
    else srBoardPage.set(triple, 0);
  }

  /* What the Bluetooth module replied when the firmware asked it, verbatim.
     The Shimmer3R default is the line `BT_generateCyw20820FirmwareVersionStr`
     composes (`CYW20820.c:1893-1903`); a Shimmer3 forwards the RN module's
     own banner instead, so `hardwareVersion === 3` gets one of those.

     `&btVersion=` (empty) models the real zero-length case: the firmware's
     buffer starts zeroed and is filled only once the module has answered its
     own query, so a sensor asked early enough reports nothing. */
  const btVersionString =
    opts.btVersion !== undefined
      ? String(opts.btVersion)
      : hardwareVersion === 3
        ? "RN4678 V1.23 06/30/2021 (c)Microchip Technology Inc"
        : "CYW20820 app=v01.04.18.18, stack=0x00000000, protocol=0x0000, hardware=0x00";

  /* Calibration RAM with the synthetic dump at the front of it. Everything
     past the dump reads as zeros, which is what a read past a real dump
     returns — and what makes the SDK's "take the total from the first
     chunk's header" paging worth exercising. */
  const calibRam = new Uint8Array(CALIB_RAM_BYTES);
  calibRam.set(buildSyntheticCalibDump(hardwareVersion, fw), 0);
  /**
   * A SET_CALIB_DUMP in progress. The firmware takes the dump's total length
   * from the FIRST chunk's own header and counts the rest in, refusing a
   * write that does not start at the beginning
   * (`ShimCalib_ramWrite`, `Calibration/shimmer_calibration.c:330-370`).
   * `null` between writes.
   */
  let calibStaging = null;
  /** Bookkeeping the harness reads: applies, and writes the firmware dropped. */
  const calibStats = { updates: 0, discarded: 0 };

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

    /* The seven config setup bytes, in step with what the inquiry reports for
       the same reason the sensor bitmap is: a config form reads them from
       InfoMem while the stream schema comes from the inquiry, so two sources
       that disagree would have the page showing one configuration and decoding
       another. Byte 1 is the accel/gyro ODR, which is exactly the pair a host
       has to keep coherent with the sampling rate above. */
    infoMem.set(state.configSetupBytes.subarray(0, 4), IM.configSetupByte0);
    /* Bytes 4-6 are NOT contiguous with 0-3, and byte 6 is not adjacent to 5
       either: the Shimmer3R layout puts them at 128, 129 and 132. Writing them
       as a run is the mistake to avoid - it lands byte 6 on 130, which is a
       different field. */
    infoMem[IM.configSetupByte4] = state.configSetupBytes[4];
    infoMem[IM.configSetupByte5] = state.configSetupBytes[5];
    infoMem[IM.configSetupByte6] = state.configSetupBytes[6];

    infoMem[IM.btCommBaudRate] = 9; // 1 Mbaud, the Shimmer3R default
    /* From the SDK rather than hand-rolled, so the mock cannot drift from what
       the firmware's own ShimConfig_setDefaultShimmerName /
       ShimConfig_setDefaultTrialId produce. The previous inline
       `mac.slice(-4)` also assumed a separator-free MAC, which this mock
       happens to use but a caller passing a colon-separated one would break. */
    const identity = defaultTrialIdentity(mac);
    if (identity.deviceName !== null) {
      writeName(IM.shimmerName, identity.deviceName);
    }
    writeName(IM.expIdName, identity.trialName);

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

  /**
   * The calibration RAM, exposed for development and for tests. `bytes()` is
   * the dump as it stands now — after any SET_CALIB_DUMP the firmware
   * accepted — `updates` counts UPD_CALIB_DUMP, and `discarded` counts the
   * chunks the firmware dropped while still ACKing them, which is how a test
   * proves an out-of-order write really did go nowhere.
   */
  transport.calib = {
    bytes: () => {
      const total = (calibRam[0] | (calibRam[1] << 8)) + 2;
      return calibRam.slice(0, Math.min(Math.max(total, 2), calibRam.length));
    },
    ram: () => calibRam.slice(),
    get updates() {
      return calibStats.updates;
    },
    get discarded() {
      return calibStats.discarded;
    },
  };

  /**
   * The sensor's own news: dock it, undock it, or push the status as it
   * stands.
   *
   * On real firmware a dock and an undock each send an unsolicited
   * STATUS_RESPONSE to whatever host is connected
   * (`LogAndStream_setupDock` / `LogAndStream_setupUndock`,
   * log-and-stream-common `log_and_stream_common.c`), and so does a sensing
   * change the firmware made itself — the user button, a trial ending, a low
   * battery. That is the only way a host hears about any of them, and it is
   * what `Shimmer3RClient.onDeviceStatus` exists to deliver.
   *
   * Deliberately NOT sent when this mock's own state changes because of a
   * command: the firmware suppresses that one
   * (`ShimBt_instreamStatusRespSendIfNotBtCmd`) rather than echo back what
   * the host just asked for, so a page that wants to show its own start or
   * stop has to reflect it itself.
   */
  transport.status = {
    get docked() {
      return state.docked;
    },
    /** Dock or undock, pushing the status the change produced. */
    setDocked: (docked) => {
      state.docked = !!docked;
      reply(statusResponse());
    },
    /** Push the status as it stands, without changing anything. */
    push: () => reply(statusResponse()),
    /** The frame a push (or a GET_STATUS answer) carries, for comparison. */
    bytes: () => new Uint8Array(statusResponse()),
  };

  transport.factoryTest = {
    /** How many self-tests this sensor has been asked to run. */
    get runs() {
      return state.factoryTest.runs;
    },
    /** True while the report is still printing — a cancel cannot stop it. */
    get running() {
      return state.factoryTest.running;
    },
    get lastType() {
      return state.factoryTest.lastType;
    },
    /** Exactly the text put on the wire, for a byte-for-byte comparison. */
    text: () => testText,
  };

  transport.identity = {
    /** The id page's first three bytes as written, or null when erased. */
    get srBoard() {
      const [boardId, boardRev, specialRev] = srBoardPage;
      if (boardId === 0xff && boardRev === 0xff && specialRev === 0xff)
        return null;
      return { boardId, boardRev, specialRev };
    },
    /** What the Bluetooth module replied, exactly as it goes on the wire. */
    get btVersion() {
      return btVersionString;
    },
  };

  transport.rtc = {
    get ppm() {
      return rtcPpm;
    },
    get clockBase() {
      return rtcClockBase;
    },
    /** The sensor's own clock, in its own epoch. */
    deviceNowMs,
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
  /**
   * CRC bytes appended to everything the device sends, per SET_CRC_COMMAND.
   * Zero until a host asks, which is the state after every power cycle.
   */
  let crcMode = 0;

  function reply(bytes) {
    const u8 = appendCrc(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      crcMode,
    );
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
  function replyStream(frame) {
    const u8 = appendCrc(frame, crcMode);
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
  // Device status
  // -------------------------------------------------------------------------

  /**
   * `[0x8A][0x71][status0][status1]` — the in-stream status message.
   *
   * ONE builder for both the answer to GET_STATUS and the unsolicited push, so
   * the two cannot drift apart: on the wire they are the same message, and a
   * mock whose push disagreed with its own reply would let a page's status
   * handling look right while being wrong.
   *
   * Bit order is `ShimBt_assembleStatusBytes` (log-and-stream-common
   * `Comms/shimmer_bt_uart.c`): docked, sensing, RTC set, SD logging,
   * streaming, card inserted, bad file, red LED. `sensing` is set by either
   * kind of recording, which is how the firmware reports it — it is not a
   * fourth thing the host can start.
   *
   * Always two bytes, the Shimmer3R length: a Shimmer3 sends one, but this
   * mock answers as a Shimmer3R whatever hardware id it is told to report,
   * and the SDK reads only as many bytes as the platform it identified has.
   */
  function statusResponse() {
    const sensing = state.streaming || state.logging;
    const status0 =
      (state.docked ? 0x01 : 0) |
      (sensing ? 0x02 : 0) |
      (state.rwcSet ? 0x04 : 0) |
      (state.logging ? 0x08 : 0) |
      (state.streaming ? 0x10 : 0) |
      (state.sdInserted ? 0x20 : 0) |
      (state.sdBadFile ? 0x40 : 0) |
      (state.redLedOn ? 0x80 : 0);
    return [
      CMD.INSTREAM_CMD_RESPONSE,
      CMD.STATUS_RESPONSE,
      status0,
      state.usbPluggedIn ? 1 : 0,
    ];
  }

  // -------------------------------------------------------------------------
  // Stream schema and synthetic data
  // -------------------------------------------------------------------------

  /** Enabled channel IDs, deduplicated, in firmware report order. */
  function channelIds() {
    const ids = [];
    for (const group of sensorChannelsFor(hardwareVersion)) {
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
    const width = channelWidthFor(id, hardwareVersion);
    const t = n / state.rateHz;
    const phase = ((id * 37) % 360) * (Math.PI / 180);
    const freq = 0.7 + (id % 5) * 0.4;
    const swing = Math.sin(2 * Math.PI * freq * t + phase);

    /* The channels whose calibrated value is a physical quantity get a
       plausible one, because a full-scale sine through the ADC formula reads as
       3000 mV of battery or 125 kPa of air and makes a calibrated plot useless
       for telling right from wrong. The rest keep the old full-scale sine,
       which is what makes an axis mix-up obvious. */
    const plausible = PLAUSIBLE_SAMPLES[id];
    if (plausible) {
      return Math.max(
        0,
        Math.round(plausible.centre + plausible.amplitude * swing),
      );
    }

    const full = width.unsigned
      ? (1 << (width.bytes * 8)) - 1
      : (1 << (width.bytes * 8 - 1)) - 1;
    if (width.unsigned) return Math.round(full * (0.5 + 0.3 * swing));
    return Math.round(full * 0.45 * swing);
  }

  /** `[0x00][ts u24 LE][channel values…]` for one sample. */
  function dataFrame(ids, ticks, n) {
    let size = 1 + 3;
    for (const id of ids) size += channelWidthFor(id, hardwareVersion).bytes;
    const out = new Uint8Array(size);
    out[0] = CMD.DATA_PACKET;
    out[1] = ticks & 0xff;
    out[2] = (ticks >> 8) & 0xff;
    out[3] = (ticks >> 16) & 0xff;
    let at = 4;
    for (const id of ids) {
      const width = channelWidthFor(id, hardwareVersion);
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

  /**
   * Where the stream's tick counter starts, which is a per-generation fact.
   *
   * On a **Shimmer3R** the packet timestamp is `RTC_get32()` — the low 24 bits
   * of the very counter `GET_RWC` reports as `RTC_get64()`
   * (`RTC/shimmer_rtc.h:25-28`; `Core/Src/rtc.c` gives the two identical
   * bodies). That identity is the whole reason a host can pin a Shimmer3R
   * stream to a wall clock exactly, so a mock that started the counter at zero
   * would let an aligned anchor look like it worked while placing every sample
   * up to 256 s from the truth — the error is bounded by the wrap, so it never
   * looks absurd enough to notice.
   *
   * On a **Shimmer3** it is a free-running counter since boot
   * (`Shimmer_Driver/5xx_HAL/hal_RTC.c`), and the real-world clock is that
   * counter plus a stored offset which never leaves the device. Zero is right
   * there: a host has to estimate the offset from the request round trip, and
   * a mock whose counter happened to agree with its clock would hide that.
   */
  function streamStartTicks() {
    if (hardwareVersion === 3) return 0;
    return Number(BigInt(Math.round(deviceNowMs() * 32.768)) & 0xffffffn);
  }

  function startStreaming() {
    if (streamTimer) return;
    const ids = channelIds();
    streamTicks = streamStartTicks();
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
    stopFactoryTest();
    if (sdRead) {
      clearInterval(sdRead.timer);
      sdRead = null;
    }
    state.streaming = false;
    state.logging = false;
  });

  // -------------------------------------------------------------------------
  // Factory self-test (SET_FACTORY_TEST)
  //
  // The firmware ACKs, then prints its report as RAW TEXT on the same link:
  // no opcode, no length, no CRC, one write per line, each write truncated
  // (not split) at MAX_TEST_REPORT_LENGTH = 128 characters — which drops that
  // line's own terminator and glues the next line onto it
  // (log-and-stream-common `Test/shimmer_test.c:69-88`,
  // `Comms/shimmer_bt_uart.c:1285-1293`). Reproduced here, truncation
  // included, because a host that cannot survive it cannot read a real report.
  // -------------------------------------------------------------------------

  /** What the firmware caps a single report write at. */
  const TEST_REPORT_MAX_CHARS = 128;
  /** Bytes per notification while framed — small enough to split every line. */
  const TEST_REPORT_NOTIFY_BYTES = 13;

  const TEST_START_BANNER =
    "//**************************** TEST START " +
    "************************************//\r\n";
  const TEST_END_BANNER =
    "//***************************** TEST END " +
    "*************************************//\r\n";

  const factoryTestOpts = opts.factoryTest ?? {};
  /** Milliseconds the firmware dwells on each LED step (`DELAY_BETWEEN_LED_CHANGES_MS`). */
  const testStepMs = Math.max(1, factoryTestOpts.stepMs ?? 2000);
  /** Report a failing unit: a FAIL line, an over-long line, and a fail mask. */
  const testFails = !!factoryTestOpts.fail;

  let testTimer = null;
  let testQueue = [];
  let testText = "";

  function stopFactoryTest() {
    if (testTimer) {
      clearTimeout(testTimer);
      testTimer = null;
    }
    testQueue = [];
    state.factoryTest.running = false;
  }

  /** Push one already-truncated entry onto the wire, chunked mid-line. */
  function emitTestChunkedText(text) {
    testText += text;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    const size = framed ? TEST_REPORT_NOTIFY_BYTES : dribbleBytes;
    for (let off = 0; off < bytes.length; off += size) {
      transport.notify(bytes.slice(off, off + size));
    }
  }

  function pumpFactoryTest() {
    testTimer = null;
    const entry = testQueue.shift();
    if (!entry) {
      state.factoryTest.running = false;
      return;
    }
    /* The firmware's own rule, applied before anything reaches the link:
       longer than the buffer and the tail — terminator and all — is lost. */
    emitTestChunkedText(
      entry.text.length > TEST_REPORT_MAX_CHARS
        ? entry.text.slice(0, TEST_REPORT_MAX_CHARS)
        : entry.text,
    );
    testTimer = setTimeout(pumpFactoryTest, entry.delayMs);
  }

  /**
   * `[0xA8][type]` — run one of the firmware's four self-tests.
   *
   * NACKed while sensing, exactly as `ShimBt_isCmdBlockedWhileSensing`
   * (`Comms/shimmer_bt_uart.c:2985`) refuses it. A type at or above
   * FACTORY_TEST_COUNT is NACKed here where the firmware ACKs and silently
   * runs nothing (`:1287`): a page cannot reach that case through its own
   * type list, and a mock that answered nothing would look like a dead link.
   */
  function handleFactoryTest(cmd) {
    if (cmd[0] !== CMD.SET_FACTORY_TEST) return false;
    if (state.streaming || state.logging) {
      reply([NACK]);
      return true;
    }
    const type = cmd[1] ?? 0;
    if (type >= FACTORY_TEST_TYPE_COUNT) {
      reply([NACK]);
      return true;
    }
    stopFactoryTest();
    // ACK first: `reply` defers by a macrotask, so the report cannot bury the
    // acknowledgement the host is waiting for — the firmware's own ordering,
    // where TASK_BT_RESPOND outranks TASK_FACTORY_TEST.
    reply([ACK]);
    state.factoryTest.runs += 1;
    state.factoryTest.lastType = type;
    state.factoryTest.running = true;
    testText = "";
    testQueue = buildFactoryTestReport(type);
    testTimer = setTimeout(pumpFactoryTest, REPLY_DELAY_MS + 1);
    return true;
  }

  /**
   * The report a Shimmer3R (or, with `hw=3`, a Shimmer3) prints, as a queue of
   * `{ text, delayMs }` writes — one entry per firmware `sendReport` call, so
   * the two-write model line and the paced LED narration reach the host the
   * way they really do.
   */
  function buildFactoryTestReport(type) {
    const line = (
      text,
      delayMs = Math.max(1, Math.round(testStepMs / 10)),
    ) => ({
      text,
      delayMs,
    });
    const led = (text) => line(text, testStepMs);
    const stateLine = (text) => line(text, Math.round(testStepMs * 2.5));
    const shimmer3 = hardwareVersion === 3;
    const isMain = type === FACTORY_TEST_TYPE.MAIN;
    const isIcs = type === FACTORY_TEST_TYPE.ICS;
    const isLeds = type === FACTORY_TEST_TYPE.LEDS;
    const isLedStates = type === FACTORY_TEST_TYPE.LED_STATES;
    const id = (n, rest) =>
      shimmer3 ? ` - ${rest}\r\n` : ` - S3R_TEST_${n} - ${rest}\r\n`;
    const out = [line(TEST_START_BANNER)];
    out.push(
      line(
        `Firmware version: v${fw.major}.${String(fw.minor).padStart(2, "0")}.` +
          `${String(fw.patch).padStart(3, "0")}\r\n`,
      ),
    );

    if (isIcs || isMain) {
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      if (!shimmer3) {
        out.push(
          line(
            `Date (yyyy-mm-dd): ${now.getUTCFullYear()}-` +
              `${p2(now.getUTCMonth() + 1)}-${p2(now.getUTCDate())}\r\n`,
          ),
          line(
            `Time (hh:mm:ss): ${p2(now.getUTCHours())}:` +
              `${p2(now.getUTCMinutes())}:${p2(now.getUTCSeconds())} (UTC)\r\n`,
          ),
          line("\r\n"),
          line("INFO: Temperature pass range set to 15-35 degC\r\n"),
        );
      }
      out.push(line("\r\n"), line("Shimmer model:\r\n"));
      /* Two writes, no terminator on the first: the firmware prints the card
         id and its SR revision separately (`hal_FactoryTest.c:414-419`), so a
         host that reassembles per notification would show a broken line. */
      out.push(
        line(
          shimmer3
            ? " - PASS: Shimmer3 GSR+"
            : " - S3R_TEST_0003 - PASS: Shimmer3R IMU",
        ),
        line(shimmer3 ? " (SR48-4-0)\r\n" : " (SR68-1-0)\r\n"),
      );

      out.push(line("\r\n"), line("MCU:\r\n"));
      if (shimmer3) {
        out.push(line(" - Last reset reason = Power on\r\n"));
      } else {
        out.push(
          line(" - Device ID = 1126\r\n"),
          line(" - Revision ID = 4104\r\n"),
          line(" - Unique ID = 0x0033002E3438510B00313437\r\n"),
        );
      }
      out.push(
        line(
          id(
            "0007",
            testFails
              ? "FAIL: VRef = 2900mV (3200-3400mV)"
              : "PASS: VRef = 3301mV (3200-3400mV)",
          ),
        ),
      );
      if (!shimmer3) {
        out.push(
          line(id("0008", "PASS: VCore = 1376mV (900-1800mV)")),
          line(id("0009", "PASS: VBatt pin = 1802mV (1750-1850mV)")),
          line(id("0010", "PASS: Temperature = 24 degC")),
          /* Deliberately over 128 characters in the failing build: the
             firmware would drop this line's terminator and glue the next
             line onto it, which is the case a report reader must survive. */
          line(
            testFails
              ? id(
                  "0028",
                  "FAIL: 32k LSE vs 16M HSE error not measurable " +
                    "(LSE not ready, L 0/32769 H 62501/62501, retries exhausted, " +
                    "drive ladder walked to MEDIUMHIGH)",
                )
              : id(
                  "0028",
                  "PASS: 32k LSE vs 16M HSE error = -9.3 ppm " +
                    "(limit +/-35.0 ppm, HSE-fixed caps rev)",
                ),
          ),
          line(" - LSE drive applied at boot: MEDIUMLOW\r\n"),
          line(" - I/O status:\r\n"),
          line("    - Docked: No\r\n"),
          line("    - BT connected: Yes\r\n"),
          line("    - Button pressed: No\r\n"),
          line("    - USB connected: No\r\n"),
          line("\r\n"),
          line("Battery:\r\n"),
          line(id("0011", "PASS: VBatt = 4012mV (2980-4750mV)")),
          line(id("0012", "PASS: Charger chip status = Charge is completed")),
          line(" - Determined charging status = Fully Charged\r\n"),
        );
      }

      out.push(line("\r\n"), line("SD Card:\r\n"));
      out.push(
        shimmer3
          ? line(" - PASS: SD card detected\r\n")
          : line(" - Manufacturer: SanDisk\r\n"),
      );
      if (!shimmer3) out.push(line(id("0013", "PASS: MCU read/write test")));

      out.push(line("\r\n"), line("BT Module:\r\n"));
      out.push(line(` - MAC ID: ${mac.toUpperCase()}\r\n`));
      if (shimmer3) {
        out.push(
          line(" - RN4678 V1.23\r\n"),
          line(" - PASS\r\n"),
          line(" - Counts:\r\n"),
          line("   - BT data-rate test blockages = 12\r\n"),
          line("   - BT disconnects while streaming = 0\r\n"),
        );
      } else {
        out.push(
          line(" - v01.04.18.18\r\n"),
          line(id("0014", "PASS: Correct BT firmware version")),
        );
      }

      if (shimmer3) {
        out.push(
          line("\r\n"),
          line("I2C:\r\n"),
          line(" - PASS: CAT24C16\r\n"),
          line(" - LSM303AH detected (self-test not implemented yet)\r\n"),
          line(" - MPU9x50 detected (self-test not implemented yet)\r\n"),
          line(" - BMP280 detected (self-test not implemented yet)\r\n"),
          line("\r\n"),
          line("SPI:\r\n"),
          line(" - PASS: ADS1292R Chip1 detect\r\n"),
          line(" - PASS: ADS1292R Chip2 detect\r\n"),
        );
      } else {
        out.push(
          line("\r\n"),
          line("SPI1:\r\n"),
          line(id("0015", "PASS: ADS7028")),
          line(id("0016", "PASS: LSM6DSV (27.31 degC)")),
          line(id("0017", "PASS: BMP390 (26.94 degC)")),
          line(id("0018", "ADXL371 test not applicable for this model")),
          line("SPI2:\r\n"),
          line(id("0019", "LIS3MDL test not applicable for this model")),
          line(id("0020", "PASS: LIS2DW12 (27.02 degC)")),
          line("SPI3:\r\n"),
          line(id("0021", "PASS: ADS1292R Chip1 detect")),
          line(id("0021", "PASS: ADS1292R Chip2 detect")),
          line("\r\n"),
          line("I2C1:\r\n"),
          line(id("0022", "PASS: LIS2MDL (27.10 degC)")),
          line(id("0023", "PASS: CAT24C16")),
          line("I2C4:\r\n"),
          line(id("0024", "I2C4 test not applicable for this model")),
          line(id("0025", "WARNING: GSR - Correct test rig not detected")),
          line("\r\n"),
          line("Microphone:\r\n"),
          line(id("0026", "PASS")),
        );
      }
    }

    if (isMain || isLeds) {
      out.push(line("\r\n"));
      out.push(
        line(shimmer3 ? "LED test:\r\n" : "LED test (S3R_TEST_0027):\r\n"),
      );
      const sequence = shimmer3
        ? [
            "All LEDs off",
            "Lower Green LED on",
            "Lower Yellow LED on",
            "Lower Red LED on",
            "Upper Green LED on",
            "Upper Blue LED on",
            "All LEDs off",
            "All LEDs on",
          ]
        : [
            "All LEDs off",
            "Lower Red LED on",
            "Lower Green LED on",
            "Lower Blue LED on",
            "Upper Red LED on",
            "Upper Green LED on",
            "Upper Blue LED on",
            "All LEDs off",
            "All LEDs on",
          ];
      for (const step of sequence) out.push(led(` - ${step}\r\n`));
    }

    if (isLedStates) {
      out.push(line("Testing Operational LED states - Start\r\n"));
      const groups = [
        ["BT Disabled:", ["Idle...", "SD Logging..."]],
        [
          "BT Enabled:",
          [
            "Idle...",
            "SD Logging...",
            "BT Streaming...",
            "BT Streaming and SD Logging...",
            "BT Connected...",
            "BT Connected and SD Logging...",
          ],
        ],
        [
          "SD Sync Enabled:",
          [
            "Idle...",
            "SD Logging waiting for initial sync (slave)...",
            "SD Logging waiting for initial sync (master)...",
            "SD Logging and BT advertising...",
            "SD Logging and syncing...",
          ],
        ],
        ["Other:", ["Configuring...", "Time not set..."]],
      ];
      for (const [heading, states] of groups) {
        out.push(line(`${heading}\r\n`));
        for (const s of states) out.push(stateLine(`\t-> ${s}\r\n`));
      }
      out.push(line("Testing Operational LED states - End\r\n"));
    }

    /* Only MAIN and ICS carry a verdict line — the two LED tests are watched,
       not scored, and set no bits (`Test/shimmer_test.c:43-55`). */
    if (isMain || isIcs) {
      out.push(
        line(
          testFails
            ? "\r\nOverall Result = FAIL (0x00000040)\r\n"
            : "\r\nOverall Result = PASS\r\n",
        ),
      );
    }
    out.push(line(TEST_END_BANNER));
    return out;
  }

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
    if (handleFactoryTest(cmd)) return;

    switch (op) {
      case CMD.INQUIRY:
        reply(concat([ACK], inquiryResponse()));
        return;

      /* SET_CRC takes effect INCLUDING its own ACK. The firmware sets the mode
         while processing this command's arguments (`shimmer_bt_uart.c:944`) and
         composes the ACK afterwards from the new mode (`:2422`), so that ACK
         already carries a CRC. Setting it after the reply here would model a
         device that does not exist, and would hide the one message a host
         receives framed differently from what it expects. An unrecognised
         value falls back to off rather than being rejected, as the firmware
         does (`ShimBt_setCrcMode`). */
      case CMD.SET_CRC: {
        const mode = cmd[1];
        crcMode = mode === 1 || mode === 2 ? mode : 0;
        reply([ACK]);
        return;
      }

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
        // firmware it can be answered mid-stream. Same frame as an
        // unsolicited push, built by the same function — see `statusResponse`.
        reply(concat([ACK], statusResponse()));
        return;

      case CMD.GET_PRESSURE_CALIBRATION_COEFFICIENTS: {
        /* `[0xA6][1 + n][sensorId][coeffs]` — the length byte counts the id
           (`Comms/shimmer_bt_uart.c:2064-2099`). A BMP581 sends the id alone,
           which is a SUCCESS: it compensates on-chip, and the firmware sends
           the id in-band precisely so a host can tell that from a NACK. */
        if (pressureMode === "nack") {
          reply([NACK]);
          return;
        }
        const fixture = PRESSURE_FIXTURES[pressureMode];
        if (!fixture) {
          // 'silent' models firmware old enough to have no such command at
          // all — it answers nothing, and the host times out.
          return;
        }
        reply([
          ACK,
          CMD.PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE,
          1 + fixture.coeffs.length,
          fixture.id,
          ...fixture.coeffs,
        ]);
        return;
      }

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

      case CMD.GET_CALIB_DUMP: {
        // [0x9A][len][offsetLo][offsetHi] → [0x99][len][offsetLo][offsetHi][data…]
        const len = cmd[1] ?? 0;
        const off = (cmd[2] ?? 0) | ((cmd[3] ?? 0) << 8);
        if (len < 1 || len > CALIB_MAX_PER_CALL || off >= calibRam.length) {
          reply([NACK]);
          return;
        }
        const out = new Uint8Array(4 + len);
        out[0] = CMD.RSP_CALIB_DUMP;
        out[1] = len;
        out[2] = off & 0xff;
        out[3] = (off >> 8) & 0xff;
        /* Short at the end of RAM rather than wrapping: `subarray` stops
           there and the rest of `out` stays zero, which is the flash read a
           real device does. */
        out.set(
          calibRam.subarray(off, Math.min(off + len, calibRam.length)),
          4,
        );
        reply(concat([ACK], out));
        return;
      }

      case CMD.SET_CALIB_DUMP: {
        // [0x98][len][offsetLo][offsetHi][data…]
        const len = cmd[1] ?? 0;
        const off = (cmd[2] ?? 0) | ((cmd[3] ?? 0) << 8);
        const data = cmd.subarray(4, 4 + len);
        /* Always ACKed, even when dropped. The firmware's handler ignores
           `ShimCalib_ramWrite`'s failure return, so a host that starts in the
           middle of the dump gets an ACK for a write that went nowhere — the
           single most surprising thing about this command, and worth
           reproducing rather than smoothing over. */
        reply([ACK]);
        if (len < 1 || len > CALIB_MAX_PER_CALL) {
          calibStats.discarded++;
          return;
        }
        if (off === 0) {
          if (data.length < 2) {
            calibStats.discarded++;
            return;
          }
          // +2: the u16 length field counts the bytes after itself.
          const total = (data[0] | (data[1] << 8)) + 2;
          if (total <= 2 || total > calibRam.length) {
            calibStaging = null;
            calibStats.discarded++;
            return;
          }
          calibStaging = { total, received: 0, buf: new Uint8Array(total) };
        } else if (!calibStaging || off !== calibStaging.received) {
          /* "starting with offset > 2 is not accepted" — and neither is a
             chunk that skips forward. Dropped, silently, exactly as the
             firmware drops it. */
          calibStaging = null;
          calibStats.discarded++;
          return;
        }
        const room = Math.min(data.length, calibStaging.total - off);
        calibStaging.buf.set(data.subarray(0, room), off);
        calibStaging.received = off + room;
        if (calibStaging.received >= calibStaging.total) {
          /* The firmware applies the dump the moment the bytes it has add up
             to the length its own header declared, without waiting for
             UPD_CALIB_DUMP. */
          calibRam.fill(0);
          calibRam.set(calibStaging.buf, 0);
          calibStaging = null;
        }
        return;
      }

      case CMD.UPD_CALIB_DUMP:
        // Apply the in-RAM dump to the configuration bytes and the SD header.
        // Nothing here models the configuration side, so this only counts.
        calibStats.updates++;
        reply([ACK]);
        return;

      case CMD.GET_DAUGHTER_CARD_ID: {
        // [0x66][len][offset] → [0x65][len][data…], capped at one page
        const len = cmd[1] ?? 0;
        const off = cmd[2] ?? 0;
        if (len < 1 || off + len > srBoardPage.length) {
          reply([NACK]);
          return;
        }
        const out = new Uint8Array(2 + len);
        out[0] = CMD.DAUGHTER_CARD_ID_RESPONSE;
        out[1] = len;
        out.set(srBoardPage.subarray(off, off + len), 2);
        reply(concat([ACK], out));
        return;
      }

      case CMD.GET_BT_VERSION_STR: {
        /* [0xa1] → [0xa2][strlen][ASCII…]. No arguments, and the length is
           the firmware's own `strlen()` of the module's reply — which is why
           a zero-length answer is a legitimate one and not modelled as a
           NACK. Sent through `reply()` whole: on a framed link that makes it
           one notification the SDK has to split by the declared length, and
           on an unframed one the dribble path exercises reassembly. */
        const bytes = [];
        for (const ch of btVersionString) bytes.push(ch.charCodeAt(0) & 0xff);
        /* Truncated to the firmware's own buffer, so the length byte always
           matches the payload that follows it. Without this a `&btVersion=`
           longer than 255 characters would wrap the length byte while the
           full string still went out, and the host would sit waiting for the
           wrong number of bytes. The firmware cannot report more than this
           either - `btVerStrResponse` is `char[100]`. */
        const capped = bytes.slice(0, BT_VERSION_MAX_BYTES);
        reply(
          concat([ACK, CMD.BT_VERSION_STR_RESPONSE, capped.length], capped),
        );
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
        let ticks = BigInt(Math.round(deviceNowMs() * 32.768));
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
        // Re-seat the running clock on what the host wrote: from here the
        // sensor keeps its own time, and keeps drifting at `rtc.ppm`.
        rtc.devMsAtSet = Number(ticks) / 32.768;
        rtc.setAtHostMs = Date.now();
        // What the "Clock set" status bit means: not that the clock reads
        // something, but that a host has set it since the sensor last lost
        // power (`RTC_isRwcTimeSet`).
        state.rwcSet = true;
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
        // The status bit the firmware reports is the toggle state, not a
        // command echo (`shimmerStatus.toggleLedRedCmd`).
        state.redLedOn = !state.redLedOn;
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
