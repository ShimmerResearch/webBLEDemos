/**
 * Discriminated kind tag for a data field in an ObjectCluster.
 */
type FieldKind = 'raw' | 'cal' | null;
/**
 * A single named field stored inside an ObjectCluster.
 */
interface SensorField {
    /** Signal name, e.g. 'GYRO_X', 'GSR', 'TIMESTAMP'. */
    name: string;
    /** Numeric value. */
    value: number;
    /** Optional unit string, e.g. 'deg/s', 'µS', 'ticks'. */
    unit: string | null;
    /** Whether the value is raw ADC counts or calibrated engineering units. */
    kind: FieldKind;
}
/**
 * Constructor options common to all Shimmer device clients.
 */
interface ShimmerClientOptions {
    /** Enable verbose console logging. Defaults to `true`. */
    debug?: boolean;
}
/**
 * Contract that every Shimmer device client must satisfy.
 *
 * Both `Shimmer3RClient` and `VerisenseBleDevice` implement this interface,
 * allowing application code to remain device-agnostic for the common operations.
 */
interface IShimmerClient {
    /** Open a BLE connection to the device (triggers the browser picker). */
    connect(...args: unknown[]): Promise<unknown>;
    /** Close the BLE connection. */
    disconnect(...args: unknown[]): Promise<unknown>;
    /** Start streaming sensor data. */
    startStreaming(): Promise<void>;
    /** Stop streaming sensor data. */
    stopStreaming(): Promise<void>;
    /**
     * Called for every decoded data frame while streaming.
     * For Shimmer3R this delivers an ObjectCluster; for Verisense it delivers
     * a raw streaming packet (see `VerisenseBleDevice` for the exact shape).
     */
    onStreamFrame: ((frame: ObjectCluster) => void) | null;
    /** Called whenever the client emits a human-readable status message. */
    onStatus: ((msg: string) => void) | null;
}
/**
 * Calibration parameters for a single inertial axis.
 */
