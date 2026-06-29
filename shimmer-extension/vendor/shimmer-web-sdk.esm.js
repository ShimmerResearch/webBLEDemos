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
/**
 * True if `bytes` is non-empty and every byte equals `value` (0–255). Useful for
 * detecting uniform blobs such as erased flash (all `0xFF`) or zeroed regions.
 * Returns false for empty or nullish input.
 */
function isUniformByteArray(bytes, value) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    if (!u8.length)
        return false;
    const expected = value & 0xff;
    for (let i = 0; i < u8.length; i++) {
        if (u8[i] !== expected)
            return false;
    }
    return true;
}

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
 * Drop ring events older than `cutoff` (by receive time), but always keep the
 * last 2 so the rate/throughput still reflect the most recent delivery even when
 * packets arrive less often than the window (big FIFO reads, slow sensors).
 */
function pruneRing(ring, cutoff) {
    if (ring.length <= 2)
        return ring;
    let i = 0;
    while (i < ring.length - 2 && ring[i].t < cutoff)
        i++;
    return i > 0 ? ring.slice(i) : ring;
}
/**
 * Accumulates live statistics for one streaming session. Call {@link reset} on
 * (re)start, {@link recordPacket} for every decoded packet, {@link recordCrcFail}
 * for CRC failures, and {@link snapshot} to read the current numbers.
 */
