/**
 * Container for a single decoded sensor frame.
 *
 * Mirrors the ObjectCluster concept from the Shimmer C# SDK:
 * a named, typed bag of raw and calibrated signal values produced
 * by parsing one data packet from a device.
 *
 * @example
 * ```ts
 * const oc = new ObjectCluster('MyShimmer3R');
 * oc.add('GYRO_X', rawVal, null, 'raw');
 * oc.add('GYRO_X', degPerSec, 'deg/s', 'cal');
 *
 * const cal = oc.get('GYRO_X', 'cal');
 * console.log(cal?.value, cal?.unit); // e.g. 12.5  "deg/s"
 * ```
 */
class ObjectCluster {
    constructor(deviceId) {
        this.deviceId = deviceId;
        this.fields = [];
        this.raw = null;
    }
    /**
     * Append a named field to this cluster.
     *
     * @param name   Signal name, e.g. `'GYRO_X'`.
     * @param value  Numeric value.
     * @param unit   Optional unit string, e.g. `'deg/s'`, `'µS'`, `'ticks'`.
     * @param kind   `'raw'` for ADC counts, `'cal'` for calibrated units, or `null`.
     */
    add(name, value, unit = null, kind = null) {
        this.fields.push({ name, value, unit, kind });
    }
    /**
     * Look up a field by name and optional kind.
     *
     * When both a raw and a calibrated version exist for the same signal name,
     * pass `kind` to disambiguate.
     *
     * @returns The matching field, or `null` if not found.
     */
    get(name, kind = null) {
        return this.fields.find((f) => f.name === name && (kind === null || f.kind === kind)) ?? null;
    }
    /**
     * Return all fields that match the given name (regardless of kind).
     */
    getAll(name) {
        return this.fields.filter((f) => f.name === name);
    }
}

/**
 * Abstract base class shared by all Shimmer device clients.
 *
 * Provides:
 * - A `debug` flag and `_log` helper.
 * - Stub implementations of `onStatus` and `onStreamFrame` callback properties.
 * - Abstract stubs for `connect`, `disconnect`, `startStreaming`, and `stopStreaming`
 *   that concrete sub-classes must override.
 *
 * Sub-classes should call `this._emitStatus(msg)` to surface status strings to
 * the application layer without depending on a particular event-emitter library.
 */
class BaseShimmerClient {
    constructor(opts = {}) {
        /**
         * Invoked whenever the client emits a human-readable status message
         * (e.g. "GATT connected", "Sampling rate ACKed. Applied ≈ 51.200 Hz").
         */
        this.onStatus = null;
        /**
         * Invoked for every fully-decoded sensor frame while streaming.
         * The exact shape depends on the concrete sub-class:
         * - `Shimmer3RClient` passes an {@link ObjectCluster}.
         * - `VerisenseBleDevice` passes a streaming packet object (see that class).
         */
        this.onStreamFrame = null;
        this.debug = opts.debug ?? true;
    }
    /** Log to console when debug is enabled. */
    _log(...args) {
        if (this.debug)
            console.log('[Shimmer]', ...args);
    }
    /** Emit a status message to `onStatus` and to the debug log. */
    _emitStatus(msg) {
        this._log(msg);
        this.onStatus?.(msg);
    }
}

/**
 * Shimmer3R BLE protocol opcodes.
 * Values taken directly from the Shimmer3 firmware header.
 */
const OPCODES = Object.freeze({
    DATA_PACKET: 0x00,
    INQUIRY_COMMAND: 0x01,
    INQUIRY_RESPONSE: 0x02,
    GET_SAMPLING_RATE_COMMAND: 0x03,
    SAMPLING_RATE_RESPONSE: 0x04,
    SET_SAMPLING_RATE_COMMAND: 0x05,
    TOGGLE_LED_COMMAND: 0x06,
    START_STREAMING_COMMAND: 0x07,
    SET_SENSORS_COMMAND: 0x08,
    SET_WR_ACCEL_RANGE_COMMAND: 0x09,
    WR_ACCEL_RANGE_RESPONSE: 0x0a,
    GET_WR_ACCEL_RANGE_COMMAND: 0x0b,
    SET_CONFIG_SETUP_BYTES_COMMAND: 0x0e,
    CONFIG_SETUP_BYTES_RESPONSE: 0x0f,
    GET_CONFIG_SETUP_BYTES_COMMAND: 0x10,
    SET_LN_ACCEL_CALIBRATION_COMMAND: 0x11,
    LN_ACCEL_CALIBRATION_RESPONSE: 0x12,
    GET_LN_ACCEL_CALIBRATION_COMMAND: 0x13,
    SET_GYRO_CALIBRATION_COMMAND: 0x14,
    GYRO_CALIBRATION_RESPONSE: 0x15,
    GET_GYRO_CALIBRATION_COMMAND: 0x16,
    SET_MAG_CALIBRATION_COMMAND: 0x17,
    MAG_CALIBRATION_RESPONSE: 0x18,
    GET_MAG_CALIBRATION_COMMAND: 0x19,
    SET_WR_ACCEL_CALIBRATION_COMMAND: 0x1a,
    WR_ACCEL_CALIBRATION_RESPONSE: 0x1b,
    GET_WR_ACCEL_CALIBRATION_COMMAND: 0x1c,
    STOP_STREAMING_COMMAND: 0x20,
    SET_GSR_RANGE_COMMAND: 0x21,
    GSR_RANGE_RESPONSE: 0x22,
    GET_GSR_RANGE_COMMAND: 0x23,
    DEVICE_VERSION_RESPONSE: 0x25,
    GET_ALL_CALIBRATION_COMMAND: 0x2c,
    ALL_CALIBRATION_RESPONSE: 0x2d,
    GET_FW_VERSION_COMMAND: 0x2e,
    FW_VERSION_RESPONSE: 0x2f,
    SET_CHARGE_STATUS_LED_COMMAND: 0x30,
    CHARGE_STATUS_LED_RESPONSE: 0x31,
    GET_CHARGE_STATUS_LED_COMMAND: 0x32,
    BUFFER_SIZE_RESPONSE: 0x35,
    GET_BUFFER_SIZE_COMMAND: 0x36,
    SET_MAG_GAIN_COMMAND: 0x37,
    MAG_GAIN_RESPONSE: 0x38,
    GET_MAG_GAIN_COMMAND: 0x39,
    SET_MAG_SAMPLING_RATE_COMMAND: 0x3a,
    MAG_SAMPLING_RATE_RESPONSE: 0x3b,
    GET_MAG_SAMPLING_RATE_COMMAND: 0x3c,
    UNIQUE_SERIAL_RESPONSE: 0x3d,
    GET_UNIQUE_SERIAL_COMMAND: 0x3e,
    GET_DEVICE_VERSION_COMMAND: 0x3f,
    SET_WR_ACCEL_SAMPLING_RATE_COMMAND: 0x40,
    WR_ACCEL_SAMPLING_RATE_RESPONSE: 0x41,
    GET_WR_ACCEL_SAMPLING_RATE_COMMAND: 0x42,
    SET_WR_ACCEL_LPMODE_COMMAND: 0x43,
    WR_ACCEL_LPMODE_RESPONSE: 0x44,
    GET_WR_ACCEL_LPMODE_COMMAND: 0x45,
    SET_WR_ACCEL_HRMODE_COMMAND: 0x46,
    WR_ACCEL_HRMODE_RESPONSE: 0x47,
    GET_WR_ACCEL_HRMODE_COMMAND: 0x48,
    SET_GYRO_RANGE_COMMAND: 0x49,
    GYRO_RANGE_RESPONSE: 0x4a,
    GET_GYRO_RANGE_COMMAND: 0x4b,
    SET_GYRO_SAMPLING_RATE_COMMAND: 0x4c,
    GYRO_SAMPLING_RATE_RESPONSE: 0x4d,
    GET_GYRO_SAMPLING_RATE_COMMAND: 0x4e,
    SET_ALT_ACCEL_RANGE_COMMAND: 0x4f,
    ALT_ACCEL_RANGE_RESPONSE: 0x50,
    GET_ALT_ACCEL_RANGE_COMMAND: 0x51,
    SET_PRESSURE_OVERSAMPLING_RATIO_COMMAND: 0x52,
    PRESSURE_OVERSAMPLING_RATIO_RESPONSE: 0x53,
    GET_PRESSURE_OVERSAMPLING_RATIO_COMMAND: 0x54,
    BMP180_CALIBRATION_COEFFICIENTS_RESPONSE: 0x58,
    GET_BMP180_CALIBRATION_COEFFICIENTS_COMMAND: 0x59,
    RESET_TO_DEFAULT_CONFIGURATION_COMMAND: 0x5a,
    RESET_CALIBRATION_VALUE_COMMAND: 0x5b,
    MPU9150_MAG_SENS_ADJ_VALS_RESPONSE: 0x5c,
    GET_MPU9150_MAG_SENS_ADJ_VALS_COMMAND: 0x5d,
    SET_INTERNAL_EXP_POWER_ENABLE_COMMAND: 0x5e,
    INTERNAL_EXP_POWER_ENABLE_RESPONSE: 0x5f,
    GET_INTERNAL_EXP_POWER_ENABLE_COMMAND: 0x60,
    SET_EXG_REGS_COMMAND: 0x61,
    EXG_REGS_RESPONSE: 0x62,
    GET_EXG_REGS_COMMAND: 0x63,
    SET_DAUGHTER_CARD_ID_COMMAND: 0x64,
    DAUGHTER_CARD_ID_RESPONSE: 0x65,
    GET_DAUGHTER_CARD_ID_COMMAND: 0x66,
    SET_DAUGHTER_CARD_MEM_COMMAND: 0x67,
    DAUGHTER_CARD_MEM_RESPONSE: 0x68,
    GET_DAUGHTER_CARD_MEM_COMMAND: 0x69,
    SET_DERIVED_CHANNEL_BYTES: 0x6d,
    DERIVED_CHANNEL_BYTES_RESPONSE: 0x6e,
    GET_DERIVED_CHANNEL_BYTES: 0x6f,
    START_SDBT_COMMAND: 0x70,
    STATUS_RESPONSE: 0x71,
    GET_STATUS_COMMAND: 0x72,
    SET_TRIAL_CONFIG_COMMAND: 0x73,
    TRIAL_CONFIG_RESPONSE: 0x74,
    GET_TRIAL_CONFIG_COMMAND: 0x75,
    SET_CENTER_COMMAND: 0x76,
    CENTER_RESPONSE: 0x77,
    GET_CENTER_COMMAND: 0x78,
    SET_SHIMMERNAME_COMMAND: 0x79,
    SHIMMERNAME_RESPONSE: 0x7a,
    GET_SHIMMERNAME_COMMAND: 0x7b,
    SET_EXPID_COMMAND: 0x7c,
    EXPID_RESPONSE: 0x7d,
    GET_EXPID_COMMAND: 0x7e,
    SET_MYID_COMMAND: 0x7f,
    MYID_RESPONSE: 0x80,
    GET_MYID_COMMAND: 0x81,
    SET_NSHIMMER_COMMAND: 0x82,
    NSHIMMER_RESPONSE: 0x83,
    GET_NSHIMMER_COMMAND: 0x84,
    SET_CONFIGTIME_COMMAND: 0x85,
    CONFIGTIME_RESPONSE: 0x86,
    GET_CONFIGTIME_COMMAND: 0x87,
    DIR_RESPONSE: 0x88,
    GET_DIR_COMMAND: 0x89,
    INSTREAM_CMD_RESPONSE: 0x8a,
    SET_CRC_COMMAND: 0x8b,
    SET_INFOMEM_COMMAND: 0x8c,
    INFOMEM_RESPONSE: 0x8d,
    GET_INFOMEM_COMMAND: 0x8e,
    SET_RWC_COMMAND: 0x8f,
    RWC_RESPONSE: 0x90,
    GET_RWC_COMMAND: 0x91,
    START_LOGGING_COMMAND: 0x92,
    STOP_LOGGING_COMMAND: 0x93,
    VBATT_RESPONSE: 0x94,
    GET_VBATT_COMMAND: 0x95,
    TEST_CONNECTION_COMMAND: 0x96,
    STOP_SDBT_COMMAND: 0x97,
    SET_CALIB_DUMP_COMMAND: 0x98,
    RSP_CALIB_DUMP_COMMAND: 0x99,
    GET_CALIB_DUMP_COMMAND: 0x9a,
    UPD_CALIB_DUMP_COMMAND: 0x9b,
    UPD_SDLOG_CFG_COMMAND: 0x9c,
    BMP280_CALIBRATION_COEFFICIENTS_RESPONSE: 0x9f,
    GET_BMP280_CALIBRATION_COEFFICIENTS_COMMAND: 0xa0,
    GET_BT_VERSION_STR_COMMAND: 0xa1,
    BT_VERSION_STR_RESPONSE: 0xa2,
    SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE: 0xa3,
    SET_DATA_RATE_TEST: 0xa4,
    DATA_RATE_TEST_RESPONSE: 0xa5,
    PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE: 0xa6,
    GET_PRESSURE_CALIBRATION_COEFFICIENTS_COMMAND: 0xa7,
    SET_FACTORY_TEST: 0xa8,
    SET_ALT_ACCEL_CALIBRATION_COMMAND: 0xa9,
    ALT_ACCEL_CALIBRATION_RESPONSE: 0xaa,
    GET_ALT_ACCEL_CALIBRATION_COMMAND: 0xab,
    SET_ALT_ACCEL_SAMPLING_RATE_COMMAND: 0xac,
    ALT_ACCEL_SAMPLING_RATE_RESPONSE: 0xad,
    GET_ALT_ACCEL_SAMPLING_RATE_COMMAND: 0xae,
    SET_ALT_MAG_CALIBRATION_COMMAND: 0xaf,
    ALT_MAG_CALIBRATION_RESPONSE: 0xb0,
    GET_ALT_MAG_CALIBRATION_COMMAND: 0xb1,
    SET_ALT_MAG_SAMPLING_RATE_COMMAND: 0xb2,
    ALT_MAG_SAMPLING_RATE_RESPONSE: 0xb3,
    GET_ALT_MAG_SAMPLING_RATE_COMMAND: 0xb4,
    DUMMY_COMMAND: 0xb5,
    RESET_BT_ERROR_COUNTS: 0xb6,
    SET_FEATURE: 0xb7,
    SET_SD_SYNC_COMMAND: 0xe0,
    SD_SYNC_RESPONSE: 0xe1,
    NACK_COMMAND_PROCESSED: 0xfe,
    ACK_COMMAND_PROCESSED: 0xff,
});
/** Default BLE service / characteristic UUIDs for Shimmer3R. */
const SHIMMER3R_DEFAULTS = Object.freeze({
    SERVICE_UUID: '65333333-a115-11e2-9e9a-0800200ca100',
    /** Write characteristic (host → device). */
    CHAR_RX_UUID: '65333333-a115-11e2-9e9a-0800200ca102',
    /** Notify characteristic (device → host). */
    CHAR_TX_UUID: '65333333-a115-11e2-9e9a-0800200ca101',
});
/**
 * Timestamp field descriptors keyed by width.
 * Shimmer3R firmware ≥ v1.0.22 always uses u24.
 */
const TIMESTAMP_FIELD = Object.freeze({
    u16: { name: 'TIMESTAMP', fmt: 'u16', endian: 'le', sizeBytes: 2 },
    u24: { name: 'TIMESTAMP', fmt: 'u24', endian: 'le', sizeBytes: 3 },
});
/** GSR signal name constant used in ObjectCluster fields. */
const GSR_NAME = 'GSR';
/** ADC limit below which GSR range-3 calibration is clamped. */
const GSR_UNCAL_LIMIT_RANGE3 = 683;
/**
 * Shimmer3R GSR resistance min/max per hardware range (kΩ).
 * Index 0 = range 0 (8–63 kΩ) … index 3 = range 3 (680–4700 kΩ).
 */
const SHIMMER3_GSR_RESISTANCE_MIN_MAX_KOHMS = [
    [8.0, 63.0],
    [63.0, 220.0],
    [220.0, 680.0],
    [680.0, 4700.0],
];

/**
 * Sensor enable bitmasks for Shimmer3 / Shimmer3R.
 *
 * Values are 24-bit integers sent as the payload of SET_SENSORS_CMD.
 * Multiple sensors are ORed together.
 *
 * @example
 * ```ts
 * const mask = SensorBitmapShimmer3.SENSOR_GYRO | SensorBitmapShimmer3.SENSOR_A_ACCEL;
 * await client.setSensors(mask);
 * ```
 */
const SensorBitmapShimmer3 = Object.freeze({
    SENSOR_A_ACCEL: 0x000080,
    SENSOR_GYRO: 0x000040,
    SENSOR_MAG: 0x000020,
    SENSOR_GSR: 0x000004,
    SENSOR_VBATT: 0x002000,
    SENSOR_D_ACCEL: 0x001000,
    SENSOR_PRESSURE: 0x040000,
    SENSOR_EXG1_24BIT: 0x000010,
    SENSOR_EXG2_24BIT: 0x000008,
    SENSOR_EXG1_16BIT: 0x100000,
    SENSOR_EXG2_16BIT: 0x080000,
    SENSOR_BRIDGE_AMP: 0x008000,
    SENSOR_ACCEL_ALT: 0x400000,
    SENSOR_MAG_ALT: 0x200000,
    SENSOR_EXT_A0: 0x000002,
    SENSOR_EXT_A1: 0x000001,
    SENSOR_EXT_A2: 0x000800,
    SENSOR_INT_A3: 0x000400,
    SENSOR_INT_A0: 0x000200,
    SENSOR_INT_A1: 0x000100,
    SENSOR_INT_A2: 0x800000,
});

/**
 * Mapping from Shimmer3R channel ID byte to its format descriptor.
 * Channel IDs are reported in the INQUIRY_RSP payload.
 */