interface InertialCalibration {
    /** Zero-g or zero-rate offset. */
    offset: [number, number, number];
    /** 3×3 alignment/cross-axis correction matrix (row-major). */
    align: [[number, number, number], [number, number, number], [number, number, number]];
    /** Per-axis sensitivity in LSB/unit. */
    sensitivity: [number, number, number];
}

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
declare class ObjectCluster {
    /** Identifier of the source device (typically the BLE device name). */
    readonly deviceId: string;
    /** All signal fields decoded from this frame. */
    readonly fields: SensorField[];
    /**
     * The original unparsed byte array for this frame.
     * Populated by protocol parsers that keep the raw bytes for debug purposes.
     */
    raw: Uint8Array | null;
    constructor(deviceId: string);
    /**
     * Append a named field to this cluster.
     *
     * @param name   Signal name, e.g. `'GYRO_X'`.
     * @param value  Numeric value.
     * @param unit   Optional unit string, e.g. `'deg/s'`, `'µS'`, `'ticks'`.
     * @param kind   `'raw'` for ADC counts, `'cal'` for calibrated units, or `null`.
     */
    add(name: string, value: number, unit?: string | null, kind?: FieldKind): void;
    /**
     * Look up a field by name and optional kind.
     *
     * When both a raw and a calibrated version exist for the same signal name,
     * pass `kind` to disambiguate.
     *
     * @returns The matching field, or `null` if not found.
     */
    get(name: string, kind?: FieldKind): SensorField | null;
    /**
     * Return all fields that match the given name (regardless of kind).
     */
    getAll(name: string): SensorField[];
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
declare abstract class BaseShimmerClient implements IShimmerClient {
    /** Enable verbose console logging. */
    debug: boolean;
    /**
     * Invoked whenever the client emits a human-readable status message
     * (e.g. "GATT connected", "Sampling rate ACKed. Applied ≈ 51.200 Hz").
     */
    onStatus: ((msg: string) => void) | null;
    /**
     * Invoked for every fully-decoded sensor frame while streaming.
     * The exact shape depends on the concrete sub-class:
     * - `Shimmer3RClient` passes an {@link ObjectCluster}.
     * - `VerisenseBleDevice` passes a streaming packet object (see that class).
     */
    onStreamFrame: ((frame: ObjectCluster) => void) | null;
    constructor(opts?: ShimmerClientOptions);
    /** Log to console when debug is enabled. */
    protected _log(...args: unknown[]): void;
    /** Emit a status message to `onStatus` and to the debug log. */
    protected _emitStatus(msg: string): void;
    abstract connect(...args: unknown[]): Promise<unknown>;
    abstract disconnect(...args: unknown[]): Promise<unknown>;
    abstract startStreaming(): Promise<void>;
    abstract stopStreaming(): Promise<void>;
}

/**
 * Shimmer3R BLE protocol opcodes.
 * Values taken directly from the Shimmer3 firmware header.
 */
declare const OPCODES: Readonly<{
    readonly DATA_PACKET: 0;
    readonly INQUIRY_COMMAND: 1;
    readonly INQUIRY_RESPONSE: 2;
    readonly GET_SAMPLING_RATE_COMMAND: 3;
    readonly SAMPLING_RATE_RESPONSE: 4;
    readonly SET_SAMPLING_RATE_COMMAND: 5;
    readonly TOGGLE_LED_COMMAND: 6;
    readonly START_STREAMING_COMMAND: 7;
    readonly SET_SENSORS_COMMAND: 8;
    readonly SET_WR_ACCEL_RANGE_COMMAND: 9;
    readonly WR_ACCEL_RANGE_RESPONSE: 10;
    readonly GET_WR_ACCEL_RANGE_COMMAND: 11;
    readonly SET_CONFIG_SETUP_BYTES_COMMAND: 14;
    readonly CONFIG_SETUP_BYTES_RESPONSE: 15;
    readonly GET_CONFIG_SETUP_BYTES_COMMAND: 16;
    readonly SET_LN_ACCEL_CALIBRATION_COMMAND: 17;
    readonly LN_ACCEL_CALIBRATION_RESPONSE: 18;
    readonly GET_LN_ACCEL_CALIBRATION_COMMAND: 19;
    readonly SET_GYRO_CALIBRATION_COMMAND: 20;
    readonly GYRO_CALIBRATION_RESPONSE: 21;
    readonly GET_GYRO_CALIBRATION_COMMAND: 22;
    readonly SET_MAG_CALIBRATION_COMMAND: 23;
    readonly MAG_CALIBRATION_RESPONSE: 24;
    readonly GET_MAG_CALIBRATION_COMMAND: 25;
    readonly SET_WR_ACCEL_CALIBRATION_COMMAND: 26;
    readonly WR_ACCEL_CALIBRATION_RESPONSE: 27;
    readonly GET_WR_ACCEL_CALIBRATION_COMMAND: 28;
    readonly STOP_STREAMING_COMMAND: 32;
    readonly SET_GSR_RANGE_COMMAND: 33;
    readonly GSR_RANGE_RESPONSE: 34;
    readonly GET_GSR_RANGE_COMMAND: 35;
    readonly DEVICE_VERSION_RESPONSE: 37;
    readonly GET_ALL_CALIBRATION_COMMAND: 44;
    readonly ALL_CALIBRATION_RESPONSE: 45;
    readonly GET_FW_VERSION_COMMAND: 46;
    readonly FW_VERSION_RESPONSE: 47;
    readonly SET_CHARGE_STATUS_LED_COMMAND: 48;
    readonly CHARGE_STATUS_LED_RESPONSE: 49;
    readonly GET_CHARGE_STATUS_LED_COMMAND: 50;
    readonly BUFFER_SIZE_RESPONSE: 53;
    readonly GET_BUFFER_SIZE_COMMAND: 54;
    readonly SET_MAG_GAIN_COMMAND: 55;
    readonly MAG_GAIN_RESPONSE: 56;
    readonly GET_MAG_GAIN_COMMAND: 57;
    readonly SET_MAG_SAMPLING_RATE_COMMAND: 58;
    readonly MAG_SAMPLING_RATE_RESPONSE: 59;
    readonly GET_MAG_SAMPLING_RATE_COMMAND: 60;
    readonly UNIQUE_SERIAL_RESPONSE: 61;
    readonly GET_UNIQUE_SERIAL_COMMAND: 62;
    readonly GET_DEVICE_VERSION_COMMAND: 63;
    readonly SET_WR_ACCEL_SAMPLING_RATE_COMMAND: 64;
    readonly WR_ACCEL_SAMPLING_RATE_RESPONSE: 65;
    readonly GET_WR_ACCEL_SAMPLING_RATE_COMMAND: 66;
    readonly SET_WR_ACCEL_LPMODE_COMMAND: 67;
    readonly WR_ACCEL_LPMODE_RESPONSE: 68;
    readonly GET_WR_ACCEL_LPMODE_COMMAND: 69;
    readonly SET_WR_ACCEL_HRMODE_COMMAND: 70;
    readonly WR_ACCEL_HRMODE_RESPONSE: 71;
    readonly GET_WR_ACCEL_HRMODE_COMMAND: 72;
    readonly SET_GYRO_RANGE_COMMAND: 73;
    readonly GYRO_RANGE_RESPONSE: 74;
    readonly GET_GYRO_RANGE_COMMAND: 75;
    readonly SET_GYRO_SAMPLING_RATE_COMMAND: 76;
    readonly GYRO_SAMPLING_RATE_RESPONSE: 77;
    readonly GET_GYRO_SAMPLING_RATE_COMMAND: 78;
    readonly SET_ALT_ACCEL_RANGE_COMMAND: 79;
    readonly ALT_ACCEL_RANGE_RESPONSE: 80;
    readonly GET_ALT_ACCEL_RANGE_COMMAND: 81;
    readonly SET_PRESSURE_OVERSAMPLING_RATIO_COMMAND: 82;
    readonly PRESSURE_OVERSAMPLING_RATIO_RESPONSE: 83;
    readonly GET_PRESSURE_OVERSAMPLING_RATIO_COMMAND: 84;
    readonly BMP180_CALIBRATION_COEFFICIENTS_RESPONSE: 88;
    readonly GET_BMP180_CALIBRATION_COEFFICIENTS_COMMAND: 89;
    readonly RESET_TO_DEFAULT_CONFIGURATION_COMMAND: 90;
    readonly RESET_CALIBRATION_VALUE_COMMAND: 91;
    readonly MPU9150_MAG_SENS_ADJ_VALS_RESPONSE: 92;
    readonly GET_MPU9150_MAG_SENS_ADJ_VALS_COMMAND: 93;
    readonly SET_INTERNAL_EXP_POWER_ENABLE_COMMAND: 94;
    readonly INTERNAL_EXP_POWER_ENABLE_RESPONSE: 95;
    readonly GET_INTERNAL_EXP_POWER_ENABLE_COMMAND: 96;
    readonly SET_EXG_REGS_COMMAND: 97;
    readonly EXG_REGS_RESPONSE: 98;
    readonly GET_EXG_REGS_COMMAND: 99;
    readonly SET_DAUGHTER_CARD_ID_COMMAND: 100;
    readonly DAUGHTER_CARD_ID_RESPONSE: 101;
    readonly GET_DAUGHTER_CARD_ID_COMMAND: 102;
    readonly SET_DAUGHTER_CARD_MEM_COMMAND: 103;
    readonly DAUGHTER_CARD_MEM_RESPONSE: 104;
    readonly GET_DAUGHTER_CARD_MEM_COMMAND: 105;
    readonly SET_DERIVED_CHANNEL_BYTES: 109;
    readonly DERIVED_CHANNEL_BYTES_RESPONSE: 110;
    readonly GET_DERIVED_CHANNEL_BYTES: 111;
    readonly START_SDBT_COMMAND: 112;
    readonly STATUS_RESPONSE: 113;
    readonly GET_STATUS_COMMAND: 114;
    readonly SET_TRIAL_CONFIG_COMMAND: 115;
    readonly TRIAL_CONFIG_RESPONSE: 116;
    readonly GET_TRIAL_CONFIG_COMMAND: 117;
    readonly SET_CENTER_COMMAND: 118;
    readonly CENTER_RESPONSE: 119;
    readonly GET_CENTER_COMMAND: 120;
    readonly SET_SHIMMERNAME_COMMAND: 121;
    readonly SHIMMERNAME_RESPONSE: 122;
    readonly GET_SHIMMERNAME_COMMAND: 123;
    readonly SET_EXPID_COMMAND: 124;
    readonly EXPID_RESPONSE: 125;
    readonly GET_EXPID_COMMAND: 126;
    readonly SET_MYID_COMMAND: 127;
    readonly MYID_RESPONSE: 128;
    readonly GET_MYID_COMMAND: 129;
    readonly SET_NSHIMMER_COMMAND: 130;
    readonly NSHIMMER_RESPONSE: 131;
    readonly GET_NSHIMMER_COMMAND: 132;
    readonly SET_CONFIGTIME_COMMAND: 133;
    readonly CONFIGTIME_RESPONSE: 134;
    readonly GET_CONFIGTIME_COMMAND: 135;
    readonly DIR_RESPONSE: 136;
    readonly GET_DIR_COMMAND: 137;
    readonly INSTREAM_CMD_RESPONSE: 138;
    readonly SET_CRC_COMMAND: 139;
    readonly SET_INFOMEM_COMMAND: 140;
    readonly INFOMEM_RESPONSE: 141;
    readonly GET_INFOMEM_COMMAND: 142;
    readonly SET_RWC_COMMAND: 143;
    readonly RWC_RESPONSE: 144;
    readonly GET_RWC_COMMAND: 145;
    readonly START_LOGGING_COMMAND: 146;
    readonly STOP_LOGGING_COMMAND: 147;
    readonly VBATT_RESPONSE: 148;
    readonly GET_VBATT_COMMAND: 149;
    readonly TEST_CONNECTION_COMMAND: 150;
    readonly STOP_SDBT_COMMAND: 151;
    readonly SET_CALIB_DUMP_COMMAND: 152;
    readonly RSP_CALIB_DUMP_COMMAND: 153;
    readonly GET_CALIB_DUMP_COMMAND: 154;
    readonly UPD_CALIB_DUMP_COMMAND: 155;
    readonly UPD_SDLOG_CFG_COMMAND: 156;
    readonly BMP280_CALIBRATION_COEFFICIENTS_RESPONSE: 159;
    readonly GET_BMP280_CALIBRATION_COEFFICIENTS_COMMAND: 160;
    readonly GET_BT_VERSION_STR_COMMAND: 161;
    readonly BT_VERSION_STR_RESPONSE: 162;
    readonly SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE: 163;
    readonly SET_DATA_RATE_TEST: 164;
    readonly DATA_RATE_TEST_RESPONSE: 165;
    readonly PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE: 166;
    readonly GET_PRESSURE_CALIBRATION_COEFFICIENTS_COMMAND: 167;
    readonly SET_FACTORY_TEST: 168;
    readonly SET_ALT_ACCEL_CALIBRATION_COMMAND: 169;
    readonly ALT_ACCEL_CALIBRATION_RESPONSE: 170;
    readonly GET_ALT_ACCEL_CALIBRATION_COMMAND: 171;
    readonly SET_ALT_ACCEL_SAMPLING_RATE_COMMAND: 172;
    readonly ALT_ACCEL_SAMPLING_RATE_RESPONSE: 173;
    readonly GET_ALT_ACCEL_SAMPLING_RATE_COMMAND: 174;
    readonly SET_ALT_MAG_CALIBRATION_COMMAND: 175;
    readonly ALT_MAG_CALIBRATION_RESPONSE: 176;
    readonly GET_ALT_MAG_CALIBRATION_COMMAND: 177;
    readonly SET_ALT_MAG_SAMPLING_RATE_COMMAND: 178;
    readonly ALT_MAG_SAMPLING_RATE_RESPONSE: 179;
    readonly GET_ALT_MAG_SAMPLING_RATE_COMMAND: 180;
    readonly DUMMY_COMMAND: 181;
    readonly RESET_BT_ERROR_COUNTS: 182;
    readonly SET_FEATURE: 183;
    readonly SET_SD_SYNC_COMMAND: 224;
    readonly SD_SYNC_RESPONSE: 225;
    readonly NACK_COMMAND_PROCESSED: 254;
    readonly ACK_COMMAND_PROCESSED: 255;
}>;
type Opcode = (typeof OPCODES)[keyof typeof OPCODES];
/** Default BLE service / characteristic UUIDs for Shimmer3R. */
declare const SHIMMER3R_DEFAULTS: Readonly<{
    readonly SERVICE_UUID: "65333333-a115-11e2-9e9a-0800200ca100";
    /** Write characteristic (host → device). */
    readonly CHAR_RX_UUID: "65333333-a115-11e2-9e9a-0800200ca102";
    /** Notify characteristic (device → host). */
    readonly CHAR_TX_UUID: "65333333-a115-11e2-9e9a-0800200ca101";
}>;
/**
 * Timestamp field descriptors keyed by width.
 * Shimmer3R firmware ≥ v1.0.22 always uses u24.
 */
declare const TIMESTAMP_FIELD: Readonly<{
    readonly u16: {
        readonly name: "TIMESTAMP";
        readonly fmt: "u16";
        readonly endian: "le";
        readonly sizeBytes: 2;
    };
    readonly u24: {
        readonly name: "TIMESTAMP";
        readonly fmt: "u24";
        readonly endian: "le";
        readonly sizeBytes: 3;
    };
}>;
type TimestampFmt = 'u16' | 'u24';
/** GSR signal name constant used in ObjectCluster fields. */
declare const GSR_NAME = "GSR";

interface ChannelField {
    id: number;
    name: string;
    fmt: string;
    endian: string;
    sizeBytes: number;
}
interface StreamSchema {
    timestampFmt: TimestampFmt;
    fields: ChannelField[];
    /** Total bytes per frame, including the 0x00 preamble byte. */
    frameBytes: number;
    enabledSensors: number;
    dataPreambleByte: number;
}
interface Shimmer3RClientOptions extends ShimmerClientOptions {
    /** BLE service UUID override (default: Shimmer3R service UUID). */
    serviceUUID?: string;
    /** Write characteristic UUID override. */
    rxUUID?: string;
    /** Notify characteristic UUID override. */
    txUUID?: string;
    /**
     * Force a specific timestamp width.
     * Shimmer3R firmware ≥ v1.0.22 uses 24-bit timestamps.
     * @default 'u24'
     */
    timestampFmt?: TimestampFmt;
}
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
declare class Shimmer3RClient extends BaseShimmerClient {
    private serviceUUID;
    private rxUUID;
    private txUUID;
    device: BluetoothDevice | null;
    private server;
    private rx;
    private tx;
    private _rxBuf;
    private _temps;
    private schema;
    private forceTimestampFmt;
    private _lastAckRemainder;
    private _expectingAck;
    private _streaming;
    private _lastTs;
    enabledSensors: number;
    samplingRateHz: number;
    gsrRangeSetting: number;
    ExpPower: number;
    /** Minimum valid GSR conductance in µS (below this, connectivity = "Disconnected"). */
    readonly LIMIT_MIN_VALID_USIEMENS = 0.03;
    onInquiry: ((info: ReturnType<Shimmer3RClient['_interpretInquiryResponseShimmer3R']>) => void) | null;
    onExpPowerChanged: ((expPower: number) => void) | null;
    constructor(opts?: Shimmer3RClientOptions);
    protected _log(...args: unknown[]): void;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    private _handleNotify;
    /**
     * Control the internal expansion power rail (required for ExG/EMG/ECG).
     * @param expPower 0 = disable, 1 = enable.
     */
    setInternalExpPower(expPower: 0 | 1): Promise<{
        expPower: number;
        ackRemainder: Uint8Array | null;
    }>;
    /**
     * Set the GSR measurement range.
     * @param gsrRange 0 = 8–63 kΩ, 1 = 63–220 kΩ, 2 = 220–680 kΩ, 3 = 680–4700 kΩ, 4 = Auto.
     */
    setGSRRange(gsrRange: number): Promise<{
        gsrRange: number;
        ackRemainder: Uint8Array | null;
    }>;
    getInternalExpPower(): number;
    getEnabledSensors(): number;
    /**
     * Enable sensors via a 24-bit bitmask.
     * Automatically performs an Inquiry after ACK to rebuild the stream schema.
     */
    setSensors(sensors: number): Promise<{
        sensors: number;
        ackRemainder: Uint8Array | null;
        enabledSensors: number;
    }>;
    /**
     * Set the sampling rate.
     * The firmware expects a 16-bit divisor: `divisor = floor(32768 / rateHz)`.
     */
    setSamplingRate(rateHz: number): Promise<{
        requestedHz: number;
        appliedHz: number;
        divisor: number;
        ackRemainder: Uint8Array | null;
    }>;
    /** Send INQUIRY_CMD and parse the response to build the stream schema. */
    inquiry(): Promise<{
        opcode: number;
        adcRaw: number;
        samplingRateHz: number;
        numChannels: number;
        bufferSize: number;
        channelIds: number[];
        schema: StreamSchema;
        bytes: Uint8Array<ArrayBuffer>;
    }>;
    /** Enable EMG (ADS1292R) in 16-bit mode on EXG1 & EXG2. */
    enableEMG16Bit(): Promise<void>;
    /** Enable EXG test signal in 16-bit mode (useful for verifying ExG hardware). */
    enableEXGTestSignal16Bit(): Promise<void>;
    /** Enable ECG in 16-bit mode on EXG1 & EXG2. */
    enableECG16Bit(): Promise<void>;
    private _writeExgPages;
    startStreaming(): Promise<void>;
    stopStreaming(): Promise<void>;
    /** Start streaming AND SD card logging simultaneously. */
    startStreamingAndLogging(): Promise<void>;
    /** Stop streaming AND SD card logging. */
    stopStreamingAndLogging(): Promise<void>;
    private _interpretInquiryResponseShimmer3R;
    private _buildSchemaFromChannels;
    private _calibrateData;
    private _parseBySchema;
    private _write;
    private _writeExpectingAck;
    private _waitForAck;
    private _waitForResponse;
    private _onTemp;
    private _offTemp;
    private _emitTemp;
}

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
declare const SensorBitmapShimmer3: Readonly<{
    readonly SENSOR_A_ACCEL: 128;
    readonly SENSOR_GYRO: 64;
    readonly SENSOR_MAG: 32;
    readonly SENSOR_GSR: 4;
    readonly SENSOR_VBATT: 8192;
    readonly SENSOR_D_ACCEL: 4096;
    readonly SENSOR_PRESSURE: 262144;
    readonly SENSOR_EXG1_24BIT: 16;
    readonly SENSOR_EXG2_24BIT: 8;
    readonly SENSOR_EXG1_16BIT: 1048576;
    readonly SENSOR_EXG2_16BIT: 524288;
    readonly SENSOR_BRIDGE_AMP: 32768;
    readonly SENSOR_ACCEL_ALT: 4194304;
    readonly SENSOR_MAG_ALT: 2097152;
    readonly SENSOR_EXT_A0: 2;
    readonly SENSOR_EXT_A1: 1;
    readonly SENSOR_EXT_A2: 2048;
    readonly SENSOR_INT_A3: 1024;
    readonly SENSOR_INT_A0: 512;
    readonly SENSOR_INT_A1: 256;
    readonly SENSOR_INT_A2: 8388608;
}>;
type SensorBitmapShimmer3Key = keyof typeof SensorBitmapShimmer3;

/**
 * Channel format descriptor for a single Shimmer3R data channel.
 */
interface ChannelFormat {
    /** Human-readable signal name stored in ObjectCluster fields. */
    name: string;
    /** Encoding format: i16, u16, i24, u24, i12*, u8. */
    fmt: 'i16' | 'u16' | 'i24' | 'u24' | 'i12*' | 'u8';
    /** Byte order for multi-byte values. */
    endian: 'le' | 'be';
    /** Number of bytes this channel occupies in the packet. */
    sizeBytes: number;
}
/**
 * Mapping from Shimmer3R channel ID byte to its format descriptor.
 * Channel IDs are reported in the INQUIRY_RSP payload.
 */
declare const CHANNEL_FORMATS: Readonly<Record<number, ChannelFormat>>;

/**
 * Convert a Shimmer3R 12-bit ADC value to millivolts.
 *
 * @param unCalData  Raw 12-bit ADC sample.
 * @param offset     ADC offset (typically 0).
 * @param vRefP      Reference voltage in volts (typically 3 V for Shimmer3R).
 * @param gain       Amplifier gain (typically 1).
 * @returns Calibrated voltage in millivolts.
 */
declare function calibrateU12AdcValue(unCalData: number, offset: number, vRefP: number, gain: number): number;
/**
 * Convert a Shimmer3R ADC channel value to millivolts using the
 * default Shimmer3R ADC parameters (Vref = 3 V, gain = 1, offset = 0).
 *
 * @param unCalData Raw 12-bit ADC sample.
 * @returns Voltage in millivolts.
 */
declare function calibrateShimmer3RAdcChannel(unCalData: number): number;
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
declare function calibrateGsrDataToResistanceFromAmplifierEq(gsrUncalibratedData: number, range: number): number;
/**
 * Clamp a GSR resistance value to the physical limits of a given range.
 *
 * When `gsrRangeSetting === 4` (auto-range) no clamping is applied.
 *
 * @param gsrResistanceKOhms Calibrated resistance in kΩ.
 * @param gsrRangeSetting    Range 0–3 (fixed) or 4 (auto).
 * @returns Clamped resistance in kΩ.
 */
declare function nudgeGsrResistance(gsrResistanceKOhms: number, gsrRangeSetting: number): number;
/**
 * Determine the ADS1292R oversampling ratio config byte for a given
 * Shimmer3R sampling rate.
 *
 * This value is ORed into the lower 3 bits of ExG config byte index 4.
 *
 * @param samplingRate Shimmer3R sampling rate in Hz (must be ≥ 0).
 * @returns Oversampling ratio index 0–6.
 */
declare function getOversamplingRatioADS1292R(samplingRate: number): number;

/**
 * Compute CRC-16/CCITT-FALSE over `bytes`.
 *
 * Parameters: poly=0x1021, init=0xFFFF, xorOut=0x0000.
 * Matches the C# `ComputeCRC` implementation used by Verisense firmware.
 */
declare function crc16_ccitt_false(bytes: Uint8Array): number;
/**
 * Convert any reasonable representation of an operational config to a
 * `Uint8Array`.  Throws if the input type is unrecognised.
 */
declare function normalizeOperationalConfig(payload: Uint8Array | ArrayBuffer | number[] | {
    buffer: ArrayBuffer;
    byteOffset?: number;
    byteLength?: number;
} | null | undefined): Uint8Array | null;
interface ProductionConfig {
    hardware: string;
    firmware: string;
    asmid: string;
    configHeader: number;
}
/**
 * Parse the production config response payload into a structured object.
 */
declare function parseProductionConfigPayload(response: Uint8Array): ProductionConfig;

/**
 * Abstract base class for all Verisense sensor decoders.
 *
 * Provides:
 * - Timestamp unwrapping (handles the 1-minute rollover at 32768 ticks/s).
 * - System-time offset tracking for plotting calibrated wall-clock timestamps.
 * - Per-sample time extrapolation based on sampling rate and last-sample tick.
 */
declare abstract class SensorBase {
    /** Verisense clock frequency in ticks per second. */
    static readonly CLOCK_FREQ = 32768;
    /** 1-minute rollover at 32768 ticks/s (matches C# Sensor.cs). */
    static readonly TICKS_MAX_VALUE: number;
    protected lastTicksUnwrapped: number;
    protected cycle: number;
    /** (system time) − (shimmer time) at first sample, in milliseconds. */
    systemOffsetFirstTime: number | null;
    /** Sampling rate in Hz (used for per-sample time extrapolation). */
    samplingRateHz: number | null;
    /** Whether this sensor is enabled in the operational config. */
    enabled: boolean;
    /** Reset all timestamp state (call on (re)connect or when streaming restarts). */
    resetTimestamps(): void;
    /**
     * Unwrap a rolling 24-bit tick counter to a monotonically increasing value.
     */
    unwrapTicks(ticks: number): number;
    /** Convert unwrapped ticks to milliseconds. */
    ticksToMillis(unwrappedTicks: number): number;
    /**
     * Compute the calibrated shimmer timestamp for the *last* sample in a burst,
     * and store the first-seen system-offset for later plotting.
     *
     * @param lastSampleTicksU24  24-bit tick counter from the packet header.
     * @param systemMillis        `Date.now()` at the time of packet receipt.
     */
    getTimestampUnwrappedMillis(lastSampleTicksU24: number, systemMillis: number): {
        shimmerMillis: number;
        systemOffsetFirstTime: number;
    };
    /**
     * Extrapolate the timestamp for sample `i` of `numSamples` in a burst,
     * given the timestamp of the *last* sample and the sampling rate.
     *
     * @returns Object with `tsMillis`, `systemTsMillis`, and `systemTsPlotMillis`.
     */
    extrapolateSampleTimes(opts: {
        numSamples: number;
        i: number;
        samplingRateHz?: number | null;
        tsLastSampleMillis: number;
        systemTsLastSampleMillis: number;
        systemOffsetFirstTime?: number | null;
    }): {
        tsMillis: number;
        systemTsMillis: number;
        systemTsPlotMillis: number;
    };
    /** Parse a raw sensor payload byte array into decoded samples. */
    abstract parsePayload(sensorPayloadBytes: Uint8Array): unknown[];
    /** Apply the Verisense operational config blob to update decoder settings. */
    abstract applyOperationalConfig(op: Uint8Array): void;
}

interface GSRSample {
    raw: number;
    adc12: number;
    range: number;
    volts: number;
    kOhms: number;
    uS: number;
    connectivity: 'Connected' | 'Disconnected';
}
interface GSRBatterySample {
    raw: number;
    mV: number;
}
interface GSRPayloadSample {
    gsr: GSRSample | null;
    batt: GSRBatterySample | null;
}
type HardwareIdentifier = 'VERISENSE_PULSE_PLUS' | 'VERISENSE_GSR_PLUS' | string;
/**
 * Decoder for the GSR (galvanic skin response) sensor (Verisense sensor id = 1).
 *
 * Implements C# `SensorGSR.cs` including:
 * - Per-hardware reference resistor selection (SR68 vs Shimmer3 resistors).
 * - Auto-range decoding from the raw ADC value's upper bits.
 * - Range-3 clamping threshold that differs by hardware.
 * - Conductance (µS) output with connectivity detection.
 */
declare class SensorGSR extends SensorBase {
    readonly LIMIT_MIN_VALID_USIEMENS = 0.03;
    readonly GSR_UNCAL_LIMIT_RANGE3_SR68 = 1134;
    readonly GSR_UNCAL_LIMIT_RANGE3_SR62 = 683;
    private readonly SHIMMER3_REF_KOHMS;
    private readonly SR68_REF_KOHMS;
    gsrEnabled: boolean;
    battEnabled: boolean;
    /** GSR range 0–3 (fixed) or 4 (auto-range). */
    gsrRangeSetting: number;
    hardwareIdentifier: HardwareIdentifier;
    gsrRateSettingRaw: number;
    gsrRangeSettingRaw: number;
    gsrOversamplingRateSettingRaw: number;
    constructor();
    setHardwareIdentifier(idStr: HardwareIdentifier): void;
    setGsrRangeSetting(v: number): void;
    setGSREnabled(enabled: boolean, opConfigBytes?: Uint8Array | null): Uint8Array | Record<string, boolean>;
    setBattEnabled(enabled: boolean, opConfigBytes?: Uint8Array | null): Uint8Array | Record<string, boolean>;
    /**
     * Dual-mode setter:
     * - If `opConfigBytes` is provided: returns a new Uint8Array with the enable bits patched.
     * - Otherwise: updates local decoder flags only.
     */
    setEnabled(arg1: boolean | {
        gsr?: boolean;
        batt?: boolean;
    }, opConfigBytes?: Uint8Array | null): Uint8Array | Record<string, boolean>;
    private _patchEnabled;
    patchGsrRange(rangeCfg: number, op: Uint8Array): Uint8Array;
    patchGsrSamplingRate(rateCfg: number, op: Uint8Array): Uint8Array;
    patchGsrOversampling(overCfg: number, op: Uint8Array): Uint8Array;
    calibrateAdcToVolts(uncal12bit: number): number;
    calibrateGsrToKOhmsUsingAmplifierEq(volts: number, range: number): number;
    nudgeGsrResistance(kOhms: number): number;
    kOhmToUSiemens(kOhms: number): number;
    parsePayload(sensorPayloadBytes: Uint8Array): GSRPayloadSample[];
    applyOperationalConfig(op: Uint8Array): void;
}

type AccelRange$1 = '2G' | '4G' | '8G' | '16G';
interface LIS2DW12Sample {
    raw: [number, number, number];
    cal: [number, number, number];
    units: {
        cal: string;
    };
}
/**
 * Decoder for the LIS2DW12 low-power accelerometer (Verisense sensor id = 2).
 *
 * Sensitivity values are given in raw-LSB / (m/s²) per axis — matching
 * the C# `SensorLIS2DW12.cs` implementation.
 */
declare class SensorLIS2DW12 extends SensorBase {
    offset: [number, number, number];
    align: [[number, number, number], [number, number, number], [number, number, number]];
    private readonly sensitivityByRange;
    range: AccelRange$1;
    constructor();
    setRange(rangeStr: AccelRange$1): void;
    setEnabled(enabled: boolean, opConfigBytes?: Uint8Array | null): Uint8Array | boolean;
    setAccelEnabled(enabled: boolean, opConfigBytes?: Uint8Array | null): Uint8Array | boolean;
    patchAccelRange(rangeCfg: number, op: Uint8Array): Uint8Array;
    patchAccelSamplingRate(rateCfg: number, op: Uint8Array): Uint8Array;
    private _calibrate;
    parsePayload(sensorPayloadBytes: Uint8Array): LIS2DW12Sample[];
    applyOperationalConfig(op: Uint8Array): void;
}

type AccelRange = '2G' | '4G' | '8G' | '16G';
type GyroRange = '250DPS' | '500DPS' | '1000DPS' | '2000DPS';
interface LSM6DS3Sample {
    accel: {
        raw: [number, number, number];
        cal: [number, number, number];
        units: string;
    } | null;
    gyro: {
        raw: [number, number, number];
        cal: [number, number, number];
        units: string;
    } | null;
}
/**
 * Decoder for the LSM6DS3 combined accelerometer + gyroscope (Verisense sensor id = 3).
 *
 * Sensitivity values mirror the C# `SensorLSM6DS3.cs` implementation.
 */
declare class SensorLSM6DS3 extends SensorBase {
    offset: [number, number, number];
    align: [[number, number, number], [number, number, number], [number, number, number]];
    private readonly accSensByRange;
    private readonly gyroSensByRange;
    accRange: AccelRange;
    gyroRange: GyroRange;
    accEnabled: boolean;
    gyroEnabled: boolean;
    constructor();
    setAccelEnabled(v: boolean): void;
    setGyroEnabled(v: boolean): void;
    setAccelRange(r: AccelRange): void;
    setGyroRange(r: GyroRange): void;
    private _applyAlignAndOffset;
    parsePayload(sensorPayloadBytes: Uint8Array): LSM6DS3Sample[];
    applyOperationalConfig(op: Uint8Array): void;
}

interface PPGChannelSample {
    raw: number;
    cal: number;
    units: {
        raw: string;
        cal: string;
    };
}
interface PPGSample {
    RED?: PPGChannelSample;
    IR?: PPGChannelSample;
    GREEN?: PPGChannelSample;
    BLUE?: PPGChannelSample;
}
type PPGChannel = 'RED' | 'IR' | 'GREEN' | 'BLUE';
/**
 * Decoder for the PPG sensor (Verisense sensor id = 4).
 *
 * Calibration constants mirror C# `SensorPPG.cs`.
 */
declare class SensorPPG extends SensorBase {
    red: boolean;
    ir: boolean;
    green: boolean;
    blue: boolean;
    private readonly adcLsb;
    private readonly adcBitShift;
    adcResolutionIndex: number;
    constructor();
    setChannels(channels: Partial<Record<PPGChannel, boolean>>): void;
    setAdcResolutionIndex(i: number): void;
    calibrateValue(uncalValue: number): number;
    parsePayload(sensorPayloadBytes: Uint8Array): PPGSample[];
    applyOperationalConfig(_op: Uint8Array): void;
}

type TransportKind = 'ble' | 'serial' | null;
type DeviceMode = 'idle' | 'streaming' | 'command' | 'logged';
interface SensorMap {
    1: SensorGSR;
    2: SensorLIS2DW12;
    3: SensorLSM6DS3;
    4: SensorPPG;
}
interface StreamPacket {
    sensorId: number;
    tick_u24: number;
    decoded: unknown[] | null;
    rawPayload: Uint8Array;
    crcOk: boolean | null;
}
interface TransferLoggedDataOptions {
    fileHandle?: FileSystemFileHandle | null;
    timeoutMs?: number;
    maxNack?: number;
    maxCrcNack?: number;
    onProgress?: ((info: {
        payloadIndex: number;
        bytesWritten: number;
        crcOk: boolean;
    }) => void) | null;
}
interface TransferLoggedDataResult {
    ok: boolean;
    bytesWritten: number;
    blob?: Blob;
}
interface VerisenseClientOptions {
    hardwareIdentifier?: string;
    stripStreamCrc?: boolean;
    verifyStreamCrc?: boolean;
    debug?: boolean;
}
/**
 * Web Bluetooth client for the Verisense sensor platform.
 *
 * Extends {@link BaseShimmerClient} and adds an event-emitter API
 * (on/off/emit) for the richer event model the Verisense protocol needs.
 *
 * Supports:
 * - BLE streaming (accel, GSR, gyro, PPG)
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
declare class VerisenseBleDevice extends BaseShimmerClient {
    static readonly NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
    static readonly NUS_TX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
    static readonly NUS_RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
    private readonly _evMap;
    on<T = unknown>(ev: string, fn: (data: T) => void): () => void;
    off(ev: string, fn: (data: unknown) => void): void;
    emit(ev: string, data?: unknown): void;
    private _transportKind;
    device: BluetoothDevice | null;
    private server;
    private service;
    tx: BluetoothRemoteGATTCharacteristic | null;
    rx: BluetoothRemoteGATTCharacteristic | null;
    port: SerialPort | null;
    private _serialAbort;
    private _serialReader;
    private _serialReadLoopTask;
    private _onGattDisconnected;
    private _mode;
    private _rxStreamBuf;
    private _buf;
    private _newPayload;
    private _expectedLen;
    private _pending;
    private _loggedChain;
    private _sync;
    readonly stripStreamCrc: boolean;
    readonly verifyStreamCrc: boolean;
    readonly hardwareIdentifier: string;
    readonly sensors: SensorMap;
    operationalConfig: Uint8Array | null;
    productionConfig: Uint8Array | null;
    debugSync: boolean;
    private _syncRxCount;
    private _syncPayloadCount;
    constructor(opts?: VerisenseClientOptions);
    protected _log(...args: unknown[]): void;
    get gsr(): SensorGSR;
    get accel1(): SensorLIS2DW12;
    get gyroAccel2(): SensorLSM6DS3;
    get ppg(): SensorPPG;
    connect(opts?: {
        device?: BluetoothDevice | null;
        filters?: BluetoothLEScanFilter[];
        optionalServices?: BluetoothServiceUUID[];
    }): Promise<boolean>;
    connectSerial(opts?: {
        port?: SerialPort | null;
        baudRate?: number;
        dataBits?: number;
        stopBits?: number;
        parity?: ParityType;
        flowControl?: FlowControlType;
        filters?: SerialPortFilter[] | null;
    }): Promise<boolean>;
    private _serialWrite;
    private _startSerialReadLoop;
    private _serialDisconnect;
    disconnect(opts?: {
        reason?: string;
    }): Promise<boolean>;
    startStreaming(): Promise<void>;
    stopStreaming(): Promise<void>;
    transferLoggedData(opts?: TransferLoggedDataOptions): Promise<TransferLoggedDataResult>;
    writeBytes(bytes: Uint8Array | number[], opts?: {
        withResponse?: boolean;
    }): Promise<void>;
    private _makeReq;
    request(opcode: number, payloadBytes?: number[] | Uint8Array, timeoutMs?: number): Promise<{
        payload: Uint8Array;
    }>;
    readStatus(): Promise<{
        payload: Uint8Array;
    }>;
    readStatus2(): Promise<{
        payload: Uint8Array;
    }>;
    readProductionConfig(): Promise<{
        payload: Uint8Array;
    }>;
    readOperationalConfig(): Promise<{
        payload: Uint8Array;
    }>;
    readTime(): Promise<{
        payload: Uint8Array;
    }>;
    readPendingEvents(): Promise<{
        payload: Uint8Array;
    }>;
    disconnectRequest(): Promise<{
        payload: Uint8Array;
    }>;
    getOpConfig(): Promise<Uint8Array>;
    readProductionConfigFromDevice(): Promise<ProductionConfig>;
    readOpConfigFromDevice(): Promise<Uint8Array>;
    writeOpConfig(opConfigBytes: Uint8Array | number[]): Promise<void>;
    getopconfig(): Promise<Uint8Array>;
    writeopconfig(op: Uint8Array | number[]): Promise<void>;
    getSensor(name: string | number): SensorBase | null;
    GetSensor(name: string | number): SensorBase | null;
    private _abortSync;
    private _finishSync;
    private _handleLoggedPayload;
    private _resetAssembler;
    private _appendStreamBuf;
    private _clearSyncRxBuffers;
    private _feedStreamBytes;
    private _handleStreamingPayload;
}

/** NUS primary service UUID. */
declare const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
/** NUS TX characteristic UUID (host writes to this). */
declare const NUS_TX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
/** NUS RX characteristic UUID (host subscribes to notifications from this). */
declare const NUS_RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
/**
 * Byte indices into the Verisense operational config blob (`op[OP_IDX.xxx]`).
 * Index 0 is the config version byte (must be 0x5A for a valid config).
 */
declare const OP_IDX: Readonly<{
    readonly GEN_CFG_0: 1;
    readonly GEN_CFG_1: 2;
    readonly GEN_CFG_2: 3;
    readonly GEN_CFG_3: 4;
    readonly ACCEL1_CFG_0: 5;
    readonly ACCEL1_CFG_1: 6;
    readonly ACCEL1_CFG_2: 7;
    readonly ACCEL1_CFG_3: 8;
    readonly GYRO_ACCEL2_CFG_0: 10;
    readonly GYRO_ACCEL2_CFG_1: 11;
    readonly GYRO_ACCEL2_CFG_2: 12;
    readonly GYRO_ACCEL2_CFG_3: 13;
    readonly GYRO_ACCEL2_CFG_4: 14;
    readonly GYRO_ACCEL2_CFG_5: 15;
    readonly GYRO_ACCEL2_CFG_6: 16;
    readonly GYRO_ACCEL2_CFG_7: 17;
    readonly START_TIME: 21;
    readonly END_TIME: 25;
    readonly INACTIVE_TIMEOUT: 29;
    readonly BLE_RETRY_COUNT: 30;
    readonly BLE_TX_POWER: 31;
    readonly BLE_DATA_TRANS_WKUP_INT_HRS: 32;
    readonly BLE_DATA_TRANS_WKUP_TIME: 33;
    readonly BLE_DATA_TRANS_WKUP_DUR: 35;
    readonly BLE_DATA_TRANS_RETRY_INT: 36;
    readonly BLE_STATUS_WKUP_INT_HRS: 38;
    readonly BLE_STATUS_WKUP_TIME: 39;
    readonly BLE_STATUS_WKUP_DUR: 41;
    readonly BLE_STATUS_RETRY_INT: 42;
    readonly BLE_RTC_SYNC_WKUP_INT_HRS: 44;
    readonly BLE_RTC_SYNC_WKUP_TIME: 45;
    readonly BLE_RTC_SYNC_WKUP_DUR: 47;
    readonly BLE_RTC_SYNC_RETRY_INT: 48;
    readonly ADC_CHANNEL_SETTINGS_0: 50;
    readonly ADC_CHANNEL_SETTINGS_1: 51;
    readonly ADAPTIVE_SCHEDULER_INT: 52;
    readonly ADAPTIVE_SCHEDULER_FAILCOUNT_MAX: 54;
    readonly PPG_REC_DUR_SECS_LSB: 55;
    readonly PPG_REC_DUR_SECS_MSB: 56;
    readonly PPG_REC_INT_MINS_LSB: 57;
    readonly PPG_REC_INT_MINS_MSB: 58;
    readonly PPG_FIFO_CONFIG: 59;
    readonly PPG_MODE_CONFIG2: 60;
    readonly PPG_MA_DEFAULT: 61;
    readonly PPG_MA_MAX_RED_IR: 62;
    readonly PPG_MA_MAX_GREEN_BLUE: 63;
    readonly PPG_AGC_TARGET_PERCENT_OF_RANGE: 64;
    readonly PPG_MA_LED_PILOT: 66;
    readonly PPG_DAC1_CROSSTALK: 67;
    readonly PPG_DAC2_CROSSTALK: 68;
    readonly PPG_DAC3_CROSSTALK: 69;
    readonly PPG_DAC4_CROSSTALK: 70;
    readonly PROX_AGC_MODE: 71;
}>;
type OpIdx = keyof typeof OP_IDX;

export { BaseShimmerClient, CHANNEL_FORMATS, GSR_NAME, NUS_RX, NUS_SERVICE, NUS_TX, OPCODES, OP_IDX, ObjectCluster, SHIMMER3R_DEFAULTS, SensorBase, SensorBitmapShimmer3, SensorGSR, SensorLIS2DW12, SensorLSM6DS3, SensorPPG, Shimmer3RClient, TIMESTAMP_FIELD, VerisenseBleDevice, calibrateGsrDataToResistanceFromAmplifierEq, calibrateShimmer3RAdcChannel, calibrateU12AdcValue, crc16_ccitt_false, getOversamplingRatioADS1292R, normalizeOperationalConfig, nudgeGsrResistance, parseProductionConfigPayload };
export type { ChannelFormat, DeviceMode, FieldKind, GSRBatterySample, GSRPayloadSample, GSRSample, IShimmerClient, InertialCalibration, LIS2DW12Sample, LSM6DS3Sample, OpIdx, Opcode, PPGChannelSample, PPGSample, ProductionConfig, SensorBitmapShimmer3Key, SensorField, SensorMap, Shimmer3RClientOptions, ShimmerClientOptions, StreamPacket, TimestampFmt, TransferLoggedDataOptions, TransferLoggedDataResult, TransportKind, VerisenseClientOptions };
