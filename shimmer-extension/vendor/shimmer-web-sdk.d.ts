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
 * True if `bytes` is non-empty and every byte equals `value` (0–255). Useful for
 * detecting uniform blobs such as erased flash (all `0xFF`) or zeroed regions.
 * Returns false for empty or nullish input.
 */
declare function isUniformByteArray(bytes: ArrayLike<number> | ArrayBuffer | null | undefined, value: number): boolean;

/**
 * Device-agnostic live stream statistics: throughput, packet rate and
 * sample-gap-derived packet loss for a real-time sensor stream.
 *
 * The tracker is fed one call per received packet ({@link StreamStatsTracker.recordPacket})
 * and produces a {@link StreamStatsSnapshot} on demand ({@link StreamStatsTracker.snapshot}).
 *
 * Loss is derived from gaps in each sub-stream's *monotonic device clock*
 * (`lastSampleMillis`), NOT host receive time — host BLE buffering bunches
 * packets together and would otherwise create false gaps. Throughput and packet
 * rate, by contrast, are measured over a sliding window of host receive time
 * (`recvMillis`), which is what "bytes per wall-clock second" means.
 */
/**
 * One sub-stream's contribution from a single decoded packet. A sensor that
 * carries a single stream emits one of these per packet; a sensor whose FIFO
 * interleaves multiple streams (e.g. the LSM6DSV accel/gyro/mag) emits one per
 * active sub-stream.
 */
interface StreamContribution {
    /** Unique key per sub-stream, e.g. `"2"` or `"6:accel"`. */
    key: string;
    /** Human label, e.g. `"Accel"`. */
    label: string;
    /** Configured/expected rate for this sub-stream, or null if unknown. */
    samplingRateHz: number | null;
    /** Number of samples of this sub-stream in this packet. */
    sampleCount: number;
    /** Min `tsMillis` (monotonic device clock) of this sub-stream in this packet. */
    firstSampleMillis: number | null;
    /** Max `tsMillis` (monotonic device clock) of this sub-stream in this packet. */
    lastSampleMillis: number | null;
}
/** Per-sub-stream loss/rate accounting in a snapshot. */
interface StreamLossStats {
    key: string;
    sensorId: number;
    label: string;
    samplingRateHz: number | null;
    samples: number;
    expectedSamples: number;
    lostSamples: number;
    lossPct: number;
    /** Achieved sample rate over the sliding window (samples/sec). */
    windowSampleRateHz: number;
    lastSampleMillis: number | null;
}
/** Per-sensor rollup in a snapshot. */
interface SensorStreamStats {
    sensorId: number;
    packets: number;
    bytes: number;
    crcFails: number;
    /** Windowed throughput for this sensor's frames (bytes/sec). */
    windowThroughputBps: number;
    /** Windowed packet rate for this sensor (packets/sec). */
    windowPacketRateHz: number;
    streams: StreamLossStats[];
}
/** Full snapshot of stream statistics at a point in time. */
interface StreamStatsSnapshot {
    durationMillis: number;
    totalPackets: number;
    totalSamples: number;
    totalBytes: number;
    totalCrcFails: number;
    /**
     * Bytes discarded while re-locking onto frame boundaries after the stream lost
     * sync (e.g. dropped bytes on a weak BLE link). 0 on a healthy stream; a rising
     * count means data was lost on the wire but the parser is recovering cleanly.
     */
    resyncDroppedBytes: number;
    /** Overall windowed bytes/sec across all sensors. */
    throughputBps: number;
    /** Aggregate lostSamples / expectedSamples * 100. */
    lossPct: number;
    perSensor: Record<number, SensorStreamStats>;
}
/**
 * Accumulates live statistics for one streaming session. Call {@link reset} on
 * (re)start, {@link recordPacket} for every decoded packet, {@link recordCrcFail}
 * for CRC failures, and {@link snapshot} to read the current numbers.
 */
declare class StreamStatsTracker {
    private readonly windowMillis;
    private sessionStartMillis;
    private resyncDroppedBytes;
    private readonly sensors;
    private readonly streams;
    constructor(opts?: {
        windowMillis?: number;
    });
    /** Clear all state. Call when streaming (re)starts. */
    reset(): void;
    private getSensor;
    private getStream;
    /** Record one received (and decoded) streaming packet. */
    recordPacket(p: {
        sensorId: number;
        byteLength: number;
        crcOk: boolean | null;
        recvMillis: number;
        contributions: StreamContribution[];
    }): void;
    /** Record a CRC failure for a (possibly unknown) sensor. */
    recordCrcFail(sensorId?: number): void;
    /**
     * Record bytes discarded while re-synchronising the frame parser after the
     * stream lost alignment (typically a flaky link dropping bytes mid-stream).
     */
    recordResyncDrop(byteCount?: number): void;
    private prune;
    /**
     * Cadence-relative stall test: a stream is "stalled" only if its newest packet
     * is older than a multiple of its own observed packet interval (floored at the
     * window). This keeps a stalled stream reading 0 while NOT zeroing a healthy
     * stream that simply delivers less often than the window (big FIFO reads, slow
     * sensors). Events carry a receive time `t`.
     */
    private isStalled;
    /**
     * Achieved sample rate for a sub-stream's windowed events.
     *
     * Measured over the *device-clock* span of the samples — from the first
     * sample of the oldest packet to the last sample of the newest packet (their
     * tsMillis), not the host receive-time window. This is robust to bursty BLE
     * delivery AND to large packets: one packet can carry hundreds of samples
     * spanning several seconds (e.g. a high FIFO watermark), so dividing its count
     * by the fixed receive window would over-report. Using the samples' own
     * device-time span gives the true rate even from a single packet. A stream
     * whose newest packet is older than a cadence-relative threshold reads 0 (see
     * {@link isStalled}).
     */
    private windowRateHz;
    /**
     * Windowed throughput (bytes/sec) and packet rate over the *actual* receive
     * span of the retained events, robust to packets that arrive less often than
     * the window. Bytes/packets are counted after the oldest event (the span's
     * start point). Returns 0 if the stream is stalled (see {@link isStalled}).
     */
    private windowThroughput;
    /** Produce a snapshot of all statistics as of `nowMillis`. */
    snapshot(nowMillis: number): StreamStatsSnapshot;
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

/** NUS primary service UUID. */
declare const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
/** NUS TX characteristic UUID (host writes to this). */
declare const NUS_TX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
/** NUS RX characteristic UUID (host subscribes to notifications from this). */
declare const NUS_RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
/** Nordic Secure DFU service UUID (buttonless DFU). */
declare const NORDIC_DFU_SERVICE = "0000fe59-0000-1000-8000-00805f9b34fb";
/** Nordic buttonless DFU control-point characteristic (without bond sharing). */
declare const NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS = "8ec90003-f315-4f60-9fb8-838830daea50";
/** Nordic buttonless DFU control-point characteristic (with bond sharing). */
declare const NORDIC_DFU_BUTTONLESS_WITH_BONDS = "8ec90004-f315-4f60-9fb8-838830daea50";
/** Buttonless DFU control-point op-code that reboots the device into the bootloader. */
declare const NORDIC_DFU_OP_ENTER_BOOTLOADER = 1;
/** Upper-nibble command classes used in protocol headers. */
declare const ASM_COMMAND: Readonly<{
    readonly READ: 16;
    readonly WRITE: 32;
    readonly RESPONSE: 48;
    readonly ACK: 64;
    readonly NACK_BAD_HEADER_COMMAND: 80;
    readonly NACK_BAD_HEADER_PROPERTY: 96;
    readonly NACK_GENERIC: 112;
    readonly ACK_NEXT_STAGE: 128;
}>;
type AsmCommand = (typeof ASM_COMMAND)[keyof typeof ASM_COMMAND];
/** Lower-nibble property IDs used in protocol headers. */
declare const ASM_PROPERTY: Readonly<{
    readonly STATUS1: 1;
    readonly DATA: 2;
    readonly PRODUCTION_CONFIGURATION: 3;
    readonly OPERATIONAL_CONFIGURATION: 4;
    readonly TIME: 5;
    readonly DFU_MODE: 6;
    readonly PENDING_EVENTS: 7;
    readonly TEST_MODE: 8;
    readonly DEBUG_COMMAND: 9;
    readonly STREAM_MODE: 10;
    readonly DEVICE_DISCONNECT: 11;
    readonly STATUS2: 12;
    readonly CALIBRATION: 13;
}>;
type AsmProperty = (typeof ASM_PROPERTY)[keyof typeof ASM_PROPERTY];
/** Stream mode payload values. */
declare const STREAM_MODE: Readonly<{
    readonly ENABLE: 1;
    readonly DISABLE: 2;
}>;
/** Test mode IDs documented by Verisense firmware. */
declare const TEST_MODE_ID: Readonly<{
    readonly STOP: 0;
    readonly FLASH_8MB_1: 1;
    readonly FLASH_8MB_2: 2;
    readonly FLASH_128MB_512MB: 3;
    readonly EEPROM: 4;
    readonly ACCEL1_LIS2DW12: 5;
    readonly BATTERY_VOLTAGE: 6;
    readonly USB_POWER: 7;
    readonly ACCEL2_GYRO_LSM6DS3: 8;
    readonly PPG_MAX86XXX: 9;
    readonly BIOZ_MAX30002: 11;
    readonly ACCEL2_GYRO_LSM6DSV: 12;
    readonly MAG_LIS2MDL: 13;
    readonly ALL_TESTS: 255;
}>;
type TestModeId = (typeof TEST_MODE_ID)[keyof typeof TEST_MODE_ID];
/** Debug command IDs documented by Verisense firmware. */
declare const DEBUG_COMMAND_ID: Readonly<{
    readonly FLASH_LOOKUP_TABLE_READ: 1;
    readonly FLASH_LOOKUP_TABLE_ERASE: 2;
    readonly RWC_SCHEDULER_READ: 3;
    readonly ERASE_128MB_512MB_FLASH: 4;
    readonly ERASE_8MB_FLASH_1: 5;
    readonly ERASE_8MB_FLASH_2: 6;
    readonly ERASE_OPERATIONAL_CONFIG: 7;
    readonly ERASE_PRODUCTION_CONFIG: 8;
    readonly CLEAR_PENDING_EVENTS: 9;
    readonly ERASE_FLASH_AND_LOOKUP_TABLE: 10;
    readonly TEST_DATA_TRANSFER_LOOP: 11;
    readonly LOAD_TEST_LOOKUP_TABLE: 12;
    readonly LED_TEST: 13;
    readonly MAX86XXX_LED_TEST: 14;
    readonly CHECK_PAYLOAD_CRC_ERRORS: 15;
    readonly READ_EVENT_LOG: 16;
    readonly POWER_PROFILER_TEST: 17;
    readonly READ_RECORD_BUFFER_DETAILS: 18;
    readonly SYSTEM_RESET: 19;
    readonly IC_POWER_CONSUMPTION_TEST: 20;
    readonly DELETE_ALL_BONDS: 21;
    readonly BLE_LINK_PARAMS_READ: 22;
    readonly BLE_LINK_OPTIMIZE: 23;
    /** Streamed MAX32674C algorithm-hub firmware (.msbl) upload (factory). The
     * byte after this id is a HUB_FW_UPLOAD_STAGE sub-stage. */
    readonly HUB_FW_UPLOAD: 24;
}>;
type DebugCommandId = (typeof DEBUG_COMMAND_ID)[keyof typeof DEBUG_COMMAND_ID];
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
    readonly LSM6DSV_CFG_0: 18;
    readonly LSM6DSV_CFG_1: 19;
    readonly LSM6DSV_CFG_2: 20;
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
    readonly OP_CONFIG_VERSION: 9;
    readonly LIGHT_GAIN_INDEX: 72;
    readonly LIGHT_EXPOSURE_INDEX: 73;
    readonly LIGHT_CONFIG: 74;
    readonly LIGHT_SAMPLE_RATE_INDEX: 75;
    readonly SKIN_TEMP_CONFIG: 76;
    readonly SKIN_TEMP_SAMPLE_RATE_INDEX: 77;
    readonly ALGO_OP_MODE: 78;
    readonly ALGO_REPORT_MODE_RATE: 79;
    readonly ALGO_CONTROL: 80;
    readonly ALGO_INITIAL_HR: 81;
    readonly LED_AUTO_BRIGHTNESS_CFG: 82;
    readonly LED_MAX_BRIGHTNESS: 83;
    readonly LED_LUX_THRESHOLD: 84;
    readonly PERSON_HEIGHT_CM: 86;
    readonly PERSON_WEIGHT_KG: 88;
    readonly PERSON_AGE: 90;
    readonly PERSON_GENDER: 91;
}>;
type OpIdx = keyof typeof OP_IDX;
/** Minimum firmware version that supports the BLE-link debug commands
 * (read/optimize connection parameters). */