const CHANNEL_FORMATS = Object.freeze({
    0x00: { name: 'LN_ACCEL_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x01: { name: 'LN_ACCEL_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x02: { name: 'LN_ACCEL_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x04: { name: 'WR_ACCEL_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x05: { name: 'WR_ACCEL_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x06: { name: 'WR_ACCEL_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x14: { name: 'HG_ACCEL_X', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
    0x15: { name: 'HG_ACCEL_Y', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
    0x16: { name: 'HG_ACCEL_Z', fmt: 'i12*', endian: 'le', sizeBytes: 2 },
    0x0a: { name: 'GYRO_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x0b: { name: 'GYRO_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x0c: { name: 'GYRO_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x07: { name: 'MAG_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x08: { name: 'MAG_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x09: { name: 'MAG_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x1d: { name: 'Exg1_Status', fmt: 'u8', endian: 'le', sizeBytes: 1 },
    0x20: { name: 'Exg2_Status', fmt: 'u8', endian: 'le', sizeBytes: 1 },
    0x1e: { name: 'Exg1_CH1_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
    0x1f: { name: 'Exg1_CH2_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
    0x21: { name: 'Exg2_CH1_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
    0x22: { name: 'Exg2_CH2_24Bit', fmt: 'i24', endian: 'be', sizeBytes: 3 },
    0x23: { name: 'Exg1_CH1_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
    0x24: { name: 'Exg1_CH2_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
    0x25: { name: 'Exg2_CH1_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
    0x26: { name: 'Exg2_CH2_16Bit', fmt: 'i16', endian: 'be', sizeBytes: 2 },
    0x12: { name: 'PPG', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    0x1c: { name: 'GSR', fmt: 'u16', endian: 'le', sizeBytes: 2 },
});

// ---------------------------------------------------------------------------
// ADC helpers
// ---------------------------------------------------------------------------
/**
 * Convert a Shimmer3R 12-bit ADC value to millivolts.
 *
 * @param unCalData  Raw 12-bit ADC sample.
 * @param offset     ADC offset (typically 0).
 * @param vRefP      Reference voltage in volts (typically 3 V for Shimmer3R).
 * @param gain       Amplifier gain (typically 1).
 * @returns Calibrated voltage in millivolts.
 */
function calibrateU12AdcValue(unCalData, offset, vRefP, gain) {
    return (unCalData - offset) * ((vRefP * 1000) / gain / 4095);
}
/**
 * Convert a Shimmer3R ADC channel value to millivolts using the
 * default Shimmer3R ADC parameters (Vref = 3 V, gain = 1, offset = 0).
 *
 * @param unCalData Raw 12-bit ADC sample.
 * @returns Voltage in millivolts.
 */
function calibrateShimmer3RAdcChannel(unCalData) {
    return calibrateU12AdcValue(unCalData, 0, 3, 1);
}
// ---------------------------------------------------------------------------
// GSR calibration
// ---------------------------------------------------------------------------
/**
 * Convert a raw GSR ADC sample to skin resistance (kΩ) using the
 * Shimmer3R amplifier equation.
 *
 * Reference resistors per range (kΩ): [40.2, 287.0, 1000.0, 3300.0].
 *
 * @param gsrUncalibratedData Raw 12-bit GSR ADC value.
 * @param range               Hardware range index 0–3.
 * @returns Resistance in kΩ.
 */
function calibrateGsrDataToResistanceFromAmplifierEq(gsrUncalibratedData, range) {
    const SHIMMER3_REF_KOHMS = [40.2, 287.0, 1000.0, 3300.0];
    const rFeedback = SHIMMER3_REF_KOHMS[range];
    const volts = calibrateShimmer3RAdcChannel(gsrUncalibratedData) / 1000.0; // mV → V
    const rSource = rFeedback / (volts / 0.5 - 1.0);
    return rSource;
}
/**
 * Clamp a GSR resistance value to the physical limits of a given range.
 *
 * When `gsrRangeSetting === 4` (auto-range) no clamping is applied.
 *
 * @param gsrResistanceKOhms Calibrated resistance in kΩ.
 * @param gsrRangeSetting    Range 0–3 (fixed) or 4 (auto).
 * @returns Clamped resistance in kΩ.
 */
function nudgeGsrResistance(gsrResistanceKOhms, gsrRangeSetting) {
    if (gsrRangeSetting === 4)
        return gsrResistanceKOhms;
    const [minVal, maxVal] = SHIMMER3_GSR_RESISTANCE_MIN_MAX_KOHMS[gsrRangeSetting];
    return Math.max(minVal, Math.min(maxVal, gsrResistanceKOhms));
}
// ---------------------------------------------------------------------------
// ExG (ADS1292R) oversampling ratio
// ---------------------------------------------------------------------------
/**
 * Determine the ADS1292R oversampling ratio config byte for a given
 * Shimmer3R sampling rate.
 *
 * This value is ORed into the lower 3 bits of ExG config byte index 4.
 *
 * @param samplingRate Shimmer3R sampling rate in Hz (must be ≥ 0).
 * @returns Oversampling ratio index 0–6.
 */
function getOversamplingRatioADS1292R(samplingRate) {
    if (!Number.isFinite(samplingRate)) {
        throw new TypeError('samplingRate must be a finite number');
    }
    if (samplingRate < 0) {
        throw new RangeError('samplingRate must be non-negative');
    }
    if (samplingRate < 125)
        return 0;
    if (samplingRate < 250)
        return 1;
    if (samplingRate < 500)
        return 2;
    if (samplingRate < 1000)
        return 3;
    if (samplingRate < 2000)
        return 4;
    if (samplingRate < 4000)
        return 5;
    return 6; // ≥ 4000 Hz
}

/**
 * Low-level byte-manipulation utilities used by the Shimmer3R protocol decoder.
 * All functions are pure and have no side-effects, making them straightforward
 * to unit-test without a BLE device.
 */
/** Concatenate two Uint8Arrays. */
function concatU8(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}
/** Read a 16-bit unsigned integer, little-endian. */
function u16le$1(b, o) {
    return (b[o] | (b[o + 1] << 8)) >>> 0;
}
/** Read a 16-bit unsigned integer, big-endian. */
function u16be(b, o) {
    return ((b[o] << 8) | b[o + 1]) >>> 0;
}
/** Read a 24-bit unsigned integer, little-endian. */
function u24le$1(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) >>> 0;
}
/** Read a 24-bit unsigned integer, big-endian. */
function u24be(b, o) {
    return ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;
}
/** Sign-extend a 16-bit value to a signed integer. */
function sign16(v) {
    return v & 0x8000 ? v | 0xffff0000 : v;
}
/** Sign-extend a 24-bit value to a signed integer. */
function sign24(v) {
    return v & 0x800000 ? v | 0xff000000 : v;
}
/** Format a byte as a 2-digit uppercase hex string. */
function hex2(v) {
    return v.toString(16).padStart(2, '0').toUpperCase();
}

function toArrayBuffer(u8) {
    if (u8.buffer instanceof ArrayBuffer) {
        if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength)
            return u8.buffer;
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    }
    const out = new Uint8Array(u8.byteLength);
    out.set(u8);
    return out.buffer;
}

// ---------------------------------------------------------------------------
// Shimmer3RClient
// ---------------------------------------------------------------------------
/**
 * Web Bluetooth client for the Shimmer3R sensor platform.
 *
 * Implements the ACK-first command flow used by Shimmer3R firmware ≥ v1.0.22:
 * every configuration command awaits an ACK (0xFF) before resolving.
 * Streaming data frames are framed with a DATA preamble (0x00).
 *
 * @example
 * ```ts
 * const client = new Shimmer3RClient({ timestampFmt: 'u24', debug: true });
 * client.onStatus = (msg) => console.log(msg);
 * client.onStreamFrame = (oc) => {
 *   const gz = oc.get('GYRO_Z', 'raw')?.value;
 *   console.log('gz =', gz);
 * };
 *
 * await client.connect();
 * await client.setSamplingRate(51.2);
 * await client.setSensors(SensorBitmapShimmer3.SENSOR_GYRO);
 * await client.startStreaming();
 * ```
 */
class Shimmer3RClient extends BaseShimmerClient {
    constructor(opts = {}) {
        super(opts);
        this.device = null;
        this.server = null;
        this.rx = null;
        this.tx = null;
        // Protocol state
        this._rxBuf = new Uint8Array(0);
        this._temps = new Set();
        this.schema = null;
        this._lastAckRemainder = null;
        this._expectingAck = 0;
        this._streaming = false;
        this._lastTs = 0;
        // Cached device configuration
        this.enabledSensors = 0x000000;
        this.samplingRateHz = 0;
        this.gsrRangeSetting = 0;
        this.ExpPower = 0;
        /** Minimum valid GSR conductance in µS (below this, connectivity = "Disconnected"). */
        this.LIMIT_MIN_VALID_USIEMENS = 0.03;
        // Callbacks
        this.onInquiry = null;
        this.onExpPowerChanged = null;
        // ---------------------------------------------------------------------------
        // BLE notify handler
        // ---------------------------------------------------------------------------
        this._handleNotify = (evt) => {
            const chunk = new Uint8Array(evt.target.value.buffer);
            this._log('Notify len=', chunk.length, 'data=', chunk);
            // 1) Consume an expected ACK
            if (chunk.length >= 1 &&
                chunk[0] === OPCODES.ACK_COMMAND_PROCESSED &&
                (this._expectingAck ?? 0) > 0) {
                this._log('ACK detected at start of notify (expected)');
                this._expectingAck = Math.max(0, this._expectingAck - 1);
                const remainder = chunk.slice(1);
                this._lastAckRemainder = remainder.length ? remainder : null;
                this._emitTemp(new Uint8Array([OPCODES.ACK_COMMAND_PROCESSED]));
                if (this._lastAckRemainder) {
                    if (this._streaming && this._lastAckRemainder[0] === OPCODES.DATA_PACKET) {
                        this._log('Appending DATA remainder after ACK to stream buffer');
                        this._rxBuf = concatU8(this._rxBuf, this._lastAckRemainder);
                    }
                    else {
                        this._log('Forwarding non-DATA remainder to control handlers');
                        this._emitTemp(this._lastAckRemainder);
                    }
                    this._lastAckRemainder = null;
                }
                return;
            }
            // 2) During streaming, all bytes are data-plane
            if (this._streaming) {
                this._rxBuf = concatU8(this._rxBuf, chunk);
            }
            else {
                this._emitTemp(chunk);
                if (chunk.length && chunk[0] === OPCODES.DATA_PACKET) {
                    this._rxBuf = concatU8(this._rxBuf, chunk);
                }
            }
            // 3) Try parsing if schema is available
            if (this.schema) {
                try {
                    this._parseBySchema();
                }
                catch (e) {
                    this._log('parseBySchema error:', e);
                }
            }
        };
        this.serviceUUID = opts.serviceUUID ?? SHIMMER3R_DEFAULTS.SERVICE_UUID;
        this.rxUUID = opts.rxUUID ?? SHIMMER3R_DEFAULTS.CHAR_RX_UUID;
        this.txUUID = opts.txUUID ?? SHIMMER3R_DEFAULTS.CHAR_TX_UUID;
        this.forceTimestampFmt = opts.timestampFmt ?? 'u24';
    }
    _log(...args) {
        if (this.debug)
            console.log('[Shimmer3R]', ...args);
    }
    // ---------------------------------------------------------------------------
    // Connection management
    // ---------------------------------------------------------------------------
    async connect() {
        this._emitStatus('Requesting Bluetooth device…');
        this.device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [this.serviceUUID] }],
            optionalServices: [this.serviceUUID],
        });
        this._emitStatus(`Selected: ${this.device.name ?? 'Shimmer3R'}`);
        this.server = await this.device.gatt.connect();
        this._emitStatus('GATT connected');
        const svc = await this.server.getPrimaryService(this.serviceUUID);
        this.rx = await svc.getCharacteristic(this.rxUUID);
        this.tx = await svc.getCharacteristic(this.txUUID);
        this._emitStatus('RX/TX obtained');
        await this.tx.startNotifications();
        this.tx.addEventListener('characteristicvaluechanged', this._handleNotify);
        this._emitStatus('Notifications started');
    }
    async disconnect() {
        try {
            if (this.tx) {
                try {
                    await this.tx.stopNotifications();
                }
                catch {
                    /* ignore */
                }
                this.tx.removeEventListener('characteristicvaluechanged', this._handleNotify);
            }
            if (this.device?.gatt?.connected)
                this.device.gatt.disconnect();
        }
        finally {
            this.device = this.server = this.rx = this.tx = null;
            this._rxBuf = new Uint8Array(0);
            this.schema = null;
            this._streaming = false;
            this.ExpPower = 0;
            this._emitStatus('Disconnected');
        }
    }
    // ---------------------------------------------------------------------------
    // Configuration commands
    // ---------------------------------------------------------------------------
    /**
     * Control the internal expansion power rail (required for ExG/EMG/ECG).
     * @param expPower 0 = disable, 1 = enable.
     */
    async setInternalExpPower(expPower) {
        if (expPower !== 0 && expPower !== 1)
            throw new Error('expPower must be 0 (off) or 1 (on)');
        if (!this.rx)
            throw new Error('Not connected (RX missing)');
        const cmd = new Uint8Array([OPCODES.SET_INTERNAL_EXP_POWER_ENABLE_COMMAND, expPower]);
        this._emitStatus(`SET_INTERNAL_EXP_POWER_ENABLE_CMD → ${expPower ? 'ON' : 'OFF'} waiting for ACK…`);
        const ackRemainder = await this._writeExpectingAck(cmd, 1500);
        this._emitStatus(`Expansion power ${expPower ? 'enabled' : 'disabled'} (ACK received).`);
        this.ExpPower = expPower;
        try {
            this.onExpPowerChanged?.(expPower);
        }
        catch (e) {
            this._log('onExpPowerChanged handler error', e);
        }
        return { expPower, ackRemainder };
    }
    /**
     * Set the GSR measurement range.
     * @param gsrRange 0 = 8–63 kΩ, 1 = 63–220 kΩ, 2 = 220–680 kΩ, 3 = 680–4700 kΩ, 4 = Auto.
     */
    async setGSRRange(gsrRange) {
        if (!Number.isInteger(gsrRange) || gsrRange < 0 || gsrRange > 4) {
            throw new Error('gsrRange must be 0–4');
        }
        if (!this.rx)
            throw new Error('Not connected (RX missing)');
        const cmd = new Uint8Array([OPCODES.SET_GSR_RANGE_COMMAND, gsrRange & 0xff]);
        this._emitStatus('SET_GSR_RANGE → waiting for ACK…');
        const ackRemainder = await this._writeExpectingAck(cmd, 1500);
        this._emitStatus('SET_GSR_RANGE (ACK received).');
        this.gsrRangeSetting = gsrRange;
        return { gsrRange, ackRemainder };
    }
    getInternalExpPower() {
        return this.ExpPower;
    }
    getEnabledSensors() {
        return this.enabledSensors;
    }
    /**
     * Enable sensors via a 24-bit bitmask.
     * Automatically performs an Inquiry after ACK to rebuild the stream schema.
     */
    async setSensors(sensors) {
        if (!Number.isFinite(sensors))
            throw new Error('sensors must be a finite number');
        if (!this.rx)
            throw new Error('Not connected (RX missing)');
        sensors = (sensors >>> 0) & 0xffffff;
        const b1 = sensors & 0xff;
        const b2 = (sensors >>> 8) & 0xff;
        const b3 = (sensors >>> 16) & 0xff;
        const cmd = new Uint8Array([OPCODES.SET_SENSORS_COMMAND, b1, b2, b3]);
        this._emitStatus(`SET_SENSORS_CMD → bitmask=0x${sensors.toString(16).toUpperCase().padStart(6, '0')} waiting for ACK…`);
        const ackRemainder = await this._writeExpectingAck(cmd, 1500);
        this._emitStatus(`Sensors ACK received. Bitmask 0x${sensors.toString(16).toUpperCase().padStart(6, '0')} applied.`);
        try {
            this._emitStatus('Performing automatic inquiry to refresh schema…');
            const info = await this.inquiry();
            this.enabledSensors = info.schema.enabledSensors;
            this._emitStatus(`Inquiry complete. Enabled sensors: 0x${this.enabledSensors.toString(16).toUpperCase()}`);
        }
        catch (err) {
            this._emitStatus(`Inquiry after setSensors failed: ${err.message}`);
        }
        return { sensors, ackRemainder, enabledSensors: this.enabledSensors };
    }
    /**
     * Set the sampling rate.
     * The firmware expects a 16-bit divisor: `divisor = floor(32768 / rateHz)`.
     */
    async setSamplingRate(rateHz) {
        if (!Number.isFinite(rateHz) || rateHz <= 0) {
            throw new Error('Sampling rate must be a positive number (Hz)');
        }
        if (!this.rx)
            throw new Error('Not connected (RX missing)');
        let divisor = Math.floor(32768 / rateHz);
        divisor = Math.max(1, Math.min(0xffff, divisor));
        const lsb = divisor & 0xff;
        const msb = (divisor >> 8) & 0xff;
        const cmd = new Uint8Array([OPCODES.SET_SAMPLING_RATE_COMMAND, lsb, msb]);
        this._emitStatus(`Set sampling rate → ${rateHz.toFixed(3)} Hz (divisor=${divisor}) — waiting for ACK…`);
        const ackRemainder = await this._writeExpectingAck(cmd, 1500);
        const appliedHz = 32768 / divisor;
        this.samplingRateHz = appliedHz;
        this._emitStatus(`Sampling rate ACKed. Applied ≈ ${this.samplingRateHz.toFixed(3)} Hz`);
        return { requestedHz: rateHz, appliedHz, divisor, ackRemainder };
    }
    // ---------------------------------------------------------------------------
    // Inquiry
    // ---------------------------------------------------------------------------
    /** Send INQUIRY_CMD and parse the response to build the stream schema. */
    async inquiry() {
        this._emitStatus('INQUIRY_CMD → waiting for ACK then RSP…');
        const remainder = await this._writeExpectingAck(new Uint8Array([OPCODES.INQUIRY_COMMAND]), 1500);
        if (remainder && remainder[0] === OPCODES.INQUIRY_RESPONSE) {
            this._log('Using post-ACK remainder as response');
            const info = this._interpretInquiryResponseShimmer3R(remainder);
            this.onInquiry?.(info);
            return info;
        }
        const rsp = await this._waitForResponse(OPCODES.INQUIRY_RESPONSE, 2000);
        this._emitStatus(`Inquiry RSP (${rsp.length} bytes)`);
        const info = this._interpretInquiryResponseShimmer3R(rsp);
        this.onInquiry?.(info);
        return info;
    }
    // ---------------------------------------------------------------------------
    // ExG configuration helpers
    // ---------------------------------------------------------------------------
    /** Enable EMG (ADS1292R) in 16-bit mode on EXG1 & EXG2. */
    async enableEMG16Bit() {
        if (!this.rx)
            throw new Error('Not connected (RX missing)');
        await this._writeExgPages(new Uint8Array([
            0x61, 0x00, 0x00, 0x0a, 0x02, 0xa8, 0x10, 0x69, 0x60, 0x20, 0x00, 0x00, 0x02, 0x03,
        ]), new Uint8Array([
            0x61, 0x01, 0x00, 0x0a, 0x02, 0xa0, 0x10, 0xe1, 0xe1, 0x00, 0x00, 0x00, 0x02, 0x01,
        ]));
        this._emitStatus('EMG 16-bit enabled on EXG1 & EXG2. Schema updated.');
    }
    /** Enable EXG test signal in 16-bit mode (useful for verifying ExG hardware). */
    async enableEXGTestSignal16Bit() {
        if (!this.rx)
            throw new Error('Not connected (RX missing)');
        await this._writeExgPages(new Uint8Array([
            0x61, 0x00, 0x00, 0x0a, 0x02, 0xab, 0x10, 0x15, 0x15, 0x00, 0x00, 0x00, 0x02, 0x01,
        ]), new Uint8Array([
            0x61, 0x01, 0x00, 0x0a, 0x02, 0xa3, 0x10, 0x15, 0x15, 0x00, 0x00, 0x00, 0x02, 0x01,
        ]));
        this._emitStatus('EXG test signal 16-bit enabled. Schema updated.');
    }
    /** Enable ECG in 16-bit mode on EXG1 & EXG2. */
    async enableECG16Bit() {
        if (!this.rx)
            throw new Error('Not connected (RX missing)');
        await this._writeExgPages(new Uint8Array([
            0x61, 0x00, 0x00, 0x0a, 0x02, 0xa8, 0x10, 0x40, 0x40, 0x2d, 0x00, 0x00, 0x02, 0x03,
        ]), new Uint8Array([
            0x61, 0x01, 0x00, 0x0a, 0x02, 0xa0, 0x10, 0x40, 0x47, 0x00, 0x00, 0x00, 0x02, 0x01,
        ]));
        this._emitStatus('ECG 16-bit enabled on EXG1 & EXG2. Schema updated.');
    }
    async _writeExgPages(exg1, exg2) {
        const oversamplingRatio = getOversamplingRatioADS1292R(this.samplingRateHz);
        exg1 = new Uint8Array(exg1);
        exg2 = new Uint8Array(exg2);
        exg1[4] = (((exg1[4] >> 3) << 3) | oversamplingRatio) & 0xff;
        exg2[4] = (((exg2[4] >> 3) << 3) | oversamplingRatio) & 0xff;
        await this._write(exg1);
        await new Promise((r) => setTimeout(r, 200));
        await this._write(exg2);
        await new Promise((r) => setTimeout(r, 50));
        const targetBits = (SensorBitmapShimmer3.SENSOR_EXG1_16BIT | SensorBitmapShimmer3.SENSOR_EXG2_16BIT) >>> 0;
        const newMask = ((this.enabledSensors >>> 0) | targetBits) & 0xffffff;
        await this.setSensors(newMask);
    }
    // ---------------------------------------------------------------------------
    // Streaming
    // ---------------------------------------------------------------------------
    async startStreaming() {
        if (!this.schema)
            this._emitStatus('Starting stream without schema (not recommended).');
        this._emitStatus('START_STREAM → waiting for ACK…');
        const remainder = await this._writeExpectingAck(new Uint8Array([OPCODES.START_STREAMING_COMMAND]), 1500);
        this._streaming = true;
        if (remainder?.length) {
            if (remainder[0] === OPCODES.DATA_PACKET) {
                this._rxBuf = concatU8(this._rxBuf, remainder);
            }
            else {
                this._emitTemp(remainder);
            }
        }
        this._emitStatus('START_STREAM ACK received; frames should follow');
    }
    async stopStreaming() {
        this._emitStatus('STOP_STREAM → sending (no ACK wait)…');
        try {
            await this._write(new Uint8Array([OPCODES.STOP_STREAMING_COMMAND]));
            this._emitStatus('STOP_STREAM command sent (skipped ACK wait).');
        }
        catch (err) {
            this._emitStatus(`STOP_STREAM write failed: ${err.message}`);
        }
        this._streaming = false;
        this._rxBuf = new Uint8Array(0);
        this._emitStatus('Streaming stopped.');
    }
    /** Start streaming AND SD card logging simultaneously. */
    async startStreamingAndLogging() {
        if (!this.schema)
            this._emitStatus('Starting stream without schema (not recommended).');
        this._emitStatus('START_BT_STREAM_SD_LOGGING → waiting for ACK…');
        const remainder = await this._writeExpectingAck(new Uint8Array([OPCODES.START_SDBT_COMMAND]), 1500);
        this._streaming = true;
        if (remainder?.length) {
            if (remainder[0] === OPCODES.DATA_PACKET) {
                this._rxBuf = concatU8(this._rxBuf, remainder);
            }
            else {
                this._emitTemp(remainder);
            }
        }
        this._emitStatus('START_BT_STREAM_SD_LOGGING ACK received; frames should follow');
    }
    /** Stop streaming AND SD card logging. */
    async stopStreamingAndLogging() {
        this._emitStatus('STOP_BT_STREAM_SD_LOGGING → sending…');
        try {
            await this._write(new Uint8Array([OPCODES.STOP_SDBT_COMMAND]));
        }
        catch (err) {
            this._emitStatus(`STOP_BT_STREAM_SD_LOGGING write failed: ${err.message}`);
        }
        this._streaming = false;
        this._rxBuf = new Uint8Array(0);
        this._emitStatus('Streaming + logging stopped.');
    }
    // ---------------------------------------------------------------------------
    // Inquiry response / schema building
    // ---------------------------------------------------------------------------
    _interpretInquiryResponseShimmer3R(u8) {
        let base = 0;
        if (u8[0] === OPCODES.INQUIRY_RESPONSE && u8.length >= 2)
            base = 1;
        const adcRaw = u16le$1(u8, base + 0);
        const samplingRateHz = 32768 / adcRaw;
        this.samplingRateHz = samplingRateHz;
        const cfg = BigInt(u8[base + 2]) |
            (BigInt(u8[base + 3]) << 8n) |
            (BigInt(u8[base + 4]) << 16n) |
            (BigInt(u8[base + 5]) << 24n) |
            (BigInt(u8[base + 6]) << 32n) |
            (BigInt(u8[base + 7]) << 40n) |
            (BigInt(u8[base + 8]) << 48n);
        const internalExpPower = Number((cfg >> 24n) & 0x1n);
        const gsrRange = Number((cfg >> 25n) & 0x7n);
        this.ExpPower = internalExpPower;
        this.gsrRangeSetting = gsrRange;
        const numCh = u8[base + 9] ?? 0;
        const bufSize = u8[base + 10] ?? 0;
        const chStart = base + 11;
        const channelIds = [...u8.slice(chStart, chStart + numCh)];
        const schema = this._buildSchemaFromChannels(channelIds, this.forceTimestampFmt ?? 'u24');
        this.schema = schema;
        this._log(`Schema built: timestampFmt=${schema.timestampFmt}, fields=${schema.fields.length}, enabledSensors=0x${schema.enabledSensors.toString(16)}`);
        this._emitStatus(`Expansion power ${this.ExpPower ? 'enabled' : 'disabled'} (ACK received).`);
        return {
            opcode: u8[0],
            adcRaw,
            samplingRateHz,
            numChannels: numCh,
            bufferSize: bufSize,
            channelIds,
            schema,
            bytes: u8.slice(0),
        };
    }
    _buildSchemaFromChannels(channelIds, timestampFmt) {
        const fields = [];
        const ts = timestampFmt === 'u24' ? TIMESTAMP_FIELD.u24 : TIMESTAMP_FIELD.u16;
        let packetSize = 1 + ts.sizeBytes; // 1 = preamble 0x00
        let enabledSensors = 0;
        for (const id of channelIds) {
            const fmt = CHANNEL_FORMATS[id];
            if (!fmt) {
                fields.push({ id, name: `CH_${hex2(id)}`, fmt: 'i16', endian: 'le', sizeBytes: 2 });
                packetSize += 2;
                continue;
            }
            fields.push({ id, ...fmt });
            packetSize += fmt.sizeBytes ?? 2;
            switch (id) {
                case 0x00:
                case 0x01:
                case 0x02:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_A_ACCEL;
                    break;
                case 0x04:
                case 0x05:
                case 0x06:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_D_ACCEL;
                    break;
                case 0x14:
                case 0x15:
                case 0x16:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_ACCEL_ALT;
                    break;
                case 0x07:
                case 0x08:
                case 0x09:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_MAG;
                    break;
                case 0x0a:
                case 0x0b:
                case 0x0c:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_GYRO;
                    break;
                case 0x12:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_INT_A1;
                    break;
                case 0x1c:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_GSR;
                    break;
                case 0x23:
                case 0x24:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_EXG1_16BIT;
                    break;
                case 0x25:
                case 0x26:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_EXG2_16BIT;
                    break;
                case 0x1e:
                case 0x1f:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_EXG1_24BIT;
                    break;
                case 0x21:
                case 0x22:
                    enabledSensors |= SensorBitmapShimmer3.SENSOR_EXG2_24BIT;
                    break;
                default:
                    console.warn(`⚠️ Unmapped channel ID 0x${id.toString(16)} — added as generic i16.`);
            }
        }
        this.enabledSensors = enabledSensors;
        return { timestampFmt, fields, frameBytes: packetSize, enabledSensors, dataPreambleByte: 0x00 };
    }
    // ---------------------------------------------------------------------------
    // GSR calibration (applied inline during stream parsing)
    // ---------------------------------------------------------------------------
    _calibrateData(oc) {
        const snapshot = [...oc.fields];
        for (const field of snapshot) {
            if (field.name === GSR_NAME) {
                const rawField = oc.get(GSR_NAME, 'raw');
                const gsrraw = rawField?.value ?? null;
                if (gsrraw === null)
                    continue;
                let adc12 = gsrraw & 0x0fff;
                let currentRange = this.gsrRangeSetting;
                if (currentRange === 4) {
                    currentRange = (gsrraw >> 14) & 0x03;
                }
                if (currentRange === 3 && adc12 < GSR_UNCAL_LIMIT_RANGE3) {
                    adc12 = GSR_UNCAL_LIMIT_RANGE3;
                }
                let gsrkOhm = calibrateGsrDataToResistanceFromAmplifierEq(adc12, currentRange);
                gsrkOhm = nudgeGsrResistance(gsrkOhm, this.gsrRangeSetting);
                const gsrConductanceUSiemens = (1.0 / gsrkOhm) * 1000;
                oc.add(GSR_NAME, gsrConductanceUSiemens, 'uSiemens', 'cal');
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Stream frame parser
    // ---------------------------------------------------------------------------
    _parseBySchema() {
        const sch = this.schema;
        const preamble = sch.dataPreambleByte;
        const frameBytes = sch.frameBytes >>> 0;
        const tsBytes = sch.timestampFmt === 'u16' ? 2 : 3;
        const TS_MOD = tsBytes === 3 ? 16777216 : 65536;
        let buf = this._rxBuf;
        let frames = 0;
        let drops = 0;
        let anomalies = 0;
        while (buf.length >= frameBytes * 2) {
            if (buf[0] === preamble && buf[frameBytes] === preamble) {
                let ts1, ts2;
                try {
                    ts1 = tsBytes === 2 ? u16le$1(buf, 1) : u24le$1(buf, 1);
                    ts2 = tsBytes === 2 ? u16le$1(buf, frameBytes + 1) : u24le$1(buf, frameBytes + 1);
                }
                catch {
                    buf = buf.subarray(1);
                    drops++;
                    continue;
                }
                const dt = (((ts2 - ts1) % TS_MOD) + TS_MOD) % TS_MOD;
                if (dt === 0) {
                    buf = buf.subarray(1);
                    drops++;
                    continue;
                }
                const frame = buf.subarray(0, frameBytes);
                try {
                    let cursor = 1;
                    const oc = new ObjectCluster(this.device?.name ?? 'Shimmer3R');
                    const ts = tsBytes === 2 ? u16le$1(frame, cursor) : u24le$1(frame, cursor);
                    cursor += tsBytes;
                    oc.add('TIMESTAMP', ts, 'ticks', 'raw');
                    for (const f of sch.fields) {
                        if (cursor + f.sizeBytes > frame.length) {
                            throw new Error(`short frame: need ${f.sizeBytes} @${cursor}, have ${frame.length}`);
                        }
                        let v;
                        switch (f.fmt) {
                            case 'i16':
                                v = f.endian === 'be' ? sign16(u16be(frame, cursor)) : sign16(u16le$1(frame, cursor));
                                break;
                            case 'u16':
                                v = f.endian === 'be' ? u16be(frame, cursor) : u16le$1(frame, cursor);
                                break;
                            case 'i24':
                                v = f.endian === 'be' ? sign24(u24be(frame, cursor)) : sign24(u24le$1(frame, cursor));
                                break;
                            case 'u24':
                                v = f.endian === 'be' ? u24be(frame, cursor) : u24le$1(frame, cursor);
                                break;
                            case 'i12*': {
                                const msb = frame[cursor] & 0xff;
                                const lsb = frame[cursor + 1] & 0xff;
                                const raw12 = (msb << 4) | (lsb >> 4);
                                v = raw12 & 0x800 ? raw12 - 0x1000 : raw12;
                                break;
                            }
                            case 'u8':
                                v = frame[cursor];
                                break;
                            default:
                                v = u16le$1(frame, cursor);
                        }
                        cursor += f.sizeBytes;
                        oc.add(f.name, v, null, 'raw');
                    }
                    if (this._lastTs) {
                        const dLast = (((ts - this._lastTs) % TS_MOD) + TS_MOD) % TS_MOD;
                        if (dLast === 0) {
                            anomalies++;
                            this._log(`⚠️ Timestamp anomaly#${anomalies}: ts=${ts}, last=${this._lastTs}, Δ=0`);
                        }
                    }
                    this._lastTs = ts;
                    this._calibrateData(oc);
                    this.onStreamFrame?.(oc);
                    frames++;
                    buf = buf.subarray(frameBytes);
                }
                catch (e) {
                    this._log('⚠️ frame decode error → sliding 1 byte', e.message);
                    buf = buf.subarray(1);
                    drops++;
                }
                continue;
            }
            buf = buf.subarray(1);
            drops++;
            if (this.debug && drops % 64 === 1) {
                this._log(`resync: dropped ${drops} byte(s) so far; bufLen=${buf.length}`);
            }
        }
        this._rxBuf = buf;
        if (drops && drops % 512 === 0)
            this._lastTs = 0;
        if (this.debug && (frames || drops)) {
            this._log(`parse: frames=${frames}, drops=${drops}, leftover=${this._rxBuf.length}`);
        }
    }
    // ---------------------------------------------------------------------------
    // Low-level transport helpers
    // ---------------------------------------------------------------------------
    async _write(u8) {
        if (!this.rx)
            throw new Error('Not connected (RX missing)');
        this._log('Write', u8);
        await this.rx.writeValue(toArrayBuffer(u8));
    }
    async _writeExpectingAck(u8, ackTimeoutMs = 1000) {
        this._expectingAck++;
        try {
            await this._write(u8);
            return await this._waitForAck(ackTimeoutMs);
        }
        catch (e) {
            this._expectingAck = Math.max(0, this._expectingAck - 1);
            throw e;
        }
    }
    _waitForAck(timeoutMs = 1000) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this._offTemp(handler);
                reject(new Error('ACK timeout'));
            }, timeoutMs);
            const handler = (chunk) => {
                if (!chunk || chunk.length === 0)
                    return;
                if (chunk.length === 1 && chunk[0] === OPCODES.ACK_COMMAND_PROCESSED) {
                    clearTimeout(t);
                    this._offTemp(handler);
                    const rem = this._lastAckRemainder;
                    this._lastAckRemainder = null;
                    resolve(rem ?? null);
                    return;
                }
                if (chunk[0] === OPCODES.ACK_COMMAND_PROCESSED && chunk.length > 1) {
                    clearTimeout(t);
                    this._offTemp(handler);
                    resolve(chunk.slice(1));
                }
            };
            this._onTemp(handler);
        });
    }
    _waitForResponse(expectedOpcode, timeoutMs = 1500) {
        if (this._lastAckRemainder && this._lastAckRemainder[0] === expectedOpcode) {
            const rem = this._lastAckRemainder;
            this._lastAckRemainder = null;
            return Promise.resolve(rem);
        }
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this._offTemp(handler);
                reject(new Error('Response timeout'));
            }, timeoutMs);
            const handler = (chunk) => {
                if (!chunk || chunk.length === 0)
                    return;
                if (chunk.length === 1 && chunk[0] === OPCODES.ACK_COMMAND_PROCESSED)
                    return;
                if (chunk[0] === expectedOpcode) {
                    clearTimeout(t);
                    this._offTemp(handler);
                    resolve(chunk);
                }
            };
            this._onTemp(handler);
        });
    }
    _onTemp(fn) {
        this._temps.add(fn);
    }
    _offTemp(fn) {
        this._temps.delete(fn);
    }
    _emitTemp(buf) {
        this._temps.forEach((fn) => {
            try {
                fn(buf);
            }
            catch (e) {
                this._log('temp handler error', e);
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Nordic UART Service (NUS) UUIDs used by Verisense devices
// ---------------------------------------------------------------------------
/** NUS primary service UUID. */
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
/** NUS TX characteristic UUID (host writes to this). */
const NUS_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
/** NUS RX characteristic UUID (host subscribes to notifications from this). */
const NUS_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
/** Nordic Secure DFU primary service UUID (0xFE59). */
const NORDIC_DFU_SERVICE = '0000fe59-0000-1000-8000-00805f9b34fb';
/** Nordic DFU control-point characteristic UUID. */
const NORDIC_DFU_CONTROL_CHAR = '8ec90001-f315-4f60-9fb8-838830daea50';
/** Nordic DFU packet characteristic UUID. */
const NORDIC_DFU_PACKET_CHAR = '8ec90002-f315-4f60-9fb8-838830daea50';
/** Nordic buttonless DFU characteristic UUID (write 0x01 to reboot to bootloader). */
const NORDIC_DFU_BUTTONLESS_CHAR = '8ec90003-f315-4f60-9fb8-838830daea50';
// ---------------------------------------------------------------------------
// Verisense protocol command/property constants
// ---------------------------------------------------------------------------
/** Upper-nibble command classes used in protocol headers. */
const ASM_COMMAND = Object.freeze({
    READ: 0x10,
    WRITE: 0x20,
    RESPONSE: 0x30,
    ACK: 0x40,
    NACK_BAD_HEADER_COMMAND: 0x50,
    NACK_BAD_HEADER_PROPERTY: 0x60,
    NACK_GENERIC: 0x70,
    ACK_NEXT_STAGE: 0x80,
});
/** Lower-nibble property IDs used in protocol headers. */
const ASM_PROPERTY = Object.freeze({
    STATUS1: 0x01,
    DATA: 0x02,
    PRODUCTION_CONFIGURATION: 0x03,
    OPERATIONAL_CONFIGURATION: 0x04,
    TIME: 0x05,
    DFU_MODE: 0x06,
    PENDING_EVENTS: 0x07,
    TEST_MODE: 0x08,
    DEBUG_COMMAND: 0x09,
    STREAM_MODE: 0x0a,
    DEVICE_DISCONNECT: 0x0b,
    STATUS2: 0x0c,
});
/** Stream mode payload values. */
const STREAM_MODE = Object.freeze({
    ENABLE: 0x01,
    DISABLE: 0x02,
});
/** Test mode IDs documented by Verisense firmware. */
const TEST_MODE_ID = Object.freeze({
    STOP: 0x00,
    FLASH_8MB_1: 0x01,
    FLASH_8MB_2: 0x02,
    FLASH_128MB_512MB: 0x03,
    EEPROM: 0x04,
    ACCEL1_LIS2DW12: 0x05,
    BATTERY_VOLTAGE: 0x06,
    USB_POWER: 0x07,
    ACCEL2_GYRO_LSM6DS3: 0x08,
    PPG_MAX86XXX: 0x09,
    BIOZ_MAX30002: 0x0b,
    ACCEL2_GYRO_LSM6DSV: 0x0c,
    MAG_LIS2MDL: 0x0d,
    TEST_REPORT: 0xfe,
    ALL_TESTS: 0xff,
});
/** Debug command IDs documented by Verisense firmware. */
const DEBUG_COMMAND_ID = Object.freeze({
    FLASH_LOOKUP_TABLE_READ: 0x01,
    FLASH_LOOKUP_TABLE_ERASE: 0x02,
    RWC_SCHEDULER_READ: 0x03,
    ERASE_128MB_512MB_FLASH: 0x04,
    ERASE_8MB_FLASH_1: 0x05,
    ERASE_8MB_FLASH_2: 0x06,
    ERASE_OPERATIONAL_CONFIG: 0x07,
    ERASE_PRODUCTION_CONFIG: 0x08,
    CLEAR_PENDING_EVENTS: 0x09,
    ERASE_FLASH_AND_LOOKUP_TABLE: 0x0a,
    TEST_DATA_TRANSFER_LOOP: 0x0b,
    LOAD_TEST_LOOKUP_TABLE: 0x0c,
    LED_TEST: 0x0d,
    MAX86XXX_LED_TEST: 0x0e,
    CHECK_PAYLOAD_CRC_ERRORS: 0x0f,
    READ_EVENT_LOG: 0x10,
    POWER_PROFILER_TEST: 0x11,
    READ_RECORD_BUFFER_DETAILS: 0x12,
    SYSTEM_RESET: 0x13,
    IC_POWER_CONSUMPTION_TEST: 0x14,
    DELETE_ALL_BONDS: 0x15,
});
// ---------------------------------------------------------------------------
// Operational config byte offsets
// ---------------------------------------------------------------------------
/**
 * Byte indices into the Verisense operational config blob (`op[OP_IDX.xxx]`).
 * Index 0 is the config version byte (must be 0x5A for a valid config).
 */
const OP_IDX = Object.freeze({
    GEN_CFG_0: 1,
    GEN_CFG_1: 2,
    GEN_CFG_2: 3,
    GEN_CFG_3: 4,
    ACCEL1_CFG_0: 5,
    ACCEL1_CFG_1: 6,
    ACCEL1_CFG_2: 7,
    ACCEL1_CFG_3: 8,
    GYRO_ACCEL2_CFG_0: 10,
    GYRO_ACCEL2_CFG_1: 11,
    GYRO_ACCEL2_CFG_2: 12,
    GYRO_ACCEL2_CFG_3: 13,
    GYRO_ACCEL2_CFG_4: 14,
    GYRO_ACCEL2_CFG_5: 15,
    GYRO_ACCEL2_CFG_6: 16,
    GYRO_ACCEL2_CFG_7: 17,
    START_TIME: 21,
    END_TIME: 25,
    INACTIVE_TIMEOUT: 29,
    BLE_RETRY_COUNT: 30,
    BLE_TX_POWER: 31,
    BLE_DATA_TRANS_WKUP_INT_HRS: 32,
    BLE_DATA_TRANS_WKUP_TIME: 33,
    BLE_DATA_TRANS_WKUP_DUR: 35,
    BLE_DATA_TRANS_RETRY_INT: 36,
    BLE_STATUS_WKUP_INT_HRS: 38,
    BLE_STATUS_WKUP_TIME: 39,
    BLE_STATUS_WKUP_DUR: 41,
    BLE_STATUS_RETRY_INT: 42,
    BLE_RTC_SYNC_WKUP_INT_HRS: 44,
    BLE_RTC_SYNC_WKUP_TIME: 45,
    BLE_RTC_SYNC_WKUP_DUR: 47,
    BLE_RTC_SYNC_RETRY_INT: 48,
    ADC_CHANNEL_SETTINGS_0: 50,
    ADC_CHANNEL_SETTINGS_1: 51,
    ADAPTIVE_SCHEDULER_INT: 52,
    ADAPTIVE_SCHEDULER_FAILCOUNT_MAX: 54,
    PPG_REC_DUR_SECS_LSB: 55,
    PPG_REC_DUR_SECS_MSB: 56,
    PPG_REC_INT_MINS_LSB: 57,
    PPG_REC_INT_MINS_MSB: 58,
    PPG_FIFO_CONFIG: 59,
    PPG_MODE_CONFIG2: 60,
    PPG_MA_DEFAULT: 61,
    PPG_MA_MAX_RED_IR: 62,
    PPG_MA_MAX_GREEN_BLUE: 63,
    PPG_AGC_TARGET_PERCENT_OF_RANGE: 64,
    PPG_MA_LED_PILOT: 66,
    PPG_DAC1_CROSSTALK: 67,
    PPG_DAC2_CROSSTALK: 68,
    PPG_DAC3_CROSSTALK: 69,
    PPG_DAC4_CROSSTALK: 70,
    PROX_AGC_MODE: 71,
});
/**
 * Factory test type selection byte sent as the last byte of a TEST_REPORT (0xFE) payload.
 * Mirrors the firmware `factory_test_t` enum.
 */
const FACTORY_TEST = Object.freeze({
    MAIN: 0,
    LEDS: 1,
    ICS: 2,
    LED_STATES: 3,
});

/** Read a 16-bit unsigned integer, little-endian. */
function u16le(b0, b1) {
    return (b1 << 8) | b0;
}
/** Read a signed 16-bit integer at byte offset `off`, little-endian. */
function i16le(bytes, off) {
    const v = bytes[off] | (bytes[off + 1] << 8);
    return v & 0x8000 ? v - 0x10000 : v;
}
/** Read a 24-bit unsigned integer at byte offset `off`, little-endian. */
function u24le(bytes, off) {
    return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16)) >>> 0;
}
/** Read a 16-bit unsigned integer at byte offset `off`, little-endian (full-array form). */
function u16le_at(bytes, off) {
    return (bytes[off] | (bytes[off + 1] << 8)) >>> 0;
}
/** Return current time in milliseconds. */
function nowMillis() {
    return Date.now();
}
/**
 * Compute CRC-16/CCITT-FALSE over `bytes`.
 *
 * Parameters: poly=0x1021, init=0xFFFF, xorOut=0x0000.
 * Matches the C# `ComputeCRC` implementation used by Verisense firmware.
 */
function crc16_ccitt_false(bytes) {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i] << 8;
        for (let b = 0; b < 8; b++) {
            crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
            crc &= 0xffff;
        }
    }
    return crc & 0xffff;
}
/**
 * Extract the CRC that was appended to a logged payload (last 2 bytes, LE).
 */
function getOriginalCrcLE(payload) {
    const n = payload.length;
    return (payload[n - 2] | (payload[n - 1] << 8)) >>> 0;
}
/**
 * Compute the CRC of a logged payload, excluding the trailing 2 CRC bytes,
 * matching the C# `ComputeCRC(payload, 0, payload.Length - 2)` call.
 */
function computeCrcLikeCSharp(payload) {
    return crc16_ccitt_false(payload.subarray(0, payload.length - 2));
}
/**
 * Convert any reasonable representation of an operational config to a
 * `Uint8Array`. Throws if the input type is unrecognised.
 */
function normalizeOperationalConfig(payload) {
    if (!payload)
        return null;
    if (payload instanceof Uint8Array)
        return payload;
    if (payload instanceof ArrayBuffer)
        return new Uint8Array(payload);
    if (Array.isArray(payload))
        return new Uint8Array(payload);
    if (payload.buffer instanceof ArrayBuffer) {
        const p = payload;
        return new Uint8Array(p.buffer, p.byteOffset ?? 0, p.byteLength ?? p.buffer.byteLength);
    }
    throw new Error('normalizeOperationalConfig: unsupported payload type');
}
/** Alias for arbitrary protocol byte payload normalization. */
function normalizeBytePayload(payload) {
    return normalizeOperationalConfig(payload);
}
/**
 * Derive the 6-digit pairing PIN from a Verisense unique identifier.
 *
 * The PIN is built from digits 2, 4 and 6 (1-based) of the identifier,
 * followed by the decimal value of the final byte padded to 3 digits.
 */
function computeVerisensePairingPin(uniqueId) {
    const normalized = String(uniqueId ?? '')
        .trim()
        .replace(/^Verisense-/i, '');
    if (!/^[0-9a-fA-F]{8,}$/.test(normalized)) {
        throw new Error('computeVerisensePairingPin: uniqueId must be a hex identifier string');
    }
    if (normalized.length < 6) {
        throw new Error('computeVerisensePairingPin: uniqueId must be at least 6 hex characters');
    }
    const prefix = `${normalized[1]}${normalized[3]}${normalized[5]}`;
    const suffixHex = normalized.slice(-2);
    const suffixDec = Number.parseInt(suffixHex, 16);
    return `${prefix}${suffixDec.toString().padStart(3, '0')}`;
}
const PROD_CONFIG_FLAG_DFU_ENABLED = 1 << 0;
const LOG_EVENT_NAMES = {
    0: 'NONE',
    1: 'BATTERY_FALL',
    2: 'BATTERY_RECOVER',
    3: 'WRITE_TO_FLASH_SUCCESS',
    4: 'WRITE_TO_FLASH_FAIL_GENERAL',
    5: 'WRITE_TO_FLASH_FULL',
    6: 'WRITE_TO_FLASH_FAIL_CHECK_ADDR_FREE',
    7: 'WRITE_TO_FLASH_FAIL_LOW_BATT_CHECK_ADDR_FREE',
    8: 'WRITE_TO_FLASH_FAIL_LOW_BATT_FLASH_ON',
    9: 'WRITE_TO_FLASH_FAIL_LOW_BATT_FLASH_WRITE',
    10: 'WRITE_TO_FLASH_FAIL_LOW_BATT_BEFORE_START',
    11: 'USB_PLUGGED_IN_SOFT_DEVICE',
    12: 'USB_PLUGGED_OUT_SOFT_DEVICE',
    13: 'RECORDING_PAUSED',
    14: 'RECORDING_RESUMED',
    15: 'BATTERY_RECOVER_IN_BATT_CHECK_TIMER',
    16: 'TSK_FREE_UP_FLASH',
    17: 'FREE_UP_FLASH_FAIL_LOW_BATT',
    18: 'PAYLOAD_PACKAGING_TASK_SET',
    19: 'PAYLOAD_PACKAGING_FUNCTION_CALL',
    20: 'BATTERY_VOLTAGE',
    21: 'TSK_WRITE_LOOKUP_TBL_CHANGES_TO_EEPROM',
    22: 'LPCOMP_ON',
    23: 'LPCOMP_ON_ALREADY',
    24: 'LPCOMP_OFF',
    25: 'LPCOMP_TRIED_BUT_BATT_LOW',
    26: 'BLE_CONNECTED',
    27: 'BLE_DISCONNECTED',
    28: 'TSK_WRITE_FLASH',
    29: 'PPG_TIMER_START',
    30: 'PAYLOAD_OVERSHOT',
    31: 'ADVERTISING_START',
    32: 'ADVERTISING_STOP',
    33: 'NIMH_BATT_PPG_BLOCKED_BLE_RETRY',
    34: 'NIMH_BATT_PPG_BLOCKED_BLE_ADAPT_SCH',
    35: 'NIMH_BATT_PPG_BLOCKED_BLE_PENDING_EVENTS',
    36: 'NIMH_BATT_BLE_BLOCKED_PPG',
    37: 'USB_PORT_OPEN',
    38: 'USB_PORT_CLOSED',
    39: 'FIFO_INT_SAFETY_CHECK_EVENT_ACCEL1',
    40: 'FIFO_INT_SAFETY_CHECK_EVENT_ACCEL2GYRO',
    41: 'FIFO_INT_SAFETY_CHECK_EVENT_MAX86XXX',
    42: 'FIFO_INT_SAFETY_CHECK_EVENT_MAX3000X',
    43: 'FIFO_INT_SAFETY_CHECK_EVENT_ADC',
    44: 'USB_PLUGGED_IN_PIN_HANDLER',
    45: 'USB_PLUGGED_OUT_PIN_HANDLER',
    46: 'BATTERY_CHARGER_STATUS_BAD_BATTERY',
    47: 'BATTERY_CHARGER_STATUS_CHARGING',
    48: 'BATTERY_CHARGER_STATUS_CHARGING_COMPLETE',
    49: 'BATTERY_CHARGER_STATUS_POWER_DOWN',
    50: 'LTC4123_RECOVERY_ATTEMPT',
    51: 'LTC4123_RECOVERY_GAVE_UP',
    52: 'LTC4123_CHRG_COMPLETE_OVERRIDDEN_BAD_BATT',
};
const LOOKUP_STATUS_NAMES = {
    0: 'Zero',
    1: 'Full',
    2: '2Del',
    3: 'Emty',
    4: 'Bad',
    5: 'NUse',
};
function u32le_at(bytes, off) {
    return (((bytes[off] ?? 0) |
        ((bytes[off + 1] ?? 0) << 8) |
        ((bytes[off + 2] ?? 0) << 16) |
        ((bytes[off + 3] ?? 0) << 24)) >>>
        0);
}
function decodeAsciiTrimFF(bytes) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0xff)
        end--;
    if (end === 0)
        return '';
    return new TextDecoder().decode(bytes.slice(0, end));
}
/** Convert unix seconds into Verisense 7-byte RTC payload (4-byte minutes + 3-byte ticks). */
function unixSecondsToAsmRtcBytes(unixSeconds) {
    if (!Number.isFinite(unixSeconds) || unixSeconds < 0) {
        throw new Error('unixSecondsToAsmRtcBytes: unixSeconds must be a finite positive number');
    }
    const minutes = Math.floor(unixSeconds / 60);
    const secondsInMinute = unixSeconds - minutes * 60;
    const ticks = Math.floor(secondsInMinute * 32768);
    return new Uint8Array([
        minutes & 0xff,
        (minutes >> 8) & 0xff,
        (minutes >> 16) & 0xff,
        (minutes >> 24) & 0xff,
        ticks & 0xff,
        (ticks >> 8) & 0xff,
        (ticks >> 16) & 0xff,
    ]);
}
/** Convert Verisense 7-byte RTC payload into unix seconds. */
function asmRtcBytesToUnixSeconds(rtc7) {
    if (rtc7.length !== 7) {
        throw new Error('asmRtcBytesToUnixSeconds: payload must be exactly 7 bytes');
    }
    const minutes = u32le_at(rtc7, 0);
    const ticks = u24le(rtc7, 4);
    return minutes * 60 + ticks / 32768.0;
}
/** Convert Verisense 8-byte minute counter payload into unix seconds. */
function asmRtcMinutesBytesToUnixSeconds(minutes8) {
    if (minutes8.length !== 8) {
        throw new Error('asmRtcMinutesBytesToUnixSeconds: payload must be exactly 8 bytes');
    }
    let minutes = 0n;
    for (let i = 0; i < 8; i++) {
        minutes |= BigInt(minutes8[i]) << BigInt(i * 8);
    }
    return Number(minutes) * 60;
}
/**
 * Build a production configuration payload (56 bytes) from structured options.
 * This matches the Python tooling layout used by ASM_BLE.py / ASM_Device.py.
 */
function buildProductionConfigPayload(opts) {
    const mo = String(opts.manufacturingOrderNumberHex ?? '').trim();
    const mac = String(opts.macIdHex ?? '').trim();
    if (!/^[0-9a-fA-F]{8}$/.test(mo)) {
        throw new Error('buildProductionConfigPayload: manufacturingOrderNumberHex must be 8 hex chars');
    }
    if (!/^[0-9a-fA-F]{4}$/.test(mac)) {
        throw new Error('buildProductionConfigPayload: macIdHex must be 4 hex chars');
    }
    const uniqueBytes = new Uint8Array(6);
    uniqueBytes.set(new Uint8Array(mo.match(/../g).map((h) => Number.parseInt(h, 16))), 0);
    uniqueBytes.set(new Uint8Array(mac.match(/../g).map((h) => Number.parseInt(h, 16))), 4);
    uniqueBytes.reverse();
    const revHwInternal = (opts.revHwInternal ?? 0) & 0xffff;
    const revFwInternal = (opts.revFwInternal ?? 0) & 0xffff;
    const out = new Uint8Array(56);
    out[0] = 0x5a;
    out.set(uniqueBytes, 1);
    out[7] = opts.revHwMajor & 0xff;
    out[8] = opts.revHwMinor & 0xff;
    out[9] = opts.revFwMajor & 0xff;
    out[10] = opts.revFwMinor & 0xff;
    out[11] = revFwInternal & 0xff;
    out[12] = (revFwInternal >> 8) & 0xff;
    out[13] = revHwInternal & 0xff;
    out[14] = (revHwInternal >> 8) & 0xff;
    out.fill(0xff, 15, 56);
    const passkeyId = opts.passkeyId ?? '';
    if (passkeyId.length > 0) {
        if (passkeyId.length !== 2) {
            throw new Error('buildProductionConfigPayload: passkeyId must be 2 chars when provided');
        }
        out.set(new TextEncoder().encode(passkeyId), 15);
    }
    const passkey = opts.passkey ?? '';
    if (passkey.length > 0) {
        if (passkey.length !== 6) {
            throw new Error('buildProductionConfigPayload: passkey must be 6 chars when provided');
        }
        out.set(new TextEncoder().encode(passkey), 17);
    }
    const advPrefix = opts.advertisingNamePrefix ?? '';
    if (advPrefix.length > 32) {
        throw new Error('buildProductionConfigPayload: advertisingNamePrefix must be <= 32 chars');
    }
    if (advPrefix.length > 0) {
        out.set(new TextEncoder().encode(advPrefix), 23);
    }
    if (opts.dfuEnabled ?? true) {
        out[55] = PROD_CONFIG_FLAG_DFU_ENABLED;
    }
    return out;
}
/** Parse production configuration with optional passkey/name/flag fields. */
function parseProductionConfigPayloadFull(response) {
    if (response.length < 11) {
        throw new Error('parseProductionConfigPayloadFull: payload must be at least 11 bytes');
    }
    const base = parseProductionConfigPayload(response);
    const uniqueIdentifier = [...response.slice(1, 7)]
        .reverse()
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
    const revHwMajor = response[7] ?? 0;
    const revHwMinor = response[8] ?? 0;
    const revFwMajor = response[9] ?? 0;
    const revFwMinor = response[10] ?? 0;
    const revFwInternal = response.length >= 13 ? u16le_at(response, 11) : 0;
    const revHwInternal = response.length >= 15 ? u16le_at(response, 13) : 0;
    const passkeyId = response.length >= 17 ? decodeAsciiTrimFF(response.slice(15, 17)) : '';
    const passkey = response.length >= 23 ? decodeAsciiTrimFF(response.slice(17, 23)) : '';
    const advertisingNamePrefix = response.length >= 55 ? decodeAsciiTrimFF(response.slice(23, 55)) : '';
    const dfuEnabled = response.length >= 56 ? !!(response[55] & PROD_CONFIG_FLAG_DFU_ENABLED) : true;
    return {
        ...base,
        manufacturingOrderNumber: uniqueIdentifier.slice(0, 8),
        macId: uniqueIdentifier.slice(8, 12),
        uniqueIdentifier,
        revHwMajor,
        revHwMinor,
        revHwInternal,
        revFwMajor,
        revFwMinor,
        revFwInternal,
        passkeyId,
        passkey,
        advertisingNamePrefix,
        dfuEnabled,
    };
}
/**
 * Parse STATUS1/STATUS2 payload into a typed object.
 *
 * This ports the core byte parsing from ASM_Device.parse_status while keeping
 * the output concise and UI-friendly.
 */
function parseStatusPayload(response, sourceStatusProperty = 'status1') {
    if (response.length < 24) {
        throw new Error('parseStatusPayload: payload must be at least 24 bytes');
    }
    const uniqueIdentifier = [...response.slice(0, 6)]
        .reverse()
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
    const hasTickFields = response.length >= 56;
    const hasExtendedCapacity = response.length >= 65;
    const statusTimestampSeconds = hasTickFields
        ? asmRtcBytesToUnixSeconds(new Uint8Array([...response.slice(6, 10), ...response.slice(34, 37)]))
        : u32le_at(response, 6) * 60;
    const batteryMilliVolts = u16le_at(response, 10);
    const batteryPercent = response[12] ?? 0;
    const lastOkTransferSeconds = hasTickFields
        ? asmRtcBytesToUnixSeconds(new Uint8Array([...response.slice(13, 17), ...response.slice(37, 40)]))
        : u32le_at(response, 13) * 60;
    const lastFailTransferSeconds = hasTickFields
        ? asmRtcBytesToUnixSeconds(new Uint8Array([...response.slice(17, 21), ...response.slice(40, 43)]))
        : u32le_at(response, 17) * 60;
    const memoryFreeKb = hasExtendedCapacity
        ? (response[21] | (response[22] << 8) | (response[23] << 16) | (response[57] << 24)) >>> 0
        : (response[21] | (response[22] << 8) | (response[23] << 16)) >>> 0;
    const memoryCapacityKb = hasExtendedCapacity ? u32le_at(response, 60) : null;
    const memoryUsedKb = memoryCapacityKb == null ? null : Math.max(0, memoryCapacityKb - memoryFreeKb);
    // Bank breakdown: FULL=syncable data, 2DEL=partially-deleted, BAD=unusable flash.
    // Present in payloads >= 57 bytes (tick-capable extended format).
    const hasBankData = response.length >= 57;
    const memoryFullBanksKb = hasBankData ? u32le_at(response, 45) : null;
    const memoryTwoDelBanksKb = hasBankData ? u32le_at(response, 49) : null;
    const memoryBadBanksKb = hasBankData ? u32le_at(response, 53) : null;
    const batteryFallCounter = response.length >= 26 ? u16le_at(response, 24) : null;
    let statusFlags = null;
    if (response.length >= 34) {
        const f = response[26];
        statusFlags = {
            usbPluggedIn: (f & 0x01) !== 0,
            recordingPaused: (f & 0x02) !== 0,
            flashIsFull: (f & 0x04) !== 0,
            powerIsGood: (f & 0x08) !== 0,
            adaptiveSchedulerOn: (f & 0x10) !== 0,
            dfuServiceOn: (f & 0x20) !== 0,
            firstBoot: (f & 0x40) !== 0,
            repeatedBatteryMeasurement: (f & 0x80) !== 0,
        };
    }
    return {
        uniqueIdentifier,
        sourceStatusProperty,
        statusTimestampSeconds,
        batteryMilliVolts,
        batteryPercent,
        lastOkTransferSeconds,
        lastFailTransferSeconds,
        memoryFreeKb,
        memoryCapacityKb,
        memoryUsedKb,
        memoryFullBanksKb,
        memoryTwoDelBanksKb,
        memoryBadBanksKb,
        statusFlags,
        batteryFallCounter,
    };
}
/** Parse scheduler debug response payload from DEBUG_COMMAND_ID.RWC_SCHEDULER_READ. */
function parseSchedulerDebugPayload(payload) {
    if (payload.length < 42) {
        throw new Error('parseSchedulerDebugPayload: payload is too short');
    }
    let idx = 0;
    const currentTimeUnixSeconds = asmRtcBytesToUnixSeconds(payload.slice(idx, idx + 7));
    idx += 7;
    const bleControlByte = payload[idx++] ?? 0xff;
    const bleControlCounter = bleControlByte === 0x00
        ? 'data-transfer'
        : bleControlByte === 0x01
            ? 'status1'
            : bleControlByte === 0x02
                ? 'rtc-sync'
                : bleControlByte === 0x03
                    ? 'status2'
                    : bleControlByte === 0xff
                        ? 'never'
                        : 'unknown';
    const next8 = () => {
        const v = asmRtcMinutesBytesToUnixSeconds(payload.slice(idx, idx + 8));
        idx += 8;
        return v;
    };
    const out = {
        currentTimeUnixSeconds,
        bleControlCounter,
        pendingDataTransferUnixSeconds: next8(),
        pendingStatus1UnixSeconds: next8(),
        pendingRtcSyncUnixSeconds: next8(),
        pendingRetryUnixSeconds: next8(),
        retryCount: payload[idx++] ?? 0,
        retryOperation: (payload[idx++] ?? 0) === 1 ? 'ble-on' : 'ble-off',
    };
    if (payload.length >= idx + 10) {
        out.adaptiveScheduler = {
            nextUnixSeconds: next8(),
            enabled: (payload[idx++] ?? 0) === 1,
            syncFailCounter: payload[idx++] ?? 0,
        };
    }
    if (payload.length >= idx + 11) {
        const nextUnixSeconds = next8();
        const op = payload[idx++] ?? 0;
        out.ltfRetry = {
            nextUnixSeconds,
            currentOperation: op === 0
                ? 'flash-write-retry-inactive'
                : op === 1
                    ? 'short-flash-write-retry'
                    : op === 2
                        ? 'attempt-flash-write'
                        : op === 3
                            ? 'long-flash-write-retry'
                            : op === 4
                                ? 'sensor-paused-until-usb-plug-in'
                                : 'unknown',
            failCounterShort: payload[idx++] ?? 0,
            failCounterLong: payload[idx++] ?? 0,
        };
    }
    if (payload.length >= idx + 8) {
        out.pendingStatus2UnixSeconds = next8();
    }
    if (payload.length >= idx + 8) {
        out.ppgMeasurementUnixSeconds = next8();
    }
    if (payload.length >= idx + 8) {
        out.stepCounterResetUnixSeconds = next8();
    }
    if (payload.length >= idx + 8) {
        out.sensorInactivityUnixSeconds = next8();
    }
    return out;
}
/** Parse debug payload listing bank indexes with bad CRC (2-byte LE entries). */
function parsePayloadCrcErrorBankIndexes(payload) {
    if (payload.length % 2 !== 0) {
        throw new Error('parsePayloadCrcErrorBankIndexes: payload length must be even');
    }
    const out = [];
    for (let i = 0; i < payload.length; i += 2)
        out.push(u16le_at(payload, i));
    return out;
}
/** Parse 8-byte debug event-log entries. */
function parseEventLogPayload(payload) {
    if (payload.length % 8 !== 0) {
        throw new Error('parseEventLogPayload: payload length must be a multiple of 8');
    }
    const out = [];
    for (let i = 0; i < payload.length; i += 8) {
        const entry = payload.slice(i, i + 8);
        const eventId = entry[7];
        if (eventId === 0)
            continue;
        out.push({
            index: i / 8,
            eventId,
            eventName: LOG_EVENT_NAMES[eventId] ?? `EVENT_${eventId}`,
            timestampUnixSeconds: eventId === 20 ? null : asmRtcBytesToUnixSeconds(entry.slice(0, 7)),
            batteryMilliVolts: eventId === 20 ? u24le(entry, 0) : null,
        });
    }
    return out;
}
/** Parse record-buffer details payload (26-byte current layout, 19-byte legacy layout). */
function parseRecordBufferDetailsPayload(payload) {
    const bytesPerBuffer = payload.length % 26 === 0 ? 26 : payload.length % 19 === 0 ? 19 : 0;
    if (!bytesPerBuffer) {
        throw new Error('parseRecordBufferDetailsPayload: unsupported payload length');
    }
    const out = [];
    for (let i = 0; i < payload.length; i += bytesPerBuffer) {
        const row = payload.slice(i, i + bytesPerBuffer);
        out.push({
            bufferIndex: row[0],
            bufferState: row[1],
            packagedPayloadIndex: u16le_at(row, 2),
            currentByteIndexForSensorData: u16le_at(row, 4),
            usedBufferLength: u16le_at(row, 6),
            fifoTicks: u16le_at(row, 8),
            dataTimestampRwcMinutes: u32le_at(row, 10),
            dataTimestampRwcTicks: u24le(row, 14),
            temperatureData: u16le_at(row, 17),
            dataTimestampUcClockMinutes: bytesPerBuffer >= 23 ? u32le_at(row, 19) : null,
            dataTimestampUcClockTicks: bytesPerBuffer >= 26 ? u24le(row, 23) : null,
        });
    }
    return out;
}
/**
 * Parse lookup-table debug payload entries (3 bytes per bank), with optional
 * 4-byte tail/head prefix present in older firmware debug responses.
 */
function parseLookupTablePayload(payload, totalBanks) {
    const bytesPerBank = 3;
    const expectedNoHeadTail = totalBanks * bytesPerBank;
    const expectedWithHeadTail = expectedNoHeadTail + 4;
    let data = payload;
    let head = null;
    let tail = null;
    if (payload.length === expectedWithHeadTail) {
        tail = u16le_at(payload, 0);
        head = u16le_at(payload, 2);
        data = payload.slice(4);
    }
    else if (payload.length !== expectedNoHeadTail) {
        throw new Error(`parseLookupTablePayload: payload length ${payload.length} does not match expected ${expectedNoHeadTail} or ${expectedWithHeadTail}`);
    }
    const entries = [];
    for (let bankIndex = 0; bankIndex < totalBanks; bankIndex++) {
        const off = bankIndex * bytesPerBank;
        const statusByte = data[off];
        const pendingEepromWrite = (statusByte & 0x80) !== 0;
        const statusCode = statusByte & 0x7f;
        entries.push({
            bankIndex,
            statusCode,
            statusName: LOOKUP_STATUS_NAMES[statusCode] ?? 'Unknown',
            pendingEepromWrite,
            payloadIndex: u16le_at(data, off + 1),
        });
    }
    return { head, tail, entries };
}
/**
 * Parse the production config response payload into a structured object.
 */
function parseProductionConfigPayload(response) {
    const isAllFFs = (arr) => arr.every((b) => b === 255);
    const configHeader = response[0];
    const asmid = [...response.slice(1, 7)]
        .reverse()
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    const revHwMajor = response[7];
    const revHwMinor = response[8];
    const revFwMajor = response[9];
    const revFwMinor = response[10];
    const fwInternalArray = response.slice(11, 13);
    const revFwInternal = fwInternalArray[0] | (fwInternalArray[1] << 8);
    let revHwInternal = 0;
    if (response.length >= 15) {
        const hwInternalArray = response.slice(13, 15);
        if (!isAllFFs(hwInternalArray)) {
            revHwInternal = hwInternalArray[0] | (hwInternalArray[1] << 8);
        }
    }
    return {
        hardware: `${revHwMajor}.${revHwMinor}.${revHwInternal}`,
        firmware: `${revFwMajor}.${revFwMinor}.${revFwInternal}`,
        asmid: asmid.toUpperCase(),
        configHeader,
    };
}

/** Build a protocol header byte from command/property nibbles. */
function buildHeader(command, property) {
    return ((command & 0xf0) | (property & 0x0f)) & 0xff;
}
/** Decode a protocol header byte into command/property fields. */
function parseHeader(header) {
    return {
        command: (header & 0xf0),
        property: (header & 0x0f),
    };
}
/** Build a complete protocol message (header + 16-bit LE payload length + payload bytes). */
function buildMessage(command, property, payloadBytes = []) {
    const payload = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes);
    const out = new Uint8Array(3 + payload.length);
    out[0] = buildHeader(command, property);
    out[1] = payload.length & 0xff;
    out[2] = (payload.length >> 8) & 0xff;
    out.set(payload, 3);
    return out;
}
/** Parse a complete protocol message into structured fields. */
function parseMessage(msg) {
    if (msg.length < 3)
        throw new Error('Invalid Verisense message: header is incomplete');
    const header = msg[0];
    const payloadLength = u16le(msg[1], msg[2]);
    if (msg.length !== payloadLength + 3) {
        throw new Error(`Invalid Verisense message: length=${payloadLength}, actualPayload=${Math.max(0, msg.length - 3)}`);
    }
    const { command, property } = parseHeader(header);
    return {
        header,
        command,
        property,
        payloadLength,
        payload: msg.slice(3),
    };
}
function isAckCommand(command) {
    return command === ASM_COMMAND.ACK || command === ASM_COMMAND.ACK_NEXT_STAGE;
}
function isNackCommand(command) {
    return (command === ASM_COMMAND.NACK_BAD_HEADER_COMMAND ||
        command === ASM_COMMAND.NACK_BAD_HEADER_PROPERTY ||
        command === ASM_COMMAND.NACK_GENERIC);
}
/** Convert a pending-events payload (property IDs) into a typed array. */
function parsePendingEvents(payload) {
    const out = [];
    for (let i = 0; i < payload.length; i++)
        out.push((payload[i] & 0x0f));
    return out;
}

function pad2(n) {
    return Math.trunc(n).toString().padStart(2, '0');
}
function pad5(n) {
    return Math.trunc(n).toString().padStart(5, '0');
}
function dateToYyMMddHHmmss(date) {
    const yy = pad2(date.getUTCFullYear() % 100);
    const mm = pad2(date.getUTCMonth() + 1);
    const dd = pad2(date.getUTCDate());
    const hh = pad2(date.getUTCHours());
    const min = pad2(date.getUTCMinutes());
    const ss = pad2(date.getUTCSeconds());
    return `${yy}${mm}${dd}_${hh}${min}${ss}`;
}
/** Build a binary upload file name: yyMMdd_HHmmss_00000.bin */
function buildUploadBinaryFileName(uploadDate, firstPayloadIndex) {
    if (!Number.isFinite(firstPayloadIndex) || firstPayloadIndex < 0 || firstPayloadIndex > 0xffff) {
        throw new Error('buildUploadBinaryFileName: firstPayloadIndex must be in range 0..65535');
    }
    return `${dateToYyMMddHHmmss(uploadDate)}_${pad5(firstPayloadIndex)}.bin`;
}
/** Build parsed CSV file name: yyMMdd_HHmmss_DataSource_00000.csv */
function buildParsedCsvFileName(startDate, dataSource, firstPayloadIndex) {
    if (!dataSource || !String(dataSource).trim()) {
        throw new Error('buildParsedCsvFileName: dataSource must be a non-empty string');
    }
    if (!Number.isFinite(firstPayloadIndex) || firstPayloadIndex < 0 || firstPayloadIndex > 0xffff) {
        throw new Error('buildParsedCsvFileName: firstPayloadIndex must be in range 0..65535');
    }
    return `${dateToYyMMddHHmmss(startDate)}_${String(dataSource).trim()}_${pad5(firstPayloadIndex)}.csv`;
}
/** Add duplicate suffix like " (2)" before extension. */
function applyDuplicateSuffix(fileName, duplicateIndex) {
    if (duplicateIndex < 2) {
        throw new Error('applyDuplicateSuffix: duplicateIndex must be >= 2');
    }
    const idx = fileName.lastIndexOf('.');
    if (idx <= 0)
        return `${fileName} (${duplicateIndex})`;
    const stem = fileName.slice(0, idx);
    const ext = fileName.slice(idx);
    return `${stem} (${duplicateIndex})${ext}`;
}
/** Return first non-colliding duplicate name for a target file name. */
function nextAvailableDuplicateFileName(fileName, existingNames) {
    const existing = new Set(existingNames);
    if (!existing.has(fileName))
        return fileName;
    let i = 2;
    while (true) {
        const candidate = applyDuplicateSuffix(fileName, i);
        if (!existing.has(candidate))
            return candidate;
        i++;
    }
}
/** Parse first payload index (uint16 LE) from a payload byte array. */
function getFirstPayloadIndex(payload) {
    if (payload.length < 2) {
        throw new Error('getFirstPayloadIndex: payload must contain at least 2 bytes');
    }
    return u16le_at(payload, 0);
}
/**
 * Evaluate whether parsed CSV output should roll to a new file.
 * Rules mirror ASM-DES08 split conditions.
 */
function evaluateParsedFileSplit(input) {
    const reasons = [];
    const prev = input.prevTimestampSec;
    const curr = input.currTimestampSec;
    // Split when crossing 12:00am or 12:00pm boundaries.
    const prevHalfDay = Math.floor(prev / (12 * 60 * 60));
    const currHalfDay = Math.floor(curr / (12 * 60 * 60));
    if (currHalfDay !== prevHalfDay)
        reasons.push('midday-midnight-boundary');
    if ((input.prevConfigSignature ?? null) !== (input.currConfigSignature ?? null)) {
        reasons.push('config-change');
    }
    if (input.expectedDeltaSec != null) {
        const tol = Math.max(0, input.timestampToleranceSec ?? 0);
        const delta = curr - prev;
        if (Math.abs(delta - input.expectedDeltaSec) > tol) {
            reasons.push('timestamp-discontinuity');
        }
    }
    if (input.powerResetDetected) {
        reasons.push('power-reset');
    }
    return { shouldSplit: reasons.length > 0, reasons };
}

/**
 * Abstract base class for all Verisense sensor decoders.
 *
 * Provides:
 * - Timestamp unwrapping (handles the 1-minute rollover at 32768 ticks/s).
 * - System-time offset tracking for plotting calibrated wall-clock timestamps.
 * - Per-sample time extrapolation based on sampling rate and last-sample tick.
 */
class SensorBase {
    constructor() {
        this.lastTicksUnwrapped = 0;
        this.cycle = 0;
        /** (system time) − (shimmer time) at first sample, in milliseconds. */
        this.systemOffsetFirstTime = null;
        /** Sampling rate in Hz (used for per-sample time extrapolation). */
        this.samplingRateHz = null;
        /** Whether this sensor is enabled in the operational config. */
        this.enabled = true;
    }
    /** Reset all timestamp state (call on (re)connect or when streaming restarts). */
    resetTimestamps() {
        this.lastTicksUnwrapped = 0;
        this.cycle = 0;
        this.systemOffsetFirstTime = null;
    }
    /**
     * Unwrap a rolling 24-bit tick counter to a monotonically increasing value.
     */
    unwrapTicks(ticks) {
        let unwrapped = ticks + SensorBase.TICKS_MAX_VALUE * this.cycle;
        if (this.lastTicksUnwrapped > unwrapped) {
            this.cycle += 1;
            unwrapped = ticks + SensorBase.TICKS_MAX_VALUE * this.cycle;
        }
        this.lastTicksUnwrapped = unwrapped;
        return unwrapped;
    }
    /** Convert unwrapped ticks to milliseconds. */
    ticksToMillis(unwrappedTicks) {
        return (unwrappedTicks / SensorBase.CLOCK_FREQ) * 1000.0;
    }
    /**
     * Compute the calibrated shimmer timestamp for the *last* sample in a burst,
     * and store the first-seen system-offset for later plotting.
     *
     * @param lastSampleTicksU24  24-bit tick counter from the packet header.
     * @param systemMillis        `Date.now()` at the time of packet receipt.
     */
    getTimestampUnwrappedMillis(lastSampleTicksU24, systemMillis) {
        const unwrappedTicks = this.unwrapTicks(lastSampleTicksU24);
        const shimmerMillis = this.ticksToMillis(unwrappedTicks);
        if (this.systemOffsetFirstTime == null) {
            this.systemOffsetFirstTime = systemMillis - shimmerMillis;
        }
        return { shimmerMillis, systemOffsetFirstTime: this.systemOffsetFirstTime };
    }
    /**
     * Extrapolate the timestamp for sample `i` of `numSamples` in a burst,
     * given the timestamp of the *last* sample and the sampling rate.
     *
     * @returns Object with `tsMillis`, `systemTsMillis`, and `systemTsPlotMillis`.
     */
    extrapolateSampleTimes(opts) {
        const sr = opts.samplingRateHz ?? this.samplingRateHz;
        const { tsLastSampleMillis, systemTsLastSampleMillis, systemOffsetFirstTime } = opts;
        if (!sr || sr <= 0) {
            return {
                tsMillis: tsLastSampleMillis,
                systemTsMillis: systemTsLastSampleMillis,
                systemTsPlotMillis: systemOffsetFirstTime != null
                    ? tsLastSampleMillis + systemOffsetFirstTime
                    : systemTsLastSampleMillis,
            };
        }
        const sampleOffsetSec = (opts.numSamples - opts.i - 1) / sr;
        const tsMillis = tsLastSampleMillis - sampleOffsetSec * 1000;
        const systemTsMillis = systemTsLastSampleMillis - sampleOffsetSec * 1000;
        const systemTsPlotMillis = systemOffsetFirstTime != null ? tsMillis + systemOffsetFirstTime : systemTsMillis;
        return { tsMillis, systemTsMillis, systemTsPlotMillis };
    }
}
/** Verisense clock frequency in ticks per second. */
SensorBase.CLOCK_FREQ = 32768;
/** 1-minute rollover at 32768 ticks/s (matches C# Sensor.cs). */
SensorBase.TICKS_MAX_VALUE = 60 * 32768;

/**
 * Decoder for grouped ADC channels (Verisense sensor id = 1).
 *
 * Includes GSR plus battery/ADC channels carried in the same packet source.
 * Implements C# `SensorGSR.cs` including:
 * - Per-hardware reference resistor selection (SR68 vs Shimmer3 resistors).
 * - Auto-range decoding from the raw ADC value's upper bits.
 * - Range-3 clamping threshold that differs by hardware.
 * - Conductance (uS) output with connectivity detection.
 */
class SensorADC extends SensorBase {
    constructor() {
        super();
        this.LIMIT_MIN_VALID_USIEMENS = 0.03;
        this.GSR_UNCAL_LIMIT_RANGE3_SR68 = 1134;
        this.GSR_UNCAL_LIMIT_RANGE3_SR62 = 683;
        this.SHIMMER3_REF_KOHMS = [40.2, 287.0, 1000.0, 3300.0];
        this.SR68_REF_KOHMS = [21.0, 150.0, 562.0, 1740.0];
        this.gsrEnabled = true;
        this.battEnabled = false;
        /** GSR range 0-3 (fixed) or 4 (auto-range). */
        this.gsrRangeSetting = 4;
        this.hardwareIdentifier = 'VERISENSE_PULSE_PLUS';
        // Decoded from opConfig for debug/display
        this.gsrRateSettingRaw = 0;
        this.gsrRangeSettingRaw = 0;
        this.gsrOversamplingRateSettingRaw = 0;
        this.samplingRateHz = 50;
    }
    setHardwareIdentifier(idStr) {
        this.hardwareIdentifier = idStr;
    }
    setGsrRangeSetting(v) {
        this.gsrRangeSetting = v;
    }
    setEnabled(arg1, opConfigBytes) {
        if (opConfigBytes != null) {
            const desired = typeof arg1 === 'boolean' ? { gsr: arg1 } : arg1 && typeof arg1 === 'object' ? arg1 : {};
            return this._patchEnabled(desired, opConfigBytes);
        }
        const obj = typeof arg1 === 'boolean' ? { gsr: arg1 } : arg1 && typeof arg1 === 'object' ? arg1 : {};
        if (typeof obj.gsr === 'boolean')
            this.gsrEnabled = obj.gsr;
        if (typeof obj.batt === 'boolean')
            this.battEnabled = obj.batt;
        return { gsr: this.gsrEnabled, batt: this.battEnabled };
    }
    _patchEnabled({ gsr, batt }, opConfigBytes) {
        const op = normalizeOperationalConfig(opConfigBytes);
        const out = new Uint8Array(op);
        if (typeof gsr === 'boolean') {
            const idx = OP_IDX.GEN_CFG_1;
            out[idx] = gsr ? (out[idx] | 0x80) & 0xff : out[idx] & 0x7f & 0xff;
        }
        if (typeof batt === 'boolean') {
            const idx = OP_IDX.GEN_CFG_2;
            out[idx] = batt ? (out[idx] | 0x02) & 0xff : out[idx] & 0xfd & 0xff;
        }
        return out;
    }
    patchGsrRange(rangeCfg, op) {
        const out = new Uint8Array(op);
        const i = OP_IDX.ADC_CHANNEL_SETTINGS_1;
        out[i] = (out[i] & 0b11111000) | (rangeCfg & 0x07);
        return out;
    }
    patchGsrSamplingRate(rateCfg, op) {
        const out = new Uint8Array(op);
        const i = OP_IDX.ADC_CHANNEL_SETTINGS_0;
        out[i] = (out[i] & 0b11000000) | (rateCfg & 0x3f);
        return out;
    }
    patchGsrOversampling(overCfg, op) {
        const out = new Uint8Array(op);
        const i = OP_IDX.ADC_CHANNEL_SETTINGS_1;
        out[i] = (out[i] & 0b00001111) | ((overCfg & 0x0f) << 4);
        return out;
    }
    calibrateAdcToVolts(uncal12bit) {
        const adcRange = 2 ** 12 - 1;
        let refVoltage = 1.8 / 4.0;
        if (this.hardwareIdentifier === 'VERISENSE_GSR_PLUS') {
            refVoltage = 3.0 / 4.0;
        }
        const adcScaling = 1.0 / 4.0;
        return (uncal12bit * refVoltage) / adcRange / adcScaling;
    }
    calibrateGsrToKOhmsUsingAmplifierEq(volts, range) {
        let rFeedback = this.SHIMMER3_REF_KOHMS[range];
        if (this.hardwareIdentifier === 'VERISENSE_PULSE_PLUS') {
            rFeedback = this.SR68_REF_KOHMS[range];
        }
        const gsrRefVoltage = this.hardwareIdentifier === 'VERISENSE_PULSE_PLUS' ? 0.4986 : 0.5;
        return rFeedback / (volts / gsrRefVoltage - 1.0);
    }
    nudgeGsrResistance(kOhms) {
        const limitsByRange = {
            0: [8.0, 63.0],
            1: [63.0, 220.0],
            2: [220.0, 680.0],
            3: [680.0, 4700.0],
            4: [8.0, 4700.0],
        };
        const lim = limitsByRange[this.gsrRangeSetting] ?? [8.0, 4700.0];
        return Math.min(Math.max(kOhms, lim[0]), lim[1]);
    }
    kOhmToUSiemens(kOhms) {
        return 1000.0 / kOhms;
    }
    parsePayload(sensorPayloadBytes) {
        const bytesPerSample = this.gsrEnabled && this.battEnabled ? 4 : 2;
        const n = Math.floor(sensorPayloadBytes.length / bytesPerSample);
        const out = [];
        for (let i = 0; i < n; i++) {
            const base = i * bytesPerSample;
            let batt = null;
            let gsr = null;
            const gsrStart = this.battEnabled && this.gsrEnabled ? 2 : 0;
            if (this.gsrEnabled) {
                const gsrraw = i16le(sensorPayloadBytes, base + gsrStart);
                let adc12 = gsrraw & 0x0fff;
                let currentRange = this.gsrRangeSetting;
                if (currentRange === 4)
                    currentRange = (gsrraw >> 14) & 0x03;
                if (currentRange === 3) {
                    const limit = this.hardwareIdentifier === 'VERISENSE_PULSE_PLUS'
                        ? this.GSR_UNCAL_LIMIT_RANGE3_SR68
                        : this.GSR_UNCAL_LIMIT_RANGE3_SR62;
                    if (adc12 < limit)
                        adc12 = limit;
                }
                const volts = this.calibrateAdcToVolts(adc12);
                let kOhms = this.calibrateGsrToKOhmsUsingAmplifierEq(volts, currentRange);
                kOhms = this.nudgeGsrResistance(kOhms);
                const uS = this.kOhmToUSiemens(kOhms);
                const connectivity = uS > this.LIMIT_MIN_VALID_USIEMENS ? 'Connected' : 'Disconnected';
                gsr = { raw: gsrraw, adc12, range: currentRange, volts, kOhms, uS, connectivity };
            }
            if (this.battEnabled) {
                const raw16 = i16le(sensorPayloadBytes, base) & 0xffff;
                const adc12 = raw16 & 0x0fff;
                const usbPluggedIn = ((raw16 >> 15) & 0x01) === 1;
                const chargerStatusBits = (raw16 >> 13) & 0x03;
                let mv = this.calibrateAdcToVolts(adc12) * 1000.0;
                if (this.hardwareIdentifier === 'VERISENSE_GSR_PLUS') {
                    mv *= 1.988;
                }
                const chargerStatusMap = {
                    0: 'Power-Down/Suspended',
                    1: 'Charging',
                    2: 'Charging Complete',
                    3: 'Bad Battery/LDO',
                };
                batt = {
                    raw16,
                    adc12,
                    mV: mv,
                    usbPluggedIn,
                    chargerStatusBits,
                    chargerStatus: chargerStatusMap[chargerStatusBits] ?? 'Unknown',
                };
            }
            out.push({ gsr, batt });
        }
        return out;
    }
    applyOperationalConfig(op) {
        const gen1 = op[OP_IDX.GEN_CFG_1] ?? 0;
        const gen2 = op[OP_IDX.GEN_CFG_2] ?? 0;
        this.gsrEnabled = ((gen1 >> 7) & 0x01) === 1;
        this.battEnabled = (gen2 & 0b00000010) !== 0;
        const rateCfg = (op[OP_IDX.ADC_CHANNEL_SETTINGS_0] ?? 0) & 0x3f;
        const cfg1 = (op[OP_IDX.ADC_CHANNEL_SETTINGS_1] ?? 0) & 0xff;
        const rangeCfg = cfg1 & 0x07;
        const oversamplingCfg = (cfg1 >> 4) & 0x0f;
        this.gsrRateSettingRaw = rateCfg;
        this.gsrRangeSettingRaw = rangeCfg;
        this.gsrOversamplingRateSettingRaw = oversamplingCfg;
        if (rangeCfg >= 0 && rangeCfg <= 4) {
            this.gsrRangeSetting = rangeCfg;
        }
    }
}

/**
 * Decoder for the LIS2DW12 low-power accelerometer (Verisense sensor id = 2).
 *
 * Sensitivity values are given in raw-LSB / (m/s²) per axis — matching
 * the C# `SensorLIS2DW12.cs` implementation.
 */
class SensorLIS2DW12 extends SensorBase {
    constructor() {
        super();
        this.offset = [0, 0, 0];
        this.align = [
            [0, 0, 1],
            [1, 0, 0],
            [0, 1, 0],
        ];
        this.sensitivityByRange = {
            '2G': [1671.665922915, 1671.665922915, 1671.665922915],
            '4G': [835.832961457, 835.832961457, 835.832961457],
            '8G': [417.916480729, 417.916480729, 417.916480729],
            '16G': [208.958240364, 208.958240364, 208.958240364],
        };
        this.range = '2G';
        this.samplingRateHz = 50;
    }
    setRange(rangeStr) {
        if (this.sensitivityByRange[rangeStr])
            this.range = rangeStr;
    }
    // --- Functional OpConfig helpers (returns new Uint8Array, does not mutate) ---
    setEnabled(enabled, opConfigBytes) {
        if (opConfigBytes == null) {
            this.enabled = enabled;
            return this.enabled;
        }
        const op = normalizeOperationalConfig(opConfigBytes);
        const out = new Uint8Array(op);
        const idx = OP_IDX.GEN_CFG_0;
        out[idx] = enabled ? (out[idx] | 0x80) & 0xff : out[idx] & 0x7f & 0xff;
        return out;
    }
    setAccelEnabled(enabled, opConfigBytes) {
        return this.setEnabled(enabled, opConfigBytes);
    }
    patchAccelRange(rangeCfg, op) {
        const out = new Uint8Array(op);
        const i = OP_IDX.ACCEL1_CFG_1;
        out[i] = (out[i] & 0b11001111) | ((rangeCfg & 0x03) << 4);
        return out;
    }
    patchAccelSamplingRate(rateCfg, op) {
        const out = new Uint8Array(op);
        const i = OP_IDX.ACCEL1_CFG_0;
        out[i] = (out[i] & 0b00001111) | ((rateCfg & 0x0f) << 4);
        return out;
    }
    _calibrate(raw) {
        const v = [
            raw[0] - this.offset[0],
            raw[1] - this.offset[1],
            raw[2] - this.offset[2],
        ];
        const a = this.align;
        const aligned = [
            a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
            a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
            a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
        ];
        const s = this.sensitivityByRange[this.range];
        return [aligned[0] / s[0], aligned[1] / s[1], aligned[2] / s[2]];
    }
    parsePayload(sensorPayloadBytes) {
        const BYTES_PER_SAMPLE = 6;
        const n = Math.floor(sensorPayloadBytes.length / BYTES_PER_SAMPLE);
        const out = [];
        for (let i = 0; i < n; i++) {
            const off = i * BYTES_PER_SAMPLE;
            const raw = [
                i16le(sensorPayloadBytes, off + 0),
                i16le(sensorPayloadBytes, off + 2),
                i16le(sensorPayloadBytes, off + 4),
            ];
            const cal = this._calibrate(raw);
            out.push({ raw, cal, units: { cal: 'm/s^2' } });
        }
        return out;
    }
    applyOperationalConfig(op) {
        const gen0 = op[OP_IDX.GEN_CFG_0];
        const cfg0 = op[OP_IDX.ACCEL1_CFG_0];
        const cfg1 = op[OP_IDX.ACCEL1_CFG_1];
        if (gen0 == null || cfg0 == null || cfg1 == null) {
            console.warn('[LIS2DW12] Missing required bytes; cannot apply config.');
            return;
        }
        this.enabled = ((gen0 >> 7) & 0x01) === 1;
        const rangeSetting = (cfg1 >> 4) & 0x03;
        const modeSetting = (cfg0 >> 2) & 0x03;
        const rateSetting = (cfg0 >> 4) & 0x0f;
        const rangeMap = { 0: '2G', 1: '4G', 2: '8G', 3: '16G' };
        this.setRange(rangeMap[rangeSetting] ?? '2G');
        const lowPowerHzByCfg = {
            1: 1.6,
            2: 12.5,
            3: 25,
            4: 50,
            5: 100,
            6: 200,
        };
        const highPerfHzByCfg = {
            1: 12.5,
            3: 25,
            4: 50,
            5: 100,
            6: 200,
            7: 400,
            8: 800,
            9: 1600,
        };
        const isLowPower = modeSetting === 0;
        const hz = isLowPower ? lowPowerHzByCfg[rateSetting] : highPerfHzByCfg[rateSetting];
        if (hz)
            this.samplingRateHz = hz;
    }
}

/**
 * Decoder for the LSM6DS3 combined accelerometer + gyroscope (Verisense sensor id = 3).
 *
 * Sensitivity values mirror the C# `SensorLSM6DS3.cs` implementation.
 */
class SensorLSM6DS3 extends SensorBase {
    constructor() {
        super();
        this.offset = [0, 0, 0];
        this.align = [
            [0, 0, 1],
            [-1, 0, 0],
            [0, -1, 0],
        ];
        this.accSensByRange = {
            '2G': [1671.665922915, 1671.665922915, 1671.665922915],
            '4G': [835.832961457, 835.832961457, 835.832961457],
            '8G': [417.916480729, 417.916480729, 417.916480729],
            '16G': [208.958240364, 208.958240364, 208.958240364],
        };
        this.gyroSensByRange = {
            '250DPS': [114.285714286, 114.285714286, 114.285714286],
            '500DPS': [57.142857143, 57.142857143, 57.142857143],
            '1000DPS': [28.571428571, 28.571428571, 28.571428571],
            '2000DPS': [14.285714286, 14.285714286, 14.285714286],
        };
        this.accRange = '2G';
        this.gyroRange = '250DPS';
        this.accEnabled = true;
        this.gyroEnabled = true;
        this.samplingRateHz = 50;
    }
    setAccelEnabled(v) {
        this.accEnabled = !!v;
    }
    setGyroEnabled(v) {
        this.gyroEnabled = !!v;
    }
    setAccelRange(r) {
        if (this.accSensByRange[r])
            this.accRange = r;
    }
    setGyroRange(r) {
        if (this.gyroSensByRange[r])
            this.gyroRange = r;
    }
    _applyAlignAndOffset(raw3) {
        const v = [
            raw3[0] - this.offset[0],
            raw3[1] - this.offset[1],
            raw3[2] - this.offset[2],
        ];
        const a = this.align;
        return [
            a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
            a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
            a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
        ];
    }
    parsePayload(sensorPayloadBytes) {
        let bytesPerSample = 6;
        if (this.gyroEnabled && this.accEnabled)
            bytesPerSample = 12;
        const n = Math.floor(sensorPayloadBytes.length / bytesPerSample);
        const out = [];
        for (let i = 0; i < n; i++) {
            const base = i * bytesPerSample;
            let gyroRaw = null;
            let accRaw = null;
            if (this.gyroEnabled && this.accEnabled) {
                gyroRaw = [
                    i16le(sensorPayloadBytes, base + 0),
                    i16le(sensorPayloadBytes, base + 2),
                    i16le(sensorPayloadBytes, base + 4),
                ];
                accRaw = [
                    i16le(sensorPayloadBytes, base + 6),
                    i16le(sensorPayloadBytes, base + 8),
                    i16le(sensorPayloadBytes, base + 10),
                ];
            }
            else if (this.gyroEnabled) {
                gyroRaw = [
                    i16le(sensorPayloadBytes, base + 0),
                    i16le(sensorPayloadBytes, base + 2),
                    i16le(sensorPayloadBytes, base + 4),
                ];
            }
            else if (this.accEnabled) {
                accRaw = [
                    i16le(sensorPayloadBytes, base + 0),
                    i16le(sensorPayloadBytes, base + 2),
                    i16le(sensorPayloadBytes, base + 4),
                ];
            }
            let accCal = null;
            let gyroCal = null;
            if (accRaw) {
                const aligned = this._applyAlignAndOffset(accRaw);
                const s = this.accSensByRange[this.accRange];
                accCal = [aligned[0] / s[0], aligned[1] / s[1], aligned[2] / s[2]];
            }
            if (gyroRaw) {
                const aligned = this._applyAlignAndOffset(gyroRaw);
                const s = this.gyroSensByRange[this.gyroRange];
                gyroCal = [aligned[0] / s[0], aligned[1] / s[1], aligned[2] / s[2]];
            }
            out.push({
                accel: accRaw && accCal ? { raw: accRaw, cal: accCal, units: 'm/s^2' } : null,
                gyro: gyroRaw && gyroCal ? { raw: gyroRaw, cal: gyroCal, units: 'deg/s' } : null,
            });
        }
        return out;
    }
    applyOperationalConfig(op) {
        this.accEnabled = (op[OP_IDX.GEN_CFG_0] & 0b01000000) !== 0;
        this.gyroEnabled = (op[OP_IDX.GEN_CFG_0] & 0b00100000) !== 0;
        const cfg4 = op[OP_IDX.GYRO_ACCEL2_CFG_4];
        const accelRateCfg = (cfg4 >> 4) & 0x0f;
        const cfg5 = op[OP_IDX.GYRO_ACCEL2_CFG_5];
        const accelRangeCfg = (cfg5 >> 2) & 0x03;
        const gyroRangeCfg = (cfg5 >> 4) & 0x03;
        const accelRangeMap = { 0: '2G', 1: '4G', 2: '8G', 3: '16G' };
        const gyroRangeMap = {
            0: '250DPS',
            1: '500DPS',
            2: '1000DPS',
            3: '2000DPS',
        };
        this.setAccelRange(accelRangeMap[accelRangeCfg] ?? this.accRange);
        this.setGyroRange(gyroRangeMap[gyroRangeCfg] ?? this.gyroRange);
        const hzByCfg = {
            0: null,
            1: 12.5,
            2: 26,
            3: 52,
            4: 104,
            5: 208,
            6: 416,
            7: 833,
            8: 1660,
        };
        const hz = hzByCfg[accelRateCfg];
        if (hz)
            this.samplingRateHz = hz;
    }
}

/**
 * Decoder for the PPG sensor (Verisense sensor id = 4).
 *
 * Calibration constants mirror C# `SensorPPG.cs`.
 */
class SensorPPG extends SensorBase {
    constructor() {
        super();
        this.red = false;
        this.ir = false;
        this.green = false;
        this.blue = false;
        this.adcLsb = [7.8125, 15.625, 31.25, 62.5];
        this.adcBitShift = [2 ** 7, 2 ** 6, 2 ** 5, 2 ** 4];
        this.adcResolutionIndex = 0; // 0..3
        this.samplingRateHz = 50;
    }
    setChannels(channels) {
        if (typeof channels.RED === 'boolean')
            this.red = channels.RED;
        if (typeof channels.IR === 'boolean')
            this.ir = channels.IR;
        if (typeof channels.GREEN === 'boolean')
            this.green = channels.GREEN;
        if (typeof channels.BLUE === 'boolean')
            this.blue = channels.BLUE;
    }
    setAdcResolutionIndex(i) {
        if (i >= 0 && i <= 3)
            this.adcResolutionIndex = i;
    }
    calibrateValue(uncalValue) {
        const idx = this.adcResolutionIndex;
        return ((uncalValue / this.adcBitShift[idx]) * this.adcLsb[idx]) / 1000.0;
    }
    parsePayload(sensorPayloadBytes) {
        const enabled = [];
        if (this.red)
            enabled.push('RED');
        if (this.ir)
            enabled.push('IR');
        if (this.green)
            enabled.push('GREEN');
        if (this.blue)
            enabled.push('BLUE');
        const bytesPerSample = enabled.length * 3;
        if (bytesPerSample === 0)
            return [];
        const n = Math.floor(sensorPayloadBytes.length / bytesPerSample);
        const out = [];
        for (let i = 0; i < n; i++) {
            const base = i * bytesPerSample;
            let off = 0;
            const sample = {};
            for (const ch of enabled) {
                const b0 = sensorPayloadBytes[base + off + 0];
                const b1 = sensorPayloadBytes[base + off + 1];
                const b2 = sensorPayloadBytes[base + off + 2];
                off += 3;
                let uncal = (b0 | (b1 << 8) | (b2 << 16)) >>> 0;
                uncal &= 0x7ffff;
                sample[ch] = {
                    raw: uncal,
                    cal: this.calibrateValue(uncal),
                    units: { raw: 'counts', cal: 'scaled' },
                };
            }
            out.push(sample);
        }
        return out;
    }
    applyOperationalConfig(_op) {
        // PPG channels are configured by the operational config but the bit
        // mapping is hardware-specific. For now we leave channel flags as-is;
        // callers can use setChannels() directly.
        void normalizeOperationalConfig(_op); // no-op, satisfies lint
    }
}

function defaultAcceptedCommands(command) {
    if (command === ASM_COMMAND.READ)
        return new Set([ASM_COMMAND.RESPONSE]);
    if (command === ASM_COMMAND.WRITE) {
        return new Set([ASM_COMMAND.ACK, ASM_COMMAND.ACK_NEXT_STAGE, ASM_COMMAND.RESPONSE]);
    }
    return new Set([ASM_COMMAND.ACK, ASM_COMMAND.ACK_NEXT_STAGE, ASM_COMMAND.RESPONSE]);
}
function toCommandResponse(msg) {
    return {
        header: msg.header,
        command: msg.command,
        property: msg.property,
        payload: msg.payload,
    };
}
function validatePendingResponse(pending, msg) {
    if (isNackCommand(msg.command)) {
        return new Error(`Device returned NACK command=0x${msg.command.toString(16)} property=0x${msg.property.toString(16)}`);
    }
    if (pending.acceptedProperties?.size) {
        if (!pending.acceptedProperties.has(msg.property)) {
            return new Error(`Unexpected response property 0x${msg.property.toString(16)} (expected one of ${Array.from(pending.acceptedProperties)
                .map((p) => `0x${p.toString(16)}`)
                .join(', ')})`);
        }
    }
    else if (msg.property !== pending.expectedProperty) {
        return new Error(`Unexpected response property 0x${msg.property.toString(16)} (expected 0x${pending.expectedProperty.toString(16)})`);
    }
    if (!pending.acceptedCommands.has(msg.command)) {
        return new Error(`Unexpected response command 0x${msg.command.toString(16)} for property 0x${msg.property.toString(16)}`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// VerisenseBleDevice
// ---------------------------------------------------------------------------
/**
 * Web Bluetooth client for the Verisense sensor platform.
 *
 * Extends {@link BaseShimmerClient} and adds an event-emitter API
 * (on/off/emit) for the richer event model the Verisense protocol needs.
 *
 * Supports:
 * - BLE streaming (accel, ADC/GSR, gyro, PPG)
 * - Web Serial (USB COM port) as an alternative transport
 * - Logged-data download (`transferLoggedData`)
 * - Operational config read/write
 *
 * Events:
 * - `"connected"` — `{ name?: string; id?: string; kind?: string }`
 * - `"disconnected"` — `{ kind: TransportKind }`
 * - `"streaming"` — `{ on: boolean }`
 * - `"streamPacket"` / `"data"` — `StreamPacket`
 * - `"streamCrcFail"` — `{ claimed: number; body: Uint8Array }`
 * - `"opConfig"` — `{ op: Uint8Array }`
 * - `"productionConfig"` — `ProductionConfig`
 * - `"commandPayload"` — `{ payload: Uint8Array }`
 */
class VerisenseBleDevice extends BaseShimmerClient {
    on(ev, fn) {
        if (!this._evMap.has(ev))
            this._evMap.set(ev, new Set());
        this._evMap.get(ev).add(fn);
        return () => this.off(ev, fn);
    }
    off(ev, fn) {
        this._evMap.get(ev)?.delete(fn);
    }
    emit(ev, data) {
        const s = this._evMap.get(ev);
        if (s)
            for (const fn of s)
                fn(data);
    }
    constructor(opts = {}) {
        super({ debug: opts.debug ?? true });
        // Event emitter state
        this._evMap = new Map();
        // Transport handles
        this._transportKind = null;
        this.device = null;
        this.server = null;
        this.service = null;
        this.tx = null;
        this.rx = null;
        this.port = null;
        this._serialAbort = null;
        this._serialReader = null;
        this._serialReadLoopTask = null;
        this._onGattDisconnected = null;
        // Protocol state
        this._mode = 'idle';
        this._rxStreamBuf = new Uint8Array(0);
        this._pending = null;
        this._loggedChain = Promise.resolve();
        this._sync = null;
        this._testReportCapture = null;
        this._testReportDecoder = new TextDecoder();
        // Cached configs
        this.operationalConfig = null;
        this.productionConfig = null;
        // Debug flags
        this.debugSync = true;
        this._syncRxCount = 0;
        this._syncPayloadCount = 0;
        this.hardwareIdentifier = opts.hardwareIdentifier ?? 'VERISENSE_PULSE_PLUS';
        this.stripStreamCrc = opts.stripStreamCrc ?? true;
        this.verifyStreamCrc = opts.verifyStreamCrc ?? false;
        this.sensors = {
            1: new SensorADC(),
            2: new SensorLIS2DW12(),
            3: new SensorLSM6DS3(),
            4: new SensorPPG(),
        };
        this.sensors[1].setHardwareIdentifier(this.hardwareIdentifier);
    }
    _log(...args) {
        if (this.debug)
            console.log('[Verisense]', ...args);
    }
    // Quick accessors
    get adc() {
        return this.sensors[1];
    }
    get accel1() {
        return this.sensors[2];
    }
    get gyroAccel2() {
        return this.sensors[3];
    }
    get ppg() {
        return this.sensors[4];
    }
    // ---------------------------------------------------------------------------
    // BLE connect / disconnect
    // ---------------------------------------------------------------------------
    async connect(opts = {}) {
        if (this._transportKind === 'serial' || this.port) {
            try {
                await this.disconnect();
            }
            catch {
                /* ignore */
            }
        }
        this._transportKind = 'ble';
        const requestOpts = {
            filters: opts.filters ?? [{ services: [NUS_SERVICE] }],
            optionalServices: opts.optionalServices ?? [NUS_SERVICE],
        };
        this.device = opts.device ?? (await navigator.bluetooth.requestDevice(requestOpts));
        try {
            if (this._onGattDisconnected && this.device) {
                this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
            }
        }
        catch {
            /* ignore */
        }
        this._onGattDisconnected = () => {
            this._mode = 'idle';
            this._transportKind = null;
            this._clearHardwareTestReportCapture(new Error('Disconnected'), null);
            this.emit('disconnected', { kind: 'ble' });
        };
        this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
        this.server = await this.device.gatt.connect();
        this.service = await this.server.getPrimaryService(NUS_SERVICE);
        this.tx = await this.service.getCharacteristic(NUS_TX);
        this.rx = await this.service.getCharacteristic(NUS_RX);
        await this.rx.startNotifications();
        this.rx.addEventListener('characteristicvaluechanged', (ev) => {
            const dv = ev.target?.value;
            if (!dv)
                return;
            const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
            this._feedStreamBytes(bytes);
        });
        this._emitStatus(`Connected: ${this.device.name ?? 'Verisense'}`);
        this.emit('connected', { name: this.device.name, id: this.device.id });
        await this.readProductionConfigFromDevice();
        await this.readOpConfigFromDevice();
        return true;
    }
    // --- Web Serial (USB COM port) connect ---
    async connectSerial(opts = {}) {
        if (!('serial' in navigator)) {
            throw new Error('Web Serial not supported. Use Chrome/Edge on HTTPS or http://localhost.');
        }
        if (this._transportKind === 'ble' && this.device?.gatt?.connected) {
            await this.disconnect();
        }
        else if (this._transportKind === 'serial' && this.port) {
            await this.disconnect();
        }
        this._transportKind = 'serial';
        this._mode = 'idle';
        this._resetAssembler();
        const serial = navigator.serial;
        if (!opts.port) {
            opts.port = await serial.requestPort(opts.filters ? { filters: opts.filters } : undefined);
        }
        this.port = opts.port;
        await this.port.open({
            baudRate: opts.baudRate ?? 115200,
            dataBits: opts.dataBits ?? 8,
            stopBits: opts.stopBits ?? 1,
            parity: opts.parity ?? 'none',
            flowControl: opts.flowControl ?? 'none',
        });
        this._serialAbort = new AbortController();
        this._startSerialReadLoop(this._serialAbort.signal);
        this._emitStatus('Connected via USB Serial');
        this.emit('connected', { kind: 'serial' });
        await this.readOpConfigFromDevice();
        return true;
    }
    async _serialWrite(u8) {
        const writable = this.port.writable;
        if (!writable)
            throw new Error('Not connected');
        const writer = writable.getWriter();
        try {
            await writer.write(u8);
        }
        finally {
            writer.releaseLock();
        }
    }
    _startSerialReadLoop(signal) {
        const port = this.port;
        this._serialReadLoopTask = (async () => {
            let reader = null;
            try {
                const readable = port.readable;
                if (!readable)
                    return;
                reader = readable.getReader();
                this._serialReader = reader;
                while (!signal.aborted) {
                    const { value, done } = await reader.read();
                    if (done)
                        break;
                    if (value?.length)
                        this._feedStreamBytes(new Uint8Array(value));
                }
            }
            catch (e) {
                if (!signal.aborted)
                    console.warn('[serial] read loop error:', e);
            }
            finally {
                try {
                    reader?.releaseLock?.();
                }
                catch {
                    /* ignore */
                }
                if (this._serialReader === reader)
                    this._serialReader = null;
                this._serialReadLoopTask = null;
                if (!signal.aborted) {
                    this._mode = 'idle';
                    this._clearHardwareTestReportCapture(new Error('Disconnected'), null);
                    this.emit('disconnected', { kind: 'serial' });
                }
            }
        })();
    }
    async _serialDisconnect(reason = 'user') {
        try {
            this._serialAbort?.abort();
        }
        catch {
            /* ignore */
        }
        const cancelActiveReader = async () => {
            const r = this._serialReader;
            if (!r)
                return false;
            try {
                await r.cancel();
            }
            catch {
                /* ignore */
            }
            try {
                r.releaseLock();
            }
            catch {
                /* ignore */
            }
            if (this._serialReader === r)
                this._serialReader = null;
            return true;
        };
        await cancelActiveReader();
        const portReadableLocked = this.port
            ?.readable?.locked;
        if (portReadableLocked && !this._serialReader) {
            for (let i = 0; i < 10; i++) {
                await new Promise((r) => setTimeout(r, 20));
                if (await cancelActiveReader())
                    break;
            }
        }
        try {
            const task = this._serialReadLoopTask;
            if (task)
                await Promise.race([task, new Promise((r) => setTimeout(r, 750))]);
        }
        catch {
            /* ignore */
        }
        try {
            const writable = this.port?.writable;
            if (writable?.locked) {
                const w = writable.getWriter();
                try {
                    await w.abort?.();
                }
                catch {
                    /* ignore */
                }
                try {
                    w.releaseLock();
                }
                catch {
                    /* ignore */
                }
            }
        }
        catch {
            /* ignore */
        }
        try {
            await this.port?.close?.();
        }
        catch {
            /* ignore */
        }
        this.port = null;
        this._serialAbort = null;
        this._serialReader = null;
        this._serialReadLoopTask = null;
        console.warn(`[serial] disconnect done reason=${reason}`);
    }
    async disconnect(opts = {}) {
        const kind = this._transportKind === 'serial' ? 'serial' : 'ble';
        if (this._mode === 'streaming') {
            try {
                await this.stopStreaming();
            }
            catch {
                /* ignore */
            }
        }
        if (this._sync) {
            try {
                this._abortSync(new Error(opts.reason ?? 'Disconnected'));
            }
            catch {
                /* ignore */
            }
        }
        this._clearHardwareTestReportCapture(new Error(opts.reason ?? 'Disconnected'), null);
        if (this._transportKind === 'serial') {
            try {
                await this._serialDisconnect(opts.reason ?? 'user');
            }
            catch {
                /* ignore */
            }
        }
        else {
            void this.writeBytes(buildMessage(ASM_COMMAND.WRITE, ASM_PROPERTY.DEVICE_DISCONNECT), {
                withResponse: false,
            });
            try {
                if (this.rx)
                    await this.rx.stopNotifications?.();
            }
            catch {
                /* ignore */
            }
            try {
                if (this._onGattDisconnected && this.device) {
                    this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
                }
            }
            catch {
                /* ignore */
            }
            try {
                if (this.device?.gatt?.connected)
                    this.device.gatt.disconnect();
            }
            catch {
                /* ignore */
            }
        }
        this._mode = 'idle';
        this._transportKind = null;
        this.port = null;
        this._serialAbort = null;
        this.tx = this.rx = null;
        this.service = this.server = this.device = null;
        this.emit('disconnected', { kind });
        return true;
    }
    // ---------------------------------------------------------------------------
    // Streaming
    // ---------------------------------------------------------------------------
    async startStreaming() {
        await this.setStreamingMode(true);
        this._mode = 'streaming';
        this.emit('streaming', { on: true });
    }
    async stopStreaming() {
        await this.setStreamingMode(false);
        this._mode = 'idle';
        this.emit('streaming', { on: false });
    }
    // ---------------------------------------------------------------------------
    // Logged data transfer
    // ---------------------------------------------------------------------------
    async transferLoggedData(opts = {}) {
        const { fileHandle = null, timeoutMs = 1000, maxNack = 5, maxCrcNack = 5, onProgress = null, } = opts;
        const bleOk = !!(this.rx && this.tx);
        const serOk = !!this.port;
        if (!bleOk && !serOk)
            throw new Error('Not connected');
        if (this._mode === 'streaming')
            throw new Error('Stop streaming before TransferLoggedData');
        if (this._mode === 'logged')
            throw new Error('Already syncing logged data');
        let writable = null;
        const chunks = [];
        if (fileHandle)
            writable = await fileHandle.createWritable();
        this._mode = 'logged';
        this._resetAssembler();
        this._loggedChain = Promise.resolve();
        this._syncRxCount = 0;
        this._syncPayloadCount = 0;
        const sync = {
            receiving: true,
            lastReply: 'NONE',
            emptyAckCount: 0,
            nackCount: 0,
            nackCrcCount: 0,
            maxNack,
            maxCrcNack,
            lastRxAt: Date.now(),
            timeoutMs,
            bytesWritten: 0,
            resolve: null,
            reject: null,
            timer: null,
            writable,
            chunks,
            onProgress: onProgress ?? null,
        };
        this._sync = sync;
        const donePromise = new Promise((resolve, reject) => {
            sync.resolve = resolve;
            sync.reject = reject;
        });
        let watchdogRunning = false;
        sync.timer = setInterval(async () => {
            if (watchdogRunning)
                return;
            watchdogRunning = true;
            try {
                if (!this._sync?.receiving)
                    return;
                const age = Date.now() - this._sync.lastRxAt;
                if (age < this._sync.timeoutMs)
                    return;
                try {
                    if (this._sync.lastReply === 'NONE') {
                        await this.writeBytes(buildMessage(ASM_COMMAND.READ, ASM_PROPERTY.DATA), {
                            withResponse: true,
                        });
                    }
                    else {
                        this._clearSyncRxBuffers('timeout-nack');
                        await this.writeBytes(buildMessage(ASM_COMMAND.NACK_GENERIC, ASM_PROPERTY.DATA));
                        this._sync.nackCount++;
                        this._sync.lastReply = 'NACK';
                        if (this._sync.nackCount >= this._sync.maxNack)
                            throw new Error('Too many NACK timeouts');
                    }
                    this._sync.lastRxAt = Date.now();
                }
                catch (e) {
                    this._abortSync(e instanceof Error ? e : new Error(String(e)));
                }
            }
            finally {
                watchdogRunning = false;
            }
        }, Math.max(250, Math.floor(timeoutMs / 2)));
        try {
            await this.writeBytes(buildMessage(ASM_COMMAND.READ, ASM_PROPERTY.DATA), {
                withResponse: true,
            });
            const result = await donePromise;
            await (this._loggedChain ?? Promise.resolve());
            if (!fileHandle) {
                const blob = new Blob(chunks.map(toArrayBuffer), { type: 'application/octet-stream' });
                return { ...result, blob };
            }
            return result;
        }
        finally {
            if (sync.timer) {
                clearInterval(sync.timer);
                sync.timer = null;
            }
            if (writable)
                await writable.close();
        }
    }
    // ---------------------------------------------------------------------------
    // Request / response helpers
    // ---------------------------------------------------------------------------
    async writeBytes(bytes, opts = {}) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (this._transportKind === 'serial') {
            await this._serialWrite(u8);
            return;
        }
        if (!this.tx)
            throw new Error('Not connected');
        if (opts.withResponse) {
            await this.tx.writeValue(toArrayBuffer(u8));
            return;
        }
        const txExt = this.tx;
        if (txExt.writeValueWithoutResponse) {
            await txExt.writeValueWithoutResponse(toArrayBuffer(u8));
        }
        else {
            await this.tx.writeValue(toArrayBuffer(u8));
        }
    }
    async _requestByCommand(command, property, payloadBytes = [], timeoutMs = 3000, acceptedCommands, acceptedProperties) {
        if (this._pending)
            throw new Error('A request is already pending');
        this._mode = 'command';
        this._resetAssembler();
        const req = buildMessage(command, property, payloadBytes);
        const accepted = acceptedCommands ?? defaultAcceptedCommands(command);
        const pendingPromise = new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                this._pending = null;
                reject(new Error('Request timeout'));
            }, timeoutMs);
            this._pending = {
                expectedProperty: property,
                acceptedCommands: accepted,
                acceptedProperties,
                resolve: (resp) => {
                    clearTimeout(t);
                    this._pending = null;
                    resolve(resp);
                },
                reject: (e) => {
                    clearTimeout(t);
                    this._pending = null;
                    reject(e);
                },
            };
        });
        await this.writeBytes(req);
        return pendingPromise;
    }
    async readProperty(property, timeoutMs = 3000) {
        return this._requestByCommand(ASM_COMMAND.READ, property, [], timeoutMs);
    }
    async writeProperty(property, payloadBytes = [], timeoutMs = 3000) {
        return this._requestByCommand(ASM_COMMAND.WRITE, property, payloadBytes, timeoutMs);
    }
    async request(opcode, payloadBytes = [], timeoutMs = 3000) {
        const { command, property } = parseHeader(opcode & 0xff);
        const rsp = await this._requestByCommand(command, property, payloadBytes, timeoutMs);
        return { payload: rsp.payload };
    }
    // Convenience command methods (all protocol properties)
    readStatus() {
        return this.request(ASM_COMMAND.READ | ASM_PROPERTY.STATUS1);
    }
    async readStatusParsed() {
        const { payload } = await this.readStatus();
        return parseStatusPayload(payload, 'status1');
    }
    readStatus2() {
        return this.request(ASM_COMMAND.READ | ASM_PROPERTY.STATUS2);
    }
    async readStatus2Parsed() {
        const { payload } = await this.readStatus2();
        return parseStatusPayload(payload, 'status2');
    }
    readData() {
        return this.request(ASM_COMMAND.READ | ASM_PROPERTY.DATA);
    }
    readProductionConfig() {
        return this.request(ASM_COMMAND.READ | ASM_PROPERTY.PRODUCTION_CONFIGURATION);
    }
    readOperationalConfig() {
        return this.request(ASM_COMMAND.READ | ASM_PROPERTY.OPERATIONAL_CONFIGURATION);
    }
    readTime() {
        return this.request(ASM_COMMAND.READ | ASM_PROPERTY.TIME);
    }
    async readTimeUnixSeconds() {
        const { payload } = await this.readTime();
        return asmRtcBytesToUnixSeconds(payload);
    }
    readPendingEvents() {
        return this.request(ASM_COMMAND.READ | ASM_PROPERTY.PENDING_EVENTS);
    }
    async readPendingEventsParsed() {
        const { payload } = await this.readPendingEvents();
        return parsePendingEvents(payload);
    }
    async writeProductionConfig(bytes) {
        const payload = normalizeBytePayload(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        if (!payload || payload.length < 11 || payload.length > 56) {
            throw new Error('writeProductionConfig: payload length must be between 11 and 56 bytes');
        }
        await this.writeProperty(ASM_PROPERTY.PRODUCTION_CONFIGURATION, payload);
    }
    async writeOperationalConfig(bytes) {
        const payload = normalizeBytePayload(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        if (!payload || payload.length < 50) {
            throw new Error('writeOperationalConfig: payload length must be at least 50 bytes');
        }
        await this.writeProperty(ASM_PROPERTY.OPERATIONAL_CONFIGURATION, payload);
    }
    async writeTime(rtc7) {
        const payload = normalizeBytePayload(rtc7 instanceof Uint8Array ? rtc7 : new Uint8Array(rtc7));
        if (!payload || payload.length !== 7) {
            throw new Error('writeTime: payload must be exactly 7 bytes');
        }
        await this.writeProperty(ASM_PROPERTY.TIME, payload);
    }
    async writeTimeUnixSeconds(unixSeconds) {
        await this.writeTime(unixSecondsToAsmRtcBytes(unixSeconds));
    }
    /**
     * Enables Nordic Secure DFU service advertisement after the next disconnect.
     *
     * This sends ASM DFU_MODE property write (equivalent to [0x26, 0x00, 0x00]).
     * It does not immediately reboot into bootloader mode.
     */
    async enableDfuServiceOnNextDisconnect() {
        await this.writeProperty(ASM_PROPERTY.DFU_MODE, []);
    }
    /**
     * @deprecated Use enableDfuServiceOnNextDisconnect() for clearer semantics.
     */
    async enterDfuMode() {
        await this.enableDfuServiceOnNextDisconnect();
    }
    /**
     * Uses Nordic buttonless DFU characteristic to reboot the connected device into bootloader mode.
     *
     * Requirements:
     * - BLE transport must be connected
     * - Nordic Secure DFU service and buttonless characteristic must be present
     */
    async rebootToDfuBootloader(opts = {}) {
        if (this._transportKind !== 'ble' || !this.device?.gatt?.connected || !this.server) {
            throw new Error('rebootToDfuBootloader: requires an active BLE connection');
        }
        const waitForDisconnect = opts.waitForDisconnect ?? true;
        const disconnectAfterCommand = opts.disconnectAfterCommand ?? true;
        const timeoutMs = Math.max(500, Math.trunc(opts.timeoutMs ?? 8000));
        const dfuService = await this.server.getPrimaryService(NORDIC_DFU_SERVICE);
        let buttonlessChar;
        try {
            buttonlessChar = await dfuService.getCharacteristic(NORDIC_DFU_BUTTONLESS_CHAR);
        }
        catch {
            const hasControl = await dfuService
                .getCharacteristic(NORDIC_DFU_CONTROL_CHAR)
                .then(() => true)
                .catch(() => false);
            const hasPacket = await dfuService
                .getCharacteristic(NORDIC_DFU_PACKET_CHAR)
                .then(() => true)
                .catch(() => false);
            if (hasControl && hasPacket) {
                throw new Error('Device already appears to be in DFU bootloader mode');
            }
            throw new Error('Nordic buttonless DFU characteristic not found');
        }
        if (buttonlessChar.properties.notify || buttonlessChar.properties.indicate) {
            try {
                await buttonlessChar.startNotifications();
            }
            catch {
                /* some stacks may still allow write without notifications */
            }
        }
        const device = this.device;
        let disconnectPromise = null;
        if (waitForDisconnect) {
            let offDisconnect = null;
            disconnectPromise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (offDisconnect)
                        offDisconnect();
                    reject(new Error(`Timed out waiting for reboot/disconnect (${timeoutMs} ms)`));
                }, timeoutMs);
                const onDisconnect = () => {
                    clearTimeout(timer);
                    if (offDisconnect)
                        offDisconnect();
                    resolve();
                };
                device.addEventListener('gattserverdisconnected', onDisconnect, { once: true });
                offDisconnect = () => {
                    try {
                        device.removeEventListener('gattserverdisconnected', onDisconnect);
                    }
                    catch {
                        /* ignore */
                    }
                };
            });
        }
        const cmd = new Uint8Array([0x01]);
        await buttonlessChar.writeValue(cmd);
        if (disconnectAfterCommand && device.gatt?.connected) {
            try {
                device.gatt.disconnect();
            }
            catch {
                /* ignore */
            }
        }
        if (waitForDisconnect) {
            if (!device.gatt?.connected)
                return;
            if (disconnectPromise)
                await disconnectPromise;
        }
    }
    async runTestMode(testPayload) {
        const payload = normalizeBytePayload(testPayload instanceof Uint8Array ? testPayload : new Uint8Array(testPayload));
        if (!payload || payload.length < 2) {
            throw new Error('runTestMode: payload must contain at least [testId, hwMajor]');
        }
        await this.writeProperty(ASM_PROPERTY.TEST_MODE, payload);
    }
    async runHardwareTest(testId, hwMajor, hwMinor = 0, hwInternal = 0) {
        const payload = new Uint8Array([
            testId & 0xff,
            hwMajor & 0xff,
            hwMinor & 0xff,
            hwInternal & 0xff,
            (hwInternal >> 8) & 0xff,
        ]);
        await this.runTestMode(payload);
    }
    _clearHardwareTestReportCapture(error, text) {
        const cap = this._testReportCapture;
        if (!cap)
            return;
        this._testReportCapture = null;
        if (cap.timeout) {
            clearTimeout(cap.timeout);
            cap.timeout = null;
        }
        if (error) {
            cap.reject?.(error);
            return;
        }
        cap.resolve?.(text ?? '');
    }
    _captureHardwareTestReportChunk(chunk) {
        const cap = this._testReportCapture;
        if (!cap || !chunk?.length)
            return;
        const decoded = this._testReportDecoder.decode(chunk, { stream: true });
        if (!decoded)
            return;
        cap.aggregateText += decoded;
        if (!cap.started) {
            const firstMarker = cap.aggregateText.indexOf(cap.marker);
            if (firstMarker >= 0) {
                cap.started = true;
                if (firstMarker > 0) {
                    cap.aggregateText = cap.aggregateText.slice(firstMarker);
                    cap.emittedChars = 0;
                }
            }
            else {
                // Some firmware builds vary the star count around TEST START. Fall back
                // to a fuzzy marker so we can still stream the report to the UI.
                const hint = VerisenseBleDevice.TEST_REPORT_MARKER_HINT;
                const hintIdx = cap.aggregateText.indexOf(hint);
                if (hintIdx < 0) {
                    const keep = Math.max(cap.marker.length * 2, 2048);
                    if (cap.aggregateText.length > keep) {
                        cap.aggregateText = cap.aggregateText.slice(-keep);
                    }
                    return;
                }
                const bannerStart = cap.aggregateText.lastIndexOf('//', hintIdx);
                let lineStart = bannerStart >= 0 ? bannerStart : cap.aggregateText.lastIndexOf('\n', hintIdx);
                lineStart = lineStart >= 0 ? lineStart + (bannerStart >= 0 ? 0 : 1) : 0;
                cap.started = true;
                if (lineStart > 0) {
                    cap.aggregateText = cap.aggregateText.slice(lineStart);
                    cap.emittedChars = 0;
                }
            }
        }
        const nextChunk = cap.aggregateText.slice(cap.emittedChars);
        if (nextChunk) {
            cap.onChunk?.(nextChunk, cap.aggregateText);
            this.emit('hardwareTestReportChunk', {
                chunkText: nextChunk,
                aggregateText: cap.aggregateText,
            });
            cap.emittedChars = cap.aggregateText.length;
        }
        const endMarker = cap.aggregateText.indexOf(cap.marker, cap.marker.length);
        let full = null;
        if (endMarker >= 0) {
            full = cap.aggregateText.slice(0, endMarker + cap.marker.length);
        }
        else {
            const hint = VerisenseBleDevice.TEST_REPORT_MARKER_HINT;
            const firstHint = cap.aggregateText.indexOf(hint);
            if (firstHint >= 0) {
                const secondHint = cap.aggregateText.indexOf(hint, firstHint + hint.length);
                if (secondHint >= 0) {
                    const endOfSecondLine = cap.aggregateText.indexOf('\n', secondHint);
                    full = endOfSecondLine >= 0
                        ? cap.aggregateText.slice(0, endOfSecondLine + 1)
                        : cap.aggregateText;
                }
            }
        }
        if (full !== null) {
            this.emit('hardwareTestReportComplete', { text: full });
            this._clearHardwareTestReportCapture(null, full);
            return;
        }
        if (cap.aggregateText.length > cap.maxChars) {
            cap.aggregateText = cap.aggregateText.slice(-cap.maxChars);
            cap.emittedChars = Math.min(cap.emittedChars, cap.aggregateText.length);
        }
    }
    /**
     * Runs TEST_REPORT (0xFE) and captures the rolling text report.
     *
     * The firmware ACKs the command first, then emits plain-text lines over the link.
     * Capture starts on the first delimiter and completes on the second delimiter.
     */
    async runHardwareTestReport(hwMajor, hwMinor = 0, hwInternal = 0, opts = {}) {
        const timeoutMs = Math.max(1000, Math.trunc(opts.timeoutMs ?? 120000));
        const marker = typeof opts.marker === 'string' && opts.marker.length > 0
            ? opts.marker
            : VerisenseBleDevice.TEST_REPORT_DELIMITER;
        const maxChars = Math.max(4096, Math.trunc(opts.maxChars ?? 2 * 1024 * 1024));
        this._clearHardwareTestReportCapture(new Error('Hardware test report capture was replaced'), null);
        this._testReportDecoder.decode();
        const reportPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._clearHardwareTestReportCapture(new Error(`Hardware test report timeout after ${timeoutMs} ms`), null);
            }, timeoutMs);
            this._testReportCapture = {
                marker,
                maxChars,
                started: false,
                aggregateText: '',
                emittedChars: 0,
                resolve,
                reject,
                onChunk: opts.onChunk ?? null,
                timeout,
            };
        });
        try {
            const factoryTestType = Math.max(0, Math.min(255, Math.trunc(opts.factoryTestType ?? 0)));
            const payload = new Uint8Array([
                VerisenseBleDevice.TEST_REPORT_MODE_ID & 0xff,
                hwMajor & 0xff,
                hwMinor & 0xff,
                hwInternal & 0xff,
                (hwInternal >> 8) & 0xff,
                factoryTestType,
            ]);
            await this.runTestMode(payload);
        }
        catch (error) {
            this._clearHardwareTestReportCapture(error, null);
            throw error;
        }
        return reportPromise;
    }
    _buildDebugPayload(debugId, args = []) {
        const argBytes = args instanceof Uint8Array ? args : new Uint8Array(args);
        const payload = new Uint8Array(1 + argBytes.length);
        payload[0] = debugId & 0xff;
        payload.set(argBytes, 1);
        return payload;
    }
    _debugIndexArgs(index) {
        const i = Math.max(0, Math.min(0xff, Math.trunc(index)));
        return i > 0 ? [i] : [];
    }
    _waitForDebugResponse(timeoutMs = 3000) {
        return new Promise((resolve, reject) => {
            let done = false;
            let off = null;
            let timer = null;
            const cleanup = () => {
                if (off) {
                    try {
                        off();
                    }
                    catch {
                        /* ignore */
                    }
                    off = null;
                }
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            };
            off = this.on('commandPayload', (evt) => {
                if (done || !evt)
                    return;
                if (evt.command !== ASM_COMMAND.RESPONSE || evt.property !== ASM_PROPERTY.DEBUG_COMMAND)
                    return;
                done = true;
                cleanup();
                resolve({ payload: evt.payload ?? new Uint8Array(0) });
            });
            timer = setTimeout(() => {
                if (done)
                    return;
                done = true;
                cleanup();
                reject(new Error('Debug response timeout'));
            }, timeoutMs);
        });
    }
    async readDebugCommand(debugId, args = [], timeoutMs = 3000) {
        const payload = this._buildDebugPayload(debugId, args);
        const debugAcceptedProps = new Set([ASM_PROPERTY.DEBUG_COMMAND, 0]);
        // Python flow: WRITE DEBUG command, optional empty/transient frame, then RESPONSE DEBUG payload.
        const responsePromise = this._waitForDebugResponse(timeoutMs);
        try {
            await this._requestByCommand(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, payload, timeoutMs, undefined, debugAcceptedProps);
            return await responsePromise;
        }
        catch (e) {
            void responsePromise.catch(() => { });
            const msg = e instanceof Error ? e.message : String(e);
            const isDebugNack = /NACK command=0x(?:50|60|70) property=0x9/i.test(msg);
            const isDebugAckPropertyZero = /Unexpected response property 0x0 \(expected 0x9\)/i.test(msg);
            if (!isDebugNack && !isDebugAckPropertyZero)
                throw e;
            const rsp = await this._requestByCommand(ASM_COMMAND.READ, ASM_PROPERTY.DEBUG_COMMAND, payload, timeoutMs);
            return { payload: rsp.payload };
        }
    }
    async sendDebugCommand(debugId, args = [], timeoutMs = 3000) {
        const rsp = await this._requestByCommand(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, this._buildDebugPayload(debugId, args), timeoutMs);
        return { payload: rsp.payload };
    }
    async readFlashLookupTable(_index = 0, timeoutMs = 12000) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.FLASH_LOOKUP_TABLE_READ, [], timeoutMs);
    }
    async readRealWorldClockScheduler(_index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.RWC_SCHEDULER_READ);
    }
    async readRealWorldClockSchedulerParsed(index = 0) {
        const { payload } = await this.readRealWorldClockScheduler(index);
        return parseSchedulerDebugPayload(payload);
    }
    async loadTestLookupTable(_index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.LOAD_TEST_LOOKUP_TABLE);
    }
    async checkPayloadCrcErrors(_index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.CHECK_PAYLOAD_CRC_ERRORS);
    }
    async checkPayloadCrcErrorsParsed(index = 0) {
        const { payload } = await this.checkPayloadCrcErrors(index);
        return parsePayloadCrcErrorBankIndexes(payload);
    }
    async readEventLog(_index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.READ_EVENT_LOG);
    }
    async readEventLogParsed(index = 0) {
        const { payload } = await this.readEventLog(index);
        return parseEventLogPayload(payload);
    }
    async readRecordBufferDetails(_index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.READ_RECORD_BUFFER_DETAILS);
    }
    async readRecordBufferDetailsParsed(index = 0) {
        const { payload } = await this.readRecordBufferDetails(index);
        return parseRecordBufferDetailsPayload(payload);
    }
    async eraseOperationalConfig() {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.ERASE_OPERATIONAL_CONFIG);
    }
    async eraseProductionConfig() {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.ERASE_PRODUCTION_CONFIG);
    }
    async clearPendingEvents() {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.CLEAR_PENDING_EVENTS);
    }
    async eraseAllLoggedData(timeoutMs = 12000) {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.ERASE_FLASH_AND_LOOKUP_TABLE, [], timeoutMs);
    }
    async testDataTransferLoop(loopCount) {
        const clamped = Math.max(0, Math.min(0xffff, Math.trunc(loopCount)));
        await this.sendDebugCommand(DEBUG_COMMAND_ID.TEST_DATA_TRANSFER_LOOP, [
            clamped & 0xff,
            (clamped >> 8) & 0xff,
        ]);
    }
    async ledTest(ledIndex) {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.LED_TEST, [ledIndex & 0xff]);
    }
    async max86xxxLedTest(start) {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.MAX86XXX_LED_TEST, [start ? 0x01 : 0x00]);
    }
    async startPowerProfilerTest() {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.POWER_PROFILER_TEST);
    }
    async requestSystemReset() {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.SYSTEM_RESET);
    }
    async startIcPowerConsumptionTest(loopCount, stageIntervalMs) {
        const clampedLoopCount = Math.max(0, Math.min(0xffff, Math.trunc(loopCount)));
        const clampedStageInterval = Math.max(0, Math.min(0xffff, Math.trunc(stageIntervalMs)));
        await this.sendDebugCommand(DEBUG_COMMAND_ID.IC_POWER_CONSUMPTION_TEST, [
            clampedLoopCount & 0xff,
            (clampedLoopCount >> 8) & 0xff,
            clampedStageInterval & 0xff,
            (clampedStageInterval >> 8) & 0xff,
        ]);
    }
    async deleteAllBonds() {
        await this.sendDebugCommand(DEBUG_COMMAND_ID.DELETE_ALL_BONDS);
    }
    async setStreamingMode(enabled) {
        await this.writeProperty(ASM_PROPERTY.STREAM_MODE, [enabled ? STREAM_MODE.ENABLE : STREAM_MODE.DISABLE], 3000);
    }
    async disconnectRequest() {
        try {
            return await this.request(ASM_COMMAND.WRITE | ASM_PROPERTY.DEVICE_DISCONNECT, [], 1500);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/timeout/i.test(msg))
                return { payload: new Uint8Array(0) };
            throw e;
        }
    }
    // ---------------------------------------------------------------------------
    // Operational config helpers
    // ---------------------------------------------------------------------------
    async getOpConfig() {
        if (this.operationalConfig?.length)
            return new Uint8Array(this.operationalConfig);
        throw new Error('Operational config not cached. Call readOpConfigFromDevice() first.');
    }
    async readProductionConfigFromDevice() {
        const rsp = await this.readProductionConfig();
        const prod = normalizeOperationalConfig(rsp?.payload);
        if (!prod?.length)
            throw new Error('Invalid production config returned from device');
        this.productionConfig = prod;
        const parsed = parseProductionConfigPayload(prod);
        this.emit('productionConfig', parsed);
        return parsed;
    }
    async readOpConfigFromDevice() {
        const rsp = await this.readOperationalConfig();
        const op = normalizeOperationalConfig(rsp?.payload);
        if (!op?.length || op[0] !== 0x5a)
            throw new Error('Invalid operational config returned from device');
        this.operationalConfig = op;
        try {
            this.accel1.applyOperationalConfig(op);
            this.gyroAccel2.applyOperationalConfig(op);
            this.adc.applyOperationalConfig(op);
            this.ppg.applyOperationalConfig(op);
        }
        catch (e) {
            console.warn('[opcfg] apply after read failed:', e);
        }
        this.emit('opConfig', { op });
        return new Uint8Array(op);
    }
    async writeOpConfig(opConfigBytes) {
        const op = normalizeOperationalConfig(opConfigBytes instanceof Uint8Array ? opConfigBytes : new Uint8Array(opConfigBytes));
        if (!op || op.length < 4)
            throw new Error('writeOpConfig: invalid opconfig');
        if (op[0] !== 0x5a)
            throw new Error('writeOpConfig: opconfig must start with 0x5A');
        await this.writeOperationalConfig(op);
        await this.readOpConfigFromDevice();
    }
    getSensor(name) {
        const k = String(name ?? '').toLowerCase();
        if (!k)
            return null;
        if (k.includes('lis2dw12') || k.includes('accel1') || k === '2')
            return this.accel1;
        if (k.includes('lsm6') || k.includes('gyro') || k.includes('accel2') || k === '3')
            return this.gyroAccel2;
        if (k.includes('vbatt') || k.includes('batt') || k.includes('battery') || k.includes('adc'))
            return this.adc;
        if (k.includes('gsr') || k === '1')
            return this.adc;
        if (k.includes('ppg') || k === '4')
            return this.ppg;
        return null;
    }
    // ---------------------------------------------------------------------------
    // RX assembly and dispatch
    // ---------------------------------------------------------------------------
    _abortSync(err) {
        const s = this._sync;
        if (!s)
            return;
        s.receiving = false;
        if (s.timer)
            clearInterval(s.timer);
        this._sync = null;
        this._mode = 'idle';
        s.reject(err);
    }
    _finishSync() {
        const s = this._sync;
        if (!s)
            return;
        s.receiving = false;
        if (s.timer)
            clearInterval(s.timer);
        const bytesWritten = s.bytesWritten;
        this._sync = null;
        this._mode = 'idle';
        s.resolve({ ok: true, bytesWritten });
    }
    async _handleLoggedPayload(payloadU8) {
        this._syncPayloadCount++;
        const s = this._sync;
        if (!s)
            return;
        const computed = computeCrcLikeCSharp(payloadU8);
        const original = getOriginalCrcLE(payloadU8);
        const crcOk = computed === original;
        const payloadIndex = u16le_at(payloadU8, 0);
        if (!crcOk) {
            s.lastReply = 'NACK';
            s.nackCrcCount++;
            this._clearSyncRxBuffers('crc-nack');
            await this.writeBytes(buildMessage(ASM_COMMAND.NACK_GENERIC, ASM_PROPERTY.DATA));
            if (s.nackCrcCount >= s.maxCrcNack)
                this._abortSync(new Error('Too many CRC failures'));
            s.onProgress?.({ payloadIndex, bytesWritten: s.bytesWritten, crcOk: false });
            return;
        }
        if (s.writable) {
            await s.writable.write(toArrayBuffer(payloadU8));
        }
        else {
            s.chunks.push(new Uint8Array(payloadU8));
        }
        s.bytesWritten += payloadU8.length;
        s.emptyAckCount = 0;
        s.lastReply = 'ACK';
        s.nackCount = 0;
        s.nackCrcCount = 0;
        await this.writeBytes(buildMessage(ASM_COMMAND.ACK_NEXT_STAGE, ASM_PROPERTY.DATA), {
            withResponse: true,
        });
        s.onProgress?.({ payloadIndex, bytesWritten: s.bytesWritten, crcOk: true });
    }
    _resetAssembler() {
        this._rxStreamBuf = new Uint8Array(0);
    }
    _appendStreamBuf(chunk) {
        const merged = new Uint8Array(this._rxStreamBuf.length + chunk.length);
        merged.set(this._rxStreamBuf, 0);
        merged.set(chunk, this._rxStreamBuf.length);
        this._rxStreamBuf = merged;
    }
    _clearSyncRxBuffers(reason = '') {
        this._rxStreamBuf = new Uint8Array(0);
        this._resetAssembler();
        if (this.debugSync)
            console.warn('[sync] cleared RX buffers', { reason });
    }
    _isPlausibleHeaderByte(hdr) {
        const command = hdr & 0xf0;
        const property = hdr & 0x0f;
        const validCommand = command === ASM_COMMAND.READ ||
            command === ASM_COMMAND.WRITE ||
            command === ASM_COMMAND.RESPONSE ||
            command === ASM_COMMAND.ACK ||
            command === ASM_COMMAND.NACK_BAD_HEADER_COMMAND ||
            command === ASM_COMMAND.NACK_BAD_HEADER_PROPERTY ||
            command === ASM_COMMAND.NACK_GENERIC ||
            command === ASM_COMMAND.ACK_NEXT_STAGE;
        if (!validCommand)
            return false;
        // Known properties are 0x01..0x0C; keep 0x00 permissive for transient frames.
        return property === 0 || (property >= ASM_PROPERTY.STATUS1 && property <= ASM_PROPERTY.STATUS2);
    }
    _isPlausibleFrameStart(hdr, len) {
        if (!this._isPlausibleHeaderByte(hdr))
            return false;
        // Debug responses may carry large blobs (for example flash lookup tables),
        // while normal properties and streaming/logged payloads should stay bounded.
        const isPendingDebugCommand = this._mode === 'command' && this._pending?.expectedProperty === ASM_PROPERTY.DEBUG_COMMAND;
        const maxLen = isPendingDebugCommand
            ? VerisenseBleDevice.MAX_DEBUG_FRAME_PAYLOAD_LEN
            : VerisenseBleDevice.MAX_FRAME_PAYLOAD_LEN;
        return len <= maxLen;
    }
    _resolvePendingCommand(msg) {
        const pending = this._pending;
        if (pending) {
            // Some firmware/transport paths emit a transient empty 0x00/0x00 frame
            // immediately before the real command response; ignore and keep waiting.
            if (msg.command === 0 &&
                msg.property === 0 &&
                msg.payload.length === 0) {
                return;
            }
            const err = validatePendingResponse(pending, msg);
            if (err) {
                this._pending = null;
                if (this._mode === 'command')
                    this._mode = 'idle';
                pending.reject(err);
            }
            else {
                this._pending = null;
                if (this._mode === 'command')
                    this._mode = 'idle';
                pending.resolve(toCommandResponse(msg));
            }
        }
        else {
            this._pending = null;
            if (this._mode === 'command')
                this._mode = 'idle';
        }
        this.emit('commandPayload', {
            header: msg.header,
            command: msg.command,
            property: msg.property,
            payload: msg.payload,
        });
    }
    _feedStreamBytes(chunk) {
        if (this._mode === 'logged' && this._sync)
            this._sync.lastRxAt = Date.now();
        if (this._testReportCapture) {
            this._captureHardwareTestReportChunk(chunk);
        }
        this._appendStreamBuf(chunk);
        for (;;) {
            if (this._rxStreamBuf.length < 3)
                return;
            const hdr = this._rxStreamBuf[0];
            const len = (this._rxStreamBuf[1] | (this._rxStreamBuf[2] << 8)) >>> 0;
            if (!this._isPlausibleFrameStart(hdr, len)) {
                if (this.debugSync) {
                    console.warn('[rx] resync: dropping byte', {
                        dropped: hdr,
                        nextLen: len,
                        bufLen: this._rxStreamBuf.length,
                    });
                }
                this._rxStreamBuf = this._rxStreamBuf.slice(1);
                continue;
            }
            if (len === 0) {
                const header = hdr & 0xff;
                const decodedHeader = parseHeader(header);
                const msg = {
                    header,
                    command: decodedHeader.command,
                    property: decodedHeader.property,
                    payloadLength: 0,
                    payload: new Uint8Array(0),
                };
                this._rxStreamBuf = this._rxStreamBuf.slice(3);
                if (this._mode === 'logged' && hdr === buildHeader(ASM_COMMAND.ACK, ASM_PROPERTY.DATA)) {
                    const s = this._sync;
                    if (s && s.bytesWritten === 0 && s.emptyAckCount < 6) {
                        s.emptyAckCount++;
                        if (this.debugSync)
                            console.log('[sync] empty ACK before payload; requesting next DATA chunk.');
                        void this.writeBytes(buildMessage(ASM_COMMAND.READ, ASM_PROPERTY.DATA), {
                            withResponse: true,
                        }).catch((e) => this._abortSync(e));
                        continue;
                    }
                    if (this.debugSync)
                        console.log('[sync] EOS received. Finishing.');
                    this._finishSync();
                    continue;
                }
                if (this._mode === 'command') {
                    this._resolvePendingCommand(msg);
                }
                continue;
            }
            if (this._rxStreamBuf.length < 3 + len)
                return;
            const payload = this._rxStreamBuf.slice(3, 3 + len);
            this._rxStreamBuf = this._rxStreamBuf.slice(3 + len);
            const header = hdr & 0xff;
            const decodedHeader = parseHeader(header);
            const msg = {
                header,
                command: decodedHeader.command,
                property: decodedHeader.property,
                payloadLength: payload.length,
                payload,
            };
            if (this._mode === 'logged') {
                this._loggedChain = (this._loggedChain ?? Promise.resolve())
                    .then(() => this._handleLoggedPayload(msg.payload))
                    .catch((e) => this._abortSync(e));
                continue;
            }
            if (this._mode === 'streaming') {
                this._handleStreamingPayload(msg.payload);
                continue;
            }
            this._resolvePendingCommand(msg);
        }
    }
    _handleStreamingPayload(payload) {
        if (payload.length < 4)
            return;
        let body = payload;
        let crcOk = null;
        if (this.stripStreamCrc && payload.length >= 6) {
            const claimed = (payload[payload.length - 2] | (payload[payload.length - 1] << 8)) >>> 0;
            const dataNoCrc = payload.slice(0, payload.length - 2);
            if (this.verifyStreamCrc) {
                const calc = crc16_ccitt_false(dataNoCrc);
                crcOk = calc === claimed;
            }
            body = dataNoCrc;
            if (this.verifyStreamCrc && crcOk === false) {
                this.emit('streamCrcFail', { claimed, body: dataNoCrc });
            }
        }
        const sensorId = body[0];
        const tick = u24le(body, 1);
        const sensorPayload = body.slice(4);
        const sensor = this.sensors[sensorId];
        const systemTsLastSampleMillis = nowMillis();
        let tsInfo = null;
        if (sensor)
            tsInfo = sensor.getTimestampUnwrappedMillis(tick, systemTsLastSampleMillis);
        let decodedSamples = null;
        if (sensor)
            decodedSamples = sensor.parsePayload(sensorPayload);
        let samplesWithTime = decodedSamples;
        if (sensor && Array.isArray(decodedSamples) && decodedSamples.length > 0 && tsInfo) {
            const num = decodedSamples.length;
            samplesWithTime = decodedSamples.map((s, i) => ({
                ...s,
                timestamps: sensor.extrapolateSampleTimes({
                    numSamples: num,
                    i,
                    samplingRateHz: sensor.samplingRateHz,
                    tsLastSampleMillis: tsInfo.shimmerMillis,
                    systemTsLastSampleMillis,
                    systemOffsetFirstTime: tsInfo.systemOffsetFirstTime,
                }),
            }));
        }
        const packet = {
            sensorId,
            tick_u24: tick,
            decoded: samplesWithTime,
            rawPayload: sensorPayload,
            crcOk,
        };
        this.emit('streamPacket', packet);
        this.emit('data', packet);
    }
}
VerisenseBleDevice.MAX_FRAME_PAYLOAD_LEN = 4096;
VerisenseBleDevice.MAX_DEBUG_FRAME_PAYLOAD_LEN = 0xffff;
VerisenseBleDevice.TEST_REPORT_MODE_ID = 0xfe;
VerisenseBleDevice.TEST_REPORT_DELIMITER = '//**************************** TEST START ************************************\r\n';
VerisenseBleDevice.TEST_REPORT_MARKER_HINT = 'TEST START';
// Static NUS UUIDs
VerisenseBleDevice.NUS_SERVICE = NUS_SERVICE;
VerisenseBleDevice.NUS_TX = NUS_TX;
VerisenseBleDevice.NUS_RX = NUS_RX;
VerisenseBleDevice.NORDIC_DFU_SERVICE = NORDIC_DFU_SERVICE;
VerisenseBleDevice.NORDIC_DFU_BUTTONLESS_CHAR = NORDIC_DFU_BUTTONLESS_CHAR;