class StreamStatsTracker {
    constructor(opts) {
        this.sessionStartMillis = null;
        this.resyncDroppedBytes = 0;
        this.sensors = new Map();
        this.streams = new Map();
        this.windowMillis = opts?.windowMillis ?? 2000;
    }
    /** Clear all state. Call when streaming (re)starts. */
    reset() {
        this.sessionStartMillis = null;
        this.resyncDroppedBytes = 0;
        this.sensors.clear();
        this.streams.clear();
    }
    getSensor(sensorId) {
        let s = this.sensors.get(sensorId);
        if (!s) {
            s = { sensorId, packets: 0, bytes: 0, crcFails: 0, throughputRing: [] };
            this.sensors.set(sensorId, s);
        }
        return s;
    }
    getStream(key, sensorId, label) {
        let st = this.streams.get(key);
        if (!st) {
            st = {
                key,
                sensorId,
                label,
                samplingRateHz: null,
                samples: 0,
                expectedSamples: 0,
                lostSamples: 0,
                lastSampleMillis: null,
                started: false,
                rateRing: [],
            };
            this.streams.set(key, st);
        }
        return st;
    }
    /** Record one received (and decoded) streaming packet. */
    recordPacket(p) {
        if (this.sessionStartMillis == null)
            this.sessionStartMillis = p.recvMillis;
        const sensor = this.getSensor(p.sensorId);
        sensor.packets += 1;
        sensor.bytes += p.byteLength;
        sensor.throughputRing.push({ t: p.recvMillis, bytes: p.byteLength });
        // CRC failures, when a device reports them, are counted via recordCrcFail()
        // rather than here, to avoid double-counting a packet also passed in here.
        for (const c of p.contributions) {
            const st = this.getStream(c.key, p.sensorId, c.label);
            st.label = c.label;
            st.samplingRateHz = c.samplingRateHz;
            st.samples += c.sampleCount;
            st.rateRing.push({
                t: p.recvMillis,
                n: c.sampleCount,
                devFirst: c.firstSampleMillis,
                dev: c.lastSampleMillis,
            });
            const prev = st.lastSampleMillis;
            if (!st.started ||
                !c.samplingRateHz ||
                c.samplingRateHz <= 0 ||
                prev == null ||
                c.lastSampleMillis == null) {
                // No measurable gap yet -> assume every sample we got was expected.
                st.expectedSamples += c.sampleCount;
            }
            else {
                const interval = 1000 / c.samplingRateHz;
                const delta = c.lastSampleMillis - prev;
                if (delta > 0) {
                    const expected = Math.round(delta / interval);
                    st.expectedSamples += expected;
                    st.lostSamples += Math.max(0, expected - c.sampleCount);
                }
                // delta <= 0 (reorder / duplicate): ignore for loss; still counted in samples.
            }
            st.started = true;
            if (c.lastSampleMillis != null)
                st.lastSampleMillis = c.lastSampleMillis;
        }
    }
    /** Record a CRC failure for a (possibly unknown) sensor. */
    recordCrcFail(sensorId) {
        const id = sensorId ?? -1;
        this.getSensor(id).crcFails += 1;
    }
    /**
     * Record bytes discarded while re-synchronising the frame parser after the
     * stream lost alignment (typically a flaky link dropping bytes mid-stream).
     */
    recordResyncDrop(byteCount = 1) {
        if (byteCount > 0)
            this.resyncDroppedBytes += byteCount;
    }
    prune(nowMillis) {
        const cutoff = nowMillis - this.windowMillis;
        for (const s of this.sensors.values()) {
            s.throughputRing = pruneRing(s.throughputRing, cutoff);
        }
        for (const st of this.streams.values()) {
            st.rateRing = pruneRing(st.rateRing, cutoff);
        }
    }
    /**
     * Cadence-relative stall test: a stream is "stalled" only if its newest packet
     * is older than a multiple of its own observed packet interval (floored at the
     * window). This keeps a stalled stream reading 0 while NOT zeroing a healthy
     * stream that simply delivers less often than the window (big FIFO reads, slow
     * sensors). Events carry a receive time `t`.
     */
    isStalled(ring, nowMillis) {
        if (ring.length === 0)
            return true;
        const newest = ring[ring.length - 1].t;
        const avgIntervalMillis = ring.length >= 2 ? (newest - ring[0].t) / (ring.length - 1) : this.windowMillis;
        const stallMillis = Math.max(this.windowMillis, 3 * avgIntervalMillis);
        return nowMillis - newest > stallMillis;
    }
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
    windowRateHz(ring, nowMillis) {
        if (this.isStalled(ring, nowMillis))
            return 0;
        let totalN = 0;
        let oldestFirst = Infinity;
        let newestLast = -Infinity;
        for (const e of ring) {
            totalN += e.n;
            if (e.devFirst != null && e.devFirst < oldestFirst)
                oldestFirst = e.devFirst;
            if (e.dev != null && e.dev > newestLast)
                newestLast = e.dev;
        }
        if (totalN <= 0)
            return 0;
        // N samples span N-1 intervals over the device-time window, so the rate is
        // (N-1) / span. A single packet uses its own first->last sample span; a
        // stream with no usable device span (1 sample / no timestamps) reads 0.
        const spanMillis = newestLast - oldestFirst;
        if (spanMillis > 0 && totalN > 1)
            return ((totalN - 1) / spanMillis) * 1000;
        return 0;
    }
    /**
     * Windowed throughput (bytes/sec) and packet rate over the *actual* receive
     * span of the retained events, robust to packets that arrive less often than
     * the window. Bytes/packets are counted after the oldest event (the span's
     * start point). Returns 0 if the stream is stalled (see {@link isStalled}).
     */
    windowThroughput(ring, nowMillis) {
        if (ring.length < 2 || this.isStalled(ring, nowMillis))
            return { bps: 0, packetRateHz: 0 };
        const spanMillis = ring[ring.length - 1].t - ring[0].t;
        if (spanMillis <= 0)
            return { bps: 0, packetRateHz: 0 };
        let bytesAfterOldest = 0;
        for (let i = 1; i < ring.length; i++)
            bytesAfterOldest += ring[i].bytes;
        const spanSec = spanMillis / 1000;
        return { bps: bytesAfterOldest / spanSec, packetRateHz: (ring.length - 1) / spanSec };
    }
    /** Produce a snapshot of all statistics as of `nowMillis`. */
    snapshot(nowMillis) {
        this.prune(nowMillis);
        const perSensor = {};
        for (const s of this.sensors.values()) {
            const tp = this.windowThroughput(s.throughputRing, nowMillis);
            perSensor[s.sensorId] = {
                sensorId: s.sensorId,
                packets: s.packets,
                bytes: s.bytes,
                crcFails: s.crcFails,
                windowThroughputBps: tp.bps,
                windowPacketRateHz: tp.packetRateHz,
                streams: [],
            };
        }
        let totalPackets = 0;
        let totalBytes = 0;
        let totalCrcFails = 0;
        let totalSamples = 0;
        let totalExpected = 0;
        let totalLost = 0;
        let throughputBps = 0;
        for (const sid of Object.keys(perSensor)) {
            const s = perSensor[Number(sid)];
            totalPackets += s.packets;
            totalBytes += s.bytes;
            totalCrcFails += s.crcFails;
            throughputBps += s.windowThroughputBps;
        }
        const streamList = [...this.streams.values()].sort((a, b) => a.key.localeCompare(b.key));
        for (const st of streamList) {
            const lossPct = st.expectedSamples > 0 ? (st.lostSamples / st.expectedSamples) * 100 : 0;
            const row = {
                key: st.key,
                sensorId: st.sensorId,
                label: st.label,
                samplingRateHz: st.samplingRateHz,
                samples: st.samples,
                expectedSamples: st.expectedSamples,
                lostSamples: st.lostSamples,
                lossPct,
                windowSampleRateHz: this.windowRateHz(st.rateRing, nowMillis),
                lastSampleMillis: st.lastSampleMillis,
            };
            totalSamples += st.samples;
            totalExpected += st.expectedSamples;
            totalLost += st.lostSamples;
            // A stream's sensor row may not exist if recordPacket was never called for
            // it (only possible via a stray CRC-fail id); guard defensively.
            const sensorRow = perSensor[st.sensorId];
            if (sensorRow)
                sensorRow.streams.push(row);
        }
        return {
            durationMillis: this.sessionStartMillis != null ? Math.max(0, nowMillis - this.sessionStartMillis) : 0,
            totalPackets,
            totalSamples,
            totalBytes,
            totalCrcFails,
            resyncDroppedBytes: this.resyncDroppedBytes,
            throughputBps,
            lossPct: totalExpected > 0 ? (totalLost / totalExpected) * 100 : 0,
            perSensor,
        };
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
function u16le$2(b, o) {
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
        const adcRaw = u16le$2(u8, base + 0);
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
                    ts1 = tsBytes === 2 ? u16le$2(buf, 1) : u24le$1(buf, 1);
                    ts2 = tsBytes === 2 ? u16le$2(buf, frameBytes + 1) : u24le$1(buf, frameBytes + 1);
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
                    const ts = tsBytes === 2 ? u16le$2(frame, cursor) : u24le$1(frame, cursor);
                    cursor += tsBytes;
                    oc.add('TIMESTAMP', ts, 'ticks', 'raw');
                    for (const f of sch.fields) {
                        if (cursor + f.sizeBytes > frame.length) {
                            throw new Error(`short frame: need ${f.sizeBytes} @${cursor}, have ${frame.length}`);
                        }
                        let v;
                        switch (f.fmt) {
                            case 'i16':
                                v = f.endian === 'be' ? sign16(u16be(frame, cursor)) : sign16(u16le$2(frame, cursor));
                                break;
                            case 'u16':
                                v = f.endian === 'be' ? u16be(frame, cursor) : u16le$2(frame, cursor);
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
                                v = u16le$2(frame, cursor);
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
/** Nordic Secure DFU service UUID (buttonless DFU). */
const NORDIC_DFU_SERVICE = '0000fe59-0000-1000-8000-00805f9b34fb';
/** Nordic buttonless DFU control-point characteristic (without bond sharing). */
const NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS = '8ec90003-f315-4f60-9fb8-838830daea50';
/** Nordic buttonless DFU control-point characteristic (with bond sharing). */
const NORDIC_DFU_BUTTONLESS_WITH_BONDS = '8ec90004-f315-4f60-9fb8-838830daea50';
/** Buttonless DFU control-point op-code that reboots the device into the bootloader. */
const NORDIC_DFU_OP_ENTER_BOOTLOADER = 0x01;
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
    CALIBRATION: 0x0d,
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
    BLE_LINK_PARAMS_READ: 0x16,
    BLE_LINK_OPTIMIZE: 0x17,
    /** Streamed MAX32674C algorithm-hub firmware (.msbl) upload (factory). The
     * byte after this id is a HUB_FW_UPLOAD_STAGE sub-stage. */
    HUB_FW_UPLOAD: 0x18,
});
/** Sub-stages for the streamed MAX32674C hub firmware upload, carried in the
 * payload byte immediately after DEBUG_COMMAND_ID.HUB_FW_UPLOAD. */
const HUB_FW_UPLOAD_STAGE = Object.freeze({
    BEGIN: 0x00,
    PAGE_CHUNK: 0x01,
    END: 0x02,
    ABORT: 0x03,
});
/** MAX32674C .msbl image geometry (mirrors firmware flashUpdater.h). A page on
 * the wire is PAGE_PAYLOAD + PAGE_CRC bytes; HEADER_SIZE bytes precede page 0. */
const MSBL = Object.freeze({
    HEADER_SIZE: 0x4c,
    OFF_NUMPAGES: 0x44,
    PAGE_PAYLOAD: 8192,
    PAGE_CRC: 16,
    PAGE_FILE_BYTES: 8208,
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
    LSM6DSV_CFG_0: 18,
    LSM6DSV_CFG_1: 19,
    LSM6DSV_CFG_2: 20,
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
    // v9 second-generation sensor settings (only present when op[OP_CONFIG_VERSION] >= 9)
    OP_CONFIG_VERSION: 9,
    LIGHT_GAIN_INDEX: 72,
    LIGHT_EXPOSURE_INDEX: 73,
    LIGHT_CONFIG: 74,
    LIGHT_SAMPLE_RATE_INDEX: 75,
    SKIN_TEMP_CONFIG: 76,
    SKIN_TEMP_SAMPLE_RATE_INDEX: 77,
    ALGO_OP_MODE: 78,
    ALGO_REPORT_MODE_RATE: 79,
    ALGO_CONTROL: 80,
    ALGO_INITIAL_HR: 81,
    LED_AUTO_BRIGHTNESS_CFG: 82,
    LED_MAX_BRIGHTNESS: 83,
    LED_LUX_THRESHOLD: 84,
    // MAX32674 algorithm-suite subject parameters (bytes 86-91)
    PERSON_HEIGHT_CM: 86, // u16 LE, cm
    PERSON_WEIGHT_KG: 88, // u16 LE, kg
    PERSON_AGE: 90, // u8, years
    PERSON_GENDER: 91, // u8, 0=Male, 1=Female
});
/** Operational config layout version stored at OP_IDX.OP_CONFIG_VERSION (byte 9).
 * 0 = legacy 72-byte layout; 9 = v9 layout with second-generation sensor settings. */
const OP_CONFIG_VERSION_V9 = 9;
/** Minimum firmware version that supports the BLE-link debug commands
 * (read/optimize connection parameters). */
const BLE_LINK_MIN_FW = Object.freeze({
    major: 1,
    minor: 4,
    internal: 23,
});
/** Human-readable labels for Verisense stream-packet sensor IDs. Each ID maps to
 * the device part(s) that produce that stream (some streams interleave several
 * physical sensors, e.g. id 6 = LSM6DSV accel + gyro + mag). */
const VERISENSE_STREAM_SENSOR_LABELS = Object.freeze({
    1: 'ADC (GSR / Battery)',
    2: 'Accel 1 (LIS2DW12)',
    3: 'Accel 2 + Gyro (LSM6DS3)',
    4: 'PPG (MAX86xxx)',
    6: 'Accel 2 + Gyro + Mag (LSM6DSV + LIS2MDL)',
    7: 'Ambient Light (VD6283)',
    8: 'Algo Hub (MAX32674 — HR + raw PPG)',
    9: 'Skin Temperature (MLX90632)',
});

/** Read a 16-bit unsigned integer, little-endian. */
function u16le$1(b0, b1) {
    return (b1 << 8) | b0;
}
/** Format a single byte as an uppercase `0xNN` string. */
function formatByteAsHex(v) {
    return `0x${(v & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}
/** Format bytes as `[0xAA, 0xBB, ...]`. */
function formatByteArrayAsHex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    return `[${Array.from(u8, (b) => formatByteAsHex(Number(b))).join(', ')}]`;
}
/** Parse text containing hex bytes like `0x5A, 00 12` into a Uint8Array. */
function parseHexByteString(text) {
    const matches = String(text ?? '').match(/[0-9a-fA-F]{2}/g) ?? [];
    if (!matches.length) {
        throw new Error('No hex bytes found. Example: 0x5A, 0x00, 0x12');
    }
    return new Uint8Array(matches.map((h) => Number.parseInt(h, 16)));
}
/**
 * Compare two firmware version triples. Returns a negative number if `a < b`,
 * positive if `a > b`, and 0 if equal. Missing or non-numeric components are
 * treated as 0.
 */
function compareVerisenseFirmwareVersion(a, b) {
    const aMaj = Number(a?.major) || 0;
    const aMin = Number(a?.minor) || 0;
    const aInt = Number(a?.internal) || 0;
    const bMaj = Number(b?.major) || 0;
    const bMin = Number(b?.minor) || 0;
    const bInt = Number(b?.internal) || 0;
    if (aMaj !== bMaj)
        return aMaj - bMaj;
    if (aMin !== bMin)
        return aMin - bMin;
    return aInt - bInt;
}
/** Format a firmware version triple as `"major.minor.internal"`, or `"unknown"`
 * when the version is null/undefined. */
function formatVerisenseFirmwareVersion(v) {
    if (!v)
        return 'unknown';
    return `${Number(v.major) || 0}.${Number(v.minor) || 0}.${Number(v.internal) || 0}`;
}
/** Human-readable label for a Verisense stream-packet sensor ID, with a
 * `"Sensor 0xNN"` hex fallback for unknown IDs. */
function getVerisenseStreamSensorLabel(sensorId) {
    const labels = VERISENSE_STREAM_SENSOR_LABELS;
    return labels[sensorId] ?? `Sensor 0x${Number(sensorId).toString(16).toUpperCase()}`;
}
const ASM_PROPERTY_BY_VALUE = new Map(Object.entries(ASM_PROPERTY).map(([name, value]) => [Number(value), name]));
/** Label pending-event property values with both enum name and hex representation. */
function formatPendingEventProperties(pendingProps) {
    const list = Array.isArray(pendingProps)
        ? pendingProps
        : pendingProps == null
            ? []
            : Array.from(pendingProps);
    return list.map((prop) => {
        const value = Number(prop) & 0xff;
        return {
            value,
            hex: formatByteAsHex(value),
            property: ASM_PROPERTY_BY_VALUE.get(value) ?? 'UNKNOWN_PROPERTY',
        };
    });
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
/** Read a 32-bit IEEE-754 float at byte offset `off`, little-endian. */
function f32le(bytes, off) {
    return new DataView(bytes.buffer, bytes.byteOffset + off, 4).getFloat32(0, true);
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
/** Infer charger chip family from hardware revision fields in production config. */
function inferVerisenseChargerChipFamily(revHwMajor, revHwMinor, revHwInternal) {
    const major = Number(revHwMajor);
    const minor = Number(revHwMinor);
    const internal = Number(revHwInternal);
    if ((major === 68 && minor === 7 && internal === 1) || (major === 68 && minor === 8)) {
        return 'LTC4123';
    }
    if (major === 62) {
        return 'LM3658D';
    }
    if ((major === 68 && minor >= 9) || (major === 61 && minor >= 5)) {
        return 'XC6803';
    }
    return 'UNKNOWN';
}
/** Return chip-specific charger status text for a parsed 3-bit status code. */
function describeVerisenseChargerStatus(chipFamily, statusCode) {
    if (statusCode === 7) {
        return 'Not read yet';
    }
    if (chipFamily === 'LTC4123') {
        if (statusCode === 0) {
            return 'Zinc-air/reverse polarity/temp out-of-range/UVCL at start of charge cycle';
        }
        if (statusCode === 1) {
            return 'Powered on/charging';
        }
        if (statusCode === 2) {
            return 'Charge completed';
        }
        if (statusCode === 3) {
            return 'No power/not charging';
        }
    }
    if (chipFamily === 'LM3658D') {
        if (statusCode === 0 || statusCode === 3) {
            return 'Power-down, charging suspended or interrupted';
        }
        if (statusCode === 1) {
            return 'Pre-qualification, CC/CV charging, or top-off mode';
        }
        if (statusCode === 2) {
            return 'Charge completed';
        }
    }
    if (chipFamily === 'XC6803') {
        if (statusCode === 0) {
            return 'Fault (overvoltage, overcurrent, shorted battery, etc.)';
        }
        if (statusCode === 1) {
            return 'Pre-qualification, CC/CV charging, or top-off mode';
        }
        if (statusCode === 2) {
            return 'Charge completed';
        }
        if (statusCode === 3) {
            return 'Power-down, charging suspended or interrupted';
        }
        if (statusCode === 4) {
            return 'Trickle charging';
        }
    }
    return 'Unknown';
}
/** Format charger summary text for UIs, e.g. "XC6803: Charge completed". */
function formatVerisenseChargerStatus(status, hw) {
    if (status.chargerPresent == null ||
        status.chargerStatusCode == null ||
        !status.chargerStatusName) {
        return '-';
    }
    if (!status.chargerPresent) {
        return 'Not present';
    }
    const chipFamily = inferVerisenseChargerChipFamily(hw?.revHwMajor ?? Number.NaN, hw?.revHwMinor ?? Number.NaN, hw?.revHwInternal ?? Number.NaN);
    const text = describeVerisenseChargerStatus(chipFamily, Number(status.chargerStatusCode));
    return chipFamily === 'UNKNOWN' ? text : `${chipFamily}: ${text}`;
}
/** Format unix seconds as raw + human-readable local datetime for logging. */
function formatVerisenseUnixAndHuman(unixSeconds) {
    const unix = Number(unixSeconds);
    if (!Number.isFinite(unix)) {
        return { unix, human: 'invalid' };
    }
    if (unix <= 0) {
        return { unix, human: '1970-01-01 00:00:00 (epoch)' };
    }
    if (unix > 4102444800) {
        return { unix, human: 'not-valid' };
    }
    const d = new Date(unix * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    const SS = String(d.getSeconds()).padStart(2, '0');
    return {
        unix,
        human: `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`,
    };
}
/** Convert parsed status payload into an object with human-readable timestamps for logs. */
function formatStatusPayloadForLog(status) {
    return {
        ...status,
        statusTimestamp: formatVerisenseUnixAndHuman(status.statusTimestampSeconds),
        lastOkTransfer: formatVerisenseUnixAndHuman(status.lastOkTransferSeconds),
        lastFailTransfer: formatVerisenseUnixAndHuman(status.lastFailTransferSeconds),
    };
}
/** Convert parsed scheduler payload into an object with human-readable timestamps for logs. */
function formatSchedulerPayloadForLog(parsed) {
    const out = {
        ...parsed,
        adaptiveScheduler: undefined,
        ltfRetry: undefined,
        currentTime: formatVerisenseUnixAndHuman(parsed.currentTimeUnixSeconds),
        pendingDataTransfer: formatVerisenseUnixAndHuman(parsed.pendingDataTransferUnixSeconds),
        pendingStatus1: formatVerisenseUnixAndHuman(parsed.pendingStatus1UnixSeconds),
        pendingRtcSync: formatVerisenseUnixAndHuman(parsed.pendingRtcSyncUnixSeconds),
        pendingRetry: formatVerisenseUnixAndHuman(parsed.pendingRetryUnixSeconds),
    };
    if (typeof parsed.pendingStatus2UnixSeconds === 'number') {
        out.pendingStatus2 = formatVerisenseUnixAndHuman(parsed.pendingStatus2UnixSeconds);
    }
    if (typeof parsed.ppgMeasurementUnixSeconds === 'number') {
        out.ppgMeasurement = formatVerisenseUnixAndHuman(parsed.ppgMeasurementUnixSeconds);
    }
    if (typeof parsed.stepCounterResetUnixSeconds === 'number') {
        out.stepCounterReset = formatVerisenseUnixAndHuman(parsed.stepCounterResetUnixSeconds);
    }
    if (typeof parsed.sensorInactivityUnixSeconds === 'number') {
        out.sensorInactivity = formatVerisenseUnixAndHuman(parsed.sensorInactivityUnixSeconds);
    }
    if (parsed.adaptiveScheduler) {
        out.adaptiveScheduler = {
            ...parsed.adaptiveScheduler,
            nextTime: formatVerisenseUnixAndHuman(parsed.adaptiveScheduler.nextUnixSeconds),
        };
    }
    if (parsed.ltfRetry) {
        out.ltfRetry = {
            ...parsed.ltfRetry,
            nextTime: formatVerisenseUnixAndHuman(parsed.ltfRetry.nextUnixSeconds),
        };
    }
    return out;
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
    // DEV-790 USB enumeration debug events
    53: 'USB_POWER_READY_EVT',
    54: 'USB_USBD_ENABLE_CALLED',
    55: 'USB_USBD_START_CALLED',
    56: 'USB_COM_PORT_DISABLED_ON_DETECT',
    57: 'USB_USBD_STOPPED_EVT',
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
    // 0xFF is the "unset" sentinel for the passkey/advertising-name region
    // (bytes 15..54). The configFlags byte (55) must NOT be left as 0xFF — its
    // bit 0 is PROD_CONFIG_FLAG_DFU_ENABLED, so 0xFF reads as "DFU enabled" and
    // disabling DFU would silently have no effect. It is set explicitly below.
    out.fill(0xff, 15, 55);
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
    // Always set configFlags explicitly (0x01 = DFU enabled on boot, 0x00 =
    // disabled). Matches the firmware reference encoding in ASM_Device.py.
    out[55] = (opts.dfuEnabled ?? true) ? PROD_CONFIG_FLAG_DFU_ENABLED : 0;
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
    // Ported from ASM_Device.parse_status. Present in payloads >= 56 bytes. In the
    // extended (fw v1.02.102+, payload >= 65 bytes) format the FULL and 2DEL totals
    // are split: 3 low bytes at 47-49 / 50-52 plus a high byte appended at offset
    // 58 / 59 respectively (mirroring the free-memory split to byte 57).
    const hasBankData = response.length >= 56;
    let memoryFullBanksKb = null;
    let memoryTwoDelBanksKb = null;
    let memoryBadBanksKb = null;
    if (hasBankData) {
        if (hasExtendedCapacity) {
            memoryFullBanksKb =
                (response[47] | (response[48] << 8) | (response[49] << 16) | (response[58] << 24)) >>> 0;
            memoryTwoDelBanksKb =
                (response[50] | (response[51] << 8) | (response[52] << 16) | (response[59] << 24)) >>> 0;
            memoryBadBanksKb = u32le_at(response, 53); // bytes 53-56
        }
        else {
            memoryFullBanksKb = (response[47] | (response[48] << 8) | (response[49] << 16)) >>> 0;
            memoryTwoDelBanksKb = (response[50] | (response[51] << 8) | (response[52] << 16)) >>> 0;
            memoryBadBanksKb = (response[53] | (response[54] << 8) | (response[55] << 16)) >>> 0;
        }
    }
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
    let chargerPresent = null;
    let chargerStatusCode = null;
    let chargerStatusName = null;
    if (hasExtendedCapacity) {
        const chargerStatusByte = response[64] ?? 0;
        chargerPresent = (chargerStatusByte & 0x01) !== 0;
        chargerStatusCode = (chargerStatusByte >> 1) & 0x07;
        chargerStatusName =
            chargerStatusCode === 0
                ? 'CHARGER_STATUS_BAD_BATTERY'
                : chargerStatusCode === 1
                    ? 'CHARGER_STATUS_CHARGING'
                    : chargerStatusCode === 2
                        ? 'CHARGER_STATUS_CHARGING_COMPLETE'
                        : chargerStatusCode === 3
                            ? 'CHARGER_STATUS_POWER_DOWN'
                            : chargerStatusCode === 4
                                ? 'CHARGER_STATUS_TRICKLE_CHARGING'
                                : chargerStatusCode === 7
                                    ? 'CHARGER_STATUS_NOT_READ'
                                    : 'CHARGER_STATUS_UNKNOWN';
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
        chargerPresent,
        chargerStatusCode,
        chargerStatusName,
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
/** Parse debug payload from BLE link read/optimize commands. */
function parseBleLinkDebugPayload(payload) {
    if (payload.length < 10) {
        throw new Error('parseBleLinkDebugPayload: payload is too short');
    }
    const connectionIntervalUnits = u16le_at(payload, 4);
    return {
        attMtu: u16le_at(payload, 0),
        maxDataLength: u16le_at(payload, 2),
        connectionIntervalUnits,
        connectionIntervalMs: connectionIntervalUnits * 1.25,
        txPhy: payload[6] ?? 0,
        rxPhy: payload[7] ?? 0,
        optimizationResult: payload[8] ?? 0,
        isConnected: (payload[9] ?? 0) !== 0,
    };
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
 * Infer the lookup-table bank count from a raw debug payload length. The payload
 * is 3 bytes per bank, optionally prefixed with a 4-byte head/tail block.
 * Returns 0 if the length matches neither layout.
 */
function inferVerisenseLookupBankCount(payloadLen) {
    if (!Number.isFinite(payloadLen) || payloadLen <= 0)
        return 0;
    if (payloadLen >= 4 && (payloadLen - 4) % 3 === 0)
        return Math.floor((payloadLen - 4) / 3);
    if (payloadLen % 3 === 0)
        return Math.floor(payloadLen / 3);
    return 0;
}
/**
 * Parse lookup-table debug payload entries (3 bytes per bank), with optional
 * 4-byte tail/head prefix present in older firmware debug responses. When
 * `totalBanks` is omitted it is inferred from the payload length via
 * {@link inferVerisenseLookupBankCount}.
 */
function parseLookupTablePayload(payload, totalBanks) {
    const bytesPerBank = 3;
    const banks = totalBanks ?? inferVerisenseLookupBankCount(payload.length);
    const expectedNoHeadTail = banks * bytesPerBank;
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
    for (let bankIndex = 0; bankIndex < banks; bankIndex++) {
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
        if (!isUniformByteArray(hwInternalArray, 0xff)) {
            revHwInternal = hwInternalArray[0] | (hwInternalArray[1] << 8);
        }
    }
    return {
        hardware: `${revHwMajor}.${revHwMinor}.${revHwInternal}`,
        firmware: `${revFwMajor}.${revFwMinor}.${revFwInternal}`,
        asmid: asmid.toUpperCase(),
        configHeader,
        revHwMajor,
        revHwMinor,
        revHwInternal,
        revFwMajor,
        revFwMinor,
        revFwInternal,
    };
}

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
const SC_CALIB_FORMAT_VERSION = 1;
const SC_GLOBAL_HEADER_BYTES = 12;
const SC_BLOCK_HEADER_BYTES = 12;
const SC_TS_BYTES = 8;
const SC_DATA_LEN_IMU = 60;
/**
 * The per-block `range` byte packs the full-scale index in bits [5:0] and a 2-bit
 * calibration-quality indicator in bits [7:6]. Lookups/comparisons must use only
 * the index (`range & SC_CAL_RANGE_MASK`). Quality has no producer yet (always 0),
 * so it is reserved without growing the blob or bumping the format version.
 */
const SC_CAL_RANGE_MASK = 0x3f;
const SC_CAL_QUALITY_SHIFT = 6;
const SC_CAL_QUALITY_MASK = 0x03;
/** Calibration-quality indicator (ST MotionAC / Android sensor-accuracy convention). */
const CalibQuality = {
    UNKNOWN: 0,
    POOR: 1,
    OK: 2,
    GOOD: 3,
};
/**
 * Calibration-domain sensor IDs. Distinct from the data-stream sensor IDs
 * (1=ADC, 2=LIS2DW12, 3=LSM6DS3, 4=PPG, 6=LSM6DSV, 7=VD6283, 8=MAX32674,
 * 9=MLX90632). These reuse the Shimmer3 `SC_SENSOR_*` values where they exist,
 * so accel/gyro/mag can each carry their own calibration even though one
 * data-stream id (6) covers all three.
 *
 * Data-stream → calibration mapping: 6 → {37, 38, 42}, 2 → {39}, 3 → {40, 41}.
 */
const CalibSensorId = {
    LSM6DSV_ACCEL: 37,
    LSM6DSV_GYRO: 38,
    LIS2DW12_ACCEL: 39,
    /** 1st-gen LSM6DS3 accel (data-stream id 3). */
    LSM6DS3_ACCEL: 40,
    /** 1st-gen LSM6DS3 gyro (data-stream id 3). */
    LSM6DS3_GYRO: 41,
    LIS2MDL_MAG: 42,
};
function parseImuPayload(p) {
    return {
        bias: [f32le(p, 0), f32le(p, 4), f32le(p, 8)],
        sens: [f32le(p, 12), f32le(p, 16), f32le(p, 20)],
        align: [
            f32le(p, 24),
            f32le(p, 28),
            f32le(p, 32),
            f32le(p, 36),
            f32le(p, 40),
            f32le(p, 44),
            f32le(p, 48),
            f32le(p, 52),
            f32le(p, 56),
        ],
    };
}
/** Parse a calibration blob into a typed, indexable {@link CalibrationSet}. */
function parseCalibrationBlob(blob) {
    if (blob.length < SC_GLOBAL_HEADER_BYTES) {
        throw new Error(`parseCalibrationBlob: blob too short (${blob.length} < ${SC_GLOBAL_HEADER_BYTES})`);
    }
    const totalLen = u16le_at(blob, 0);
    if (totalLen + 2 !== blob.length) {
        throw new Error(`parseCalibrationBlob: totalLen ${totalLen} does not match blob.length-2 ${blob.length - 2}`);
    }
    const formatVersion = blob[2];
    const hwVerMajor = blob[3];
    const hwVerMinor = blob[4];
    const fwVerMajor = blob[5];
    const fwVerMinor = blob[6];
    const fwVerPatch = u16le_at(blob, 7);
    const blockCount = blob[9];
    const reserved = u16le_at(blob, 10);
    const blocks = [];
    let off = SC_GLOBAL_HEADER_BYTES;
    for (let i = 0; i < blockCount; i++) {
        if (off + SC_BLOCK_HEADER_BYTES > blob.length) {
            throw new Error(`parseCalibrationBlob: block ${i} header out of range`);
        }
        const sensorId = u16le_at(blob, off);
        const rangeByte = blob[off + 2];
        const range = rangeByte & SC_CAL_RANGE_MASK;
        const quality = (rangeByte >> SC_CAL_QUALITY_SHIFT) & SC_CAL_QUALITY_MASK;
        const dataLen = blob[off + 3];
        const ts = blob.slice(off + 4, off + 4 + SC_TS_BYTES);
        const payloadStart = off + SC_BLOCK_HEADER_BYTES;
        if (payloadStart + dataLen > blob.length) {
            throw new Error(`parseCalibrationBlob: block ${i} payload out of range`);
        }
        const payload = blob.slice(payloadStart, payloadStart + dataLen);
        const isDefault = ts.every((b) => b === 0);
        const block = { sensorId, range, quality, dataLen, ts, isDefault, payload };
        if (dataLen === SC_DATA_LEN_IMU) {
            block.imu = parseImuPayload(payload);
        }
        blocks.push(block);
        off = payloadStart + dataLen;
    }
    const crc16 = crc16_ccitt_false(blob);
    return {
        formatVersion,
        hwVerMajor,
        hwVerMinor,
        fwVerMajor,
        fwVerMinor,
        fwVerPatch,
        reserved,
        blocks,
        crc16,
        getImu(sensorId, range) {
            const b = blocks.find((x) => x.sensorId === sensorId && x.range === range && x.imu);
            return b?.imu ?? null;
        },
    };
}
function serializeImuPayload(imu) {
    const out = new Uint8Array(SC_DATA_LEN_IMU);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 3; i++)
        dv.setFloat32(i * 4, imu.bias[i] ?? 0, true);
    for (let i = 0; i < 3; i++)
        dv.setFloat32(12 + i * 4, imu.sens[i] ?? 0, true);
    for (let i = 0; i < 9; i++)
        dv.setFloat32(24 + i * 4, imu.align[i] ?? 0, true);
    return out;
}
/** Serialize a calibration set into a blob (inverse of {@link parseCalibrationBlob}). */
function serializeCalibrationBlob(input) {
    const payloads = input.blocks.map((b) => {
        if (b.payload)
            return b.payload;
        if (b.imu)
            return serializeImuPayload(b.imu);
        throw new Error('serializeCalibrationBlob: each block needs imu or payload');
    });
    let total = SC_GLOBAL_HEADER_BYTES;
    for (const p of payloads)
        total += SC_BLOCK_HEADER_BYTES + p.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, total - 2, true);
    out[2] = input.formatVersion ?? SC_CALIB_FORMAT_VERSION;
    out[3] = input.hwVerMajor & 0xff;
    out[4] = input.hwVerMinor & 0xff;
    out[5] = input.fwVerMajor & 0xff;
    out[6] = input.fwVerMinor & 0xff;
    dv.setUint16(7, input.fwVerPatch & 0xffff, true);
    out[9] = input.blocks.length & 0xff;
    dv.setUint16(10, (input.reserved ?? 0) & 0xffff, true);
    let off = SC_GLOBAL_HEADER_BYTES;
    input.blocks.forEach((b, i) => {
        const payload = payloads[i];
        dv.setUint16(off, b.sensorId & 0xffff, true);
        out[off + 2] =
            (b.range & SC_CAL_RANGE_MASK) |
                (((b.quality ?? 0) & SC_CAL_QUALITY_MASK) << SC_CAL_QUALITY_SHIFT);
        out[off + 3] = payload.length & 0xff;
        if (b.ts)
            out.set(b.ts.subarray(0, SC_TS_BYTES), off + 4); // else leave zero (default)
        out.set(payload, off + SC_BLOCK_HEADER_BYTES);
        off += SC_BLOCK_HEADER_BYTES + payload.length;
    });
    return out;
}
/** CRC-16/CCITT-FALSE over a serialized blob — the value stamped into payload headers. */
function calibrationBlobCrc(blob) {
    return crc16_ccitt_false(blob);
}
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
function applyImuCalibration(raw, cal) {
    const v0 = (raw[0] - cal.bias[0]) / cal.sens[0];
    const v1 = (raw[1] - cal.bias[1]) / cal.sens[1];
    const v2 = (raw[2] - cal.bias[2]) / cal.sens[2];
    const a = cal.align;
    return [
        a[0] * v0 + a[1] * v1 + a[2] * v2,
        a[3] * v0 + a[4] * v1 + a[5] * v2,
        a[6] * v0 + a[7] * v1 + a[8] * v2,
    ];
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
// ---------------------------------------------------------------------------
// Streaming-frame framing / resynchronisation
// ---------------------------------------------------------------------------
/**
 * Header byte that prefixes every streaming data frame:
 * `RESPONSE (0x30) | STREAM_MODE (0x0a) === 0x3A`.
 */
const STREAM_FRAME_HEADER = buildHeader(ASM_COMMAND.RESPONSE, ASM_PROPERTY.STREAM_MODE);
/** Smallest valid streaming payload: sensorId(1) + tick(3) + CRC16(2). */
const STREAM_FRAME_MIN_PAYLOAD = 6;
/**
 * Largest streaming payload we will accept. The firmware packages multi-sample
 * sensor records into a single logical frame that is frequently much larger
 * than one BLE notification (e.g. ~1.8 kB for an LSM6DSV accel/gyro/mag burst)
 * and fragments it across several notifications; the host reassembles them in
 * its receive buffer before this scanner runs. The ceiling must therefore cover
 * the firmware's largest packaged payload — it mirrors the length-only path's
 * `MAX_FRAME_PAYLOAD_LEN` (see VerisenseClient) — not the BLE MTU. It still
 * bounds how far a corrupt length field can run before the CRC rejects it
 * during resync.
 *
 * WARNING: do NOT shrink this to an MTU-sized value. A small ceiling silently
 * drops every large frame (accel/gyro/mag), because their length exceeds the
 * cap and the CRC trailer is never reached — the stream just looks dead.
 */
const STREAM_FRAME_MAX_PAYLOAD = 40000;
const STREAM_SCAN_NEED_MORE = { status: 'need-more' };
const STREAM_SCAN_INVALID = { status: 'invalid' };
/**
 * Try to read one CRC-validated streaming frame from the front of `buf`.
 *
 * On the wire a streaming frame is:
 *
 * ```
 * [0x3A][ len LE (2) ][ sensorId(1) | tick(3) | samples… | CRC16(2) ]
 * ```
 *
 * where `len` is the payload length **including** the trailing 2-byte CRC, and
 * the CRC-16/CCITT-FALSE covers the payload up to (but not including) those last
 * 2 bytes — matching the firmware's `crc16_ccitt(buf + 3, len - 2)`.
 *
 * The framing has no start/sync marker, so the CRC is what makes
 * resynchronisation reliable: after a flaky link drops bytes and knocks the
 * stream out of alignment, the caller slides one byte at a time and accepts a
 * boundary only when its CRC checks out, so misaligned/garbage data can no
 * longer masquerade as a valid (but wrong sensor-id) packet.
 *
 * Returns:
 *  - `need-more` — too few bytes buffered to decide; wait for the next chunk.
 *  - `invalid`   — the front of the buffer is not a valid frame start; the
 *                  caller should drop one byte and try again.
 *  - `frame`     — a CRC-valid frame; `payload` is the `len`-byte payload (CRC
 *                  trailer included) and `consumed` is `3 + len` bytes to remove.
 */
function scanStreamFrame(buf) {
    if (buf.length < 3)
        return STREAM_SCAN_NEED_MORE;
    if (buf[0] !== STREAM_FRAME_HEADER)
        return STREAM_SCAN_INVALID;
    const len = (buf[1] | (buf[2] << 8)) >>> 0;
    if (len < STREAM_FRAME_MIN_PAYLOAD || len > STREAM_FRAME_MAX_PAYLOAD) {
        return STREAM_SCAN_INVALID;
    }
    if (buf.length < 3 + len)
        return STREAM_SCAN_NEED_MORE;
    // CRC trailer is the last 2 payload bytes (LE); it covers the payload before it.
    const crcAt = 3 + len - 2;
    const claimed = (buf[crcAt] | (buf[crcAt + 1] << 8)) >>> 0;
    const calc = crc16_ccitt_false(buf.subarray(3, crcAt));
    if (calc !== claimed)
        return STREAM_SCAN_INVALID;
    return { status: 'frame', payload: buf.slice(3, 3 + len), consumed: 3 + len };
}
/** Parse a complete protocol message into structured fields. */
function parseMessage(msg) {
    if (msg.length < 3)
        throw new Error('Invalid Verisense message: header is incomplete');
    const header = msg[0];
    const payloadLength = u16le$1(msg[1], msg[2]);
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

const VERISENSE_HW_MAJOR_FRIENDLY_NAMES = {
    61: 'IMU',
    62: 'GSR+',
    64: 'SDK',
    68: 'Pulse+',
};
function getVerisenseHardwareFriendlyName(revHwMajor) {
    return VERISENSE_HW_MAJOR_FRIENDLY_NAMES[revHwMajor] ?? null;
}
/**
 * Second-generation Verisense hardware is currently defined as:
 * - SR61.5+
 * - SR68.9+
 * - Any future major revision above SR68
 */
function isVerisenseSecondGenerationHardware(revHwMajor, revHwMinor) {
    const major = Number(revHwMajor);
    const minor = Number(revHwMinor);
    if (!Number.isFinite(major) || !Number.isFinite(minor))
        return false;
    if (major > 68)
        return true;
    if (major === 61 && minor >= 5)
        return true;
    if (major === 68 && minor >= 9)
        return true;
    return false;
}
function getVerisenseHardwareCapabilities(revHwMajor, revHwMinor) {
    const secondGeneration = isVerisenseSecondGenerationHardware(revHwMajor, revHwMinor);
    return {
        secondGeneration,
        supportsMagnetometer: secondGeneration,
    };
}
const VERISENSE_SENSOR_SUPPORT_NONE = {
    accel1: false,
    gyroAccel2: false,
    imuGen2: false,
    gsr: false,
    ppg: false,
    ambientLight: false,
    skinTemperature: false,
    algorithmHub: false,
    ledAutoBrightness: false,
};
const VERISENSE_SENSOR_SUPPORT_ALL = {
    accel1: true,
    gyroAccel2: true,
    imuGen2: true,
    gsr: true,
    ppg: true,
    ambientLight: true,
    skinTemperature: true,
    algorithmHub: true,
    ledAutoBrightness: true,
};
/**
 * Resolves which sensor blocks a given Verisense hardware revision carries,
 * derived from the firmware Model IC matrix
 * (verisense-firmware/docs/VERISENSE_MODEL_IC_MATRIX.md).
 *
 * Unknown / development hardware (e.g. SR64, or any unrecognised major
 * revision) reports every block as present so consumers never hide a setting
 * they cannot confidently rule out.
 */
function getVerisenseHardwareSensorSupport(revHwMajor, revHwMinor) {
    const major = Number(revHwMajor);
    const minor = Number(revHwMinor);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) {
        return { ...VERISENSE_SENSOR_SUPPORT_ALL };
    }
    const gen2 = isVerisenseSecondGenerationHardware(major, minor);
    switch (major) {
        case 61: // Verisense IMU
            return gen2
                ? // SR61.5+: LSM6DSV + LIS2MDL, GSR, ambient light, 2xRGB LEDs.
                    {
                        ...VERISENSE_SENSOR_SUPPORT_NONE,
                        imuGen2: true,
                        gsr: true,
                        ambientLight: true,
                        ledAutoBrightness: true,
                    }
                : // SR61.1-4: LIS2DW12 + LSM6DS3 only.
                    { ...VERISENSE_SENSOR_SUPPORT_NONE, accel1: true, gyroAccel2: true };
        case 62: // Verisense GSR+: LIS2DW12 + LSM6DS3, GSR, analog PPG.
            return {
                ...VERISENSE_SENSOR_SUPPORT_NONE,
                accel1: true,
                gyroAccel2: true,
                gsr: true,
                ppg: true,
            };
        case 63: // Verisense PPG: LIS2DW12 + LSM6DS3 + PPG.
            return { ...VERISENSE_SENSOR_SUPPORT_NONE, accel1: true, gyroAccel2: true, ppg: true };
        case 68: // Verisense Pulse+
            return gen2
                ? // SR68.9+: full 2nd-gen stack. The LIS2DW12 (accel1) is physically
                    // present but routed to the algorithm hub and not recorded from, so
                    // it is treated as unsupported for operational-config purposes.
                    {
                        ...VERISENSE_SENSOR_SUPPORT_NONE,
                        imuGen2: true,
                        gsr: true,
                        ppg: true,
                        ambientLight: true,
                        skinTemperature: true,
                        algorithmHub: true,
                        ledAutoBrightness: true,
                    }
                : // SR68.1-8: LIS2DW12 + PPG; skin temperature added from SR68.7.
                    {
                        ...VERISENSE_SENSOR_SUPPORT_NONE,
                        accel1: true,
                        ppg: true,
                        skinTemperature: minor >= 7,
                    };
        default:
            // SR64 (dev board) and any future/unknown major: assume everything.
            return { ...VERISENSE_SENSOR_SUPPORT_ALL };
    }
}
function getVerisenseHardwareRevision(source) {
    if (!source)
        return null;
    const major = Number(source.revHwMajor);
    const minor = Number(source.revHwMinor);
    const internal = Number(source.revHwInternal);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(internal)) {
        return null;
    }
    if (major <= 0 || major > 255 || minor < 0 || minor > 255 || internal < 0 || internal > 65535) {
        return null;
    }
    return {
        major: Math.trunc(major),
        minor: Math.trunc(minor),
        internal: Math.trunc(internal),
    };
}
function supportsVerisenseMagnetometer(source) {
    const hw = getVerisenseHardwareRevision(source);
    if (!hw)
        return false;
    return getVerisenseHardwareCapabilities(hw.major, hw.minor).supportsMagnetometer;
}
function formatVerisenseHardwareRevision(revHwMajor, revHwMinor, revHwInternal = 0, opts = {}) {
    const prefix = opts.prefix ?? 'SR';
    const base = `${prefix}${revHwMajor}.${revHwMinor}.${revHwInternal}`;
    if (!opts.includeFriendlyName)
        return base;
    const friendly = getVerisenseHardwareFriendlyName(revHwMajor);
    return friendly ? `${base} (${friendly})` : base;
}
/**
 * Battery voltage scaling for streamed ADC battery samples.
 * Status responses already contain firmware-scaled battery values and should not use this helper.
 */
function getVerisenseStreamingBatteryVoltageMultiplier(revHwMajor, revHwMinor) {
    // SR62
    if (revHwMajor === 62)
        return 2.0;
    // SR61.5+, SR68.9+, and newer major revisions.
    if (isVerisenseSecondGenerationHardware(revHwMajor, revHwMinor)) {
        return 2.469;
    }
    return 1.0;
}

const VERISENSE_OPERATIONAL_FIELD_SCHEMA = [
    // GEN_CFG_0
    {
        key: 'BLUETOOTH_EN',
        label: 'Bluetooth',
        desc: 'Enable BLE',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_0,
        shift: 4,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'USB_EN',
        label: 'USB',
        desc: 'Enable USB interface',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_0,
        shift: 3,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    // GEN_CFG_0 bit 2 is reserved (was PRIORITISE_LONG_TERM_FLASH, removed in
    // DEV-806): never used and never read by the firmware. The bit is left unused
    // in the byte layout (free to repurpose); older configs that set it are simply
    // ignored.
    {
        key: 'DEVICE_EN',
        label: 'Device',
        desc: 'Master device enable',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_0,
        shift: 1,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'RECORDING_EN',
        label: 'Recording',
        desc: 'Enable recording',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_0,
        shift: 0,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    // GEN_CFG_1
    {
        key: 'DATA_COMPRESSION_MODE',
        label: 'Data Compression',
        desc: '0: Off, 1: ZLIB (future), 2: XZ (future), 3: Reserved',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_1,
        shift: 0,
        width: 2,
        options: [
            [0, 'Off'],
            [1, 'ZLIB (future)'],
            [2, 'XZ (future)'],
            [3, 'Reserved'],
        ],
    },
    // GEN_CFG_2/3
    {
        key: 'HR_PPG_CHANNEL',
        label: 'HR PPG Channel',
        desc: 'Default HR channel',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_2,
        shift: 6,
        width: 2,
        options: [
            [0, 'IR'],
            [1, 'RED'],
            [2, 'GREEN'],
            [3, 'BLUE'],
        ],
    },
    {
        key: 'STEP_COUNT_EN',
        label: 'Step Counter',
        desc: 'Enable step counter',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_2,
        shift: 5,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'PENDING_EVENTS_SCHEDULER_DISABLED',
        label: 'Pending Events Scheduler',
        desc: '1 = disabled',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_2,
        shift: 4,
        width: 1,
        options: [
            [0, 'Enabled'],
            [1, 'Disabled'],
        ],
    },
    {
        key: 'BATT_TYPE',
        label: 'Battery Type',
        desc: 'Battery chemistry',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_2,
        shift: 0,
        width: 1,
        options: [
            [0, 'Zinc-Air'],
            [1, 'NiMH'],
        ],
    },
    {
        key: 'MAG_EN',
        label: 'Magnetometer',
        desc: 'Enable LIS2MDL magnetometer (second-generation hardware)',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_3,
        shift: 2,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'LED_MODE',
        label: 'LED Mode',
        desc: '0 Off, 1 On, 2 Low-power',
        kind: 'bit',
        index: OP_IDX.GEN_CFG_3,
        shift: 0,
        width: 2,
        options: [
            [0, 'Off'],
            [1, 'On'],
            [2, 'Low-power'],
            [3, 'Reserved'],
        ],
    },
    // ACCEL1
    {
        key: 'ODR',
        label: 'Accel1 ODR',
        desc: 'Accel1 sampling rate mode',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_0,
        shift: 4,
        width: 4,
        options: [
            [0, 'Power-down'],
            [1, '12.5/1.6 Hz'],
            [2, '12.5 Hz'],
            [3, '25 Hz'],
            [4, '50 Hz'],
            [5, '100 Hz'],
            [6, '200 Hz'],
            [7, '400/200 Hz'],
            [8, '800/200 Hz'],
            [9, '1600/200 Hz'],
        ],
    },
    {
        key: 'MODE',
        label: 'Accel1 Mode',
        desc: 'Operating mode',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_0,
        shift: 2,
        width: 2,
        options: [
            [0, 'Low-Power'],
            [1, 'High-Performance'],
            [2, 'Single conversion'],
            [3, 'Reserved'],
        ],
    },
    {
        key: 'LP_MODE',
        label: 'Accel1 LP Mode',
        desc: 'Low-power sub-mode',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_0,
        shift: 0,
        width: 2,
        options: [
            [0, 'LP1'],
            [1, 'LP2'],
            [2, 'LP3'],
            [3, 'LP4'],
        ],
    },
    {
        key: 'BW_FILT',
        label: 'Accel1 BW Filter',
        desc: '00 ODR/2, 01 ODR/4, 10 ODR/10, 11 ODR/20',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_1,
        shift: 6,
        width: 2,
        options: [
            [0, 'ODR/2'],
            [1, 'ODR/4'],
            [2, 'ODR/10'],
            [3, 'ODR/20'],
        ],
    },
    {
        key: 'FS',
        label: 'Accel1 Range',
        desc: 'Full-scale range',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_1,
        shift: 4,
        width: 2,
        options: [
            [0, '+-2g'],
            [1, '+-4g'],
            [2, '+-8g'],
            [3, '+-16g'],
        ],
    },
    {
        key: 'FDS',
        label: 'Accel1 FDS',
        desc: 'Filtered data selection',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_1,
        shift: 3,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'LOW_NOISE',
        label: 'Accel1 Low Noise',
        desc: 'Low-noise mode',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_1,
        shift: 2,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'HP_REF_MODE',
        label: 'Accel1 HP Ref Mode',
        desc: 'High-pass reference mode',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_2,
        shift: 1,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'FMode',
        label: 'Accel1 FIFO Mode',
        desc: 'LIS2DW12 FIFO mode',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_3,
        shift: 5,
        width: 3,
        options: [
            [0, 'Bypass'],
            [1, 'FIFO'],
            [2, 'Reserved'],
            [3, 'Continuous-to-FIFO'],
            [4, 'Bypass-to-Continuous'],
            [5, 'Reserved'],
            [6, 'Continuous'],
            [7, 'Reserved'],
        ],
    },
    {
        key: 'FTH',
        label: 'Accel1 FIFO Threshold',
        desc: '5-bit threshold (0-31)',
        kind: 'bit',
        index: OP_IDX.ACCEL1_CFG_3,
        shift: 0,
        width: 5,
        min: 0,
        max: 31,
    },
    // ACCEL2/GYRO
    {
        key: 'FTH_LSB',
        label: 'LSM FIFO Threshold LSB',
        desc: 'Lower 8 bits of LSM FIFO threshold',
        kind: 'u8',
        index: OP_IDX.GYRO_ACCEL2_CFG_0,
        min: 0,
        max: 255,
    },
    {
        key: 'TIMER_PEDO_FIFDO_EN',
        label: 'Timer/Pedo FIFO Dataset',
        desc: 'Include step/timestamp as 4th dataset',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_1,
        shift: 7,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'TIMER_PEDO_FIFO_DRDY',
        label: 'Timer/Pedo FIFO DRDY',
        desc: '0 write by DRDY, 1 disable write at each step',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_1,
        shift: 6,
        width: 1,
        options: [
            [0, 'DRDY'],
            [1, 'Step detect'],
        ],
    },
    {
        key: 'FTH_MSB',
        label: 'LSM FIFO Threshold MSB',
        desc: 'Upper 4 bits of LSM FIFO threshold',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_1,
        shift: 0,
        width: 4,
        min: 0,
        max: 15,
    },
    {
        key: 'DEC_FIFO_GYRO',
        label: 'Gyro FIFO Decimation',
        desc: 'Decimation factor for gyro',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_2,
        shift: 3,
        width: 3,
        options: [
            [0, 'Not in FIFO'],
            [1, 'No decimation'],
            [2, 'x2'],
            [3, 'x3'],
            [4, 'x4'],
            [5, 'x8'],
            [6, 'x16'],
            [7, 'x32'],
        ],
    },
    {
        key: 'DEC_FIFO_XL',
        label: 'Accel2 FIFO Decimation',
        desc: 'Decimation factor for accel2',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_2,
        shift: 0,
        width: 3,
        options: [
            [0, 'Not in FIFO'],
            [1, 'No decimation'],
            [2, 'x2'],
            [3, 'x3'],
            [4, 'x4'],
            [5, 'x8'],
            [6, 'x16'],
            [7, 'x32'],
        ],
    },
    {
        key: 'ODR_FIFO',
        label: 'LSM FIFO ODR',
        desc: 'FIFO sampling rate',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_3,
        shift: 3,
        width: 4,
        options: [
            [0, 'Disabled'],
            [1, '12.5 Hz'],
            [2, '26 Hz'],
            [3, '52 Hz'],
            [4, '104 Hz'],
            [5, '208 Hz'],
            [6, '416 Hz'],
            [7, '833 Hz'],
            [8, '1.66 kHz'],
            [9, '3.33 kHz'],
            [10, '6.66 kHz'],
        ],
    },
    {
        key: 'FIFO_MODE',
        label: 'LSM FIFO Mode',
        desc: 'FIFO behavior',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_3,
        shift: 0,
        width: 3,
        options: [
            [0, 'Bypass'],
            [1, 'FIFO'],
            [2, 'Reserved'],
            [3, 'Continuous-to-FIFO'],
            [4, 'Bypass-to-Continuous'],
            [5, 'Reserved'],
            [6, 'Continuous'],
            [7, 'Reserved'],
        ],
    },
    {
        key: 'ODR_XL',
        label: 'Accel2 ODR',
        desc: 'Accel2 sampling rate',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_4,
        shift: 4,
        width: 4,
        options: [
            [0, 'Power-down'],
            [1, '12.5 Hz'],
            [2, '26 Hz'],
            [3, '52 Hz'],
            [4, '104 Hz'],
            [5, '208 Hz'],
            [6, '416 Hz'],
            [7, '833 Hz'],
            [8, '1.66 kHz'],
            [9, '3.33 kHz'],
            [10, '6.66 kHz'],
        ],
    },
    {
        key: 'FS_XL',
        label: 'Accel2 Range',
        desc: '00 +-2g, 01 +-16g, 10 +-4g, 11 +-8g',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_4,
        shift: 2,
        width: 2,
        options: [
            [0, '+-2g'],
            [1, '+-16g'],
            [2, '+-4g'],
            [3, '+-8g'],
        ],
    },
    {
        key: 'BW_XL',
        label: 'Accel2 BW',
        desc: 'Anti-alias filter bandwidth',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_4,
        shift: 0,
        width: 2,
        options: [
            [0, '400 Hz'],
            [1, '200 Hz'],
            [2, '100 Hz'],
            [3, '50 Hz'],
        ],
    },
    {
        key: 'ODR_G',
        label: 'Gyro ODR',
        desc: 'Gyro sampling rate',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_5,
        shift: 4,
        width: 4,
        options: [
            [0, 'Power-down'],
            [1, '12.5 Hz'],
            [2, '26 Hz'],
            [3, '52 Hz'],
            [4, '104 Hz'],
            [5, '208 Hz'],
            [6, '416 Hz'],
            [7, '833 Hz'],
            [8, '1.66 kHz'],
        ],
    },
    {
        key: 'FS_G',
        label: 'Gyro Range',
        desc: 'Gyro full-scale',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_5,
        shift: 2,
        width: 2,
        options: [
            [0, '250 dps'],
            [1, '500 dps'],
            [2, '1000 dps'],
            [3, '2000 dps'],
        ],
    },
    {
        key: 'FS_125',
        label: 'Gyro 125 dps',
        desc: 'Enable 125 dps full-scale',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_5,
        shift: 1,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'G_HM_MODE',
        label: 'Gyro High-Performance Mode',
        desc: '0 HP enabled, 1 HP disabled',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_6,
        shift: 7,
        width: 1,
        options: [
            [0, 'Enabled'],
            [1, 'Disabled'],
        ],
    },
    {
        key: 'HP_G_EN',
        label: 'Gyro HPF',
        desc: 'Gyro high-pass filter',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_6,
        shift: 6,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'HPCF_G',
        label: 'Gyro HPF Cutoff',
        desc: 'Gyro HPF cutoff frequency',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_6,
        shift: 4,
        width: 2,
        options: [
            [0, '0.0081 Hz'],
            [1, '0.0324 Hz'],
            [2, '2.07 Hz'],
            [3, '16.32 Hz'],
        ],
    },
    {
        key: 'HP_G_RST',
        label: 'Gyro HPF Reset',
        desc: 'Reset digital HPF',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_6,
        shift: 3,
        width: 1,
        options: [
            [0, 'Off'],
            [1, 'On'],
        ],
    },
    {
        key: 'ROUNDING_STATUS',
        label: 'Rounding Status',
        desc: 'Source register rounding',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_6,
        shift: 2,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'LPF2_XL_EN',
        label: 'Accel2 LPF2',
        desc: 'LPF2 selection',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_7,
        shift: 7,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'HPCF_XL',
        label: 'Accel2 HP/Slope Cutoff',
        desc: 'HPCF_XL bits',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_7,
        shift: 5,
        width: 2,
        min: 0,
        max: 3,
    },
    {
        key: 'HP_SLOPE_XL_EN',
        label: 'Accel2 HP/Slope Enable',
        desc: 'HP/slope filter selection',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_7,
        shift: 2,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'LOW_PASS_ON_6D',
        label: 'Low-pass on 6D',
        desc: 'Low-pass filter on 6D function',
        kind: 'bit',
        index: OP_IDX.GYRO_ACCEL2_CFG_7,
        shift: 0,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    // LSM6DSV explicit host fields (bytes 18..20)
    {
        key: 'LSM6DSV_ODR_XL',
        label: 'LSM6DSV Accel ODR',
        desc: 'Accel ODR (LSM6DSV ODR_XL datasheet register value, byte 18 bits 3:0)',
        kind: 'bit',
        index: OP_IDX.LSM6DSV_CFG_0,
        shift: 0,
        width: 4,
        options: [
            [0, 'Off'],
            [1, '1.875 Hz'],
            [2, '7.5 Hz'],
            [3, '15 Hz'],
            [4, '30 Hz'],
            [5, '60 Hz'],
            [6, '120 Hz'],
            [7, '240 Hz'],
            [8, '480 Hz'],
            [9, '960 Hz'],
            [10, '1920 Hz'],
            [11, '3840 Hz'],
            [12, '7680 Hz'],
        ],
    },
    {
        key: 'LSM6DSV_FS_XL',
        label: 'LSM6DSV Accel Range',
        desc: 'Second-gen accel range code (byte 18 bits 5:4)',
        kind: 'bit',
        index: OP_IDX.LSM6DSV_CFG_0,
        shift: 4,
        width: 2,
        options: [
            [0, '+-2g'],
            [1, '+-4g'],
            [2, '+-8g'],
            [3, '+-16g'],
        ],
    },
    {
        key: 'LSM6DSV_ODR_G',
        label: 'LSM6DSV Gyro ODR',
        desc: 'Gyro ODR (LSM6DSV ODR_G datasheet register value, byte 19 bits 3:0)',
        kind: 'bit',
        index: OP_IDX.LSM6DSV_CFG_1,
        shift: 0,
        width: 4,
        options: [
            [0, 'Off'],
            [1, '1.875 Hz'],
            [2, '7.5 Hz'],
            [3, '15 Hz'],
            [4, '30 Hz'],
            [5, '60 Hz'],
            [6, '120 Hz'],
            [7, '240 Hz'],
            [8, '480 Hz'],
            [9, '960 Hz'],
            [10, '1920 Hz'],
            [11, '3840 Hz'],
            [12, '7680 Hz'],
        ],
    },
    {
        key: 'LSM6DSV_FS_G',
        label: 'LSM6DSV Gyro Range',
        desc: 'Gyro range (LSM6DSV FS_G datasheet register value, byte 19 bits 7:4)',
        kind: 'bit',
        index: OP_IDX.LSM6DSV_CFG_1,
        shift: 4,
        width: 4,
        options: [
            [0, '125 dps'],
            [1, '250 dps'],
            [2, '500 dps'],
            [3, '1000 dps'],
            [4, '2000 dps'],
        ],
    },
    {
        key: 'LIS2MDL_ODR',
        label: 'Mag Output Rate',
        desc: 'Magnetometer output (sensor-hub) rate. Firmware derives the LIS2MDL ODR to keep a fresh sample available (byte 20 bits 1:0). Bounded by the accel/gyro ODR (the sensor-hub trigger).',
        kind: 'bit',
        index: OP_IDX.LSM6DSV_CFG_2,
        shift: 0,
        width: 2,
        options: [
            [0, '15 Hz (LIS2MDL 20 Hz)'],
            [1, '30 Hz (LIS2MDL 50 Hz)'],
            [2, '60 Hz (LIS2MDL 100 Hz)'],
            [3, '120 Hz (LIS2MDL 100 Hz)'],
        ],
    },
    // Timing and BLE scheduler
    {
        key: 'START_TIME',
        label: 'Start Time',
        desc: '32-bit start time',
        kind: 'u32',
        index: OP_IDX.START_TIME,
        min: 0,
        max: 4294967295,
    },
    {
        key: 'END_TIME',
        label: 'End Time',
        desc: '32-bit end time',
        kind: 'u32',
        index: OP_IDX.END_TIME,
        min: 0,
        max: 4294967295,
    },
    {
        key: 'RESUME_REC_ON_ACTIVITY',
        label: 'Resume Rec On Activity',
        desc: 'INACTIVE_TIMEOUT bit 6',
        kind: 'inactiveResume',
        index: OP_IDX.INACTIVE_TIMEOUT,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'INACTIVE_TIMEOUT_MINUTES',
        label: 'Inactive Timeout (min)',
        desc: 'INACTIVE_TIMEOUT bits [5:0]',
        kind: 'inactiveMinutes',
        index: OP_IDX.INACTIVE_TIMEOUT,
        min: 0,
        max: 63,
    },
    {
        key: 'BLE_CONNECTION_TRIES_PER_DAY',
        label: 'BLE Retry Count',
        desc: 'BLE connection tries per day',
        kind: 'u8',
        index: OP_IDX.BLE_RETRY_COUNT,
        min: 0,
        max: 255,
    },
    {
        key: 'BLE_TX_POWER',
        label: 'BLE TX Power',
        desc: 'Radio TX power',
        kind: 'u8',
        index: OP_IDX.BLE_TX_POWER,
        options: [
            [0x08, '+8 dBm'],
            [0x07, '+7 dBm'],
            [0x06, '+6 dBm'],
            [0x05, '+5 dBm'],
            [0x04, '+4 dBm'],
            [0x03, '+3 dBm'],
            [0x02, '+2 dBm'],
            [0x00, '+0 dBm'],
            [0xfc, '-4 dBm'],
            [0xf8, '-8 dBm'],
            [0xf4, '-12 dBm'],
            [0xf0, '-16 dBm'],
            [0xec, '-20 dBm'],
            [0xd8, '-40 dBm'],
        ],
    },
    {
        key: 'BLE_DATA_TRANS_WKUP_INT_HOURS',
        label: 'BLE Data Wakeup Interval (h)',
        desc: 'Data transfer wake interval',
        kind: 'u8',
        index: OP_IDX.BLE_DATA_TRANS_WKUP_INT_HRS,
        min: 0,
        max: 255,
    },
    {
        key: 'BLE_DATA_TRANS_WKUP_TIME',
        label: 'BLE Data Wakeup Time',
        desc: 'LSB/MSB 16-bit value',
        kind: 'u16',
        index: OP_IDX.BLE_DATA_TRANS_WKUP_TIME,
        min: 0,
        max: 65535,
    },
    {
        key: 'BLE_DATA_TRANS_WKUP_DUR',
        label: 'BLE Data Wakeup Duration',
        desc: 'Duration in units used by firmware',
        kind: 'u8',
        index: OP_IDX.BLE_DATA_TRANS_WKUP_DUR,
        min: 0,
        max: 255,
    },
    {
        key: 'BLE_DATA_TRANS_RETRY_INT',
        label: 'BLE Data Retry Interval',
        desc: 'LSB/MSB 16-bit value',
        kind: 'u16',
        index: OP_IDX.BLE_DATA_TRANS_RETRY_INT,
        min: 0,
        max: 65535,
    },
    {
        key: 'BLE_STATUS_WKUP_INT_HOURS',
        label: 'BLE Status Wakeup Interval (h)',
        desc: 'Status wake interval',
        kind: 'u8',
        index: OP_IDX.BLE_STATUS_WKUP_INT_HRS,
        min: 0,
        max: 255,
    },
    {
        key: 'BLE_STATUS_WKUP_TIME',
        label: 'BLE Status Wakeup Time',
        desc: 'LSB/MSB 16-bit value',
        kind: 'u16',
        index: OP_IDX.BLE_STATUS_WKUP_TIME,
        min: 0,
        max: 65535,
    },
    {
        key: 'BLE_STATUS_WKUP_DUR',
        label: 'BLE Status Wakeup Duration',
        desc: 'Duration in units used by firmware',
        kind: 'u8',
        index: OP_IDX.BLE_STATUS_WKUP_DUR,
        min: 0,
        max: 255,
    },
    {
        key: 'BLE_STATUS_RETRY_INT',
        label: 'BLE Status Retry Interval',
        desc: 'LSB/MSB 16-bit value',
        kind: 'u16',
        index: OP_IDX.BLE_STATUS_RETRY_INT,
        min: 0,
        max: 65535,
    },
    {
        key: 'BLE_RTC_SYNC_WKUP_INT_HOURS',
        label: 'BLE RTC Sync Wakeup Interval (h)',
        desc: 'RTC sync wake interval',
        kind: 'u8',
        index: OP_IDX.BLE_RTC_SYNC_WKUP_INT_HRS,
        min: 0,
        max: 255,
    },
    {
        key: 'BLE_RTC_SYNC_WKUP_TIME',
        label: 'BLE RTC Sync Wakeup Time',
        desc: 'LSB/MSB 16-bit value',
        kind: 'u16',
        index: OP_IDX.BLE_RTC_SYNC_WKUP_TIME,
        min: 0,
        max: 65535,
    },
    {
        key: 'BLE_RTC_SYNC_WKUP_DUR',
        label: 'BLE RTC Sync Wakeup Duration',
        desc: 'Duration in units used by firmware',
        kind: 'u8',
        index: OP_IDX.BLE_RTC_SYNC_WKUP_DUR,
        min: 0,
        max: 255,
    },
    {
        key: 'BLE_RTC_SYNC_RETRY_INT',
        label: 'BLE RTC Sync Retry Interval',
        desc: 'LSB/MSB 16-bit value',
        kind: 'u16',
        index: OP_IDX.BLE_RTC_SYNC_RETRY_INT,
        min: 0,
        max: 65535,
    },
    // ADC/PPG
    {
        key: 'ADC_SAMPLE_RATE',
        label: 'ADC Sample Rate',
        desc: 'ADC sample rate code',
        kind: 'bit',
        index: OP_IDX.ADC_CHANNEL_SETTINGS_0,
        shift: 0,
        width: 6,
        options: [
            [0, 'Off'],
            [1, '32768.0 Hz'],
            [2, '16384.0 Hz'],
            [3, '8192.0 Hz'],
            [4, '6553.6 Hz'],
            [5, '4096.0 Hz'],
            [6, '3276.8 Hz'],
            [7, '2048.0 Hz'],
            [8, '1638.4 Hz'],
            [9, '1310.72 Hz'],
            [10, '1024.0 Hz'],
            [11, '819.2 Hz'],
            [12, '655.36 Hz'],
            [13, '512.0 Hz'],
            [14, '409.6 Hz'],
            [15, '327.68 Hz'],
            [16, '256.0 Hz'],
            [17, '204.8 Hz'],
            [18, '163.84 Hz'],
            [19, '128.0 Hz'],
            [20, '102.4 Hz'],
            [21, '81.92 Hz'],
            [22, '64.0 Hz'],
            [23, '51.2 Hz'],
            [24, '40.96 Hz'],
            [25, '32.0 Hz'],
            [26, '25.6 Hz'],
            [27, '20.48 Hz'],
            [28, '16.0 Hz'],
            [29, '12.8 Hz'],
            [30, '10.24 Hz'],
            [31, '8.0 Hz'],
            [32, '6.4 Hz'],
            [33, '5.12 Hz'],
            [34, '4.0 Hz'],
            [35, '3.2 Hz'],
            [36, '2.56 Hz'],
            [37, '2.0 Hz'],
            [38, '1.6 Hz'],
            [39, '1.28 Hz'],
            [40, '1.0 Hz'],
            [41, '0.8 Hz'],
            [42, '0.64 Hz'],
        ],
    },
    {
        key: 'ADC_OVERSAMPLE_RATE',
        label: 'ADC Oversample',
        desc: 'ADC oversampling',
        kind: 'bit',
        index: OP_IDX.ADC_CHANNEL_SETTINGS_1,
        shift: 4,
        width: 4,
        options: [
            [0, 'Disabled'],
            [1, '2x'],
            [2, '4x'],
            [3, '8x'],
            [4, '16x'],
            [5, '32x'],
            [6, '64x'],
            [7, '128x'],
            [8, '256x'],
        ],
    },
    {
        key: 'GSR_RANGE_SETTING',
        label: 'GSR Range',
        desc: '0:40k, 1:287k, 2:1M, 3:3.3M, 4:Auto',
        kind: 'bit',
        index: OP_IDX.ADC_CHANNEL_SETTINGS_1,
        shift: 0,
        width: 3,
        options: [
            [0, 'Range 0 (40k)'],
            [1, 'Range 1 (287k)'],
            [2, 'Range 2 (1M)'],
            [3, 'Range 3 (3.3M)'],
            [4, 'Auto'],
        ],
    },
    {
        key: 'ADAPTIVE_SCHEDULER_INTERVAL',
        label: 'Adaptive Scheduler Interval',
        desc: '16-bit adaptive scheduler interval',
        kind: 'u16',
        index: OP_IDX.ADAPTIVE_SCHEDULER_INT,
        min: 0,
        max: 65535,
    },
    {
        key: 'ADAPTIVE_SCHEDULER_FAILCOUNT_MAX',
        label: 'Adaptive Scheduler Failcount Max',
        desc: 'Maximum failed attempts',
        kind: 'u8',
        index: OP_IDX.ADAPTIVE_SCHEDULER_FAILCOUNT_MAX,
        min: 0,
        max: 255,
    },
    {
        key: 'PPG_REC_DUR_SECS',
        label: 'PPG Record Duration (s)',
        desc: '0 = always on',
        kind: 'u16',
        index: OP_IDX.PPG_REC_DUR_SECS_LSB,
        min: 0,
        max: 65535,
    },
    {
        key: 'PPG_REC_INT_MINS',
        label: 'PPG Record Interval (min)',
        desc: '0 = always on',
        kind: 'u16',
        index: OP_IDX.PPG_REC_INT_MINS_LSB,
        min: 0,
        max: 65535,
    },
    {
        key: 'SMP_AVE',
        label: 'PPG Sample Averaging',
        desc: 'FIFO sample averaging',
        kind: 'bit',
        index: OP_IDX.PPG_FIFO_CONFIG,
        shift: 5,
        width: 3,
        options: [
            [0, '1'],
            [1, '2'],
            [2, '4'],
            [3, '8'],
            [4, '16'],
            [5, '32'],
            [6, '32'],
            [7, '32'],
        ],
    },
    {
        key: 'PPG_ADC_RGE',
        label: 'PPG ADC Range',
        desc: 'ADC range / full-scale',
        kind: 'bit',
        index: OP_IDX.PPG_MODE_CONFIG2,
        shift: 5,
        width: 2,
        options: [
            [0, '7.8125 / 4096'],
            [1, '15.625 / 8192'],
            [2, '31.25 / 16384'],
            [3, '62.5 / 32768'],
        ],
    },
    {
        key: 'PPG_SR',
        label: 'PPG Sample Rate',
        desc: 'PPG sample rate',
        kind: 'bit',
        index: OP_IDX.PPG_MODE_CONFIG2,
        shift: 2,
        width: 3,
        options: [
            [0, '50 Hz'],
            [1, '100 Hz'],
            [2, '200 Hz'],
            [3, '400 Hz'],
            [4, '800 Hz'],
            [5, '1000 Hz'],
            [6, '1600 Hz'],
            [7, '3200 Hz'],
        ],
    },
    {
        key: 'PPG_LED_PW',
        label: 'PPG LED Pulse Width',
        desc: '50/100/200/400 us',
        kind: 'bit',
        index: OP_IDX.PPG_MODE_CONFIG2,
        shift: 0,
        width: 2,
        options: [
            [0, '50 us'],
            [1, '100 us'],
            [2, '200 us'],
            [3, '400 us'],
        ],
    },
    {
        key: 'PPG_MA_DEFAULT',
        label: 'PPG MA Default',
        desc: 'Default LED current (mA)',
        kind: 'u8',
        index: OP_IDX.PPG_MA_DEFAULT,
        min: 0,
        max: 255,
    },
    {
        key: 'PPG_MA_MAX_RED_IR',
        label: 'PPG MA Max Red/IR',
        desc: 'Max current for Red/IR (mA)',
        kind: 'u8',
        index: OP_IDX.PPG_MA_MAX_RED_IR,
        min: 0,
        max: 255,
    },
    {
        key: 'PPG_MA_MAX_GREEN_BLUE',
        label: 'PPG MA Max Green/Blue',
        desc: 'Max current for Green/Blue (mA)',
        kind: 'u8',
        index: OP_IDX.PPG_MA_MAX_GREEN_BLUE,
        min: 0,
        max: 255,
    },
    {
        key: 'PPG_AGC_TARGET_PERCENT_OF_RANGE',
        label: 'PPG AGC Target %',
        desc: 'AGC target percent of range',
        kind: 'u8',
        index: OP_IDX.PPG_AGC_TARGET_PERCENT_OF_RANGE,
        min: 0,
        max: 100,
    },
    {
        key: 'PPG_UNUSED_BYTE',
        label: 'PPG Unused Byte',
        desc: 'Reserved byte 65',
        kind: 'u8',
        index: 65,
        min: 0,
        max: 255,
    },
    {
        key: 'PPG_MA_LED_PILOT',
        label: 'PPG MA LED Pilot',
        desc: 'Pilot/proximity LED current',
        kind: 'u8',
        index: OP_IDX.PPG_MA_LED_PILOT,
        min: 0,
        max: 255,
    },
    {
        key: 'XTALK_DAC1',
        label: 'PPG DAC1 Crosstalk',
        desc: '5-bit value',
        kind: 'u8',
        index: OP_IDX.PPG_DAC1_CROSSTALK,
        min: 0,
        max: 31,
    },
    {
        key: 'XTALK_DAC2',
        label: 'PPG DAC2 Crosstalk',
        desc: '5-bit value',
        kind: 'u8',
        index: OP_IDX.PPG_DAC2_CROSSTALK,
        min: 0,
        max: 31,
    },
    {
        key: 'XTALK_DAC3',
        label: 'PPG DAC3 Crosstalk',
        desc: '5-bit value',
        kind: 'u8',
        index: OP_IDX.PPG_DAC3_CROSSTALK,
        min: 0,
        max: 31,
    },
    {
        key: 'XTALK_DAC4',
        label: 'PPG DAC4 Crosstalk',
        desc: '5-bit value',
        kind: 'u8',
        index: OP_IDX.PPG_DAC4_CROSSTALK,
        min: 0,
        max: 31,
    },
    {
        key: 'PROX_AGC_MODE',
        label: 'Proximity/AGC Mode',
        desc: '0 Disabled, 1 Driver approach, 2 Hybrid',
        kind: 'u8',
        index: OP_IDX.PROX_AGC_MODE,
        options: [
            [0, 'AGC Off / Prox Off'],
            [1, 'AGC On / Driver Prox'],
            [2, 'AGC On / Hybrid Prox'],
        ],
    },
    // -------------------------------------------------------------------------
    // v9 second-generation sensor settings (light / skin-temp / algo-hub / LED)
    // -------------------------------------------------------------------------
    // OP_CONFIG_VERSION (byte 9) is an internal layout marker, not a user setting.
    // It is auto-stamped on serialize (see VERISENSE_OP_CONFIG_VERSION_V9 /
    // createBlankVerisenseOperationalConfig), so it is intentionally NOT an
    // editable field here.
    // AMBIENT_LIGHT_EN / SKIN_TEMP_EN / ALGO_HUB_EN are sensor enables and are
    // rendered as checkboxes (see VERISENSE_SENSOR_ENABLE_FIELDS), not here.
    // GEN_CFG_3 bit 6 is reserved (was PPG_VIA_HUB): the MAX86176 is hardwired to
    // the hub, so raw PPG always arrives under the PPG sensor id (4) when a PPG
    // channel is enabled, and the algorithm output under id 8 when ALGO_HUB_EN is
    // set - no routing bit is needed.
    {
        key: 'LIGHT_GAIN_INDEX',
        label: 'Light Gain',
        // Default index 0 = 1.0x, matching the VD6283 reference example
        // (SetGain(..., 256), i.e. the 8.8 value 0x0100).
        desc: 'VD6283 channel gain (default 1.0x)',
        kind: 'u8',
        index: OP_IDX.LIGHT_GAIN_INDEX,
        min: 0,
        max: 7,
        options: [
            [0, '1.0x'],
            [1, '1.67x'],
            [2, '2.5x'],
            [3, '5.0x'],
            [4, '10.0x'],
            [5, '25.0x'],
            [6, '50.0x'],
            [7, '66.67x'],
        ],
    },
    {
        key: 'LIGHT_EXPOSURE_INDEX',
        label: 'Light Exposure',
        // Default index 0 = 100 ms (100000 us), matching the VD6283 reference
        // example (SetExposureTime(..., 100000)).
        desc: 'VD6283 exposure / integration time (default 100 ms). The chip cannot sample faster than it integrates, so the exposure caps the achievable sample rate at ~1/exposure (shown per option). Picking a higher sample rate therefore requires a shorter exposure.',
        kind: 'u8',
        index: OP_IDX.LIGHT_EXPOSURE_INDEX,
        min: 0,
        max: 7,
        // Label suffix = max sample rate this exposure allows (≈ 1/exposure, capped
        // at the 20 Hz poll ceiling).
        options: [
            [0, '100 ms (max 10 Hz)'],
            [1, '1.6 ms (max 20 Hz)'],
            [2, '6.4 ms (max 20 Hz)'],
            [3, '12.8 ms (max 20 Hz)'],
            [4, '25.6 ms (max 20 Hz)'],
            [5, '51.2 ms (max ~19 Hz)'],
            [6, '102.4 ms (max ~9.8 Hz)'],
            [7, '204.8 ms (max ~4.9 Hz)'],
        ],
    },
    // LIGHT_CONFIG bit 0 (continuous mode) is intentionally NOT exposed: the
    // VD6283 must run in continuous mode for the timer-driven poll to read it, so
    // the firmware hardcodes it. The op-config bit is left unused (free to
    // repurpose).
    {
        key: 'LIGHT_DARK_ENABLE',
        label: 'Light Dark Channel',
        desc: 'Replace the visible/clear channel reading with the dark (covered-photodiode) baseline',
        kind: 'bit',
        index: OP_IDX.LIGHT_CONFIG,
        shift: 1,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'LIGHT_FLICKER_EN',
        label: 'Light Flicker Detect',
        desc: 'RESERVED: VD6283 flicker detection (host PDM path pending nRF SDK v17 — not yet active)',
        kind: 'bit',
        index: OP_IDX.LIGHT_CONFIG,
        shift: 2,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled (reserved)'],
        ],
    },
    {
        key: 'LIGHT_SAMPLE_RATE_INDEX',
        label: 'Light Sample Rate',
        desc: 'Ambient-light sample rate. The firmware sets the VD6283 inter-measurement (continuous-mode) cadence to this period, so the sensor measures only as often as it is read and idles in between for lower power. The rate is limited by the exposure time (the chip cannot measure faster than it integrates): 20 Hz needs exposure ≤ 50 ms, 10 Hz needs ≤ 100 ms, etc. — see the Light Exposure options.',
        kind: 'u8',
        index: OP_IDX.LIGHT_SAMPLE_RATE_INDEX,
        min: 0,
        max: 6,
        options: [
            [0, 'Off'],
            [1, '0.5 Hz'],
            [2, '1 Hz'],
            [3, '2 Hz'],
            [4, '5 Hz'],
            [5, '10 Hz'],
            [6, '20 Hz'],
        ],
    },
    {
        key: 'SKIN_TEMP_MEAS_TYPE',
        label: 'Skin Temp Mode',
        desc: 'MLX90632 measurement type (default Medical for skin/body temperature)',
        kind: 'bit',
        index: OP_IDX.SKIN_TEMP_CONFIG,
        shift: 0,
        width: 1,
        options: [
            [0, 'Medical (25–42.5 °C, ±0.2 °C)'],
            [1, 'Extended (wider range, lower accuracy)'],
        ],
    },
    {
        // Single skin-temp rate setting. Stored as the MLX90632 refresh-rate code
        // (byte 76 bits 3:1); the firmware sets the chip refresh AND derives the read
        // poll from it. Shown as the *medical* output rate (= refresh ÷ 2; extended
        // mode is ÷ 3). The legacy poll field (byte 77) and power-mode bits (byte 76
        // bits 5:4) are now unused (free to repurpose) — continuous mode is required
        // and set automatically.
        key: 'SKIN_TEMP_SAMPLE_RATE',
        label: 'Skin Temp Sample Rate',
        desc: 'MLX90632 sample rate (medical output = chip refresh ÷2; extended ÷3). Drives both the chip refresh and the read poll. Byte 76 bits 3:1.',
        kind: 'bit',
        index: OP_IDX.SKIN_TEMP_CONFIG,
        shift: 1,
        width: 3,
        options: [
            [0, '0.25 Hz'],
            [1, '0.5 Hz'],
            [2, '1 Hz'],
            [3, '2 Hz'],
            [4, '4 Hz'],
            [5, '8 Hz'],
            [6, '16 Hz'],
            [7, '32 Hz'],
        ],
    },
    {
        key: 'ALGO_OP_MODE',
        label: 'Algo Operation Mode',
        desc: 'MAX32674 sensor-hub operation mode',
        kind: 'u8',
        index: OP_IDX.ALGO_OP_MODE,
        min: 0,
        max: 5,
        options: [
            [0, 'Raw'],
            [1, 'WHRM (HR)'],
            [3, 'IRN'],
            [4, 'HRV'],
            [5, 'RR'],
        ],
    },
    {
        key: 'ALGO_REPORT_MODE',
        label: 'Algo Report Mode',
        desc: 'Sensor-hub report mode',
        kind: 'bit',
        index: OP_IDX.ALGO_REPORT_MODE_RATE,
        shift: 0,
        width: 2,
        options: [
            [1, 'Basic'],
            [2, 'Extended'],
        ],
    },
    {
        key: 'ALGO_REPORT_PERIOD',
        label: 'Algo Report Period',
        desc: 'Sensor-hub report period code',
        kind: 'bit',
        index: OP_IDX.ALGO_REPORT_MODE_RATE,
        shift: 2,
        width: 6,
    },
    {
        key: 'ALGO_AEC_ENABLE',
        label: 'Algo Auto Exposure Control (AEC)',
        desc: 'Enable the WHRM/SpO2 automatic exposure control (AEC) loop for the optical PPG AFE. Not related to ECG.',
        kind: 'bit',
        index: OP_IDX.ALGO_CONTROL,
        shift: 0,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'ALGO_SCD_ENABLE',
        label: 'Algo Skin Contact Detect',
        desc: 'Enable skin-contact detection',
        kind: 'bit',
        index: OP_IDX.ALGO_CONTROL,
        shift: 1,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'ALGO_AUTO_PD_ENABLE',
        label: 'Algo Auto PD Current',
        desc: 'Enable automatic photodiode current control',
        kind: 'bit',
        index: OP_IDX.ALGO_CONTROL,
        shift: 2,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'ALGO_INITIAL_HR',
        label: 'Algo Initial HR',
        desc: 'Optional WHRM initial heart-rate seed (bpm, 0 = none)',
        kind: 'u8',
        index: OP_IDX.ALGO_INITIAL_HR,
        min: 0,
        max: 255,
    },
    {
        key: 'LED_AUTO_BRIGHTNESS_ENABLE',
        label: 'LED Auto-Brightness',
        desc: 'Drive RGB LED brightness from ambient light',
        kind: 'bit',
        index: OP_IDX.LED_AUTO_BRIGHTNESS_CFG,
        shift: 0,
        width: 1,
        options: [
            [0, 'Disabled'],
            [1, 'Enabled'],
        ],
    },
    {
        key: 'LED_MAX_BRIGHTNESS',
        label: 'LED Max Brightness',
        desc: 'Ceiling for auto-brightness mode (0-255)',
        kind: 'u8',
        index: OP_IDX.LED_MAX_BRIGHTNESS,
        min: 0,
        max: 255,
    },
    {
        key: 'LED_LUX_THRESHOLD',
        label: 'LED Lux Threshold',
        desc: 'Below this ambient level the LED stays at max brightness',
        kind: 'u16',
        index: OP_IDX.LED_LUX_THRESHOLD,
        min: 0,
        max: 65535,
    },
    {
        key: 'PERSON_HEIGHT_CM',
        label: 'Height',
        desc: 'Subject height for the MAX32674 algorithm suite (cm)',
        kind: 'u16',
        index: OP_IDX.PERSON_HEIGHT_CM,
        min: 50,
        max: 250,
    },
    {
        key: 'PERSON_WEIGHT_KG',
        label: 'Weight',
        desc: 'Subject weight for the MAX32674 algorithm suite (kg)',
        kind: 'u16',
        index: OP_IDX.PERSON_WEIGHT_KG,
        min: 10,
        max: 300,
    },
    {
        key: 'PERSON_AGE',
        label: 'Age',
        desc: 'Subject age for the MAX32674 algorithm suite (years)',
        kind: 'u8',
        index: OP_IDX.PERSON_AGE,
        min: 0,
        max: 120,
    },
    {
        key: 'PERSON_GENDER',
        label: 'Gender',
        desc: 'Subject gender for the MAX32674 algorithm suite',
        kind: 'u8',
        index: OP_IDX.PERSON_GENDER,
        min: 0,
        max: 1,
        options: [
            [0, 'Male'],
            [1, 'Female'],
        ],
    },
];
const VERISENSE_OP_CONFIG_BYTE_SIZE = 92;
function createBlankVerisenseOperationalConfig(byteSize = VERISENSE_OP_CONFIG_BYTE_SIZE) {
    const blank = new Uint8Array(byteSize);
    blank[0] = 0x5a;
    // Stamp the layout version so v9-sized configs are recognised as second-gen.
    if (byteSize >= VERISENSE_OP_CONFIG_BYTE_SIZE) {
        blank[OP_IDX.OP_CONFIG_VERSION] = OP_CONFIG_VERSION_V9;
        // Seed the MAX32674 subject parameters with the Maxim algorithm defaults
        // (height 175 cm, weight 78 kg, age 30 yr, gender Male) so the UI shows
        // sane values rather than blanks. u16 fields are little-endian.
        blank[OP_IDX.PERSON_HEIGHT_CM] = 175 & 0xff;
        blank[OP_IDX.PERSON_HEIGHT_CM + 1] = (175 >> 8) & 0xff;
        blank[OP_IDX.PERSON_WEIGHT_KG] = 78 & 0xff;
        blank[OP_IDX.PERSON_WEIGHT_KG + 1] = (78 >> 8) & 0xff;
        blank[OP_IDX.PERSON_AGE] = 30;
        blank[OP_IDX.PERSON_GENDER] = 0;
    }
    return blank;
}
function clampInt(v, min, max) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n))
        return min;
    return Math.max(min, Math.min(max, n));
}
function readVerisenseOperationalFieldValue(op, field) {
    if (field.kind === 'bit') {
        const width = field.width ?? 1;
        const shift = field.shift ?? 0;
        const mask = (1 << width) - 1;
        return (op[field.index] >> shift) & mask;
    }
    if (field.kind === 'u8')
        return op[field.index] & 0xff;
    if (field.kind === 'u16') {
        return (op[field.index] & 0xff) | ((op[field.index + 1] & 0xff) << 8);
    }
    if (field.kind === 'u32') {
        return (((op[field.index] & 0xff) |
            ((op[field.index + 1] & 0xff) << 8) |
            ((op[field.index + 2] & 0xff) << 16) |
            ((op[field.index + 3] & 0xff) << 24)) >>>
            0);
    }
    if (field.kind === 'inactiveResume') {
        return op[field.index] & (0x01 << 6) ? 1 : 0;
    }
    if (field.kind === 'inactiveMinutes') {
        return op[field.index] & 0x3f;
    }
    return 0;
}
function writeVerisenseOperationalFieldValue(op, field, rawValue) {
    if (field.kind === 'bit') {
        const width = field.width ?? 1;
        const shift = field.shift ?? 0;
        const mask = (1 << width) - 1;
        const value = clampInt(rawValue, 0, mask);
        op[field.index] = (op[field.index] & ~(mask << shift)) | ((value & mask) << shift);
        return;
    }
    if (field.kind === 'u8') {
        op[field.index] = clampInt(rawValue, field.min ?? 0, field.max ?? 255) & 0xff;
        return;
    }
    if (field.kind === 'u16') {
        const value = clampInt(rawValue, field.min ?? 0, field.max ?? 65535);
        op[field.index] = value & 0xff;
        op[field.index + 1] = (value >> 8) & 0xff;
        return;
    }
    if (field.kind === 'u32') {
        const value = clampInt(rawValue, field.min ?? 0, field.max ?? 4294967295) >>> 0;
        op[field.index] = value & 0xff;
        op[field.index + 1] = (value >> 8) & 0xff;
        op[field.index + 2] = (value >> 16) & 0xff;
        op[field.index + 3] = (value >> 24) & 0xff;
        return;
    }
    if (field.kind === 'inactiveResume') {
        const enabled = clampInt(rawValue, 0, 1) === 1;
        op[field.index] = enabled ? op[field.index] | (0x01 << 6) : op[field.index] & -65;
        return;
    }
    if (field.kind === 'inactiveMinutes') {
        const minutes = clampInt(rawValue, field.min ?? 0, field.max ?? 63) & 0x3f;
        op[field.index] = (op[field.index] & 0xc0) | minutes;
    }
}
function setVerisenseOperationalBitRange(op, index, shift, width, rawValue) {
    const mask = (1 << width) - 1;
    const value = clampInt(rawValue, 0, mask);
    op[index] = (op[index] & ~(mask << shift)) | ((value & mask) << shift);
}
/** GEN_CFG_0 bit masks for the two host comms channels (see byte map / firmware
 * ASM_definitions.h). */
const GEN_CFG_0_BLUETOOTH_EN_MASK = 1 << 4;
const GEN_CFG_0_USB_EN_MASK = 1 << 3;
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
function enforceVerisenseCommsChannelInterlock(op) {
    if (!op || op.length <= OP_IDX.GEN_CFG_0)
        return false;
    const genCfg0 = op[OP_IDX.GEN_CFG_0];
    const bothDisabled = (genCfg0 & GEN_CFG_0_BLUETOOTH_EN_MASK) === 0 && (genCfg0 & GEN_CFG_0_USB_EN_MASK) === 0;
    if (!bothDisabled)
        return false;
    op[OP_IDX.GEN_CFG_0] = genCfg0 | GEN_CFG_0_BLUETOOTH_EN_MASK | GEN_CFG_0_USB_EN_MASK;
    return true;
}
const VERISENSE_SENSOR_ENABLE_FIELDS = [
    { key: 'ACCEL_1_EN', index: OP_IDX.GEN_CFG_0, shift: 7 },
    { key: 'ACCEL_2_EN', index: OP_IDX.GEN_CFG_0, shift: 6 },
    { key: 'GYRO_EN', index: OP_IDX.GEN_CFG_0, shift: 5 },
    { key: 'MAG_EN', index: OP_IDX.GEN_CFG_3, shift: 2 },
    { key: 'GSR_EN', index: OP_IDX.GEN_CFG_1, shift: 7 },
    { key: 'PPG_GREEN_EN', index: OP_IDX.GEN_CFG_1, shift: 6 },
    { key: 'PPG_RED_EN', index: OP_IDX.GEN_CFG_1, shift: 5 },
    { key: 'PPG_IR_EN', index: OP_IDX.GEN_CFG_1, shift: 4 },
    { key: 'ECG_EN', index: OP_IDX.GEN_CFG_1, shift: 3 },
    { key: 'PPG_BLUE_EN', index: OP_IDX.GEN_CFG_1, shift: 2 },
    { key: 'VPROG_EN', index: OP_IDX.GEN_CFG_2, shift: 2 },
    { key: 'VBATT_EN', index: OP_IDX.GEN_CFG_2, shift: 1 },
    // v9 second-generation sensors. On 2nd-gen the raw PPG (id 4) is gated by the
    // existing PPG channel enables above; ALGO_HUB_EN gates the algorithm (id 8).
    { key: 'AMBIENT_LIGHT_EN', index: OP_IDX.GEN_CFG_3, shift: 3 },
    { key: 'SKIN_TEMP_EN', index: OP_IDX.GEN_CFG_3, shift: 4 },
    { key: 'ALGO_HUB_EN', index: OP_IDX.GEN_CFG_3, shift: 5 },
];
const VERISENSE_OPERATIONAL_FIELD_GROUPS = [
    {
        id: 'gen',
        title: 'General / Sensors',
        openByDefault: false,
        keys: [
            'BLUETOOTH_EN',
            'USB_EN',
            'DEVICE_EN',
            'RECORDING_EN',
            'DATA_COMPRESSION_MODE',
            'HR_PPG_CHANNEL',
            'STEP_COUNT_EN',
            'PENDING_EVENTS_SCHEDULER_DISABLED',
            'BATT_TYPE',
            'MAG_EN',
            'LED_MODE',
        ],
    },
    {
        id: 'accel1',
        title: 'Accel1',
        openByDefault: false,
        keys: [
            'ODR',
            'MODE',
            'LP_MODE',
            'BW_FILT',
            'FS',
            'FDS',
            'LOW_NOISE',
            'HP_REF_MODE',
            'FMode',
            'FTH',
        ],
    },
    {
        id: 'gyro_accel2',
        title: 'Gyro / Accel2',
        openByDefault: false,
        keys: [
            'FTH_LSB',
            'TIMER_PEDO_FIFDO_EN',
            'TIMER_PEDO_FIFO_DRDY',
            'FTH_MSB',
            'DEC_FIFO_GYRO',
            'DEC_FIFO_XL',
            'ODR_FIFO',
            'FIFO_MODE',
            'ODR_XL',
            'FS_XL',
            'BW_XL',
            'ODR_G',
            'FS_G',
            'FS_125',
            'G_HM_MODE',
            'HP_G_EN',
            'HPCF_G',
            'HP_G_RST',
            'ROUNDING_STATUS',
            'LPF2_XL_EN',
            'HPCF_XL',
            'HP_SLOPE_XL_EN',
            'LOW_PASS_ON_6D',
        ],
    },
    {
        id: 'lsm6dsv',
        title: 'Accel / Gyro / Mag',
        openByDefault: false,
        keys: ['LSM6DSV_ODR_XL', 'LSM6DSV_FS_XL', 'LSM6DSV_ODR_G', 'LSM6DSV_FS_G', 'LIS2MDL_ODR'],
    },
    {
        id: 'scheduler_ble',
        title: 'Schedule / BLE Wake',
        openByDefault: false,
        keys: [
            'START_TIME',
            'END_TIME',
            'RESUME_REC_ON_ACTIVITY',
            'INACTIVE_TIMEOUT_MINUTES',
            'BLE_CONNECTION_TRIES_PER_DAY',
            'BLE_TX_POWER',
            'BLE_DATA_TRANS_WKUP_INT_HOURS',
            'BLE_DATA_TRANS_WKUP_TIME',
            'BLE_DATA_TRANS_WKUP_DUR',
            'BLE_DATA_TRANS_RETRY_INT',
            'BLE_STATUS_WKUP_INT_HOURS',
            'BLE_STATUS_WKUP_TIME',
            'BLE_STATUS_WKUP_DUR',
            'BLE_STATUS_RETRY_INT',
            'BLE_RTC_SYNC_WKUP_INT_HOURS',
            'BLE_RTC_SYNC_WKUP_TIME',
            'BLE_RTC_SYNC_WKUP_DUR',
            'BLE_RTC_SYNC_RETRY_INT',
        ],
    },
    {
        id: 'adc_gsr',
        title: 'ADC / GSR',
        openByDefault: false,
        keys: [
            'ADC_SAMPLE_RATE',
            'ADC_OVERSAMPLE_RATE',
            'GSR_RANGE_SETTING',
            'ADAPTIVE_SCHEDULER_INTERVAL',
            'ADAPTIVE_SCHEDULER_FAILCOUNT_MAX',
        ],
    },
    {
        id: 'ppg',
        title: 'PPG',
        openByDefault: false,
        keys: [
            'PPG_REC_DUR_SECS',
            'PPG_REC_INT_MINS',
            'SMP_AVE',
            'PPG_ADC_RGE',
            'PPG_SR',
            'PPG_LED_PW',
            'PPG_MA_DEFAULT',
            'PPG_MA_MAX_RED_IR',
            'PPG_MA_MAX_GREEN_BLUE',
            'PPG_AGC_TARGET_PERCENT_OF_RANGE',
            'PPG_UNUSED_BYTE',
            'PPG_MA_LED_PILOT',
            'XTALK_DAC1',
            'XTALK_DAC2',
            'XTALK_DAC3',
            'XTALK_DAC4',
            'PROX_AGC_MODE',
        ],
    },
    {
        id: 'light',
        title: 'Ambient Light',
        openByDefault: false,
        keys: [
            'LIGHT_GAIN_INDEX',
            'LIGHT_EXPOSURE_INDEX',
            'LIGHT_DARK_ENABLE',
            'LIGHT_FLICKER_EN',
            'LIGHT_SAMPLE_RATE_INDEX',
        ],
    },
    {
        id: 'skin_temp',
        title: 'Skin Temperature',
        openByDefault: false,
        keys: ['SKIN_TEMP_MEAS_TYPE', 'SKIN_TEMP_SAMPLE_RATE'],
    },
    {
        id: 'algo',
        title: 'Algorithm Hub',
        openByDefault: false,
        keys: [
            'ALGO_OP_MODE',
            'ALGO_REPORT_MODE',
            'ALGO_REPORT_PERIOD',
            'ALGO_AEC_ENABLE',
            'ALGO_SCD_ENABLE',
            'ALGO_AUTO_PD_ENABLE',
            'ALGO_INITIAL_HR',
        ],
    },
    {
        id: 'person',
        title: 'Subject / Person Parameters',
        openByDefault: false,
        keys: ['PERSON_AGE', 'PERSON_HEIGHT_CM', 'PERSON_WEIGHT_KG', 'PERSON_GENDER'],
    },
    {
        id: 'led',
        title: 'LED Auto-Brightness',
        openByDefault: false,
        keys: ['LED_AUTO_BRIGHTNESS_ENABLE', 'LED_MAX_BRIGHTNESS', 'LED_LUX_THRESHOLD'],
    },
];
const VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID = 'gen';
/**
 * Maps each hardware-gated operational-config group id to the sensor block that
 * gates it (see {@link VerisenseHardwareSensorSupport}). Group ids absent from
 * this map (e.g. `gen`, `scheduler_ble`) configure behaviour that applies to
 * every board and are always considered supported.
 */
const VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR = {
    accel1: 'accel1',
    gyro_accel2: 'gyroAccel2',
    lsm6dsv: 'imuGen2',
    adc_gsr: 'gsr',
    ppg: 'ppg',
    light: 'ambientLight',
    skin_temp: 'skinTemperature',
    algo: 'algorithmHub',
    person: 'algorithmHub',
    led: 'ledAutoBrightness',
};
/**
 * Returns the set of operational-config group ids (from
 * {@link VERISENSE_OPERATIONAL_FIELD_GROUPS}) whose underlying sensor is present
 * on the given hardware revision. A group is supported when it is not gated by a
 * sensor block, or when its gating sensor is present.
 *
 * Returns `null` when the hardware revision is unknown so callers can fall back
 * to showing every group.
 */
function getVerisenseSupportedOperationalFieldGroupIds(source) {
    const hw = getVerisenseHardwareRevision(source);
    if (!hw)
        return null;
    const support = getVerisenseHardwareSensorSupport(hw.major, hw.minor);
    const supported = new Set();
    for (const group of VERISENSE_OPERATIONAL_FIELD_GROUPS) {
        const sensorKey = VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR[group.id];
        if (!sensorKey || support[sensorKey])
            supported.add(group.id);
    }
    return supported;
}
/** LIGHT_CONFIG bit 1 is the VD6283 dark-channel select: when set, the shared
 * visible/clear slot carries the dark (covered-photodiode) baseline instead of
 * the visible reading. Returns false for empty/nullish config. */
function isVerisenseLightDarkChannelEnabled(op) {
    if (!op?.length)
        return false;
    return ((op[OP_IDX.LIGHT_CONFIG] ?? 0) & (1 << 1)) !== 0;
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
        /**
         * Per-device calibration read from the sensor, or null when none is available
         * (decoders then fall back to nominal full-scale/datasheet scaling). Set via
         * {@link applyCalibration}; subclasses read it in their calibrate routines.
         */
        this.calibration = null;
    }
    /** Supply (or clear) the device calibration set used by this decoder. */
    applyCalibration(set) {
        this.calibration = set;
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
    computeSampleTimestamps(decodedSamples, block) {
        const num = decodedSamples.length;
        const out = new Array(num);
        for (let i = 0; i < num; i++) {
            out[i] = this.extrapolateSampleTimes({
                numSamples: num,
                i,
                samplingRateHz: this.samplingRateHz,
                tsLastSampleMillis: block.tsLastSampleMillis,
                systemTsLastSampleMillis: block.systemTsLastSampleMillis,
                systemOffsetFirstTime: block.systemOffsetFirstTime,
            });
        }
        return out;
    }
    /**
     * Turn a decoded + timestamped burst into one or more stream contributions
     * for live throughput / packet-loss tracking. The default treats the sensor
     * as a single stream; sensors whose decoded array interleaves several
     * sub-streams at different cadences (e.g. the LSM6DSV tagged FIFO) override
     * this to report one contribution per sub-stream so loss is tracked
     * independently.
     */
    getStreamContributions(samplesWithTime, sensorId) {
        let first = null;
        let last = null;
        for (const s of samplesWithTime) {
            const t = s?.timestamps?.tsMillis;
            if (typeof t !== 'number')
                continue;
            if (first == null || t < first)
                first = t;
            if (last == null || t > last)
                last = t;
        }
        return [
            {
                key: String(sensorId),
                label: `Sensor ${sensorId}`,
                samplingRateHz: this.samplingRateHz,
                sampleCount: samplesWithTime.length,
                firstSampleMillis: first,
                lastSampleMillis: last,
            },
        ];
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
        this.hwRevisionMajor = null;
        this.hwRevisionMinor = null;
        this.hwRevisionInternal = null;
        // Decoded from opConfig for debug/display
        this.gsrRateSettingRaw = 0;
        this.gsrRangeSettingRaw = 0;
        this.gsrOversamplingRateSettingRaw = 0;
        this.samplingRateHz = 50;
    }
    setHardwareIdentifier(idStr) {
        this.hardwareIdentifier = idStr;
    }
    setHardwareRevision(revHwMajor, revHwMinor, revHwInternal = 0) {
        this.hwRevisionMajor = Number.isFinite(revHwMajor) ? Math.trunc(revHwMajor) : null;
        this.hwRevisionMinor = Number.isFinite(revHwMinor) ? Math.trunc(revHwMinor) : null;
        this.hwRevisionInternal = Number.isFinite(revHwInternal) ? Math.trunc(revHwInternal) : null;
    }
    setGsrRangeSetting(v) {
        this.gsrRangeSetting = v;
    }
    getBatteryVoltageMultiplier() {
        if (this.hwRevisionMajor != null && this.hwRevisionMinor != null) {
            return getVerisenseStreamingBatteryVoltageMultiplier(this.hwRevisionMajor, this.hwRevisionMinor);
        }
        // Backward-compatible fallback when production config revision is unavailable.
        if (this.hardwareIdentifier === 'VERISENSE_GSR_PLUS')
            return 2.0;
        return 1.0;
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
    /**
     * Convert the 6-bit ADC sample-rate code to the streamed output rate in Hz,
     * or null for "Off"/unknown codes. Used for per-sample timestamp spacing.
     */
    decodeAdcSampleRateHz(rateCode) {
        const divisor = SensorADC.ADC_RATE_DIVISORS[rateCode];
        if (!divisor)
            return null;
        return SensorBase.CLOCK_FREQ / divisor;
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
                mv *= this.getBatteryVoltageMultiplier();
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
        // Drive per-sample timestamp spacing from the configured ADC rate. Without
        // this, samplingRateHz stays at the constructor default (50 Hz); when the
        // real rate differs, computeSampleTimestamps mis-spaces samples and
        // consecutive blocks overlap on the time axis (the GSR "zigzag").
        const rateHz = this.decodeAdcSampleRateHz(rateCfg);
        if (rateHz)
            this.samplingRateHz = rateHz;
        if (rangeCfg >= 0 && rangeCfg <= 4) {
            this.gsrRangeSetting = rangeCfg;
        }
    }
}
/**
 * ADC sample-rate code → divisor of the 32768 Hz clock. Mirrors the firmware
 * `samplingRateInTicksArray` (hal_adc.c): the sampling timer fires every
 * `divisor` ticks, producing one sample set per fire, so the streamed output
 * rate = 32768 / divisor. Oversampling uses SAADC burst mode and therefore
 * does NOT divide the output rate. Index 0 = "Off".
 */
SensorADC.ADC_RATE_DIVISORS = [
    0, 1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 128, 160, 200, 256, 320, 400, 512,
    640, 800, 1024, 1280, 1600, 2048, 2560, 3200, 4096, 5120, 6400, 8192, 10240, 12800, 16384,
    20480, 25600, 32768, 40960, 51200,
];

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
        /** Numeric full-scale index (0=2G..3=16G) used to select the device calibration block. */
        this.rangeIndex = 0;
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
        // Prefer per-device calibration from the sensor when available for this range.
        const dev = this.calibration?.getImu(CalibSensorId.LIS2DW12_ACCEL, this.rangeIndex);
        if (dev)
            return applyImuCalibration(raw, dev);
        // Fallback: nominal offset / alignment / datasheet sensitivity.
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
        this.rangeIndex = rangeSetting & 0x03;
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
        // Applied directly as `physical = align · (raw − offset)` (no inversion), so this
        // must be the *inverse* alignment R⁻¹ = Rᵀ — matching the Shimmer Java reference
        // `UtilCalibration` (C = R⁻¹·K⁻¹·(U−B)) and the gen-1 calibration doc's R, which
        // is the forward §8 rotation. (Previously stored the un-transposed R, which
        // applied R instead of R⁻¹.)
        this.align = [
            [0, -1, 0],
            [0, 0, -1],
            [1, 0, 0],
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
    _calibrateAccel(raw) {
        const dev = this.calibration?.getImu(CalibSensorId.LSM6DS3_ACCEL, SensorLSM6DS3.ACC_RANGE_CODE[this.accRange]);
        if (dev)
            return applyImuCalibration(raw, dev);
        const aligned = this._applyAlignAndOffset(raw);
        const s = this.accSensByRange[this.accRange];
        return [aligned[0] / s[0], aligned[1] / s[1], aligned[2] / s[2]];
    }
    _calibrateGyro(raw) {
        const dev = this.calibration?.getImu(CalibSensorId.LSM6DS3_GYRO, SensorLSM6DS3.GYRO_RANGE_CODE[this.gyroRange]);
        if (dev)
            return applyImuCalibration(raw, dev);
        const aligned = this._applyAlignAndOffset(raw);
        const s = this.gyroSensByRange[this.gyroRange];
        return [aligned[0] / s[0], aligned[1] / s[1], aligned[2] / s[2]];
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
                accCal = this._calibrateAccel(accRaw);
            }
            if (gyroRaw) {
                gyroCal = this._calibrateGyro(gyroRaw);
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
// Calibration-block range codes (must match getVerisenseCalibrationSensors gen-1).
SensorLSM6DS3.ACC_RANGE_CODE = {
    '2G': 0,
    '4G': 1,
    '8G': 2,
    '16G': 3,
};
SensorLSM6DS3.GYRO_RANGE_CODE = {
    '250DPS': 0,
    '500DPS': 1,
    '1000DPS': 2,
    '2000DPS': 3,
};

class SensorLSM6DSV extends SensorBase {
    constructor() {
        super();
        this.accEnabled = true;
        this.gyroEnabled = true;
        this.magEnabled = true;
        this.accelFsG = 2;
        this.gyroFsDps = 2000;
        // Numeric full-scale codes (register values) used to select the device
        // calibration block: accel 0..3 (2/4/8/16 g), gyro 0..4 (125..2000 dps).
        this.fsXlCode = 0;
        this.fsGCode = 4;
        // Configured per-stream rates (the FIFO interleaves accel/gyro/mag, so each
        // stream is timestamped on its own rate — see computeSampleTimestamps). Public
        // so the per-sub-stream loss tracking (getStreamContributions) can read each.
        // accelHz/gyroHz are the configured LSM6DSV ODRs; magHz is the configured
        // magnetometer output (sensor-hub) rate. The firmware FIFO-batches accel/gyro
        // at their ODR, so they deliver at the configured rate; the mag is still
        // bounded by the accel/gyro hub trigger, so a mag rate above the accel/gyro
        // ODR delivers slower — which shows up as packet loss.
        this.accelHz = 15;
        this.gyroHz = 15;
        this.magHz = 15;
        this.samplingRateHz = 15;
    }
    decodeAccelFsG(code) {
        switch (code) {
            case 0:
                return 2;
            case 1:
                return 4;
            case 2:
                return 8;
            case 3:
                return 16;
            default:
                return 2;
        }
    }
    decodeGyroFsDps(code) {
        // LSM6DSV FS_G datasheet register values.
        switch (code) {
            case 0:
                return 125;
            case 1:
                return 250;
            case 2:
                return 500;
            case 3:
                return 1000;
            case 4:
                return 2000;
            default:
                return 2000;
        }
    }
    decodeOdrHz(code) {
        // LSM6DSV ODR_XL / ODR_G datasheet register values (normal mode).
        switch (code) {
            case 0:
                return 0; // Off
            case 1:
                return 1.875;
            case 2:
                return 7.5;
            case 3:
                return 15;
            case 4:
                return 30;
            case 5:
                return 60;
            case 6:
                return 120;
            case 7:
                return 240;
            case 8:
                return 480;
            case 9:
                return 960;
            case 10:
                return 1920;
            case 11:
                return 3840;
            case 12:
                return 7680;
            default:
                return 15;
        }
    }
    decodeMagOutputRateHz(code) {
        // Magnetometer output (sensor-hub) rate code from op-config byte 20 bits 1:0.
        // This is the rate mag samples reach the host; the firmware derives the
        // underlying LIS2MDL ODR (20/50/100/100 Hz) to keep a fresh sample available.
        switch (code) {
            case 0:
                return 15;
            case 1:
                return 30;
            case 2:
                return 60;
            case 3:
                return 120;
            default:
                return 15;
        }
    }
    calibrateAccel(raw) {
        const dev = this.calibration?.getImu(CalibSensorId.LSM6DSV_ACCEL, this.fsXlCode);
        if (dev)
            return applyImuCalibration(raw, dev);
        const scale = (this.accelFsG / 32768) * 9.80665;
        return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
    }
    calibrateGyro(raw) {
        const dev = this.calibration?.getImu(CalibSensorId.LSM6DSV_GYRO, this.fsGCode);
        if (dev)
            return applyImuCalibration(raw, dev);
        const scale = this.gyroFsDps / 32768;
        return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
    }
    calibrateMag(raw) {
        const dev = this.calibration?.getImu(CalibSensorId.LIS2MDL_MAG, 0);
        if (dev)
            return applyImuCalibration(raw, dev);
        // LIS2MDL nominal sensitivity is 1.5 mGauss/LSB (0.15 uT/LSB).
        const scale = 0.15;
        return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
    }
    parsePayload(sensorPayloadBytes) {
        if (!sensorPayloadBytes?.length)
            return [];
        // Entry count is a 16-bit little-endian value (a full FIFO drain can return
        // more than 255 samples), followed by `count` x 7-byte tagged entries.
        const entryCount = ((sensorPayloadBytes[0] ?? 0) | ((sensorPayloadBytes[1] ?? 0) << 8)) >>> 0;
        const maxEntriesByLength = Math.floor((sensorPayloadBytes.length - 2) / 7);
        const n = Math.min(entryCount, maxEntriesByLength);
        const out = [];
        let offset = 2;
        for (let i = 0; i < n; i++) {
            const tagCnt = sensorPayloadBytes[offset];
            const tag = (tagCnt >> 3) & 0x1f;
            const cnt = (tagCnt >> 1) & 0x03;
            const x = i16le(sensorPayloadBytes, offset + 1);
            const y = i16le(sensorPayloadBytes, offset + 3);
            const z = i16le(sensorPayloadBytes, offset + 5);
            const raw = [x, y, z];
            let accel = null;
            let gyro = null;
            let mag = null;
            if (tag === SensorLSM6DSV.TAG_ACCEL && this.accEnabled) {
                accel = { raw, cal: this.calibrateAccel(raw), units: 'm/s^2' };
            }
            else if (tag === SensorLSM6DSV.TAG_GYRO && this.gyroEnabled) {
                gyro = { raw, cal: this.calibrateGyro(raw), units: 'deg/s' };
            }
            else if (tag === SensorLSM6DSV.TAG_SENSORHUB_SLAVE0 && this.magEnabled) {
                mag = { raw, cal: this.calibrateMag(raw), units: 'uT' };
            }
            if (accel || gyro || mag) {
                out.push({ tag, cnt, accel, gyro, mag });
            }
            offset += 7;
        }
        return out;
    }
    applyOperationalConfig(op) {
        this.accEnabled = (op[OP_IDX.GEN_CFG_0] & 0b01000000) !== 0;
        this.gyroEnabled = (op[OP_IDX.GEN_CFG_0] & 0b00100000) !== 0;
        this.magEnabled = (op[OP_IDX.GEN_CFG_3] & 0b00000100) !== 0;
        const cfg0 = op[OP_IDX.LSM6DSV_CFG_0] ?? 0;
        const cfg1 = op[OP_IDX.LSM6DSV_CFG_1] ?? 0;
        const cfg2 = op[OP_IDX.LSM6DSV_CFG_2] ?? 0;
        const odrXl = cfg0 & 0x0f;
        const fsXl = (cfg0 >> 4) & 0x03;
        const odrG = cfg1 & 0x0f;
        const fsG = (cfg1 >> 4) & 0x0f;
        const odrMag = cfg2 & 0x03;
        this.accelFsG = this.decodeAccelFsG(fsXl);
        this.gyroFsDps = this.decodeGyroFsDps(fsG);
        this.fsXlCode = fsXl;
        this.fsGCode = fsG;
        this.accelHz = this.accEnabled ? this.decodeOdrHz(odrXl) : 0;
        this.gyroHz = this.gyroEnabled ? this.decodeOdrHz(odrG) : 0;
        // Configured mag output rate (NOT capped at the accel/gyro trigger). Loss is
        // measured against this, so when the accel/gyro that trigger the sensor hub
        // are too slow to deliver it, the shortfall surfaces as mag loss.
        this.magHz = this.magEnabled ? this.decodeMagOutputRateHz(odrMag) : 0;
        this.samplingRateHz = Math.max(this.accelHz, this.gyroHz, this.magHz, 1);
    }
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
    computeSampleTimestamps(decodedSamples, block) {
        const samples = decodedSamples;
        let accelTotal = 0;
        let gyroTotal = 0;
        let magTotal = 0;
        for (const s of samples) {
            if (s.accel)
                accelTotal++;
            else if (s.gyro)
                gyroTotal++;
            else if (s.mag)
                magTotal++;
        }
        // Block duration (s) from a directly-sampled reference stream at a known ODR.
        let blockPeriodSec = 0;
        if (accelTotal > 0 && this.accelHz > 0)
            blockPeriodSec = accelTotal / this.accelHz;
        else if (gyroTotal > 0 && this.gyroHz > 0)
            blockPeriodSec = gyroTotal / this.gyroHz;
        else if (magTotal > 0 && this.magHz > 0)
            blockPeriodSec = magTotal / this.magHz;
        // Effective per-stream rate so each stream spans exactly blockPeriodSec.
        const rateFor = (total) => blockPeriodSec > 0 && total > 0 ? total / blockPeriodSec : (this.samplingRateHz ?? 1);
        const accelRate = rateFor(accelTotal);
        const gyroRate = rateFor(gyroTotal);
        const magRate = rateFor(magTotal);
        let ai = 0;
        let gi = 0;
        let mi = 0;
        return samples.map((s) => {
            let numSamples = samples.length;
            let i = 0;
            let rate = this.samplingRateHz;
            if (s.accel) {
                numSamples = accelTotal;
                i = ai++;
                rate = accelRate;
            }
            else if (s.gyro) {
                numSamples = gyroTotal;
                i = gi++;
                rate = gyroRate;
            }
            else if (s.mag) {
                numSamples = magTotal;
                i = mi++;
                rate = magRate;
            }
            return this.extrapolateSampleTimes({
                numSamples,
                i,
                samplingRateHz: rate,
                tsLastSampleMillis: block.tsLastSampleMillis,
                systemTsLastSampleMillis: block.systemTsLastSampleMillis,
                systemOffsetFirstTime: block.systemOffsetFirstTime,
            });
        });
    }
    /**
     * Report up to three independent sub-streams (accel / gyro / mag) so loss is
     * tracked per stream. Each sub-stream's expected rate is its configured rate
     * (ODR for accel/gyro, output rate for mag); loss is measured against that, so
     * the mag's hub-trigger bound — or any rate the firmware/link can't keep up
     * with — surfaces as loss when a configured rate exceeds what's delivered.
     */
    getStreamContributions(samplesWithTime, sensorId) {
        const samples = samplesWithTime;
        const subs = [
            {
                key: `${sensorId}:accel`,
                label: 'Accel',
                rate: this.accelHz,
                has: (s) => !!s.accel,
            },
            {
                key: `${sensorId}:gyro`,
                label: 'Gyro',
                rate: this.gyroHz,
                has: (s) => !!s.gyro,
            },
            // Mag enters the FIFO at its configured sensor-hub output rate (`magHz`).
            { key: `${sensorId}:mag`, label: 'Mag', rate: this.magHz, has: (s) => !!s.mag },
        ];
        const out = [];
        for (const sub of subs) {
            let count = 0;
            let first = null;
            let last = null;
            for (const s of samples) {
                if (!sub.has(s))
                    continue;
                count++;
                const t = s?.timestamps?.tsMillis;
                if (typeof t !== 'number')
                    continue;
                if (first == null || t < first)
                    first = t;
                if (last == null || t > last)
                    last = t;
            }
            if (count === 0)
                continue; // disabled or no samples in this burst
            out.push({
                key: sub.key,
                label: sub.label,
                samplingRateHz: sub.rate > 0 ? sub.rate : null,
                sampleCount: count,
                firstSampleMillis: first,
                lastSampleMillis: last,
            });
        }
        return out;
    }
}
SensorLSM6DSV.TAG_GYRO = 0x01;
SensorLSM6DSV.TAG_ACCEL = 0x02;
SensorLSM6DSV.TAG_SENSORHUB_SLAVE0 = 0x0e;

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
        /**
         * 2nd-gen hub mode: PPG arrives via the MAX32674 hub as a fixed block of 6 raw
         * MAX86176 LED channels (6 x u24), independent of the RED/IR/GREEN/BLUE enable
         * bits. Set from the connected device's hardware generation (see
         * VerisenseClient). When false, the 1st-gen named-channel layout is used.
         */
        this.hubMode = false;
        this.adcLsb = [7.8125, 15.625, 31.25, 62.5];
        this.adcBitShift = [2 ** 7, 2 ** 6, 2 ** 5, 2 ** 4];
        this.adcResolutionIndex = 0; // 0..3
        /** PPG_SR code → base sampling rate in Hz (op byte PPG_MODE_CONFIG2 bits 4:2). */
        this.PPG_SR_HZ = [50, 100, 200, 400, 800, 1000, 1600, 3200];
        /** SMP_AVE code → FIFO sample-averaging factor (op byte PPG_FIFO_CONFIG bits 7:5). */
        this.SMP_AVE_FACTOR = [1, 2, 4, 8, 16, 32, 32, 32];
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
    setHubMode(enabled) {
        this.hubMode = enabled;
    }
    setAdcResolutionIndex(i) {
        if (i >= 0 && i <= 3)
            this.adcResolutionIndex = i;
    }
    calibrateValue(uncalValue) {
        const idx = this.adcResolutionIndex;
        return ((uncalValue / this.adcBitShift[idx]) * this.adcLsb[idx]) / 1000.0;
    }
    /**
     * 2nd-gen hub PPG block: N samples x (3 x u24 LED channels = green, IR, red),
     * no count prefix (sample count derived from the block length, matching the
     * firmware packer).
     */
    parseHubPayload(sensorPayloadBytes) {
        const bytesPerSample = 9; // 3 channels x 3 bytes
        const n = Math.floor(sensorPayloadBytes.length / bytesPerSample);
        const out = [];
        for (let i = 0; i < n; i++) {
            const base = i * bytesPerSample;
            out.push({
                leds: [
                    u24le(sensorPayloadBytes, base + 0), // green (LED1)
                    u24le(sensorPayloadBytes, base + 3), // IR (LED2)
                    u24le(sensorPayloadBytes, base + 6), // red (LED3)
                ],
            });
        }
        return out;
    }
    parsePayload(sensorPayloadBytes) {
        if (this.hubMode) {
            return this.parseHubPayload(sensorPayloadBytes);
        }
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
    applyOperationalConfig(op) {
        // PPG *channel* flags have a hardware-specific bit mapping (1st-gen named
        // channels vs MAX86176 hub), so those are still left to setChannels(). The
        // sample rate is a well-defined field, though, and it drives per-sample
        // timestamp spacing: without it samplingRateHz stays at the 50 Hz default
        // and any other configured rate makes consecutive blocks overlap on the
        // time axis (the same "zigzag" fixed for GSR/IMU).
        const norm = normalizeOperationalConfig(op);
        if (!norm)
            return;
        const srCode = ((norm[OP_IDX.PPG_MODE_CONFIG2] ?? 0) >> 2) & 0x07;
        const smpAveCode = ((norm[OP_IDX.PPG_FIFO_CONFIG] ?? 0) >> 5) & 0x07;
        const baseHz = this.PPG_SR_HZ[srCode];
        const aveFactor = this.SMP_AVE_FACTOR[smpAveCode] ?? 1;
        // The MAX86xxx averages SMP_AVE samples into one FIFO entry, so the streamed
        // output rate is the base PPG_SR divided by the averaging factor.
        if (baseHz)
            this.samplingRateHz = baseHz / aveFactor;
    }
}

/** Slow-sensor sample-rate index -> Hz (matches firmware slowSensorRateMs). This
 * is the configured (target) rate the firmware polls at; the sensor's exposure
 * may prevent reaching it, which surfaces as packet loss against this rate. */
const SLOW_SENSOR_RATE_HZ = [0, 0.5, 1, 2, 5, 10, 20];
/** Op-config index -> exposure µs (matches firmware vd6283_exposureIndexToUs). */
const EXPOSURE_US_TABLE = [100000, 1600, 6400, 12800, 25600, 51200, 102400, 204800];
/** Op-config index -> 8.8 fixed-point gain (matches firmware vd6283_gainIndexToValue). */
const GAIN_8P8_TABLE = [0x0100, 0x01ab, 0x0280, 0x0500, 0x0a00, 0x1900, 0x3200, 0x42ab];
/** Reference exposure (firmware VD6283TX_DEFAULT_EXPO). */
const DEFAULT_EXPO_US = 100800;
/** ALS-counts -> XYZ matrix (firmware App_vd6283tx.c). Rows are X, Y, Z. */
const XYZ_MATRIX = [
    [0.20557, 0.4167, -0.143816],
    [-0.028752, 0.506372, -0.120614],
    [-0.552625, 0.335866, 0.494781],
];
/**
 * Decoder for the VD6283TX45 ambient light sensor (Verisense sensor id = 7).
 *
 * Data block payload = N samples x 18 bytes (6 channels x 24-bit LE counts).
 * In addition to the raw channel counts, each sample carries the derived lux
 * and CCT, computed from the RED/GREEN/BLUE channels with the configured gain
 * and exposure (ported from firmware App_vd6283tx.c).
 */
class SensorVD6283 extends SensorBase {
    constructor() {
        super();
        this.exposureUs = EXPOSURE_US_TABLE[0];
        this.gain8p8 = GAIN_8P8_TABLE[0];
        /** Op-config dark-channel bit (LIGHT_CONFIG bit 1): when set the shared second
         * slot carries the dark baseline (`DARK`) instead of the visible reading. */
        this.darkEnabled = false;
        this.samplingRateHz = 1;
    }
    /** Normalise a raw channel count for the XYZ transform (gain + exposure). */
    normalizeForXyz(meas) {
        const expoScale = DEFAULT_EXPO_US / this.exposureUs;
        // Firmware divides by 256 (16.8 / 8.8 fixed-point); float division here is
        // a touch more precise than the firmware's integer division.
        return (expoScale * (meas / 256)) / (this.gain8p8 / 256 || 1);
    }
    /** Compute illuminance (lux) and CCT (K) from RED/GREEN/BLUE counts. */
    computeLuxCct(red, green, blue) {
        const r = this.normalizeForXyz(red);
        const g = this.normalizeForXyz(green);
        const b = this.normalizeForXyz(blue);
        const X = XYZ_MATRIX[0][0] * r + XYZ_MATRIX[0][1] * g + XYZ_MATRIX[0][2] * b;
        const Y = XYZ_MATRIX[1][0] * r + XYZ_MATRIX[1][1] * g + XYZ_MATRIX[1][2] * b;
        const Z = XYZ_MATRIX[2][0] * r + XYZ_MATRIX[2][1] * g + XYZ_MATRIX[2][2] * b;
        const lux = Y < 0 ? 0 : Y;
        const norm = X + Y + Z;
        let cct = 0;
        if (norm !== 0) {
            const x = X / norm;
            const y = Y / norm;
            const n = (x - 0.332) / (0.1858 - y);
            cct = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
        }
        return { lux, cct };
    }
    parsePayload(sensorPayloadBytes) {
        if (!sensorPayloadBytes?.length)
            return [];
        const n = Math.floor(sensorPayloadBytes.length / SensorVD6283.BYTES_PER_SAMPLE);
        const out = [];
        for (let i = 0; i < n; i++) {
            const base = i * SensorVD6283.BYTES_PER_SAMPLE;
            const RED = u24le(sensorPayloadBytes, base + 0);
            // Slot 1 is visible-or-dark depending on the configured dark-channel bit.
            const slot1 = u24le(sensorPayloadBytes, base + 3);
            const VISIBLE = this.darkEnabled ? null : slot1;
            const DARK = this.darkEnabled ? slot1 : null;
            const BLUE = u24le(sensorPayloadBytes, base + 6);
            const GREEN = u24le(sensorPayloadBytes, base + 9);
            const IR = u24le(sensorPayloadBytes, base + 12);
            const CLEAR = u24le(sensorPayloadBytes, base + 15);
            // lux/CCT derive from RED/GREEN/BLUE, so the dark-channel selection (which
            // only affects slot 1) leaves them valid in either mode.
            const { lux, cct } = this.computeLuxCct(RED, GREEN, BLUE);
            out.push({ RED, VISIBLE, BLUE, GREEN, IR, CLEAR, DARK, lux, cct });
        }
        return out;
    }
    applyOperationalConfig(op) {
        this.enabled = (op[OP_IDX.GEN_CFG_3] & (1 << 3)) !== 0;
        const rateIdx = op[OP_IDX.LIGHT_SAMPLE_RATE_INDEX] ?? 0;
        // Report the configured rate; loss is measured against it so a long exposure
        // (or any firmware/hardware shortfall) that prevents reaching it shows up.
        this.samplingRateHz = SLOW_SENSOR_RATE_HZ[rateIdx] || 1;
        const expoIdx = op[OP_IDX.LIGHT_EXPOSURE_INDEX] ?? 0;
        const gainIdx = op[OP_IDX.LIGHT_GAIN_INDEX] ?? 0;
        this.exposureUs = EXPOSURE_US_TABLE[expoIdx] ?? EXPOSURE_US_TABLE[0];
        this.gain8p8 = GAIN_8P8_TABLE[gainIdx] ?? GAIN_8P8_TABLE[0];
        // LIGHT_CONFIG bit 1 selects the dark channel on slot 1 (see VD6283Sample).
        this.darkEnabled = isVerisenseLightDarkChannelEnabled(op);
    }
}
SensorVD6283.NUM_CHANNELS = 6;
SensorVD6283.BYTES_PER_SAMPLE = 18;

function u16le(bytes, off) {
    return (bytes[off] & 0xff) | ((bytes[off + 1] & 0xff) << 8);
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
class SensorMAX32674 extends SensorBase {
    constructor() {
        super();
        // Approximate; the hub reports at the configured algorithm report rate.
        this.samplingRateHz = 25;
    }
    parsePayload(sensorPayloadBytes) {
        if (!sensorPayloadBytes?.length)
            return [];
        const count = sensorPayloadBytes[0] ?? 0;
        const maxByLength = Math.floor((sensorPayloadBytes.length - 1) / SensorMAX32674.BYTES_PER_SAMPLE);
        const n = Math.min(count, maxByLength);
        const out = [];
        for (let i = 0; i < n; i++) {
            const base = 1 + i * SensorMAX32674.BYTES_PER_SAMPLE;
            out.push({
                accel: {
                    raw: [
                        i16le(sensorPayloadBytes, base + 0),
                        i16le(sensorPayloadBytes, base + 2),
                        i16le(sensorPayloadBytes, base + 4),
                    ],
                },
                hr: u16le(sensorPayloadBytes, base + 6),
                hrConfidence: sensorPayloadBytes[base + 8] ?? 0,
                spo2: u16le(sensorPayloadBytes, base + 9),
                spo2Confidence: sensorPayloadBytes[base + 11] ?? 0,
                activityClass: sensorPayloadBytes[base + 12] ?? 0,
                scdContactState: sensorPayloadBytes[base + 13] ?? 0,
            });
        }
        return out;
    }
    applyOperationalConfig(op) {
        this.enabled = (op[OP_IDX.GEN_CFG_3] & (1 << 5)) !== 0;
        // samplingRateHz is left at its default; the hub report period mapping is
        // hardware-specific and not derived from a single op-config byte.
    }
}
SensorMAX32674.BYTES_PER_SAMPLE = 14;

/** MLX90632 refresh-rate code (op-config byte 76 bits 3:1) -> refresh Hz. The
 * single skin-temp rate setting is stored as this code; the output (sample) rate
 * is refresh / sub-measurements (medical = 2, extended = 3). */
const MLX_REFRESH_HZ = [0.5, 1, 2, 4, 8, 16, 32, 64];
/**
 * Decoder for the MLX90632 skin temperature sensor (Verisense sensor id = 9).
 *
 * Data block payload = N samples x 4 bytes: object int16 then ambient int16,
 * each in centi-degrees Celsius (value / 100 = degrees C).
 */
class SensorMLX90632 extends SensorBase {
    constructor() {
        super();
        this.samplingRateHz = 1;
    }
    parsePayload(sensorPayloadBytes) {
        if (!sensorPayloadBytes?.length)
            return [];
        const n = Math.floor(sensorPayloadBytes.length / SensorMLX90632.BYTES_PER_SAMPLE);
        const out = [];
        for (let i = 0; i < n; i++) {
            const base = i * SensorMLX90632.BYTES_PER_SAMPLE;
            const objRaw = i16le(sensorPayloadBytes, base + 0);
            const ambRaw = i16le(sensorPayloadBytes, base + 2);
            out.push({
                object: { raw: objRaw, cal: objRaw / 100, units: 'degC' },
                ambient: { raw: ambRaw, cal: ambRaw / 100, units: 'degC' },
            });
        }
        return out;
    }
    applyOperationalConfig(op) {
        this.enabled = (op[OP_IDX.GEN_CFG_3] & (1 << 4)) !== 0;
        // Single skin-temp rate: stored as the MLX90632 refresh-rate code (byte 76
        // bits 3:1). The output (sample) rate the firmware delivers is the refresh
        // rate divided by the sub-measurement count (medical = 2, extended = 3).
        const cfg = op[OP_IDX.SKIN_TEMP_CONFIG] ?? 0;
        const isExtended = (cfg & 0x01) !== 0;
        const refreshCode = (cfg >> 1) & 0x07;
        const refreshHz = MLX_REFRESH_HZ[refreshCode] ?? 16;
        this.samplingRateHz = refreshHz / (isExtended ? 3 : 2);
    }
}
SensorMLX90632.BYTES_PER_SAMPLE = 4;

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
 * - `"streamStats"` — `StreamStatsSnapshot` (throttled ~3 Hz live throughput/loss)
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
        this._suppressDisconnectedEvent = false;
        // Protocol state
        this._mode = 'idle';
        this._rxStreamBuf = new Uint8Array(0);
        this._pending = null;
        this._loggedChain = Promise.resolve();
        this._sync = null;
        this._testReportMode = false; // Flag to capture raw streaming bytes for test reports
        this._throughputTestMode = false; // Flag to count raw bytes during a BLE throughput test
        this._bootstrapRequestTimeoutOverrideMs = null;
        this._isSecondGenerationHw = false;
        // Live stream statistics (throughput / packet-loss). Reset on stream start.
        this._streamStats = new StreamStatsTracker();
        this._lastStreamStatsEmitMillis = 0;
        // Cached configs
        this.operationalConfig = null;
        this.productionConfig = null;
        // Debug flags
        this.debugSync = false;
        this._syncRxCount = 0;
        this._syncPayloadCount = 0;
        /** Per-device calibration last read from the device, or null. */
        this._calibration = null;
        this.hardwareIdentifier = opts.hardwareIdentifier ?? 'VERISENSE_PULSE_PLUS';
        this.stripStreamCrc = opts.stripStreamCrc ?? true;
        this.sensors = {
            1: new SensorADC(),
            2: new SensorLIS2DW12(),
            3: new SensorLSM6DS3(),
            4: new SensorPPG(),
            6: new SensorLSM6DSV(),
            7: new SensorVD6283(),
            8: new SensorMAX32674(),
            9: new SensorMLX90632(),
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
        return this._isSecondGenerationHw ? this.sensors[6] : this.sensors[3];
    }
    get gyroAccel2Lsm6ds3() {
        return this.sensors[3];
    }
    get gyroAccel2Lsm6dsv() {
        return this.sensors[6];
    }
    get ppg() {
        return this.sensors[4];
    }
    _setOperationalConfigErasedFallback(lengthHint) {
        const fallbackLen = lengthHint ?? this.operationalConfig?.length ?? VERISENSE_OP_CONFIG_BYTE_SIZE;
        const op = new Uint8Array(fallbackLen);
        op.fill(0xff);
        this.operationalConfig = op;
        this.emit('opConfigErased', { raw: new Uint8Array(op) });
        this.emit('opConfig', { op: new Uint8Array(op), erased: true });
        return op;
    }
    async _bootstrapConfigsAfterConnect() {
        await this.readProductionConfigFromDevice();
        try {
            await this.readOpConfigFromDevice();
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const invalidOp = /Invalid operational config returned from device/i.test(msg);
            const productionErased = this._isUninitializedBlob(this.productionConfig);
            if (invalidOp && productionErased) {
                console.warn('[opcfg] invalid operational config during bootstrap; treating as erased because production config is uninitialized', { payloadLengthHint: this.operationalConfig?.length ?? VERISENSE_OP_CONFIG_BYTE_SIZE });
                this._setOperationalConfigErasedFallback();
                return;
            }
            throw e;
        }
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
            // NORDIC_DFU_SERVICE must be granted at requestDevice() time so the
            // buttonless DFU control point is reachable from rebootToDfuBootloader().
            optionalServices: opts.optionalServices ?? [NUS_SERVICE, NORDIC_DFU_SERVICE],
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
            if (this._suppressDisconnectedEvent)
                return;
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
        await this._bootstrapConfigsAfterConnect();
        return true;
    }
    async _cleanupFailedBleConnectAttempt(retrySettleMs) {
        this._suppressDisconnectedEvent = true;
        try {
            if (this._onGattDisconnected && this.device) {
                this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
            }
        }
        catch {
            /* ignore */
        }
        try {
            if (this.device?.gatt?.connected) {
                this.device.gatt.disconnect();
            }
        }
        catch {
            /* ignore */
        }
        this.tx = null;
        this.rx = null;
        this.service = null;
        this.server = null;
        this._pending = null;
        this._mode = 'idle';
        this._transportKind = null;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, retrySettleMs)));
        this._suppressDisconnectedEvent = false;
    }
    async _retryBootstrapInPlaceWithBudget(totalBudgetMs, perAttemptTimeoutMs) {
        const budgetMs = Math.max(1000, Math.trunc(totalBudgetMs));
        const attemptTimeoutBaseMs = Math.max(1000, Math.trunc(perAttemptTimeoutMs));
        const deadline = Date.now() + budgetMs;
        while (Date.now() < deadline) {
            const remainingMs = Math.max(1000, deadline - Date.now());
            this._bootstrapRequestTimeoutOverrideMs = Math.min(attemptTimeoutBaseMs, remainingMs);
            try {
                this._pending = null;
                this._resetAssembler();
                await this._bootstrapConfigsAfterConnect();
                return true;
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                const retryable = /Unexpected response property/i.test(msg) ||
                    /A request is already pending/i.test(msg) ||
                    /request timeout/i.test(msg);
                if (!retryable || Date.now() + 100 >= deadline) {
                    throw e;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        return false;
    }
    async connectWithRetry(opts = {}) {
        const { bootstrapTimeoutMs = 3000, pairingBootstrapTimeoutMs = 45000, maxRetries = 2, retrySettleMs = 250, retryOnUnexpectedProperty = true, onRetry = null, ...connectOpts } = opts;
        const clampedDefaultTimeoutMs = Math.max(1000, Math.trunc(bootstrapTimeoutMs));
        const clampedPairingTimeoutMs = Math.max(clampedDefaultTimeoutMs, Math.trunc(pairingBootstrapTimeoutMs));
        const clampedMaxRetries = Math.max(0, Math.trunc(maxRetries));
        let lastError = null;
        for (let attempt = 0; attempt <= clampedMaxRetries; attempt += 1) {
            const attemptTimeoutMs = clampedDefaultTimeoutMs;
            this._bootstrapRequestTimeoutOverrideMs = attemptTimeoutMs;
            try {
                return await this.connect(connectOpts);
            }
            catch (e) {
                lastError = e;
                const msg = e instanceof Error ? e.message : String(e);
                const isRequestTimeout = /request timeout/i.test(msg);
                const isGattDisconnected = /gatt server is disconnected/i.test(msg);
                const isUnexpectedResponseProperty = retryOnUnexpectedProperty && /Unexpected response property/i.test(msg);
                const shouldRetry = (isRequestTimeout || isGattDisconnected || isUnexpectedResponseProperty) &&
                    attempt < clampedMaxRetries;
                if (!shouldRetry) {
                    await this._cleanupFailedBleConnectAttempt(retrySettleMs);
                    throw e;
                }
                // If pairing/passkey entry is still in progress, a request timeout can occur
                // while the BLE link itself remains up. In that case, retry bootstrap in-place
                // first to avoid forcing a disconnect that interrupts Windows bonding UX.
                if (isRequestTimeout && this.device?.gatt?.connected && this.tx && this.rx) {
                    onRetry?.({
                        attempt,
                        maxRetries: clampedMaxRetries,
                        bootstrapTimeoutMs: attemptTimeoutMs,
                        nextBootstrapTimeoutMs: clampedPairingTimeoutMs,
                        reason: 'request-timeout',
                        error: msg,
                    });
                    try {
                        await this._retryBootstrapInPlaceWithBudget(clampedPairingTimeoutMs, clampedDefaultTimeoutMs);
                        return true;
                    }
                    catch (bootstrapRetryError) {
                        lastError = bootstrapRetryError;
                    }
                }
                let reason;
                if (isRequestTimeout) {
                    reason = 'request-timeout';
                }
                else if (isGattDisconnected) {
                    reason = 'gatt-disconnected';
                }
                else {
                    reason = 'unexpected-response-property';
                }
                onRetry?.({
                    attempt,
                    maxRetries: clampedMaxRetries,
                    bootstrapTimeoutMs: attemptTimeoutMs,
                    nextBootstrapTimeoutMs: clampedPairingTimeoutMs,
                    reason,
                    error: msg,
                });
                await this._cleanupFailedBleConnectAttempt(retrySettleMs);
            }
            finally {
                this._bootstrapRequestTimeoutOverrideMs = null;
            }
        }
        throw lastError instanceof Error ? lastError : new Error('BLE connect failed');
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
        await this._bootstrapConfigsAfterConnect();
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
        // Clear live throughput / packet-loss stats for the new streaming session.
        this._streamStats.reset();
        this._lastStreamStatsEmitMillis = 0;
        await this.setStreamingMode(true);
        this._mode = 'streaming';
        this.emit('streaming', { on: true });
    }
    async stopStreaming() {
        // Stop is best-effort. The application-level ACK for STREAM_MODE-disable rides
        // on BLE notifications, which are unacknowledged and can be dropped under
        // high-throughput streaming; the in-flight stream tail is also parsed by the
        // command path (not the CRC-gated stream scanner) once we leave streaming
        // mode, so the small ACK frame is easily lost or mis-framed. We confirm
        // delivery of the disable command via a write-with-response, then reconcile
        // local state regardless — a missing ACK must never leave the client wedged
        // in 'streaming' (which locks the UI). This mirrors the best-effort stop used
        // by Shimmer3RClient and the DEVICE_DISCONNECT path in disconnect().
        try {
            await this.writeBytes(buildMessage(ASM_COMMAND.WRITE, ASM_PROPERTY.STREAM_MODE, [STREAM_MODE.DISABLE]), { withResponse: true });
        }
        catch (e) {
            this._log('stopStreaming: disable write failed; reconciling state anyway:', e);
        }
        finally {
            this._mode = 'idle';
            this._resetAssembler();
            this.emit('streaming', { on: false });
        }
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
            lastPayloadIndex: 0,
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
        const effectiveTimeoutMs = this._bootstrapRequestTimeoutOverrideMs != null && timeoutMs === 3000
            ? this._bootstrapRequestTimeoutOverrideMs
            : timeoutMs;
        const rsp = await this._requestByCommand(command, property, payloadBytes, effectiveTimeoutMs);
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
        // Safety interlock (mirrors firmware): never write a config with both
        // Bluetooth and USB disabled, or the device becomes unreachable for
        // reconfiguration. Apply to a copy so the caller's buffer is left untouched
        // (normalizeBytePayload returns the input reference for a Uint8Array).
        const corrected = new Uint8Array(payload);
        enforceVerisenseCommsChannelInterlock(corrected);
        await this.writeProperty(ASM_PROPERTY.OPERATIONAL_CONFIGURATION, corrected);
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
     * Request the Verisense firmware to expose the Nordic Secure DFU service.
     *
     * Writes the ASM `DFU_MODE` property. The firmware treats this as a request
     * to enable the buttonless DFU service but does NOT reboot or expose the
     * service immediately — it enables it on the next BLE disconnect. The host
     * must therefore disconnect and reconnect before the Nordic DFU service (and
     * {@link rebootToDfuBootloader}) become available on the connection.
     */
    async enableDfuServiceOnNextDisconnect() {
        await this.writeProperty(ASM_PROPERTY.DFU_MODE, []);
    }
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
    async rebootToDfuBootloader(options = {}) {
        const { waitForDisconnect = true, disconnectAfterCommand = true, timeoutMs = 10000 } = options;
        if (this._transportKind !== 'ble' || !this.server || !this.device?.gatt?.connected) {
            throw new Error('rebootToDfuBootloader: requires an active BLE connection');
        }
        let dfuService;
        try {
            dfuService = await this.server.getPrimaryService(NORDIC_DFU_SERVICE);
        }
        catch {
            throw new Error('rebootToDfuBootloader: Nordic DFU service is not present on this connection. ' +
                'Call enableDfuServiceOnNextDisconnect(), then disconnect and reconnect first.');
        }
        // The buttonless control point lives under one of two UUIDs depending on
        // whether the firmware shares its bonds with the bootloader.
        let controlPoint = null;
        for (const uuid of [NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS, NORDIC_DFU_BUTTONLESS_WITH_BONDS]) {
            try {
                controlPoint = await dfuService.getCharacteristic(uuid);
                break;
            }
            catch {
                /* try the next variant */
            }
        }
        if (!controlPoint) {
            throw new Error('rebootToDfuBootloader: buttonless DFU control-point characteristic not found');
        }
        // Start watching for the disconnect before issuing the command so we never
        // miss the event if the device reboots immediately.
        const disconnected = waitForDisconnect ? this._waitForGattDisconnect(timeoutMs) : null;
        // The buttonless control point delivers its response via indications;
        // subscribe so the firmware sends it before resetting. Some stacks reject a
        // duplicate subscription — the command write below still succeeds.
        try {
            await controlPoint.startNotifications();
        }
        catch {
            /* ignore — indication subscription is best-effort */
        }
        const cp = controlPoint;
        const payload = Uint8Array.from([NORDIC_DFU_OP_ENTER_BOOTLOADER]);
        if (cp.writeValueWithResponse) {
            await cp.writeValueWithResponse(toArrayBuffer(payload));
        }
        else {
            await cp.writeValue(toArrayBuffer(payload));
        }
        if (disconnected) {
            const didDisconnect = await disconnected;
            if (!didDisconnect && disconnectAfterCommand && this.device?.gatt?.connected) {
                try {
                    this.device.gatt.disconnect();
                }
                catch {
                    /* ignore */
                }
            }
        }
        else if (disconnectAfterCommand && this.device?.gatt?.connected) {
            try {
                this.device.gatt.disconnect();
            }
            catch {
                /* ignore */
            }
        }
    }
    /**
     * Resolve when the BLE link drops (`gattserverdisconnected`), or after
     * `timeoutMs`. Resolves `true` if the device disconnected, `false` on timeout.
     */
    _waitForGattDisconnect(timeoutMs) {
        const device = this.device;
        if (!device || !device.gatt?.connected)
            return Promise.resolve(true);
        return new Promise((resolve) => {
            let settled = false;
            const onDisconnect = () => finish(true);
            const finish = (didDisconnect) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                try {
                    device.removeEventListener('gattserverdisconnected', onDisconnect);
                }
                catch {
                    /* ignore */
                }
                resolve(didDisconnect);
            };
            const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
            device.addEventListener('gattserverdisconnected', onDisconnect);
        });
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
    /**
     * Ask the device to stop/exit any running test, including an in-progress
     * hardware test report (TEST_MODE "exit", id 0x00). The firmware acts on this
     * from interrupt context, so it aborts the blocking report promptly instead of
     * running it to completion against a connection no one is reading. Best-effort
     * and safe to call when no test is running.
     */
    async stopTestMode(hwMajor = 0, hwMinor = 0, hwInternal = 0) {
        await this.runTestMode([
            0x00,
            hwMajor & 0xff,
            hwMinor & 0xff,
            hwInternal & 0xff,
            (hwInternal >> 8) & 0xff,
        ]);
    }
    async runHardwareTestReport(hwMajor, hwMinor = 0, hwInternal = 0, opts = {}) {
        const timeoutMs = Math.max(1000, Math.trunc(opts.timeoutMs ?? 120000));
        const completionIdleMs = Math.max(100, Math.trunc(opts.completionIdleMs ?? 1200));
        const marker = String(opts.marker ?? '').trim();
        const endMarker = String(opts.endMarker ??
            (marker.includes('TEST START') ? marker.replace('TEST START', 'TEST END') : '')).trim();
        const factoryTestType = Math.max(0, Math.min(0xff, Math.trunc(opts.factoryTestType ?? 0)));
        const abortSignal = opts.signal ?? null;
        const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
        const TEST_REPORT_MODE_ID = 0xfe;
        const payload = new Uint8Array([
            TEST_REPORT_MODE_ID,
            hwMajor & 0xff,
            hwMinor & 0xff,
            hwInternal & 0xff,
            (hwInternal >> 8) & 0xff,
            factoryTestType & 0xff,
        ]);
        return new Promise((resolve, reject) => {
            let done = false;
            let aggregate = '';
            let decoder;
            try {
                decoder = new TextDecoder('latin1');
            }
            catch {
                decoder = new TextDecoder();
            }
            let sawMarker = marker.length === 0;
            const effectiveIdleMs = Math.max(completionIdleMs, 10000);
            let idleTimer = null;
            let timeoutTimer = null;
            let off = null;
            let onAbort = null;
            const sanitizeChunk = (text) => {
                // Drop control bytes that occasionally appear in factory stream noise
                // while preserving CR/LF/TAB for report formatting.
                return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
            };
            const cleanup = () => {
                this._testReportMode = false;
                if (off) {
                    try {
                        off();
                    }
                    catch {
                        /* ignore */
                    }
                    off = null;
                }
                if (idleTimer) {
                    clearTimeout(idleTimer);
                    idleTimer = null;
                }
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
                if (abortSignal && onAbort) {
                    try {
                        abortSignal.removeEventListener('abort', onAbort);
                    }
                    catch {
                        /* ignore */
                    }
                    onAbort = null;
                }
            };
            const finish = (err) => {
                if (done)
                    return;
                done = true;
                cleanup();
                if (err) {
                    // Best-effort: tell the device to stop the in-progress test/report so it
                    // doesn't keep running a blocking suite against a connection no one is
                    // reading (dialog closed / aborted / timed out). The firmware acts on
                    // this from interrupt context, so the report aborts promptly.
                    void this.stopTestMode(hwMajor, hwMinor, hwInternal).catch(() => { });
                    reject(err);
                    return;
                }
                const tail = decoder.decode();
                if (tail) {
                    aggregate += tail;
                }
                resolve(aggregate);
            };
            const scheduleIdleFinish = () => {
                if (idleTimer)
                    clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (!sawMarker)
                        return;
                    finish();
                }, effectiveIdleMs);
            };
            off = this.on('testReportChunk', (rawChunk) => {
                if (done || !rawChunk?.length)
                    return;
                const chunk = sanitizeChunk(decoder.decode(rawChunk, { stream: true }));
                if (!chunk.length)
                    return;
                aggregate += chunk;
                if (!sawMarker && marker.length > 0 && aggregate.includes(marker)) {
                    sawMarker = true;
                }
                const sawEndMarker = (endMarker.length > 0 && aggregate.includes(endMarker)) || /TEST END/.test(aggregate);
                if (sawEndMarker) {
                    finish();
                    return;
                }
                if (onChunk) {
                    try {
                        onChunk(chunk, aggregate);
                    }
                    catch {
                        /* ignore callback errors */
                    }
                }
                if (sawMarker) {
                    scheduleIdleFinish();
                }
            });
            timeoutTimer = setTimeout(() => {
                finish(new Error(`runHardwareTestReport timeout after ${timeoutMs} ms while waiting for report data`));
            }, timeoutMs);
            if (abortSignal) {
                if (abortSignal.aborted) {
                    finish(new Error('runHardwareTestReport aborted'));
                    return;
                }
                onAbort = () => finish(new Error('runHardwareTestReport aborted'));
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
            // Enable test report mode before sending command
            this._testReportMode = true;
            void this.runTestMode(payload).catch((e) => {
                const msg = e instanceof Error ? e.message : String(e);
                finish(new Error(`runHardwareTestReport failed to start test mode: ${msg}`));
            });
        });
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
            if (isDebugNack || isDebugAckPropertyZero) {
                return this._waitForDebugResponse(timeoutMs);
            }
            throw e;
        }
    }
    async sendDebugCommand(debugId, args = [], timeoutMs = 3000) {
        const rsp = await this._requestByCommand(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, this._buildDebugPayload(debugId, args), timeoutMs);
        return { payload: rsp.payload };
    }
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
    async uploadHubFirmware(msbl, onProgress) {
        const img = msbl instanceof Uint8Array ? msbl : new Uint8Array(msbl);
        if (img.length < MSBL.HEADER_SIZE) {
            throw new Error('uploadHubFirmware: file is too small to be a valid .msbl');
        }
        const numPages = img[MSBL.OFF_NUMPAGES] | (img[MSBL.OFF_NUMPAGES + 1] << 8);
        const expectedLen = MSBL.HEADER_SIZE + numPages * MSBL.PAGE_FILE_BYTES;
        if (numPages === 0 || img.length < expectedLen) {
            throw new Error(`uploadHubFirmware: invalid .msbl (pages=${numPages}, length=${img.length}, expected>=${expectedLen})`);
        }
        // BEGIN: device enters bootloader, programs IV/auth/page-count, erases flash.
        try {
            await this._requestByCommand(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, this._buildHubUploadPayload(HUB_FW_UPLOAD_STAGE.BEGIN, img.subarray(0, MSBL.HEADER_SIZE)), 15000);
        }
        catch (e) {
            throw new Error(`Hub FW upload BEGIN failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Pages: stream each page in order, awaiting ACK_NEXT_STAGE (page flashed).
        const MAX_PAGE_RETRIES = 5;
        for (let page = 0; page < numPages; page++) {
            const base = MSBL.HEADER_SIZE + page * MSBL.PAGE_FILE_BYTES;
            const pageBytes = img.subarray(base, base + MSBL.PAGE_FILE_BYTES);
            let attempt = 0;
            for (;;) {
                try {
                    await this._sendHubPage(page, pageBytes);
                    break;
                }
                catch (e) {
                    if (++attempt >= MAX_PAGE_RETRIES) {
                        await this._abortHubUpload();
                        throw new Error(`Hub FW upload failed at page ${page + 1}/${numPages} after ${attempt} attempts: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }
            onProgress?.(page + 1, numPages);
        }
        // END: device resets the hub to application mode and returns its FW version.
        const endRsp = await this._requestByCommand(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, this._buildHubUploadPayload(HUB_FW_UPLOAD_STAGE.END), 8000);
        return new TextDecoder().decode(endRsp.payload).replace(/\0+$/, '').trim();
    }
    /** Build a debug payload `[HUB_FW_UPLOAD, stage, ...stageArgs]`. */
    _buildHubUploadPayload(stage, stageArgs = []) {
        const a = stageArgs instanceof Uint8Array ? stageArgs : new Uint8Array(stageArgs);
        const staged = new Uint8Array(1 + a.length);
        staged[0] = stage & 0xff;
        staged.set(a, 1);
        return this._buildDebugPayload(DEBUG_COMMAND_ID.HUB_FW_UPLOAD, staged);
    }
    /** Send one 8208-byte page as in-order <=64-byte chunks; await ACK_NEXT_STAGE. */
    async _sendHubPage(page, pageBytes) {
        const CHUNK = 64; // keep each packet within the device's ~96-byte RX buffer
        const total = pageBytes.length;
        for (let off = 0; off < total; off += CHUNK) {
            const end = Math.min(off + CHUNK, total);
            const isFinal = end >= total;
            const args = new Uint8Array(4 + (end - off));
            args[0] = page & 0xff;
            args[1] = (page >> 8) & 0xff;
            args[2] = off & 0xff;
            args[3] = (off >> 8) & 0xff;
            args.set(pageBytes.subarray(off, end), 4);
            const payload = this._buildHubUploadPayload(HUB_FW_UPLOAD_STAGE.PAGE_CHUNK, args);
            if (isFinal) {
                // Final chunk completes the page; the device flashes it (~0.7 s) and
                // replies ACK_NEXT_STAGE (or NACK on failure -> throws -> page retry).
                await this._requestByCommand(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, payload, 6000);
            }
            else {
                // Mid-page chunk: reliable, in-order delivery via write-with-response,
                // with no application-level reply from the device.
                await this.writeBytes(buildMessage(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, payload), {
                    withResponse: true,
                });
            }
        }
    }
    /** Best-effort abort: tell the device to reset the hub back to application mode. */
    async _abortHubUpload() {
        try {
            await this._requestByCommand(ASM_COMMAND.WRITE, ASM_PROPERTY.DEBUG_COMMAND, this._buildHubUploadPayload(HUB_FW_UPLOAD_STAGE.ABORT), 5000);
        }
        catch {
            /* best effort */
        }
    }
    async readFlashLookupTable(index = 0, timeoutMs = 12000) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.FLASH_LOOKUP_TABLE_READ, this._debugIndexArgs(index), timeoutMs);
    }
    async readRealWorldClockScheduler(index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.RWC_SCHEDULER_READ, this._debugIndexArgs(index));
    }
    async readRealWorldClockSchedulerParsed(index = 0) {
        const { payload } = await this.readRealWorldClockScheduler(index);
        return parseSchedulerDebugPayload(payload);
    }
    async loadTestLookupTable(index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.LOAD_TEST_LOOKUP_TABLE, this._debugIndexArgs(index));
    }
    async checkPayloadCrcErrors(index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.CHECK_PAYLOAD_CRC_ERRORS, this._debugIndexArgs(index));
    }
    async checkPayloadCrcErrorsParsed(index = 0) {
        const { payload } = await this.checkPayloadCrcErrors(index);
        return parsePayloadCrcErrorBankIndexes(payload);
    }
    async readEventLog(index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.READ_EVENT_LOG, this._debugIndexArgs(index));
    }
    async readEventLogParsed(index = 0) {
        const { payload } = await this.readEventLog(index);
        return parseEventLogPayload(payload);
    }
    async readRecordBufferDetails(index = 0) {
        return this.readDebugCommand(DEBUG_COMMAND_ID.READ_RECORD_BUFFER_DETAILS, this._debugIndexArgs(index));
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
    async testDataTransferLoop(durationMs) {
        const clamped = Math.max(0, Math.min(0xffff, Math.trunc(durationMs)));
        await this.sendDebugCommand(DEBUG_COMMAND_ID.TEST_DATA_TRANSFER_LOOP, [
            clamped & 0xff,
            (clamped >> 8) & 0xff,
        ]);
    }
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
    async runBleThroughputTest(opts = {}) {
        const durationMs = Math.max(100, Math.min(60000, Math.trunc(opts.durationMs ?? 5000)));
        const idleMs = Math.max(100, Math.min(5000, Math.trunc(opts.idleMs ?? 600)));
        const overallTimeoutMs = Math.max(durationMs + 1000, Math.trunc(opts.timeoutMs ?? durationMs + 5000));
        const abortSignal = opts.signal ?? null;
        const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
        return new Promise((resolve, reject) => {
            let done = false;
            let bytes = 0;
            let packets = 0;
            let firstByteMs = 0;
            let lastByteMs = 0;
            let idleTimer = null;
            let timeoutTimer = null;
            let off = null;
            let onAbort = null;
            const buildResult = () => {
                const elapsedMs = packets > 1 && lastByteMs > firstByteMs ? lastByteMs - firstByteMs : durationMs;
                const bps = elapsedMs > 0 ? (bytes * 1000) / elapsedMs : 0;
                return {
                    bytesReceived: bytes,
                    packetsReceived: packets,
                    durationRequestedMs: durationMs,
                    elapsedMs,
                    throughputBytesPerSec: bps,
                    throughputKBps: bps / 1000,
                    throughputKbps: (bps * 8) / 1000,
                };
            };
            const cleanup = () => {
                this._throughputTestMode = false;
                if (off) {
                    try {
                        off();
                    }
                    catch {
                        /* ignore */
                    }
                    off = null;
                }
                if (idleTimer) {
                    clearTimeout(idleTimer);
                    idleTimer = null;
                }
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
                if (abortSignal && onAbort) {
                    try {
                        abortSignal.removeEventListener('abort', onAbort);
                    }
                    catch {
                        /* ignore */
                    }
                    onAbort = null;
                }
            };
            const finish = (err) => {
                if (done)
                    return;
                done = true;
                cleanup();
                if (err)
                    reject(err);
                else
                    resolve(buildResult());
            };
            const scheduleIdleFinish = () => {
                if (idleTimer)
                    clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    // Only finish on idle once data has actually started arriving.
                    if (packets > 0)
                        finish();
                }, idleMs);
            };
            off = this.on('throughputChunk', (len) => {
                if (done || !len)
                    return;
                const now = nowMillis();
                if (packets === 0)
                    firstByteMs = now;
                lastByteMs = now;
                bytes += len;
                packets++;
                if (onProgress) {
                    try {
                        onProgress(buildResult());
                    }
                    catch {
                        /* ignore callback errors */
                    }
                }
                scheduleIdleFinish();
            });
            // Safety net: the device stops after durationMs, so the idle gap should
            // normally finish first. If it never does, finalize with what we have.
            timeoutTimer = setTimeout(() => finish(), overallTimeoutMs);
            if (abortSignal) {
                if (abortSignal.aborted) {
                    finish(new Error('runBleThroughputTest aborted'));
                    return;
                }
                onAbort = () => finish(new Error('runBleThroughputTest aborted'));
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
            // Enable raw-count mode before sending so no blast bytes are missed. The
            // ACK is consumed by the normal command path (while _pending is set); the
            // dummy blast that follows is counted by the _feedStreamBytes branch.
            this._throughputTestMode = true;
            void this.testDataTransferLoop(durationMs).catch((e) => {
                const msg = e instanceof Error ? e.message : String(e);
                finish(new Error(`runBleThroughputTest failed to start: ${msg}`));
            });
        });
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
    async _assertBleLinkDebugSupported() {
        let parsed = null;
        if (this.productionConfig?.length) {
            if (this._isErasedBlob(this.productionConfig)) {
                throw new Error('BLE link debug commands require firmware >= 1.4.23, but production config is erased.');
            }
            parsed = parseProductionConfigPayload(this.productionConfig);
        }
        else {
            parsed = await this.readProductionConfigFromDevice();
            if (this._isErasedBlob(this.productionConfig)) {
                throw new Error('BLE link debug commands require firmware >= 1.4.23, but production config is erased.');
            }
        }
        const current = {
            major: Number(parsed.revFwMajor),
            minor: Number(parsed.revFwMinor),
            internal: Number(parsed.revFwInternal),
        };
        if (!Number.isFinite(current.major) ||
            !Number.isFinite(current.minor) ||
            !Number.isFinite(current.internal)) {
            throw new Error('BLE link debug commands require firmware >= 1.4.23, but firmware version is unavailable.');
        }
        const min = BLE_LINK_MIN_FW;
        if (compareVerisenseFirmwareVersion(current, min) < 0) {
            throw new Error(`BLE link debug commands require firmware >= ${formatVerisenseFirmwareVersion(min)} (current ${formatVerisenseFirmwareVersion(current)}).`);
        }
    }
    async readBleLinkParams() {
        await this._assertBleLinkDebugSupported();
        return this.readDebugCommand(DEBUG_COMMAND_ID.BLE_LINK_PARAMS_READ);
    }
    async readBleLinkParamsParsed() {
        const { payload } = await this.readBleLinkParams();
        return parseBleLinkDebugPayload(payload);
    }
    async optimizeBleLink() {
        await this._assertBleLinkDebugSupported();
        return this.readDebugCommand(DEBUG_COMMAND_ID.BLE_LINK_OPTIMIZE);
    }
    async optimizeBleLinkParsed() {
        const { payload } = await this.optimizeBleLink();
        return parseBleLinkDebugPayload(payload);
    }
    _bleLinkSignature(parsed) {
        return [
            parsed.attMtu,
            parsed.maxDataLength,
            parsed.connectionIntervalUnits,
            parsed.txPhy,
            parsed.rxPhy,
            parsed.isConnected ? 1 : 0,
        ].join('|');
    }
    _bleLinkOptimizedEnough(parsed, { targetConnectionIntervalUnits, targetPhy, minDataLength, }) {
        const intervalOk = parsed.connectionIntervalUnits <= targetConnectionIntervalUnits;
        const phyOk = parsed.txPhy === targetPhy && parsed.rxPhy === targetPhy;
        const mtuBoundDataLength = Math.max(20, (parsed.attMtu || 23) - 3);
        const requiredDataLength = Math.min(minDataLength, mtuBoundDataLength);
        const dataLenOk = parsed.maxDataLength >= requiredDataLength;
        return intervalOk && phyOk && dataLenOk;
    }
    _isAbortError(error) {
        if (error?.name === 'AbortError')
            return true;
        const msg = error instanceof Error ? error.message : String(error);
        return /abort/i.test(msg);
    }
    _waitWithAbort(ms, signal) {
        if (!Number.isFinite(ms) || ms <= 0)
            return Promise.resolve();
        if (signal?.aborted) {
            const err = new Error('Operation aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (signal)
                    signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                if (signal)
                    signal.removeEventListener('abort', onAbort);
                const err = new Error('Operation aborted');
                err.name = 'AbortError';
                reject(err);
            };
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }
    async autoOptimizeBleLink(opts = {}) {
        const startedAt = nowMillis();
        const pollIntervalMs = Math.max(100, Math.trunc(opts.pollIntervalMs ?? 700));
        const stableReadCount = Math.max(1, Math.trunc(opts.stableReadCount ?? 3));
        const maxDurationMs = Math.max(pollIntervalMs, Math.trunc(opts.maxDurationMs ?? 20000));
        const settleMode = opts.settleMode === 'stability' ? 'stability' : 'target-and-stability';
        const minSettleTimeMs = Math.max(0, Math.trunc(opts.minSettleTimeMs ?? (settleMode === 'stability' ? pollIntervalMs * 2 : 0)));
        const forceOptimizeAttempts = Math.max(0, Math.trunc(opts.forceOptimizeAttempts ?? (settleMode === 'stability' ? 2 : 0)));
        const targetConnectionIntervalUnits = Math.max(6, Math.trunc(opts.targetConnectionIntervalUnits ?? 6));
        const targetPhy = Math.max(1, Math.min(4, Math.trunc(opts.targetPhy ?? 2)));
        const minDataLength = Math.max(20, Math.min(251, Math.trunc(opts.minDataLength ?? 251)));
        const signal = opts.signal ?? null;
        let iterations = 0;
        let optimizeAttempts = 0;
        let stableCount = 0;
        let lastSignature = '';
        let lastParsed = null;
        const finish = (reason) => ({
            reason,
            iterations,
            optimizeAttempts,
            stableCount,
            lastParsed,
            durationMs: Math.max(0, nowMillis() - startedAt),
        });
        if (this._transportKind !== 'ble')
            return finish('not-ble');
        if (signal?.aborted)
            return finish('aborted');
        while (nowMillis() - startedAt < maxDurationMs) {
            if (signal?.aborted)
                return finish('aborted');
            if (this._transportKind !== 'ble')
                return finish('not-ble');
            let parsed;
            try {
                parsed = await this.readBleLinkParamsParsed();
            }
            catch (error) {
                if (this._isAbortError(error))
                    return finish('aborted');
                const msg = error instanceof Error ? error.message : String(error);
                if (/require firmware >=|unavailable on this firmware|firmware version is unavailable/i.test(msg)) {
                    return finish('unsupported');
                }
                throw error;
            }
            iterations += 1;
            lastParsed = parsed;
            let signature = this._bleLinkSignature(parsed);
            stableCount = signature === lastSignature ? stableCount + 1 : 1;
            lastSignature = signature;
            let optimizedEnough = this._bleLinkOptimizedEnough(parsed, {
                targetConnectionIntervalUnits,
                targetPhy,
                minDataLength,
            });
            if (typeof opts.onSample === 'function') {
                opts.onSample({
                    source: 'read',
                    iteration: iterations,
                    stableCount,
                    parsed,
                    signature,
                    optimizedEnough,
                });
            }
            const shouldOptimize = settleMode === 'stability' ? optimizeAttempts < forceOptimizeAttempts : !optimizedEnough;
            if (shouldOptimize) {
                try {
                    parsed = await this.optimizeBleLinkParsed();
                }
                catch (error) {
                    if (this._isAbortError(error))
                        return finish('aborted');
                    throw error;
                }
                optimizeAttempts += 1;
                lastParsed = parsed;
                signature = this._bleLinkSignature(parsed);
                stableCount = signature === lastSignature ? stableCount + 1 : 1;
                lastSignature = signature;
                optimizedEnough = this._bleLinkOptimizedEnough(parsed, {
                    targetConnectionIntervalUnits,
                    targetPhy,
                    minDataLength,
                });
                if (typeof opts.onSample === 'function') {
                    opts.onSample({
                        source: 'optimize',
                        iteration: iterations,
                        stableCount,
                        parsed,
                        signature,
                        optimizedEnough,
                    });
                }
            }
            const elapsedMs = Math.max(0, nowMillis() - startedAt);
            const stableReady = stableCount >= stableReadCount && elapsedMs >= minSettleTimeMs;
            const settleReady = settleMode === 'stability' ? stableReady : stableReady && optimizedEnough;
            if (settleReady) {
                return finish('stabilized');
            }
            try {
                await this._waitWithAbort(pollIntervalMs, signal);
            }
            catch (error) {
                if (this._isAbortError(error))
                    return finish('aborted');
                throw error;
            }
        }
        return finish('timeout');
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
    _isErasedBlob(payload) {
        return isUniformByteArray(payload, 0xff);
    }
    _isZeroBlob(payload) {
        return isUniformByteArray(payload, 0x00);
    }
    _isUninitializedBlob(payload) {
        return this._isErasedBlob(payload) || this._isZeroBlob(payload);
    }
    async readProductionConfigFromDevice() {
        const rsp = await this.readProductionConfig();
        const prod = normalizeOperationalConfig(rsp?.payload);
        if (!prod?.length)
            throw new Error('Invalid production config returned from device');
        const erased = this._isErasedBlob(prod);
        this.productionConfig = prod;
        const parsed = parseProductionConfigPayload(prod);
        if (!erased && typeof parsed.revHwMajor === 'number' && typeof parsed.revHwMinor === 'number') {
            const hwIdentifier = parsed.revHwMajor === 62 ? 'VERISENSE_GSR_PLUS' : 'VERISENSE_PULSE_PLUS';
            this.adc.setHardwareIdentifier(hwIdentifier);
            this.adc.setHardwareRevision(parsed.revHwMajor, parsed.revHwMinor, typeof parsed.revHwInternal === 'number' ? parsed.revHwInternal : 0);
            this._isSecondGenerationHw = isVerisenseSecondGenerationHardware(parsed.revHwMajor, parsed.revHwMinor);
            // On 2nd-gen hardware the raw PPG (id 4) is the 6-channel MAX86176 block
            // drained from the hub, not the 1st-gen named-channel layout.
            this.ppg.setHubMode(this._isSecondGenerationHw);
        }
        if (erased) {
            this.emit('productionConfigErased', { raw: new Uint8Array(prod) });
        }
        this.emit('productionConfig', parsed);
        return parsed;
    }
    async readOpConfigFromDevice() {
        const rsp = await this.readOperationalConfig();
        let op = normalizeOperationalConfig(rsp?.payload);
        // Some firmware erase flows can return an empty payload for operational config.
        // Treat this as erased (all 0xFF) instead of invalid.
        if (!op?.length) {
            return this._setOperationalConfigErasedFallback();
        }
        if (this._isZeroBlob(op)) {
            console.warn('[opcfg] operational config payload is all 0x00; treating as erased');
            return this._setOperationalConfigErasedFallback(op.length);
        }
        const erased = this._isErasedBlob(op);
        if (!erased && op[0] !== 0x5a) {
            throw new Error('Invalid operational config returned from device');
        }
        this.operationalConfig = op;
        if (!erased) {
            try {
                this.accel1.applyOperationalConfig(op);
                this.sensors[3].applyOperationalConfig(op);
                this.sensors[6].applyOperationalConfig(op);
                this.adc.applyOperationalConfig(op);
                this.ppg.applyOperationalConfig(op);
                this.sensors[7].applyOperationalConfig(op);
                this.sensors[8].applyOperationalConfig(op);
                this.sensors[9].applyOperationalConfig(op);
            }
            catch (e) {
                console.warn('[opcfg] apply after read failed:', e);
            }
        }
        else {
            this.emit('opConfigErased', { raw: new Uint8Array(op) });
        }
        this.emit('opConfig', { op, erased });
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
    /** The parsed calibration set last read via {@link readCalibrationParsed}, or null. */
    getCalibration() {
        return this._calibration;
    }
    /**
     * Read the raw calibration blob from the device (CMD_AR_CFG_CALIB). The whole
     * blob (~1 KB) arrives in one response, reassembled across BLE/USB fragments.
     * Requires FW v2.0.4+; older firmware NACKs or times out.
     */
    async readCalibration(timeoutMs = 8000) {
        const rsp = await this.readProperty(ASM_PROPERTY.CALIBRATION, timeoutMs);
        const blob = rsp.payload;
        if (!blob || blob.length < SC_GLOBAL_HEADER_BYTES) {
            throw new Error('readCalibration: device returned no/short calibration blob');
        }
        return new Uint8Array(blob);
    }
    /**
     * Read + parse the calibration set, cache it, and push it into the IMU
     * decoders so subsequent samples calibrate from per-device values. Call before
     * a logged-data transfer and/or after connect (no-op on FW that lacks it —
     * the call rejects and the decoders keep their full-scale fallback).
     */
    async readCalibrationParsed() {
        const blob = await this.readCalibration();
        const set = parseCalibrationBlob(blob);
        this._calibration = set;
        try {
            this.accel1.applyCalibration(set);
            this.sensors[6].applyCalibration(set);
        }
        catch (e) {
            console.warn('[calib] apply after read failed:', e);
        }
        return set;
    }
    /**
     * Write a calibration blob to the device (CMD_AR_CFG_CALIB), chunked in
     * <=128-byte pieces as [offset_lo, offset_hi, ...chunk]. The device reassembles
     * and commits on the final chunk. Requires FW v2.0.4+.
     */
    async writeCalibration(blob, chunkSize = 128) {
        if (!blob || blob.length < SC_GLOBAL_HEADER_BYTES) {
            throw new Error('writeCalibration: invalid calibration blob');
        }
        const step = Math.max(1, Math.min(chunkSize, 128)); // firmware ramWrite caps chunks at 128
        for (let offset = 0; offset < blob.length; offset += step) {
            const chunk = blob.subarray(offset, Math.min(offset + step, blob.length));
            const payload = new Uint8Array(2 + chunk.length);
            payload[0] = offset & 0xff;
            payload[1] = (offset >> 8) & 0xff;
            payload.set(chunk, 2);
            await this.writeProperty(ASM_PROPERTY.CALIBRATION, payload);
        }
    }
    getSensor(name) {
        const k = String(name ?? '').toLowerCase();
        if (!k)
            return null;
        if (k.includes('lis2dw12') || k.includes('accel1') || k === '2')
            return this.accel1;
        if (k.includes('lsm6dsv') || k === '6')
            return this.sensors[6];
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
        const payloadIndex = s.lastPayloadIndex;
        this._sync = null;
        this._mode = 'idle';
        s.resolve({ ok: true, bytesWritten, payloadIndex });
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
        s.lastPayloadIndex = payloadIndex;
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
        // Known properties are 0x01..0x0D; keep 0x00 permissive for transient frames.
        return (property === 0 || (property >= ASM_PROPERTY.STATUS1 && property <= ASM_PROPERTY.CALIBRATION));
    }
    _isPlausibleFrameStart(hdr, len) {
        // Logged sync frames can be large and should be length-gated like the working single-file implementation.
        if (this._mode === 'logged') {
            return len <= VerisenseBleDevice.MAX_FRAME_PAYLOAD_LEN;
        }
        if (!this._isPlausibleHeaderByte(hdr))
            return false;
        // Debug responses may carry large blobs (for example flash lookup tables),
        // while normal properties and streaming/logged payloads should stay bounded.
        // DEBUG and CALIBRATION responses can be large (lookup tables / the ~1 KB
        // calibration blob) and arrive across multiple fragments.
        const expectsLargeResponse = this._mode === 'command' &&
            (this._pending?.expectedProperty === ASM_PROPERTY.DEBUG_COMMAND ||
                this._pending?.expectedProperty === ASM_PROPERTY.CALIBRATION);
        const maxLen = expectsLargeResponse
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
        // Test report data is streamed as raw text bytes after the initial ACK.
        // Once the command pending state is cleared, bypass frame parsing entirely.
        if (this._testReportMode && !this._pending) {
            if (chunk?.length)
                this.emit('testReportChunk', chunk);
            return;
        }
        // Throughput-test data is raw dummy bytes streamed after the initial ACK.
        // The ACK itself is consumed by the normal frame path while _pending is set;
        // everything after is counted (not parsed) until the test finishes.
        if (this._throughputTestMode && !this._pending) {
            if (chunk?.length)
                this.emit('throughputChunk', chunk.length);
            return;
        }
        this._appendStreamBuf(chunk);
        for (;;) {
            // Streaming frames carry a CRC-16 trailer; use it to lock onto frame
            // boundaries. A candidate is accepted only when its CRC validates, so
            // after a weak link drops bytes we slide past the garbage and re-lock on
            // the next genuine frame instead of emitting misaligned (wrong sensor-id)
            // packets. Legacy firmware that streams without a CRC trailer
            // (stripStreamCrc=false) falls through to the length-only path below.
            if (this._mode === 'streaming' && this.stripStreamCrc) {
                const scan = scanStreamFrame(this._rxStreamBuf);
                if (scan.status === 'need-more')
                    return;
                if (scan.status === 'invalid') {
                    if (this.debugSync) {
                        console.warn('[rx] stream resync: dropping byte', {
                            dropped: this._rxStreamBuf[0],
                            bufLen: this._rxStreamBuf.length,
                        });
                    }
                    this._rxStreamBuf = this._rxStreamBuf.slice(1);
                    this._streamStats.recordResyncDrop(1);
                    continue;
                }
                this._rxStreamBuf = this._rxStreamBuf.slice(scan.consumed);
                this._handleStreamingPayload(scan.payload);
                continue;
            }
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
            // Reached only for frames the CRC-gated scanner already validated (see
            // _feedStreamBytes), so the CRC is known good; just strip the 2-byte
            // trailer before decoding.
            body = payload.slice(0, payload.length - 2);
            crcOk = true;
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
            // Per-stream-aware (sensors with interleaved FIFO streams override this).
            const tsArray = sensor.computeSampleTimestamps(decodedSamples, {
                tsLastSampleMillis: tsInfo.shimmerMillis,
                systemTsLastSampleMillis,
                systemOffsetFirstTime: tsInfo.systemOffsetFirstTime,
            });
            samplesWithTime = decodedSamples.map((s, i) => ({
                ...s,
                timestamps: tsArray[i],
            }));
        }
        const packet = {
            sensorId,
            tick_u24: tick,
            decoded: samplesWithTime,
            rawPayload: sensorPayload,
            crcOk,
        };
        // Live throughput / packet-loss accounting. Loss is derived from gaps in the
        // monotonic device clock (tsMillis) via getStreamContributions; throughput
        // uses the full BLE frame size and host receive time.
        const contributions = sensor && Array.isArray(samplesWithTime) && samplesWithTime.length
            ? sensor.getStreamContributions(samplesWithTime, sensorId)
            : [];
        this._streamStats.recordPacket({
            sensorId,
            byteLength: payload.length,
            crcOk,
            recvMillis: systemTsLastSampleMillis,
            contributions,
        });
        this.emit('streamPacket', packet);
        this.emit('data', packet);
        // Throttled stats push (~3 Hz) so the UI can subscribe instead of polling.
        if (systemTsLastSampleMillis - this._lastStreamStatsEmitMillis >= 333) {
            this._lastStreamStatsEmitMillis = systemTsLastSampleMillis;
            this.emit('streamStats', this._streamStats.snapshot(systemTsLastSampleMillis));
        }
    }
    /** Snapshot of live stream statistics (throughput / packet-loss). */
    getStreamStats() {
        return this._streamStats.snapshot(nowMillis());
    }
}
// Single source of truth for the max frame size, shared with the CRC-gated
// streaming scanner so both framing paths accept the same large (fragmented)
// payloads. See STREAM_FRAME_MAX_PAYLOAD.
VerisenseBleDevice.MAX_FRAME_PAYLOAD_LEN = STREAM_FRAME_MAX_PAYLOAD;
VerisenseBleDevice.MAX_DEBUG_FRAME_PAYLOAD_LEN = 0xffff;
// Static NUS UUIDs
VerisenseBleDevice.NUS_SERVICE = NUS_SERVICE;
VerisenseBleDevice.NUS_TX = NUS_TX;
VerisenseBleDevice.NUS_RX = NUS_RX;

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
const VERISENSE_CALIBRATION_MIN_FW = {
    major: 2,
    minor: 0,
    internal: 4,
};
/** Whether the given firmware version supports the calibration command. */
function supportsVerisenseCalibration(fw) {
    if (!fw)
        return false;
    return compareVerisenseFirmwareVersion(fw, VERISENSE_CALIBRATION_MIN_FW) >= 0;
}
// ---------------------------------------------------------------------------
// 8-byte little-endian Unix-epoch-seconds timestamp (block header `ts` field).
// ---------------------------------------------------------------------------
/** Encode Unix-epoch seconds into the 8-byte little-endian calibration `ts`. */
function unixSecondsToCalibTsBytes(unixSeconds) {
    const out = new Uint8Array(SC_TS_BYTES);
    let v = Math.max(0, Math.floor(Number(unixSeconds) || 0));
    for (let i = 0; i < SC_TS_BYTES; i++) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
    }
    return out;
}
/** Decode the 8-byte little-endian calibration `ts` back to Unix-epoch seconds
 * (0 = default/seeded). */
function calibTsBytesToUnixSeconds(ts) {
    if (!ts || ts.length < SC_TS_BYTES)
        return 0;
    let secs = 0;
    for (let i = SC_TS_BYTES - 1; i >= 0; i--)
        secs = secs * 256 + (ts[i] & 0xff);
    return secs;
}
const ACCEL_RANGES = [
    { code: 0, label: '±2g', sens: 1671.665922915 },
    { code: 1, label: '±4g', sens: 835.832961457 },
    { code: 2, label: '±8g', sens: 417.916480729 },
    { code: 3, label: '±16g', sens: 208.958240364 },
];
// LSM6DSV gyro full-scale codes 0..4 (125/250/500/1000/2000 dps).
const GYRO_RANGES = [
    { code: 0, label: '±125dps', sens: 228.571428571 },
    { code: 1, label: '±250dps', sens: 114.285714286 },
    { code: 2, label: '±500dps', sens: 57.142857143 },
    { code: 3, label: '±1000dps', sens: 28.571428571 },
    { code: 4, label: '±2000dps', sens: 14.285714286 },
];
// LSM6DS3 gyro full-scale codes 0..3 (250/500/1000/2000 dps) — the gen-1 op-config
// gyro field is 2 bits, so 125 dps is not selectable via the standard range (see
// SensorLSM6DS3). Codes here match that field and the decoder lookup.
const LSM6DS3_GYRO_RANGES = [
    { code: 0, label: '±250dps', sens: 114.285714286 },
    { code: 1, label: '±500dps', sens: 57.142857143 },
    { code: 2, label: '±1000dps', sens: 28.571428571 },
    { code: 3, label: '±2000dps', sens: 14.285714286 },
];
/**
 * 2nd-generation catalog (LSM6DSV accel+gyro, LIS2DW12, LIS2MDL). Alignment
 * matrices derived from the ST datasheet axis figures + the SR68-10 pin-1
 * placement; common frame +X=strap, +Y=out of face, +Z=toward hand. LSM6DSV /
 * LIS2DW12 are proper rotations (det +1); the LIS2MDL frame is left-handed
 * (det −1, a reflection). Kept byte-for-byte in sync with the firmware seed
 * (asm_calibration.c) and VERISENSE_CALIBRATION.md §4.
 */
const CALIBRATION_SENSORS_GEN2 = [
    {
        id: CalibSensorId.LSM6DSV_ACCEL,
        label: 'Accelerometer (LSM6DSV)',
        unit: 'LSB/(m/s²)',
        align: [0, -1, 0, 0, 0, 1, -1, 0, 0],
        ranges: ACCEL_RANGES,
    },
    {
        id: CalibSensorId.LSM6DSV_GYRO,
        label: 'Gyroscope (LSM6DSV)',
        unit: 'LSB/dps',
        align: [0, -1, 0, 0, 0, 1, -1, 0, 0],
        ranges: GYRO_RANGES,
    },
    {
        id: CalibSensorId.LIS2DW12_ACCEL,
        label: 'Accelerometer 2 (LIS2DW12)',
        unit: 'LSB/(m/s²)',
        align: [1, 0, 0, 0, 0, 1, 0, -1, 0],
        ranges: ACCEL_RANGES,
    },
    {
        id: CalibSensorId.LIS2MDL_MAG,
        label: 'Magnetometer (LIS2MDL)',
        unit: 'LSB/Gauss',
        align: [0, 1, 0, 0, 0, 1, -1, 0, 0],
        ranges: [{ code: 0, label: '±49.152Ga', sens: 667 }],
    },
];
/**
 * 1st-generation catalog (LIS2DW12 + LSM6DS3 accel/gyro). Sensitivities and
 * alignment from the gen-1 calibration document (ASM-DES §8). The doc states the
 * forward rotation `R` (output = K·R·physical); the stored `align` is the applied
 * sensor→common map = Rᵀ. Note the LIS2DW12 mounting differs from gen-2, so its
 * alignment (id 39) is generation-specific. All proper rotations (det +1).
 */
const CALIBRATION_SENSORS_GEN1 = [
    {
        id: CalibSensorId.LIS2DW12_ACCEL,
        label: 'Accelerometer 1 (LIS2DW12)',
        unit: 'LSB/(m/s²)',
        align: [0, 1, 0, 0, 0, 1, 1, 0, 0],
        ranges: ACCEL_RANGES,
    },
    {
        id: CalibSensorId.LSM6DS3_ACCEL,
        label: 'Accelerometer 2 (LSM6DS3)',
        unit: 'LSB/(m/s²)',
        align: [0, -1, 0, 0, 0, -1, 1, 0, 0],
        ranges: ACCEL_RANGES,
    },
    {
        id: CalibSensorId.LSM6DS3_GYRO,
        label: 'Gyroscope (LSM6DS3)',
        unit: 'LSB/dps',
        align: [0, -1, 0, 0, 0, -1, 1, 0, 0],
        ranges: LSM6DS3_GYRO_RANGES,
    },
];
/**
 * The calibration sensor catalog for a board: the 1st-generation set
 * (LIS2DW12 + LSM6DS3) for 1st-gen hardware, otherwise the 2nd-generation set
 * (LSM6DSV + LIS2DW12 + LIS2MDL). Unknown/offline (no revision) defaults to
 * 2nd-gen. Note id 39 (LIS2DW12) appears in both with a generation-specific
 * alignment, so the catalog must be resolved per hardware revision.
 */
function getVerisenseCalibrationSensors(revHwMajor, revHwMinor) {
    if (revHwMajor != null &&
        revHwMinor != null &&
        !isVerisenseSecondGenerationHardware(revHwMajor, revHwMinor)) {
        return CALIBRATION_SENSORS_GEN1;
    }
    return CALIBRATION_SENSORS_GEN2;
}
/**
 * Build the default calibration set for a board (bias=0, default sensitivity,
 * default alignment, ts=0). Host-side mirror of `AsmCalib_seedDefaults`; useful
 * for "reset to defaults" and round-trip tests.
 */
function buildDefaultVerisenseCalibrationSet(opts) {
    const sensors = getVerisenseCalibrationSensors(opts.hwVerMajor, opts.hwVerMinor);
    const blocks = sensors.flatMap((s) => s.ranges.map((r) => ({
        sensorId: s.id,
        range: r.code,
        imu: {
            bias: [0, 0, 0],
            sens: [r.sens, r.sens, r.sens],
            align: s.align.slice(),
        },
    })));
    return {
        hwVerMajor: opts.hwVerMajor,
        hwVerMinor: opts.hwVerMinor,
        fwVerMajor: opts.fwVerMajor,
        fwVerMinor: opts.fwVerMinor,
        fwVerPatch: opts.fwVerPatch,
        blocks,
    };
}
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
function getVerisenseCalibrationSensorAvailability(support) {
    const all = (v) => ({
        [CalibSensorId.LSM6DSV_ACCEL]: v,
        [CalibSensorId.LSM6DSV_GYRO]: v,
        [CalibSensorId.LIS2DW12_ACCEL]: v,
        [CalibSensorId.LSM6DS3_ACCEL]: v,
        [CalibSensorId.LSM6DS3_GYRO]: v,
        [CalibSensorId.LIS2MDL_MAG]: v,
    });
    if (!support)
        return all('enabled');
    const imuGen2 = support.imuGen2 ? 'enabled' : 'hidden';
    const gen1Imu = support.gyroAccel2 ? 'enabled' : 'hidden';
    // LIS2DW12: recorded directly on 1st-gen (accel1); present-but-algo-hub-routed
    // on 2nd-gen (imuGen2) so shown disabled; otherwise not fitted.
    const lis2dw12 = support.accel1
        ? 'enabled'
        : support.imuGen2
            ? 'disabled'
            : 'hidden';
    return {
        [CalibSensorId.LSM6DSV_ACCEL]: imuGen2,
        [CalibSensorId.LSM6DSV_GYRO]: imuGen2,
        [CalibSensorId.LIS2MDL_MAG]: imuGen2,
        [CalibSensorId.LIS2DW12_ACCEL]: lis2dw12,
        [CalibSensorId.LSM6DS3_ACCEL]: gen1Imu,
        [CalibSensorId.LSM6DS3_GYRO]: gen1Imu,
    };
}

export { ASM_COMMAND, ASM_PROPERTY, BLE_LINK_MIN_FW, BaseShimmerClient, CHANNEL_FORMATS, CalibQuality, CalibSensorId, DEBUG_COMMAND_ID, GSR_NAME, NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS, NORDIC_DFU_BUTTONLESS_WITH_BONDS, NORDIC_DFU_OP_ENTER_BOOTLOADER, NORDIC_DFU_SERVICE, NUS_RX, NUS_SERVICE, NUS_TX, OPCODES, OP_IDX, ObjectCluster, SC_CALIB_FORMAT_VERSION, SC_CAL_QUALITY_MASK, SC_CAL_QUALITY_SHIFT, SC_CAL_RANGE_MASK, SC_DATA_LEN_IMU, SC_GLOBAL_HEADER_BYTES, SHIMMER3R_DEFAULTS, STREAM_MODE, SensorADC, SensorBase, SensorBitmapShimmer3, SensorLIS2DW12, SensorLSM6DS3, SensorLSM6DSV, SensorMAX32674, SensorMLX90632, SensorPPG, SensorVD6283, Shimmer3RClient, StreamStatsTracker, TEST_MODE_ID, TIMESTAMP_FIELD, VERISENSE_CALIBRATION_MIN_FW, VERISENSE_HW_MAJOR_FRIENDLY_NAMES, VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID, VERISENSE_OPERATIONAL_FIELD_GROUPS, VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR, VERISENSE_OPERATIONAL_FIELD_SCHEMA, VERISENSE_OP_CONFIG_BYTE_SIZE, VERISENSE_SENSOR_ENABLE_FIELDS, VERISENSE_STREAM_SENSOR_LABELS, VerisenseBleDevice, applyDuplicateSuffix, applyImuCalibration, asmRtcBytesToUnixSeconds, asmRtcMinutesBytesToUnixSeconds, buildDefaultVerisenseCalibrationSet, buildHeader, buildMessage, buildParsedCsvFileName, buildProductionConfigPayload, buildUploadBinaryFileName, calibTsBytesToUnixSeconds, calibrateGsrDataToResistanceFromAmplifierEq, calibrateShimmer3RAdcChannel, calibrateU12AdcValue, calibrationBlobCrc, compareVerisenseFirmwareVersion, computeVerisensePairingPin, crc16_ccitt_false, createBlankVerisenseOperationalConfig, describeVerisenseChargerStatus, enforceVerisenseCommsChannelInterlock, evaluateParsedFileSplit, formatByteArrayAsHex, formatByteAsHex, formatPendingEventProperties, formatSchedulerPayloadForLog, formatStatusPayloadForLog, formatVerisenseChargerStatus, formatVerisenseFirmwareVersion, formatVerisenseHardwareRevision, formatVerisenseUnixAndHuman, getFirstPayloadIndex, getOversamplingRatioADS1292R, getVerisenseCalibrationSensorAvailability, getVerisenseCalibrationSensors, getVerisenseHardwareCapabilities, getVerisenseHardwareFriendlyName, getVerisenseHardwareRevision, getVerisenseHardwareSensorSupport, getVerisenseStreamSensorLabel, getVerisenseStreamingBatteryVoltageMultiplier, getVerisenseSupportedOperationalFieldGroupIds, inferVerisenseChargerChipFamily, inferVerisenseLookupBankCount, isAckCommand, isNackCommand, isUniformByteArray, isVerisenseLightDarkChannelEnabled, isVerisenseSecondGenerationHardware, nextAvailableDuplicateFileName, normalizeBytePayload, normalizeOperationalConfig, nudgeGsrResistance, parseBleLinkDebugPayload, parseCalibrationBlob, parseEventLogPayload, parseHeader, parseHexByteString, parseLookupTablePayload, parseMessage, parsePayloadCrcErrorBankIndexes, parsePendingEvents, parseProductionConfigPayload, parseProductionConfigPayloadFull, parseRecordBufferDetailsPayload, parseSchedulerDebugPayload, parseStatusPayload, readVerisenseOperationalFieldValue, serializeCalibrationBlob, setVerisenseOperationalBitRange, supportsVerisenseCalibration, supportsVerisenseMagnetometer, unixSecondsToAsmRtcBytes, unixSecondsToCalibTsBytes, writeVerisenseOperationalFieldValue };
//# sourceMappingURL=shimmer-web-sdk.esm.js.map