declare const BLE_LINK_MIN_FW: Readonly<{
    major: 1;
    minor: 4;
    internal: 23;
}>;
/** Human-readable labels for Verisense stream-packet sensor IDs. Each ID maps to
 * the device part(s) that produce that stream (some streams interleave several
 * physical sensors, e.g. id 6 = LSM6DSV accel + gyro + mag). */
declare const VERISENSE_STREAM_SENSOR_LABELS: Readonly<{
    readonly 1: "ADC (GSR / Battery)";
    readonly 2: "Accel 1 (LIS2DW12)";
    readonly 3: "Accel 2 + Gyro (LSM6DS3)";
    readonly 4: "PPG (MAX86xxx)";
    readonly 6: "Accel 2 + Gyro + Mag (LSM6DSV + LIS2MDL)";
    readonly 7: "Ambient Light (VD6283)";
    readonly 8: "Algo Hub (MAX32674 — HR + raw PPG)";
    readonly 9: "Skin Temperature (MLX90632)";
}>;

/**
 * Verisense sensor-calibration TLV codec.
 *
 * Mirrors the firmware `asm_calibration.{c,h}` byte format. A calibration "blob"
 * is a self-describing block of per-sensor calibration that the device persists,
 * exposes over the `CALIBRATION` command, and stamps into every logged payload
 * header via a CRC-16 version tag.
 *
 * Layout (all little-endian):
 *
 *   Global header (12 bytes)
 *     0  u16  totalLen          (= blob.length - 2)
 *     2  u8   calibFormatVersion
 *     3  u8   hwVerMajor
 *     4  u8   hwVerMinor
 *     5  u8   fwVerMajor
 *     6  u8   fwVerMinor
 *     7  u16  fwVerPatch
 *     9  u8   sensorBlockCount
 *    10  u16  reserved
 *
 *   Per-sensor block (12-byte header + payload)
 *     0  u16  sensorId          (calibration-domain id, see {@link CalibSensorId})
 *     2  u8   range/quality     (bits[5:0] full-scale index; bits[7:6] calib quality)
 *     3  u8   dataLen
 *     4  u8[8] ts               (0 = default/seeded; RTC time = real per-unit cal)
 *    12  payload[dataLen]
 *
 *   IMU payload (60 bytes, float32): bias[3] · sens[3] · align[9] (row-major 3x3)
 *
 * Calibration math (ASM-DES04 §8): output = K·R·physical + b, so the host
 * recovers physical = R⁻¹·K⁻¹·(raw − b). K is the diagonal sensitivity, R the
 * rotation into the common ASM axes, b the offset bias.
 */
declare const SC_CALIB_FORMAT_VERSION = 1;
declare const SC_GLOBAL_HEADER_BYTES = 12;
declare const SC_DATA_LEN_IMU = 60;
/**
 * The per-block `range` byte packs the full-scale index in bits [5:0] and a 2-bit
 * calibration-quality indicator in bits [7:6]. Lookups/comparisons must use only
 * the index (`range & SC_CAL_RANGE_MASK`). Quality has no producer yet (always 0),
 * so it is reserved without growing the blob or bumping the format version.
 */
declare const SC_CAL_RANGE_MASK = 63;
declare const SC_CAL_QUALITY_SHIFT = 6;
declare const SC_CAL_QUALITY_MASK = 3;
/** Calibration-quality indicator (ST MotionAC / Android sensor-accuracy convention). */
declare const CalibQuality: {
    readonly UNKNOWN: 0;
    readonly POOR: 1;
    readonly OK: 2;
    readonly GOOD: 3;
};
type CalibQuality = (typeof CalibQuality)[keyof typeof CalibQuality];
/**
 * Calibration-domain sensor IDs. Distinct from the data-stream sensor IDs
 * (1=ADC, 2=LIS2DW12, 3=LSM6DS3, 4=PPG, 6=LSM6DSV, 7=VD6283, 8=MAX32674,
 * 9=MLX90632). These reuse the Shimmer3 `SC_SENSOR_*` values where they exist,
 * so accel/gyro/mag can each carry their own calibration even though one
 * data-stream id (6) covers all three.
 *
 * Data-stream → calibration mapping: 6 → {37, 38, 42}, 2 → {39}, 3 → {40, 41}.
 */
declare const CalibSensorId: {
    readonly LSM6DSV_ACCEL: 37;
    readonly LSM6DSV_GYRO: 38;
    readonly LIS2DW12_ACCEL: 39;
    /** 1st-gen LSM6DS3 accel (data-stream id 3). */
    readonly LSM6DS3_ACCEL: 40;
    /** 1st-gen LSM6DS3 gyro (data-stream id 3). */
    readonly LSM6DS3_GYRO: 41;
    readonly LIS2MDL_MAG: 42;
};
type CalibSensorId = (typeof CalibSensorId)[keyof typeof CalibSensorId];
/** Per-unit IMU calibration: offset bias, diagonal sensitivity, and 3x3 rotation. */
interface ImuCalibration {
    /** Offset bias `b`, per axis (sensor LSB). */
    bias: [number, number, number];
    /** Diagonal sensitivity `K`, per axis (LSB per physical unit). */
    sens: [number, number, number];
    /** Rotation `R`, row-major 3x3 (length 9), mapping sensor axes to ASM axes. */
    align: number[];
}
interface CalibrationBlock {
    sensorId: number;
    /** Full-scale index (the low 6 bits of the wire `range` byte). */
    range: number;
    /** Calibration quality, bits [7:6] of the wire `range` byte (0 = unknown today). */
    quality: number;
    dataLen: number;
    /** 8-byte calibration timestamp; all-zero means default/seeded. */
    ts: Uint8Array;
    isDefault: boolean;
    payload: Uint8Array;
    /** Decoded IMU calibration when the block is a 60-byte IMU payload. */
    imu?: ImuCalibration;
}
interface CalibrationSet {
    formatVersion: number;
    hwVerMajor: number;
    hwVerMinor: number;
    fwVerMajor: number;
    fwVerMinor: number;
    fwVerPatch: number;
    reserved: number;
    blocks: CalibrationBlock[];
    /** CRC-16/CCITT-FALSE over the whole blob — equals the payload-header version tag. */
    crc16: number;
    /** Find the IMU calibration for a calibration-domain sensor id + range, else null. */
    getImu(sensorId: number, range: number): ImuCalibration | null;
}
/** Parse a calibration blob into a typed, indexable {@link CalibrationSet}. */
declare function parseCalibrationBlob(blob: Uint8Array): CalibrationSet;
interface CalibrationBlockInput {
    sensorId: number;
    /** Full-scale index (only the low 6 bits are used). */
    range: number;
    /** Calibration quality (0-3); defaults to 0 (unknown). Packed into range byte bits [7:6]. */
    quality?: number;
    /** 8-byte timestamp; defaults to all-zero (a "default/seeded" marker). */
    ts?: Uint8Array | null;
    imu?: ImuCalibration;
    /** Raw payload override (used when `imu` is not supplied). */
    payload?: Uint8Array;
}
interface CalibrationSetInput {
    formatVersion?: number;
    hwVerMajor: number;
    hwVerMinor: number;
    fwVerMajor: number;
    fwVerMinor: number;
    fwVerPatch: number;
    reserved?: number;
    blocks: CalibrationBlockInput[];
}
/** Serialize a calibration set into a blob (inverse of {@link parseCalibrationBlob}). */
declare function serializeCalibrationBlob(input: CalibrationSetInput): Uint8Array;
/** CRC-16/CCITT-FALSE over a serialized blob — the value stamped into payload headers. */
declare function calibrationBlobCrc(blob: Uint8Array): number;
/**
 * Apply IMU calibration to a raw tri-axial sample.
 *
 *   physical = align · (K⁻¹ · (raw − bias))
 *
 * `bias` (b) is subtracted and `sens` (K, diagonal) divided per axis, then the
 * `align` matrix (row-major 3x3) is applied directly to rotate the sensor frame
 * into the common ASM frame. With identity `align` and zero `bias` this reduces
 * to `raw / sens`.
 *
 * Convention note: `align` is the directly-applied sensor-frame → ASM-frame
 * matrix (= R⁻¹ in ASM-DES04 §8's `output = K·R·physical + b` notation). This
 * matches the cloud calibration CSV `rotation_*` columns one-to-one — the CSV
 * stores the same applied matrix, row-major — so the sensor-calibration parser
 * maps blob → CSV with NO transpose. (Confirmed against a LIS2DW12 sample CSV:
 * offset→bias, sensitivity→sens, rotation→align.)
 */
declare function applyImuCalibration(raw: readonly [number, number, number], cal: ImuCalibration): [number, number, number];

interface VerisenseMessage {
    header: number;
    command: AsmCommand;
    property: AsmProperty;
    payloadLength: number;
    payload: Uint8Array;
}
/** Build a protocol header byte from command/property nibbles. */
declare function buildHeader(command: AsmCommand, property: AsmProperty): number;
/** Decode a protocol header byte into command/property fields. */
declare function parseHeader(header: number): {
    command: AsmCommand;
    property: AsmProperty;
};
/** Build a complete protocol message (header + 16-bit LE payload length + payload bytes). */
declare function buildMessage(command: AsmCommand, property: AsmProperty, payloadBytes?: Uint8Array | number[]): Uint8Array;
/** Parse a complete protocol message into structured fields. */
declare function parseMessage(msg: Uint8Array): VerisenseMessage;
declare function isAckCommand(command: AsmCommand): boolean;
declare function isNackCommand(command: AsmCommand): boolean;
/** Convert a pending-events payload (property IDs) into a typed array. */
declare function parsePendingEvents(payload: Uint8Array): AsmProperty[];

/** Format a single byte as an uppercase `0xNN` string. */
declare function formatByteAsHex(v: number): string;
/** Format bytes as `[0xAA, 0xBB, ...]`. */
declare function formatByteArrayAsHex(bytes: ArrayLike<number> | ArrayBuffer | null | undefined): string;
/** Parse text containing hex bytes like `0x5A, 00 12` into a Uint8Array. */
declare function parseHexByteString(text: string): Uint8Array;
/** A Verisense firmware version triple (major.minor.internal). */
interface VerisenseFirmwareVersion {
    major: number;
    minor: number;
    internal: number;
}
/**
 * Compare two firmware version triples. Returns a negative number if `a < b`,
 * positive if `a > b`, and 0 if equal. Missing or non-numeric components are
 * treated as 0.
 */