export { ASM_COMMAND, ASM_PROPERTY, BaseShimmerClient, CHANNEL_FORMATS, DEBUG_COMMAND_ID, FACTORY_TEST, GSR_NAME, NORDIC_DFU_BUTTONLESS_CHAR, NORDIC_DFU_CONTROL_CHAR, NORDIC_DFU_PACKET_CHAR, NORDIC_DFU_SERVICE, NUS_RX, NUS_SERVICE, NUS_TX, OPCODES, OP_IDX, ObjectCluster, SHIMMER3R_DEFAULTS, STREAM_MODE, SensorADC, SensorBase, SensorBitmapShimmer3, SensorLIS2DW12, SensorLSM6DS3, SensorPPG, Shimmer3RClient, TEST_MODE_ID, TIMESTAMP_FIELD, VerisenseBleDevice, applyDuplicateSuffix, asmRtcBytesToUnixSeconds, asmRtcMinutesBytesToUnixSeconds, buildHeader, buildMessage, buildParsedCsvFileName, buildProductionConfigPayload, buildUploadBinaryFileName, calibrateGsrDataToResistanceFromAmplifierEq, calibrateShimmer3RAdcChannel, calibrateU12AdcValue, computeVerisensePairingPin, crc16_ccitt_false, evaluateParsedFileSplit, getFirstPayloadIndex, getOversamplingRatioADS1292R, isAckCommand, isNackCommand, nextAvailableDuplicateFileName, normalizeBytePayload, normalizeOperationalConfig, nudgeGsrResistance, parseEventLogPayload, parseHeader, parseLookupTablePayload, parseMessage, parsePayloadCrcErrorBankIndexes, parsePendingEvents, parseProductionConfigPayload, parseProductionConfigPayloadFull, parseRecordBufferDetailsPayload, parseSchedulerDebugPayload, parseStatusPayload, unixSecondsToAsmRtcBytes };
//# sourceMappingURL=shimmer-web-sdk.esm.js.map