declare function compareVerisenseFirmwareVersion(a: Partial<VerisenseFirmwareVersion> | null | undefined, b: Partial<VerisenseFirmwareVersion> | null | undefined): number;
/** Format a firmware version triple as `"major.minor.internal"`, or `"unknown"`
 * when the version is null/undefined. */
declare function formatVerisenseFirmwareVersion(v: Partial<VerisenseFirmwareVersion> | null | undefined): string;
/** Human-readable label for a Verisense stream-packet sensor ID, with a
 * `"Sensor 0xNN"` hex fallback for unknown IDs. */
declare function getVerisenseStreamSensorLabel(sensorId: number): string;
interface PendingEventPropertyLabel {
    value: number;
    hex: string;
    property: string;
}
/** Label pending-event property values with both enum name and hex representation. */
declare function formatPendingEventProperties(pendingProps: ArrayLike<number> | null | undefined): PendingEventPropertyLabel[];
/**
 * Compute CRC-16/CCITT-FALSE over `bytes`.
 *
 * Parameters: poly=0x1021, init=0xFFFF, xorOut=0x0000.
 * Matches the C# `ComputeCRC` implementation used by Verisense firmware.
 */
declare function crc16_ccitt_false(bytes: Uint8Array): number;
/**
 * Convert any reasonable representation of an operational config to a
 * `Uint8Array`. Throws if the input type is unrecognised.
 */
declare function normalizeOperationalConfig(payload: Uint8Array | ArrayBuffer | number[] | {
    buffer: ArrayBuffer;
    byteOffset?: number;
    byteLength?: number;
} | null | undefined): Uint8Array | null;
/** Alias for arbitrary protocol byte payload normalization. */
declare function normalizeBytePayload(payload: Uint8Array | ArrayBuffer | number[] | {
    buffer: ArrayBuffer;
    byteOffset?: number;
    byteLength?: number;
} | null | undefined): Uint8Array | null;
/**
 * Derive the 6-digit pairing PIN from a Verisense unique identifier.
 *
 * The PIN is built from digits 2, 4 and 6 (1-based) of the identifier,
 * followed by the decimal value of the final byte padded to 3 digits.
 */
declare function computeVerisensePairingPin(uniqueId: string): string;
interface ProductionConfig {
    hardware: string;
    firmware: string;
    asmid: string;
    configHeader: number;
    revHwMajor?: number;
    revHwMinor?: number;
    revHwInternal?: number;
    revFwMajor?: number;
    revFwMinor?: number;
    revFwInternal?: number;
}
interface ProductionConfigBuildOptions {
    manufacturingOrderNumberHex: string;
    macIdHex: string;
    revHwMajor: number;
    revHwMinor: number;
    revFwMajor: number;
    revFwMinor: number;
    revFwInternal?: number;
    revHwInternal?: number;
    passkeyId?: string;
    passkey?: string;
    advertisingNamePrefix?: string;
    dfuEnabled?: boolean;
}
interface ProductionConfigFull extends ProductionConfig {
    manufacturingOrderNumber: string;
    macId: string;
    uniqueIdentifier: string;
    revHwMajor: number;
    revHwMinor: number;
    revHwInternal: number;
    revFwMajor: number;
    revFwMinor: number;
    revFwInternal: number;
    passkeyId: string;
    passkey: string;
    advertisingNamePrefix: string;
    dfuEnabled: boolean;
}
interface VerisenseStatusFlags {
    usbPluggedIn: boolean;
    recordingPaused: boolean;
    flashIsFull: boolean;
    powerIsGood: boolean;
    adaptiveSchedulerOn: boolean;
    dfuServiceOn: boolean;
    firstBoot: boolean;
    repeatedBatteryMeasurement: boolean;
}
interface VerisenseStatusPayload {
    uniqueIdentifier: string;
    sourceStatusProperty: 'status1' | 'status2';
    statusTimestampSeconds: number;
    batteryMilliVolts: number;
    batteryPercent: number;
    lastOkTransferSeconds: number;
    lastFailTransferSeconds: number;
    memoryFreeKb: number;
    memoryCapacityKb: number | null;
    memoryUsedKb: number | null;
    /** kB of FULL (ready-to-sync) flash banks. Only populated for payloads >= 57 bytes. */
    memoryFullBanksKb: number | null;
    /** kB of 2DEL (partially-deleted) flash banks. Only populated for payloads >= 57 bytes. */
    memoryTwoDelBanksKb: number | null;
    /** kB of BAD flash banks. Only populated for payloads >= 57 bytes. */
    memoryBadBanksKb: number | null;
    statusFlags: VerisenseStatusFlags | null;
    batteryFallCounter: number | null;
    /** Byte 64 bit0 (charger chip present). Null for legacy payloads (<65 bytes). */
    chargerPresent: boolean | null;
    /** Byte 64 bits1..3 (BatteryChargerStatus_t). Null for legacy payloads (<65 bytes). */
    chargerStatusCode: number | null;
    /** Decoded charger status enum label from chargerStatusCode. */
    chargerStatusName: 'CHARGER_STATUS_BAD_BATTERY' | 'CHARGER_STATUS_CHARGING' | 'CHARGER_STATUS_CHARGING_COMPLETE' | 'CHARGER_STATUS_POWER_DOWN' | 'CHARGER_STATUS_TRICKLE_CHARGING' | 'CHARGER_STATUS_NOT_READ' | 'CHARGER_STATUS_UNKNOWN' | null;
}
interface VerisenseUnixAndHumanTimestamp {
    unix: number;
    human: string;
}
interface VerisenseStatusPayloadForLog extends VerisenseStatusPayload {
    statusTimestamp: VerisenseUnixAndHumanTimestamp;
    lastOkTransfer: VerisenseUnixAndHumanTimestamp;
    lastFailTransfer: VerisenseUnixAndHumanTimestamp;
}
type VerisenseChargerChipFamily = 'LM3658D' | 'LTC4123' | 'XC6803' | 'UNKNOWN';
/** Infer charger chip family from hardware revision fields in production config. */
declare function inferVerisenseChargerChipFamily(revHwMajor: number, revHwMinor: number, revHwInternal: number): VerisenseChargerChipFamily;
/** Return chip-specific charger status text for a parsed 3-bit status code. */
declare function describeVerisenseChargerStatus(chipFamily: VerisenseChargerChipFamily, statusCode: number): string;
/** Format charger summary text for UIs, e.g. "XC6803: Charge completed". */
declare function formatVerisenseChargerStatus(status: Pick<VerisenseStatusPayload, 'chargerPresent' | 'chargerStatusCode' | 'chargerStatusName'>, hw?: {
    revHwMajor?: number;
    revHwMinor?: number;
    revHwInternal?: number;
}): string;
interface VerisenseSchedulerDebugPayload {
    currentTimeUnixSeconds: number;
    bleControlCounter: 'data-transfer' | 'status1' | 'rtc-sync' | 'status2' | 'never' | 'unknown';
    pendingDataTransferUnixSeconds: number;
    pendingStatus1UnixSeconds: number;
    pendingRtcSyncUnixSeconds: number;
    pendingRetryUnixSeconds: number;
    retryCount: number;
    retryOperation: 'ble-off' | 'ble-on' | 'unknown';
    adaptiveScheduler?: {
        nextUnixSeconds: number;
        enabled: boolean;
        syncFailCounter: number;
    };
    ltfRetry?: {
        nextUnixSeconds: number;
        currentOperation: 'flash-write-retry-inactive' | 'short-flash-write-retry' | 'attempt-flash-write' | 'long-flash-write-retry' | 'sensor-paused-until-usb-plug-in' | 'unknown';
        failCounterShort: number;
        failCounterLong: number;
    };
    pendingStatus2UnixSeconds?: number;
    ppgMeasurementUnixSeconds?: number;
    stepCounterResetUnixSeconds?: number;
    sensorInactivityUnixSeconds?: number;
}
interface VerisenseSchedulerDebugPayloadForLog extends VerisenseSchedulerDebugPayload {
    currentTime: VerisenseUnixAndHumanTimestamp;
    pendingDataTransfer: VerisenseUnixAndHumanTimestamp;
    pendingStatus1: VerisenseUnixAndHumanTimestamp;
    pendingRtcSync: VerisenseUnixAndHumanTimestamp;
    pendingRetry: VerisenseUnixAndHumanTimestamp;
    pendingStatus2?: VerisenseUnixAndHumanTimestamp;
    ppgMeasurement?: VerisenseUnixAndHumanTimestamp;
    stepCounterReset?: VerisenseUnixAndHumanTimestamp;
    sensorInactivity?: VerisenseUnixAndHumanTimestamp;
    adaptiveScheduler?: VerisenseSchedulerDebugPayload['adaptiveScheduler'] & {
        nextTime: VerisenseUnixAndHumanTimestamp;
    };
    ltfRetry?: VerisenseSchedulerDebugPayload['ltfRetry'] & {
        nextTime: VerisenseUnixAndHumanTimestamp;
    };
}
interface VerisenseBleLinkDebugPayload {
    attMtu: number;
    maxDataLength: number;
    connectionIntervalUnits: number;
    connectionIntervalMs: number;
    txPhy: number;
    rxPhy: number;
    optimizationResult: number;
    isConnected: boolean;
}
interface VerisenseEventLogEntry {
    index: number;
    eventId: number;
    eventName: string;
    timestampUnixSeconds: number | null;
    batteryMilliVolts: number | null;
}
/** Format unix seconds as raw + human-readable local datetime for logging. */
declare function formatVerisenseUnixAndHuman(unixSeconds: number): VerisenseUnixAndHumanTimestamp;
/** Convert parsed status payload into an object with human-readable timestamps for logs. */
declare function formatStatusPayloadForLog(status: VerisenseStatusPayload): VerisenseStatusPayloadForLog;
/** Convert parsed scheduler payload into an object with human-readable timestamps for logs. */
declare function formatSchedulerPayloadForLog(parsed: VerisenseSchedulerDebugPayload): VerisenseSchedulerDebugPayloadForLog;
interface VerisenseRecordBufferDetails {
    bufferIndex: number;
    bufferState: number;
    packagedPayloadIndex: number;
    currentByteIndexForSensorData: number;
    usedBufferLength: number;
    fifoTicks: number;
    dataTimestampRwcMinutes: number;
    dataTimestampRwcTicks: number;
    temperatureData: number;
    dataTimestampUcClockMinutes: number | null;
    dataTimestampUcClockTicks: number | null;
}
interface VerisenseLookupTableEntry {
    bankIndex: number;
    statusCode: number;
    statusName: 'Full' | '2Del' | 'Emty' | 'Bad' | 'NUse' | 'Zero' | 'Unknown';
    pendingEepromWrite: boolean;
    payloadIndex: number;
}
interface VerisenseLookupTablePayload {
    head: number | null;
    tail: number | null;
    entries: VerisenseLookupTableEntry[];
}
/** Convert unix seconds into Verisense 7-byte RTC payload (4-byte minutes + 3-byte ticks). */
declare function unixSecondsToAsmRtcBytes(unixSeconds: number): Uint8Array;
/** Convert Verisense 7-byte RTC payload into unix seconds. */
declare function asmRtcBytesToUnixSeconds(rtc7: Uint8Array): number;
/** Convert Verisense 8-byte minute counter payload into unix seconds. */
declare function asmRtcMinutesBytesToUnixSeconds(minutes8: Uint8Array): number;
/**
 * Build a production configuration payload (56 bytes) from structured options.
 * This matches the Python tooling layout used by ASM_BLE.py / ASM_Device.py.
 */
declare function buildProductionConfigPayload(opts: ProductionConfigBuildOptions): Uint8Array;
/** Parse production configuration with optional passkey/name/flag fields. */
declare function parseProductionConfigPayloadFull(response: Uint8Array): ProductionConfigFull;
/**
 * Parse STATUS1/STATUS2 payload into a typed object.
 *
 * This ports the core byte parsing from ASM_Device.parse_status while keeping
 * the output concise and UI-friendly.
 */
declare function parseStatusPayload(response: Uint8Array, sourceStatusProperty?: 'status1' | 'status2'): VerisenseStatusPayload;
/** Parse scheduler debug response payload from DEBUG_COMMAND_ID.RWC_SCHEDULER_READ. */
declare function parseSchedulerDebugPayload(payload: Uint8Array): VerisenseSchedulerDebugPayload;
/** Parse debug payload from BLE link read/optimize commands. */
declare function parseBleLinkDebugPayload(payload: Uint8Array): VerisenseBleLinkDebugPayload;
/** Parse debug payload listing bank indexes with bad CRC (2-byte LE entries). */
declare function parsePayloadCrcErrorBankIndexes(payload: Uint8Array): number[];
/** Parse 8-byte debug event-log entries. */
declare function parseEventLogPayload(payload: Uint8Array): VerisenseEventLogEntry[];
/** Parse record-buffer details payload (26-byte current layout, 19-byte legacy layout). */
declare function parseRecordBufferDetailsPayload(payload: Uint8Array): VerisenseRecordBufferDetails[];
/**
 * Infer the lookup-table bank count from a raw debug payload length. The payload
 * is 3 bytes per bank, optionally prefixed with a 4-byte head/tail block.
 * Returns 0 if the length matches neither layout.
 */
declare function inferVerisenseLookupBankCount(payloadLen: number): number;
/**
 * Parse lookup-table debug payload entries (3 bytes per bank), with optional
 * 4-byte tail/head prefix present in older firmware debug responses. When
 * `totalBanks` is omitted it is inferred from the payload length via
 * {@link inferVerisenseLookupBankCount}.
 */
declare function parseLookupTablePayload(payload: Uint8Array, totalBanks?: number): VerisenseLookupTablePayload;
/**
 * Parse the production config response payload into a structured object.
 */
declare function parseProductionConfigPayload(response: Uint8Array): ProductionConfig;

type ParsedSplitReason = 'midday-midnight-boundary' | 'config-change' | 'timestamp-discontinuity' | 'power-reset';
interface EvaluateParsedSplitInput {
    prevTimestampSec: number;
    currTimestampSec: number;
    expectedDeltaSec?: number;
    timestampToleranceSec?: number;
    prevConfigSignature?: string | null;
    currConfigSignature?: string | null;
    powerResetDetected?: boolean;
}
/** Build a binary upload file name: yyMMdd_HHmmss_00000.bin */
declare function buildUploadBinaryFileName(uploadDate: Date, firstPayloadIndex: number): string;
/** Build parsed CSV file name: yyMMdd_HHmmss_DataSource_00000.csv */
declare function buildParsedCsvFileName(startDate: Date, dataSource: string, firstPayloadIndex: number): string;
/** Add duplicate suffix like " (2)" before extension. */
declare function applyDuplicateSuffix(fileName: string, duplicateIndex: number): string;
/** Return first non-colliding duplicate name for a target file name. */
declare function nextAvailableDuplicateFileName(fileName: string, existingNames: Iterable<string>): string;
/** Parse first payload index (uint16 LE) from a payload byte array. */
declare function getFirstPayloadIndex(payload: Uint8Array): number;
/**
 * Evaluate whether parsed CSV output should roll to a new file.
 * Rules mirror ASM-DES08 split conditions.
 */
declare function evaluateParsedFileSplit(input: EvaluateParsedSplitInput): {
    shouldSplit: boolean;
    reasons: ParsedSplitReason[];
};

type VerisenseHardwareFriendlyName = 'IMU' | 'GSR+' | 'SDK' | 'Pulse+';
interface VerisenseHardwareCapabilities {
    readonly secondGeneration: boolean;
    readonly supportsMagnetometer: boolean;
}
interface VerisenseHardwareRevision {
    readonly major: number;
    readonly minor: number;
    readonly internal: number;
}
interface VerisenseHardwareRevisionSource {
    readonly revHwMajor?: number | null;
    readonly revHwMinor?: number | null;
    readonly revHwInternal?: number | null;
}
declare const VERISENSE_HW_MAJOR_FRIENDLY_NAMES: Readonly<Record<number, VerisenseHardwareFriendlyName>>;
declare function getVerisenseHardwareFriendlyName(revHwMajor: number): VerisenseHardwareFriendlyName | null;
/**
 * Second-generation Verisense hardware is currently defined as:
 * - SR61.5+
 * - SR68.9+
 * - Any future major revision above SR68
 */
declare function isVerisenseSecondGenerationHardware(revHwMajor: number, revHwMinor: number): boolean;
declare function getVerisenseHardwareCapabilities(revHwMajor: number, revHwMinor: number): VerisenseHardwareCapabilities;
/**
 * Which physical sensor blocks a Verisense board carries. Each flag lines up
 * with an operational-config field group (see
 * `getVerisenseSupportedOperationalFieldGroupIds`), so callers can decide which
 * config groups are meaningful for the connected hardware.
 *
 * Derived from the firmware Model IC matrix
 * (verisense-firmware/docs/VERISENSE_MODEL_IC_MATRIX.md).
 */
interface VerisenseHardwareSensorSupport {
    /** 1st-gen low-power accel, LIS2DW12 (`accel1` group). */
    readonly accel1: boolean;
    /** 1st-gen gyro + accel2, LSM6DS3 (`gyro_accel2` group). */
    readonly gyroAccel2: boolean;
    /** 2nd-gen IMU + magnetometer, LSM6DSV + LIS2MDL (`lsm6dsv` group). */
    readonly imuGen2: boolean;
    /** Galvanic skin response front-end (`adc_gsr` group). */
    readonly gsr: boolean;
    /** Photoplethysmography front-end (`ppg` group). */
    readonly ppg: boolean;
    /** Ambient light sensor, VD6283 (`light` group). */
    readonly ambientLight: boolean;
    /** Skin temperature sensor, MLX90632 (`skin_temp` group). */
    readonly skinTemperature: boolean;
    /** Algorithm hub, MAX32674 (`algo` group). */
    readonly algorithmHub: boolean;
    /** 2xRGB status LEDs with auto-brightness (`led` group). */
    readonly ledAutoBrightness: boolean;
}
/**
 * Resolves which sensor blocks a given Verisense hardware revision carries,
 * derived from the firmware Model IC matrix
 * (verisense-firmware/docs/VERISENSE_MODEL_IC_MATRIX.md).
 *
 * Unknown / development hardware (e.g. SR64, or any unrecognised major
 * revision) reports every block as present so consumers never hide a setting
 * they cannot confidently rule out.
 */
declare function getVerisenseHardwareSensorSupport(revHwMajor: number, revHwMinor: number): VerisenseHardwareSensorSupport;
declare function getVerisenseHardwareRevision(source: VerisenseHardwareRevisionSource | null | undefined): VerisenseHardwareRevision | null;
declare function supportsVerisenseMagnetometer(source: VerisenseHardwareRevisionSource | null | undefined): boolean;
declare function formatVerisenseHardwareRevision(revHwMajor: number, revHwMinor: number, revHwInternal?: number, opts?: {
    prefix?: string;
    includeFriendlyName?: boolean;
}): string;
/**
 * Battery voltage scaling for streamed ADC battery samples.
 * Status responses already contain firmware-scaled battery values and should not use this helper.
 */
declare function getVerisenseStreamingBatteryVoltageMultiplier(revHwMajor: number, revHwMinor: number): number;

type VerisenseOperationalFieldKind = 'bit' | 'u8' | 'u16' | 'u32' | 'inactiveResume' | 'inactiveMinutes';
type VerisenseOperationalFieldOption = readonly [number, string];
interface VerisenseOperationalFieldDefinition {
    readonly key: string;
    readonly label: string;
    readonly desc: string;
    readonly kind: VerisenseOperationalFieldKind;
    readonly index: number;
    readonly shift?: number;
    readonly width?: number;
    readonly min?: number;
    readonly max?: number;
    readonly options?: readonly VerisenseOperationalFieldOption[];
}
declare const VERISENSE_OPERATIONAL_FIELD_SCHEMA: ({
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 1;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 2;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 3;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 4;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 5;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 6;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 7;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 8;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 8;
    shift: number;
    width: number;
    min: number;
    max: number;
    options?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 11;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 11;
    shift: number;
    width: number;
    min: number;
    max: number;
    options?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 12;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 13;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 14;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 15;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 16;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 17;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 17;
    shift: number;
    width: number;
    min: number;
    max: number;
    options?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 18;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 19;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 20;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 29;
    options: (string | number)[][];
    shift?: undefined;
    width?: undefined;
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 31;
    options: (string | number)[][];
    shift?: undefined;
    width?: undefined;
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 50;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 51;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 59;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 60;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: number;
    min: number;
    max: number;
    shift?: undefined;
    width?: undefined;
    options?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 71;
    options: (string | number)[][];
    shift?: undefined;
    width?: undefined;
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 72;
    min: number;
    max: number;
    options: (string | number)[][];
    shift?: undefined;
    width?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 73;
    min: number;
    max: number;
    options: (string | number)[][];
    shift?: undefined;
    width?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 74;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 75;
    min: number;
    max: number;
    options: (string | number)[][];
    shift?: undefined;
    width?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 76;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 78;
    min: number;
    max: number;
    options: (string | number)[][];
    shift?: undefined;
    width?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 79;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 79;
    shift: number;
    width: number;
    options?: undefined;
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 80;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 82;
    shift: number;
    width: number;
    options: (string | number)[][];
    min?: undefined;
    max?: undefined;
} | {
    key: string;
    label: string;
    desc: string;
    kind: string;
    index: 91;
    min: number;
    max: number;
    options: (string | number)[][];
    shift?: undefined;
    width?: undefined;
})[];
declare const VERISENSE_OP_CONFIG_BYTE_SIZE = 92;
type VerisenseOperationalField = VerisenseOperationalFieldDefinition;
declare function createBlankVerisenseOperationalConfig(byteSize?: number): Uint8Array;
declare function readVerisenseOperationalFieldValue(op: Uint8Array, field: VerisenseOperationalField): number;
declare function writeVerisenseOperationalFieldValue(op: Uint8Array, field: VerisenseOperationalField, rawValue: unknown): void;
declare function setVerisenseOperationalBitRange(op: Uint8Array, index: number, shift: number, width: number, rawValue: unknown): void;
/**
 * Enforce the USB/Bluetooth comms-channel interlock on an operational-config
 * buffer.
 *
 * A Verisense must never be configured with BOTH Bluetooth and USB disabled, or
 * it becomes unreachable for reconfiguration (the radio is the only wireless way
 * back in, and disabling USB removes the wired fallback). If a config has both
 * `BLUETOOTH_EN` and `USB_EN` cleared, this forces BOTH back on.
 *
 * This mirrors the firmware safeguard (`enforceCommsChannelInterlock` in
 * `ASM_Production/main.c`, applied on config write and parse). Enforcing it here
 * in the SDK means any consuming application is protected — a device can't be
 * stranded by a third-party tool writing 0/0.
 *
 * Mutates `op` in place. Returns `true` if a correction was applied.
 */
declare function enforceVerisenseCommsChannelInterlock(op: Uint8Array): boolean;
interface VerisenseOperationalSensorEnableField {
    readonly key: string;
    readonly index: number;
    readonly shift: number;
}
declare const VERISENSE_SENSOR_ENABLE_FIELDS: readonly VerisenseOperationalSensorEnableField[];
interface VerisenseOperationalFieldSubgroupDefinition {
    readonly id: string;
    readonly title: string;
    readonly keys: readonly string[];
}
interface VerisenseOperationalFieldGroupDefinition {
    readonly id: string;
    readonly title: string;
    readonly openByDefault: boolean;
    readonly keys: readonly string[];
    /**
     * Optional presentational partition of {@link keys} into labelled subpanels
     * rendered inside the group. Purely for layout: group membership, hardware
     * support detection and field resolution all continue to use {@link keys}.
     * Subgroups need not be exhaustive — any key in {@link keys} not covered by a
     * subgroup is rendered above the subpanels, so nothing is ever hidden.
     */
    readonly subgroups?: readonly VerisenseOperationalFieldSubgroupDefinition[];
}
declare const VERISENSE_OPERATIONAL_FIELD_GROUPS: readonly VerisenseOperationalFieldGroupDefinition[];
declare const VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID = "gen";
/**
 * Maps each hardware-gated operational-config group id to the sensor block that
 * gates it (see {@link VerisenseHardwareSensorSupport}). Group ids absent from
 * this map (e.g. `gen`, `ble_wake`) configure behaviour that applies to
 * every board and are always considered supported.
 */
declare const VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR: Readonly<Record<string, keyof VerisenseHardwareSensorSupport>>;
/**
 * Returns the set of operational-config group ids (from
 * {@link VERISENSE_OPERATIONAL_FIELD_GROUPS}) whose underlying sensor is present
 * on the given hardware revision. A group is supported when it is not gated by a
 * sensor block, or when its gating sensor is present.
 *
 * Returns `null` when the hardware revision is unknown so callers can fall back
 * to showing every group.
 */
declare function getVerisenseSupportedOperationalFieldGroupIds(source: VerisenseHardwareRevisionSource | null | undefined): ReadonlySet<string> | null;
/** LIGHT_CONFIG bit 1 is the VD6283 dark-channel select: when set, the shared
 * visible/clear slot carries the dark (covered-photodiode) baseline instead of
 * the visible reading. Returns false for empty/nullish config. */
declare function isVerisenseLightDarkChannelEnabled(op: Uint8Array | null | undefined): boolean;

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
    /**
     * Per-device calibration read from the sensor, or null when none is available
     * (decoders then fall back to nominal full-scale/datasheet scaling). Set via
     * {@link applyCalibration}; subclasses read it in their calibrate routines.
     */
    protected calibration: CalibrationSet | null;
    /** Supply (or clear) the device calibration set used by this decoder. */
    applyCalibration(set: CalibrationSet | null): void;
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
    /**
     * Compute per-sample timestamps for a whole decoded burst.
     *
     * The base implementation treats every decoded sample as one evenly-spaced
     * time step at `samplingRateHz` (correct when each decoded sample is a single
     * combined time step). Sensors whose decoded array *interleaves* multiple
     * streams at different cadences (e.g. the LSM6DSV tagged FIFO, which mixes
     * accel / gyro / mag entries) override this to timestamp each stream on its
     * own rate — otherwise the shared rate spreads each stream's samples too far
     * back and consecutive blocks overlap on the time axis.
     */
    computeSampleTimestamps(decodedSamples: unknown[], block: {
        tsLastSampleMillis: number;
        systemTsLastSampleMillis: number;
        systemOffsetFirstTime?: number | null;
    }): Array<{
        tsMillis: number;
        systemTsMillis: number;
        systemTsPlotMillis: number;
    }>;
    /**
     * Turn a decoded + timestamped burst into one or more stream contributions
     * for live throughput / packet-loss tracking. The default treats the sensor
     * as a single stream; sensors whose decoded array interleaves several
     * sub-streams at different cadences (e.g. the LSM6DSV tagged FIFO) override
     * this to report one contribution per sub-stream so loss is tracked
     * independently.
     */
    getStreamContributions(samplesWithTime: Array<{
        timestamps?: {
            tsMillis: number;
        };
    }>, sensorId: number): StreamContribution[];
    /** Parse a raw sensor payload byte array into decoded samples. */
    abstract parsePayload(sensorPayloadBytes: Uint8Array): unknown[];
    /** Apply the Verisense operational config blob to update decoder settings. */
    abstract applyOperationalConfig(op: Uint8Array): void;
}

interface ADCGSRSample {
    raw: number;
    adc12: number;
    range: number;
    volts: number;
    kOhms: number;
    uS: number;
    connectivity: 'Connected' | 'Disconnected';
}
interface ADCBatterySample {
    /** Full 16-bit packed ADC/flags word from payload. */
    raw16: number;
    /** 12-bit ADC value extracted from `raw16`. */
    adc12: number;
    mV: number;
    usbPluggedIn: boolean;
    chargerStatusBits: number;
    chargerStatus: string;
}
interface ADCPayloadSample {
    gsr: ADCGSRSample | null;
    batt: ADCBatterySample | null;
}
type HardwareIdentifier = 'VERISENSE_PULSE_PLUS' | 'VERISENSE_GSR_PLUS' | string;
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
declare class SensorADC extends SensorBase {
    readonly LIMIT_MIN_VALID_USIEMENS = 0.03;
    readonly GSR_UNCAL_LIMIT_RANGE3_SR68 = 1134;
    readonly GSR_UNCAL_LIMIT_RANGE3_SR62 = 683;
    private readonly SHIMMER3_REF_KOHMS;
    private readonly SR68_REF_KOHMS;
    /**
     * ADC sample-rate code → divisor of the 32768 Hz clock. Mirrors the firmware
     * `samplingRateInTicksArray` (hal_adc.c): the sampling timer fires every
     * `divisor` ticks, producing one sample set per fire, so the streamed output
     * rate = 32768 / divisor. Oversampling uses SAADC burst mode and therefore
     * does NOT divide the output rate. Index 0 = "Off".
     */
    private static readonly ADC_RATE_DIVISORS;
    gsrEnabled: boolean;
    battEnabled: boolean;
    /** GSR range 0-3 (fixed) or 4 (auto-range). */
    gsrRangeSetting: number;
    hardwareIdentifier: HardwareIdentifier;
    hwRevisionMajor: number | null;
    hwRevisionMinor: number | null;
    hwRevisionInternal: number | null;
    gsrRateSettingRaw: number;
    gsrRangeSettingRaw: number;
    gsrOversamplingRateSettingRaw: number;
    constructor();
    setHardwareIdentifier(idStr: HardwareIdentifier): void;
    setHardwareRevision(revHwMajor: number, revHwMinor: number, revHwInternal?: number): void;
    setGsrRangeSetting(v: number): void;
    private getBatteryVoltageMultiplier;
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
    /**
     * Convert the 6-bit ADC sample-rate code to the streamed output rate in Hz,
     * or null for "Off"/unknown codes. Used for per-sample timestamp spacing.
     */
    decodeAdcSampleRateHz(rateCode: number): number | null;
    parsePayload(sensorPayloadBytes: Uint8Array): ADCPayloadSample[];
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
    /** Numeric full-scale index (0=2G..3=16G) used to select the device calibration block. */
    private rangeIndex;
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
    private static readonly ACC_RANGE_CODE;
    private static readonly GYRO_RANGE_CODE;
    private _calibrateAccel;
    private _calibrateGyro;
    parsePayload(sensorPayloadBytes: Uint8Array): LSM6DS3Sample[];
    applyOperationalConfig(op: Uint8Array): void;
}

interface LSM6DSVSample {
    tag: number;
    cnt: number;
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
    mag: {
        raw: [number, number, number];
        cal: [number, number, number];
        units: string;
    } | null;
}
declare class SensorLSM6DSV extends SensorBase {
    private static readonly TAG_GYRO;
    private static readonly TAG_ACCEL;
    private static readonly TAG_SENSORHUB_SLAVE0;
    accEnabled: boolean;
    gyroEnabled: boolean;
    magEnabled: boolean;
    private accelFsG;
    private gyroFsDps;
    private fsXlCode;
    private fsGCode;
    accelHz: number;
    gyroHz: number;
    magHz: number;
    constructor();
    private decodeAccelFsG;
    private decodeGyroFsDps;
    private decodeOdrHz;
    private decodeMagOutputRateHz;
    private calibrateAccel;
    private calibrateGyro;
    private calibrateMag;
    parsePayload(sensorPayloadBytes: Uint8Array): LSM6DSVSample[];
    applyOperationalConfig(op: Uint8Array): void;
    /**
     * Timestamp each stream (accel / gyro / mag) so all three cover the same block
     * time window. The tagged FIFO interleaves the streams, so the generic
     * global-index spacing spreads each stream by (#interleaved-streams)x too far
     * back and makes consecutive blocks overlap on the time axis.
     *
     * Each stream's effective rate is derived from *this block*: the block's
     * covered duration is taken from a directly-sampled reference stream (accel,
     * else gyro) at its known ODR, and every stream is then spread evenly over
     * that same duration by its own sample count. This is important for the mag
     * (LIS2MDL), which is read via the LSM6DSV sensor hub — its entries land in
     * the FIFO at the hub batch rate, NOT the LIS2MDL ODR, so a fixed mag ODR
     * would mis-spread it (the zig-zag). Deriving the rate from the block keeps it
     * aligned regardless of the hub rate.
     */
    computeSampleTimestamps(decodedSamples: unknown[], block: {
        tsLastSampleMillis: number;
        systemTsLastSampleMillis: number;
        systemOffsetFirstTime?: number | null;
    }): Array<{
        tsMillis: number;
        systemTsMillis: number;
        systemTsPlotMillis: number;
    }>;
    /**
     * Report up to three independent sub-streams (accel / gyro / mag) so loss is
     * tracked per stream. Each sub-stream's expected rate is its configured rate
     * (ODR for accel/gyro, output rate for mag); loss is measured against that, so
     * the mag's hub-trigger bound — or any rate the firmware/link can't keep up
     * with — surfaces as loss when a configured rate exceeds what's delivered.
     */
    getStreamContributions(samplesWithTime: Array<{
        timestamps?: {
            tsMillis: number;
        };
    }>, sensorId: number): StreamContribution[];
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
    /**
     * 2nd-generation hub PPG: 3 raw MAX86176 LED channel counts (24-bit), in the
     * order [green, IR, red] (LED1=green, LED2=IR, LED3=red per the board's LED
     * driver wiring). The MAX86176 is reached only via the MAX32674 algorithm hub
     * and measures these 3 LEDs on photodiode PD1 (its PD2 copies are not
     * forwarded).
     */
    leds?: [number, number, number];
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
    /**
     * 2nd-gen hub mode: PPG arrives via the MAX32674 hub as a fixed block of 6 raw
     * MAX86176 LED channels (6 x u24), independent of the RED/IR/GREEN/BLUE enable
     * bits. Set from the connected device's hardware generation (see
     * VerisenseClient). When false, the 1st-gen named-channel layout is used.
     */
    hubMode: boolean;
    private readonly adcLsb;
    private readonly adcBitShift;
    adcResolutionIndex: number;
    /** PPG_SR code → base sampling rate in Hz (op byte PPG_MODE_CONFIG2 bits 4:2). */
    private readonly PPG_SR_HZ;
    /** SMP_AVE code → FIFO sample-averaging factor (op byte PPG_FIFO_CONFIG bits 7:5). */
    private readonly SMP_AVE_FACTOR;
    constructor();
    setChannels(channels: Partial<Record<PPGChannel, boolean>>): void;
    setHubMode(enabled: boolean): void;
    setAdcResolutionIndex(i: number): void;
    calibrateValue(uncalValue: number): number;
    /**
     * 2nd-gen hub PPG block: N samples x (3 x u24 LED channels = green, IR, red),
     * no count prefix (sample count derived from the block length, matching the
     * firmware packer).
     */
    private parseHubPayload;
    parsePayload(sensorPayloadBytes: Uint8Array): PPGSample[];
    applyOperationalConfig(op: Uint8Array): void;
}

/** Per-channel raw ambient-light counts (24-bit) plus the derived illuminance
 * (lux) and correlated colour temperature (CCT, Kelvin). Channel order matches
 * the firmware VD6283 AlsResults block: RED, VISIBLE, BLUE, GREEN, IR, CLEAR.
 *
 * The second slot is shared: the VD6283 routes EITHER the visible/clear reading
 * OR the dark (covered-photodiode) baseline onto it, selected by the op-config
 * dark-channel bit. They are mutually exclusive, so exactly one of `VISIBLE` /
 * `DARK` is a number per sample and the other is `null`. */
interface VD6283Sample {
    RED: number;
    /** Visible/clear channel count, or `null` when the dark channel is enabled
     * (the chip then routes the dark baseline onto this slot — see `DARK`). */
    VISIBLE: number | null;
    BLUE: number;
    GREEN: number;
    IR: number;
    CLEAR: number;
    /** Dark/covered-photodiode baseline count, or `null` when the dark channel is
     * disabled (the slot then carries the visible reading — see `VISIBLE`). */
    DARK: number | null;
    /** Illuminance in lux (XYZ Y component; clamped to >= 0). */
    lux: number;
    /** Correlated colour temperature in Kelvin (0 if undefined). */
    cct: number;
}
/**
 * Decoder for the VD6283TX45 ambient light sensor (Verisense sensor id = 7).
 *
 * Data block payload = N samples x 18 bytes (6 channels x 24-bit LE counts).
 * In addition to the raw channel counts, each sample carries the derived lux
 * and CCT, computed from the RED/GREEN/BLUE channels with the configured gain
 * and exposure (ported from firmware App_vd6283tx.c).
 */
declare class SensorVD6283 extends SensorBase {
    static readonly NUM_CHANNELS = 6;
    static readonly BYTES_PER_SAMPLE = 18;
    private exposureUs;
    private gain8p8;
    /** Op-config dark-channel bit (LIGHT_CONFIG bit 1): when set the shared second
     * slot carries the dark baseline (`DARK`) instead of the visible reading. */
    private darkEnabled;
    constructor();
    /** Normalise a raw channel count for the XYZ transform (gain + exposure). */
    private normalizeForXyz;
    /** Compute illuminance (lux) and CCT (K) from RED/GREEN/BLUE counts. */
    private computeLuxCct;
    parsePayload(sensorPayloadBytes: Uint8Array): VD6283Sample[];
    applyOperationalConfig(op: Uint8Array): void;
}

/**
 * One algorithm-hub sample: accel + WHRM algorithm output. The raw MAX86176 PPG
 * is no longer carried here - it streams separately under the PPG sensor id (4),
 * see SensorPPG hub mode.
 */
interface MAX32674Sample {
    accel: {
        raw: [number, number, number];
    };
    /** Heart rate (bpm) and confidence (0-100). */
    hr: number;
    hrConfidence: number;
    /** SpO2 (%) and confidence; 0 until SpO2 mode is enabled. */
    spo2: number;
    spo2Confidence: number;
    activityClass: number;
    scdContactState: number;
}
/**
 * Decoder for the MAX32674 algorithm hub (Verisense sensor id = 8).
 *
 * Data block payload = [sampleCount:1] then sampleCount x 14 bytes:
 *   accel x,y,z : 3 x i16 (6) | hr u16 (2) | hr_conf u8 (1) |
 *   spo2 u16 (2) | spo2_conf u8 (1) | activity u8 (1) | scd_contact u8 (1)
 *
 * Raw PPG is reported separately under the PPG sensor id (4).
 */
declare class SensorMAX32674 extends SensorBase {
    static readonly BYTES_PER_SAMPLE = 14;
    constructor();
    parsePayload(sensorPayloadBytes: Uint8Array): MAX32674Sample[];
    applyOperationalConfig(op: Uint8Array): void;
}

/** One skin-temperature sample. Object = skin temperature, ambient = sensor
 * ambient, both in degrees Celsius. */
interface MLX90632Sample {
    object: {
        raw: number;
        cal: number;
        units: string;
    };
    ambient: {
        raw: number;
        cal: number;
        units: string;
    };
}
/**
 * Decoder for the MLX90632 skin temperature sensor (Verisense sensor id = 9).
 *
 * Data block payload = N samples x 4 bytes: object int16 then ambient int16,
 * each in centi-degrees Celsius (value / 100 = degrees C).
 */
declare class SensorMLX90632 extends SensorBase {
    static readonly BYTES_PER_SAMPLE = 4;
    constructor();
    parsePayload(sensorPayloadBytes: Uint8Array): MLX90632Sample[];
    applyOperationalConfig(op: Uint8Array): void;
}

type TransportKind = 'ble' | 'serial' | null;
type DeviceMode = 'idle' | 'streaming' | 'command' | 'logged';
interface SensorMap {
    1: SensorADC;
    2: SensorLIS2DW12;
    3: SensorLSM6DS3;
    4: SensorPPG;
    6: SensorLSM6DSV;
    7: SensorVD6283;
    8: SensorMAX32674;
    9: SensorMLX90632;
}
interface StreamPacket {
    sensorId: number;
    tick_u24: number;
    decoded: unknown[] | null;
    rawPayload: Uint8Array;
    crcOk: boolean | null;
}
interface LoggedTransferProgressInfo {
    payloadIndex: number;
    bytesWritten: number;
    crcOk: boolean;
}
interface TransferLoggedDataOptions {
    fileHandle?: FileSystemFileHandle | null;
    timeoutMs?: number;
    maxNack?: number;
    maxCrcNack?: number;
    onProgress?: ((info: LoggedTransferProgressInfo) => void) | null;
}
interface TransferLoggedDataResult {
    ok: boolean;
    bytesWritten: number;
    payloadIndex?: number;
    blob?: Blob;
}
interface RunHardwareTestReportOptions {
    timeoutMs?: number;
    marker?: string;
    endMarker?: string;
    completionIdleMs?: number;
    factoryTestType?: number;
    signal?: AbortSignal | null;
    onChunk?: ((chunk: string, aggregate: string) => void) | null;
}
interface VerisenseClientOptions {
    hardwareIdentifier?: string;
    /**
     * Streaming frames carry a 2-byte CRC-16 trailer. When `true` (default) the
     * trailer is used to lock onto frame boundaries — the parser accepts a frame
     * only when its CRC validates, so a flaky link that drops bytes recovers
     * cleanly instead of emitting misaligned packets — and is then stripped before
     * decoding. Set to `false` only for legacy firmware that streams without a CRC
     * trailer (falls back to length-only framing).
     */
    stripStreamCrc?: boolean;
    debug?: boolean;
}
interface BleThroughputTestOptions {
    /** How long the device should saturate the link, in milliseconds. Clamped to [100, 60000]. Default 5000. */
    durationMs?: number;
    /**
     * Finish the measurement once no data has been received for this many
     * milliseconds (the device falls silent when the blast ends). Default 600.
     */
    idleMs?: number;
    /** Overall safety timeout, in milliseconds. Defaults to `durationMs + 5000`. */
    timeoutMs?: number;
    /** Abort the test early. */
    signal?: AbortSignal | null;
    /** Called on every received chunk with the running result so far. */
    onProgress?: ((partial: BleThroughputTestResult) => void) | null;
}
interface BleThroughputTestResult {
    /** Total bytes received from the device during the measurement window. */
    bytesReceived: number;
    /** Number of BLE notification chunks received. */
    packetsReceived: number;
    /** Duration requested of the device, in milliseconds. */
    durationRequestedMs: number;
    /** Measured window from first to last received byte, in milliseconds. */
    elapsedMs: number;
    /** Received goodput in bytes per second. */
    throughputBytesPerSec: number;
    /** Received goodput in kilobytes per second (bytes/sec ÷ 1000). */
    throughputKBps: number;
    /** Received goodput in kilobits per second (bytes/sec × 8 ÷ 1000). */
    throughputKbps: number;
}
type VerisenseConnectRetryReason = 'request-timeout' | 'gatt-disconnected' | 'unexpected-response-property';
interface VerisenseConnectWithRetryOptions {
    device?: BluetoothDevice | null;
    filters?: BluetoothLEScanFilter[];
    optionalServices?: BluetoothServiceUUID[];
    bootstrapTimeoutMs?: number;
    pairingBootstrapTimeoutMs?: number;
    maxRetries?: number;
    retrySettleMs?: number;
    retryOnUnexpectedProperty?: boolean;
    onRetry?: ((info: VerisenseConnectRetryInfo) => void) | null;
}
interface VerisenseConnectRetryInfo {
    attempt: number;
    maxRetries: number;
    bootstrapTimeoutMs: number;
    nextBootstrapTimeoutMs?: number;
    reason: VerisenseConnectRetryReason;
    error: string;
}
interface VerisenseCommandResponse {
    header: number;
    command: AsmCommand;
    property: AsmProperty;
    payload: Uint8Array;
}
type BleLinkAutoOptimizeStopReason = 'stabilized' | 'timeout' | 'aborted' | 'unsupported' | 'not-ble';
interface BleLinkAutoOptimizeOptions {
    pollIntervalMs?: number;
    stableReadCount?: number;
    maxDurationMs?: number;
    settleMode?: 'target-and-stability' | 'stability';
    minSettleTimeMs?: number;
    forceOptimizeAttempts?: number;
    targetConnectionIntervalUnits?: number;
    targetPhy?: number;
    minDataLength?: number;
    signal?: AbortSignal | null;
    onSample?: ((sample: BleLinkAutoOptimizeSample) => void) | null;
}
interface BleLinkAutoOptimizeSample {
    source: 'read' | 'optimize';
    iteration: number;
    stableCount: number;
    parsed: VerisenseBleLinkDebugPayload;
    signature: string;
    optimizedEnough: boolean;
}
interface BleLinkAutoOptimizeResult {
    reason: BleLinkAutoOptimizeStopReason;
    iterations: number;
    optimizeAttempts: number;
    stableCount: number;
    lastParsed: VerisenseBleLinkDebugPayload | null;
    durationMs: number;
}

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
 * - `"streamStats"` — `StreamStatsSnapshot` (throttled ~3 Hz live throughput/loss)
 * - `"opConfig"` — `{ op: Uint8Array }`
 * - `"productionConfig"` — `ProductionConfig`
 * - `"commandPayload"` — `{ payload: Uint8Array }`
 */
declare class VerisenseBleDevice extends BaseShimmerClient {
    private static readonly MAX_FRAME_PAYLOAD_LEN;
    private static readonly MAX_DEBUG_FRAME_PAYLOAD_LEN;
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
    private _suppressDisconnectedEvent;
    private _mode;
    private _rxStreamBuf;
    private _pending;
    private _loggedChain;
    private _sync;
    private _testReportMode;
    private _throughputTestMode;
    private _bootstrapRequestTimeoutOverrideMs;
    private _isSecondGenerationHw;
    private readonly _streamStats;
    private _lastStreamStatsEmitMillis;
    readonly stripStreamCrc: boolean;
    readonly hardwareIdentifier: string;
    readonly sensors: SensorMap;
    operationalConfig: Uint8Array | null;
    productionConfig: Uint8Array | null;
    debugSync: boolean;
    private _syncRxCount;
    private _syncPayloadCount;
    constructor(opts?: VerisenseClientOptions);
    protected _log(...args: unknown[]): void;
    get adc(): SensorADC;
    get accel1(): SensorLIS2DW12;
    get gyroAccel2(): SensorLSM6DS3 | SensorLSM6DSV;
    get gyroAccel2Lsm6ds3(): SensorLSM6DS3;
    get gyroAccel2Lsm6dsv(): SensorLSM6DSV;
    get ppg(): SensorPPG;
    private _setOperationalConfigErasedFallback;
    private _bootstrapConfigsAfterConnect;
    connect(opts?: {
        device?: BluetoothDevice | null;
        filters?: BluetoothLEScanFilter[];
        optionalServices?: BluetoothServiceUUID[];
    }): Promise<boolean>;
    private _cleanupFailedBleConnectAttempt;
    private _retryBootstrapInPlaceWithBudget;
    connectWithRetry(opts?: VerisenseConnectWithRetryOptions): Promise<boolean>;
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
    private _requestByCommand;
    readProperty(property: AsmProperty, timeoutMs?: number): Promise<VerisenseCommandResponse>;
    writeProperty(property: AsmProperty, payloadBytes?: number[] | Uint8Array, timeoutMs?: number): Promise<VerisenseCommandResponse>;
    request(opcode: number, payloadBytes?: number[] | Uint8Array, timeoutMs?: number): Promise<{
        payload: Uint8Array;
    }>;
    readStatus(): Promise<{
        payload: Uint8Array;
    }>;
    readStatusParsed(): Promise<VerisenseStatusPayload>;
    readStatus2(): Promise<{
        payload: Uint8Array;
    }>;
    readStatus2Parsed(): Promise<VerisenseStatusPayload>;
    readData(): Promise<{
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
    readTimeUnixSeconds(): Promise<number>;
    readPendingEvents(): Promise<{
        payload: Uint8Array;
    }>;
    readPendingEventsParsed(): Promise<AsmProperty[]>;
    writeProductionConfig(bytes: Uint8Array | number[]): Promise<void>;
    writeOperationalConfig(bytes: Uint8Array | number[]): Promise<void>;
    writeTime(rtc7: Uint8Array | number[]): Promise<void>;
    writeTimeUnixSeconds(unixSeconds: number): Promise<void>;
    /**
     * Request the Verisense firmware to expose the Nordic Secure DFU service.
     *
     * Writes the ASM `DFU_MODE` property. The firmware treats this as a request
     * to enable the buttonless DFU service but does NOT reboot or expose the
     * service immediately — it enables it on the next BLE disconnect. The host
     * must therefore disconnect and reconnect before the Nordic DFU service (and
     * {@link rebootToDfuBootloader}) become available on the connection.
     */
    enableDfuServiceOnNextDisconnect(): Promise<void>;
    /**
     * Reboot the device straight into the Nordic Secure DFU bootloader using the
     * buttonless DFU service.
     *
     * Requires the Nordic DFU service to already be active on the current BLE
     * connection — call {@link enableDfuServiceOnNextDisconnect}, then disconnect
     * and reconnect first. Writes the "Enter Bootloader" op-code (0x01) to the
     * buttonless DFU control-point characteristic; the device acknowledges via an
     * indication, then disconnects and resets into the bootloader.
     *
     * @param options.waitForDisconnect      Resolve only once the device drops the
     *   link (i.e. has begun rebooting). Default `true`.
     * @param options.disconnectAfterCommand Force a local GATT disconnect if the
     *   device has not dropped the link itself. Default `true`.
     * @param options.timeoutMs              Max time to wait for the device to
     *   disconnect after the command. Default `10000`.
     */
    rebootToDfuBootloader(options?: {
        waitForDisconnect?: boolean;
        disconnectAfterCommand?: boolean;
        timeoutMs?: number;
    }): Promise<void>;
    /**
     * Resolve when the BLE link drops (`gattserverdisconnected`), or after
     * `timeoutMs`. Resolves `true` if the device disconnected, `false` on timeout.
     */
    private _waitForGattDisconnect;
    runTestMode(testPayload: Uint8Array | number[]): Promise<void>;
    runHardwareTest(testId: TestModeId, hwMajor: number, hwMinor?: number, hwInternal?: number): Promise<void>;
    /**
     * Ask the device to stop/exit any running test, including an in-progress
     * hardware test report (TEST_MODE "exit", id 0x00). The firmware acts on this
     * from interrupt context, so it aborts the blocking report promptly instead of
     * running it to completion against a connection no one is reading. Best-effort
     * and safe to call when no test is running.
     */
    stopTestMode(hwMajor?: number, hwMinor?: number, hwInternal?: number): Promise<void>;
    runHardwareTestReport(hwMajor: number, hwMinor?: number, hwInternal?: number, opts?: RunHardwareTestReportOptions): Promise<string>;
    private _buildDebugPayload;
    private _debugIndexArgs;
    private _waitForDebugResponse;
    readDebugCommand(debugId: DebugCommandId, args?: Uint8Array | number[], timeoutMs?: number): Promise<{
        payload: Uint8Array;
    }>;
    sendDebugCommand(debugId: DebugCommandId, args?: Uint8Array | number[], timeoutMs?: number): Promise<{
        payload: Uint8Array;
    }>;
    /**
     * Stream a MAX32674C algorithm-hub firmware image (.msbl) to the device and
     * flash it into the hub via the Maxim bootloader. This is a one-time factory
     * operation: it blocks the device for ~1-2 minutes while the hub flash is
     * erased and each page is written. Only SR68 Pulse+ hardware (the only board
     * carrying the hub) accepts it — other hardware NACKs the BEGIN stage.
     *
     * @param msbl       raw .msbl file bytes
     * @param onProgress optional progress callback (pagesDone, totalPages)
     * @returns the hub application firmware version string read back after flashing
     */
    uploadHubFirmware(msbl: Uint8Array | number[], onProgress?: (pagesDone: number, totalPages: number) => void): Promise<string>;
    /** Build a debug payload `[HUB_FW_UPLOAD, stage, ...stageArgs]`. */
    private _buildHubUploadPayload;
    /** Send one 8208-byte page as in-order <=64-byte chunks; await ACK_NEXT_STAGE. */
    private _sendHubPage;
    /** Best-effort abort: tell the device to reset the hub back to application mode. */
    private _abortHubUpload;
    readFlashLookupTable(index?: number, timeoutMs?: number): Promise<{
        payload: Uint8Array;
    }>;
    readRealWorldClockScheduler(index?: number): Promise<{
        payload: Uint8Array;
    }>;
    readRealWorldClockSchedulerParsed(index?: number): Promise<VerisenseSchedulerDebugPayload>;
    loadTestLookupTable(index?: number): Promise<{
        payload: Uint8Array;
    }>;
    checkPayloadCrcErrors(index?: number): Promise<{
        payload: Uint8Array;
    }>;
    checkPayloadCrcErrorsParsed(index?: number): Promise<number[]>;
    readEventLog(index?: number): Promise<{
        payload: Uint8Array;
    }>;
    readEventLogParsed(index?: number): Promise<VerisenseEventLogEntry[]>;
    readRecordBufferDetails(index?: number): Promise<{
        payload: Uint8Array;
    }>;
    readRecordBufferDetailsParsed(index?: number): Promise<VerisenseRecordBufferDetails[]>;
    eraseOperationalConfig(): Promise<void>;
    eraseProductionConfig(): Promise<void>;
    clearPendingEvents(): Promise<void>;
    eraseAllLoggedData(timeoutMs?: number): Promise<void>;
    /**
     * Low-level: ask the device to saturate the BLE link with dummy data for
     * `durationMs` milliseconds (debug command 0x0B). The device ACKs immediately
     * and then blasts a fixed 244-byte buffer as fast as the link will accept it.
     *
     * This only starts the blast; it does not measure anything. Prefer
     * {@link runBleThroughputTest}, which sends this command and measures the
     * throughput actually received at the host.
     *
     * @param durationMs Blast duration in milliseconds (clamped to the protocol's 0..65535 range).
     */
    testDataTransferLoop(durationMs: number): Promise<void>;
    /**
     * Measure the maximum BLE link throughput, independent of sensor
     * configuration. Asks the device to blast dummy data for `durationMs`
     * (see {@link testDataTransferLoop}) and measures the goodput actually
     * received at the host.
     *
     * The reported rate reflects device→host (notification) throughput and is
     * governed by the negotiated PHY, connection interval, MTU and packets per
     * connection interval — i.e. the real link, not any sensor's sample rate.
     *
     * The measurement finishes when the device falls silent for `idleMs` after
     * the blast (or when the overall safety timeout elapses).
     *
     * @returns received byte/packet counts and the computed throughput.
     */
    runBleThroughputTest(opts?: BleThroughputTestOptions): Promise<BleThroughputTestResult>;
    ledTest(ledIndex: number): Promise<void>;
    max86xxxLedTest(start: boolean): Promise<void>;
    startPowerProfilerTest(): Promise<void>;
    requestSystemReset(): Promise<void>;
    startIcPowerConsumptionTest(loopCount: number, stageIntervalMs: number): Promise<void>;
    deleteAllBonds(): Promise<void>;
    private _assertBleLinkDebugSupported;
    readBleLinkParams(): Promise<{
        payload: Uint8Array;
    }>;
    readBleLinkParamsParsed(): Promise<VerisenseBleLinkDebugPayload>;
    optimizeBleLink(): Promise<{
        payload: Uint8Array;
    }>;
    optimizeBleLinkParsed(): Promise<VerisenseBleLinkDebugPayload>;
    private _bleLinkSignature;
    private _bleLinkOptimizedEnough;
    private _isAbortError;
    private _waitWithAbort;
    autoOptimizeBleLink(opts?: BleLinkAutoOptimizeOptions): Promise<BleLinkAutoOptimizeResult>;
    setStreamingMode(enabled: boolean): Promise<void>;
    disconnectRequest(): Promise<{
        payload: Uint8Array;
    }>;
    getOpConfig(): Promise<Uint8Array>;
    private _isErasedBlob;
    private _isZeroBlob;
    private _isUninitializedBlob;
    readProductionConfigFromDevice(): Promise<ProductionConfig>;
    readOpConfigFromDevice(): Promise<Uint8Array>;
    writeOpConfig(opConfigBytes: Uint8Array | number[]): Promise<void>;
    /** Per-device calibration last read from the device, or null. */
    private _calibration;
    /** The parsed calibration set last read via {@link readCalibrationParsed}, or null. */
    getCalibration(): CalibrationSet | null;
    /**
     * Read the raw calibration blob from the device (CMD_AR_CFG_CALIB). The whole
     * blob (~1 KB) arrives in one response, reassembled across BLE/USB fragments.
     * Requires FW v2.0.4+; older firmware NACKs or times out.
     */
    readCalibration(timeoutMs?: number): Promise<Uint8Array>;
    /**
     * Read + parse the calibration set, cache it, and push it into the IMU
     * decoders so subsequent samples calibrate from per-device values. Call before
     * a logged-data transfer and/or after connect (no-op on FW that lacks it —
     * the call rejects and the decoders keep their full-scale fallback).
     */
    readCalibrationParsed(): Promise<CalibrationSet>;
    /**
     * Write a calibration blob to the device (CMD_AR_CFG_CALIB), chunked in
     * <=128-byte pieces as [offset_lo, offset_hi, ...chunk]. The device reassembles
     * and commits on the final chunk. Requires FW v2.0.4+.
     */
    writeCalibration(blob: Uint8Array, chunkSize?: number): Promise<void>;
    getSensor(name: string | number): SensorBase | null;
    private _abortSync;
    private _finishSync;
    private _handleLoggedPayload;
    private _resetAssembler;
    private _appendStreamBuf;
    private _clearSyncRxBuffers;
    private _isPlausibleHeaderByte;
    private _isPlausibleFrameStart;
    private _resolvePendingCommand;
    private _feedStreamBytes;
    private _handleStreamingPayload;
    /** Snapshot of live stream statistics (throughput / packet-loss). */
    getStreamStats(): StreamStatsSnapshot;
}

/**
 * Verisense calibration defaults, hardware/firmware gating, and timestamp helpers.
 *
 * The byte-level codec lives in `calibration.ts`; this module is the host-side
 * single source of truth for the *default* calibration (the mirror of the
 * firmware `AsmCalib_seedDefaults`) plus the small amount of domain logic the UI
 * used to carry: which calibration blocks a board has, the minimum firmware that
 * supports `CMD_AR_CFG_CALIB`, and the 8-byte timestamp encode/decode.
 */

/** Minimum firmware that implements the `CMD_AR_CFG_CALIB` (0x0D) command. */
declare const VERISENSE_CALIBRATION_MIN_FW: VerisenseFirmwareVersion;
/** Whether the given firmware version supports the calibration command. */
declare function supportsVerisenseCalibration(fw: Partial<VerisenseFirmwareVersion> | null | undefined): boolean;
/** Encode Unix-epoch seconds into the 8-byte little-endian calibration `ts`. */
declare function unixSecondsToCalibTsBytes(unixSeconds: number): Uint8Array;
/** Decode the 8-byte little-endian calibration `ts` back to Unix-epoch seconds
 * (0 = default/seeded). */
declare function calibTsBytesToUnixSeconds(ts: ArrayLike<number> | null | undefined): number;
interface VerisenseCalibrationRange {
    /** Full-scale index as stored in the block `range` byte (low 6 bits). */
    code: number;
    /** Display label, e.g. "±2g" / "±250dps". */
    label: string;
    /** Default sensitivity `K` (LSB per physical unit) for this range. */
    sens: number;
}
interface VerisenseCalibrationSensor {
    /** Calibration-domain sensor id (see {@link CalibSensorId}). */
    id: number;
    /** Display label, e.g. "Accelerometer (LSM6DSV)". */
    label: string;
    /** Physical unit of the calibrated output. */
    unit: string;
    /** Default sensor->ASM alignment `R` (row-major 3x3, applied as
     * physical = align · sensor). See VERISENSE_CALIBRATION.md §4. */
    align: number[];
    ranges: VerisenseCalibrationRange[];
}
/**
 * The calibration sensor catalog for a board: the 1st-generation set
 * (LIS2DW12 + LSM6DS3) for 1st-gen hardware, otherwise the 2nd-generation set
 * (LSM6DSV + LIS2DW12 + LIS2MDL). Unknown/offline (no revision) defaults to
 * 2nd-gen. Note id 39 (LIS2DW12) appears in both with a generation-specific
 * alignment, so the catalog must be resolved per hardware revision.
 */
declare function getVerisenseCalibrationSensors(revHwMajor?: number, revHwMinor?: number): VerisenseCalibrationSensor[];
/**
 * Build the default calibration set for a board (bias=0, default sensitivity,
 * default alignment, ts=0). Host-side mirror of `AsmCalib_seedDefaults`; useful
 * for "reset to defaults" and round-trip tests.
 */
declare function buildDefaultVerisenseCalibrationSet(opts: {
    hwVerMajor: number;
    hwVerMinor: number;
    fwVerMajor: number;
    fwVerMinor: number;
    fwVerPatch: number;
}): CalibrationSetInput;
type VerisenseCalibrationAvailability = 'enabled' | 'disabled' | 'hidden';
/**
 * Map each calibration-domain sensor id to whether it is present and usable on
 * the connected hardware:
 *  - `enabled`  — present and recorded from; show + allow edit.
 *  - `disabled` — physically present but not recorded from (LIS2DW12 routed to
 *    the algorithm hub on 2nd-gen SR68); show greyed.
 *  - `hidden`   — not fitted on this hardware.
 *
 * `support` is the result of `getVerisenseHardwareSensorSupport`. A null/absent
 * support object (offline / unknown hardware) reports every sensor `enabled`.
 */
declare function getVerisenseCalibrationSensorAvailability(support: VerisenseHardwareSensorSupport | null | undefined): Record<number, VerisenseCalibrationAvailability>;

export { ASM_COMMAND, ASM_PROPERTY, BLE_LINK_MIN_FW, BaseShimmerClient, CHANNEL_FORMATS, CalibQuality, CalibSensorId, DEBUG_COMMAND_ID, GSR_NAME, NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS, NORDIC_DFU_BUTTONLESS_WITH_BONDS, NORDIC_DFU_OP_ENTER_BOOTLOADER, NORDIC_DFU_SERVICE, NUS_RX, NUS_SERVICE, NUS_TX, OPCODES, OP_IDX, ObjectCluster, SC_CALIB_FORMAT_VERSION, SC_CAL_QUALITY_MASK, SC_CAL_QUALITY_SHIFT, SC_CAL_RANGE_MASK, SC_DATA_LEN_IMU, SC_GLOBAL_HEADER_BYTES, SHIMMER3R_DEFAULTS, STREAM_MODE, SensorADC, SensorBase, SensorBitmapShimmer3, SensorLIS2DW12, SensorLSM6DS3, SensorLSM6DSV, SensorMAX32674, SensorMLX90632, SensorPPG, SensorVD6283, Shimmer3RClient, StreamStatsTracker, TEST_MODE_ID, TIMESTAMP_FIELD, VERISENSE_CALIBRATION_MIN_FW, VERISENSE_HW_MAJOR_FRIENDLY_NAMES, VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID, VERISENSE_OPERATIONAL_FIELD_GROUPS, VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR, VERISENSE_OPERATIONAL_FIELD_SCHEMA, VERISENSE_OP_CONFIG_BYTE_SIZE, VERISENSE_SENSOR_ENABLE_FIELDS, VERISENSE_STREAM_SENSOR_LABELS, VerisenseBleDevice, applyDuplicateSuffix, applyImuCalibration, asmRtcBytesToUnixSeconds, asmRtcMinutesBytesToUnixSeconds, buildDefaultVerisenseCalibrationSet, buildHeader, buildMessage, buildParsedCsvFileName, buildProductionConfigPayload, buildUploadBinaryFileName, calibTsBytesToUnixSeconds, calibrateGsrDataToResistanceFromAmplifierEq, calibrateShimmer3RAdcChannel, calibrateU12AdcValue, calibrationBlobCrc, compareVerisenseFirmwareVersion, computeVerisensePairingPin, crc16_ccitt_false, createBlankVerisenseOperationalConfig, describeVerisenseChargerStatus, enforceVerisenseCommsChannelInterlock, evaluateParsedFileSplit, formatByteArrayAsHex, formatByteAsHex, formatPendingEventProperties, formatSchedulerPayloadForLog, formatStatusPayloadForLog, formatVerisenseChargerStatus, formatVerisenseFirmwareVersion, formatVerisenseHardwareRevision, formatVerisenseUnixAndHuman, getFirstPayloadIndex, getOversamplingRatioADS1292R, getVerisenseCalibrationSensorAvailability, getVerisenseCalibrationSensors, getVerisenseHardwareCapabilities, getVerisenseHardwareFriendlyName, getVerisenseHardwareRevision, getVerisenseHardwareSensorSupport, getVerisenseStreamSensorLabel, getVerisenseStreamingBatteryVoltageMultiplier, getVerisenseSupportedOperationalFieldGroupIds, inferVerisenseChargerChipFamily, inferVerisenseLookupBankCount, isAckCommand, isNackCommand, isUniformByteArray, isVerisenseLightDarkChannelEnabled, isVerisenseSecondGenerationHardware, nextAvailableDuplicateFileName, normalizeBytePayload, normalizeOperationalConfig, nudgeGsrResistance, parseBleLinkDebugPayload, parseCalibrationBlob, parseEventLogPayload, parseHeader, parseHexByteString, parseLookupTablePayload, parseMessage, parsePayloadCrcErrorBankIndexes, parsePendingEvents, parseProductionConfigPayload, parseProductionConfigPayloadFull, parseRecordBufferDetailsPayload, parseSchedulerDebugPayload, parseStatusPayload, readVerisenseOperationalFieldValue, serializeCalibrationBlob, setVerisenseOperationalBitRange, supportsVerisenseCalibration, supportsVerisenseMagnetometer, unixSecondsToAsmRtcBytes, unixSecondsToCalibTsBytes, writeVerisenseOperationalFieldValue };
export type { ADCBatterySample, ADCGSRSample, ADCPayloadSample, AsmCommand, AsmProperty, BleLinkAutoOptimizeOptions, BleLinkAutoOptimizeResult, BleLinkAutoOptimizeSample, BleLinkAutoOptimizeStopReason, BleThroughputTestOptions, BleThroughputTestResult, CalibrationBlock, CalibrationBlockInput, CalibrationSet, CalibrationSetInput, ChannelFormat, DebugCommandId, DeviceMode, EvaluateParsedSplitInput, FieldKind, IShimmerClient, ImuCalibration, InertialCalibration, LIS2DW12Sample, LSM6DS3Sample, LSM6DSVSample, MAX32674Sample, MLX90632Sample, OpIdx, Opcode, PPGChannelSample, PPGSample, ParsedSplitReason, PendingEventPropertyLabel, ProductionConfig, ProductionConfigBuildOptions, ProductionConfigFull, RunHardwareTestReportOptions, SensorBitmapShimmer3Key, SensorField, SensorMap, SensorStreamStats, Shimmer3RClientOptions, ShimmerClientOptions, StreamContribution, StreamLossStats, StreamPacket, StreamStatsSnapshot, TestModeId, TimestampFmt, TransferLoggedDataOptions, TransferLoggedDataResult, TransportKind, VD6283Sample, VerisenseBleLinkDebugPayload, VerisenseCalibrationAvailability, VerisenseCalibrationRange, VerisenseCalibrationSensor, VerisenseChargerChipFamily, VerisenseClientOptions, VerisenseCommandResponse, VerisenseConnectRetryInfo, VerisenseConnectWithRetryOptions, VerisenseEventLogEntry, VerisenseFirmwareVersion, VerisenseHardwareCapabilities, VerisenseHardwareRevision, VerisenseHardwareRevisionSource, VerisenseHardwareSensorSupport, VerisenseLookupTableEntry, VerisenseLookupTablePayload, VerisenseMessage, VerisenseOperationalField, VerisenseOperationalFieldDefinition, VerisenseOperationalFieldGroupDefinition, VerisenseOperationalFieldKind, VerisenseOperationalFieldOption, VerisenseOperationalSensorEnableField, VerisenseRecordBufferDetails, VerisenseSchedulerDebugPayload, VerisenseSchedulerDebugPayloadForLog, VerisenseStatusPayload, VerisenseStatusPayloadForLog, VerisenseUnixAndHumanTimestamp };
