(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.ShimmerBLE = {}));
})(this, (function (exports) { 'use strict';

    /**
     * SDK version, exported so consumers (e.g. the webBLEDemos pages, which vendor
     * the built bundle) can log which build they are actually running — a stale
     * vendored copy is otherwise indistinguishable from a firmware fault.
     *
     * Kept in sync with package.json by tests/core/version.test.ts.
     */
    const SDK_VERSION = '0.1.15';

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
     * A {@link ShimmerTransport} over the Web Bluetooth GATT API.
     *
     * Parameterised by service / write-characteristic / notify-characteristic UUIDs
     * so it serves both Shimmer3R and Verisense (which use different UUIDs, and
     * mirror-image write/notify roles). It performs no protocol interpretation: each
     * `characteristicvaluechanged` notification is forwarded verbatim to
     * `onNotify`, preserving chunk boundaries.
     *
     * The concrete GATT handles ({@link device}, {@link server},
     * {@link writeCharacteristic}, {@link notifyCharacteristic}) are exposed so a
     * client can reach adjacent services on the same connection (e.g. Verisense's
     * Nordic buttonless-DFU control point) without the transport having to model
     * them.
     */
    class WebBluetoothTransport {
        constructor(opts) {
            this.kind = 'ble';
            this.capabilities = { framed: true };
            this._device = null;
            this._server = null;
            this._service = null;
            this._writeChar = null;
            this._notifyChar = null;
            this._notifyCbs = new Set();
            this._disconnectCbs = new Set();
            this._onCharacteristicChanged = (evt) => {
                const dv = evt.target?.value;
                if (!dv)
                    return;
                // Copy the exact notification bytes (preserving chunk boundaries). No
                // protocol interpretation happens here.
                const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
                for (const cb of this._notifyCbs) {
                    try {
                        cb(bytes);
                    }
                    catch (e) {
                        this._log('notify handler error', e);
                    }
                }
            };
            this._onGattServerDisconnected = () => {
                for (const cb of this._disconnectCbs) {
                    try {
                        cb();
                    }
                    catch (e) {
                        this._log('disconnect handler error', e);
                    }
                }
            };
            this._serviceUUID = opts.serviceUUID;
            this._writeCharUUID = opts.writeCharUUID;
            this._notifyCharUUID = opts.notifyCharUUID;
            this._requestDeviceOptions = opts.requestDeviceOptions;
            this._device = opts.device ?? null;
            this._defaultWriteWithResponse = opts.defaultWriteWithResponse ?? false;
            this._debug = opts.debug ?? false;
            this._logTag = opts.logTag ?? '[WebBluetoothTransport]';
        }
        /** The selected `BluetoothDevice`, once chosen. */
        get device() {
            return this._device;
        }
        /** The connected GATT server, once connected. */
        get server() {
            return this._server;
        }
        /** The write characteristic (host → device), once discovered. */
        get writeCharacteristic() {
            return this._writeChar;
        }
        /** The notify characteristic (device → host), once discovered. */
        get notifyCharacteristic() {
            return this._notifyChar;
        }
        get deviceName() {
            return this._device?.name ?? undefined;
        }
        _log(...args) {
            if (this._debug)
                console.log(this._logTag, ...args);
        }
        async connect() {
            if (!this._device) {
                const requestOpts = this._requestDeviceOptions ?? {
                    filters: [{ services: [this._serviceUUID] }],
                    optionalServices: [this._serviceUUID],
                };
                this._device = await navigator.bluetooth.requestDevice(requestOpts);
            }
            // Register the link-drop listener before connecting so an immediate drop is
            // never missed.
            this._device.addEventListener('gattserverdisconnected', this._onGattServerDisconnected);
            this._server = await this._device.gatt.connect();
            this._service = await this._server.getPrimaryService(this._serviceUUID);
            this._writeChar = await this._service.getCharacteristic(this._writeCharUUID);
            this._notifyChar = await this._service.getCharacteristic(this._notifyCharUUID);
            await this._notifyChar.startNotifications();
            this._notifyChar.addEventListener('characteristicvaluechanged', this._onCharacteristicChanged);
            this._log('connected', this._device.name ?? '(unnamed)');
        }
        async disconnect() {
            try {
                if (this._notifyChar) {
                    try {
                        await this._notifyChar.stopNotifications();
                    }
                    catch {
                        /* ignore */
                    }
                    this._notifyChar.removeEventListener('characteristicvaluechanged', this._onCharacteristicChanged);
                }
                if (this._device) {
                    this._device.removeEventListener('gattserverdisconnected', this._onGattServerDisconnected);
                }
                if (this._device?.gatt?.connected)
                    this._device.gatt.disconnect();
            }
            finally {
                this._server = null;
                this._service = null;
                this._writeChar = null;
                this._notifyChar = null;
                // Keep `_device` so a caller can reconnect to the same peripheral.
            }
        }
        async write(data, opts) {
            if (!this._writeChar)
                throw new Error('Not connected (write characteristic missing)');
            const withResponse = opts?.withResponse ?? this._defaultWriteWithResponse;
            const buf = toArrayBuffer(data);
            this._log('write', data);
            if (withResponse) {
                await this._writeChar.writeValue(buf);
                return;
            }
            const ext = this._writeChar;
            if (ext.writeValueWithoutResponse) {
                await ext.writeValueWithoutResponse(buf);
            }
            else {
                await this._writeChar.writeValue(buf);
            }
        }
        onNotify(cb) {
            this._notifyCbs.add(cb);
            return () => this._notifyCbs.delete(cb);
        }
        onDisconnect(cb) {
            this._disconnectCbs.add(cb);
            return () => this._disconnectCbs.delete(cb);
        }
    }

    /**
     * A {@link ShimmerTransport} over the Web Serial API (USB COM port).
     *
     * Web Serial is an unframed byte stream, so `capabilities.framed` is `false` and
     * the notify callback fires with whatever chunk the reader yields — the client's
     * assembler re-frames. Behaviour (open parameters, read-loop teardown, writer
     * lifecycle) is ported verbatim from `VerisenseBleDevice`'s former serial path.
     */
    class WebSerialTransport {
        constructor(opts = {}) {
            this.capabilities = { framed: false };
            this._abort = null;
            this._reader = null;
            this._readLoopTask = null;
            this._notifyCbs = new Set();
            this._disconnectCbs = new Set();
            this._port = opts.port ?? null;
            this._filters = opts.filters ?? null;
            this._allowedBluetoothServiceClassIds = opts.allowedBluetoothServiceClassIds ?? null;
            this._openTimeoutMs = opts.openTimeoutMs ?? 15000;
            this.kind = opts.kind ?? 'serial';
            this._signals = {
                dataTerminalReady: opts.dataTerminalReady ?? true,
                requestToSend: opts.requestToSend ?? true,
            };
            this._debug = opts.debug ?? false;
            this._openOptions = {
                baudRate: opts.baudRate ?? 115200,
                dataBits: opts.dataBits ?? 8,
                stopBits: opts.stopBits ?? 1,
                parity: opts.parity ?? 'none',
                flowControl: opts.flowControl ?? 'none',
                ...(opts.bufferSize !== undefined ? { bufferSize: opts.bufferSize } : {}),
            };
        }
        /** The underlying serial port, once opened. */
        get port() {
            return this._port;
        }
        async connect() {
            if (!('serial' in navigator)) {
                throw new Error('Web Serial not supported. Use Chrome/Edge on HTTPS or http://localhost.');
            }
            if (!this._port) {
                const serial = navigator.serial;
                // Unknown dictionary members are ignored by WebIDL, so naming the
                // Bluetooth service classes is safe on browsers that predate them.
                const request = {};
                if (this._filters)
                    request.filters = this._filters;
                if (this._allowedBluetoothServiceClassIds) {
                    request.allowedBluetoothServiceClassIds = this._allowedBluetoothServiceClassIds;
                }
                this._port = await serial.requestPort(Object.keys(request).length ? request : undefined);
            }
            await this._openWithTimeout();
            // Assert DTR/RTS now that the port is open. The Shimmer single-slot dock
            // holds the docked sensor in RESET until both lines are asserted, so a
            // port opened without them leaves the sensor unresponsive. Non-fatal when
            // unsupported: not every serial stack implements setSignals, and hardware
            // that ignores the control lines behaves the same either way.
            try {
                await this._port.setSignals?.(this._signals);
            }
            catch (e) {
                if (this._debug)
                    console.warn('[WebSerialTransport] setSignals failed (continuing):', e);
            }
            this._abort = new AbortController();
            this._startReadLoop(this._abort.signal);
        }
        /**
         * `port.open()`, bounded by {@link WebSerialTransportOptions.openTimeoutMs}.
         *
         * Opening a classic-Bluetooth COM port is what brings the RFCOMM link up, so
         * an asleep or out-of-range sensor blocks here rather than failing fast. If
         * the timeout wins we still close the port should the open land later —
         * otherwise the OS keeps an orphaned handle and the next attempt fails with
         * "port already open" instead of the real reason.
         */
        async _openWithTimeout() {
            const port = this._port;
            const opening = port.open(this._openOptions);
            if (this._openTimeoutMs <= 0)
                return opening;
            let timedOut = false;
            let timer;
            try {
                await Promise.race([
                    opening,
                    new Promise((_resolve, reject) => {
                        timer = setTimeout(() => {
                            timedOut = true;
                            reject(new Error(`Timed out after ${this._openTimeoutMs} ms opening the serial port. ` +
                                'For a Bluetooth COM port: check the sensor is powered, in range, ' +
                                'and still paired with this PC.'));
                        }, this._openTimeoutMs);
                    }),
                ]);
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
                if (timedOut) {
                    // Never leave the late open unobserved (unhandled rejection) or the
                    // port held open behind our back.
                    void opening.then(() => port.close().catch(() => undefined), () => undefined);
                    this._port = null;
                }
            }
        }
        async write(data) {
            const writable = this._port?.writable;
            if (!writable)
                throw new Error('Not connected');
            const writer = writable.getWriter();
            try {
                await writer.write(data);
            }
            finally {
                writer.releaseLock();
            }
        }
        async disconnect(reason = 'user') {
            try {
                this._abort?.abort();
            }
            catch {
                /* ignore */
            }
            const cancelActiveReader = async () => {
                const r = this._reader;
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
                if (this._reader === r)
                    this._reader = null;
                return true;
            };
            await cancelActiveReader();
            const portReadableLocked = this._port
                ?.readable?.locked;
            if (portReadableLocked && !this._reader) {
                for (let i = 0; i < 10; i++) {
                    await new Promise((r) => setTimeout(r, 20));
                    if (await cancelActiveReader())
                        break;
                }
            }
            try {
                const task = this._readLoopTask;
                if (task)
                    await Promise.race([task, new Promise((r) => setTimeout(r, 750))]);
            }
            catch {
                /* ignore */
            }
            try {
                const writable = this._port?.writable;
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
                await this._port?.close?.();
            }
            catch {
                /* ignore */
            }
            this._port = null;
            this._abort = null;
            this._reader = null;
            this._readLoopTask = null;
            if (this._debug)
                console.warn(`[serial] disconnect done reason=${reason}`);
        }
        onNotify(cb) {
            this._notifyCbs.add(cb);
            return () => this._notifyCbs.delete(cb);
        }
        onDisconnect(cb) {
            this._disconnectCbs.add(cb);
            return () => this._disconnectCbs.delete(cb);
        }
        _emitNotify(bytes) {
            for (const cb of this._notifyCbs) {
                try {
                    cb(bytes);
                }
                catch (e) {
                    if (this._debug)
                        console.warn('[serial] notify handler error', e);
                }
            }
        }
        _startReadLoop(signal) {
            const port = this._port;
            this._readLoopTask = (async () => {
                let reader = null;
                try {
                    const readable = port.readable;
                    if (!readable)
                        return;
                    reader = readable.getReader();
                    this._reader = reader;
                    while (!signal.aborted) {
                        const { value, done } = await reader.read();
                        if (done)
                            break;
                        if (value?.length)
                            this._emitNotify(new Uint8Array(value));
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
                    if (this._reader === reader)
                        this._reader = null;
                    this._readLoopTask = null;
                    if (!signal.aborted) {
                        for (const cb of this._disconnectCbs) {
                            try {
                                cb();
                            }
                            catch {
                                /* ignore */
                            }
                        }
                    }
                }
            })();
        }
    }

    /**
     * An in-memory {@link ShimmerTransport} for tests. It preserves notification
     * chunk boundaries (each {@link notify} call = one chunk) so client behaviour
     * such as Shimmer3R's ACK-remainder handling can be exercised without a browser
     * or hardware.
     *
     * Scripting a device: pass `onWrite`, or set it later via {@link setOnWrite},
     * and respond by calling {@link notify}. Recorded writes are available on
     * {@link writes}.
     */
    class LoopbackTransport {
        constructor(opts = {}) {
            this.kind = 'loopback';
            /** Every write the client has issued, in order. */
            this.writes = [];
            /** Whether {@link connect} has run and {@link disconnect} has not. */
            this.connected = false;
            this._notifyCbs = new Set();
            this._disconnectCbs = new Set();
            this._onWrite = opts.onWrite;
            this.capabilities = { framed: true, ...opts.capabilities };
            this.deviceName = opts.deviceName;
        }
        /** Replace the write handler (e.g. after connect-time bootstrap). */
        setOnWrite(fn) {
            this._onWrite = fn;
        }
        async connect() {
            this.connected = true;
        }
        async disconnect() {
            this.connected = false;
        }
        async write(data, opts) {
            const bytes = new Uint8Array(data);
            this.writes.push({ bytes, withResponse: opts?.withResponse });
            if (this._onWrite) {
                await this._onWrite(bytes, this);
            }
        }
        onNotify(cb) {
            this._notifyCbs.add(cb);
            return () => this._notifyCbs.delete(cb);
        }
        onDisconnect(cb) {
            this._disconnectCbs.add(cb);
            return () => this._disconnectCbs.delete(cb);
        }
        /**
         * Deliver one inbound notification chunk to every {@link onNotify} listener,
         * exactly as given (no merge / re-split). Accepts a `Uint8Array` or number[].
         */
        notify(data) {
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            for (const cb of this._notifyCbs)
                cb(u8);
        }
        /** Simulate a link drop / requested disconnect. */
        emitDisconnect(reason) {
            for (const cb of this._disconnectCbs)
                cb(reason);
        }
        /** The last recorded write, or undefined. */
        get lastWrite() {
            return this.writes[this.writes.length - 1];
        }
    }

    /**
     * Escape a value for a CSV cell (RFC 4180 style): whitespace runs — including
     * newlines — collapse to a single space, then cells containing a quote or
     * comma are quoted with internal quotes doubled. Null/undefined become the
     * empty cell.
     */
    function csvCell(text) {
        const s = String(text ?? '')
            .replace(/\s+/g, ' ')
            .trim();
        return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    /**
     * Device RTC drift estimation over a live connection (DEV-844).
     *
     * Sample the device clock periodically against the host clock and fit a
     * least-squares slope of (device − host) offset vs host time: the
     * dimensionless slope × 1e6 is directly the crystal error in ppm, giving a
     * usable estimate in hours instead of waiting days between connections.
     * Device time resolves to 1/32768 s, so per-sample noise is just transport
     * round-trip jitter (~tens of ms); the fit averages it out. Host timestamps
     * should be taken at the midpoint of the read round-trip, bounding transport
     * latency to ±rtt/2.
     *
     * Host clock steps (NTP corrections) are a measurement hazard: the wall
     * clock jumping mid-series pollutes the least-squares slope while looking
     * like device drift (seen live on DEV-844: a −1.4 s Windows NTP step bent
     * the fit from 1020 to 1077 ppm). Each sample therefore also records a
     * monotonic timestamp (`performance.now()`): wall-vs-monotonic divergence
     * between samples attributes a jump to the HOST, which resets the fit
     * baseline instead of counting as a device step.
     *
     * This class is pure bookkeeping — the caller owns the sampling timer, the
     * device read, and any UI. Feed it one {@link RtcDriftSampleInput} per read.
     */
    class RtcDriftMonitor {
        constructor(options = {}) {
            this.samples = [];
            /** Device clock steps detected across the whole run (survives rebaselines). */
            this.deviceSteps = 0;
            /** Host (NTP) clock steps detected; each one rebaselines the fit. */
            this.hostSteps = 0;
            this.deviceStepThresholdSeconds = options.deviceStepThresholdSeconds ?? 1;
            this.hostStepThresholdSeconds = options.hostStepThresholdSeconds ?? 0.5;
        }
        /** Drop all samples and step counts (e.g. when starting a new run). */
        reset() {
            this.samples.length = 0;
            this.deviceSteps = 0;
            this.hostSteps = 0;
        }
        /**
         * Drop the samples but keep the step counters. Call when the device time is
         * written: a time write moves the offset baseline, so every prior sample is
         * invalid and the fit must not straddle the discontinuity.
         */
        rebaseline() {
            this.samples.length = 0;
        }
        /**
         * Record one device-time reading. Attributes any offset jump before
         * recording it: wall-clock elapsed minus monotonic elapsed isolates host
         * clock steps (NTP) from device steps. A host step resets the fit baseline
         * (the fit must not straddle the discontinuity); a device step is counted
         * and kept in-series.
         */
        addSample(input) {
            const sample = { ...input, offsetSec: input.devSec - input.hostSec };
            const prev = this.samples[this.samples.length - 1];
            const hostStepSec = prev
                ? sample.hostSec - prev.hostSec - (sample.perfMs - prev.perfMs) / 1000
                : 0;
            if (Math.abs(hostStepSec) > this.hostStepThresholdSeconds) {
                this.hostSteps++;
                this.samples.length = 0;
                this.samples.push(sample);
                return { kind: 'host-step', sample, hostStepSec };
            }
            if (prev && Math.abs(sample.offsetSec - prev.offsetSec) > this.deviceStepThresholdSeconds) {
                this.deviceSteps++;
                this.samples.push(sample);
                return { kind: 'device-step', sample, deltaSec: sample.offsetSec - prev.offsetSec };
            }
            this.samples.push(sample);
            return { kind: 'sample', sample };
        }
        /**
         * Least-squares slope of offset vs host time, in ppm (offset and time are
         * both in seconds, so the dimensionless slope × 1e6 is directly ppm).
         * Null until two samples spanning a non-zero interval exist.
         */
        ppmFit() {
            const s = this.samples;
            if (s.length < 2)
                return null;
            const t0 = s[0].hostSec;
            const y0 = s[0].offsetSec;
            let sx = 0;
            let sy = 0;
            let sxx = 0;
            let sxy = 0;
            for (const p of s) {
                const x = p.hostSec - t0;
                const y = p.offsetSec - y0;
                sx += x;
                sy += y;
                sxx += x * x;
                sxy += x * y;
            }
            const n = s.length;
            const denom = n * sxx - sx * sx;
            if (denom === 0)
                return null;
            return ((n * sxy - sx * sy) / denom) * 1e6;
        }
        /** Elapsed span of the current sample series in minutes (0 when empty). */
        elapsedMinutes() {
            const s = this.samples;
            if (s.length < 2)
                return 0;
            return (s[s.length - 1].hostSec - s[0].hostSec) / 60;
        }
        /**
         * CSV rows of the current series, matching the DEV-844 export format: a
         * header row (host ISO time, host/device unix seconds, offset, rtt,
         * monotonic seconds) followed by one row per sample.
         *
         * Optional `metadata` is emitted as `# key: value` comment lines BEFORE the
         * header (so the header is no longer row 0 when metadata is supplied), so a
         * saved file records what it came from (device, transport, the fit result,
         * etc.) - the S3R drift tool established this preamble and the console
         * adopts it. Each value has newlines collapsed so every entry stays a single
         * comment line; a caller can read the fit via
         * {@link ppmFit}/{@link deviceSteps}/{@link hostSteps} to build the map.
         */
        toCsvRows(metadata) {
            const rows = [];
            if (metadata) {
                for (const [k, v] of Object.entries(metadata)) {
                    // Keep each entry a single clean comment line.
                    const clean = String(v)
                        .replace(/[\r\n]+/g, ' ')
                        .trim();
                    rows.push(`# ${k}: ${clean}`);
                }
            }
            rows.push('host_iso,host_unix_s,device_unix_s,offset_s,rtt_ms,perf_monotonic_s');
            for (const p of this.samples) {
                rows.push(`${new Date(p.hostSec * 1000).toISOString()},${p.hostSec.toFixed(3)},${p.devSec.toFixed(5)},${p.offsetSec.toFixed(3)},${p.rttMs},${(p.perfMs / 1000).toFixed(3)}`);
            }
            return rows;
        }
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
    /**
     * Feature ids for the SET_FEATURE (0xB7) command: `[0xB7][featureId][value]`.
     * Mirrors the FEATURE_* enum in log-and-stream-common
     * `Comms/shimmer_bt_uart.h`.
     */
    const BT_FEATURE = Object.freeze({
        NONE: 0,
        /** Shimmer3 RN4678 error LEDs. */
        RN4678_ERROR_LEDS: 1,
        /**
         * Arm a one-shot soft reboot that fires when the host disconnects. Lets a
         * host apply settings only read at boot (e.g. the EEPROM brand record's
         * advertising names) without the user power-cycling the device. Firmware
         * skips the reboot while sensing, so an armed request can never truncate an
         * active SD recording.
         */
        REBOOT_ON_DISCONNECT: 2,
    });
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
    function u16le$3(b, o) {
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

    /**
     * Shimmer wired/dock UART CRC.
     *
     * This is the Shimmer-specific 16-bit CRC used by the dock UART protocol — it is
     * **not** CRC-16/CCITT-FALSE (the algorithm the Verisense client uses in
     * `../verisense/protocolUtils.ts#crc16_ccitt_false`), so it cannot be reused:
     * different seed (0xB0CA), a byte-swap step, and an odd-length zero-pad rule.
     * Ported verbatim from the Java driver:
     *   com.shimmerresearch.comms.wiredProtocol.ShimmerCrc (ShimmerCrc.java:12-60).
     *
     * All functions are pure. Every operation mirrors the Java `int` (32-bit,
     * two's-complement) arithmetic exactly — JavaScript bitwise operators are also
     * 32-bit, so the results are byte-for-byte identical (verified against the Java
     * implementation compiled and run directly; e.g. CRC over `[0x24, 0xFF]` = the
     * `TEST_ACK` header+command → `0xD9 0xB2`, matching
     * `AbstractCommsProtocolWired.TEST_ACK`).
     */
    /** Seed value for the wired UART CRC (ShimmerCrc.java:29 `CRC_INIT`). */
    const SHIMMER_UART_CRC_INIT = 0xb0ca;
    /**
     * Fold a single byte into the running CRC.
     * Ported from `ShimmerCrc.shimmerUartCrcByte` (ShimmerCrc.java:12-21).
     *
     * NB: only the first and last lines mask to 0xFFFF, exactly as in Java — the
     * intermediate byte-swap / shift / XOR steps run on the full 32-bit word. Adding
     * intermediate masks changes the result, so do not "tidy" this.
     */
    function shimmerUartCrcByte(crc, b) {
        crc &= 0xffff;
        crc = ((crc & 0xffff) >>> 8) | ((crc & 0xffff) << 8);
        crc ^= b & 0xff;
        crc ^= (crc & 0xff) >>> 4;
        crc ^= crc << 12;
        crc ^= (crc & 0xff) << 5;
        crc &= 0xffff;
        return crc;
    }
    /**
     * Compute the 2-byte CRC over the first `len` bytes of `msg`.
     * Returns `[LSB, MSB]` — the on-wire order (LSB first), matching
     * `ShimmerCrc.shimmerUartCrcCalc` (ShimmerCrc.java:28-46).
     *
     * If `len` is odd, one `0x00` byte is folded in before finalising
     * (ShimmerCrc.java:37-39) — the padding is part of the algorithm and must be
     * kept.
     *
     * @param msg the input bytes
     * @param len number of bytes to CRC (defaults to `msg.length`)
     */
    function shimmerUartCrcCalc(msg, len = msg.length) {
        let crc = shimmerUartCrcByte(SHIMMER_UART_CRC_INIT, msg[0]);
        for (let i = 1; i < len; i++) {
            crc = shimmerUartCrcByte(crc, msg[i]);
        }
        if (len % 2 > 0) {
            crc = shimmerUartCrcByte(crc, 0x00);
        }
        return [crc & 0xff, (crc >> 8) & 0xff];
    }
    /**
     * Validate a full packet whose last two bytes are the CRC (LSB then MSB).
     * Recomputes over `msg[0 .. length-2)` and compares, matching
     * `ShimmerCrc.shimmerUartCrcCheck` (ShimmerCrc.java:52-60).
     */
    function shimmerUartCrcCheck(msg) {
        if (msg.length < 3)
            return false;
        const [lsb, msb] = shimmerUartCrcCalc(msg, msg.length - 2);
        return lsb === msg[msg.length - 2] && msb === msg[msg.length - 1];
    }

    /**
     * Constants for the Shimmer wired/dock UART protocol.
     *
     * Ported from the Java driver's wiredProtocol package:
     *   com.shimmerresearch.comms.wiredProtocol.UartPacketDetails (UartPacketDetails.java)
     *   com.shimmerresearch.comms.wiredProtocol.AbstractCommsProtocolWired
     *
     * This is the protocol a Shimmer speaks when docked in a BasicDock/Base over the
     * dock's FTDI UART (host↔device). It is unrelated to the LiteProtocol used by
     * `Shimmer3Client` / `Shimmer3RClient` over Bluetooth — different framing,
     * commands, addressing and CRC.
     */
    /** ASCII `$` — every packet starts with this byte (UartPacketDetails.java:28). */
    const UART_PACKET_HEADER = 0x24;
    /**
     * Serial-line settings for the dock FTDI UART (SerialPortCommJssc.connect:
     * 8 data bits, 1 stop bit, no parity, no flow control; baud below). These are
     * transport-level hints — the codec/client are byte-pipe-agnostic — surfaced so
     * a Web Serial / native transport can configure the port. Baud from
     * AbstractSerialPortHal.SHIMMER_UART_BAUD_RATES.SHIMMER3_DOCKED = 115200.
     */
    const UART_DOCK_BAUD_RATE = 115200;
    /**
     * UART packet commands (`enum UART_PACKET_CMD`, UartPacketDetails.java:34-54).
     * WRITE/READ are host→device requests; the rest are device→host responses.
     */
    const UART_PACKET_CMD = Object.freeze({
        /** Host→device: set a component property (expects ACK). */
        WRITE: 0x01,
        /** Device→host: the data payload for a READ (carries component+property). */
        DATA_RESPONSE: 0x02,
        /** Host→device: get a component property (expects DATA_RESPONSE). */
        READ: 0x03,
        /** Device→host: unrecognised command. */
        BAD_CMD_RESPONSE: 0xfc, // 252
        /** Device→host: bad argument. */
        BAD_ARG_RESPONSE: 0xfd, // 253
        /** Device→host: CRC mismatch on the received command. */
        BAD_CRC_RESPONSE: 0xfe, // 254
        /** Device→host: command accepted (the response to a successful WRITE). */
        ACK_RESPONSE: 0xff, // 255
    });
    /**
     * UART components — the addressable sub-systems (`enum UART_COMPONENT`,
     * UartPacketDetails.java:57-80).
     */
    const UART_COMPONENT = Object.freeze({
        MAIN_PROCESSOR: 0x01,
        BAT: 0x02,
        DAUGHTER_CARD: 0x03,
        PPG: 0x04,
        GSR: 0x05,
        LSM303DLHC_ACCEL: 0x06,
        MPU9X50_ACCEL: 0x07,
        BEACON: 0x08,
        RADIO_802154: 0x09,
        RADIO_BLUETOOTH: 0x0a,
        TEST: 0x0b,
    });
    const cp = (component, property, permission, name) => Object.freeze({ component, property, permission, name });
    /**
     * The component/property table (`UART_COMPONENT_AND_PROPERTY`,
     * UartPacketDetails.java:98-160). Only the groups relevant to a docked
     * Shimmer3/3R identify + status + config path are surfaced; the GQ-only
     * 802.15.4 radio and device-self-test entries are omitted from D1 (see README).
     */
    const UART_PROP = Object.freeze({
        MAIN_PROCESSOR: Object.freeze({
            ENABLE: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x00, 'READ_WRITE', 'ENABLE'),
            SAMPLE_RATE: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x01, 'READ_WRITE', 'SAMPLE_RATE'),
            MAC: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x02, 'READ_WRITE', 'MAC'),
            VER: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x03, 'READ_ONLY', 'VER'),
            /* Access flags verified against the firmware handler (log-and-stream-common
             * Comms/shimmer_dock_usart.c): UART_SET is implemented ONLY for
             * RWC_CFG_TIME (0x04) — writing it calls RTC_setTimeFromTicksPtr(), i.e.
             * this is the property that SETS the clock (payload from msToRtcBytesLE);
             * reading it returns the time at which the RTC was last configured.
             * CURR_LOCAL_TIME (0x05) is GET-only (current RTC value) — a SET is
             * answered with BAD_CMD. */
            RTC_CFG_TIME: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x04, 'READ_WRITE', 'RTC_CFG_TIME'),
            CURR_LOCAL_TIME: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x05, 'READ_ONLY', 'CURR_LOCAL_TIME'),
            INFOMEM: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x06, 'READ_WRITE', 'INFOMEM'),
            LED0_STATE: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x07, 'READ_WRITE', 'LED_TOGGLE'),
            DEVICE_BOOT: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x08, 'READ_ONLY', 'DEVICE_BOOT'),
            ENTER_BOOTLOADER: cp(UART_COMPONENT.MAIN_PROCESSOR, 0x09, 'WRITE_ONLY', 'ENTER_BOOTLOADER'),
        }),
        BAT: Object.freeze({
            ENABLE: cp(UART_COMPONENT.BAT, 0x00, 'READ_WRITE', 'ENABLE'),
            VALUE: cp(UART_COMPONENT.BAT, 0x02, 'READ_ONLY', 'VALUE'),
            FREQ_DIVIDER: cp(UART_COMPONENT.BAT, 0x06, 'READ_WRITE', 'DIVIDER'),
        }),
        GSR: Object.freeze({
            ENABLE: cp(UART_COMPONENT.GSR, 0x00, 'READ_WRITE', 'ENABLE'),
            RANGE: cp(UART_COMPONENT.GSR, 0x03, 'READ_WRITE', 'RANGE'),
            FREQ_DIVIDER: cp(UART_COMPONENT.GSR, 0x06, 'READ_WRITE', 'DIVIDER'),
        }),
        PPG: Object.freeze({
            ENABLE: cp(UART_COMPONENT.PPG, 0x00, 'READ_WRITE', 'ENABLE'),
            FREQ_DIVIDER: cp(UART_COMPONENT.PPG, 0x06, 'READ_WRITE', 'DIVIDER'),
        }),
        DAUGHTER_CARD: Object.freeze({
            CARD_ID: cp(UART_COMPONENT.DAUGHTER_CARD, 0x02, 'READ_WRITE', 'CARD_ID'),
            CARD_MEM: cp(UART_COMPONENT.DAUGHTER_CARD, 0x03, 'READ_WRITE', 'CARD_MEM'),
        }),
        LSM303DLHC_ACCEL: Object.freeze({
            ENABLE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x00, 'READ_WRITE', 'ENABLE'),
            DATA_RATE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x02, 'READ_WRITE', 'DATA_RATE'),
            RANGE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x03, 'READ_WRITE', 'RANGE'),
            LP_MODE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x04, 'READ_WRITE', 'LP_MODE'),
            HR_MODE: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x05, 'READ_WRITE', 'HR_MODE'),
            FREQ_DIVIDER: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x06, 'READ_WRITE', 'FREQ_DIVIDER'),
            CALIBRATION: cp(UART_COMPONENT.LSM303DLHC_ACCEL, 0x07, 'READ_WRITE', 'CALIBRATION'),
        }),
        BEACON: Object.freeze({
            ENABLE: cp(UART_COMPONENT.BEACON, 0x00, 'READ_WRITE', 'ENABLE'),
            FREQ_DIVIDER: cp(UART_COMPONENT.BEACON, 0x06, 'READ_WRITE', 'DIVIDER'),
        }),
        BLUETOOTH: Object.freeze({
            VER: cp(UART_COMPONENT.RADIO_BLUETOOTH, 0x03, 'READ_ONLY', 'BT_FW_VER'),
        }),
    });
    /**
     * The ordered list of component/properties the Java config loops iterate
     * (`UartPacketDetails.mListOfUartCommandsConfig`, UartPacketDetails.java:172-197).
     *
     * NB: this list is GQ-oriented. `BasicDock.internalReadAllConfigByUart` only
     * issues each entry when the docked device's version is compatible
     * (`isVerCompatibleWithAnyOf`), and for a Shimmer3/3R the real configuration
     * path is InfoMem — not this list. It is surfaced here verbatim (same order) so
     * a caller can drive property-level get/set exactly as the Java does, and to
     * document precisely which properties the wired protocol exposes as discrete
     * commands. See README for what maps to the app config model.
     */
    const UART_CONFIG_COMMANDS = Object.freeze([
        UART_PROP.BAT.ENABLE,
        UART_PROP.BAT.FREQ_DIVIDER,
        UART_PROP.LSM303DLHC_ACCEL.ENABLE,
        UART_PROP.LSM303DLHC_ACCEL.DATA_RATE,
        UART_PROP.LSM303DLHC_ACCEL.RANGE,
        UART_PROP.LSM303DLHC_ACCEL.LP_MODE,
        UART_PROP.LSM303DLHC_ACCEL.HR_MODE,
        UART_PROP.LSM303DLHC_ACCEL.FREQ_DIVIDER,
        UART_PROP.LSM303DLHC_ACCEL.CALIBRATION,
        UART_PROP.GSR.ENABLE,
        UART_PROP.GSR.RANGE,
        UART_PROP.GSR.FREQ_DIVIDER,
        UART_PROP.BEACON.ENABLE,
        UART_PROP.BEACON.FREQ_DIVIDER,
    ]);
    /**
     * Packet framing overhead (UartPacketDetails.java:30-31).
     * DATA = header + cmd + length + component + property (CRC counted in length).
     * OTHER = header + cmd + CRC-LSB + CRC-MSB.
     */
    const PACKET_OVERHEAD_RESPONSE_DATA = 5;
    const PACKET_OVERHEAD_RESPONSE_OTHER = 4;
    /**
     * Request/response timing (AbstractCommsProtocolWired.java).
     * SERIAL_PORT_TIMEOUT = 500 ms (line 69), polled at 100 ms intervals in
     * `waitForResponse` (line 507). Retry is a dock-layer concern
     * (`AbstractDock.READ_MAC_RETRY_ATTEMPTS = 2`), not the comms layer.
     */
    const WIRED_DEFAULTS = Object.freeze({
        /** Per-request response timeout (ms). Matches Java SERIAL_PORT_TIMEOUT. */
        RESPONSE_TIMEOUT_MS: 500,
        /** MAC-read retry attempts, from AbstractDock.READ_MAC_RETRY_ATTEMPTS. */
        MAC_READ_RETRIES: 2,
    });
    /** Charging-status raw bytes (ShimmerBattStatusDetails.CHARGING_STATUS_BYTE). */
    const CHARGING_STATUS_BYTE = Object.freeze({
        SUSPENDED: 0xc0,
        FULLY_CHARGED: 0x40,
        PRECONDITIONING: 0x80,
        BAD_BATTERY: 0x00,
        UNKNOWN: 0xff,
    });

    /**
     * Pure codec for the Shimmer wired/dock UART protocol.
     *
     * Everything here is a side-effect-free function so it can be unit-tested with
     * byte fixtures and reused by the {@link WiredShimmerClient} regardless of the
     * byte pipe underneath. Ported from the Java driver:
     *   com.shimmerresearch.comms.wiredProtocol.AbstractCommsProtocolWired
     *     (#assembleTxPacket — TX build, AbstractCommsProtocolWired.java:404-456)
     *     (#processRxBuf     — RX framing, :639-757)
     *   com.shimmerresearch.comms.wiredProtocol.UartRxPacketObject (RX field parse)
     *   com.shimmerresearch.comms.wiredProtocol.CommsProtocolWiredShimmerViaDock
     *     (MAC / VER / battery response parsing)
     *   com.shimmerresearch.driverUtilities.ShimmerVerObject#parseVersionByteArray
     *   com.shimmerresearch.driverUtilities.ShimmerBattStatusDetails
     *   com.shimmerresearch.driverUtilities.ExpansionBoardDetails
     */
    // ---------------------------------------------------------------------------
    // TX — packet assembly
    // ---------------------------------------------------------------------------
    /**
     * Assemble a command packet: `$ | cmd | [length] | [comp | prop] | [payload] | crcLSB | crcMSB`.
     *
     * Mirrors `AbstractCommsProtocolWired#assembleTxPacket` (AbstractCommsProtocolWired.java:404-456):
     * - the LENGTH byte = component(1) + property(1) + payload.length, and is
     *   OMITTED entirely when that sum is 0 (i.e. an ACK/bad-response echo with no
     *   arg) — see the `msgLength>0` guard at lines 414/435;
     * - the CRC (2 bytes, LSB then MSB) is computed over the whole preceding buffer
     *   and appended, and is NOT counted in the LENGTH byte.
     *
     * @param command one of `UART_PACKET_CMD`
     * @param arg     the component/property address, or null (ACK / bad responses)
     * @param payload optional value bytes (for WRITE / mem commands), or null
     */
    function buildUartPacket(command, arg, payload = null) {
        const compPropLen = arg ? 2 : 0;
        const valueLen = payload ? payload.length : 0;
        const msgLength = compPropLen + valueLen;
        const pre = [UART_PACKET_HEADER, command & 0xff];
        if (msgLength > 0)
            pre.push(msgLength & 0xff);
        if (arg) {
            pre.push(arg.component & 0xff, arg.property & 0xff);
        }
        if (payload) {
            for (const b of payload)
                pre.push(b & 0xff);
        }
        const preU8 = Uint8Array.from(pre);
        const [crcLsb, crcMsb] = shimmerUartCrcCalc(preU8, preU8.length);
        return concatU8(preU8, Uint8Array.from([crcLsb, crcMsb]));
    }
    /** Build a READ (get) request for a component/property. */
    function buildReadPacket(arg) {
        return buildUartPacket(UART_PACKET_CMD.READ, arg);
    }
    /** Build a WRITE (set) request for a component/property with a value payload. */
    function buildWritePacket(arg, value) {
        return buildUartPacket(UART_PACKET_CMD.WRITE, arg, value);
    }
    /**
     * Build the memory-read payload used by INFOMEM / daughter-card reads:
     * `[sizeByte] [addressBytes...]`. The address is 2 bytes little-endian, except
     * for `DAUGHTER_CARD.CARD_ID` where it is a single byte
     * (AbstractCommsProtocolWired#shimmerUartGetMemCommand, :293-309).
     */
    function buildMemReadPayload(arg, address, size) {
        const singleByteAddr = isDaughterCardId(arg);
        const addr = singleByteAddr
            ? Uint8Array.from([address & 0xff])
            : Uint8Array.from([address & 0xff, (address >> 8) & 0xff]); // little-endian
        return concatU8(Uint8Array.from([size & 0xff]), addr);
    }
    /**
     * Build the memory-write payload: `[sizeByte] [addressBytes...] [data...]`
     * (AbstractCommsProtocolWired#shimmerUartSetMemCommand, :341-360). `size` is the
     * data length. Address encoding matches {@link buildMemReadPayload}.
     */
    function buildMemWritePayload(arg, address, data) {
        const head = buildMemReadPayload(arg, address, data.length);
        return concatU8(head, data);
    }
    function isDaughterCardId(arg) {
        return arg.component === 0x03 && arg.property === 0x02;
    }
    // ---------------------------------------------------------------------------
    // RTC (real-world clock) payload — set from host time
    // ---------------------------------------------------------------------------
    /**
     * Encode a UNIX-epoch millisecond value as the 8-byte, LSB-first RTC payload the
     * Shimmer expects on `MAIN_PROCESSOR.RTC_CFG_TIME`.
     *
     * Ported byte-for-byte from `UtilShimmer.convertMilliSecondsToShimmerRtcDataBytesLSB`
     * (UtilShimmer.java:854-868):
     *   1. `ticks = (long)((double)milliseconds * 32.768)` — the 32.768 kHz RTC tick
     *      count; the `(long)` cast truncates toward zero (`Math.trunc` here matches,
     *      since the IEEE-754 double multiply is identical).
     *   2. `ByteBuffer.allocate(8).putLong(ticks)` — 8 bytes big-endian (…MSB).
     *   3. `ArrayUtils.reverse(...)` — reversed to little-endian (LSB first).
     *
     * BigInt is used for the 64-bit width so the full 8-byte tick count is exact
     * (host-time ticks are ~5.6e13 in 2026 — within double range, but BigInt keeps
     * the byte extraction exact regardless).
     *
     * HARDWARE-VERIFY: this exact 8-byte LSB-first tick encoding has not been
     * exercised against a real dock/Shimmer; it is a faithful port of the Java only.
     */
    function msToRtcBytesLE(milliseconds) {
        const ticks = BigInt(Math.trunc(milliseconds * 32.768));
        const out = new Uint8Array(8);
        let v = ticks;
        for (let i = 0; i < 8; i++) {
            out[i] = Number(v & 0xffn); // LSB first
            v >>= 8n;
        }
        return out;
    }
    // HW/FW identity codes referenced by the RTC-config gate below
    // (ShimmerVerDetails.HW_ID / FW_ID). Only the values the gate reads are defined.
    const RTC_HW_ID = Object.freeze({
        SHIMMER_3: 3,
        SHIMMER_GQ_BLE: 5,
        SHIMMER_2R_GQ: 9,
        SHIMMER_3R: 10,
        SHIMMER_GQ_802154_LR: 56,
        SHIMMER_GQ_802154_NR: 57,
        SHIMMER_4_SDK: 58,
    });
    const RTC_FW_ID = Object.freeze({
        SDLOG: 2,
        LOGANDSTREAM: 3,
        GQ_BLE: 5,
        STROKARE: 15,
    });
    /**
     * Whether the docked device supports setting its real-world clock over the dock
     * UART. Faithful port of `ShimmerVerObject.isSupportedRtcConfigViaUart(hwVer, fwId)`
     * (ShimmerVerObject.java:405-418) — desktop `CallableWriteConfig` only issues the
     * RTC write when this is true (BasicDock.java:1564), and SKIPS it otherwise. For
     * the Shimmer3/3R scope: Shimmer3 requires SDLog/LogAndStream/StroKare firmware;
     * Shimmer3R is supported on any firmware. The GQ/Shimmer4 branches are ported
     * verbatim for completeness.
     */
    function isSupportedRtcConfigViaUart(hwVer, fwId) {
        if ((hwVer === RTC_HW_ID.SHIMMER_3 && fwId === RTC_FW_ID.SDLOG) ||
            (hwVer === RTC_HW_ID.SHIMMER_3 && fwId === RTC_FW_ID.LOGANDSTREAM) ||
            (hwVer === RTC_HW_ID.SHIMMER_3 && fwId === RTC_FW_ID.STROKARE) ||
            (hwVer === RTC_HW_ID.SHIMMER_GQ_BLE && fwId === RTC_FW_ID.GQ_BLE) ||
            hwVer === RTC_HW_ID.SHIMMER_GQ_802154_NR ||
            hwVer === RTC_HW_ID.SHIMMER_GQ_802154_LR ||
            hwVer === RTC_HW_ID.SHIMMER_2R_GQ ||
            hwVer === RTC_HW_ID.SHIMMER_4_SDK ||
            hwVer === RTC_HW_ID.SHIMMER_3R) {
            return true;
        }
        return false;
    }
    // ---------------------------------------------------------------------------
    // RX — framing (reassembly length) + single-packet parse
    // ---------------------------------------------------------------------------
    /** Sentinel: not enough bytes buffered yet to know the message length. */
    const NEED_MORE$2 = -1;
    /** Sentinel: leading byte is not a valid header/command — caller drops 1 byte. */
    const RESYNC$2 = 0;
    /**
     * Given the head of the accumulated RX buffer, return the total byte length of
     * the complete UART packet it starts with, or {@link NEED_MORE} / {@link RESYNC}.
     *
     * This is the primitive that makes the unframed serial stream tractable: the
     * dock UART (over FTDI serial) delivers bytes split or coalesced arbitrarily, so
     * the client cannot assume one read == one packet. The Java driver solves the
     * same problem in `processRxBuf` with blocking top-up reads that know each
     * packet's length from `PACKET_OVERHEAD_RESPONSE_* + payloadLength`
     * (AbstractCommsProtocolWired.java:661-680); this expresses that as a pure
     * function.
     *
     * - Header must be `$` (0x24); otherwise RESYNC.
     * - DATA_RESPONSE/READ/WRITE: length = 5 + LENGTH-byte (needs index 2 present).
     * - ACK / BAD_*: length = 4.
     */
    function wiredPacketLength(buf) {
        if (buf.length === 0)
            return NEED_MORE$2;
        if (buf[0] !== UART_PACKET_HEADER)
            return RESYNC$2;
        if (buf.length < 2)
            return NEED_MORE$2;
        const cmd = buf[1];
        if (cmd === UART_PACKET_CMD.DATA_RESPONSE ||
            cmd === UART_PACKET_CMD.READ ||
            cmd === UART_PACKET_CMD.WRITE) {
            if (buf.length < 3)
                return NEED_MORE$2; // need the LENGTH byte at index 2
            return PACKET_OVERHEAD_RESPONSE_DATA + buf[2];
        }
        if (cmd === UART_PACKET_CMD.ACK_RESPONSE ||
            cmd === UART_PACKET_CMD.BAD_CMD_RESPONSE ||
            cmd === UART_PACKET_CMD.BAD_ARG_RESPONSE ||
            cmd === UART_PACKET_CMD.BAD_CRC_RESPONSE) {
            return PACKET_OVERHEAD_RESPONSE_OTHER;
        }
        return RESYNC$2; // unknown command byte
    }
    /**
     * Parse exactly one complete packet from the START of `buf`. The caller is
     * responsible for having ensured a full packet is present (via
     * {@link wiredPacketLength}); the length is recomputed here and used to slice.
     *
     * Field extraction mirrors `UartRxPacketObject` (UartRxPacketObject.java:34-72):
     * for DATA_RESPONSE/READ/WRITE the LENGTH byte at index 2 counts
     * component+property+payload, so the payload is `LENGTH-2` bytes starting at
     * index 5 and the CRC is the final 2 bytes. CRC is validated with
     * `shimmerUartCrcCheck` over the whole packet (AbstractCommsProtocolWired
     * #parseSinglePacket, :760-767).
     *
     * @throws if `buf` does not start with a header or is too short for the packet.
     */
    function parseUartPacket(buf) {
        if (buf.length < 2 || buf[0] !== UART_PACKET_HEADER) {
            throw new Error('parseUartPacket: buffer does not start with a UART packet header');
        }
        const command = buf[1];
        const total = wiredPacketLength(buf);
        if (total <= 0 || buf.length < total) {
            throw new Error('parseUartPacket: incomplete packet');
        }
        const packet = buf.subarray(0, total);
        const crcOk = shimmerUartCrcCheck(packet);
        if (command === UART_PACKET_CMD.DATA_RESPONSE ||
            command === UART_PACKET_CMD.READ ||
            command === UART_PACKET_CMD.WRITE) {
            const lengthByte = buf[2];
            const component = buf[3];
            const property = buf[4];
            // payload = LENGTH-2 bytes at offset 5 (comp+prop already consumed).
            const payloadLen = Math.max(0, lengthByte - 2);
            const payload = new Uint8Array(packet.subarray(5, 5 + payloadLen));
            return { command, component, property, payload, crcOk, length: total };
        }
        // ACK / BAD_* — no component/property/payload.
        return {
            command,
            component: null,
            property: null,
            payload: new Uint8Array(0),
            crcOk,
            length: total,
        };
    }
    /** True when a parsed command byte is one of the device error responses. */
    function isBadResponse(command) {
        return (command === UART_PACKET_CMD.BAD_CMD_RESPONSE ||
            command === UART_PACKET_CMD.BAD_ARG_RESPONSE ||
            command === UART_PACKET_CMD.BAD_CRC_RESPONSE);
    }
    /** Map a bad-response command byte to a human-readable reason. */
    function badResponseReason(command) {
        switch (command) {
            case UART_PACKET_CMD.BAD_CMD_RESPONSE:
                return 'BAD_CMD';
            case UART_PACKET_CMD.BAD_ARG_RESPONSE:
                return 'BAD_ARG';
            case UART_PACKET_CMD.BAD_CRC_RESPONSE:
                return 'BAD_CRC';
            default:
                return `0x${command.toString(16)}`;
        }
    }
    // ---------------------------------------------------------------------------
    // Response payload parsers
    // ---------------------------------------------------------------------------
    /**
     * Format a MAC-address payload as a 12-char UPPERCASE hex string (no
     * separators), taking the first 6 bytes in the order the device sends them.
     * Mirrors `CommsProtocolWiredShimmerViaDock#readMacId` (:40-53) +
     * `UtilShimmer.bytesToHexString`, whose `hexArray = "0123456789ABCDEF"` renders
     * uppercase — matching this SDK's Verisense MAC/hex rendering.
     */
    function parseMacId(payload) {
        if (payload.length < 6)
            throw new Error('MAC payload too short (need 6 bytes)');
        let s = '';
        for (let i = 0; i < 6; i++)
            s += payload[i].toString(16).toUpperCase().padStart(2, '0');
        return s;
    }
    /**
     * Parse a VER response payload. Accepts the 7-byte (1-byte HW version) or
     * 8-byte (2-byte HW version) layout, matching
     * `ShimmerVerObject#parseVersionByteArray` (ShimmerVerObject.java:193-217):
     *   7-byte: [hw][fwId LE(2)][major LE(2)][minor][internal]
     *   8-byte: [hw LE(2)][fwId LE(2)][major LE(2)][minor][internal]
     */
    function parseVersionInfo(payload) {
        if (payload.length !== 7 && payload.length !== 8) {
            throw new Error(`VER payload must be 7 or 8 bytes, got ${payload.length}`);
        }
        let i = 0;
        let hardwareVersion;
        if (payload.length === 7) {
            hardwareVersion = payload[i++] & 0xff;
        }
        else {
            hardwareVersion = (payload[i++] | (payload[i++] << 8)) & 0xffff;
        }
        const firmwareIdentifier = (payload[i++] | (payload[i++] << 8)) & 0xffff;
        const firmwareVersionMajor = (payload[i++] | (payload[i++] << 8)) & 0xffff;
        const firmwareVersionMinor = payload[i++] & 0xff;
        const firmwareVersionInternal = payload[i] & 0xff;
        return {
            hardwareVersion,
            firmwareIdentifier,
            firmwareVersionMajor,
            firmwareVersionMinor,
            firmwareVersionInternal,
        };
    }
    const BATTERY_ERROR_VOLTAGE = 4.5;
    /**
     * Convert a raw 12-bit battery ADC value to volts.
     * `adcValToBattVoltage` (ShimmerBattStatusDetails.java:143-147): the U12 ADC is
     * calibrated to millivolts (Vref=3 V, gain=1, offset=0 — reusing the shared
     * {@link calibrateU12AdcValue}), scaled by the on-board divider factor 1.988,
     * then converted mV→V.
     */
    function battAdcToVoltage(adcValue) {
        const mv = calibrateU12AdcValue(adcValue, 0, 3, 1);
        return (mv * 1.988) / 1000;
    }
    /**
     * 4th-order polynomial charge-% estimate from voltage
     * (ShimmerBattStatusDetails#battVoltageToBattPercentage, :175-181), with the
     * pre-clamp to [3.2, 4.167] V and post-clamp to [0, 100]
     * (#calculateBattPercentage, :155-173).
     */
    function battVoltageToPercentage(voltage) {
        let v = voltage;
        if (v > 4.167 + 0.2)
            v = 4.167;
        else if (v < 3.2 - 0.2)
            v = 3.2;
        let pct = 1109.739792 * v ** 4 -
            17167.12674 * v ** 3 +
            99232.71686 * v ** 2 -
            253825.397 * v +
            242266.0527;
        if (pct > 100)
            pct = 100;
        else if (pct < 0)
            pct = 0;
        return pct;
    }
    function decodeChargingStatus(raw, voltage) {
        if (voltage > BATTERY_ERROR_VOLTAGE)
            return 'CHECKING';
        switch (raw & 0xff) {
            case CHARGING_STATUS_BYTE.SUSPENDED:
                return 'SUSPENDED';
            case CHARGING_STATUS_BYTE.FULLY_CHARGED:
                return 'FULLY_CHARGED';
            case CHARGING_STATUS_BYTE.PRECONDITIONING:
                return 'CHARGING';
            case CHARGING_STATUS_BYTE.BAD_BATTERY:
                return 'BAD_BATTERY';
            case CHARGING_STATUS_BYTE.UNKNOWN:
                return 'UNKNOWN';
            default:
                return 'ERROR';
        }
    }
    /**
     * Parse a BAT.VALUE response payload (needs ≥3 bytes). ADC is a 12-bit
     * little-endian value in bytes [0..1] (LSB first), charging status byte [2]
     * (ShimmerBattStatusDetails.java:74-82).
     */
    function parseBatteryStatus(payload) {
        if (payload.length < 3)
            throw new Error('battery payload too short (need 3 bytes)');
        const adcValue = ((payload[1] & 0xff) << 8) | (payload[0] & 0xff);
        const voltage = battAdcToVoltage(adcValue);
        const chargingStatusRaw = payload[2] & 0xff;
        const percentage = voltage <= BATTERY_ERROR_VOLTAGE ? battVoltageToPercentage(voltage) : null;
        return {
            adcValue,
            voltage,
            percentage,
            chargingStatusRaw,
            chargingStatus: decodeChargingStatus(chargingStatusRaw, voltage),
        };
    }
    /**
     * Parse the first 3 bytes of a daughter-card CARD_ID read as
     * `[boardId, boardRev, specialRev]` (ExpansionBoardDetails.java:58-60). Returns
     * null when the board is absent (an unwritten card memory reads back all 0xFF).
     */
    function parseExpansionBoard(payload) {
        if (payload.length < 3)
            return null;
        const boardId = payload[0] & 0xff;
        const boardRev = payload[1] & 0xff;
        const specialRev = payload[2] & 0xff;
        if (boardId === 0xff && boardRev === 0xff && specialRev === 0xff)
            return null;
        return { boardId, boardRev, specialRev };
    }

    /**
     * Sentinels shared by the byte-stream (unframed transport) message framers.
     *
     * A framer is a pure function `(buf) => number` that reports how many bytes the
     * message at the head of `buf` occupies, so a client reading from an unframed
     * pipe (Web Serial, RFCOMM/SPP, a dock UART) can rebuild the message boundaries
     * that BLE notifications hand it for free.
     *
     * `src/devices/shimmer3/protocol.ts` and `src/devices/dock/protocol.ts` each
     * predate this module and export their own identically-valued copies; they are
     * public API and are left alone. New framers should import from here.
     */
    /** Not enough bytes buffered yet to determine the message length. */
    const NEED_MORE$1 = -1;
    /**
     * The leading byte is not the start of a message we understand — the caller
     * should drop one byte and retry (resynchronise) rather than guess a length.
     */
    const RESYNC$1 = 0;

    /**
     * Wire protocol for Shimmer3R SD-card file transfer over BLE.
     *
     * Mirrors the firmware implementation in
     * `log-and-stream-common/Comms/shimmer_sd_file_transfer.{c,h}` (FW >= v1.01.009).
     *
     * Command/response shapes (all multi-byte fields little-endian):
     *
     *   SD_LIST_DIR_COMMAND  0xCC: [startIdx u16][maxEntries u8][pathLen u8][path]
     *   SD_LIST_DIR_RESPONSE 0xC1: [status][startIdx u16][entriesLen u16][nEntries][flags][entries…]
     *       entry: [attr][size u32][fdate u16][ftime u16][nameLen][name…]
     *   SD_FILE_STAT_COMMAND 0xC2: [pathLen u8][path]
     *   SD_FILE_STAT_RESPONSE 0xC3: [status][size u32][fdate u16][ftime u16][attr]
     *   SD_FILE_READ_COMMAND 0xC4: [offset u32][windowLen u32][blockPayloadLen u16][pathLen u8][path]
     *   SD_FREE_SPACE_COMMAND 0xC8 / RESPONSE 0xC9: [status][freeKB u32][totalKB u32]
     *   SD_DELETE_COMMAND 0xCA / RESPONSE 0xCB: [status]
     *   SD_TRANSFER_ABORT_COMMAND 0xC7: no args
     *
     * Streamed frames (always self-CRC'd, independent of the global CRC mode):
     *   data:   [0x8A][0xC5][sessionId][seq u16][len u16][payload…][crc16 u16]
     *   status: [0x8A][0xC6][sessionId][status][nextOffset u32][crc16 u16]
     */
    const SD_TRANSFER_OPCODES = {
        // Command opcodes must avoid the CYW20820 EZ-Serial SOF bytes 0x80/0xC0/
        // 0xD0 (the firmware's UART RX demux would route them to the EZ-Serial
        // parser instead of the Shimmer command parser) — hence LIST sits at 0xCC.
        LIST_DIR_COMMAND: 0xcc,
        LIST_DIR_RESPONSE: 0xc1,
        FILE_STAT_COMMAND: 0xc2,
        FILE_STAT_RESPONSE: 0xc3,
        FILE_READ_COMMAND: 0xc4,
        FILE_DATA_RESPONSE: 0xc5,
        FILE_STATUS_RESPONSE: 0xc6,
        TRANSFER_ABORT_COMMAND: 0xc7,
        FREE_SPACE_COMMAND: 0xc8,
        FREE_SPACE_RESPONSE: 0xc9,
        DELETE_COMMAND: 0xca,
        DELETE_RESPONSE: 0xcb,
    };
    /** Prefix byte shared with the firmware's other instream responses. */
    const SD_INSTREAM_BYTE = 0x8a;
    /** Status byte of the one-shot responses. 0x01–0x13 are raw FatFs FRESULTs. */
    const SD_STATUS = {
        OK: 0x00,
        SD_UNAVAILABLE: 0xf0,
        BUSY: 0xf1,
        BAD_ARGS: 0xf2,
    };
    /** Codes carried in SD_FILE_STATUS_RESPONSE frames. */
    const SD_XFER = {
        WINDOW_COMPLETE: 0,
        EOF: 1,
        HOST_ABORT: 2,
        SD_LOST: 3,
        FS_ERROR: 4,
        SUPERSEDED: 5,
        DENIED: 6,
        NOT_FOUND: 7,
    };
    const SD_ATTR_DIR = 0x01;
    const SD_ATTR_NAME_TRUNCATED = 0x02;
    const SD_MAX_PATH_LEN = 96;
    const SD_LIST_MAX_ENTRIES = 16;
    const SD_BLOCK_PAYLOAD_MIN = 64;
    const SD_BLOCK_PAYLOAD_MAX = 1024;
    const SD_BLOCK_PAYLOAD_DEFAULT = 512;
    const DATA_FRAME_HEADER_LEN = 7;
    const FRAME_CRC_LEN = 2;
    const STATUS_FRAME_LEN = 8 + FRAME_CRC_LEN;
    const LIST_RSP_HDR_LEN = 8;
    /** Error carrying the in-band status byte of a refused/failed SD command. */
    class SdTransferError extends Error {
        constructor(message, status) {
            super(message);
            this.status = status;
            this.name = 'SdTransferError';
        }
    }
    function sdStatusToString(status) {
        switch (status) {
            case SD_STATUS.OK:
                return 'OK';
            case SD_STATUS.SD_UNAVAILABLE:
                return 'SD unavailable (docked, USB-C plugged, no card or bad card)';
            case SD_STATUS.BUSY:
                return 'device busy (sensing/logging/streaming)';
            case SD_STATUS.BAD_ARGS:
                return 'bad arguments';
            default:
                return `FatFs error ${status}`;
        }
    }
    function sdXferStatusToString(status) {
        switch (status) {
            case SD_XFER.WINDOW_COMPLETE:
                return 'window complete';
            case SD_XFER.EOF:
                return 'end of file';
            case SD_XFER.HOST_ABORT:
                return 'aborted by host';
            case SD_XFER.SD_LOST:
                return 'SD card lost (docked or USB-C plugged)';
            case SD_XFER.FS_ERROR:
                return 'filesystem error';
            case SD_XFER.SUPERSEDED:
                return 'superseded by a newer read';
            case SD_XFER.DENIED:
                return 'denied (busy or bad arguments)';
            case SD_XFER.NOT_FOUND:
                return 'file not found';
            default:
                return `unknown transfer status ${status}`;
        }
    }
    // ---------------------------------------------------------------------------
    // CRC16 — mirrors the firmware's ShimSwCrc (init 0xB0CA, odd-length zero pad)
    // ---------------------------------------------------------------------------
    const SD_CRC_INIT = 0xb0ca;
    function crcByte(crc, b) {
        crc = (((crc >> 8) & 0xff) | (crc << 8)) & 0xffff;
        crc ^= b & 0xff;
        crc ^= (crc & 0xff) >> 4;
        crc = (crc ^ (crc << 12)) & 0xffff;
        crc = (crc ^ ((crc & 0xff) << 5)) & 0xffff;
        return crc;
    }
    /** Shimmer CRC16 over `len` bytes of `data` (defaults to all of it). */
    function sdCrc16(data, len = data.length) {
        let crc = SD_CRC_INIT;
        for (let i = 0; i < len; i++)
            crc = crcByte(crc, data[i]);
        if (len % 2)
            crc = crcByte(crc, 0x00);
        return crc;
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    function u16(buf, off) {
        return buf[off] | (buf[off + 1] << 8);
    }
    function u32(buf, off) {
        return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
    }
    /** Encode and validate a card path (ASCII, 1..96 bytes). */
    function encodeSdPath(path) {
        if (path.length === 0 || path.length > SD_MAX_PATH_LEN) {
            throw new SdTransferError(`path must be 1..${SD_MAX_PATH_LEN} characters, got ${path.length}`, SD_STATUS.BAD_ARGS);
        }
        const out = new Uint8Array(path.length);
        for (let i = 0; i < path.length; i++) {
            const c = path.charCodeAt(i);
            if (c < 0x20 || c > 0x7e) {
                throw new SdTransferError(`path contains non-ASCII character at index ${i}`, SD_STATUS.BAD_ARGS);
            }
            out[i] = c;
        }
        return out;
    }
    /** Decode a FAT date/time pair; null when unset or invalid. */
    function fatDateTimeToDate(fdate, ftime) {
        if (!fdate)
            return null;
        const year = 1980 + ((fdate >> 9) & 0x7f);
        const month = (fdate >> 5) & 0x0f;
        const day = fdate & 0x1f;
        const hours = (ftime >> 11) & 0x1f;
        const minutes = (ftime >> 5) & 0x3f;
        const seconds = (ftime & 0x1f) * 2;
        if (month < 1 || month > 12 || day < 1 || day > 31)
            return null;
        if (hours > 23 || minutes > 59 || seconds > 59)
            return null;
        return new Date(year, month - 1, day, hours, minutes, seconds);
    }
    // ---------------------------------------------------------------------------
    // Command builders
    // ---------------------------------------------------------------------------
    function buildListDirCmd(path, startIdx = 0, maxEntries = SD_LIST_MAX_ENTRIES) {
        const p = encodeSdPath(path);
        const cmd = new Uint8Array(5 + p.length);
        cmd[0] = SD_TRANSFER_OPCODES.LIST_DIR_COMMAND;
        cmd[1] = startIdx & 0xff;
        cmd[2] = (startIdx >> 8) & 0xff;
        cmd[3] = maxEntries & 0xff;
        cmd[4] = p.length;
        cmd.set(p, 5);
        return cmd;
    }
    function buildStatCmd(path) {
        const p = encodeSdPath(path);
        const cmd = new Uint8Array(2 + p.length);
        cmd[0] = SD_TRANSFER_OPCODES.FILE_STAT_COMMAND;
        cmd[1] = p.length;
        cmd.set(p, 2);
        return cmd;
    }
    function buildDeleteCmd(path) {
        const p = encodeSdPath(path);
        const cmd = new Uint8Array(2 + p.length);
        cmd[0] = SD_TRANSFER_OPCODES.DELETE_COMMAND;
        cmd[1] = p.length;
        cmd.set(p, 2);
        return cmd;
    }
    function buildFreeSpaceCmd() {
        return new Uint8Array([SD_TRANSFER_OPCODES.FREE_SPACE_COMMAND]);
    }
    function buildAbortCmd() {
        return new Uint8Array([SD_TRANSFER_OPCODES.TRANSFER_ABORT_COMMAND]);
    }
    function buildReadCmd(path, offset, windowLen, blockPayloadLen = SD_BLOCK_PAYLOAD_DEFAULT) {
        if (blockPayloadLen < SD_BLOCK_PAYLOAD_MIN || blockPayloadLen > SD_BLOCK_PAYLOAD_MAX) {
            throw new SdTransferError(`blockPayloadLen must be ${SD_BLOCK_PAYLOAD_MIN}..${SD_BLOCK_PAYLOAD_MAX}, got ${blockPayloadLen}`, SD_STATUS.BAD_ARGS);
        }
        const p = encodeSdPath(path);
        const cmd = new Uint8Array(12 + p.length);
        cmd[0] = SD_TRANSFER_OPCODES.FILE_READ_COMMAND;
        new DataView(cmd.buffer).setUint32(1, offset >>> 0, true);
        new DataView(cmd.buffer).setUint32(5, windowLen >>> 0, true);
        new DataView(cmd.buffer).setUint16(9, blockPayloadLen, true);
        cmd[11] = p.length;
        cmd.set(p, 12);
        return cmd;
    }
    function parseListDirRsp(buf) {
        if (buf.length < LIST_RSP_HDR_LEN || buf[0] !== SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE) {
            throw new Error('malformed SD_LIST_DIR_RESPONSE');
        }
        const status = buf[1];
        const startIdx = u16(buf, 2);
        const entriesLen = u16(buf, 4);
        const nEntries = buf[6];
        const hasMore = (buf[7] & 0x01) !== 0;
        const entries = [];
        let off = LIST_RSP_HDR_LEN;
        const end = LIST_RSP_HDR_LEN + entriesLen;
        if (buf.length < end)
            throw new Error('truncated SD_LIST_DIR_RESPONSE');
        while (off < end && entries.length < nEntries) {
            const attr = buf[off];
            const size = u32(buf, off + 1);
            const fdate = u16(buf, off + 5);
            const ftime = u16(buf, off + 7);
            const nameLen = buf[off + 9];
            const nameBytes = buf.subarray(off + 10, off + 10 + nameLen);
            entries.push({
                name: String.fromCharCode(...nameBytes),
                isDir: (attr & SD_ATTR_DIR) !== 0,
                nameTruncated: (attr & SD_ATTR_NAME_TRUNCATED) !== 0,
                size,
                fdate,
                ftime,
                mtime: fatDateTimeToDate(fdate, ftime),
            });
            off += 10 + nameLen;
        }
        return { status, startIdx, entries, hasMore };
    }
    function parseStatRsp(buf) {
        if (buf.length < 11 || buf[0] !== SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE) {
            throw new Error('malformed SD_FILE_STAT_RESPONSE');
        }
        const fdate = u16(buf, 6);
        const ftime = u16(buf, 8);
        return {
            status: buf[1],
            stat: {
                size: u32(buf, 2),
                fdate,
                ftime,
                mtime: fatDateTimeToDate(fdate, ftime),
                isDir: (buf[10] & SD_ATTR_DIR) !== 0,
            },
        };
    }
    function parseFreeSpaceRsp(buf) {
        if (buf.length < 10 || buf[0] !== SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE) {
            throw new Error('malformed SD_FREE_SPACE_RESPONSE');
        }
        return { status: buf[1], space: { freeKB: u32(buf, 2), totalKB: u32(buf, 6) } };
    }
    function parseDeleteRsp(buf) {
        if (buf.length < 2 || buf[0] !== SD_TRANSFER_OPCODES.DELETE_RESPONSE) {
            throw new Error('malformed SD_DELETE_RESPONSE');
        }
        return { status: buf[1] };
    }
    // ---------------------------------------------------------------------------
    // Incremental extractor
    // ---------------------------------------------------------------------------
    /** Expected total length of a one-shot response, or 0 if `buf` is too short
     * to tell yet, or -1 if buf[0] is not a known one-shot response opcode. */
    function oneShotLength(buf) {
        switch (buf[0]) {
            case SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE:
                if (buf.length < 6)
                    return 0;
                return LIST_RSP_HDR_LEN + u16(buf, 4);
            case SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE:
                return 11;
            case SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE:
                return 10;
            case SD_TRANSFER_OPCODES.DELETE_RESPONSE:
                return 2;
            default:
                return -1;
        }
    }
    /**
     * Total length of the SD-transfer message at the head of `buf`, or
     * {@link NEED_MORE} / {@link RESYNC}.
     *
     * The single source of truth for SD frame spans: {@link tryExtractSdMessage}
     * uses it to slice a message before CRC-checking it, and the Shimmer3R client's
     * unframed-transport drain uses it to decide how many bytes of a serial byte
     * stream belong to one SD message. CRC validity is deliberately not considered
     * here — a frame with a bad CRC still occupies the same span, and it is the
     * extractor's job to reject it.
     */
    function sdMessageSpan(buf) {
        if (buf.length === 0)
            return NEED_MORE$1;
        if (buf[0] === SD_INSTREAM_BYTE) {
            if (buf.length < 2)
                return NEED_MORE$1;
            if (buf[1] === SD_TRANSFER_OPCODES.FILE_DATA_RESPONSE) {
                if (buf.length < DATA_FRAME_HEADER_LEN)
                    return NEED_MORE$1;
                const len = u16(buf, 5);
                if (len === 0 || len > SD_BLOCK_PAYLOAD_MAX)
                    return RESYNC$1;
                const total = DATA_FRAME_HEADER_LEN + len + FRAME_CRC_LEN;
                return buf.length < total ? NEED_MORE$1 : total;
            }
            if (buf[1] === SD_TRANSFER_OPCODES.FILE_STATUS_RESPONSE) {
                return buf.length < STATUS_FRAME_LEN ? NEED_MORE$1 : STATUS_FRAME_LEN;
            }
            /* An instream response that is not part of the SD-transfer protocol
             * (e.g. an unsolicited status response) — resync past it. */
            return RESYNC$1;
        }
        const len = oneShotLength(buf);
        if (len === -1)
            return RESYNC$1;
        if (len === 0 || buf.length < len)
            return NEED_MORE$1;
        return len;
    }
    /**
     * Try to extract one SD-transfer message from the front of `buf`.
     * Unknown bytes are skipped one at a time (resync) so interleaved traffic
     * (e.g. unsolicited instream status responses) cannot jam the stream.
     */
    function tryExtractSdMessage(buf) {
        const span = sdMessageSpan(buf);
        if (span === NEED_MORE$1)
            return { consumed: 0 };
        if (span === RESYNC$1)
            return { consumed: 1 };
        if (buf[0] === SD_INSTREAM_BYTE) {
            if (buf[1] === SD_TRANSFER_OPCODES.FILE_DATA_RESPONSE) {
                const len = u16(buf, 5);
                const crcOk = sdCrc16(buf, DATA_FRAME_HEADER_LEN + len) === u16(buf, DATA_FRAME_HEADER_LEN + len);
                if (!crcOk)
                    return { consumed: 1, crcError: true };
                return {
                    consumed: span,
                    msg: {
                        kind: 'data',
                        sessionId: buf[2],
                        seq: u16(buf, 3),
                        payload: buf.slice(DATA_FRAME_HEADER_LEN, DATA_FRAME_HEADER_LEN + len),
                        crcOk,
                    },
                };
            }
            // FILE_STATUS_RESPONSE — the only other span sdMessageSpan accepts here.
            const crcOk = sdCrc16(buf, 8) === u16(buf, 8);
            if (!crcOk)
                return { consumed: 1, crcError: true };
            return {
                consumed: span,
                msg: { kind: 'status', sessionId: buf[2], status: buf[3], nextOffset: u32(buf, 4), crcOk },
            };
        }
        return { consumed: span, msg: { kind: 'oneshot', opcode: buf[0], body: buf.slice(0, span) } };
    }

    /**
     * Message framing for a Shimmer3R reached over an **unframed** byte stream.
     *
     * Over BLE the module hands the client one notification per firmware message,
     * so {@link Shimmer3RClient} can assume `chunk[0]` is an opcode and the rest of
     * the chunk is that message. A byte stream — Web Serial over USB, or over the
     * virtual COM port Windows/macOS create for a Shimmer paired via classic
     * Bluetooth (RFCOMM/SPP) — offers no such guarantee: messages arrive split
     * across reads and coalesced with their neighbours.
     *
     * {@link shimmer3rControlMessageLength} restores those boundaries the way
     * `shimmer3ControlMessageLength` does for the classic Shimmer3: as a pure
     * length function the client's drain loop can consult, expressing the same
     * length knowledge the Java driver encodes in its blocking `readBytes(n)`
     * calls.
     *
     * SD-transfer traffic is delegated to {@link sdMessageSpan} so the frame layout
     * has exactly one definition.
     */
    /**
     * Offset of the `numChannels` byte within an opcode-prefixed
     * INQUIRY_RESPONSE. Shimmer3R's config word is 7 bytes at [3..9] (Shimmer3's is
     * 4 at [3..6]) which pushes numChannels to [10] and bufferSize to [11].
     */
    const SHIMMER3R_INQ_NUM_CHANNELS_OFFSET = 10;
    /** Offset of the first channel-ID byte within an INQUIRY_RESPONSE. */
    const SHIMMER3R_INQ_CHANNELS_OFFSET = SHIMMER3R_INQ_NUM_CHANNELS_OFFSET + 2; // 12
    /**
     * Fixed payload lengths (bytes AFTER the opcode) for the fixed-width control
     * responses. Variable-length responses (INQUIRY_RESPONSE, DAUGHTER_CARD_MEM_
     * RESPONSE, everything SD) are handled explicitly in
     * {@link shimmer3rControlMessageLength}.
     *
     * **Extension point.** An opcode absent from here — and from the special cases
     * below — cannot be framed, so the drain loop resynchronises past it one byte at
     * a time and whatever command was awaiting it times out. Add an entry when
     * teaching the client a new GET over an unframed transport; the value is the
     * response's `response_size` in the LiteProtocol instruction set, minus the
     * opcode byte.
     */
    const SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS = Object.freeze({
        [OPCODES.SAMPLING_RATE_RESPONSE]: 2, // 0x04
        [OPCODES.GSR_RANGE_RESPONSE]: 1, // 0x22
        [OPCODES.DEVICE_VERSION_RESPONSE]: 1, // 0x25
        [OPCODES.FW_VERSION_RESPONSE]: 6, // 0x2F fwId u16, major u16, minor u8, patch u8
        [OPCODES.INTERNAL_EXP_POWER_ENABLE_RESPONSE]: 1, // 0x5F
        [OPCODES.RWC_RESPONSE]: 8, // 0x90 64-bit ticks, LSB first
        // 0xA5 — DATA_RATE_TEST_PACKET_SIZE is 5 in the firmware: header + u32 counter
        [OPCODES.DATA_RATE_TEST_RESPONSE]: 4,
    });
    /** SD-transfer response opcodes, which {@link sdMessageSpan} owns. */
    const SD_RESPONSE_OPCODES = new Set([
        SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE,
        SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE,
        SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE,
        SD_TRANSFER_OPCODES.DELETE_RESPONSE,
    ]);
    /**
     * Total length (INCLUDING the leading opcode) of the control message at the
     * head of `buf`, or {@link NEED_MORE} when more bytes are required to tell, or
     * {@link RESYNC} when the leading byte starts nothing we recognise.
     *
     * Deliberately does NOT frame DATA_PACKET (0x00): stream data is length-defined
     * by the negotiated schema rather than by the protocol, so the client routes it
     * to its schema parser instead of through this function.
     */
    function shimmer3rControlMessageLength(buf) {
        if (buf.length === 0)
            return NEED_MORE$1;
        const opcode = buf[0];
        if (opcode === OPCODES.ACK_COMMAND_PROCESSED || opcode === OPCODES.NACK_COMMAND_PROCESSED) {
            return 1;
        }
        // SD-transfer frames and one-shot responses: one definition, in sdMessageSpan.
        if (opcode === SD_INSTREAM_BYTE || SD_RESPONSE_OPCODES.has(opcode)) {
            return sdMessageSpan(buf);
        }
        if (opcode === OPCODES.INQUIRY_RESPONSE) {
            if (buf.length <= SHIMMER3R_INQ_NUM_CHANNELS_OFFSET)
                return NEED_MORE$1;
            const numChannels = buf[SHIMMER3R_INQ_NUM_CHANNELS_OFFSET];
            // A stray stream byte 0x02 can masquerade as an INQUIRY_RESPONSE whose
            // "numChannels" is garbage, swallowing real control traffic (ACK included).
            // No Shimmer3R comes close to 32 channels — treat the rest as garbage.
            if (numChannels > 32)
                return RESYNC$1;
            const total = SHIMMER3R_INQ_CHANNELS_OFFSET + numChannels;
            return buf.length < total ? NEED_MORE$1 : total;
        }
        if (opcode === OPCODES.DAUGHTER_CARD_MEM_RESPONSE) {
            // [0x68][length][data…]; the firmware caps a read at 128 bytes, so a larger
            // "length" is garbage rather than a giant response.
            if (buf.length < 2)
                return NEED_MORE$1;
            const dcLen = buf[1];
            if (dcLen > 128)
                return RESYNC$1;
            const total = 2 + dcLen;
            return buf.length < total ? NEED_MORE$1 : total;
        }
        const payload = SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS[opcode];
        if (payload === undefined)
            return RESYNC$1;
        const total = 1 + payload;
        return buf.length < total ? NEED_MORE$1 : total;
    }

    /**
     * Kinematic (accel/gyro/mag) calibration math and the 21-byte calibration
     * parameter block codec.
     *
     * Pure, dependency-free port of the Shimmer Java driver:
     *   com.shimmerresearch.driver.calibration.CalibDetailsKinematic
     *     (parseCalParamByteArray / generateCalParamByteArray / scale factors)
     *   com.shimmerresearch.driver.calibration.UtilCalibration
     *     (calibrateInertialSensorData / matrixInverse3x3 — the efficient method)
     *
     * Calibration equation (Ferraris, Grimaldi & Parvis 1995), UtilCalibration §14-23:
     *
     *     C = R⁻¹ · K⁻¹ · (U − B)
     *
     * where C = calibrated vector, U = uncalibrated (raw) vector, B = offset,
     * R = alignment matrix, K = diagonal sensitivity matrix. The driver's
     * "efficient method" precomputes M = inv(R)·inv(K) once per calibration set and
     * then evaluates C = M · (U − B) per sample — this module does the same.
     */
    /**
     * Invert a 3x3 matrix (row-major, length 9) via the adjugate/determinant.
     * Ported verbatim from UtilCalibration.matrixInverse3x3 (:133-162). Returns
     * `null` when the matrix is singular (determinant 0).
     */
    function matrixInverse3x3(m) {
        const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
        const det = a * e * i + b * f * g + c * d * h - c * e * g - b * d * i - a * f * h;
        if (det === 0)
            return null;
        const inv = 1 / det;
        return [
            inv * (e * i - f * h),
            inv * (c * h - b * i),
            inv * (b * f - c * e),
            inv * (f * g - d * i),
            inv * (a * i - c * g),
            inv * (c * d - a * f),
            inv * (d * h - e * g),
            inv * (g * b - a * h),
            inv * (a * e - b * d),
        ];
    }
    /** Multiply two 3x3 row-major matrices (length 9 each). */
    function matrixMultiply3x3(x, y) {
        const out = new Array(9);
        for (let r = 0; r < 3; r++) {
            for (let col = 0; col < 3; col++) {
                out[r * 3 + col] =
                    x[r * 3 + 0] * y[0 * 3 + col] +
                        x[r * 3 + 1] * y[1 * 3 + col] +
                        x[r * 3 + 2] * y[2 * 3 + col];
            }
        }
        return out;
    }
    /**
     * Build a {@link KinematicCalibration} from offset/sensitivity/alignment,
     * precomputing M = inv(alignment)·inv(diag(sensitivity)) exactly as the Java
     * efficient path does (UtilCalibration.calibrateInertialSensorData :78 with
     * CalibArraysKinematic's cached matrixMultiplication(inv(AM), inv(SM))).
     *
     * A singular alignment or a zero sensitivity axis falls back to an identity M
     * component so calibration never throws — matching the driver's tolerance of a
     * degenerate default (it would emit NaN there rather than crash).
     */
    function makeKinematicCalibration(offset, sensitivity, alignment) {
        const sm = [sensitivity[0], 0, 0, 0, sensitivity[1], 0, 0, 0, sensitivity[2]];
        const invA = matrixInverse3x3(alignment) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const invS = matrixInverse3x3(sm) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const m = matrixMultiply3x3(invA, invS);
        return {
            offset: [offset[0], offset[1], offset[2]],
            sensitivity: [sensitivity[0], sensitivity[1], sensitivity[2]],
            alignment: [...alignment],
            m,
        };
    }
    /**
     * Apply a calibration set to one raw tri-axial sample:
     *
     *     C = M · (U − B)
     *
     * with M = inv(R)·inv(K) precomputed in {@link KinematicCalibration.m}.
     */
    function calibrateVector3(raw, cal) {
        const d0 = raw[0] - cal.offset[0];
        const d1 = raw[1] - cal.offset[1];
        const d2 = raw[2] - cal.offset[2];
        const m = cal.m;
        return [
            m[0] * d0 + m[1] * d1 + m[2] * d2,
            m[3] * d0 + m[4] * d1 + m[5] * d2,
            m[6] * d0 + m[7] * d1 + m[8] * d2,
        ];
    }
    const i16be = (b, o) => {
        const v = ((b[o] << 8) | b[o + 1]) & 0xffff;
        return v >= 0x8000 ? v - 0x10000 : v;
    };
    const i8 = (v) => (v >= 0x80 ? v - 0x100 : v);
    const isAll = (b, byte) => {
        for (let i = 0; i < b.length; i++)
            if (b[i] !== byte)
                return false;
        return true;
    };
    /**
     * Parse a 21-byte kinematic calibration parameter block.
     *
     * Layout (CalibDetailsKinematic.parseCalParamByteArray :250-280, decoded with
     * UtilParseData.formatDataPacketReverse which is BIG-ENDIAN):
     *   bytes 0..5   : 3 × i16 big-endian offset  (x, y, z)
     *   bytes 6..11  : 3 × i16 big-endian sensitivity (x, y, z), ÷ sensitivityScale
     *   bytes 12..20 : 9 × i8 alignment, row-major, ÷ 100
     *
     * An all-0xFF or all-0x00 block means "no calibration stored"
     * (UtilShimmer.isAllFF / isAllZeros) and yields `null` so the caller keeps its
     * default.
     */
    function parseKinematicCalibBlock(bytes, opts = {}) {
        if (bytes.length < 21)
            return null;
        if (isAll(bytes, 0xff) || isAll(bytes, 0x00))
            return null;
        const sensScale = opts.sensitivityScale ?? 1;
        const offset = [i16be(bytes, 0), i16be(bytes, 2), i16be(bytes, 4)];
        const sensitivity = [
            i16be(bytes, 6) / sensScale,
            i16be(bytes, 8) / sensScale,
            i16be(bytes, 10) / sensScale,
        ];
        const alignment = new Array(9);
        for (let k = 0; k < 9; k++)
            alignment[k] = i8(bytes[12 + k]) / 100;
        return makeKinematicCalibration(offset, sensitivity, alignment);
    }
    /**
     * Serialize offset/sensitivity/alignment back into a 21-byte block, inverse of
     * {@link parseKinematicCalibBlock}. Ported from
     * CalibDetailsKinematic.generateCalParamByteArray (:292-327): sensitivity is
     * rounded after ×sensitivityScale, alignment rounded after ×100, offset stored
     * as-is; all as big-endian i16 (offset, sensitivity) and i8 (alignment).
     *
     * Java truncates the offset with an `(int)` cast (`(int)offsetVector[i][0]`),
     * NOT Math.round — a fractional offset drops its fractional part toward zero.
     * We use Math.trunc to match that oracle behaviour exactly. Sensitivity and
     * alignment are Math.round'd before their `(int)` cast in Java, so they keep
     * Math.round here.
     */
    function generateKinematicCalibBlock(offset, sensitivity, alignment, opts = {}) {
        const sensScale = opts.sensitivityScale ?? 1;
        const out = new Uint8Array(21);
        for (let i = 0; i < 3; i++) {
            const v = Math.trunc(offset[i]) & 0xffff; // Java (int) cast truncates toward zero
            out[i * 2] = (v >> 8) & 0xff;
            out[i * 2 + 1] = v & 0xff;
        }
        for (let i = 0; i < 3; i++) {
            const v = Math.round(sensitivity[i] * sensScale) & 0xffff;
            out[6 + i * 2] = (v >> 8) & 0xff;
            out[6 + i * 2 + 1] = v & 0xff;
        }
        for (let k = 0; k < 9; k++) {
            out[12 + k] = Math.round(alignment[k] * 100) & 0xff;
        }
        return out;
    }

    /**
     * Hard-coded default kinematic calibration matrices, ported from the Shimmer
     * Java driver's per-sensor default constants. These are the already-scaled real
     * values (e.g. gyro sensitivity 131, not 13100) the driver instantiates each
     * CalibDetailsKinematic with when no per-device calibration is available.
     *
     * Sources (all READ-ONLY oracle):
     *   Shimmer3 low-noise accel  : SensorKionixKXRB52042 (:38-55)
     *   Shimmer3 wide-range accel + mag (old IMU) : SensorLSM303DLHC (:79-183, :325-358)
     *   Shimmer3 wide-range accel + mag (new IMU) : SensorLSM303AH (:41-89, :174-206)
     *   Shimmer3 gyro (MPU9x50)   : SensorMPU9X50 (:121-158, gyro scale ×100)
     *   Shimmer3R LN accel + gyro : SensorLSM6DSV (:53-165, gyro scale ×100)
     *   Shimmer3R WR accel        : SensorLIS2DW12 (:124-160)
     *   Shimmer3R mag             : SensorLIS2MDL (:58-66)
     *   Shimmer3R alt (high-g)    : SensorADXL371 (:113-124)
     *   Shimmer3R alt mag         : SensorLIS3MDL (:59-89)
     *
     * NB: alignment matrices below are written row-major; the values are the true
     * ±1/0 alignment entries (the driver stores them ×100 on the wire — see
     * generateKinematicCalibBlock — but keeps the real values in these constants).
     */
    /** Emitted unit strings — exact Java strings (Configuration.java :162-164). */
    const INERTIAL_UNITS = Object.freeze({
        accel: 'm/(s^2)',
        gyro: 'deg/s',
        mag: 'local_flux',
    });
    const cal = (r) => makeKinematicCalibration(r.offset, r.sens, r.align);
    // --- Common alignment matrices -----------------------------------------------
    const ALIGN_KIONIX_LN = [0, -1, 0, -1, 0, 0, 0, 0, -1]; // Kionix KXRB LN accel (S3)
    const ALIGN_MPU_GYRO = [0, -1, 0, -1, 0, 0, 0, 0, -1]; // MPU9x50 gyro (S3)
    const ALIGN_LSM303DLHC = [-1, 0, 0, 0, 1, 0, 0, 0, -1]; // WR accel + mag (S3 old IMU)
    const ALIGN_LSM303AH = [0, -1, 0, 1, 0, 0, 0, 0, -1]; // WR accel + mag (S3 new IMU)
    const ALIGN_LSM6DSV = [-1, 0, 0, 0, 1, 0, 0, 0, -1]; // LN accel + gyro (S3R)
    const ALIGN_LIS2DW12 = [0, -1, 0, -1, 0, 0, 0, 0, -1]; // WR accel (S3R)
    const ALIGN_LIS2MDL = [-1, 0, 0, 0, -1, 0, 0, 0, -1]; // mag (S3R)
    const ALIGN_LIS3MDL = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // alt mag (S3R)
    const ALIGN_ADXL371 = [0, 1, 0, 1, 0, 0, 0, 0, -1]; // high-g accel (S3R)
    const ZERO_OFFSET = [0, 0, 0];
    const diag = (s) => [s, s, s];
    // -----------------------------------------------------------------------------
    // Shimmer3, old IMU (LSM303DLHC accel+mag, MPU9x50 gyro, Kionix LN accel)
    // -----------------------------------------------------------------------------
    const SHIMMER3_OLD = Object.freeze({
        lnAccel: {
            unit: INERTIAL_UNITS.accel,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_KIONIX_LN, sens: diag(83), offset: [2047, 2047, 2047] }),
            },
        },
        wrAccel: {
            unit: INERTIAL_UNITS.accel,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_LSM303DLHC, sens: diag(1631), offset: ZERO_OFFSET }),
                1: cal({ align: ALIGN_LSM303DLHC, sens: diag(815), offset: ZERO_OFFSET }),
                2: cal({ align: ALIGN_LSM303DLHC, sens: diag(408), offset: ZERO_OFFSET }),
                3: cal({ align: ALIGN_LSM303DLHC, sens: diag(135), offset: ZERO_OFFSET }),
            },
        },
        gyro: {
            unit: INERTIAL_UNITS.gyro,
            sensitivityScale: 100,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_MPU_GYRO, sens: diag(131), offset: ZERO_OFFSET }),
                1: cal({ align: ALIGN_MPU_GYRO, sens: diag(65.5), offset: ZERO_OFFSET }),
                2: cal({ align: ALIGN_MPU_GYRO, sens: diag(32.8), offset: ZERO_OFFSET }),
                3: cal({ align: ALIGN_MPU_GYRO, sens: diag(16.4), offset: ZERO_OFFSET }),
            },
        },
        mag: {
            unit: INERTIAL_UNITS.mag,
            sensitivityScale: 1,
            fallbackRange: 1, // LSM303DLHC has no range 0; driver default is 1.3 Ga (range 1)
            byRange: {
                1: cal({ align: ALIGN_LSM303DLHC, sens: [1100, 1100, 980], offset: ZERO_OFFSET }),
                2: cal({ align: ALIGN_LSM303DLHC, sens: [855, 855, 760], offset: ZERO_OFFSET }),
                3: cal({ align: ALIGN_LSM303DLHC, sens: [670, 670, 600], offset: ZERO_OFFSET }),
                4: cal({ align: ALIGN_LSM303DLHC, sens: [450, 450, 400], offset: ZERO_OFFSET }),
                5: cal({ align: ALIGN_LSM303DLHC, sens: [400, 400, 355], offset: ZERO_OFFSET }),
                6: cal({ align: ALIGN_LSM303DLHC, sens: [330, 330, 295], offset: ZERO_OFFSET }),
                7: cal({ align: ALIGN_LSM303DLHC, sens: [230, 230, 205], offset: ZERO_OFFSET }),
            },
        },
    });
    // -----------------------------------------------------------------------------
    // Shimmer3, new IMU (LSM303AHTR accel+mag, MPU9x50 gyro, Kionix LN accel).
    // LSM303AH accel range→sensitivity mapping uses config values {0,2,3,1}
    // (ListofLSM303AccelRangeConfigValues) → 2g/4g/8g/16g respectively.
    // -----------------------------------------------------------------------------
    const SHIMMER3_NEW = Object.freeze({
        lnAccel: SHIMMER3_OLD.lnAccel, // Kionix LN accel unchanged on new-IMU boards
        wrAccel: {
            unit: INERTIAL_UNITS.accel,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_LSM303AH, sens: diag(1671), offset: ZERO_OFFSET }), // 2g
                2: cal({ align: ALIGN_LSM303AH, sens: diag(836), offset: ZERO_OFFSET }), // 4g
                3: cal({ align: ALIGN_LSM303AH, sens: diag(418), offset: ZERO_OFFSET }), // 8g
                1: cal({ align: ALIGN_LSM303AH, sens: diag(209), offset: ZERO_OFFSET }), // 16g
            },
        },
        gyro: SHIMMER3_OLD.gyro, // MPU9x50 gyro unchanged
        mag: {
            unit: INERTIAL_UNITS.mag,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_LSM303AH, sens: diag(667), offset: ZERO_OFFSET }),
            },
        },
    });
    // -----------------------------------------------------------------------------
    // Shimmer3R (LSM6DSV LN accel+gyro, LIS2DW12 WR accel, LIS2MDL mag,
    // ADXL371 high-g alt accel, LIS3MDL alt mag).
    // -----------------------------------------------------------------------------
    const SHIMMER3R = Object.freeze({
        lnAccel: {
            unit: INERTIAL_UNITS.accel,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_LSM6DSV, sens: diag(1672), offset: ZERO_OFFSET }),
                1: cal({ align: ALIGN_LSM6DSV, sens: diag(836), offset: ZERO_OFFSET }),
                2: cal({ align: ALIGN_LSM6DSV, sens: diag(418), offset: ZERO_OFFSET }),
                3: cal({ align: ALIGN_LSM6DSV, sens: diag(209), offset: ZERO_OFFSET }),
            },
        },
        gyro: {
            unit: INERTIAL_UNITS.gyro,
            sensitivityScale: 100,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_LSM6DSV, sens: diag(229), offset: ZERO_OFFSET }), // 125 dps
                1: cal({ align: ALIGN_LSM6DSV, sens: diag(114), offset: ZERO_OFFSET }), // 250 dps
                2: cal({ align: ALIGN_LSM6DSV, sens: diag(57), offset: ZERO_OFFSET }), // 500 dps
                3: cal({ align: ALIGN_LSM6DSV, sens: diag(29), offset: ZERO_OFFSET }), // 1000 dps
                4: cal({ align: ALIGN_LSM6DSV, sens: diag(14), offset: ZERO_OFFSET }), // 2000 dps
                5: cal({ align: ALIGN_LSM6DSV, sens: diag(7), offset: ZERO_OFFSET }), // 4000 dps
            },
        },
        wrAccel: {
            unit: INERTIAL_UNITS.accel,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_LIS2DW12, sens: diag(1671), offset: ZERO_OFFSET }),
                1: cal({ align: ALIGN_LIS2DW12, sens: diag(836), offset: ZERO_OFFSET }),
                2: cal({ align: ALIGN_LIS2DW12, sens: diag(418), offset: ZERO_OFFSET }),
                3: cal({ align: ALIGN_LIS2DW12, sens: diag(209), offset: ZERO_OFFSET }),
            },
        },
        mag: {
            unit: INERTIAL_UNITS.mag,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_LIS2MDL, sens: diag(667), offset: ZERO_OFFSET }),
            },
        },
        altAccel: {
            unit: INERTIAL_UNITS.accel,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_ADXL371, sens: diag(1), offset: [10, 10, 10] }),
            },
        },
        altMag: {
            unit: INERTIAL_UNITS.mag,
            sensitivityScale: 1,
            fallbackRange: 0,
            byRange: {
                0: cal({ align: ALIGN_LIS3MDL, sens: diag(6842), offset: ZERO_OFFSET }), // 4 Ga
                1: cal({ align: ALIGN_LIS3MDL, sens: diag(3421), offset: ZERO_OFFSET }), // 8 Ga
                2: cal({ align: ALIGN_LIS3MDL, sens: diag(2281), offset: ZERO_OFFSET }), // 12 Ga
                3: cal({ align: ALIGN_LIS3MDL, sens: diag(1711), offset: ZERO_OFFSET }), // 16 Ga
            },
        },
    });
    const FAMILY_DEFAULTS = Object.freeze({
        'shimmer3-old': SHIMMER3_OLD,
        'shimmer3-new': SHIMMER3_NEW,
        shimmer3r: SHIMMER3R,
    });
    /** Return the default group table for a family, or null if the group is absent. */
    function getGroupDefaults(family, group) {
        return FAMILY_DEFAULTS[family][group] ?? null;
    }
    /**
     * Select the default {@link KinematicCalibration} for a family/group/range.
     * Falls back to the group's `fallbackRange` when the range value has no entry.
     * Returns `null` when the family has no such group.
     */
    function getDefaultCalibration(family, group, range) {
        const g = getGroupDefaults(family, group);
        if (!g)
            return null;
        const calibration = g.byRange[range] ?? g.byRange[g.fallbackRange];
        if (!calibration)
            return null;
        return { calibration, unit: g.unit, sensitivityScale: g.sensitivityScale };
    }

    /**
     * Calibration-dump (0x9A GET_CALIB_DUMP) wire-format codec and the
     * calibration source-priority ladder.
     *
     * Ported from the Shimmer Java driver:
     *   ShimmerDevice.calibByteDumpParse (:4319-4406) / calibByteDumpGenerate (:4255-4310)
     *   CalibDetails.CALIB_READ_SOURCE (:20-28) — source priority ordering
     *
     * Dump layout (all multi-byte little-endian unless noted):
     *   0   u16  packet length (= dump.length − 2)
     *   2   8B   version object: HwID u16, FwID u16, FwMajor u16, FwMinor u8, FwInternal u8
     *   10+ records, each:
     *          u16  sensorId
     *          u8   range
     *          u8   calibLen
     *          8B   timestamp ticks (LSB first)
     *          calibLen bytes calibration payload (a 21-byte kinematic block for IMU)
     */
    /**
     * Parse a 0x9A calibration dump. Tolerant of a trailing partial record (the
     * Java loop `while(remainingBytes.length>12)` stops before an incomplete one).
     * An all-zero buffer yields an empty record list (Java early-returns).
     */
    function parseCalibDump(bytes) {
        const packetLength = bytes.length >= 2 ? bytes[0] | (bytes[1] << 8) : 0;
        const version = bytes.length >= 10
            ? {
                hardwareId: bytes[2] | (bytes[3] << 8),
                firmwareId: bytes[4] | (bytes[5] << 8),
                firmwareMajor: bytes[6] | (bytes[7] << 8),
                firmwareMinor: bytes[8],
                firmwareInternal: bytes[9],
            }
            : {
                hardwareId: 0,
                firmwareId: 0,
                firmwareMajor: 0,
                firmwareMinor: 0,
                firmwareInternal: 0,
            };
        const records = [];
        const allZero = bytes.every((b) => b === 0);
        if (!allZero && bytes.length > 10) {
            let off = 10;
            // Header of a record is 12 bytes (id 2 + range 1 + len 1 + ts 8); the Java
            // guard `remainingBytes.length>12` requires strictly more than 12 remaining.
            while (bytes.length - off > 12) {
                const sensorId = bytes[off] | (bytes[off + 1] << 8);
                const range = bytes[off + 2];
                const calibLen = bytes[off + 3];
                const timestampTicks = bytes.slice(off + 4, off + 12);
                const start = off + 12;
                const end = start + calibLen;
                if (bytes.length < end)
                    break; // trailing partial record dropped
                const calibBytes = bytes.slice(start, end);
                records.push({
                    sensorId,
                    range,
                    calibLen,
                    timestampTicks,
                    calibBytes,
                    isDefault: timestampTicks.every((b) => b === 0),
                });
                off = end;
            }
        }
        return { packetLength, version, records };
    }
    /**
     * Serialize a calibration dump (inverse of {@link parseCalibDump}) — used by
     * tests to build round-trippable fixtures.
     */
    function generateCalibDump(version, records) {
        let bodyLen = 8; // version object
        for (const r of records)
            bodyLen += 12 + r.calibBytes.length;
        const total = 2 + bodyLen;
        const out = new Uint8Array(total);
        const len = total - 2;
        out[0] = len & 0xff;
        out[1] = (len >> 8) & 0xff;
        out[2] = version.hardwareId & 0xff;
        out[3] = (version.hardwareId >> 8) & 0xff;
        out[4] = version.firmwareId & 0xff;
        out[5] = (version.firmwareId >> 8) & 0xff;
        out[6] = version.firmwareMajor & 0xff;
        out[7] = (version.firmwareMajor >> 8) & 0xff;
        out[8] = version.firmwareMinor & 0xff;
        out[9] = version.firmwareInternal & 0xff;
        let off = 10;
        for (const r of records) {
            out[off] = r.sensorId & 0xff;
            out[off + 1] = (r.sensorId >> 8) & 0xff;
            out[off + 2] = r.range & 0xff;
            out[off + 3] = r.calibBytes.length & 0xff;
            out.set(r.timestampTicks.subarray(0, 8), off + 4);
            out.set(r.calibBytes, off + 12);
            off += 12 + r.calibBytes.length;
        }
        return out;
    }
    /**
     * Calibration read-source priority ladder (CalibDetails.CALIB_READ_SOURCE
     * :20-28). A calibration from a higher-priority source overrides one from a
     * lower-priority source; equal priority also overrides (Java uses `>=`).
     */
    const CALIB_READ_SOURCE = Object.freeze({
        UNKNOWN: 0,
        SD_HEADER: 1,
        LEGACY_BT_COMMAND: 2,
        INFOMEM: 3,
        RADIO_DUMP: 4,
        FILE_DUMP: 5,
        USER_MODIFIED: 6,
    });
    /**
     * Whether a new calibration from `incoming` should replace one currently held
     * from `current`. Mirrors the Java guard in CalibDetails.parseCalibDump:
     *   `if (calibTimeMs > getCalibTimeMs()
     *        || calibReadSource.ordinal() >= getCalibReadSource().ordinal())`
     *
     * The timestamp arguments are optional and additive: when both are supplied a
     * strictly-newer incoming calibration timestamp wins regardless of source
     * priority (a fresher on-device calibration overrides a stale higher-priority
     * one). Omitting them falls back to the source-ordinal comparison alone, which
     * preserves the previous behaviour.
     */
    function shouldOverrideCalibration(current, incoming, currentTimeMs, incomingTimeMs) {
        if (currentTimeMs !== undefined &&
            incomingTimeMs !== undefined &&
            incomingTimeMs > currentTimeMs) {
            return true;
        }
        return incoming >= current;
    }

    /**
     * Streaming-path inertial calibration.
     *
     * Applies kinematic calibration to the inertial channels of a decoded
     * {@link ObjectCluster}, adding a `'cal'` field per axis (unit m/(s^2) | deg/s |
     * local_flux) alongside the existing `'raw'` field — exactly how the streaming
     * clients already emit GSR (raw + calibrated). Calibration is chosen per group:
     * a device calibration fetched via `readCalibration()` (source-priority ladder)
     * wins, otherwise the range-selected default is used.
     */
    /**
     * Streaming channel triples by group. Names match the SDK's streaming channel
     * naming (CHANNEL_FORMATS / Shimmer3 schema); a group is calibrated only when
     * all three axis channels are present in the frame.
     */
    const STREAM_GROUPS = Object.freeze([
        { group: 'lnAccel', axes: ['LN_ACCEL_X', 'LN_ACCEL_Y', 'LN_ACCEL_Z'] },
        { group: 'wrAccel', axes: ['WR_ACCEL_X', 'WR_ACCEL_Y', 'WR_ACCEL_Z'] },
        { group: 'gyro', axes: ['GYRO_X', 'GYRO_Y', 'GYRO_Z'] },
        { group: 'mag', axes: ['MAG_X', 'MAG_Y', 'MAG_Z'] },
        { group: 'altAccel', axes: ['HG_ACCEL_X', 'HG_ACCEL_Y', 'HG_ACCEL_Z'] },
        { group: 'altMag', axes: ['ALT_MAG_X', 'ALT_MAG_Y', 'ALT_MAG_Z'] },
    ]);
    const rangeFor = (ranges, group) => ranges[group];
    /**
     * Add calibrated (`'cal'`) fields to the inertial channels present in `oc`.
     * No-op for channels not present. Uses the raw (`'raw'`) fields as input.
     */
    function applyStreamingCalibration(oc, state) {
        for (const { group, axes } of STREAM_GROUPS) {
            const fx = oc.get(axes[0], 'raw');
            const fy = oc.get(axes[1], 'raw');
            const fz = oc.get(axes[2], 'raw');
            if (!fx || !fy || !fz)
                continue;
            const def = getDefaultCalibration(state.family, group, rangeFor(state.ranges, group));
            if (!def)
                continue;
            const cal = state.device?.[group] ?? def.calibration;
            const [cx, cy, cz] = calibrateVector3([fx.value, fy.value, fz.value], cal);
            oc.add(axes[0], cx, def.unit, 'cal');
            oc.add(axes[1], cy, def.unit, 'cal');
            oc.add(axes[2], cz, def.unit, 'cal');
        }
    }

    /**
     * Firmware/hardware-conditional InfoMem byte-layout resolution for Shimmer3
     * and Shimmer3R.
     *
     * Ported verbatim from the Java driver:
     *   com.shimmerresearch.driver.shimmer2r3.ConfigByteLayoutShimmer3
     *     (field initialisers + the constructor @324-412 that mutates offsets and
     *      the InfoMem address base by firmware version / hardware id)
     *   com.shimmerresearch.driver.ConfigByteLayout (address defaults @36-40,
     *     checkConfigBytesValid @90)
     *   com.shimmerresearch.driverUtilities.UtilShimmer#compareVersions (@580-629)
     *   com.shimmerresearch.driverUtilities.ShimmerVerObject
     *     (#isSupportedMpl @390, #isSupportedEightByteDerivedSensors @472)
     *   com.shimmerresearch.driver.ShimmerDevice#isSupportedSdLogSync (@2091)
     *
     * Everything here is pure so it can be unit-tested with byte fixtures.
     */
    // ---------------------------------------------------------------------------
    // HW / FW id constants (ShimmerVerDetails.java)
    // ---------------------------------------------------------------------------
    /** Hardware version codes (`ShimmerVerDetails.HW_ID`). */
    const HW_ID = Object.freeze({
        SHIMMER_3: 3,
        SHIMMER_3R: 10,
    });
    /** Firmware identifier codes (`ShimmerVerDetails.FW_ID`). */
    const FW_ID$1 = Object.freeze({
        BTSTREAM: 1,
        SDLOG: 2,
        LOGANDSTREAM: 3,
        GQ_802154: 9,
        SHIMMER4_SDK_STOCK: 12,
        STROKARE: 15,
    });
    /** `ShimmerVerDetails.ANY_VERSION` — wildcard for a version-field comparison. */
    const ANY_VERSION = -1;
    // ---------------------------------------------------------------------------
    // InfoMem geometry
    // ---------------------------------------------------------------------------
    /** Total InfoMem config length used by Shimmer3/3R (D+C+B pages). */
    const INFOMEM_SIZE = 384;
    /** One InfoMem page (D/C/B) = 128 bytes; also the UART transfer chunk size. */
    const INFOMEM_PAGE_SIZE = 128;
    /** Number of validity sentinel bytes checked at the start of the InfoMem. */
    const INFOMEM_VALIDITY_BYTES = 6;
    /** Legacy MSP430 absolute page addresses (`ConfigByteLayout` defaults). */
    const INFOMEM_ADDR_LEGACY = Object.freeze({ D: 0x1800, C: 0x1880, B: 0x1900 });
    /** 0-based flat page addresses used by newer firmware / all Shimmer3R. */
    const INFOMEM_ADDR_FLAT = Object.freeze({ D: 0, C: 128, B: 256 });
    // ---------------------------------------------------------------------------
    // Version comparison (UtilShimmer#compareVersions)
    // ---------------------------------------------------------------------------
    /**
     * True when the context firmware matches `fwId` (or `fwId` is
     * {@link ANY_VERSION}) AND the context version is >= the given threshold.
     * Major/minor use strict `>`, internal uses `>=`, exactly as
     * `UtilShimmer.compareVersions` (UtilShimmer.java:582-629). Passing
     * {@link ANY_VERSION} for the version fields makes the version test always pass
     * (any real version is `> -1`), matching the Java `ANY_VERSION` idiom.
     */
    function fwCompare(ctx, fwId, major, minor, internal) {
        if (fwId !== ANY_VERSION && ctx.firmwareId !== fwId)
            return false;
        const { major: a, minor: b, internal: c } = ctx.firmwareVersion;
        return a > major || (a === major && b > minor) || (a === major && b === minor && c >= internal);
    }
    const isShimmer3R = (ctx) => ctx.hardwareVersion === HW_ID.SHIMMER_3R;
    // ---------------------------------------------------------------------------
    // Feature predicates that gate which InfoMem fields are meaningful
    // ---------------------------------------------------------------------------
    /**
     * `ShimmerVerObject#isSupportedMpl` (@390): Shimmer3 + SDLog in the half-open
     * window [0.7.0, 0.8.0). No supported/target device runs this, so enabled-
     * sensor bytes 3-4 (bits 24-39) are effectively never populated.
     */
    function isSupportedMpl(ctx) {
        return (ctx.hardwareVersion === HW_ID.SHIMMER_3 &&
            fwCompare(ctx, FW_ID$1.SDLOG, 0, 7, 0) &&
            !fwCompare(ctx, FW_ID$1.SDLOG, 0, 8, 0));
    }
    /**
     * `ShimmerVerObject#isSupportedEightByteDerivedSensors` (@472): SDLog>=0.13.1,
     * LogAndStream>=0.7.1, GQ_802154>=0.3.2, Shimmer4>=0.0.23, or StroKare (any).
     */
    function isSupportedEightByteDerivedSensors(ctx) {
        return (fwCompare(ctx, FW_ID$1.SDLOG, 0, 13, 1) ||
            fwCompare(ctx, FW_ID$1.LOGANDSTREAM, 0, 7, 1) ||
            fwCompare(ctx, FW_ID$1.GQ_802154, 0, 3, 2) ||
            fwCompare(ctx, FW_ID$1.SHIMMER4_SDK_STOCK, 0, 0, 23) ||
            fwCompare(ctx, FW_ID$1.STROKARE, ANY_VERSION, ANY_VERSION, ANY_VERSION));
    }
    /**
     * `ShimmerDevice#isSupportedSdLogSync` (@2091): SDLog (any), Shimmer3R+
     * LogAndStream (any), Shimmer3+LogAndStream>=0.16.11, or StroKare. Gates the
     * trial id / number-of-Shimmers, sync bits, sync-node list.
     */
    function isSupportedSdLogSync(ctx) {
        if (ctx.firmwareId === FW_ID$1.SDLOG)
            return true;
        if (ctx.firmwareId === FW_ID$1.STROKARE)
            return true;
        if (isShimmer3R(ctx) && ctx.firmwareId === FW_ID$1.LOGANDSTREAM)
            return true;
        if (ctx.hardwareVersion === HW_ID.SHIMMER_3 &&
            ctx.firmwareId === FW_ID$1.LOGANDSTREAM &&
            fwCompare(ctx, FW_ID$1.LOGANDSTREAM, 0, 16, 11)) {
            return true;
        }
        return false;
    }
    /**
     * SDLog / LogAndStream / StroKare firmware — the family that stores the
     * experiment-config bytes (button-start, disable-BT, TCXO) and honours the
     * device-write MAC-0xFF + config-file-creation-flag semantics
     * (ShimmerObject.java:5035,5054,5278,5312,5320).
     */
    function isSdLoggingFirmware(ctx) {
        return (ctx.firmwareId === FW_ID$1.SDLOG ||
            ctx.firmwareId === FW_ID$1.LOGANDSTREAM ||
            ctx.firmwareId === FW_ID$1.STROKARE);
    }
    // Field constant lengths / bit positions shared by parse + generate.
    const EXG_BANK_LENGTH = 10;
    const NAME_LENGTH = 12;
    const CONFIG_TIME_LENGTH = 4;
    const MAC_LENGTH = 6;
    const BIT_SHIFT = Object.freeze({
        GSR_RANGE: 1,
        EXP_POWER: 0,
        BUTTON_START: 5,
        DISABLE_BLUETOOTH: 3,
        SYNC_WHEN_LOGGING: 2,
        MASTER_SHIMMER: 1,
        SINGLE_TOUCH: 7,
        TCXO: 4,
        SD_CFG_FILE_WRITE_FLAG: 0,
    });
    const MASK = Object.freeze({
        GSR_RANGE: 0x07,
        EXP_POWER: 0x01,
        ONE_BIT: 0x01,
        DERIVED_BYTE: 0xff,
        SD_CFG_FILE_WRITE_FLAG: 0x01,
    });
    /** Config-time bytes are big-endian: byte0 = MSB (shift 24) … byte3 = LSB. */
    const CONFIG_TIME_BIT_SHIFTS = [24, 16, 8, 0];
    /**
     * Resolve the InfoMem layout for a firmware/hardware context, applying the
     * same ordered constructor branches as `ConfigByteLayoutShimmer3` (oldest →
     * newest). Returns a frozen, fully-derived {@link InfoMemLayout}.
     */
    function resolveInfoMemLayout(ctx) {
        const r = isShimmer3R(ctx);
        // ---- Base (default) initialiser values (ConfigByteLayoutShimmer3 @34-109).
        const layout = {
            // Page addresses — legacy default; branch 4 may remap to flat 0-based.
            addrD: INFOMEM_ADDR_LEGACY.D,
            addrC: INFOMEM_ADDR_LEGACY.C,
            addrB: INFOMEM_ADDR_LEGACY.B,
            flatAddressing: false,
            idxSamplingRate: 0,
            idxBufferSize: 2,
            idxSensors0: 3,
            idxSensors1: 4,
            idxSensors2: 5,
            idxConfigSetupByte0: 6,
            idxConfigSetupByte3: 9,
            idxExg1: 10,
            idxExg2: 20,
            idxBtCommBaudRate: 30,
            // Derived-sensor offsets default to 0 ("not present").
            idxDerivedSensors0: 0,
            idxDerivedSensors1: 0,
            idxDerivedSensors2: 0,
            idxDerivedSensors3: 0,
            idxDerivedSensors4: 0,
            idxDerivedSensors5: 0,
            idxDerivedSensors6: 0,
            idxDerivedSensors7: 0,
            // C page (128 + X).
            idxSensors3: 128 + 2,
            idxSensors4: 128 + 3,
            idxSDShimmerName: 128 + 59, // 187
            idxSDEXPIDName: 128 + 71, // 199
            idxSDConfigTime0: 128 + 83, // 211
            idxSDMyTrialID: 128 + 87, // 215
            idxSDNumOfShimmers: 128 + 88, // 216
            idxSDExperimentConfig0: 128 + 89, // 217
            idxSDExperimentConfig1: 128 + 90, // 218
            idxSDBTInterval: 128 + 91, // 219
            idxEstimatedExpLengthMsb: 128 + 92, // 220
            idxEstimatedExpLengthLsb: 128 + 93, // 221
            idxMaxExpLengthMsb: 128 + 94, // 222
            idxMaxExpLengthLsb: 128 + 95, // 223
            idxMacAddress: 128 + 96, // 224
            idxSDConfigDelayFlag: 128 + 102, // 230
            idxBtFactoryReset: 0,
            // B page.
            idxNode0: 128 + 128, // 256
            supportsMpl: isSupportedMpl(ctx),
            supportsEightByteDerived: isSupportedEightByteDerivedSensors(ctx),
            supportsSdLogSync: isSupportedSdLogSync(ctx),
            isSdLoggingFirmware: isSdLoggingFirmware(ctx),
        };
        // ---- Branch 1 (@330-343): 3R | SDLog>=0.8.42 | LogAndStream>=0.3.4 | Shimmer4 | StroKare
        // Relocates Sensors3/4 to 128/129 (ConfigSetupByte4/5 shift to 130/131) and
        // seeds DerivedSensors0-2 at 115-117 (overridden by branch 2 below).
        if (r ||
            fwCompare(ctx, FW_ID$1.SDLOG, 0, 8, 42) ||
            fwCompare(ctx, FW_ID$1.LOGANDSTREAM, 0, 3, 4) ||
            fwCompare(ctx, FW_ID$1.SHIMMER4_SDK_STOCK, ANY_VERSION, ANY_VERSION, ANY_VERSION) ||
            fwCompare(ctx, FW_ID$1.STROKARE, ANY_VERSION, ANY_VERSION, ANY_VERSION)) {
            layout.idxSensors3 = 128 + 0;
            layout.idxSensors4 = 128 + 1;
            layout.idxDerivedSensors0 = 115;
            layout.idxDerivedSensors1 = 116;
            layout.idxDerivedSensors2 = 117;
        }
        // ---- Branch 2 (@345-360): 3R | SDLog>=0.8.68 | LogAndStream>=0.3.17 | BtStream>=0.6.0 | Shimmer4 | StroKare
        // Moves DerivedSensors0-2 into InfoMem D at 31-33 (and the calibration blocks,
        // which this codec does not surface).
        if (r ||
            fwCompare(ctx, FW_ID$1.SDLOG, 0, 8, 68) ||
            fwCompare(ctx, FW_ID$1.LOGANDSTREAM, 0, 3, 17) ||
            fwCompare(ctx, FW_ID$1.BTSTREAM, 0, 6, 0) ||
            fwCompare(ctx, FW_ID$1.SHIMMER4_SDK_STOCK, ANY_VERSION, ANY_VERSION, ANY_VERSION) ||
            fwCompare(ctx, FW_ID$1.STROKARE, ANY_VERSION, ANY_VERSION, ANY_VERSION)) {
            layout.idxDerivedSensors0 = 31;
            layout.idxDerivedSensors1 = 32;
            layout.idxDerivedSensors2 = 33;
        }
        // ---- Branch 4 — ADDRESS-BASE REMAP (@370-381): 3R | SDLog>=0.11.5 |
        // LogAndStream>=0.5.16 | BtStream>=0.7.4 | Shimmer4 | StroKare.
        // HARDWARE-VERIFY: the page address the device firmware expects on the wire
        // (legacy MSP430 0x1800/0x1880/0x1900 vs. flat 0/128/256) is only confirmable
        // against real hardware of each firmware generation.
        if (r ||
            fwCompare(ctx, FW_ID$1.SDLOG, 0, 11, 5) ||
            fwCompare(ctx, FW_ID$1.LOGANDSTREAM, 0, 5, 16) ||
            fwCompare(ctx, FW_ID$1.BTSTREAM, 0, 7, 4) ||
            fwCompare(ctx, FW_ID$1.SHIMMER4_SDK_STOCK, ANY_VERSION, ANY_VERSION, ANY_VERSION) ||
            fwCompare(ctx, FW_ID$1.STROKARE, ANY_VERSION, ANY_VERSION, ANY_VERSION)) {
            layout.addrD = INFOMEM_ADDR_FLAT.D;
            layout.addrC = INFOMEM_ADDR_FLAT.C;
            layout.addrB = INFOMEM_ADDR_FLAT.B;
            layout.flatAddressing = true;
        }
        // ---- Branch 5 (@383-390): 3R | isSupportedEightByteDerivedSensors.
        if (r || layout.supportsEightByteDerived) {
            layout.idxDerivedSensors3 = 118;
            layout.idxDerivedSensors4 = 119;
            layout.idxDerivedSensors5 = 120;
            layout.idxDerivedSensors6 = 121;
            layout.idxDerivedSensors7 = 122;
        }
        // ---- Branch 7 (@398-401): 3R | LogAndStream>=0.8.1.
        if (r || fwCompare(ctx, FW_ID$1.LOGANDSTREAM, 0, 8, 1)) {
            layout.idxBtFactoryReset = 128 + 103; // 231
        }
        return Object.freeze(layout);
    }
    /**
     * The "first 6 bytes all 0xFF ⇒ unconfigured/invalid" check
     * (ConfigByteLayout.checkConfigBytesValid @90). Returns true when the InfoMem
     * holds a real configuration.
     */
    function checkConfigBytesValid(bytes) {
        if (bytes.length < INFOMEM_VALIDITY_BYTES)
            return false;
        for (let i = 0; i < INFOMEM_VALIDITY_BYTES; i++) {
            if (bytes[i] !== 0xff)
                return true;
        }
        return false;
    }

    // ---------------------------------------------------------------------------
    // InfoMem constants
    // ---------------------------------------------------------------------------
    // InfoMem (device config memory) MAC location, mirroring ConfigByteLayoutShimmer3
    // in the Shimmer Java driver: idxMacAddress = 128+96 (=224), length 6 bytes.
    // 224+6 stays within one 128-byte InfoMem segment, so a single read suffices.
    const INFOMEM_MAC_OFFSET = 224;
    // Devices that have not been provisioned report an all-FF or all-zero MAC.
    const INVALID_MAC_IDS = ['FFFFFFFFFFFF', '000000000000'];
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
            /**
             * The selected `BluetoothDevice` when connected over the default Web Bluetooth
             * transport; `null` for injected transports (React Native / loopback).
             */
            this.device = null;
            // Transport (byte pipe). Injected via options/connect, or a WebBluetoothTransport by default.
            this._injectedTransport = null;
            this._transport = null;
            this._notifyUnsub = null;
            this._disconnectUnsub = null;
            // Protocol state
            this._rxBuf = new Uint8Array(0);
            this._temps = new Set();
            this.schema = null;
            this._lastAckRemainder = null;
            this._expectingAck = 0;
            this._streaming = false;
            this._lastTs = 0;
            /** True while the active transport is a byte stream with no message framing. */
            this._unframed = false;
            /** Re-framing accumulator, used only when {@link _unframed}. */
            this._ctrlBuf = new Uint8Array(0);
            // Cached device configuration
            this.enabledSensors = 0x000000;
            this.samplingRateHz = 0;
            this.gsrRangeSetting = 0;
            this.ExpPower = 0;
            /**
             * Inertial-sensor hardware ranges, refreshed from each inquiry's config word.
             * Used to select the default calibration for streaming inertial channels.
             */
            this.imuRanges = {
                lnAccel: 0,
                wrAccel: 0,
                gyro: 0,
                mag: 0,
                altAccel: 0,
                altMag: 0,
            };
            /** When false, inertial channels are emitted raw-only (no `'cal'` field). Default true. */
            this.emitCalibratedInertial = true;
            /**
             * Device calibrations fetched via {@link readCalibration}. These override the
             * range-selected defaults (calibration source-priority ladder).
             */
            this._deviceCalibrations = {};
            /** Minimum valid GSR conductance in µS (below this, connectivity = "Disconnected"). */
            this.LIMIT_MIN_VALID_USIEMENS = 0.03;
            // Callbacks
            this.onInquiry = null;
            this.onExpPowerChanged = null;
            /** Handle an unexpected / requested transport disconnect. */
            this._handleTransportDisconnect = () => {
                this._streaming = false;
                this._sdKnownSession = null;
                this._emitStatus('Device disconnected');
            };
            // ---------------------------------------------------------------------------
            // Notify handler (fed raw notification chunks by the transport)
            // ---------------------------------------------------------------------------
            /**
             * Transport entry point. A framed transport (BLE) delivers one firmware
             * message per call and goes straight to {@link _handleFramedChunk}; an
             * unframed one (Web Serial over USB or over a classic-Bluetooth COM port)
             * is re-framed first, then funnelled through the very same handler.
             */
            this._handleNotify = (chunk) => {
                if (this._unframed) {
                    this._handleUnframedChunk(chunk);
                    return;
                }
                this._handleFramedChunk(chunk);
            };
            this._handleFramedChunk = (chunk) => {
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
            // ---------------------------------------------------------------------------
            // Firmware version (feature gating)
            // ---------------------------------------------------------------------------
            this._fwVersionCache = null;
            // ---------------------------------------------------------------------------
            // SD-card file transfer (FW >= v1.01.009)
            //
            // A dedicated, self-resynchronising RX pipeline: while any SD operation is
            // active, a persistent temp handler accumulates notification chunks and
            // extracts length-delimited SD messages from them (multi-notification
            // reassembly). Unknown bytes are skipped one at a time so interleaved
            // traffic (e.g. unsolicited instream status responses) cannot jam it.
            // ---------------------------------------------------------------------------
            this._sdRx = new Uint8Array(0);
            this._sdUsers = 0;
            this._sdHandlerAttached = false;
            this._sdExpect = null;
            this._sdFrameListener = null;
            this._sdCrcErrorListener = null;
            this._sdKnownSession = null;
            this._sdChunkHandler = (chunk) => {
                // Lone ACKs are consumed by the command flow, not the SD pipeline
                if (chunk.length === 1 && chunk[0] === OPCODES.ACK_COMMAND_PROCESSED)
                    return;
                this._sdRx = concatU8(this._sdRx, chunk);
                for (;;) {
                    const r = tryExtractSdMessage(this._sdRx);
                    if (r.crcError) {
                        try {
                            this._sdCrcErrorListener?.();
                        }
                        catch (e) {
                            this._log('sd crc listener error', e);
                        }
                    }
                    if (r.consumed === 0)
                        break;
                    this._sdRx = this._sdRx.slice(r.consumed);
                    const m = r.msg;
                    if (!m)
                        continue;
                    if (m.kind === 'oneshot') {
                        if (this._sdExpect && m.opcode === this._sdExpect.opcode) {
                            const e = this._sdExpect;
                            this._sdExpect = null;
                            e.resolve(m.body);
                        }
                    }
                    else {
                        try {
                            this._sdFrameListener?.(m);
                        }
                        catch (e) {
                            this._log('sd frame listener error', e);
                        }
                    }
                }
            };
            this.serviceUUID = opts.serviceUUID ?? SHIMMER3R_DEFAULTS.SERVICE_UUID;
            this.rxUUID = opts.rxUUID ?? SHIMMER3R_DEFAULTS.CHAR_RX_UUID;
            this.txUUID = opts.txUUID ?? SHIMMER3R_DEFAULTS.CHAR_TX_UUID;
            this.forceTimestampFmt = opts.timestampFmt ?? 'u24';
            this._injectedTransport = opts.transport ?? null;
            this.emitCalibratedInertial = opts.emitCalibratedInertial ?? true;
        }
        /** Best-effort label for `ObjectCluster`s and status messages. */
        _deviceLabel() {
            return this.device?.name ?? this._transport?.deviceName ?? 'Shimmer3R';
        }
        /** Build the default Web Bluetooth transport over the configured UUIDs. */
        _makeWebTransport() {
            return new WebBluetoothTransport({
                serviceUUID: this.serviceUUID,
                // Shimmer3R: the RX characteristic is the host→device write pipe; TX is the
                // device→host notify pipe. Writes are acknowledged (write-with-response),
                // matching the previous `rx.writeValue(...)` behaviour.
                writeCharUUID: this.rxUUID,
                notifyCharUUID: this.txUUID,
                requestDeviceOptions: {
                    filters: [{ services: [this.serviceUUID] }],
                    optionalServices: [this.serviceUUID],
                },
                defaultWriteWithResponse: true,
                debug: this.debug,
                logTag: '[Shimmer3R:ble]',
            });
        }
        _log(...args) {
            if (this.debug)
                console.log('[Shimmer3R]', ...args);
        }
        // ---------------------------------------------------------------------------
        // Connection management
        // ---------------------------------------------------------------------------
        /**
         * Open a connection. In a browser this triggers the Web Bluetooth device
         * picker (unchanged behaviour). Pass a {@link ShimmerTransport} to drive the
         * client over a different pipe (React Native, Bluetooth Classic, tests); it
         * takes precedence over any transport supplied to the constructor.
         */
        async connect(transport) {
            const t = transport ?? this._injectedTransport ?? this._makeWebTransport();
            this._transport = t;
            // A byte-stream transport needs its message boundaries rebuilt; BLE gets
            // them from the notification boundaries and takes the untouched path.
            this._unframed = t.capabilities.framed === false;
            this._ctrlBuf = new Uint8Array(0);
            // The firmware's SD session counter restarts with the connection
            this._sdKnownSession = null;
            this._notifyUnsub = t.onNotify(this._handleNotify);
            this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);
            this._emitStatus('Requesting Bluetooth device…');
            await t.connect();
            if (t instanceof WebBluetoothTransport)
                this.device = t.device;
            this._emitStatus(`Selected: ${this._deviceLabel()}`);
            this._emitStatus('GATT connected');
            this._emitStatus('RX/TX obtained');
            this._emitStatus('Notifications started');
        }
        async disconnect() {
            try {
                this._notifyUnsub?.();
                this._disconnectUnsub?.();
                await this._transport?.disconnect();
            }
            catch {
                /* ignore */
            }
            finally {
                this._notifyUnsub = this._disconnectUnsub = null;
                this._transport = null;
                this.device = null;
                this._rxBuf = new Uint8Array(0);
                this._ctrlBuf = new Uint8Array(0);
                this._unframed = false;
                this.schema = null;
                this._streaming = false;
                this.ExpPower = 0;
                this._deviceCalibrations = {};
                this._sdKnownSession = null;
                this._emitStatus('Disconnected');
            }
        }
        // ---------------------------------------------------------------------------
        // Unframed (byte-stream) transports
        // ---------------------------------------------------------------------------
        /**
         * Re-frame an unframed transport's read into whole firmware messages, then
         * replay them through {@link _handleFramedChunk} so every command, waiter and
         * SD handler above behaves exactly as it does over BLE.
         *
         * Without this a serial read can split a response down the middle (the waiter
         * resolves with a truncated buffer) or carry two messages at once (the second
         * is swallowed as the first's ACK remainder).
         */
        _handleUnframedChunk(chunk) {
            this._log('Serial rx len=', chunk.length, 'data=', chunk);
            // While a stream is live every byte is schema-defined stream data, whose
            // length this protocol layer cannot know — hand it straight to the parser,
            // which accumulates and so is already fragmentation-proof.
            if (this._streaming) {
                this._rxBuf = concatU8(this._rxBuf, chunk);
                this._parseStreamIfPossible();
                return;
            }
            this._ctrlBuf = concatU8(this._ctrlBuf, chunk);
            for (const msg of this._extractUnframedMessages())
                this._handleFramedChunk(msg);
        }
        /**
         * Pull every complete message out of {@link _ctrlBuf}, leaving the incomplete
         * tail behind. Extraction is finished before anything is dispatched so a
         * handler can never observe a half-updated buffer.
         */
        _extractUnframedMessages() {
            const out = [];
            let buf = this._ctrlBuf;
            for (;;) {
                if (buf.length === 0)
                    break;
                // DATA_PACKET belongs to the stream plane even before `_streaming` is set
                // (the window between START_STREAMING and its ACK). Its length comes from
                // the schema, so stop framing and let the stream parser own the rest.
                if (buf[0] === OPCODES.DATA_PACKET) {
                    this._rxBuf = concatU8(this._rxBuf, buf);
                    buf = new Uint8Array(0);
                    this._parseStreamIfPossible();
                    break;
                }
                const len = shimmer3rControlMessageLength(buf);
                if (len === NEED_MORE$1)
                    break;
                if (len === RESYNC$1) {
                    this._log(`serial resync: dropping unframeable byte 0x${buf[0].toString(16)}`);
                    buf = buf.subarray(1);
                    continue;
                }
                if (buf.length < len)
                    break; // defensive: framer should have said NEED_MORE
                const msg = new Uint8Array(buf.subarray(0, len));
                buf = buf.subarray(len);
                // Emulate BLE's coalescing: the module packs an ACK and the response the
                // firmware wrote straight after it into ONE notification, and the waiters
                // rely on that — `_waitForAck` hands the remainder over synchronously via
                // `_lastAckRemainder`. Emitted as two separate messages, the response
                // would arrive before the caller's `await` continuation had registered its
                // response handler, and be dropped. Two ACKs are never merged: the second
                // would masquerade as the first's response body.
                if (msg.length === 1 && msg[0] === OPCODES.ACK_COMMAND_PROCESSED && this._expectingAck > 0) {
                    const nextLen = shimmer3rControlMessageLength(buf);
                    if (nextLen !== NEED_MORE$1 &&
                        nextLen !== RESYNC$1 &&
                        buf.length >= nextLen &&
                        buf[0] !== OPCODES.ACK_COMMAND_PROCESSED) {
                        out.push(concatU8(msg, buf.subarray(0, nextLen)));
                        buf = buf.subarray(nextLen);
                        continue;
                    }
                }
                out.push(msg);
            }
            this._ctrlBuf = buf.length ? new Uint8Array(buf) : new Uint8Array(0);
            return out;
        }
        /** Run the schema parser if one has been built, swallowing parse errors. */
        _parseStreamIfPossible() {
            if (!this.schema)
                return;
            try {
                this._parseBySchema();
            }
            catch (e) {
                this._log('parseBySchema error:', e);
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
            if (!this._transport)
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
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            const cmd = new Uint8Array([OPCODES.SET_GSR_RANGE_COMMAND, gsrRange & 0xff]);
            this._emitStatus('SET_GSR_RANGE → waiting for ACK…');
            const ackRemainder = await this._writeExpectingAck(cmd, 1500);
            this._emitStatus('SET_GSR_RANGE (ACK received).');
            this.gsrRangeSetting = gsrRange;
            return { gsrRange, ackRemainder };
        }
        /**
         * Set the wide-range accelerometer (LIS2DW12) range.
         *
         * Also updates {@link imuRanges} so streaming calibration picks the matching
         * sensitivity straight away. An inquiry would refresh it from the config word
         * anyway, but callers are free to set the range after their last inquiry.
         *
         * @param wrAccelRange 0 = ±2 g, 1 = ±4 g, 2 = ±8 g, 3 = ±16 g.
         */
        async setWrAccelRange(wrAccelRange) {
            if (!Number.isInteger(wrAccelRange) || wrAccelRange < 0 || wrAccelRange > 3) {
                throw new Error('wrAccelRange must be 0–3 (±2/4/8/16 g)');
            }
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            const cmd = new Uint8Array([OPCODES.SET_WR_ACCEL_RANGE_COMMAND, wrAccelRange & 0xff]);
            this._emitStatus('SET_WR_ACCEL_RANGE → waiting for ACK…');
            const ackRemainder = await this._writeExpectingAck(cmd, 1500);
            this._emitStatus('SET_WR_ACCEL_RANGE (ACK received).');
            this.imuRanges = { ...this.imuRanges, wrAccel: wrAccelRange };
            return { wrAccelRange, ackRemainder };
        }
        /**
         * Set the gyroscope (LSM6DSV) range.
         *
         * Also updates {@link imuRanges}, as {@link setWrAccelRange} does.
         *
         * Note the firmware splits this setting across two config-setup bits when it
         * reports back in an inquiry (LSB pair plus one MSB bit), but the command
         * itself takes the full 0–5 index in one byte.
         *
         * @param gyroRange 0 = ±125, 1 = ±250, 2 = ±500, 3 = ±1000, 4 = ±2000,
         *   5 = ±4000 dps. (Shimmer3 supports only 0–3: ±250/500/1000/2000 dps.)
         */
        async setGyroRange(gyroRange) {
            if (!Number.isInteger(gyroRange) || gyroRange < 0 || gyroRange > 5) {
                throw new Error('gyroRange must be 0–5 (±125/250/500/1000/2000/4000 dps)');
            }
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            const cmd = new Uint8Array([OPCODES.SET_GYRO_RANGE_COMMAND, gyroRange & 0xff]);
            this._emitStatus('SET_GYRO_RANGE → waiting for ACK…');
            const ackRemainder = await this._writeExpectingAck(cmd, 1500);
            this._emitStatus('SET_GYRO_RANGE (ACK received).');
            this.imuRanges = { ...this.imuRanges, gyro: gyroRange };
            return { gyroRange, ackRemainder };
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
            if (!this._transport)
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
            if (!this._transport)
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
        // InfoMem
        // ---------------------------------------------------------------------------
        /**
         * Read a block from the device's InfoMem (config memory).
         * Request layout is [cmd, length, addrLSB, addrMSB] (address is little-endian
         * 16-bit), matching readMem()/GET_INFOMEM_COMMAND in the Shimmer Java driver.
         * @returns the raw bytes read
         */
        /**
         * Issue a command and read back a length-prefixed response
         * (`[opcode][len][data...]`), reassembling it across BLE notifications.
         *
         * A notification carries at most one ATT payload — around 42 bytes at the
         * MTU the CYW20820 negotiates — and the transport surfaces one notification
         * per chunk, so any response longer than that arrives split. Firmware writes
         * the logical response contiguously, so the fragments simply concatenate in
         * order: accumulate until `expectedLen` data bytes have arrived instead of
         * assuming the first chunk holds the whole response.
         *
         * Firmware always emits the length byte after the opcode, but its absence is
         * tolerated (older/variant firmware) by treating the first byte as a prefix
         * only when it equals the requested length.
         */
        async _readLengthPrefixedResponse(cmd, respOpcode, expectedLen, label, ackTimeoutMs = 1500, responseTimeoutMs = 2000) {
            const remainder = await this._writeExpectingAck(cmd, ackTimeoutMs);
            const first = remainder && remainder[0] === respOpcode
                ? remainder
                : await this._waitForResponse(respOpcode, responseTimeoutMs);
            /* Bytes after the response opcode. */
            let acc = first[0] === respOpcode ? first.subarray(1) : first;
            const dataOf = (buf) => buf.length >= 1 && buf[0] === expectedLen ? buf.subarray(1) : buf;
            if (dataOf(acc).length >= expectedLen) {
                return dataOf(acc).slice(0, expectedLen);
            }
            /* Response is fragmented — collect the continuation chunks, which carry
             * raw payload bytes with no opcode of their own. */
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => {
                    this._offTemp(handler);
                    reject(new Error(`${label} returned ${dataOf(acc).length} of ${expectedLen} bytes (response truncated).`));
                }, responseTimeoutMs);
                const handler = (chunk) => {
                    if (!chunk || chunk.length === 0)
                        return;
                    /* Every chunk from here is continuation payload — deliberately NOT
                     * filtering a lone 0xFF as a stray ACK, because a payload byte can be
                     * 0xFF and dropping it would silently corrupt the record. The ACK for
                     * this command was already consumed before this handler was registered,
                     * and commands are issued one at a time, so no other ACK can arrive
                     * mid-response. */
                    acc = concatU8(acc, chunk);
                    const data = dataOf(acc);
                    if (data.length >= expectedLen) {
                        clearTimeout(t);
                        this._offTemp(handler);
                        resolve(data.slice(0, expectedLen));
                    }
                };
                this._onTemp(handler);
            });
        }
        async readInfoMem(address, length) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
                throw new Error('InfoMem address must be an integer in 0..65535.');
            }
            if (!Number.isInteger(length) || length < 1 || length > 128) {
                throw new Error('InfoMem read length must be an integer in 1..128.');
            }
            this._emitStatus(`GET_INFOMEM ${length}B @ ${address} → waiting for ACK then RSP…`);
            const cmd = new Uint8Array([
                OPCODES.GET_INFOMEM_COMMAND,
                length & 0xff,
                address & 0xff,
                (address >> 8) & 0xff,
            ]);
            /* Response is [INFOMEM_RSP][length][data...]. The opcode is required (a raw
             * opcode-less chunk could be an unrelated notification, e.g. a 0x00-preamble
             * data frame, and must not be mis-captured as InfoMem payload); the length
             * byte is optional. Reads longer than one BLE notification are reassembled. */
            return this._readLengthPrefixedResponse(cmd, OPCODES.INFOMEM_RESPONSE, length, 'InfoMem read');
        }
        /**
         * Arm a one-shot soft reboot that the device performs as soon as this host
         * disconnects (SET_FEATURE / FEATURE_REBOOT_ON_DISCONNECT).
         *
         * Settings that firmware only reads at boot - notably the EEPROM brand
         * record's advertising names - otherwise need a manual power-cycle. The
         * reboot cannot happen while still connected, because the link has to drop
         * for the Bluetooth module to re-read its name; so the sequence is: write
         * settings, call this, then {@link disconnect}.
         *
         * Firmware skips the reboot while sensing so that it can never truncate an
         * active SD recording, and clears the request either way - it is strictly
         * one-shot and never carries into a later disconnect.
         *
         * Requires firmware with FEATURE_REBOOT_ON_DISCONNECT support; older
         * firmware NACKs the unknown feature id.
         */
        async setRebootOnDisconnect(enabled) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            this._emitStatus(`SET_FEATURE reboot-on-disconnect=${enabled ? 1 : 0} → waiting for ACK…`);
            await this._writeExpectingAck(new Uint8Array([OPCODES.SET_FEATURE, BT_FEATURE.REBOOT_ON_DISCONNECT, enabled ? 1 : 0]), 1500);
            this._emitStatus(`Reboot-on-disconnect ${enabled ? 'armed' : 'cleared'}`);
        }
        /**
         * Read from the daughter-card (expansion board) EEPROM memory. `offset` is a
         * HOST offset — firmware maps it past the first (HW details) EEPROM page, so
         * host offsets 0..2031 cover absolute EEPROM bytes 16..2047.
         */
        async readDaughterCardMem(offset, length) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            if (!Number.isInteger(offset) || offset < 0 || offset > 2031) {
                throw new Error('Daughter-card mem offset must be an integer in 0..2031.');
            }
            if (!Number.isInteger(length) || length < 1 || length > 128 || offset + length > 2032) {
                throw new Error('Daughter-card mem read must be 1..128 bytes within 0..2031.');
            }
            this._emitStatus(`GET_DAUGHTER_CARD_MEM ${length}B @ ${offset} → waiting for ACK then RSP…`);
            const cmd = new Uint8Array([
                OPCODES.GET_DAUGHTER_CARD_MEM_COMMAND,
                length & 0xff,
                offset & 0xff,
                (offset >> 8) & 0xff,
            ]);
            /* Response is [DAUGHTER_CARD_MEM_RSP][length][data...] — same framing
             * rationale as readInfoMem() above. The 64-byte brand record exceeds one
             * BLE notification, so the reassembly in the helper is load-bearing here. */
            return this._readLengthPrefixedResponse(cmd, OPCODES.DAUGHTER_CARD_MEM_RESPONSE, length, 'Daughter-card mem read');
        }
        /**
         * Write to the daughter-card (expansion board) EEPROM memory. `offset` is a
         * HOST offset (see {@link readDaughterCardMem}). Max 128 bytes per write.
         */
        async writeDaughterCardMem(offset, data) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            if (!Number.isInteger(offset) || offset < 0 || offset > 2031) {
                throw new Error('Daughter-card mem offset must be an integer in 0..2031.');
            }
            if (data.length < 1 || data.length > 128 || offset + data.length > 2032) {
                throw new Error('Daughter-card mem write must be 1..128 bytes within 0..2031.');
            }
            this._emitStatus(`SET_DAUGHTER_CARD_MEM ${data.length}B @ ${offset} → waiting for ACK…`);
            const cmd = new Uint8Array(4 + data.length);
            cmd[0] = OPCODES.SET_DAUGHTER_CARD_MEM_COMMAND;
            cmd[1] = data.length & 0xff;
            cmd[2] = offset & 0xff;
            cmd[3] = (offset >> 8) & 0xff;
            cmd.set(data, 4);
            await this._writeExpectingAck(cmd, 1500);
            this._emitStatus('Daughter-card mem write ACKed');
        }
        /**
         * Read the device's MAC address from InfoMem and return it as 12 uppercase hex
         * characters (e.g. "2601140185B8") — byte order as stored, matching the
         * identifier format used by Verisense.
         */
        async getMacAddress() {
            const bytes = await this.readInfoMem(INFOMEM_MAC_OFFSET, MAC_LENGTH);
            const mac = Array.from(bytes)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
                .toUpperCase();
            if (INVALID_MAC_IDS.includes(mac)) {
                throw new Error(`Device reported an unprovisioned MAC (${mac}).`);
            }
            this._emitStatus(`Device MAC: ${mac}`);
            return mac;
        }
        // ---------------------------------------------------------------------------
        // Real-world clock (RWC)
        // ---------------------------------------------------------------------------
        /**
         * Read the device's real-world clock (GET_RWC_COMMAND).
         *
         * The response payload is the current RTC value as a 64-bit little-endian
         * tick count at 32768 Hz since the Unix epoch (the same unit SET_RWC writes:
         * `ticks = ms * 32.768`). Intended for RTC drift measurement (DEV-844 /
         * DEV-866): pair the returned time with a host timestamp taken at the
         * midpoint of the round-trip and feed {@link RtcDriftMonitor}.
         *
         * @returns the raw tick count plus the conversion to Unix milliseconds.
         */
        async getRtcTime() {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            const remainder = await this._writeExpectingAck(new Uint8Array([OPCODES.GET_RWC_COMMAND]), 1500);
            const rsp = remainder && remainder[0] === OPCODES.RWC_RESPONSE
                ? remainder
                : await this._waitForResponse(OPCODES.RWC_RESPONSE, 2000);
            // Response is [RWC_RSP][8 bytes LSB-first]. Deliberately opcode-framed
            // ONLY (the firmware always opcode-frames the RWC response, and both paths
            // above select on the opcode): an opcode-less 8-byte chunk could be an
            // unrelated notification and must not be mis-read as a clock value — the
            // same policy as readInfoMem.
            if (rsp[0] !== OPCODES.RWC_RESPONSE || rsp.length < 9) {
                throw new Error(`Malformed RWC response (${rsp.length} bytes).`);
            }
            let ticks = 0n;
            for (let i = 8; i >= 1; i--) {
                ticks = (ticks << 8n) | BigInt(rsp[i]);
            }
            return { ticks, unixMs: Number(ticks) / 32.768 };
        }
        /**
         * Set the device's real-world clock (SET_RWC_COMMAND) to the given Unix
         * millisecond time, encoded as 64-bit little-endian 32768 Hz ticks via the
         * same {@link msToRtcBytesLE} helper as the dock path (truncating, matching
         * the Java driver's `(long)(ms * 32.768)`). Call with `Date.now()` to sync
         * the device clock to the host before a drift run.
         * NOTE (DEV-900): the device treats RWC as LOCAL civil time — pass a
         * local-adjusted value if that distinction matters for the use case; for
         * drift measurement only the rate matters, not the epoch.
         */
        async setRtcTime(unixMs) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            if (!Number.isFinite(unixMs)) {
                throw new Error('setRtcTime: unixMs must be a finite number.');
            }
            const cmd = new Uint8Array(9);
            cmd[0] = OPCODES.SET_RWC_COMMAND;
            cmd.set(msToRtcBytesLE(unixMs), 1);
            await this._writeExpectingAck(cmd, 1500);
            this._emitStatus('RWC set');
        }
        // ---------------------------------------------------------------------------
        // ExG configuration helpers
        // ---------------------------------------------------------------------------
        /** Enable EMG (ADS1292R) in 16-bit mode on EXG1 & EXG2. */
        async enableEMG16Bit() {
            if (!this._transport)
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
            if (!this._transport)
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
            if (!this._transport)
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
        // Calibration fetch (opt-in)
        // ---------------------------------------------------------------------------
        /**
         * Fetch the device's per-sensor kinematic calibration over the radio and
         * upgrade the active streaming calibration to use it (overriding the
         * range-selected defaults). Opt-in and non-fatal: any group that times out or
         * NACKs is skipped and keeps its default.
         *
         * Uses the per-sensor GET calibration commands, each of which answers with
         * `[responseOpcode][21-byte kinematic block]`
         * (ShimmerBluetooth: ACCEL/GYRO/MAG/LSM303DLHC_ACCEL_CALIBRATION_RESPONSE are
         * all 21-byte payloads). Chosen over the 0x9A GET_CALIB_DUMP because the
         * per-sensor commands + 21-byte responses are unambiguous in the Java oracle,
         * whereas the chunked dump read sequence is not verifiable for this transport.
         *
         * HARDWARE-VERIFY: no real Shimmer3R radio has exercised this path; the
         * command/response opcodes and 21-byte block layout are ported from the Java
         * driver but not confirmed end-to-end against hardware.
         *
         * @returns the set of groups whose calibration was successfully read.
         */
        async readCalibration(timeoutMs = 1500) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            const plan = [
                {
                    group: 'lnAccel',
                    get: OPCODES.GET_LN_ACCEL_CALIBRATION_COMMAND,
                    resp: OPCODES.LN_ACCEL_CALIBRATION_RESPONSE,
                },
                {
                    group: 'gyro',
                    get: OPCODES.GET_GYRO_CALIBRATION_COMMAND,
                    resp: OPCODES.GYRO_CALIBRATION_RESPONSE,
                },
                {
                    group: 'mag',
                    get: OPCODES.GET_MAG_CALIBRATION_COMMAND,
                    resp: OPCODES.MAG_CALIBRATION_RESPONSE,
                },
                {
                    group: 'wrAccel',
                    get: OPCODES.GET_WR_ACCEL_CALIBRATION_COMMAND,
                    resp: OPCODES.WR_ACCEL_CALIBRATION_RESPONSE,
                },
                {
                    group: 'altAccel',
                    get: OPCODES.GET_ALT_ACCEL_CALIBRATION_COMMAND,
                    resp: OPCODES.ALT_ACCEL_CALIBRATION_RESPONSE,
                },
                {
                    group: 'altMag',
                    get: OPCODES.GET_ALT_MAG_CALIBRATION_COMMAND,
                    resp: OPCODES.ALT_MAG_CALIBRATION_RESPONSE,
                },
            ];
            const done = [];
            for (const { group, get, resp } of plan) {
                try {
                    const cal = await this._readOneCalibration(group, get, resp, timeoutMs);
                    if (cal) {
                        this._deviceCalibrations[group] = cal;
                        done.push(group);
                    }
                }
                catch (err) {
                    this._emitStatus(`readCalibration(${group}) skipped: ${err.message}`);
                }
            }
            return done;
        }
        async _readOneCalibration(group, getOpcode, respOpcode, timeoutMs) {
            const remainder = await this._writeExpectingAck(new Uint8Array([getOpcode]), timeoutMs);
            const rsp = remainder && remainder[0] === respOpcode
                ? remainder
                : await this._waitForResponse(respOpcode, timeoutMs);
            if (rsp.length < 22)
                return null; // opcode + 21-byte block
            const block = rsp.subarray(1, 22);
            const scale = getGroupDefaults('shimmer3r', group)?.sensitivityScale ?? 1;
            return parseKinematicCalibBlock(block, { sensitivityScale: scale });
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
            const adcRaw = u16le$3(u8, base + 0);
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
            // Inertial ranges from the config setup bytes (ConfigByteLayoutShimmer3):
            //   WR accel (LIS2DW12): setup0 bits 2-3  → cfg bits 2-3
            //   gyro (LSM6DSV): LSB setup2 bits 0-1 (cfg bits 16-17) + MSB setup4 bit 2
            //     (cfg bit 34) → 6 ranges (0-5)
            //   LN accel (LSM6DSV): setup3 bits 6-7 → cfg bits 30-31
            // mag/alt-accel/alt-mag are single-range or not carried here → 0.
            const gyroLsb = Number((cfg >> 16n) & 0x3n);
            const gyroMsb = Number((cfg >> 34n) & 0x1n);
            this.imuRanges = {
                lnAccel: Number((cfg >> 30n) & 0x3n),
                wrAccel: Number((cfg >> 2n) & 0x3n),
                gyro: gyroLsb | (gyroMsb << 2),
                mag: 0,
                altAccel: 0,
                altMag: 0,
            };
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
            // Inertial calibration (accel/gyro/mag/alt): device calibration from
            // readCalibration() when available, else the range-selected default.
            if (this.emitCalibratedInertial) {
                applyStreamingCalibration(oc, {
                    family: 'shimmer3r',
                    ranges: this.imuRanges,
                    device: this._deviceCalibrations,
                });
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
                        ts1 = tsBytes === 2 ? u16le$3(buf, 1) : u24le$1(buf, 1);
                        ts2 = tsBytes === 2 ? u16le$3(buf, frameBytes + 1) : u24le$1(buf, frameBytes + 1);
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
                        const oc = new ObjectCluster(this._deviceLabel());
                        const ts = tsBytes === 2 ? u16le$3(frame, cursor) : u24le$1(frame, cursor);
                        cursor += tsBytes;
                        oc.add('TIMESTAMP', ts, 'ticks', 'raw');
                        for (const f of sch.fields) {
                            if (cursor + f.sizeBytes > frame.length) {
                                throw new Error(`short frame: need ${f.sizeBytes} @${cursor}, have ${frame.length}`);
                            }
                            let v;
                            switch (f.fmt) {
                                case 'i16':
                                    v = f.endian === 'be' ? sign16(u16be(frame, cursor)) : sign16(u16le$3(frame, cursor));
                                    break;
                                case 'u16':
                                    v = f.endian === 'be' ? u16be(frame, cursor) : u16le$3(frame, cursor);
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
                                    v = u16le$3(frame, cursor);
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
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            this._log('Write', u8);
            await this._transport.write(u8);
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
        /** Read (and cache) the firmware version via GET_FW_VERSION_COMMAND. */
        async readFwVersion() {
            if (this._fwVersionCache)
                return this._fwVersionCache;
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            const cmd = new Uint8Array([OPCODES.GET_FW_VERSION_COMMAND]);
            const ackRemainder = await this._writeExpectingAck(cmd, 1500);
            const rsp = ackRemainder && ackRemainder[0] === OPCODES.FW_VERSION_RESPONSE
                ? ackRemainder
                : await this._waitForResponse(OPCODES.FW_VERSION_RESPONSE, 1500);
            if (rsp.length < 7)
                throw new Error('short FW_VERSION_RESPONSE');
            this._fwVersionCache = {
                fwId: rsp[1] | (rsp[2] << 8),
                major: rsp[3] | (rsp[4] << 8),
                minor: rsp[5],
                patch: rsp[6],
            };
            return this._fwVersionCache;
        }
        /**
         * True when the connected firmware serves the SD file-transfer commands
         * (LogAndStream_Shimmer3R >= v1.01.009). Older firmware silently ignores
         * unknown opcodes, so version gating is the only reliable probe.
         */
        async supportsSdTransfer() {
            try {
                const v = await this.readFwVersion();
                return v.major * 1000000 + v.minor * 1000 + v.patch >= 1001009;
            }
            catch {
                return false;
            }
        }
        /**
         * Measure raw link throughput with the firmware's data-rate test
         * (SET_DATA_RATE_TEST): the device free-runs 5-byte counter packets as
         * fast as the link drains them and we count received bytes for
         * `durationMs`. This measures the pipe itself (BLE connection interval and
         * MTU, or RFCOMM/serial buffering) independent of the SD/file-transfer
         * protocol, so it gives an upper bound for transfer rates on a given
         * host/adapter/OS — and a direct BLE-vs-classic-Bluetooth comparison.
         * The device must be idle (the firmware NACKs the test while sensing).
         */
        async runDataRateTest(durationMs = 5000, onProgress) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            if (this._streaming)
                throw new Error('Data-rate test unavailable while streaming');
            let counting = false;
            let bytes = 0;
            const counter = (chunk) => {
                if (counting)
                    bytes += chunk.length;
            };
            this._onTemp(counter);
            try {
                await this._writeExpectingAck(new Uint8Array([OPCODES.SET_DATA_RATE_TEST, 1]), 2000);
                const startedAt = Date.now();
                counting = true;
                let elapsed = 0;
                while (elapsed < durationMs) {
                    await new Promise((r) => setTimeout(r, Math.min(250, durationMs - elapsed)));
                    elapsed = Date.now() - startedAt;
                    onProgress?.(bytes, elapsed);
                }
                counting = false;
                const measuredMs = Date.now() - startedAt;
                return {
                    bytesReceived: bytes,
                    durationMs: measuredMs,
                    kBps: measuredMs > 0 ? bytes / 1024 / (measuredMs / 1000) : 0,
                };
            }
            finally {
                this._offTemp(counter);
                try {
                    await this._writeExpectingAck(new Uint8Array([OPCODES.SET_DATA_RATE_TEST, 0]), 2000);
                }
                catch {
                    /* the stop ACK can be indistinguishable from residual test bytes */
                }
                // Drop any test bytes that were mistaken for stream data, or that are
                // still sitting in the re-framing accumulator on an unframed transport.
                this._rxBuf = new Uint8Array(0);
                this._ctrlBuf = new Uint8Array(0);
            }
        }
        _sdAcquire() {
            this._sdUsers++;
            if (!this._sdHandlerAttached) {
                this._onTemp(this._sdChunkHandler);
                this._sdHandlerAttached = true;
            }
        }
        _sdRelease() {
            this._sdUsers = Math.max(0, this._sdUsers - 1);
            if (this._sdUsers === 0 && this._sdHandlerAttached) {
                this._offTemp(this._sdChunkHandler);
                this._sdHandlerAttached = false;
                this._sdRx = new Uint8Array(0);
            }
        }
        /** Send an SD command and await its reassembled one-shot response. */
        async _sdCommand(cmd, rspOpcode, timeoutMs = 5000) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            if (this._streaming) {
                throw new SdTransferError('SD transfer is unavailable while streaming', SD_STATUS.BUSY);
            }
            if (this._sdExpect) {
                // A shared expectation slot: concurrent SD commands would race on it,
                // so refuse deterministically — callers are expected to sequence
                throw new SdTransferError('another SD command is already in flight', SD_STATUS.BUSY);
            }
            this._sdAcquire();
            try {
                return await new Promise((resolve, reject) => {
                    const t = setTimeout(() => {
                        this._sdExpect = null;
                        reject(new Error(`SD response 0x${rspOpcode.toString(16)} timeout`));
                    }, timeoutMs);
                    this._sdExpect = {
                        opcode: rspOpcode,
                        resolve: (b) => {
                            clearTimeout(t);
                            resolve(b);
                        },
                    };
                    this._writeExpectingAck(cmd, timeoutMs)
                        .then((ackRemainder) => {
                        // When the ACK and the response share a notification the command
                        // flow consumes the remainder — feed it back into the SD pipeline
                        if (ackRemainder && ackRemainder.length)
                            this._sdChunkHandler(ackRemainder);
                    })
                        .catch((e) => {
                        clearTimeout(t);
                        this._sdExpect = null;
                        reject(e);
                    });
                });
            }
            finally {
                this._sdRelease();
            }
        }
        /**
         * List a directory on the SD card, transparently following the firmware's
         * startIdx paging. Path example: `'data'` or
         * `'data/DefaultTrial_123/Shimmer_ABCD-000'`.
         */
        async sdListDir(path, opts = {}) {
            const entries = [];
            let startIdx = 0;
            for (;;) {
                const body = await this._sdCommand(buildListDirCmd(path, startIdx, opts.maxEntriesPerPage ?? SD_LIST_MAX_ENTRIES), SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE);
                const page = parseListDirRsp(body);
                if (page.status !== SD_STATUS.OK) {
                    throw new SdTransferError(`list '${path}': ${sdStatusToString(page.status)}`, page.status);
                }
                entries.push(...page.entries);
                if (!page.hasMore)
                    return entries;
                if (page.entries.length === 0) {
                    throw new Error(`list '${path}': paging made no progress at index ${startIdx}`);
                }
                startIdx += page.entries.length;
            }
        }
        /** Stat one file or directory on the SD card. */
        async sdStatFile(path) {
            const body = await this._sdCommand(buildStatCmd(path), SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE);
            const { status, stat } = parseStatRsp(body);
            if (status !== SD_STATUS.OK) {
                throw new SdTransferError(`stat '${path}': ${sdStatusToString(status)}`, status);
            }
            return stat;
        }
        /** Query free/total space on the SD card (in KB). */
        async sdGetFreeSpace() {
            // First call on a large FAT32 card can scan the FAT — allow extra time
            const body = await this._sdCommand(buildFreeSpaceCmd(), SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE, 15000);
            const { status, space } = parseFreeSpaceRsp(body);
            if (status !== SD_STATUS.OK) {
                throw new SdTransferError(`free space: ${sdStatusToString(status)}`, status);
            }
            return space;
        }
        /**
         * Delete one file (or empty directory) on the SD card. The firmware only
         * permits paths strictly under `data/`.
         */
        async sdDeletePath(path) {
            const body = await this._sdCommand(buildDeleteCmd(path), SD_TRANSFER_OPCODES.DELETE_RESPONSE);
            const { status } = parseDeleteRsp(body);
            if (status !== SD_STATUS.OK) {
                throw new SdTransferError(`delete '${path}': ${sdStatusToString(status)}`, status);
            }
        }
        /** Ask the firmware to abandon the in-flight read window, if any. */
        async sdAbortTransfer() {
            if (!this._transport)
                return;
            await this._writeExpectingAck(buildAbortCmd(), 2000);
        }
        /**
         * Read one window of a file. The firmware streams the window as CRC'd
         * blocks; `onBlock` is invoked for each verified block in order. Resolves
         * with the closing status frame. Rejects on stall, CRC failure or sequence
         * gap — the caller re-requests from its last good offset (the firmware is
         * stateless, so a fresh window is always a valid resume).
         */
        async sdReadFileWindow(path, offset, windowLen, opts = {}) {
            if (!this._transport)
                throw new Error('Not connected (RX missing)');
            if (this._streaming) {
                throw new SdTransferError('SD transfer is unavailable while streaming', SD_STATUS.BUSY);
            }
            if (this._sdFrameListener) {
                // The frame/CRC listeners are single-slot instance fields, so a second
                // overlapping window would hijack the first one's frames. Refuse
                // deterministically; the firmware serves one window at a time anyway.
                throw new SdTransferError('another SD read window is already in flight', SD_STATUS.BUSY);
            }
            const blockLen = opts.blockPayloadLen ?? SD_BLOCK_PAYLOAD_DEFAULT;
            const stallTimeoutMs = opts.stallTimeoutMs ?? 6000;
            this._sdAcquire();
            try {
                return await new Promise((resolve, reject) => {
                    let session = null;
                    let expectedSeq = 0;
                    let bytesReceived = 0;
                    let stallTimer = null;
                    let settled = false;
                    const cleanup = () => {
                        if (stallTimer)
                            clearTimeout(stallTimer);
                        this._sdFrameListener = null;
                        this._sdCrcErrorListener = null;
                        opts.signal?.removeEventListener('abort', onAbort);
                    };
                    const fail = (err) => {
                        if (settled)
                            return;
                        settled = true;
                        cleanup();
                        reject(err);
                    };
                    const succeed = (status, nextOffset) => {
                        if (settled)
                            return;
                        settled = true;
                        cleanup();
                        resolve({ status, nextOffset, bytesReceived });
                    };
                    const kickStall = () => {
                        if (stallTimer)
                            clearTimeout(stallTimer);
                        stallTimer = setTimeout(() => fail(new Error(`SD read stalled (no frames for ${stallTimeoutMs} ms)`)), stallTimeoutMs);
                    };
                    const onAbort = () => {
                        void this.sdAbortTransfer().catch(() => { });
                        fail(new DOMException('SD read aborted', 'AbortError'));
                    };
                    this._sdCrcErrorListener = () => fail(new Error('SD data frame failed CRC check'));
                    this._sdFrameListener = (frame) => {
                        // Adopt the first session id that is not a leftover of the
                        // previous window (late data frames or a SUPERSEDED/closing status
                        // still draining from the firmware's TX ring). The tracker resets
                        // on connect/disconnect; the residual 1-in-256 wrap collision
                        // (new window randomly assigned the previous id) is recovered by
                        // the stall watchdog + the caller's re-read retry, which advances
                        // the firmware's session counter.
                        if (session === null) {
                            if (this._sdKnownSession !== null && frame.sessionId === this._sdKnownSession)
                                return;
                            session = frame.sessionId;
                            this._sdKnownSession = frame.sessionId;
                        }
                        if (frame.sessionId !== session)
                            return;
                        kickStall();
                        if (frame.kind === 'data') {
                            if (frame.seq !== expectedSeq) {
                                fail(new Error(`SD block sequence gap (expected ${expectedSeq}, got ${frame.seq})`));
                                return;
                            }
                            expectedSeq++;
                            try {
                                opts.onBlock?.(frame.payload, offset + bytesReceived);
                            }
                            catch (e) {
                                fail(e instanceof Error ? e : new Error(String(e)));
                                return;
                            }
                            bytesReceived += frame.payload.length;
                        }
                        else {
                            succeed(frame.status, frame.nextOffset);
                        }
                    };
                    if (opts.signal) {
                        if (opts.signal.aborted) {
                            onAbort();
                            return;
                        }
                        opts.signal.addEventListener('abort', onAbort, { once: true });
                    }
                    kickStall();
                    this._writeExpectingAck(buildReadCmd(path, offset, windowLen, blockLen), 3000)
                        .then((ackRemainder) => {
                        // The ACK can coalesce with the first data frame in one notification
                        if (ackRemainder && ackRemainder.length)
                            this._sdChunkHandler(ackRemainder);
                    })
                        .catch((e) => fail(e instanceof Error ? e : new Error(String(e))));
                });
            }
            finally {
                this._sdRelease();
            }
        }
    }

    /**
     * EEPROM brand (advertising name) record.
     *
     * Shimmer3/Shimmer3R firmware stores the effective BT/BLE/USB name prefixes in
     * a 64-byte record in the daughter-card EEPROM (log-and-stream-common
     * `EEPROM/shimmer_eeprom.h`, `gEepromBrandDetails`). On boot, firmware seeds
     * the record with its compile-time defaults when it is blank or invalid and
     * treats it as the single source of truth from then on — so hosts can always
     * read the current effective names back, and can rebrand a unit by writing a
     * new record (the new names apply at the next Bluetooth init / reboot).
     *
     * The record lives at HOST daughter-card-memory offset 1952 (absolute EEPROM
     * bytes 1968–2031 — host offsets skip the first, HW-details, EEPROM page).
     * Reachable over BLE/BT via GET/SET_DAUGHTER_CARD_MEM and over the dock UART /
     * USB-C via `UART_PROP.DAUGHTER_CARD.CARD_MEM` — both take host offsets.
     *
     * Layout v2 (all multi-byte fields little-endian, names NOT NUL-terminated):
     * ```
     * offset  size  field
     *      0     2  magic 0x5342 ("SB": bytes 0x42,0x53 on the wire)
     *      2     1  layoutVer (2)
     *      3     1  flags: bit0 reserved, bits1-2 seededPlatform
     *      4     1  btClassicLen        5     1  bleLen
     *      6     1  usbProductLen       7     1  usbManufacturerLen
     *      8    16  btClassic       (Classic BT name prefix)
     *     24    10  ble             (BLE name prefix)
     *     34    16  usbProduct      (USB product prefix)
     *     50    24  usbManufacturer (USB iManufacturer string)
     *     74     4  padding (zero)
     *     78     2  CRC over bytes 0..77 — Shimmer UART CRC, LSB first
     * ```
     *
     * The stock record carries the factory USB manufacturer string
     * ("Shimmer Research Ltd."), so firmware applies the record unconditionally
     * and an unbranded unit reports exactly what it always did. There is no
     * "customer branded" flag: bit 0 of `flags` is reserved.
     */
    /** Host expansion-board-memory offset of the record (absolute EEPROM 1952). */
    const BRAND_RECORD_HOST_OFFSET = 1936;
    const BRAND_RECORD_SIZE = 80;
    const BRAND_RECORD_MAGIC = 0x5342;
    const BRAND_RECORD_LAYOUT_VER = 2;
    const BRAND_BT_CLASSIC_MAX_CHARS = 16;
    const BRAND_BLE_MAX_CHARS = 10;
    const BRAND_USB_PRODUCT_MAX_CHARS = 16;
    /** Long enough for the stock "Shimmer Research Ltd." (21 chars). */
    const BRAND_USB_MANUFACTURER_MAX_CHARS = 24;
    /**
     * Shimmer3 firmware truncates the BLE prefix to 8 chars so "<prefix>-XXXX"
     * fits the RN4678's 31-byte advertisement payload. Shimmer3R allows the full
     * field width.
     */
    const BRAND_BLE_MAX_CHARS_SHIMMER3 = 8;
    /** `flags` bits 1-2: which platform seeded a stock (non-customer) record. */
    const BRAND_PLATFORM = Object.freeze({
        UNKNOWN: 0,
        SHIMMER3: 1,
        SHIMMER3R: 2,
        SHIMMER4_SDK: 3,
    });
    const PLATFORM_MASK = 0x06;
    const PLATFORM_SHIFT = 1;
    const OFF_MAGIC = 0;
    const OFF_LAYOUT_VER = 2;
    const OFF_FLAGS = 3;
    const OFF_BT_CLASSIC_LEN = 4;
    const OFF_BLE_LEN = 5;
    const OFF_USB_PRODUCT_LEN = 6;
    const OFF_USB_MANUFACTURER_LEN = 7;
    const OFF_BT_CLASSIC = 8;
    const OFF_BLE = OFF_BT_CLASSIC + BRAND_BT_CLASSIC_MAX_CHARS; // 24
    const OFF_USB_PRODUCT = OFF_BLE + BRAND_BLE_MAX_CHARS; // 34
    const OFF_USB_MANUFACTURER = OFF_USB_PRODUCT + BRAND_USB_PRODUCT_MAX_CHARS; // 50
    const OFF_CRC = BRAND_RECORD_SIZE - 2; // 78
    /**
     * Firmware-mirrored character rule: 1..max printable ASCII (0x20–0x7E),
     * comma excluded (it would corrupt the RN4X `S-,<name>` command).
     * Returns null when OK, else a human-readable reason.
     */
    function brandNameProblem(name, maxChars) {
        if (name.length === 0)
            return 'name is empty';
        if (name.length > maxChars)
            return `longer than ${maxChars} characters`;
        for (const ch of name) {
            const c = ch.charCodeAt(0);
            if (c < 0x20 || c > 0x7e)
                return `unsupported character "${ch}" (printable ASCII only)`;
            if (c === 0x2c)
                return 'commas are not allowed';
        }
        return null;
    }
    function readField(bytes, off, len) {
        let s = '';
        for (let i = 0; i < len; i++)
            s += String.fromCharCode(bytes[off + i]);
        return s;
    }
    /** Decode and validate a brand record read from the device. */
    function parseBrandRecord(bytes) {
        const rec = {
            valid: false,
            btClassic: '',
            ble: '',
            usbProduct: '',
            usbManufacturer: '',
            seededPlatform: BRAND_PLATFORM.UNKNOWN,
        };
        if (bytes.length < BRAND_RECORD_SIZE) {
            rec.invalidReason = `record is ${bytes.length} bytes, expected ${BRAND_RECORD_SIZE}`;
            return rec;
        }
        const magic = bytes[OFF_MAGIC] | (bytes[OFF_MAGIC + 1] << 8);
        const flags = bytes[OFF_FLAGS];
        rec.seededPlatform = (flags & PLATFORM_MASK) >> PLATFORM_SHIFT;
        const btLen = bytes[OFF_BT_CLASSIC_LEN];
        const bleLen = bytes[OFF_BLE_LEN];
        const usbProductLen = bytes[OFF_USB_PRODUCT_LEN];
        const usbManufacturerLen = bytes[OFF_USB_MANUFACTURER_LEN];
        if (btLen >= 1 && btLen <= BRAND_BT_CLASSIC_MAX_CHARS) {
            rec.btClassic = readField(bytes, OFF_BT_CLASSIC, btLen);
        }
        if (bleLen >= 1 && bleLen <= BRAND_BLE_MAX_CHARS) {
            rec.ble = readField(bytes, OFF_BLE, bleLen);
        }
        if (usbProductLen >= 1 && usbProductLen <= BRAND_USB_PRODUCT_MAX_CHARS) {
            rec.usbProduct = readField(bytes, OFF_USB_PRODUCT, usbProductLen);
        }
        if (usbManufacturerLen >= 1 && usbManufacturerLen <= BRAND_USB_MANUFACTURER_MAX_CHARS) {
            rec.usbManufacturer = readField(bytes, OFF_USB_MANUFACTURER, usbManufacturerLen);
        }
        if (magic !== BRAND_RECORD_MAGIC) {
            rec.invalidReason = bytes.every((b) => b === 0xff) ? 'blank (erased) record' : 'bad magic';
            return rec;
        }
        if (bytes[OFF_LAYOUT_VER] !== BRAND_RECORD_LAYOUT_VER) {
            rec.invalidReason = `unsupported layout version ${bytes[OFF_LAYOUT_VER]}`;
            return rec;
        }
        const fieldChecks = [
            ['Classic BT name', rec.btClassic, BRAND_BT_CLASSIC_MAX_CHARS],
            ['BLE name', rec.ble, BRAND_BLE_MAX_CHARS],
            ['USB product name', rec.usbProduct, BRAND_USB_PRODUCT_MAX_CHARS],
            ['USB manufacturer name', rec.usbManufacturer, BRAND_USB_MANUFACTURER_MAX_CHARS],
        ];
        for (const [label, value, max] of fieldChecks) {
            const problem = brandNameProblem(value, max);
            if (problem) {
                rec.invalidReason = `${label}: ${problem}`;
                return rec;
            }
        }
        const [crcLo, crcHi] = shimmerUartCrcCalc(bytes, OFF_CRC);
        if (bytes[OFF_CRC] !== crcLo || bytes[OFF_CRC + 1] !== crcHi) {
            rec.invalidReason = 'CRC mismatch';
            return rec;
        }
        rec.valid = true;
        return rec;
    }
    /**
     * Serialise a brand record ready to write to the device. Throws on names that
     * the firmware would reject (so callers surface errors before writing).
     */
    function buildBrandRecord(fields) {
        const checks = [
            ['btClassic', fields.btClassic, BRAND_BT_CLASSIC_MAX_CHARS],
            ['ble', fields.ble, BRAND_BLE_MAX_CHARS],
            ['usbProduct', fields.usbProduct, BRAND_USB_PRODUCT_MAX_CHARS],
            ['usbManufacturer', fields.usbManufacturer, BRAND_USB_MANUFACTURER_MAX_CHARS],
        ];
        for (const [label, value, max] of checks) {
            const problem = brandNameProblem(value, max);
            if (problem)
                throw new Error(`${label}: ${problem}`);
        }
        const platform = fields.seededPlatform ?? BRAND_PLATFORM.UNKNOWN;
        if (!Number.isInteger(platform) || platform < 0 || platform > 3) {
            throw new Error(`seededPlatform: must be a BRAND_PLATFORM value (0..3), got ${platform}`);
        }
        const bytes = new Uint8Array(BRAND_RECORD_SIZE); // zero-filled, incl. padding
        bytes[OFF_MAGIC] = BRAND_RECORD_MAGIC & 0xff;
        bytes[OFF_MAGIC + 1] = (BRAND_RECORD_MAGIC >> 8) & 0xff;
        bytes[OFF_LAYOUT_VER] = BRAND_RECORD_LAYOUT_VER;
        bytes[OFF_FLAGS] = (platform << PLATFORM_SHIFT) & PLATFORM_MASK;
        bytes[OFF_BT_CLASSIC_LEN] = fields.btClassic.length;
        bytes[OFF_BLE_LEN] = fields.ble.length;
        bytes[OFF_USB_PRODUCT_LEN] = fields.usbProduct.length;
        bytes[OFF_USB_MANUFACTURER_LEN] = fields.usbManufacturer.length;
        for (let i = 0; i < fields.btClassic.length; i++) {
            bytes[OFF_BT_CLASSIC + i] = fields.btClassic.charCodeAt(i);
        }
        for (let i = 0; i < fields.ble.length; i++)
            bytes[OFF_BLE + i] = fields.ble.charCodeAt(i);
        for (let i = 0; i < fields.usbProduct.length; i++) {
            bytes[OFF_USB_PRODUCT + i] = fields.usbProduct.charCodeAt(i);
        }
        for (let i = 0; i < fields.usbManufacturer.length; i++) {
            bytes[OFF_USB_MANUFACTURER + i] = fields.usbManufacturer.charCodeAt(i);
        }
        const [crcLo, crcHi] = shimmerUartCrcCalc(bytes, OFF_CRC);
        bytes[OFF_CRC] = crcLo;
        bytes[OFF_CRC + 1] = crcHi;
        return bytes;
    }
    /**
     * An all-0xFF (erased) record. Writing this restores the platform defaults:
     * firmware re-seeds them at the next boot.
     */
    function buildBlankBrandRecord() {
        return new Uint8Array(BRAND_RECORD_SIZE).fill(0xff);
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
    function u16le$2(b0, b1) {
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
     * Convert a UTC unix-ms instant to the "local civil" timestamp domain used by
     * the Verisense real-world clock: unix ms with the host's local timezone
     * offset baked in, so that hour-of-day of the raw value equals the wall-clock
     * hour where the base station is.
     *
     * This is the documented time-sync contract ("synchronises the sensor's
     * real-world clock with the Base Station's local time" - Verisense
     * communication protocol) and what the downstream file parser assumes: it
     * evaluates midnight/midday CSV-split boundaries on the raw RWC value in a
     * pinned GMT+0 calendar, and labels CSV timestamp columns
     * "Unix_ms_plus_local_time_zone_offset".
     *
     * Note `getTimezoneOffset()` is evaluated at `utcMillis` itself, so the DST
     * rule in effect at that instant is applied.
     */
    function utcToLocalCivilMillis(utcMillis = Date.now()) {
        return utcMillis - new Date(utcMillis).getTimezoneOffset() * 60000;
    }
    /** Current time in the Verisense local-civil RWC domain, in whole unix seconds. */
    function localCivilUnixSecondsNow() {
        return Math.floor(utcToLocalCivilMillis() / 1000);
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
    /** Upper bound for a plausible device timestamp (2100-01-01 UTC in unix
     * seconds). Values beyond this are uninitialised/garbage bytes, not dates. */
    const VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS = 4102444800;
    /**
     * Format a device-RWC timestamp (unix seconds) as raw + human-readable datetime.
     *
     * The device RWC lives in the "local civil" domain (unix seconds with the
     * base station's timezone offset already baked in - see
     * {@link utcToLocalCivilMillis}), so the value is rendered VERBATIM via the
     * Date UTC accessors: the wall-clock time shown is exactly what the device's
     * clock reads. Rendering with the local-time accessors would apply the
     * browser's timezone offset a second time.
     */
    function formatVerisenseUnixAndHuman(unixSeconds) {
        const unix = Number(unixSeconds);
        if (!Number.isFinite(unix)) {
            return { unix, human: 'invalid' };
        }
        if (unix <= 0) {
            return { unix, human: '1970-01-01 00:00:00 (epoch)' };
        }
        if (unix > VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS) {
            return { unix, human: 'not-valid' };
        }
        const d = new Date(unix * 1000);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const HH = String(d.getUTCHours()).padStart(2, '0');
        const MM = String(d.getUTCMinutes()).padStart(2, '0');
        const SS = String(d.getUTCSeconds()).padStart(2, '0');
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
        // Second status-flags byte (byte 65; the byte-26 flags are full). Null
        // (unknown) when the firmware predates it — never defaulted to false, which
        // would wrongly steer users away from USB DFU on a capable unit.
        const usbDfuBootloader = response.length >= 66 ? (response[65] & 0x01) !== 0 : null;
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
            usbDfuBootloader,
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
    /** Decode the `optimizationResult` byte from {@link parseBleLinkDebugPayload}
     * (see {@link VerisenseBleOptimizationResult} for the bit meanings). */
    function decodeVerisenseBleOptimizationResult(resultByte) {
        const mask = Number(resultByte ?? 0) & 0xff;
        return {
            notConnected: (mask & 0x80) !== 0,
            phyRequested: (mask & 0x01) !== 0,
            connIntervalRequested: (mask & 0x02) !== 0,
            dataLengthRequested: (mask & 0x04) !== 0,
            resultMask: mask,
        };
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
     * Firmware default passkeys by passkey ID: a production config programmed
     * with passkey ID "01" pairs with the fixed PIN "123456". Other IDs have no
     * fixed default (ID "00" uses the per-device derived PIN — see
     * {@link computeVerisensePairingPin}).
     */
    const VERISENSE_DEFAULT_PASSKEY_BY_ID = Object.freeze({
        '01': '123456',
    });
    /** The fixed passkey for a passkey ID, or undefined when the ID has none
     * (leave the passkey bytes unset in the production config). */
    function defaultVerisensePasskeyForId(passkeyId) {
        return VERISENSE_DEFAULT_PASSKEY_BY_ID[String(passkeyId ?? '').trim()];
    }
    /**
     * Build the name a Verisense sensor advertises over BLE:
     * `<prefix>-<passkeyId>-<uniqueId>` (e.g. "Verisense-01-25112101B10F").
     * Returns null when any part is missing — matches how apps derive the name
     * from a parsed production config that may be blank/erased.
     */
    function buildVerisenseAdvertisedName(parts) {
        const prefix = String(parts.prefix ?? '').trim();
        const passkeyId = String(parts.passkeyId ?? '').trim();
        const uniqueId = String(parts.uniqueId ?? '').trim();
        if (!prefix || !passkeyId || !uniqueId)
            return null;
        return `${prefix}-${passkeyId}-${uniqueId}`;
    }
    /**
     * Split a Verisense advertised name back into its parts. The unique ID is the
     * final `-`-separated token; the passkey ID the token before it; anything
     * earlier (which may itself contain `-`) is the prefix. Returns null when the
     * name does not have at least three tokens.
     */
    function parseVerisenseAdvertisedName(name) {
        const tokens = String(name ?? '')
            .trim()
            .split('-');
        if (tokens.length < 3)
            return null;
        const uniqueId = tokens[tokens.length - 1];
        const passkeyId = tokens[tokens.length - 2];
        const prefix = tokens.slice(0, -2).join('-');
        if (!prefix || !passkeyId || !uniqueId)
            return null;
        return { prefix, passkeyId, uniqueId };
    }
    /**
     * The 4-hex MAC ID from a Verisense advertised name (the advertised name ends
     * with the unique ID = manufacturing order + MAC; its last 4 hex chars are
     * the MAC ID). Returns null when the tail is not valid hex.
     */
    function deriveVerisenseMacIdFromName(name) {
        const tail = (String(name ?? '')
            .trim()
            .split('-')
            .pop() ?? '')
            .replace(/[^0-9A-Fa-f]/g, '')
            .toUpperCase()
            .slice(-4);
        return /^[0-9A-F]{4}$/.test(tail) ? tail : null;
    }
    /**
     * Short device tag for file names (e.g. "…-B10F-…"): the last 4 hex chars of
     * a device unique ID or advertised name. Returns "" when unknown so callers
     * can omit it cleanly.
     */
    function verisenseDeviceFileTag(idOrName) {
        const hex = String(idOrName ?? '').replace(/[^0-9A-Fa-f]/g, '');
        return hex.length >= 4 ? hex.slice(-4).toUpperCase() : '';
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
    /**
     * Ensure a nested directory path exists under a root directory handle, creating
     * each level as needed, and return the leaf handle. Browser-only (File System
     * Access API) — the app obtains `root` from `showDirectoryPicker()` when the
     * user selects an output location at transfer start.
     */
    async function ensureDirectoryPath(root, segments) {
        let dir = root;
        for (const seg of segments) {
            dir = await dir.getDirectoryHandle(seg, { create: true });
        }
        return dir;
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
     * Public types for the Shimmer3 / Shimmer3R binary SD-log decoder.
     */
    /** Typed error thrown by the SD-log parsing/decoding entry points. */
    class SdLogFormatError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'SdLogFormatError';
            this.code = code;
        }
    }

    /**
     * SD-card directory naming helpers.
     *
     * The SD layout written by SDLog/LogAndStream firmware is:
     *
     *   <root>/data/<TrialName>_<ConfigTime>/<ShimmerName>-<SessionNumber>/000, 001, …
     *
     * with 3-digit numeric log-file names (no extension). Ported from
     * UtilDock#splitFileName (trial folder splits on the LAST `_`) and
     * ShimmerSDLog#parseSessionNameAndNumber (session folder splits on the
     * LAST `-`). Unlike the Java (which produces garbage or throws on malformed
     * names), these helpers validate and throw a typed BAD_HEADER error.
     */
    /**
     * Split a session folder name (`<ShimmerName>-<SessionNumber>`) on its last
     * `-`. The Shimmer name may itself contain dashes.
     */
    function parseSdSessionName(folder) {
        const idx = folder.lastIndexOf('-');
        if (idx <= 0 || idx === folder.length - 1) {
            throw new SdLogFormatError('BAD_HEADER', `"${folder}" is not a valid session folder name (expected <ShimmerName>-<SessionNumber>).`);
        }
        const numberPart = folder.slice(idx + 1);
        if (!/^\d+$/.test(numberPart)) {
            throw new SdLogFormatError('BAD_HEADER', `"${folder}" has a non-numeric session number ("${numberPart}").`);
        }
        return { shimmerName: folder.slice(0, idx), sessionNumber: parseInt(numberPart, 10) };
    }
    /**
     * Split a trial folder name (`<TrialName>_<ConfigTime>`) on its last `_`.
     * The trial name may itself contain underscores; the config time is kept as
     * the raw string written by the firmware.
     */
    function parseSdTrialFolderName(folder) {
        const idx = folder.lastIndexOf('_');
        if (idx <= 0 || idx === folder.length - 1) {
            throw new SdLogFormatError('BAD_HEADER', `"${folder}" is not a valid trial folder name (expected <TrialName>_<ConfigTime>).`);
        }
        return { trialName: folder.slice(0, idx), configTime: folder.slice(idx + 1) };
    }

    /**
     * High-level SD-card download orchestration for the Shimmer3R.
     *
     * Walks the on-card tree with the client's SD commands, mirrors the directory
     * structure on the host via the File System Access API, and pulls each file
     * down in windows with resume-from-on-disk-size semantics — the same shape as
     * the field-proven Verisense `transferLoggedData` flow.
     */
    /** Device-name folder used when a session folder is not `<Name>-<NNN>`. */
    const CONSENSYS_UNKNOWN_DEVICE = 'Unknown_Shimmer';
    /**
     * Format an import-time folder name as Consensys does: `yyyy-MM-dd_HH.mm.ss`
     * in local time (e.g. `2025-06-25_15.30.36`).
     */
    function formatSdImportStamp(date = new Date()) {
        const p = (n) => String(n).padStart(2, '0');
        return (`${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
            `_${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`);
    }
    /**
     * Map a card directory chain to its Consensys Backup destination.
     *
     * The device name is taken from the session folder (`<ShimmerName>-<NNN>`)
     * rather than from the connected device, so sessions recorded under a previous
     * device name - or on a card that has been moved between devices - still file
     * under the name they were recorded with, which is what Consensys shows.
     */
    function consensysBackupSegments(cardDirSegments, importStamp) {
        let shimmerName = CONSENSYS_UNKNOWN_DEVICE;
        const sessionDir = cardDirSegments[cardDirSegments.length - 1];
        if (sessionDir) {
            try {
                shimmerName = parseSdSessionName(sessionDir).shimmerName;
            }
            catch {
                /* not a <ShimmerName>-<NNN> folder - fall back to the placeholder */
            }
        }
        return [importStamp, shimmerName, ...cardDirSegments];
    }
    function throwIfAborted(signal) {
        if (signal?.aborted)
            throw new DOMException('SD download aborted', 'AbortError');
    }
    /** Recursively enumerate the on-card tree below `rootPath` (depth-first). */
    async function enumerateSdTree(client, rootPath = 'data', opts = {}) {
        const dirs = [];
        const files = [];
        const maxDepth = opts.maxDepth ?? 8;
        const walk = async (path, depth) => {
            throwIfAborted(opts.signal);
            if (depth > maxDepth)
                return;
            const entries = await client.sdListDir(path);
            for (const e of entries) {
                throwIfAborted(opts.signal);
                if (e.nameTruncated)
                    continue; // cannot be addressed by path
                const childPath = `${path}/${e.name}`;
                if (e.isDir) {
                    dirs.push(childPath);
                    await walk(childPath, depth + 1);
                }
                else {
                    files.push({ path: childPath, size: e.size, mtime: e.mtime });
                }
            }
        };
        await walk(rootPath, 0);
        return { dirs, files, totalBytes: files.reduce((n, f) => n + f.size, 0) };
    }
    /**
     * Download the card's `rootPath` tree into `destRoot`, recreating the on-card
     * directory structure. Re-running with the same destination resumes: complete
     * files are skipped and partial files continue from their on-disk size.
     */
    async function downloadSdTree(client, destRoot, opts = {}) {
        const rootPath = opts.rootPath ?? 'data';
        const windowLen = opts.windowLen ?? 128 * 1024;
        const blockPayloadLen = opts.blockPayloadLen ?? SD_BLOCK_PAYLOAD_DEFAULT;
        const resume = opts.resume ?? true;
        const skipExisting = opts.skipExisting ?? true;
        const maxRetriesPerFile = opts.maxRetriesPerFile ?? 3;
        const layout = opts.layout ?? 'card';
        const importStamp = opts.importStamp ?? formatSdImportStamp();
        const summary = {
            importStamp: layout === 'consensysBackup' ? importStamp : undefined,
            filesDownloaded: 0,
            filesSkipped: 0,
            filesFailed: [],
            bytesDownloaded: 0,
            deletedFromCard: [],
        };
        opts.onProgress?.({
            phase: 'enumerate',
            bytesDone: 0,
            bytesTotal: 0,
            filesDone: 0,
            filesTotal: 0,
        });
        const tree = await enumerateSdTree(client, rootPath, { signal: opts.signal });
        let bytesDone = 0;
        let filesDone = 0;
        const fullyDownloaded = [];
        const emit = (extra = {}) => {
            opts.onProgress?.({
                phase: 'download',
                bytesDone,
                bytesTotal: tree.totalBytes,
                filesDone,
                filesTotal: tree.files.length,
                ...extra,
            });
        };
        for (const file of tree.files) {
            throwIfAborted(opts.signal);
            const segments = file.path.split('/');
            const name = segments.pop();
            try {
                const destSegments = layout === 'consensysBackup' ? consensysBackupSegments(segments, importStamp) : segments;
                const dir = await ensureDirectoryPath(destRoot, destSegments);
                const handle = await dir.getFileHandle(name, { create: true });
                const existingSize = (await handle.getFile()).size;
                if (skipExisting && existingSize === file.size) {
                    summary.filesSkipped++;
                    fullyDownloaded.push(file.path);
                    bytesDone += file.size;
                    filesDone++;
                    emit({ currentFile: file.path, fileBytesDone: file.size, fileBytesTotal: file.size });
                    continue;
                }
                const start = resume && existingSize < file.size ? existingSize : 0;
                const writable = await handle.createWritable({ keepExistingData: start > 0 });
                let offset = start;
                let retries = 0;
                const startedAt = Date.now();
                const startedFrom = start;
                try {
                    while (offset < file.size) {
                        throwIfAborted(opts.signal);
                        // Ordered write chain, so block writes never interleave out of order
                        let chain = Promise.resolve();
                        let chainError = null;
                        try {
                            const res = await client.sdReadFileWindow(file.path, offset, Math.min(windowLen, file.size - offset), {
                                blockPayloadLen,
                                stallTimeoutMs: opts.stallTimeoutMs,
                                signal: opts.signal,
                                onBlock: (payload, absOffset) => {
                                    // Positioned writes keep window retries idempotent: a
                                    // half-received window that is re-requested simply
                                    // overwrites the same byte range
                                    chain = chain
                                        .then(() => writable.write({
                                        type: 'write',
                                        position: absOffset,
                                        data: toArrayBuffer(payload),
                                    }))
                                        .catch((e) => {
                                        chainError = e instanceof Error ? e : new Error(String(e));
                                    });
                                },
                            });
                            await chain;
                            if (chainError)
                                throw chainError;
                            if (res.status !== SD_XFER.WINDOW_COMPLETE && res.status !== SD_XFER.EOF) {
                                throw new SdTransferError(`read '${file.path}': ${sdXferStatusToString(res.status)}`, res.status);
                            }
                            if (res.nextOffset <= offset) {
                                throw new Error(`read '${file.path}': no progress at offset ${offset}`);
                            }
                            bytesDone += res.nextOffset - offset;
                            summary.bytesDownloaded += res.nextOffset - offset;
                            offset = res.nextOffset;
                            retries = 0;
                            const elapsedS = (Date.now() - startedAt) / 1000;
                            emit({
                                currentFile: file.path,
                                fileBytesDone: offset,
                                fileBytesTotal: file.size,
                                kbps: elapsedS > 0 ? (offset - startedFrom) / 1024 / elapsedS : undefined,
                            });
                            if (res.status === SD_XFER.EOF)
                                break; // card holds less than listed
                        }
                        catch (e) {
                            await chain.catch(() => { });
                            // In-band refusals (busy, SD lost, not found) are not retryable;
                            // CRC / sequence-gap / stall errors are — from the same offset
                            if (e instanceof SdTransferError || e instanceof DOMException)
                                throw e;
                            if (++retries > maxRetriesPerFile)
                                throw e;
                        }
                    }
                }
                finally {
                    await writable.close().catch(() => { });
                }
                const finalSize = (await handle.getFile()).size;
                if (finalSize >= file.size) {
                    summary.filesDownloaded++;
                    fullyDownloaded.push(file.path);
                }
                else {
                    summary.filesFailed.push({
                        path: file.path,
                        error: `incomplete (${finalSize}/${file.size} bytes)`,
                    });
                }
            }
            catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError')
                    throw e;
                summary.filesFailed.push({
                    path: file.path,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
            filesDone++;
            emit();
        }
        if (opts.deleteAfterVerify && fullyDownloaded.length) {
            opts.onProgress?.({
                phase: 'delete',
                bytesDone,
                bytesTotal: tree.totalBytes,
                filesDone,
                filesTotal: tree.files.length,
            });
            summary.deletedFromCard = await deleteDownloadedFromCard(client, fullyDownloaded, tree.dirs, {
                signal: opts.signal,
            });
        }
        return summary;
    }
    /**
     * Delete verified files from the card (files first, then any directories that
     * emptied out, deepest first). Only paths under `data/` are accepted by the
     * firmware. Returns the paths actually deleted; failures are skipped.
     */
    async function deleteDownloadedFromCard(client, filePaths, dirPaths = [], opts = {}) {
        const deleted = [];
        for (const p of filePaths) {
            throwIfAborted(opts.signal);
            try {
                await client.sdDeletePath(p);
                deleted.push(p);
            }
            catch {
                /* leave the file on the card; the caller can retry */
            }
        }
        // Deepest directories first so empty parents can follow
        const dirs = [...dirPaths].sort((a, b) => b.split('/').length - a.split('/').length);
        for (const d of dirs) {
            throwIfAborted(opts.signal);
            try {
                await client.sdDeletePath(d);
                deleted.push(d);
            }
            catch {
                /* non-empty (something was skipped or new) — leave it */
            }
        }
        return deleted;
    }

    /**
     * Pure protocol helpers for the classic Bluetooth (RFCOMM/SPP) Shimmer3.
     *
     * Classic Shimmer3 speaks the same LiteProtocol command set as the Shimmer3R
     * (see `../shimmer3r/constants.ts`), but over an **unframed RFCOMM byte stream**
     * rather than framed BLE notifications, and with a **different inquiry-response
     * layout** (a 4-byte config word instead of Shimmer3R's 7-byte word). Everything
     * in this file is a side-effect-free function so it can be unit-tested without a
     * transport.
     *
     * Ported from the Shimmer Java driver:
     *   com.shimmerresearch.driver.ShimmerObject#interpretInqResponse (HW_ID.SHIMMER_3 branch)
     *   com.shimmerresearch.bluetooth.ShimmerBluetooth (response byte layouts + handshake)
     */
    /** The Shimmer3 acknowledgement byte (LiteProtocol). Shared with Shimmer3R. */
    const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
    /** The Shimmer3 negative-acknowledgement byte (LiteProtocol). */
    const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE
    /**
     * Well-known SPP (Serial Port Profile) service UUID used to open an RFCOMM
     * socket to a classic Shimmer3. Documented here for the platform transport
     * (e.g. the React Native Android module calls
     * `createRfcommSocketToServiceRecord(SPP_UUID)`); the SDK client itself is
     * transport-agnostic and never touches it.
     */
    const SHIMMER3_SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
    // ---------------------------------------------------------------------------
    // Inquiry-response layout — THE key protocol difference vs Shimmer3R
    // ---------------------------------------------------------------------------
    //
    // Byte layout of an INQUIRY_RESPONSE, INCLUDING the 0x02 opcode byte
    // (ShimmerObject#interpretInqResponse, HW_ID.SHIMMER_3 branch works on the
    // opcode-stripped buffer, so every index below is the Java index + 1):
    //
    //   [0]      = 0x02  INQUIRY_RESPONSE opcode
    //   [1..2]   = sampling-rate divisor, 16-bit little-endian
    //   [3..6]   = config word (configByte0), 4 bytes little-endian   <-- 4, not 7
    //   [7]      = numChannels
    //   [8]      = bufferSize
    //   [9..]    = numChannels channel/signal-ID bytes
    //
    // Shimmer3R differs: its config word is 7 bytes (indices [3..9]), numChannels at
    // [10], bufferSize at [11], channels from [12]. That single width difference is
    // why this cannot reuse Shimmer3RClient's inquiry parser.
    /** 0-based offset (within the opcode-prefixed message) of the config word. */
    const SHIMMER3_INQ_CONFIG_OFFSET = 3;
    /** Config word width in bytes (Shimmer3 = 4; Shimmer3R = 7). */
    const SHIMMER3_INQ_CONFIG_LENGTH = 4;
    /** Offset of the numChannels byte within the opcode-prefixed message. */
    const SHIMMER3_INQ_NUM_CHANNELS_OFFSET = SHIMMER3_INQ_CONFIG_OFFSET + SHIMMER3_INQ_CONFIG_LENGTH; // 7
    /** Offset of the first channel-ID byte within the opcode-prefixed message. */
    const SHIMMER3_INQ_CHANNELS_OFFSET = SHIMMER3_INQ_NUM_CHANNELS_OFFSET + 2; // 9
    /** The sampling clock frequency (Hz) used for divisor↔rate conversion. */
    // ShimmerDevice#getSamplingClockFreq() returns 32768.0 for Shimmer3 and Shimmer3R.
    const SHIMMER3_SAMPLING_CLOCK_FREQ = 32768;
    /**
     * Build a stream schema from the channel-ID list reported by the inquiry.
     *
     * Mirrors ShimmerObject#interpretDataPacketFormat (the channel→format mapping is
     * identical for Shimmer3 and Shimmer3R, so `CHANNEL_FORMATS` and
     * `SensorBitmapShimmer3` are reused verbatim). The only Shimmer3-relevant knob is
     * the timestamp width (u24 for firmware code ≥ 6, else u16 — see
     * ShimmerObject#updateTimestampByteLength).
     */
    function buildShimmer3Schema(channelIds, timestampFmt) {
        const fields = [];
        const ts = timestampFmt === 'u24' ? TIMESTAMP_FIELD.u24 : TIMESTAMP_FIELD.u16;
        let frameBytes = 1 + ts.sizeBytes; // 1 = DATA_PACKET (0x00) preamble
        let enabledSensors = 0;
        for (const id of channelIds) {
            const fmt = CHANNEL_FORMATS[id];
            if (!fmt) {
                fields.push({ id, name: `CH_${hex2(id)}`, fmt: 'i16', endian: 'le', sizeBytes: 2 });
                frameBytes += 2;
                continue;
            }
            fields.push({ id, ...fmt });
            frameBytes += fmt.sizeBytes ?? 2;
            enabledSensors |= channelIdToSensorBit(id);
        }
        return { timestampFmt, fields, frameBytes, enabledSensors, dataPreambleByte: 0x00 };
    }
    /** Map a channel/signal ID to its SensorBitmapShimmer3 enable bit (0 if none). */
    function channelIdToSensorBit(id) {
        switch (id) {
            case 0x00:
            case 0x01:
            case 0x02:
                return SensorBitmapShimmer3.SENSOR_A_ACCEL;
            case 0x04:
            case 0x05:
            case 0x06:
                return SensorBitmapShimmer3.SENSOR_D_ACCEL;
            case 0x14:
            case 0x15:
            case 0x16:
                return SensorBitmapShimmer3.SENSOR_ACCEL_ALT;
            case 0x07:
            case 0x08:
            case 0x09:
                return SensorBitmapShimmer3.SENSOR_MAG;
            case 0x0a:
            case 0x0b:
            case 0x0c:
                return SensorBitmapShimmer3.SENSOR_GYRO;
            case 0x12:
                return SensorBitmapShimmer3.SENSOR_INT_A1;
            case 0x1c:
                return SensorBitmapShimmer3.SENSOR_GSR;
            case 0x23:
            case 0x24:
                return SensorBitmapShimmer3.SENSOR_EXG1_16BIT;
            case 0x25:
            case 0x26:
                return SensorBitmapShimmer3.SENSOR_EXG2_16BIT;
            case 0x1e:
            case 0x1f:
                return SensorBitmapShimmer3.SENSOR_EXG1_24BIT;
            case 0x21:
            case 0x22:
                return SensorBitmapShimmer3.SENSOR_EXG2_24BIT;
            default:
                return 0;
        }
    }
    /**
     * Decode an INQUIRY_RESPONSE using the Shimmer3 (classic) layout.
     *
     * Accepts the message with or without the leading 0x02 opcode byte (the
     * byte-stream parser always includes it; a caller passing a bare body also
     * works, matching Shimmer3RClient's `base` handling).
     *
     * Ported from ShimmerObject#interpretInqResponse, HW_ID.SHIMMER_3 branch.
     */
    function interpretShimmer3InquiryResponse(u8, timestampFmt = 'u24') {
        let base = 0;
        if (u8[0] === OPCODES.INQUIRY_RESPONSE)
            base = 1;
        const adcRaw = u16le$3(u8, base + 0);
        const samplingRateHz = SHIMMER3_SAMPLING_CLOCK_FREQ / adcRaw;
        // 4-byte little-endian config word (Java: bufferInquiry[2..5]).
        const configByte0 = ((u8[base + 2] | (u8[base + 3] << 8) | (u8[base + 4] << 16) | (u8[base + 5] << 24)) >>> 0) >>>
            0;
        const accelRange = (configByte0 & 0xc) >>> 2;
        const gyroRange = (configByte0 & 0x30000) >>> 16;
        const magRange = (configByte0 & 0xe00000) >>> 21;
        const gsrRange = (configByte0 >>> 25) & 0x7;
        const internalExpPower = (configByte0 >>> 24) & 0x1;
        const numChannels = u8[base + 6] ?? 0;
        const bufferSize = u8[base + 7] ?? 0;
        const chStart = base + 8;
        const channelIds = [...u8.slice(chStart, chStart + numChannels)];
        const schema = buildShimmer3Schema(channelIds, timestampFmt);
        return {
            opcode: u8[0],
            adcRaw,
            samplingRateHz,
            configByte0,
            gsrRange,
            internalExpPower,
            accelRange,
            gyroRange,
            magRange,
            numChannels,
            bufferSize,
            channelIds,
            schema,
            bytes: u8.slice(0),
        };
    }
    /** Decode a DEVICE_VERSION_RESPONSE (0x25) — 1 payload byte = HW version.
     *  Ported from ShimmerBluetooth (GET_SHIMMER_VERSION_RESPONSE handler). */
    function parseShimmer3DeviceVersionResponse(u8) {
        const base = u8[0] === OPCODES.DEVICE_VERSION_RESPONSE ? 1 : 0;
        return { hardwareVersion: u8[base] ?? 0 };
    }
    /**
     * Firmware identifier (type) values, from
     * com.shimmerresearch.driverUtilities.ShimmerVerDetails.FW_ID.
     */
    const FW_ID = Object.freeze({
        BTSTREAM: 1,
        SDLOG: 2,
        LOGANDSTREAM: 3,
    });
    /**
     * Decode a FW_VERSION_RESPONSE (0x2F) — 6 payload bytes.
     * Ported from ShimmerBluetooth (FW_VERSION_RESPONSE handler):
     *   id  = b1<<8 | b0   (little-endian)
     *   maj = b3<<8 | b2
     *   min = b4
     *   int = b5
     */
    function parseShimmer3FwVersionResponse(u8) {
        const base = u8[0] === OPCODES.FW_VERSION_RESPONSE ? 1 : 0;
        const b = (i) => u8[base + i] ?? 0;
        return {
            firmwareIdentifier: (b(1) << 8) | b(0),
            major: (b(3) << 8) | b(2),
            minor: b(4),
            internal: b(5),
        };
    }
    /**
     * Whether streaming data frames use a 3-byte (u24) timestamp for this firmware.
     *
     * The Java driver widens the timestamp to 3 bytes when the derived firmware
     * version code is ≥ 6 (ShimmerObject#updateTimestampByteLength). That code is a
     * per-firmware-type version ladder (ShimmerVerObject); code ≥ 6 corresponds to
     * LogAndStream ≥ 0.5.4, BtStream ≥ 0.7.3, and SDLog ≥ 0.11.5. Anything at or
     * above those (and any firmware type we don't recognise, assumed modern) uses
     * u24; older firmware uses u16.
     */
    function shimmer3UsesThreeByteTimestamp(v) {
        const atLeast = (maj, min, int) => v.major > maj || (v.major === maj && (v.minor > min || (v.minor === min && v.internal >= int)));
        switch (v.firmwareIdentifier) {
            case FW_ID.LOGANDSTREAM:
                return atLeast(0, 5, 4);
            case FW_ID.BTSTREAM:
                return atLeast(0, 7, 3);
            case FW_ID.SDLOG:
                return atLeast(0, 11, 5);
            default:
                return true; // unknown/newer firmware type — default to modern u24
        }
    }
    // ---------------------------------------------------------------------------
    // Unframed-stream control-message framing
    // ---------------------------------------------------------------------------
    /**
     * Fixed payload lengths (bytes AFTER the opcode) for the control responses the
     * v1 client consumes. INQUIRY_RESPONSE is variable and handled specially in
     * {@link shimmer3ControlMessageLength}. Extend this table to teach the
     * byte-stream parser about further GET responses.
     *
     * Lengths taken from the `readBytes(n, ...)` calls in ShimmerBluetooth and the
     * LiteProtocol instruction-set response_size annotations.
     */
    const SHIMMER3_RESPONSE_PAYLOAD_LENGTHS = Object.freeze({
        [OPCODES.SAMPLING_RATE_RESPONSE]: 2, // 0x04
        [OPCODES.FW_VERSION_RESPONSE]: 6, // 0x2F
        [OPCODES.DEVICE_VERSION_RESPONSE]: 1, // 0x25
        [OPCODES.GSR_RANGE_RESPONSE]: 1, // 0x22
        [OPCODES.INTERNAL_EXP_POWER_ENABLE_RESPONSE]: 1, // 0x5F
    });
    /** Sentinel: need more bytes before the message length can be determined. */
    const NEED_MORE = -1;
    /** Sentinel: leading byte is not a recognised control opcode — caller resyncs. */
    const RESYNC = 0;
    /**
     * Given the head of the accumulated RFCOMM byte buffer, return the total length
     * (INCLUDING the leading opcode) of the complete control message it starts with,
     * or {@link NEED_MORE} if not enough bytes have arrived yet, or {@link RESYNC}
     * if the leading byte is not a control opcode we understand (garbage / a data
     * byte leaked into the control plane — the caller should drop one byte and
     * retry).
     *
     * This is the primitive that makes the unframed RFCOMM stream tractable: unlike
     * BLE (one notification == one message), RFCOMM delivers bytes split or
     * coalesced arbitrarily, so the client cannot assume `chunk[0]` is a whole
     * message. The Java driver solves the same problem with blocking `readBytes(n)`
     * calls that know each response's length up front (ShimmerBluetooth); this
     * expresses that length knowledge as a pure function.
     *
     * ACK (0xFF) and NACK (0xFE) are 1-byte messages. INQUIRY_RESPONSE (0x02) is
     * `9 + numChannels` bytes, and numChannels lives at index 7, so at least 8 bytes
     * are needed to compute the length.
     */
    function shimmer3ControlMessageLength(buf) {
        if (buf.length === 0)
            return NEED_MORE;
        const opcode = buf[0];
        if (opcode === ACK || opcode === NACK)
            return 1;
        if (opcode === OPCODES.INQUIRY_RESPONSE) {
            if (buf.length <= SHIMMER3_INQ_NUM_CHANNELS_OFFSET)
                return NEED_MORE; // need index 7 present
            const numChannels = buf[SHIMMER3_INQ_NUM_CHANNELS_OFFSET];
            // Sanity bound: a stray stream-data byte 0x02 can masquerade as an
            // INQUIRY_RESPONSE whose "numChannels" comes from garbage, swallowing up to
            // 264 bytes of real control traffic (including ACK/NACK). No real Shimmer3
            // has anywhere near 32 channels — treat implausible values as garbage and
            // resync instead.
            if (numChannels > 32)
                return RESYNC;
            return SHIMMER3_INQ_CHANNELS_OFFSET + numChannels; // 9 + numChannels
        }
        if (opcode === OPCODES.DAUGHTER_CARD_MEM_RESPONSE) {
            // Variable length: [0x68][length][data...]. Firmware caps daughter-card
            // memory reads at 128 bytes — treat larger "lengths" as garbage and resync.
            if (buf.length < 2)
                return NEED_MORE;
            const dcLen = buf[1];
            if (dcLen > 128)
                return RESYNC;
            return 2 + dcLen;
        }
        const payload = SHIMMER3_RESPONSE_PAYLOAD_LENGTHS[opcode];
        if (payload === undefined)
            return RESYNC;
        return 1 + payload;
    }

    /**
     * Classic-Bluetooth (RFCOMM/SPP) Shimmer3 constants.
     *
     * The LiteProtocol opcode set, sensor bitmap, channel formats and timestamp
     * descriptors are byte-for-byte identical to the Shimmer3R, so they are
     * re-exported from `../shimmer3r/` rather than duplicated. Only the values that
     * are genuinely Shimmer3-classic-specific live here.
     */
    // Re-export the shared LiteProtocol surface so Shimmer3 consumers import from one
    // module (these are identical across the two device families).
    /**
     * Connect-handshake defaults, ported from the timings/sequence in
     * com.shimmerresearch.bluetooth.ShimmerBluetooth.
     */
    const SHIMMER3_DEFAULTS = Object.freeze({
        /**
         * How long to drain-and-discard bytes after the dummy read that flushes the
         * RFCOMM buffer on connect. ShimmerBluetooth's dummy read polls the serial
         * buffer with short sleeps; 250 ms comfortably covers an ACK + response at
         * classic-BT latencies.
         */
        DUMMY_READ_DRAIN_MS: 250,
        /** Per-command ACK timeout (ms). */
        ACK_TIMEOUT_MS: 1500,
        /** Response (post-ACK) timeout (ms). */
        RESPONSE_TIMEOUT_MS: 2000,
        /**
         * Default streaming timestamp width. Classic Shimmer3 LogAndStream firmware
         * with version code ≥ 6 uses a 3-byte timestamp
         * (ShimmerObject#updateTimestampByteLength); older firmware uses 2 bytes.
         */
        TIMESTAMP_FMT: 'u24',
    });

    // ---------------------------------------------------------------------------
    // Shimmer3Client
    // ---------------------------------------------------------------------------
    /**
     * Client for the **classic-Bluetooth (RFCOMM/SPP) Shimmer3**.
     *
     * Shimmer3 speaks the same LiteProtocol as the Shimmer3R (shared opcodes, sensor
     * bitmap, channel formats — all reused from `../shimmer3r/`), with two
     * differences this client owns:
     *
     * 1. **Unframed byte stream.** RFCOMM has no MTU and no message framing: bytes
     *    arrive split or coalesced arbitrarily. Rather than assume "one notification
     *    = one message" (as the BLE {@link Shimmer3RClient} does), this client
     *    accumulates inbound bytes and extracts complete control messages with a
     *    length-aware parser ({@link shimmer3ControlMessageLength}). This mirrors the
     *    Java driver's blocking `readBytes(n)` approach (ShimmerBluetooth) but as a
     *    non-blocking accumulator.
     * 2. **Inquiry-response layout.** Shimmer3's config word is 4 bytes vs
     *    Shimmer3R's 7 (see {@link interpretShimmer3InquiryResponse}).
     *
     * Transport injection is mandatory — `connect()` with no transport throws.
     *
     * @example
     * ```ts
     * const client = new Shimmer3Client({ transport: rfcommTransport });
     * client.onStatus = (m) => console.log(m);
     * await client.connect();               // handshake: flush → HW version → FW version
     * await client.setSamplingRate(51.2);
     * await client.setSensors(SensorBitmapShimmer3.SENSOR_GYRO);
     * await client.setGSRRange(2);
     * await client.startStreaming();
     * ```
     */
    class Shimmer3Client extends BaseShimmerClient {
        constructor(opts = {}) {
            super(opts);
            // Transport (byte pipe). Always injected — never built by this client.
            this._injectedTransport = null;
            this._transport = null;
            this._notifyUnsub = null;
            this._disconnectUnsub = null;
            // Protocol state
            this._rxBuf = new Uint8Array(0);
            this._temps = new Set();
            this.schema = null;
            this._streaming = false;
            this._streamStarting = false;
            this._lastTs = 0;
            /** Bumped once per inbound transport chunk — used for quiescence detection. */
            this._rxSeq = 0;
            /** While true, {@link _handleNotify} only accumulates; a drain loop owns `_rxBuf`. */
            this._drainingResidual = false;
            /** Number of {@link _waitForResponse} calls currently awaiting an INQUIRY_RESPONSE. */
            this._awaitInq = 0;
            /**
             * Number of command handlers ({@link _waitForAck} / {@link _waitForResponse})
             * currently awaiting a response. Gates NACK framing in {@link _drainControl}
             * so a stray 0xFE arriving with no command in flight cannot fabricate a NACK.
             */
            this._awaitCmd = 0;
            // Cached device info from the connect handshake
            this.deviceVersion = null;
            this.firmwareVersion = null;
            // Cached device configuration
            this.enabledSensors = 0x000000;
            this.samplingRateHz = 0;
            this.gsrRangeSetting = 0;
            this.ExpPower = 0;
            /** Inertial-sensor hardware ranges, refreshed from each inquiry's config word. */
            this.imuRanges = {
                lnAccel: 0, // Kionix KXRB LN accel is fixed-range on Shimmer3
                wrAccel: 0,
                gyro: 0,
                mag: 0,
                altAccel: 0,
                altMag: 0,
            };
            /** When false, inertial channels are emitted raw-only (no `'cal'` field). Default true. */
            this.emitCalibratedInertial = true;
            this._deviceCalibrations = {};
            /** Minimum valid GSR conductance in µS (below this, connectivity = "Disconnected"). */
            this.LIMIT_MIN_VALID_USIEMENS = 0.03;
            // Callbacks
            this.onInquiry = null;
            this.onExpPowerChanged = null;
            this._handleTransportDisconnect = () => {
                this._streaming = false;
                this._streamStarting = false;
                this._emitStatus('Device disconnected');
            };
            // ---------------------------------------------------------------------------
            // Notify handler — accumulate + parse an UNFRAMED byte stream
            // ---------------------------------------------------------------------------
            this._handleNotify = (chunk) => {
                if (!chunk || chunk.length === 0)
                    return;
                this._log('Notify len=', chunk.length, 'data=', chunk);
                this._rxSeq += 1; // for quiescence detection
                this._rxBuf = concatU8(this._rxBuf, chunk);
                // While a residual-drain is in progress the drain loop owns the buffer:
                // just accumulate, so stale stream bytes never reach the control parser.
                if (this._drainingResidual)
                    return;
                if (this._streaming) {
                    this._parseStream();
                }
                else {
                    this._drainControl();
                }
            };
            this._injectedTransport = opts.transport ?? null;
            this._forceTimestampFmt = opts.timestampFmt;
            this._timestampFmt = opts.timestampFmt ?? SHIMMER3_DEFAULTS.TIMESTAMP_FMT;
            this._stopStreamingOnConnect = opts.stopStreamingOnConnect ?? true;
            this._imuFamily = opts.imuGeneration === 'new' ? 'shimmer3-new' : 'shimmer3-old';
            this.emitCalibratedInertial = opts.emitCalibratedInertial ?? true;
        }
        _log(...args) {
            if (this.debug)
                console.log('[Shimmer3]', ...args);
        }
        /** Best-effort label for `ObjectCluster`s and status messages. */
        _deviceLabel() {
            return this._transport?.deviceName ?? 'Shimmer3';
        }
        /** The streaming timestamp width currently in effect. */
        get timestampFmt() {
            return this._timestampFmt;
        }
        // ---------------------------------------------------------------------------
        // Connection management + handshake
        // ---------------------------------------------------------------------------
        /**
         * Open the RFCOMM connection and run the classic-Shimmer3 connect handshake.
         *
         * A transport is REQUIRED (constructor option or this parameter): Web
         * Bluetooth cannot open an RFCOMM socket, so there is no default. In a browser
         * the working transport is a {@link WebSerialTransport} over the virtual COM
         * port the OS creates for a Shimmer paired over classic Bluetooth. Calling
         * without one throws.
         *
         * Handshake (ported from ShimmerBluetooth#initialize → readShimmerVersionNew →
         * readFWVersion):
         *   1. best-effort STOP_STREAMING (safety on reconnect; opt-out via options),
         *   2. dummy GET_SAMPLING_RATE write + drain to flush the RFCOMM buffer,
         *   3. GET_DEVICE_VERSION_COMMAND (0x3F) → DEVICE_VERSION_RESPONSE (HW version),
         *   4. GET_FW_VERSION_COMMAND (0x2E) → FW_VERSION_RESPONSE (firmware version),
         *   then the streaming timestamp width is derived from the firmware code.
         */
        async connect(transport) {
            const t = transport ?? this._injectedTransport;
            if (!t) {
                throw new Error('Shimmer3Client requires an injected transport: Web Bluetooth cannot open an ' +
                    'RFCOMM/SPP socket. In a browser, pair the sensor over classic Bluetooth and ' +
                    'pass a WebSerialTransport over the COM port the OS creates for it ' +
                    '(allowedBluetoothServiceClassIds: [SHIMMER3_SPP_UUID]); elsewhere pass any ' +
                    'ShimmerTransport via the constructor ({ transport }) or connect(transport).');
            }
            this._transport = t;
            this._notifyUnsub = t.onNotify(this._handleNotify);
            this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);
            this._emitStatus('Opening RFCOMM connection…');
            await t.connect();
            this._emitStatus(`Connected: ${this._deviceLabel()}`);
            await this._handshake();
        }
        async _handshake() {
            // 2) Flush the serial buffer with a dummy read (ShimmerBluetooth#dummyReadSamplingRate:
            //    "it actually acts to clear the write buffer"). A best-effort STOP first
            //    ensures a device left streaming from a previous session is quiesced.
            if (this._stopStreamingOnConnect) {
                try {
                    await this._write(new Uint8Array([OPCODES.STOP_STREAMING_COMMAND]));
                }
                catch {
                    /* ignore */
                }
            }
            this._rxBuf = new Uint8Array(0);
            this._emitStatus('Flushing RFCOMM buffer (dummy read)…');
            try {
                await this._write(new Uint8Array([OPCODES.GET_SAMPLING_RATE_COMMAND]));
            }
            catch {
                /* ignore */
            }
            await new Promise((r) => setTimeout(r, SHIMMER3_DEFAULTS.DUMMY_READ_DRAIN_MS));
            this._rxBuf = new Uint8Array(0); // discard whatever the dummy read produced
            // 3) HW version. Responses may or may not be ACK-prefixed on classic firmware,
            //    so wait for the response opcode directly (any leading ACK is ignored).
            this._emitStatus('GET_DEVICE_VERSION → waiting for response…');
            await this._write(new Uint8Array([OPCODES.GET_DEVICE_VERSION_COMMAND]));
            const verBytes = await this._waitForResponse(OPCODES.DEVICE_VERSION_RESPONSE, SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS);
            this.deviceVersion = parseShimmer3DeviceVersionResponse(verBytes);
            this._emitStatus(`HW version = ${this.deviceVersion.hardwareVersion}`);
            // 4) FW version.
            this._emitStatus('GET_FW_VERSION → waiting for response…');
            await this._write(new Uint8Array([OPCODES.GET_FW_VERSION_COMMAND]));
            const fwBytes = await this._waitForResponse(OPCODES.FW_VERSION_RESPONSE, SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS);
            this.firmwareVersion = parseShimmer3FwVersionResponse(fwBytes);
            this._emitStatus(`FW version = ${this.firmwareVersion.major}.${this.firmwareVersion.minor}.${this.firmwareVersion.internal} (type ${this.firmwareVersion.firmwareIdentifier})`);
            // Derive timestamp width from firmware unless the caller forced one.
            if (this._forceTimestampFmt === undefined) {
                this._timestampFmt = shimmer3UsesThreeByteTimestamp(this.firmwareVersion) ? 'u24' : 'u16';
            }
            this._emitStatus(`Handshake complete (timestamp = ${this._timestampFmt}).`);
        }
        async disconnect() {
            try {
                this._notifyUnsub?.();
                this._disconnectUnsub?.();
                await this._transport?.disconnect();
            }
            catch {
                /* ignore */
            }
            finally {
                this._notifyUnsub = this._disconnectUnsub = null;
                this._transport = null;
                this._rxBuf = new Uint8Array(0);
                this.schema = null;
                this._streaming = false;
                this._streamStarting = false;
                this.ExpPower = 0;
                this._deviceCalibrations = {};
                this._emitStatus('Disconnected');
            }
        }
        /**
         * Extract every complete control message currently buffered and dispatch each
         * to the temp handlers, then keep the incomplete tail for the next chunk. This
         * is what makes the unframed RFCOMM stream behave like framed BLE for the
         * ACK/response machinery below.
         */
        _drainControl() {
            let buf = this._rxBuf;
            for (;;) {
                if (buf.length === 0)
                    break;
                // While a stream is (about to be) live, DATA_PACKET (0x00) bytes belong to
                // the stream parser, not the control plane — leave them buffered.
                if ((this._streaming || this._streamStarting) && buf[0] === OPCODES.DATA_PACKET)
                    break;
                // Only frame 0x02 as an INQUIRY_RESPONSE when an inquiry is actually
                // awaited; an unexpected 0x02 is a stray/stream byte and framing it would
                // swallow real control bytes. Drop it instead.
                if (buf[0] === OPCODES.INQUIRY_RESPONSE && this._awaitInq <= 0) {
                    this._log('drainControl: dropping 0x02 — no INQUIRY awaited');
                    buf = buf.subarray(1);
                    continue;
                }
                // Same guard for NACK (0xFE): only frame it as a control message while a
                // command is genuinely awaiting a response (_awaitCmd > 0). A stray 0xFE —
                // e.g. a late residual byte arriving after the stop-drain returned early —
                // is dropped instead of framed. This diverges from the Java driver
                // (ShimmerObject processes every 0xFE unconditionally) but strictly reduces
                // the risk of a leaked stream byte being mistaken for a NACK, mirroring the
                // 0x02 gate above. Defence-in-depth: today _onTemp handlers are added only
                // while _awaitCmd > 0, so an ungated stray 0xFE would emit to no listener;
                // this guard keeps that invariant explicit and survives refactors that add
                // a longer-lived control listener.
                if (buf[0] === NACK && this._awaitCmd <= 0) {
                    this._log('drainControl: dropping 0xFE — no command awaited');
                    buf = buf.subarray(1);
                    continue;
                }
                const len = shimmer3ControlMessageLength(buf);
                if (len === NEED_MORE)
                    break;
                if (len === RESYNC) {
                    this._log(`resync: dropping unexpected control byte 0x${buf[0].toString(16)}`);
                    buf = buf.subarray(1);
                    continue;
                }
                if (buf.length < len)
                    break; // full message not here yet
                this._emitTemp(new Uint8Array(buf.subarray(0, len)));
                buf = buf.subarray(len);
            }
            this._rxBuf = buf.length ? new Uint8Array(buf) : new Uint8Array(0);
        }
        // ---------------------------------------------------------------------------
        // Configuration commands
        // ---------------------------------------------------------------------------
        getEnabledSensors() {
            return this.enabledSensors;
        }
        getInternalExpPower() {
            return this.ExpPower;
        }
        /**
         * Enable sensors via a 24-bit bitmask (SET_SENSORS_COMMAND). Automatically
         * re-inquires after the ACK to rebuild the stream schema, matching
         * {@link Shimmer3RClient.setSensors}.
         */
        async setSensors(sensors) {
            if (!Number.isFinite(sensors))
                throw new Error('sensors must be a finite number');
            if (!this._transport)
                throw new Error('Not connected');
            sensors = (sensors >>> 0) & 0xffffff;
            const cmd = new Uint8Array([
                OPCODES.SET_SENSORS_COMMAND,
                sensors & 0xff,
                (sensors >>> 8) & 0xff,
                (sensors >>> 16) & 0xff,
            ]);
            this._emitStatus(`SET_SENSORS → 0x${sensors.toString(16).toUpperCase().padStart(6, '0')} waiting for ACK…`);
            await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
            this._emitStatus('Sensors ACKed; re-inquiring to refresh schema…');
            try {
                const info = await this.inquiry();
                this.enabledSensors = info.schema.enabledSensors;
            }
            catch (err) {
                this._emitStatus(`Inquiry after setSensors failed: ${err.message}`);
            }
            return { sensors, enabledSensors: this.enabledSensors };
        }
        /**
         * Set the sampling rate (SET_SAMPLING_RATE_COMMAND). The firmware takes a
         * 16-bit divisor `floor(32768 / rateHz)`; identical to Shimmer3R.
         */
        async setSamplingRate(rateHz) {
            if (!Number.isFinite(rateHz) || rateHz <= 0) {
                throw new Error('Sampling rate must be a positive number (Hz)');
            }
            if (!this._transport)
                throw new Error('Not connected');
            let divisor = Math.floor(32768 / rateHz);
            divisor = Math.max(1, Math.min(0xffff, divisor));
            const cmd = new Uint8Array([
                OPCODES.SET_SAMPLING_RATE_COMMAND,
                divisor & 0xff,
                (divisor >> 8) & 0xff,
            ]);
            this._emitStatus(`SET_SAMPLING_RATE → ${rateHz} Hz (divisor=${divisor}) waiting for ACK…`);
            await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
            const appliedHz = 32768 / divisor;
            this.samplingRateHz = appliedHz;
            this._emitStatus(`Sampling rate ACKed. Applied ≈ ${appliedHz.toFixed(3)} Hz`);
            return { requestedHz: rateHz, appliedHz, divisor };
        }
        /**
         * Set the GSR measurement range (SET_GSR_RANGE_COMMAND).
         * @param gsrRange 0 = 8–63 kΩ, 1 = 63–220 kΩ, 2 = 220–680 kΩ, 3 = 680–4700 kΩ, 4 = Auto.
         */
        async setGSRRange(gsrRange) {
            if (!Number.isInteger(gsrRange) || gsrRange < 0 || gsrRange > 4) {
                throw new Error('gsrRange must be 0–4');
            }
            if (!this._transport)
                throw new Error('Not connected');
            const cmd = new Uint8Array([OPCODES.SET_GSR_RANGE_COMMAND, gsrRange & 0xff]);
            this._emitStatus('SET_GSR_RANGE → waiting for ACK…');
            await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
            this.gsrRangeSetting = gsrRange;
            this._emitStatus('SET_GSR_RANGE (ACK received).');
            return { gsrRange };
        }
        /**
         * Control the internal expansion power rail (required for ExG/EMG/ECG).
         * @param expPower 0 = disable, 1 = enable.
         */
        async setInternalExpPower(expPower) {
            if (expPower !== 0 && expPower !== 1)
                throw new Error('expPower must be 0 or 1');
            if (!this._transport)
                throw new Error('Not connected');
            const cmd = new Uint8Array([OPCODES.SET_INTERNAL_EXP_POWER_ENABLE_COMMAND, expPower]);
            this._emitStatus(`SET_INTERNAL_EXP_POWER → ${expPower ? 'ON' : 'OFF'} waiting for ACK…`);
            await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
            this.ExpPower = expPower;
            try {
                this.onExpPowerChanged?.(expPower);
            }
            catch (e) {
                this._log('onExpPowerChanged handler error', e);
            }
            return { expPower };
        }
        // ---------------------------------------------------------------------------
        // Inquiry
        // ---------------------------------------------------------------------------
        /**
         * Send INQUIRY_COMMAND and parse the (Shimmer3-layout) response, building the
         * stream schema. Tolerant of an optional leading ACK before the response.
         */
        async inquiry() {
            if (!this._transport)
                throw new Error('Not connected');
            this._emitStatus('INQUIRY → waiting for response…');
            await this._write(new Uint8Array([OPCODES.INQUIRY_COMMAND]));
            const rsp = await this._waitForResponse(OPCODES.INQUIRY_RESPONSE, SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS);
            const info = interpretShimmer3InquiryResponse(rsp, this._timestampFmt);
            this.schema = info.schema;
            this.samplingRateHz = info.samplingRateHz;
            this.enabledSensors = info.schema.enabledSensors;
            this.gsrRangeSetting = info.gsrRange;
            this.ExpPower = info.internalExpPower;
            // Inertial ranges from the config word (interpretShimmer3InquiryResponse):
            // accelRange = WR accel (LSM303), gyroRange = MPU gyro, magRange = LSM303 mag.
            // LN accel (Kionix) is fixed-range → 0.
            this.imuRanges = {
                lnAccel: 0,
                wrAccel: info.accelRange,
                gyro: info.gyroRange,
                mag: info.magRange,
                altAccel: 0,
                altMag: 0,
            };
            this._emitStatus(`Inquiry: ${info.numChannels} ch, ${info.samplingRateHz.toFixed(2)} Hz, ` +
                `sensors=0x${info.schema.enabledSensors.toString(16).toUpperCase()}`);
            try {
                this.onInquiry?.(info);
            }
            catch (e) {
                this._log('onInquiry handler error', e);
            }
            return info;
        }
        /**
         * Arm a one-shot soft reboot that the device performs as soon as this host
         * disconnects (SET_FEATURE / FEATURE_REBOOT_ON_DISCONNECT).
         *
         * Settings that firmware only reads at boot - notably the EEPROM brand
         * record's advertising names - otherwise need a manual power-cycle. The
         * reboot cannot happen while still connected, because the link has to drop
         * for the Bluetooth module to re-read its name; so the sequence is: write
         * settings, call this, then {@link disconnect}.
         *
         * Firmware skips the reboot while sensing so that it can never truncate an
         * active SD recording, and clears the request either way - it is strictly
         * one-shot and never carries into a later disconnect.
         *
         * Requires firmware with FEATURE_REBOOT_ON_DISCONNECT support; older
         * firmware NACKs the unknown feature id.
         */
        async setRebootOnDisconnect(enabled) {
            if (!this._transport)
                throw new Error('Not connected');
            this._emitStatus(`SET_FEATURE reboot-on-disconnect=${enabled ? 1 : 0} → waiting for ACK…`);
            await this._writeExpectingAck(new Uint8Array([OPCODES.SET_FEATURE, BT_FEATURE.REBOOT_ON_DISCONNECT, enabled ? 1 : 0]), SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
            this._emitStatus(`Reboot-on-disconnect ${enabled ? 'armed' : 'cleared'}`);
        }
        // ---------------------------------------------------------------------------
        // Daughter-card (expansion board) EEPROM memory
        // ---------------------------------------------------------------------------
        /**
         * Read from the daughter-card EEPROM memory. `offset` is a HOST offset —
         * firmware maps it past the first (HW details) EEPROM page, so host offsets
         * 0..2031 cover absolute EEPROM bytes 16..2047.
         */
        async readDaughterCardMem(offset, length) {
            if (!this._transport)
                throw new Error('Not connected');
            if (!Number.isInteger(offset) || offset < 0 || offset > 2031) {
                throw new Error('Daughter-card mem offset must be an integer in 0..2031.');
            }
            if (!Number.isInteger(length) || length < 1 || length > 128 || offset + length > 2032) {
                throw new Error('Daughter-card mem read must be 1..128 bytes within 0..2031.');
            }
            this._emitStatus(`GET_DAUGHTER_CARD_MEM ${length}B @ ${offset} → waiting for RSP…`);
            const cmd = new Uint8Array([
                OPCODES.GET_DAUGHTER_CARD_MEM_COMMAND,
                length & 0xff,
                offset & 0xff,
                (offset >> 8) & 0xff,
            ]);
            await this._write(cmd);
            const rsp = await this._waitForResponse(OPCODES.DAUGHTER_CARD_MEM_RESPONSE, SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS);
            /* Response is [DAUGHTER_CARD_MEM_RSP][length][data...]; the opcode and
             * length bytes are skipped when present and consistent. */
            let off = 0;
            if (rsp[off] === OPCODES.DAUGHTER_CARD_MEM_RESPONSE)
                off++;
            if (rsp.length > off && rsp[off] === length && rsp.length >= off + 1 + length)
                off++;
            const data = rsp.slice(off, off + length);
            if (data.length < length) {
                throw new Error(`Daughter-card mem read returned ${data.length} of ${length} bytes.`);
            }
            return data;
        }
        /**
         * Write to the daughter-card EEPROM memory. `offset` is a HOST offset (see
         * {@link readDaughterCardMem}). Max 128 bytes per write.
         */
        async writeDaughterCardMem(offset, data) {
            if (!this._transport)
                throw new Error('Not connected');
            if (!Number.isInteger(offset) || offset < 0 || offset > 2031) {
                throw new Error('Daughter-card mem offset must be an integer in 0..2031.');
            }
            if (data.length < 1 || data.length > 128 || offset + data.length > 2032) {
                throw new Error('Daughter-card mem write must be 1..128 bytes within 0..2031.');
            }
            this._emitStatus(`SET_DAUGHTER_CARD_MEM ${data.length}B @ ${offset} → waiting for ACK…`);
            const cmd = new Uint8Array(4 + data.length);
            cmd[0] = OPCODES.SET_DAUGHTER_CARD_MEM_COMMAND;
            cmd[1] = data.length & 0xff;
            cmd[2] = offset & 0xff;
            cmd[3] = (offset >> 8) & 0xff;
            cmd.set(data, 4);
            await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
            this._emitStatus('Daughter-card mem write ACKed');
        }
        // ---------------------------------------------------------------------------
        // Streaming
        // ---------------------------------------------------------------------------
        async startStreaming() {
            if (!this._transport)
                throw new Error('Not connected');
            if (!this.schema)
                this._emitStatus('Starting stream without schema (not recommended).');
            // Stale buffered bytes (e.g. residual post-stop stream data) would desync
            // the ACK wait for START — drain to quiescence and discard them first. A
            // clean state (empty buffer) skips this entirely.
            if (this._rxBuf.length > 0) {
                this._drainingResidual = true;
                try {
                    await this._drainQuiescent(300, 2000);
                }
                finally {
                    this._drainingResidual = false;
                }
                this._log('start: discarded', this._rxBuf.length, 'stale byte(s) pre-START');
                this._rxBuf = new Uint8Array(0);
            }
            this._streamStarting = true;
            this._lastTs = 0;
            this._emitStatus('START_STREAMING → waiting for ACK…');
            try {
                await this._writeExpectingAck(new Uint8Array([OPCODES.START_STREAMING_COMMAND]), SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
            }
            catch (e) {
                this._streamStarting = false;
                throw e;
            }
            this._streaming = true;
            this._streamStarting = false;
            // Bytes that arrived after the ACK are the first data — parse them now.
            this._parseStream();
            this._emitStatus('START_STREAMING ACK received; frames should follow.');
        }
        async stopStreaming() {
            this._emitStatus('STOP_STREAMING → sending, then draining residual stream…');
            try {
                await this._write(new Uint8Array([OPCODES.STOP_STREAMING_COMMAND]));
            }
            catch (err) {
                this._emitStatus(`STOP_STREAMING write failed: ${err.message}`);
            }
            // In-flight stream packets keep arriving for hundreds of ms after STOP.
            // Flipping to control mode instantly would let residual data hit
            // _drainControl, where a stray 0xFE fabricates a NACK and a stray 0x02
            // swallows real bytes (including ACKs). Keep the stream parser active while
            // draining (or accumulate-only if we weren't in streaming mode — e.g.
            // quiescing a device left streaming unattended), and only re-enable the
            // control plane once the pipe has been quiet for ~300 ms.
            this._streamStarting = false;
            if (!this._streaming)
                this._drainingResidual = true;
            try {
                await this._drainQuiescent(300, 3000);
            }
            finally {
                this._drainingResidual = false;
            }
            if (this._rxBuf.length) {
                this._log('stop drain: discarding', this._rxBuf.length, 'residual byte(s)');
            }
            this._streaming = false;
            this._rxBuf = new Uint8Array(0);
            this._emitStatus('Streaming stopped.');
        }
        /**
         * Resolve once no bytes have arrived for `quietMs` (checked every 50 ms via
         * the `_rxSeq` counter bumped in {@link _handleNotify}), or `maxMs` overall.
         *
         * HEURISTIC (hardware QA, please probe): the Shimmer3 streaming protocol has
         * no end-of-stream handshake — STOP_STREAMING is ACKed but the firmware does
         * not signal when the last data frame has been flushed over RFCOMM. Draining
         * "until quiet" is therefore best-effort: the 300 ms quiet window / 3 s cap
         * are tuned guesses, not protocol guarantees. Too short and a late residual
         * frame leaks into the next command's control parsing; too long and stop()
         * stalls. Values may need adjusting against real BT latency/buffering.
         */
        async _drainQuiescent(quietMs, maxMs) {
            const start = Date.now();
            let lastSeq = this._rxSeq;
            let quietSince = Date.now();
            for (;;) {
                await new Promise((r) => setTimeout(r, 50));
                if (this._rxSeq !== lastSeq) {
                    lastSeq = this._rxSeq;
                    quietSince = Date.now();
                }
                if (Date.now() - quietSince >= quietMs)
                    return;
                if (Date.now() - start >= maxMs) {
                    this._log('drainQuiescent: max wait reached with pipe still active');
                    return;
                }
            }
        }
        // ---------------------------------------------------------------------------
        // Stream frame parser (schema-driven; double-preamble resync)
        // ---------------------------------------------------------------------------
        //
        // Minimal v1 parser — the streaming data path is a later phase, but building a
        // working parser here proves the schema and keeps streaming from being
        // precluded. The frame layout (0x00 preamble + timestamp + channels) is
        // identical to Shimmer3R (ShimmerObject#interpretDataPacketFormat), so this
        // follows the same double-preamble sync as Shimmer3RClient.
        _parseStream() {
            if (!this.schema)
                return;
            const sch = this.schema;
            const preamble = sch.dataPreambleByte;
            const frameBytes = sch.frameBytes >>> 0;
            const tsBytes = sch.timestampFmt === 'u16' ? 2 : 3;
            let buf = this._rxBuf;
            while (buf.length >= frameBytes * 2) {
                if (buf[0] === preamble && buf[frameBytes] === preamble) {
                    try {
                        const frame = buf.subarray(0, frameBytes);
                        let cursor = 1;
                        const oc = new ObjectCluster(this._deviceLabel());
                        const ts = tsBytes === 2 ? u16le$3(frame, cursor) : u24le$1(frame, cursor);
                        cursor += tsBytes;
                        oc.add('TIMESTAMP', ts, 'ticks', 'raw');
                        for (const f of sch.fields) {
                            let v;
                            switch (f.fmt) {
                                case 'i16':
                                    v = f.endian === 'be' ? sign16(u16be(frame, cursor)) : sign16(u16le$3(frame, cursor));
                                    break;
                                case 'u16':
                                    v = f.endian === 'be' ? u16be(frame, cursor) : u16le$3(frame, cursor);
                                    break;
                                case 'i24':
                                    v = f.endian === 'be' ? sign24(u24be(frame, cursor)) : sign24(u24le$1(frame, cursor));
                                    break;
                                case 'u24':
                                    v = f.endian === 'be' ? u24be(frame, cursor) : u24le$1(frame, cursor);
                                    break;
                                case 'i12*': {
                                    const raw12 = ((frame[cursor] & 0xff) << 4) | ((frame[cursor + 1] & 0xff) >> 4);
                                    v = raw12 & 0x800 ? raw12 - 0x1000 : raw12;
                                    break;
                                }
                                case 'u8':
                                    v = frame[cursor];
                                    break;
                                default:
                                    v = u16le$3(frame, cursor);
                            }
                            cursor += f.sizeBytes;
                            oc.add(f.name, v, null, 'raw');
                        }
                        this._lastTs = ts;
                        this._calibrateData(oc);
                        this.onStreamFrame?.(oc);
                        buf = buf.subarray(frameBytes);
                    }
                    catch (e) {
                        this._log('frame decode error → sliding 1 byte', e.message);
                        buf = buf.subarray(1);
                    }
                    continue;
                }
                buf = buf.subarray(1); // resync
            }
            this._rxBuf = buf.length ? new Uint8Array(buf) : new Uint8Array(0);
        }
        /** Inline GSR calibration, matching Shimmer3RClient. */
        _calibrateData(oc) {
            for (const field of [...oc.fields]) {
                if (field.name !== GSR_NAME)
                    continue;
                const gsrraw = oc.get(GSR_NAME, 'raw')?.value ?? null;
                if (gsrraw === null)
                    continue;
                let adc12 = gsrraw & 0x0fff;
                let currentRange = this.gsrRangeSetting;
                if (currentRange === 4)
                    currentRange = (gsrraw >> 14) & 0x03;
                if (currentRange === 3 && adc12 < GSR_UNCAL_LIMIT_RANGE3)
                    adc12 = GSR_UNCAL_LIMIT_RANGE3;
                let gsrkOhm = calibrateGsrDataToResistanceFromAmplifierEq(adc12, currentRange);
                gsrkOhm = nudgeGsrResistance(gsrkOhm, this.gsrRangeSetting);
                oc.add(GSR_NAME, (1.0 / gsrkOhm) * 1000, 'uSiemens', 'cal');
            }
            // Inertial calibration (LN/WR accel, gyro, mag): device calibration from
            // readCalibration() when available, else the range-selected default.
            if (this.emitCalibratedInertial) {
                applyStreamingCalibration(oc, {
                    family: this._imuFamily,
                    ranges: this.imuRanges,
                    device: this._deviceCalibrations,
                });
            }
        }
        /**
         * Fetch the device's per-sensor kinematic calibration over RFCOMM and upgrade
         * the active streaming calibration (overriding the range-selected defaults).
         * Opt-in and non-fatal: a group that times out or NACKs keeps its default.
         *
         * Uses the per-sensor GET calibration commands (each answers with
         * `[responseOpcode][21-byte block]`), chosen over the 0x9A GET_CALIB_DUMP
         * because the per-sensor path is unambiguous in the Java oracle.
         *
         * HARDWARE-VERIFY: no real Shimmer3 radio has exercised this path.
         *
         * @returns the groups whose calibration was successfully read.
         */
        async readCalibration(timeoutMs = SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS) {
            if (!this._transport)
                throw new Error('Not connected');
            const plan = [
                {
                    group: 'lnAccel',
                    get: OPCODES.GET_LN_ACCEL_CALIBRATION_COMMAND,
                    resp: OPCODES.LN_ACCEL_CALIBRATION_RESPONSE,
                },
                {
                    group: 'gyro',
                    get: OPCODES.GET_GYRO_CALIBRATION_COMMAND,
                    resp: OPCODES.GYRO_CALIBRATION_RESPONSE,
                },
                {
                    group: 'mag',
                    get: OPCODES.GET_MAG_CALIBRATION_COMMAND,
                    resp: OPCODES.MAG_CALIBRATION_RESPONSE,
                },
                {
                    group: 'wrAccel',
                    get: OPCODES.GET_WR_ACCEL_CALIBRATION_COMMAND,
                    resp: OPCODES.WR_ACCEL_CALIBRATION_RESPONSE,
                },
            ];
            const done = [];
            for (const { group, get, resp } of plan) {
                try {
                    await this._write(new Uint8Array([get]));
                    const rsp = await this._waitForResponse(resp, timeoutMs);
                    if (rsp.length < 22)
                        continue; // opcode + 21-byte block
                    const scale = getGroupDefaults(this._imuFamily, group)?.sensitivityScale ?? 1;
                    const cal = parseKinematicCalibBlock(rsp.subarray(1, 22), { sensitivityScale: scale });
                    if (cal) {
                        this._deviceCalibrations[group] = cal;
                        done.push(group);
                    }
                }
                catch (err) {
                    this._emitStatus(`readCalibration(${group}) skipped: ${err.message}`);
                }
            }
            return done;
        }
        // ---------------------------------------------------------------------------
        // Low-level transport + ACK/response helpers
        // ---------------------------------------------------------------------------
        async _write(u8) {
            if (!this._transport)
                throw new Error('Not connected');
            this._log('Write', u8);
            await this._transport.write(u8);
        }
        async _writeExpectingAck(u8, ackTimeoutMs) {
            await this._write(u8);
            await this._waitForAck(ackTimeoutMs);
        }
        /** Resolve on the next ACK control message; reject on NACK or timeout. */
        _waitForAck(timeoutMs) {
            return new Promise((resolve, reject) => {
                // Mark a command in flight so _drainControl frames NACK (0xFE) only while
                // this window is open; balanced on every settle path below.
                this._awaitCmd += 1;
                const settle = () => {
                    this._awaitCmd = Math.max(0, this._awaitCmd - 1);
                };
                const t = setTimeout(() => {
                    settle();
                    this._offTemp(handler);
                    reject(new Error('ACK timeout'));
                }, timeoutMs);
                const handler = (msg) => {
                    if (msg.length === 0)
                        return;
                    if (msg[0] === ACK) {
                        clearTimeout(t);
                        settle();
                        this._offTemp(handler);
                        resolve();
                    }
                    else if (msg[0] === NACK) {
                        clearTimeout(t);
                        settle();
                        this._offTemp(handler);
                        reject(new Error('NACK received'));
                    }
                };
                this._onTemp(handler);
            });
        }
        /**
         * Resolve on the next control message whose opcode matches `expectedOpcode`.
         * Leading ACKs are ignored (classic firmware may or may not ACK-prefix a
         * response); a NACK rejects.
         */
        _waitForResponse(expectedOpcode, timeoutMs) {
            return new Promise((resolve, reject) => {
                // Track that an INQUIRY_RESPONSE is genuinely awaited so _drainControl
                // only frames 0x02 while this window is open. _awaitCmd (bumped for every
                // command) gates NACK framing the same way.
                if (expectedOpcode === OPCODES.INQUIRY_RESPONSE)
                    this._awaitInq += 1;
                this._awaitCmd += 1;
                const settleInq = () => {
                    if (expectedOpcode === OPCODES.INQUIRY_RESPONSE) {
                        this._awaitInq = Math.max(0, this._awaitInq - 1);
                    }
                    this._awaitCmd = Math.max(0, this._awaitCmd - 1);
                };
                const t = setTimeout(() => {
                    settleInq();
                    this._offTemp(handler);
                    reject(new Error(`Response timeout (opcode 0x${expectedOpcode.toString(16)})`));
                }, timeoutMs);
                const handler = (msg) => {
                    if (msg.length === 0)
                        return;
                    if (msg[0] === ACK)
                        return; // tolerate optional ACK prefix
                    if (msg[0] === NACK) {
                        clearTimeout(t);
                        settleInq();
                        this._offTemp(handler);
                        reject(new Error('NACK received'));
                        return;
                    }
                    if (msg[0] === expectedOpcode) {
                        clearTimeout(t);
                        settleInq();
                        this._offTemp(handler);
                        resolve(msg);
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

    /**
     * InfoMem → {@link InfoMemDeviceConfig} decode.
     *
     * Ported from `ShimmerObject#configBytesParse` (ShimmerObject.java:4931-5111)
     * and `#parseEnabledDerivedSensorsForMaps` (:5113-5149). Pure and byte-exact:
     * offsets come from {@link resolveInfoMemLayout}, field semantics from the Java
     * accessors.
     */
    /**
     * Sampling clock frequency for the InfoMem sampling-rate field. The crystal
     * (non-TCXO) 32768 Hz is used, matching the Java SD-log sampling-rate math
     * (`getSamplingClockFreq()` resolves to the crystal for a fresh parse where the
     * TCXO flag is not yet known). See `ShimmerObject#getSamplingClockFreq`.
     */
    const INFOMEM_SAMPLING_CLOCK_FREQ = 32768;
    const bit = (byte, shift, mask) => (byte >> shift) & mask;
    /** True for a printable ASCII byte (Apache commons `isAsciiPrintable`: [0x20,0x7E]). */
    function isAsciiPrintable(b) {
        return b >= 0x20 && b < 0x7f;
    }
    /** Decode an ASCII name field, stopping at the first non-printable byte. */
    function parseName(bytes, offset, length) {
        let s = '';
        for (let i = 0; i < length; i++) {
            const b = bytes[offset + i];
            if (b === undefined || !isAsciiPrintable(b))
                break;
            s += String.fromCharCode(b);
        }
        return s;
    }
    /** 12-char UPPERCASE hex, in device byte order (UtilShimmer.bytesToHexString). */
    function macToHex(bytes, offset) {
        let s = '';
        for (let i = 0; i < MAC_LENGTH; i++) {
            s += (bytes[offset + i] ?? 0).toString(16).toUpperCase().padStart(2, '0');
        }
        return s;
    }
    /** Parse the enabled + derived sensor bitmaps (parseEnabledDerivedSensorsForMaps). */
    function parseSensors(bytes, layout) {
        let enabled = (bytes[layout.idxSensors0] & 0xff) +
            (bytes[layout.idxSensors1] & 0xff) * 2 ** 8 +
            (bytes[layout.idxSensors2] & 0xff) * 2 ** 16;
        if (layout.supportsMpl) {
            enabled += (bytes[layout.idxSensors3] & 0xff) * 2 ** 24;
            enabled += (bytes[layout.idxSensors4] & 0xff) * 2 ** 32;
        }
        let derived = 0n;
        // Compatible only when the derived offsets are present (>0) and not 0xFF.
        if (layout.idxDerivedSensors0 > 0 &&
            bytes[layout.idxDerivedSensors0] !== MASK.DERIVED_BYTE &&
            layout.idxDerivedSensors1 > 0 &&
            bytes[layout.idxDerivedSensors1] !== MASK.DERIVED_BYTE) {
            derived |= BigInt(bytes[layout.idxDerivedSensors0] & 0xff);
            derived |= BigInt(bytes[layout.idxDerivedSensors1] & 0xff) << 8n;
            if (layout.idxDerivedSensors2 > 0) {
                derived |= BigInt(bytes[layout.idxDerivedSensors2] & 0xff) << 16n;
            }
            if (layout.supportsEightByteDerived) {
                derived |= BigInt(bytes[layout.idxDerivedSensors3] & 0xff) << 24n;
                derived |= BigInt(bytes[layout.idxDerivedSensors4] & 0xff) << 32n;
                derived |= BigInt(bytes[layout.idxDerivedSensors5] & 0xff) << 40n;
                derived |= BigInt(bytes[layout.idxDerivedSensors6] & 0xff) << 48n;
                derived |= BigInt(bytes[layout.idxDerivedSensors7] & 0xff) << 56n;
            }
        }
        return { enabledSensors: enabled, derivedSensors: derived };
    }
    /** A neutral (all-default) config, used for an unconfigured (invalid) InfoMem. */
    function emptyConfig(raw) {
        return {
            samplingRateHz: 0,
            enabledSensors: 0,
            derivedSensors: 0n,
            gsrRange: 0,
            expPowerEnabled: false,
            deviceName: '',
            trialName: '',
            configTime: 0,
            trial: {
                id: 0,
                numShimmers: 0,
                syncWhenLogging: false,
                masterShimmer: false,
                buttonStart: false,
                singleTouch: false,
                tcxo: false,
                disableBluetooth: false,
            },
            btBaudRate: 0,
            macAddress: '',
            exg1: new Uint8Array(EXG_BANK_LENGTH),
            exg2: new Uint8Array(EXG_BANK_LENGTH),
            raw,
            valid: false,
        };
    }
    /**
     * Decode a Shimmer3/3R InfoMem byte array into a {@link InfoMemDeviceConfig}.
     *
     * When the first 6 bytes are all 0xFF the InfoMem is unconfigured: the returned
     * config has `valid = false` and neutral defaults (the Java driver loads
     * defaults in this case), with the raw bytes preserved.
     *
     * @param bytes the full InfoMem (≥ {@link INFOMEM_SIZE} bytes recommended;
     *   shorter input is tolerated but out-of-range fields read as 0).
     * @param ctx   firmware/hardware identity selecting the byte layout.
     */
    function parseInfoMem(bytes, ctx) {
        const raw = new Uint8Array(bytes);
        if (!checkConfigBytesValid(raw)) {
            return emptyConfig(raw);
        }
        const layout = resolveInfoMemLayout(ctx);
        // Sampling rate (LSB-first divider).
        const divider = (raw[layout.idxSamplingRate] & 0xff) + ((raw[layout.idxSamplingRate + 1] & 0xff) << 8);
        const samplingRateHz = divider === 0 ? 0 : INFOMEM_SAMPLING_CLOCK_FREQ / divider;
        const { enabledSensors, derivedSensors } = parseSensors(raw, layout);
        const cfg3 = raw[layout.idxConfigSetupByte3] & 0xff;
        const gsrRange = bit(cfg3, BIT_SHIFT.GSR_RANGE, MASK.GSR_RANGE);
        const expPowerEnabled = bit(cfg3, BIT_SHIFT.EXP_POWER, MASK.EXP_POWER) === 1;
        const exg1 = raw.slice(layout.idxExg1, layout.idxExg1 + EXG_BANK_LENGTH);
        const exg2 = raw.slice(layout.idxExg2, layout.idxExg2 + EXG_BANK_LENGTH);
        const btBaudRate = raw[layout.idxBtCommBaudRate] & 0xff;
        const deviceName = parseName(raw, layout.idxSDShimmerName, NAME_LENGTH);
        const trialName = parseName(raw, layout.idxSDEXPIDName, NAME_LENGTH);
        // Config time (big-endian).
        let configTime = 0;
        for (let x = 0; x < CONFIG_TIME_LENGTH; x++) {
            configTime += (raw[layout.idxSDConfigTime0 + x] & 0xff) * 2 ** CONFIG_TIME_BIT_SHIFTS[x];
        }
        const cfg0 = raw[layout.idxSDExperimentConfig0] & 0xff;
        const cfg1 = raw[layout.idxSDExperimentConfig1] & 0xff;
        // Experiment-config fields gated on firmware family / SD-log-sync support,
        // matching the Java parse guards.
        const buttonStart = layout.isSdLoggingFirmware && bit(cfg0, BIT_SHIFT.BUTTON_START, MASK.ONE_BIT) === 1;
        const disableBluetooth = layout.isSdLoggingFirmware && bit(cfg0, BIT_SHIFT.DISABLE_BLUETOOTH, MASK.ONE_BIT) === 1;
        const tcxo = layout.isSdLoggingFirmware && bit(cfg1, BIT_SHIFT.TCXO, MASK.ONE_BIT) === 1;
        const syncWhenLogging = layout.supportsSdLogSync && bit(cfg0, BIT_SHIFT.SYNC_WHEN_LOGGING, MASK.ONE_BIT) === 1;
        const masterShimmer = layout.supportsSdLogSync && bit(cfg0, BIT_SHIFT.MASTER_SHIMMER, MASK.ONE_BIT) === 1;
        const singleTouch = layout.supportsSdLogSync && bit(cfg1, BIT_SHIFT.SINGLE_TOUCH, MASK.ONE_BIT) === 1;
        const id = layout.supportsSdLogSync ? raw[layout.idxSDMyTrialID] & 0xff : 0;
        const numShimmers = layout.supportsSdLogSync ? raw[layout.idxSDNumOfShimmers] & 0xff : 0;
        const macAddress = macToHex(raw, layout.idxMacAddress);
        return {
            samplingRateHz,
            enabledSensors,
            derivedSensors,
            gsrRange,
            expPowerEnabled,
            deviceName,
            trialName,
            configTime,
            trial: {
                id,
                numShimmers,
                syncWhenLogging,
                masterShimmer,
                buttonStart,
                singleTouch,
                tcxo,
                disableBluetooth,
            },
            btBaudRate,
            macAddress,
            exg1,
            exg2,
            raw,
            valid: true,
        };
    }

    /**
     * {@link InfoMemDeviceConfig} → InfoMem byte array.
     *
     * Ported from `ShimmerObject#configBytesGenerate` (ShimmerObject.java:5162-5380).
     *
     * Byte-layout, endianness and field gating are byte-exact against the Java
     * oracle. One deliberate structural refinement: the Java generate rebuilds the
     * whole InfoMem from scratch (0x00-filled) because a full `ShimmerObject`
     * carries every sub-setting (sensor rates/ranges, calibration blocks, sync-node
     * list) and rewrites them via per-sensor `configBytesGenerate`. This codec
     * intentionally models only the subset in {@link InfoMemDeviceConfig}, so it
     * instead layers the modelled fields over a BASE byte array (read-modify-write),
     * preserving every unmodelled region (sensor rate/range bytes, calibration
     * blocks, sync-node MAC list, showErrorLeds / low-batt bits). This matches the
     * real configure-while-docked flow (read InfoMem → change a field → write back)
     * and the spec requirement that "unknown regions must be preserved from a base
     * byte array".
     *
     * HARDWARE-VERIFY: the device-write finalization — forcing the MAC to all-0xFF
     * (so firmware re-reads it from the BT transceiver) and setting the
     * config-file-creation flag in the config-delay byte (so firmware regenerates
     * its SD config on undock/power-cycle) — is faithfully ported, but whether the
     * device accepts and applies the written InfoMem can only be confirmed on real
     * hardware.
     */
    /** Overwrite a contiguous byte range. */
    function setBytes(out, offset, src) {
        for (let i = 0; i < src.length; i++)
            out[offset + i] = src[i] & 0xff;
    }
    /** Read-modify-write a single bit-field within a byte, preserving other bits. */
    function setBitField(out, offset, shift, mask, value) {
        const cleared = out[offset] & ~(mask << shift) & 0xff;
        out[offset] = (cleared | ((value & mask) << shift)) & 0xff;
    }
    /**
     * Encode a {@link InfoMemDeviceConfig} to a {@link INFOMEM_SIZE}-byte InfoMem
     * array ready to write to the device (128-byte chunks) or store.
     */
    function generateInfoMem(config, ctx, opts = {}) {
        const layout = resolveInfoMemLayout(ctx);
        const out = new Uint8Array(INFOMEM_SIZE); // 0x00-filled
        // Preserve unmodelled regions from the base (or the config's own raw bytes).
        const base = opts.base ?? config.raw;
        if (base && base.length > 0) {
            out.set(base.subarray(0, Math.min(base.length, INFOMEM_SIZE)), 0);
        }
        writeModelledFields(out, config, layout);
        if (opts.forDeviceWrite && layout.isSdLoggingFirmware) {
            applyDeviceWriteFinalization(out, config, layout);
        }
        return out;
    }
    function writeModelledFields(out, config, layout) {
        // Sampling rate (LSB-first divider = round(clock / Hz)).
        const divider = config.samplingRateHz > 0 ? Math.round(INFOMEM_SAMPLING_CLOCK_FREQ / config.samplingRateHz) : 0;
        out[layout.idxSamplingRate] = divider & 0xff;
        out[layout.idxSamplingRate + 1] = (divider >> 8) & 0xff;
        // Buffer size forced to 1 (BtStream rejects InfoMem otherwise) — ShimmerObject.java:5192.
        out[layout.idxBufferSize] = 1;
        // Enabled sensors: bytes 0-2 (bits 0-23). Bytes 3-4 (MPL) are written by the
        // Java per-sensor generate, not the main path, so they are left to base.
        out[layout.idxSensors0] = config.enabledSensors & 0xff;
        out[layout.idxSensors1] = (config.enabledSensors >>> 8) & 0xff;
        out[layout.idxSensors2] = (config.enabledSensors >>> 16) & 0xff;
        // GSR range + expansion-board power (ConfigSetupByte3 bits 1-3 / bit 0),
        // read-modify-write so the byte's other bits (pressure/accel range) survive.
        setBitField(out, layout.idxConfigSetupByte3, BIT_SHIFT.GSR_RANGE, MASK.GSR_RANGE, config.gsrRange);
        setBitField(out, layout.idxConfigSetupByte3, BIT_SHIFT.EXP_POWER, MASK.EXP_POWER, config.expPowerEnabled ? 1 : 0);
        // EXG register banks (10 bytes each).
        setBytes(out, layout.idxExg1, exgBank(config.exg1));
        setBytes(out, layout.idxExg2, exgBank(config.exg2));
        // Bluetooth baud.
        out[layout.idxBtCommBaudRate] = config.btBaudRate & 0xff;
        // Derived sensors (only when the layout has them, matching parse gating).
        if (layout.idxDerivedSensors0 > 0 && layout.idxDerivedSensors1 > 0) {
            const d = config.derivedSensors;
            out[layout.idxDerivedSensors0] = derivedByte(d, 0n);
            out[layout.idxDerivedSensors1] = derivedByte(d, 8n);
            if (layout.idxDerivedSensors2 > 0)
                out[layout.idxDerivedSensors2] = derivedByte(d, 16n);
            if (layout.supportsEightByteDerived) {
                out[layout.idxDerivedSensors3] = derivedByte(d, 24n);
                out[layout.idxDerivedSensors4] = derivedByte(d, 32n);
                out[layout.idxDerivedSensors5] = derivedByte(d, 40n);
                out[layout.idxDerivedSensors6] = derivedByte(d, 48n);
                out[layout.idxDerivedSensors7] = derivedByte(d, 56n);
            }
        }
        // Names: up to 12 ASCII chars, remaining bytes padded 0xFF.
        writeName(out, layout.idxSDShimmerName, config.deviceName);
        writeName(out, layout.idxSDEXPIDName, config.trialName);
        // Config time (big-endian).
        for (let x = 0; x < CONFIG_TIME_LENGTH; x++) {
            out[layout.idxSDConfigTime0 + x] =
                Math.floor(config.configTime / 2 ** CONFIG_TIME_BIT_SHIFTS[x]) & 0xff;
        }
        // Experiment-config bit-fields (read-modify-write, gated like the Java parse/generate).
        const t = config.trial;
        if (layout.isSdLoggingFirmware) {
            setBitField(out, layout.idxSDExperimentConfig0, BIT_SHIFT.BUTTON_START, MASK.ONE_BIT, t.buttonStart ? 1 : 0);
            setBitField(out, layout.idxSDExperimentConfig0, BIT_SHIFT.DISABLE_BLUETOOTH, MASK.ONE_BIT, t.disableBluetooth ? 1 : 0);
            setBitField(out, layout.idxSDExperimentConfig1, BIT_SHIFT.TCXO, MASK.ONE_BIT, t.tcxo ? 1 : 0);
        }
        if (layout.supportsSdLogSync) {
            setBitField(out, layout.idxSDExperimentConfig0, BIT_SHIFT.SYNC_WHEN_LOGGING, MASK.ONE_BIT, t.syncWhenLogging ? 1 : 0);
            setBitField(out, layout.idxSDExperimentConfig0, BIT_SHIFT.MASTER_SHIMMER, MASK.ONE_BIT, t.masterShimmer ? 1 : 0);
            setBitField(out, layout.idxSDExperimentConfig1, BIT_SHIFT.SINGLE_TOUCH, MASK.ONE_BIT, t.singleTouch ? 1 : 0);
            out[layout.idxSDMyTrialID] = t.id & 0xff;
            out[layout.idxSDNumOfShimmers] = t.numShimmers & 0xff;
        }
    }
    /**
     * Device-write finalization (ShimmerObject.java:5320-5339): force the MAC to
     * all-0xFF and set the config-file-creation flag. These are the ONLY bytes that
     * intentionally diverge from a plain round-trip after a device write — see
     * {@link deviceWriteDivergentRanges}.
     */
    function applyDeviceWriteFinalization(out, config, layout) {
        // MAC → invalid (0xFF×6): firmware re-reads it from the BT transceiver.
        for (let i = 0; i < MAC_LENGTH; i++)
            out[layout.idxMacAddress + i] = 0xff;
        // Config-delay byte: set the config-file-write flag bit when requested.
        out[layout.idxSDConfigDelayFlag] = 0;
        // We always request a new SD config on undock (mirrors mConfigFileCreationFlag=true
        // in the desktop write path). HARDWARE-VERIFY: this flag is what makes the FW
        // regenerate its SD config on undock/power-cycle.
        const flag = MASK.SD_CFG_FILE_WRITE_FLAG << BIT_SHIFT.SD_CFG_FILE_WRITE_FLAG;
        out[layout.idxSDConfigDelayFlag] |= flag;
    }
    /**
     * Byte ranges that {@link generateInfoMem} with `forDeviceWrite` intentionally
     * leaves diverged from the input config — used by the write-back verify to
     * exclude them from the byte comparison.
     */
    function deviceWriteDivergentRanges(ctx) {
        const layout = resolveInfoMemLayout(ctx);
        return {
            mac: { start: layout.idxMacAddress, length: MAC_LENGTH },
            configDelayFlag: { start: layout.idxSDConfigDelayFlag, length: 1 },
        };
    }
    function exgBank(bank) {
        if (bank.length === EXG_BANK_LENGTH)
            return bank;
        const b = new Uint8Array(EXG_BANK_LENGTH);
        b.set(bank.subarray(0, EXG_BANK_LENGTH), 0);
        return b;
    }
    function derivedByte(value, shift) {
        return Number((value >> shift) & 0xffn);
    }
    function writeName(out, offset, name) {
        for (let i = 0; i < NAME_LENGTH; i++) {
            out[offset + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0xff;
        }
    }

    // ---------------------------------------------------------------------------
    // WiredShimmerClient
    // ---------------------------------------------------------------------------
    /**
     * Client for a Shimmer sitting in a BasicDock/Base, talking over the dock's
     * FTDI **UART** (host↔device). This is the wired/dock protocol
     * (`com.shimmerresearch.comms.wiredProtocol`), which is entirely separate from
     * the Bluetooth LiteProtocol used by {@link Shimmer3Client} /
     * `Shimmer3RClient` — different framing (`$`-header packets with a component +
     * property address, length, payload and a Shimmer-specific CRC), a different
     * request/response state machine, and a different CRC (`./crc.ts`).
     *
     * Scope (phase D1): identify + status + property-level config for a single
     * docked device. NO mass-storage/SD, NO firmware flashing, NO multi-slot Base
     * state machine (those are later phases). Streaming is not part of the dock
     * protocol.
     *
     * Robustness: the dock UART is an unframed byte stream (serial has no message
     * boundaries), so — exactly like {@link Shimmer3Client} — this client
     * accumulates inbound bytes and extracts complete packets with a length-aware
     * parser ({@link wiredPacketLength}), tolerant of packets split, dribbled or
     * coalesced arbitrarily. A packet whose CRC fails triggers a single-byte
     * resync, matching the Java `parseSinglePacket` recovery path.
     *
     * Transport injection is mandatory — `connect()` with no transport throws.
     *
     * @example
     * ```ts
     * const client = new WiredShimmerClient({ transport: dockSerialTransport });
     * await client.connect();
     * const id = await client.identify();     // { mac, hwVersion, firmwareVersion, expansionBoard }
     * const status = await client.getStatus(); // { voltage, percentage, chargingStatus, ... }
     * const range = await client.getConfig(UART_PROP.GSR.RANGE);
     * await client.setConfig(UART_PROP.GSR.RANGE, new Uint8Array([2]));
     * ```
     */
    class WiredShimmerClient extends BaseShimmerClient {
        constructor(opts = {}) {
            super(opts);
            this._injectedTransport = null;
            this._transport = null;
            this._notifyUnsub = null;
            this._disconnectUnsub = null;
            this._rxBuf = new Uint8Array(0);
            this._temps = new Set();
            /**
             * Serialization queue. Every public command method chains onto this so that
             * only one request/response exchange is in flight at a time — the docked
             * Shimmer speaks a strictly sequential request/response protocol and the
             * Java driver clears pending ACKs before each command
             * (AbstractCommsProtocolWired.java:318,358). Without this, overlapping
             * commands could cross-resolve on the shared temp-handler set (e.g. one
             * command's ACK satisfying another's {@link _waitForAck}), masking a failed
             * write. See {@link _serialize}.
             */
            this._queue = Promise.resolve();
            // Cached device info
            this.identity = null;
            this._handleTransportDisconnect = () => {
                this._emitStatus('Dock disconnected');
            };
            // ---------------------------------------------------------------------------
            // RX: accumulate an unframed byte stream, extract complete packets
            // ---------------------------------------------------------------------------
            this._handleNotify = (chunk) => {
                if (!chunk || chunk.length === 0)
                    return;
                this._log('Notify len=', chunk.length);
                this._rxBuf = concatU8(this._rxBuf, chunk);
                this._drain();
            };
            this._injectedTransport = opts.transport ?? null;
        }
        _log(...args) {
            if (this.debug)
                console.log('[WiredDock]', ...args);
        }
        _deviceLabel() {
            return this._transport?.deviceName ?? 'Shimmer(dock)';
        }
        // ---------------------------------------------------------------------------
        // Connection management
        // ---------------------------------------------------------------------------
        /**
         * Open the dock UART connection. A transport is REQUIRED (constructor option
         * or this parameter). Mirrors `BasicDock#setupDock` (open port); the identify
         * / status reads are exposed as explicit methods rather than run implicitly,
         * so callers control ordering (the Java auto-read order is preserved in
         * {@link identify}).
         */
        async connect(transport) {
            const t = transport ?? this._injectedTransport;
            if (!t) {
                throw new Error('WiredShimmerClient requires an injected transport: a docked Shimmer is only ' +
                    'reachable over the dock UART. Pass a ShimmerTransport via the constructor ' +
                    '({ transport }) or connect(transport).');
            }
            this._transport = t;
            this._notifyUnsub = t.onNotify(this._handleNotify);
            this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);
            this._emitStatus('Opening dock UART connection…');
            await t.connect();
            this._rxBuf = new Uint8Array(0);
            this._emitStatus(`Connected: ${this._deviceLabel()}`);
        }
        async disconnect() {
            try {
                this._notifyUnsub?.();
                this._disconnectUnsub?.();
                await this._transport?.disconnect();
            }
            catch {
                /* ignore */
            }
            finally {
                this._notifyUnsub = this._disconnectUnsub = null;
                this._transport = null;
                this._rxBuf = new Uint8Array(0);
                this._temps.clear();
                this._emitStatus('Disconnected');
            }
        }
        /**
         * Discard any buffered inbound bytes, resyncing the byte stream. Used by
         * {@link SmartDockClient} after a SmartDock slot change: switching the active
         * slot re-routes the per-Shimmer UART to a different device, so any bytes left
         * over from the previous slot must be dropped before the next request. (The
         * `_drain` parser is already tolerant of leading garbage / bad CRC, so this is
         * belt-and-braces rather than strictly required.)
         */
        resyncStream() {
            this._rxBuf = new Uint8Array(0);
        }
        /** Streaming is not part of the dock UART protocol. */
        async startStreaming() {
            throw new Error('Streaming is not supported over the dock UART (use the Bluetooth client).');
        }
        async stopStreaming() {
            /* no-op: the dock protocol has no stream to stop */
        }
        // ---------------------------------------------------------------------------
        // High-level operations
        // ---------------------------------------------------------------------------
        /**
         * Read the docked device's identity. Follows the order of
         * `BasicDock#internalReadShimmerDetails` (MAC → HW/FW version → daughter-card
         * ID). Battery is read separately via {@link getStatus}. The three reads run
         * as one atomic serialized unit (see {@link _serialize}).
         */
        async identify() {
            return this._serialize(() => this._identifyImpl());
        }
        async _identifyImpl() {
            const mac = await this._readMacImpl();
            const firmwareVersion = await this._readVersionImpl();
            const expansionBoard = await this._readExpansionBoardImpl().catch(() => null);
            const id = {
                mac,
                hardwareVersion: firmwareVersion.hardwareVersion,
                firmwareVersion,
                expansionBoard,
            };
            this.identity = id;
            this._emitStatus(`Identified ${mac} HW=${id.hardwareVersion} FW=${firmwareVersion.firmwareVersionMajor}.` +
                `${firmwareVersion.firmwareVersionMinor}.${firmwareVersion.firmwareVersionInternal} ` +
                `(type ${firmwareVersion.firmwareIdentifier})`);
            return id;
        }
        /** Read battery voltage / % / charging state (BAT.VALUE). */
        async getStatus() {
            return this._serialize(() => this._getStatusImpl());
        }
        async _getStatusImpl() {
            const payload = await this._read(UART_PROP.BAT.VALUE);
            const status = parseBatteryStatus(payload);
            this._emitStatus(`Battery ${status.voltage.toFixed(3)} V` +
                (status.percentage !== null ? ` (~${status.percentage.toFixed(0)}%)` : '') +
                ` — ${status.chargingStatus}`);
            return status;
        }
        /**
         * Read the MAC address (MAIN_PROCESSOR.MAC), retrying a total of
         * `WIRED_DEFAULTS.MAC_READ_RETRIES` (= 2) attempts as the Java dock does
         * (`AbstractDock.readMacId`, AbstractDock.java:1153 `for(i=0;i<
         * READ_MAC_RETRY_ATTEMPTS;i++)` → 2 total attempts).
         */
        async readMac() {
            return this._serialize(() => this._readMacImpl());
        }
        async _readMacImpl() {
            let lastErr;
            for (let attempt = 0; attempt < WIRED_DEFAULTS.MAC_READ_RETRIES; attempt++) {
                try {
                    const payload = await this._read(UART_PROP.MAIN_PROCESSOR.MAC);
                    return parseMacId(payload);
                }
                catch (err) {
                    lastErr = err;
                    this._log(`readMac attempt ${attempt + 1} failed: ${err.message}`);
                }
            }
            throw lastErr instanceof Error ? lastErr : new Error('readMac failed');
        }
        /** Read the HW/FW version (MAIN_PROCESSOR.VER). */
        async readVersion() {
            return this._serialize(() => this._readVersionImpl());
        }
        async _readVersionImpl() {
            const payload = await this._read(UART_PROP.MAIN_PROCESSOR.VER);
            return parseVersionInfo(payload);
        }
        /**
         * Read the daughter-card (expansion board) ID — the first 16 bytes of the
         * card memory (`DAUGHTER_CARD.CARD_ID`, address 0). Returns null when no board
         * is fitted. Cheap enough to include in {@link identify}.
         */
        async readExpansionBoard() {
            return this._serialize(() => this._readExpansionBoardImpl());
        }
        async _readExpansionBoardImpl() {
            const payload = await this._readMem(UART_PROP.DAUGHTER_CARD.CARD_ID, 0, 16);
            return parseExpansionBoard(payload);
        }
        /**
         * Read from the daughter-card EEPROM memory (`DAUGHTER_CARD.CARD_MEM`).
         * `address` is a HOST offset — firmware maps it past the first (HW details)
         * EEPROM page, so host offsets 0..2031 cover absolute EEPROM bytes 16..2047.
         */
        async readDaughterCardMem(address, size) {
            if (!Number.isInteger(address) || address < 0 || address > 2031) {
                throw new Error('Daughter-card mem address must be an integer in 0..2031.');
            }
            if (!Number.isInteger(size) || size < 1 || size > 128 || address + size > 2032) {
                throw new Error('Daughter-card mem read must be 1..128 bytes within 0..2031.');
            }
            return this._serialize(() => this._readMem(UART_PROP.DAUGHTER_CARD.CARD_MEM, address, size));
        }
        /**
         * Write to the daughter-card EEPROM memory (`DAUGHTER_CARD.CARD_MEM`).
         * `address` is a HOST offset (see {@link readDaughterCardMem}).
         */
        async writeDaughterCardMem(address, data) {
            if (!Number.isInteger(address) || address < 0 || address > 2031) {
                throw new Error('Daughter-card mem address must be an integer in 0..2031.');
            }
            if (data.length < 1 || data.length > 128 || address + data.length > 2032) {
                throw new Error('Daughter-card mem write must be 1..128 bytes within 0..2031.');
            }
            return this._serialize(async () => {
                const payload = buildMemWritePayload(UART_PROP.DAUGHTER_CARD.CARD_MEM, address, data);
                await this._writeRaw(UART_PROP.DAUGHTER_CARD.CARD_MEM, payload);
                this._emitStatus(`Daughter-card mem write ACKed (${data.length}B @ ${address})`);
            });
        }
        // ---------------------------------------------------------------------------
        // Property-level config
        // ---------------------------------------------------------------------------
        /** Read one config property's raw payload (READ). */
        async getConfig(arg) {
            if (arg.permission === 'WRITE_ONLY') {
                throw new Error(`Property ${arg.name} is write-only`);
            }
            return this._serialize(() => this._read(arg));
        }
        /** Write one config property (WRITE), resolving on ACK. */
        async setConfig(arg, value) {
            if (arg.permission === 'READ_ONLY') {
                throw new Error(`Property ${arg.name} is read-only`);
            }
            return this._serialize(async () => {
                await this._write(arg, value);
                this._emitStatus(`SET ${arg.name} ACKed`);
            });
        }
        /**
         * Read every property in `UART_CONFIG_COMMANDS` (the Java
         * `mListOfUartCommandsConfig` order). Individual reads that error (e.g. a
         * property the docked firmware does not implement) are captured rather than
         * aborting the batch — the returned map's value is the raw payload or the
         * Error for that property.
         */
        async getConfigAll() {
            return this._serialize(() => this._getConfigAllImpl());
        }
        async _getConfigAllImpl() {
            const out = new Map();
            for (const arg of UART_CONFIG_COMMANDS) {
                if (arg.permission === 'WRITE_ONLY')
                    continue;
                try {
                    out.set(arg, await this._read(arg));
                }
                catch (err) {
                    out.set(arg, err instanceof Error ? err : new Error(String(err)));
                }
            }
            return out;
        }
        // ---------------------------------------------------------------------------
        // Low-level InfoMem escape hatch (raw read/write; no layout interpretation)
        // ---------------------------------------------------------------------------
        /**
         * Raw InfoMem read (`MAIN_PROCESSOR.INFOMEM`). Returns `size` bytes from
         * `address`. The InfoMem *layout* is deliberately NOT interpreted in D1 — this
         * is a byte-level escape hatch.
         */
        async readInfoMem(address, size) {
            return this._serialize(() => this._readMem(UART_PROP.MAIN_PROCESSOR.INFOMEM, address, size));
        }
        /** Raw InfoMem write (`MAIN_PROCESSOR.INFOMEM`), resolving on ACK. */
        async writeInfoMem(address, data) {
            return this._serialize(async () => {
                const payload = buildMemWritePayload(UART_PROP.MAIN_PROCESSOR.INFOMEM, address, data);
                await this._writeRaw(UART_PROP.MAIN_PROCESSOR.INFOMEM, payload);
            });
        }
        // ---------------------------------------------------------------------------
        // InfoMem configuration (configure-while-docked, phase P2)
        // ---------------------------------------------------------------------------
        /**
         * Read the full {@link INFOMEM_SIZE}-byte InfoMem in 128-byte page chunks
         * (D → C → B), reassembled in order. The page addresses sent depend on the
         * firmware/hardware (legacy MSP430 0x1800/… vs. flat 0/128/256), resolved
         * from the cached {@link identity} — call {@link identify} (or
         * {@link readVersion}) first.
         */
        async readInfoMemBytes() {
            return this._serialize(() => this._readInfoMemBytesImpl(this._infoMemCtx()));
        }
        /**
         * Write the full {@link INFOMEM_SIZE}-byte InfoMem in 128-byte page chunks,
         * each resolving on its per-chunk ACK (the write guarantee is per-chunk
         * CRC + ACK). Requires a cached {@link identity} for the page addressing.
         */
        async writeInfoMemBytes(bytes) {
            if (bytes.length !== INFOMEM_SIZE) {
                throw new Error(`writeInfoMemBytes expects ${INFOMEM_SIZE} bytes, got ${bytes.length}`);
            }
            return this._serialize(() => this._writeInfoMemBytesImpl(this._infoMemCtx(), bytes));
        }
        /**
         * Read + decode the docked device's configuration. Uses the cached
         * {@link identity} (already-read version info) as the {@link InfoMemContext}.
         */
        async readInfoMemConfig() {
            return this._serialize(async () => {
                const ctx = this._infoMemCtx();
                const bytes = await this._readInfoMemBytesImpl(ctx);
                return parseInfoMem(bytes, ctx);
            });
        }
        /**
         * Write the docked device's real-world clock from a host timestamp
         * (`MAIN_PROCESSOR.RTC_CFG_TIME`), resolving on ACK. Port of
         * `CommsProtocolWiredShimmerViaDock.writeRealWorldClockFromPcTime`
         * (CommsProtocolWiredShimmerViaDock.java:138-153), which calls
         * `writeRealWorldClock(System.currentTimeMillis())`.
         *
         * `nowMs` (UNIX epoch ms) is injectable for testability; it defaults to
         * `Date.now()` — captured at call time, matching the Java's use of the current
         * PC time. The payload is the 8-byte, LSB-first 32.768 kHz tick count
         * ({@link msToRtcBytesLE}).
         *
         * NB the target property is `RTC_CFG_TIME` (0x04) — hardware-confirmed
         * (DEV-866 drift tool bring-up): the firmware's UART_SET handler implements
         * a time write ONLY for this property (RTC_setTimeFromTicksPtr), while a
         * SET on CURR_LOCAL_TIME (0x05) is answered with BAD_CMD. The Java props
         * table's READ_ONLY flag on 0x04 was wrong; the SDK table now says
         * READ_WRITE, matching the firmware.
         */
        async writeRtcFromHostTime(nowMs) {
            return this._serialize(() => this._writeRtcFromHostTimeImpl(nowMs ?? Date.now()));
        }
        /** Non-serialized RTC write — callers must already hold the queue. */
        async _writeRtcFromHostTimeImpl(nowMs) {
            const payload = msToRtcBytesLE(nowMs); // HARDWARE-VERIFY: ms × 32.768 ticks, 8 bytes LSB-first
            await this._write(UART_PROP.MAIN_PROCESSOR.RTC_CFG_TIME, payload);
            this._emitStatus('RTC set from host time');
        }
        /**
         * Encode + write a configuration to the docked device. The MAC is forced to
         * all-0xFF and the config-file-creation flag is set (device-write semantics),
         * so the firmware re-reads its MAC from the BT transceiver and regenerates the
         * SD config on undock/power-cycle.
         *
         * When `opts.setRtc` (default `true`, matching desktop), the device's
         * real-world clock is written FIRST from the host time, then the InfoMem — the
         * exact order of desktop `CallableWriteConfig.call()`
         * (BasicDock.java:1556-1587): (1) RTC write when `isSupportedRtcConfigViaUart`,
         * (2) chunked InfoMem write. The RTC write and InfoMem write are one atomic
         * queued unit. RTC failure ABORTS the config write (the InfoMem write is NOT
         * attempted) — desktop rethrows the RTC `ExecutionException` before reaching
         * the InfoMem write (BasicDock.java:1564-1573), so this is deliberately NOT
         * best-effort. On an identity that does not support RTC-via-UART the RTC write
         * is SKIPPED (not failed), also matching desktop.
         *
         * Finalization (plain config write): there is NO reboot/poll/rewrite here — the
         * device applies the new config and regenerates its SD config file on the next
         * undock / power-cycle. This is identical for Shimmer3 and Shimmer3R. The
         * reboot-then-rewrite dance is a DFU (firmware-update) concern only and is out
         * of scope for a plain config write (BasicDock.java:1556).
         *
         * With `opts.verify`, the InfoMem is read back and byte-compared against the
         * written bytes, EXCLUDING the intentionally-divergent ranges (the MAC bytes,
         * forced to 0xFF, and the config-delay/flag byte). Returns
         * `{ verified: boolean }` when verify was requested, or `{ verified: null }`
         * otherwise.
         *
         * HARDWARE-VERIFY: whether the device accepts and applies the write (and
         * regenerates its SD config on undock) can only be confirmed on real hardware.
         */
        async writeInfoMemConfig(config, opts = {}) {
            return this._serialize(async () => {
                const ctx = this._infoMemCtx();
                // (1) RTC write first, exactly as desktop CallableWriteConfig orders it.
                //     Skipped (not failed) on unsupported identities; a failure here aborts
                //     before the InfoMem write, matching the Java rethrow semantics.
                const setRtc = opts.setRtc ?? true;
                if (setRtc && isSupportedRtcConfigViaUart(ctx.hardwareVersion, ctx.firmwareId)) {
                    await this._writeRtcFromHostTimeImpl(Date.now());
                }
                // (2) chunked InfoMem write.
                const bytes = generateInfoMem(config, ctx, { base: config.raw, forDeviceWrite: true });
                await this._writeInfoMemBytesImpl(ctx, bytes);
                if (!opts.verify)
                    return { verified: null };
                const readback = await this._readInfoMemBytesImpl(ctx);
                const verified = compareInfoMemExcluding(bytes, readback, deviceWriteDivergentRanges(ctx));
                return { verified };
            });
        }
        /** Build the InfoMem layout context from the cached identity (requires identify/readVersion). */
        _infoMemCtx() {
            const id = this.identity;
            if (!id) {
                throw new Error('InfoMem operations need the device version: call identify() (or readVersion()) first.');
            }
            const fv = id.firmwareVersion;
            return {
                hardwareVersion: id.hardwareVersion,
                firmwareId: fv.firmwareIdentifier,
                firmwareVersion: {
                    major: fv.firmwareVersionMajor,
                    minor: fv.firmwareVersionMinor,
                    internal: fv.firmwareVersionInternal,
                },
            };
        }
        /** Non-serialized chunked read (D/C/B pages) — callers must already hold the queue. */
        async _readInfoMemBytesImpl(ctx) {
            const layout = resolveInfoMemLayout(ctx);
            const pageAddrs = [layout.addrD, layout.addrC, layout.addrB];
            const out = new Uint8Array(INFOMEM_SIZE);
            for (let i = 0; i < pageAddrs.length; i++) {
                const chunk = await this._readMem(UART_PROP.MAIN_PROCESSOR.INFOMEM, pageAddrs[i], INFOMEM_PAGE_SIZE);
                if (chunk.length < INFOMEM_PAGE_SIZE) {
                    throw new Error(`InfoMem page ${i} short read: expected ${INFOMEM_PAGE_SIZE} bytes, got ${chunk.length}`);
                }
                out.set(chunk.subarray(0, INFOMEM_PAGE_SIZE), i * INFOMEM_PAGE_SIZE);
            }
            return out;
        }
        /** Non-serialized chunked write (D/C/B pages) — callers must already hold the queue. */
        async _writeInfoMemBytesImpl(ctx, bytes) {
            const layout = resolveInfoMemLayout(ctx);
            const pageAddrs = [layout.addrD, layout.addrC, layout.addrB];
            for (let i = 0; i < pageAddrs.length; i++) {
                const page = bytes.subarray(i * INFOMEM_PAGE_SIZE, (i + 1) * INFOMEM_PAGE_SIZE);
                const payload = buildMemWritePayload(UART_PROP.MAIN_PROCESSOR.INFOMEM, pageAddrs[i], page);
                await this._writeRaw(UART_PROP.MAIN_PROCESSOR.INFOMEM, payload);
            }
        }
        // ---------------------------------------------------------------------------
        // Serialization
        // ---------------------------------------------------------------------------
        /**
         * Run `fn` after every previously-queued operation has settled, so all public
         * command methods execute strictly one-at-a-time (see {@link _queue}). The
         * queue itself never rejects — a failed op does not poison later ones — while
         * the caller still receives `fn`'s own resolution/rejection.
         */
        _serialize(fn) {
            const run = this._queue.then(() => fn());
            this._queue = run.then(() => undefined, () => undefined);
            return run;
        }
        // ---------------------------------------------------------------------------
        // Request/response core
        // ---------------------------------------------------------------------------
        /** Send a READ and await the matching DATA_RESPONSE payload. */
        async _read(arg, timeoutMs = WIRED_DEFAULTS.RESPONSE_TIMEOUT_MS) {
            if (!this._transport)
                throw new Error('Not connected');
            await this._transport.write(buildReadPacket(arg));
            return this._waitForDataResponse(arg, timeoutMs);
        }
        /** Send a memory READ and await the matching DATA_RESPONSE payload. */
        async _readMem(arg, address, size, timeoutMs = WIRED_DEFAULTS.RESPONSE_TIMEOUT_MS) {
            if (!this._transport)
                throw new Error('Not connected');
            const payload = buildMemReadPayload(arg, address, size);
            await this._transport.write(buildUartPacket(UART_PACKET_CMD.READ, arg, payload));
            return this._waitForDataResponse(arg, timeoutMs);
        }
        /** Send a WRITE with a value and await ACK. */
        async _write(arg, value, timeoutMs = WIRED_DEFAULTS.RESPONSE_TIMEOUT_MS) {
            if (!this._transport)
                throw new Error('Not connected');
            await this._transport.write(buildWritePacket(arg, value));
            await this._waitForAck(timeoutMs);
        }
        /** Send a WRITE with a pre-built payload (e.g. mem write) and await ACK. */
        async _writeRaw(arg, payload, timeoutMs = WIRED_DEFAULTS.RESPONSE_TIMEOUT_MS) {
            if (!this._transport)
                throw new Error('Not connected');
            await this._transport.write(buildUartPacket(UART_PACKET_CMD.WRITE, arg, payload));
            await this._waitForAck(timeoutMs);
        }
        /** Resolve with the payload of a DATA_RESPONSE matching comp+prop; reject on bad/timeout. */
        _waitForDataResponse(arg, timeoutMs) {
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => {
                    this._offTemp(handler);
                    reject(new Error(`Response timeout (READ ${arg.name})`));
                }, timeoutMs);
                const handler = (pkt) => {
                    if (isBadResponse(pkt.command)) {
                        clearTimeout(t);
                        this._offTemp(handler);
                        reject(new Error(`Device error: ${badResponseReason(pkt.command)} (READ ${arg.name})`));
                        return;
                    }
                    if (pkt.command === UART_PACKET_CMD.DATA_RESPONSE &&
                        pkt.component === arg.component &&
                        pkt.property === arg.property) {
                        clearTimeout(t);
                        this._offTemp(handler);
                        resolve(pkt.payload);
                    }
                };
                this._onTemp(handler);
            });
        }
        /** Resolve on the next ACK; reject on bad response or timeout. */
        _waitForAck(timeoutMs) {
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => {
                    this._offTemp(handler);
                    reject(new Error('ACK timeout'));
                }, timeoutMs);
                const handler = (pkt) => {
                    if (pkt.command === UART_PACKET_CMD.ACK_RESPONSE) {
                        clearTimeout(t);
                        this._offTemp(handler);
                        resolve();
                    }
                    else if (isBadResponse(pkt.command)) {
                        clearTimeout(t);
                        this._offTemp(handler);
                        reject(new Error(`Device error: ${badResponseReason(pkt.command)}`));
                    }
                };
                this._onTemp(handler);
            });
        }
        /**
         * Extract every complete packet currently buffered and dispatch each to the
         * temp handlers, keeping the incomplete tail for the next chunk. A packet
         * whose CRC fails is dropped one byte at a time to resync (matching the Java
         * `parseSinglePacket` CRC-fail path).
         */
        _drain() {
            let buf = this._rxBuf;
            for (;;) {
                if (buf.length === 0)
                    break;
                const len = wiredPacketLength(buf);
                if (len === NEED_MORE$2)
                    break;
                if (len === RESYNC$2) {
                    this._log(`resync: dropping byte 0x${buf[0].toString(16)}`);
                    buf = buf.subarray(1);
                    continue;
                }
                if (buf.length < len)
                    break; // full packet not here yet
                let pkt;
                try {
                    pkt = parseUartPacket(buf);
                }
                catch {
                    buf = buf.subarray(1); // malformed — resync
                    continue;
                }
                if (!pkt.crcOk) {
                    this._log('bad CRC → dropping 1 byte to resync');
                    buf = buf.subarray(1);
                    continue;
                }
                this._emitTemp(pkt);
                buf = buf.subarray(pkt.length);
            }
            this._rxBuf = buf.length ? new Uint8Array(buf) : new Uint8Array(0);
        }
        _onTemp(fn) {
            this._temps.add(fn);
        }
        _offTemp(fn) {
            this._temps.delete(fn);
        }
        _emitTemp(pkt) {
            this._temps.forEach((fn) => {
                try {
                    fn(pkt);
                }
                catch (e) {
                    this._log('temp handler error', e);
                }
            });
        }
    }
    /**
     * Byte-compare `written` against `readback` over the full InfoMem, ignoring the
     * ranges that a device write intentionally leaves diverged (the MAC bytes,
     * forced to 0xFF, and the config-delay/flag byte the firmware may rewrite).
     */
    function compareInfoMemExcluding(written, readback, ranges) {
        if (written.length !== readback.length)
            return false;
        const excluded = new Set();
        for (const r of [ranges.mac, ranges.configDelayFlag]) {
            for (let i = 0; i < r.length; i++)
                excluded.add(r.start + i);
        }
        for (let i = 0; i < written.length; i++) {
            if (excluded.has(i))
                continue;
            if (written[i] !== readback[i])
                return false;
        }
        return true;
    }

    /**
     * Pure codec for the Shimmer **SmartDock** (Base-6 / Base-15) multi-slot base
     * command layer.
     *
     * This is the *base-level* protocol a SmartDock speaks over its FTDI UART — it
     * is entirely distinct from the per-Shimmer binary `$`-header UART protocol in
     * `./protocol.ts` (D1). The base commands are short **ASCII** strings
     * terminated with `$`; the base replies with `\r\n`-terminated ASCII lines. The
     * SmartDock switches which physical slot (docked Shimmer) is routed onto the
     * *separate* per-Shimmer UART channel, so multi-slot support is: drive these
     * ASCII base commands to enumerate/select a slot, then speak the D1 binary
     * protocol to the now-active slot.
     *
     * Ported from the Java driver (read-only oracle):
     *   com.shimmerresearch.managers.dockManager.SmartDockUart
     *     (SmartDockUart.java:44-65   — BASE_CMD ASCII command strings)
     *     (SmartDockUart.java:194-242 — set active slot / connection type)
     *     (SmartDockUart.java:793-869 — version / active-slot response parse)
     *   com.shimmerresearch.managers.dockManager.SmartDockUartListener
     *     (SmartDockUartListener.java:62-296 — `\r\n` line framing + response
     *      classification by leading char; the `Q,<map>` / `V,...` / `P,NN` shapes)
     *   com.shimmerresearch.comms.wiredProtocol.SmartDockActiveSlotDetails
     *     (SmartDockActiveSlotDetails.java:13-26 — connection types)
     *   com.shimmerresearch.managers.dockManager.SmartDockVerInfoDetails
     *     (SmartDockVerInfoDetails.java:11-31 — HW/FW version fields)
     *   com.shimmerresearch.driverUtilities.HwDriverShimmerDeviceDetails
     *     (HwDriverShimmerDeviceDetails.java:248-250 BASE_HARDWARE_IDS; :313-321
     *      slot counts BASE15→15, BASE6→6)
     *
     * Everything here is side-effect-free so it can be unit-tested with fixtures and
     * reused by {@link SmartDockClient} regardless of the byte pipe underneath.
     */
    /** ASCII carriage-return + line-feed — every base response line ends with this. */
    const SMARTDOCK_LINE_TERMINATOR = '\r\n';
    /**
     * SmartDock connection type for a slot select (SmartDockActiveSlotDetails.java:13-15).
     * D2 is read-only and only ever uses `WITHOUT_SD_CARD` (partial connect, enough
     * to read the docked Shimmer over the per-Shimmer UART); `WITH_SD_CARD` (full
     * connect for mass-storage) is defined for completeness but NOT driven.
     */
    const SMARTDOCK_CONNECTION_TYPE = Object.freeze({
        DISCONNECTED: 0,
        WITH_SD_CARD: 1,
        WITHOUT_SD_CARD: 2,
    });
    /**
     * SmartDock base ASCII commands (SmartDockUart.java:44-65). Each is sent as-is
     * over the base UART; a `$` terminates the command. Slot-select commands append
     * `,NN$` (two-digit zero-padded slot, `%02d`, SmartDockUart.java:231).
     *
     * Only the READ-ONLY subset needed for D2 (version, occupancy query, slot
     * select without SD, disconnect) is surfaced as a driven command; the BSL-mask
     * / GPIO / reset / indicator-LED commands in the Java table are deliberately
     * omitted (out of scope, and several are write/flash-adjacent).
     */
    const SMARTDOCK_BASE_CMD = Object.freeze({
        /** `SDV$` → version info. */
        GET_VERSION: 'SDV$',
        /** `SDQ$` → per-slot occupancy bitmap. */
        QUERY_CONNECTED_SLOTS: 'SDQ$',
        /** `SDP$` → current active slot (without-SD form). */
        GET_ACTIVE_SLOT: 'SDP$',
        /** `SDP` prefix → set active slot WITHOUT SD access (append `,NN$`). */
        SET_SLOT_WITHOUT_SD: 'SDP',
        /** `SDC` prefix → set active slot WITH SD access (append `,NN$`). Not driven in D2. */
        SET_SLOT_WITH_SD: 'SDC',
        /** `SDD$` → disconnect all slots. */
        DISCONNECT_ALL: 'SDD$',
    });
    /**
     * SmartDock request/response timing, ported from
     * com.shimmerresearch.managers.dockManager.SmartDock (SmartDock.java):
     * - `SMARTDOCK_RESPONSE_TIMEOUT` = 1000 ms (:66) — normal base command reply.
     * - `SMARTDOCK_RESPONSE_TIMEOUT_SLOT_CHANGE` = 10000 ms (:67) — slot switch.
     * and com.shimmerresearch.managers.dockManager.AbstractDock:
     * - `SLOT_CHANGEOVER_DELAY_WITHOUT_SD_CARD` = 1500 ms (AbstractDock.java:96) —
     *   settle delay after a without-SD slot change before talking to the Shimmer.
     * - `CMD_RETRY_ATTEMPTS` = 2 (SmartDockUart.java:30).
     */
    const SMARTDOCK_DEFAULTS = Object.freeze({
        RESPONSE_TIMEOUT_MS: 1000,
        SLOT_CHANGE_TIMEOUT_MS: 10000,
        SLOT_CHANGEOVER_DELAY_MS: 1500,
        CMD_RETRY_ATTEMPTS: 2,
    });
    /**
     * Base hardware IDs from the version response's hardware-version field
     * (HwDriverShimmerDeviceDetails.java:248-250 `BASE_HARDWARE_IDS`).
     */
    const BASE_HARDWARE_IDS = Object.freeze({
        BASE15U: 1,
        BASE6U: 2,
    });
    /**
     * Map a base hardware-version byte to a family + slot count
     * (HwDriverShimmerDeviceDetails.java:313-321: BASE15→15 slots, BASE6→6 slots,
     * BASICDOCK→1). NB: in the Java driver the slot count actually comes from the
     * USB device descriptor, not the version byte — see the SmartDock README
     * hardware-verify note.
     */
    function baseHardwareType(hardwareVersion) {
        switch (hardwareVersion) {
            case BASE_HARDWARE_IDS.BASE15U:
                return { hardwareType: 'base15', slotCount: 15 };
            case BASE_HARDWARE_IDS.BASE6U:
                return { hardwareType: 'base6', slotCount: 6 };
            default:
                return { hardwareType: 'unknown', slotCount: 0 };
        }
    }
    // ---------------------------------------------------------------------------
    // TX — command assembly
    // ---------------------------------------------------------------------------
    const ASCII = new TextEncoder();
    /** Encode a base ASCII command string to bytes (UTF-8 == ASCII for this set). */
    function buildBaseCommand(cmd) {
        return ASCII.encode(cmd);
    }
    /**
     * Build a slot-select command: `SDP,NN$` (without SD) or `SDC,NN$` (with SD),
     * or `SDD$` (disconnect all). Slot is formatted `%02d`
     * (SmartDockUart.java:194-231). Slot values 1..15 (1-based, matching the UI /
     * the Java `SmartDockActiveSlotDetails.mSlot`).
     */
    function buildSelectSlotCommand(slot, connectionType) {
        if (connectionType === SMARTDOCK_CONNECTION_TYPE.DISCONNECTED) {
            return buildBaseCommand(SMARTDOCK_BASE_CMD.DISCONNECT_ALL);
        }
        const prefix = connectionType === SMARTDOCK_CONNECTION_TYPE.WITH_SD_CARD
            ? SMARTDOCK_BASE_CMD.SET_SLOT_WITH_SD
            : SMARTDOCK_BASE_CMD.SET_SLOT_WITHOUT_SD;
        const nn = String(slot).padStart(2, '0');
        return buildBaseCommand(`${prefix},${nn}$`);
    }
    // ---------------------------------------------------------------------------
    // RX — `\r\n` line framing over the unframed serial byte stream
    // ---------------------------------------------------------------------------
    const ASCII_DECODER = new TextDecoder('utf-8', { fatal: false });
    /**
     * Extract the first complete `\r\n`-terminated line from an accumulated ASCII
     * buffer, returning the line (WITHOUT the terminator) and the remaining bytes,
     * or null when no complete line is buffered yet.
     *
     * This is the base-channel analogue of the D1 `wiredPacketLength` framing: the
     * SmartDock UART is an unframed serial byte stream, so the client accumulates
     * inbound bytes and pulls out whole lines. Mirrors the `indexOf("\r\n")` split
     * in SmartDockUartListener.java:62-67.
     */
    function extractBaseLine(buf) {
        // Find CR LF (0x0d 0x0a).
        for (let i = 0; i + 1 < buf.length; i++) {
            if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
                const line = ASCII_DECODER.decode(buf.subarray(0, i));
                const rest = buf.subarray(i + 2);
                return { line, rest: rest.length ? new Uint8Array(rest) : new Uint8Array(0) };
            }
        }
        return null;
    }
    /**
     * Classify a base response line by its leading character
     * (SmartDockUartListener.java:71-296). Used to route a line to the awaiting
     * operation and to discard unrelated / garbage lines (resync discipline).
     */
    function classifyBaseResponse(line) {
        if (line.length === 0)
            return 'unknown';
        if (line === 'E')
            return 'error';
        const c = line.charAt(0);
        const hasComma = line.charAt(1) === ',';
        if (c === 'V' && hasComma)
            return 'version';
        if (c === 'Q' && hasComma)
            return 'occupancy';
        if (c === 'S' && hasComma)
            return 'occupancy'; // auto-notify slot map, same shape
        if (c === 'P' && hasComma)
            return 'slotWithoutSd';
        if (c === 'C' && hasComma)
            return 'slotWithSd';
        if (c === 'C' || c === 'D')
            return 'disconnected';
        if (line.includes('Shimmer SmartDock Initialised'))
            return 'boot';
        return 'unknown';
    }
    /**
     * Parse a `V,<hw>,<fwId>,<major>,<minor>,<internal>` version line
     * (SmartDockUart.java:796-806). Returns null when malformed (wrong prefix or not
     * exactly 5 comma-separated integers after `V,`).
     */
    function parseSmartDockVersion(line) {
        if (classifyBaseResponse(line) !== 'version')
            return null;
        const parts = line.slice(2).split(',');
        if (parts.length !== 5)
            return null;
        const nums = parts.map((p) => Number.parseInt(p, 10));
        if (nums.some((n) => Number.isNaN(n)))
            return null;
        return {
            hardwareVersion: nums[0],
            firmwareIdentifier: nums[1],
            firmwareVersionMajor: nums[2],
            firmwareVersionMinor: nums[3],
            firmwareVersionInternal: nums[4],
        };
    }
    /**
     * Parse a slot-occupancy line `Q,<map>` (or auto-notify `S,<map>`) into a
     * per-slot boolean array (SmartDockUartListener.java:140-181). Each map char is
     * ASCII `'0'`/`'1'`; index 0 → slot 1, etc. The map length is the base's slot
     * count. Returns null when malformed.
     *
     * NB: the Java `remapSlotsSmartDockToUi` remap for the BASE15U *prototype*
     * board (firmware 1.0.0.≤5) is deliberately NOT applied here — it only affects
     * pre-production hardware; see the README hardware-verify note.
     */
    function parseSlotOccupancy(line) {
        if (classifyBaseResponse(line) !== 'occupancy')
            return null;
        const map = line.slice(2);
        if (map.length === 0)
            return null;
        const out = [];
        for (const ch of map) {
            if (ch !== '0' && ch !== '1')
                return null;
            out.push(ch === '1');
        }
        return out;
    }
    /**
     * Parse an active-slot response line into slot + connection type
     * (SmartDockUart.java:810-869):
     * - `P,NN` → WITHOUT_SD, slot NN
     * - `C,NN` → WITH_SD, slot NN
     * - `C` / `D` → DISCONNECTED, slot -1
     * Returns null when the numeric slot is malformed.
     */
    function parseActiveSlot(line) {
        const kind = classifyBaseResponse(line);
        if (kind === 'disconnected') {
            return { slot: -1, connectionType: SMARTDOCK_CONNECTION_TYPE.DISCONNECTED };
        }
        if (kind === 'slotWithoutSd' || kind === 'slotWithSd') {
            const slotStr = line.slice(2);
            if (!/^\d+$/.test(slotStr))
                return null;
            return {
                slot: Number.parseInt(slotStr, 10),
                connectionType: kind === 'slotWithSd'
                    ? SMARTDOCK_CONNECTION_TYPE.WITH_SD_CARD
                    : SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD,
            };
        }
        return null;
    }

    /**
     * Thrown by {@link SmartDockClient} when a base command reply does not arrive
     * within the timeout. Distinguished from an explicit `E` error response so the
     * retry logic re-sends on timeout only (SmartDockUart.java:526-537: a timeout
     * from `waitForSmartDockResponse` triggers a re-send, whereas an error response
     * throws immediately).
     */
    class SmartDockTimeoutError extends Error {
        constructor(message) {
            super(message);
            this.name = 'SmartDockTimeoutError';
        }
    }
    // ---------------------------------------------------------------------------
    // SmartDockClient
    // ---------------------------------------------------------------------------
    /**
     * Client for a **SmartDock** multi-slot base (Base-6 / Base-15) — phase **D2**
     * of dock support, building on D1's single-device {@link WiredShimmerClient}.
     *
     * A SmartDock exposes two logical channels over (two) FTDI serial ports:
     *   1. a **base control** channel speaking short ASCII `SDx$` commands (this
     *      client), used to read the base version, query per-slot occupancy, and
     *      switch which slot is *active*; and
     *   2. a **per-Shimmer** UART channel onto which the base routes the active
     *      slot, spoken with the D1 binary `$`-header protocol.
     *
     * Multi-slot support is therefore: select a slot on the base channel, then talk
     * to the docked Shimmer on the per-Shimmer channel. This client **composes**
     * (does not duplicate) {@link WiredShimmerClient} for the per-Shimmer half —
     * see {@link identifyDockedShimmer} / {@link getDockedShimmerStatus}.
     *
     * Scope (D2): **READ-ONLY**. Dock info, occupancy, slot select, and per-slot
     * identify/status. NO config writes, NO SD/mass-storage (the `SDC` with-SD
     * connect and `getSDMountDelay` path exist in the Java oracle but are not
     * driven), NO bootloader/flashing.
     *
     * Robustness: the base UART is an unframed byte stream, so — like D1 — this
     * client accumulates inbound bytes and extracts complete `\r\n`-terminated
     * lines ({@link extractBaseLine}); unrecognised / partial lines are ignored,
     * which naturally resyncs after garbage. Per-op timeouts are ported from Java
     * (normal 1000 ms; slot change 10000 ms).
     *
     * Transport injection is mandatory — `connect()` with no base transport throws.
     *
     * @example
     * ```ts
     * const dock = new SmartDockClient({ transport: baseSerial, shimmerTransport: shimmerSerial });
     * await dock.connect();
     * const info = await dock.getDockInfo();       // { hardwareType, firmwareVersion, slotCount }
     * const slots = await dock.getSlotOccupancy(); // [{ slot: 1, occupied: true }, ...]
     * const id = await dock.identifyDockedShimmer(1);   // selects slot 1, then D1 identify()
     * const st = await dock.getDockedShimmerStatus(1);  // selects slot 1, then D1 getStatus()
     * ```
     */
    class SmartDockClient extends BaseShimmerClient {
        constructor(opts = {}) {
            super(opts);
            this._injectedTransport = null;
            this._transport = null;
            this._notifyUnsub = null;
            this._disconnectUnsub = null;
            this._rxBuf = new Uint8Array(0);
            this._temps = new Set();
            /**
             * Serialization queue: all public operations chain onto this so slot
             * select + per-slot reads run as atomic, non-interleaved units. Concurrent
             * `selectSlot` / `identifyDockedShimmer` / `getDockedShimmerStatus` otherwise
             * race on the shared {@link activeSlot} and single {@link _wired} client,
             * mis-attributing one slot's data to another. See {@link _serialize}.
             */
            this._queue = Promise.resolve();
            this._wired = null;
            this._wiredConnected = false;
            /** Cached dock info (from the last {@link getDockInfo}). */
            this.dockInfo = null;
            /** The last active slot confirmed by {@link selectSlot} (1-based; -1 when disconnected). */
            this.activeSlot = -1;
            this._handleTransportDisconnect = () => {
                this._emitStatus('SmartDock disconnected');
            };
            // ---------------------------------------------------------------------------
            // RX: accumulate the unframed byte stream, extract complete `\r\n` lines
            // ---------------------------------------------------------------------------
            this._handleNotify = (chunk) => {
                if (!chunk || chunk.length === 0)
                    return;
                this._log('Notify len=', chunk.length);
                this._rxBuf = concatU8(this._rxBuf, chunk);
                this._drain();
            };
            this._injectedTransport = opts.transport ?? null;
            this._shimmerTransport = opts.shimmerTransport ?? null;
            this._responseTimeoutMs =
                opts.timeouts?.responseTimeoutMs ?? SMARTDOCK_DEFAULTS.RESPONSE_TIMEOUT_MS;
            this._slotChangeTimeoutMs =
                opts.timeouts?.slotChangeTimeoutMs ?? SMARTDOCK_DEFAULTS.SLOT_CHANGE_TIMEOUT_MS;
            this._slotChangeoverDelayMs =
                opts.timeouts?.slotChangeoverDelayMs ?? SMARTDOCK_DEFAULTS.SLOT_CHANGEOVER_DELAY_MS;
        }
        _log(...args) {
            if (this.debug)
                console.log('[SmartDock]', ...args);
        }
        _deviceLabel() {
            return this._transport?.deviceName ?? 'SmartDock';
        }
        // ---------------------------------------------------------------------------
        // Connection management
        // ---------------------------------------------------------------------------
        /**
         * Open the SmartDock base UART connection. A base transport is REQUIRED
         * (constructor option or this parameter). The per-Shimmer transport (if
         * supplied) is opened lazily on the first docked-Shimmer op.
         */
        async connect(transport) {
            const t = transport ?? this._injectedTransport;
            if (!t) {
                throw new Error('SmartDockClient requires an injected transport: a SmartDock is only reachable ' +
                    'over the base UART. Pass a ShimmerTransport via the constructor ({ transport }) ' +
                    'or connect(transport).');
            }
            this._transport = t;
            this._notifyUnsub = t.onNotify(this._handleNotify);
            this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);
            this._emitStatus('Opening SmartDock base UART connection…');
            await t.connect();
            this._rxBuf = new Uint8Array(0);
            this._emitStatus(`Connected: ${this._deviceLabel()}`);
        }
        async disconnect() {
            try {
                if (this._wired && this._wiredConnected) {
                    await this._wired.disconnect().catch(() => undefined);
                }
                this._notifyUnsub?.();
                this._disconnectUnsub?.();
                await this._transport?.disconnect();
            }
            catch {
                /* ignore */
            }
            finally {
                this._wiredConnected = false;
                this._wired = null;
                this._notifyUnsub = this._disconnectUnsub = null;
                this._transport = null;
                this._rxBuf = new Uint8Array(0);
                this._temps.clear();
                this._emitStatus('Disconnected');
            }
        }
        /** Streaming is not part of the SmartDock protocol. */
        async startStreaming() {
            throw new Error('Streaming is not supported over the SmartDock UART.');
        }
        async stopStreaming() {
            /* no-op */
        }
        // ---------------------------------------------------------------------------
        // High-level base operations
        // ---------------------------------------------------------------------------
        /**
         * Read the base HW/FW version and derive its family + slot count. Sends
         * `SDV$` and parses the `V,<hw>,<fwId>,<major>,<minor>,<internal>` reply
         * (SmartDockUart.java:148-157, :796-806).
         */
        async getDockInfo() {
            return this._serialize(() => this._getDockInfoImpl());
        }
        async _getDockInfoImpl() {
            const line = await this._command(SMARTDOCK_BASE_CMD.GET_VERSION, 'version', this._responseTimeoutMs);
            const firmwareVersion = parseSmartDockVersion(line);
            if (!firmwareVersion)
                throw new Error(`Malformed SmartDock version response: "${line}"`);
            const { hardwareType, slotCount } = baseHardwareType(firmwareVersion.hardwareVersion);
            const info = { hardwareType, firmwareVersion, slotCount };
            this.dockInfo = info;
            this._emitStatus(`SmartDock ${hardwareType} (${slotCount} slots) FW ${firmwareVersion.firmwareVersionMajor}.` +
                `${firmwareVersion.firmwareVersionMinor}.${firmwareVersion.firmwareVersionInternal}`);
            return info;
        }
        /**
         * Query which slots are occupied. Sends `SDQ$` and parses the
         * `Q,<map>` bitmap (one ASCII `0`/`1` per slot) into per-slot occupancy
         * (SmartDockUart.java:162-171, SmartDockUartListener.java:140-181). The number
         * of entries is the base's slot count as reported on the wire.
         */
        async getSlotOccupancy() {
            return this._serialize(() => this._getSlotOccupancyImpl());
        }
        async _getSlotOccupancyImpl() {
            const line = await this._command(SMARTDOCK_BASE_CMD.QUERY_CONNECTED_SLOTS, 'occupancy', this._responseTimeoutMs);
            const map = parseSlotOccupancy(line);
            if (!map)
                throw new Error(`Malformed SmartDock occupancy response: "${line}"`);
            return map.map((occupied, i) => ({ slot: i + 1, occupied }));
        }
        /**
         * Select the active slot (WITHOUT SD access — the read path). Sends
         * `SDP,NN$`, awaits the `P,NN` confirmation with the ported ~10 s slot-change
         * timeout, verifies the returned slot matches the request (Java throws
         * `DOCK_CMD_ERR_FAIL_SET` on mismatch, SmartDockUart.java:233-241), then waits
         * the ported settle delay (1500 ms) before the per-Shimmer UART is usable
         * (SmartDock.java:674-691). Finally resyncs the per-Shimmer byte stream (the
         * slot re-route may leave stale bytes) — reusing D1's
         * {@link WiredShimmerClient.resyncStream}.
         *
         * @param slotNumber 1-based slot (1..slotCount).
         */
        async selectSlot(slotNumber) {
            return this._serialize(() => this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD));
        }
        /** Disconnect all slots (`SDD$`); no slot is active afterwards. */
        async disconnectAllSlots() {
            return this._serialize(() => this._disconnectAllSlotsImpl());
        }
        async _disconnectAllSlotsImpl() {
            await this._command(SMARTDOCK_BASE_CMD.DISCONNECT_ALL, 'disconnected', this._slotChangeTimeoutMs);
            this.activeSlot = -1;
            this._emitStatus('All slots disconnected');
        }
        async _selectSlotInternal(slotNumber, connectionType) {
            if (!this._transport)
                throw new Error('Not connected');
            const cmd = buildSelectSlotCommand(slotNumber, connectionType);
            // The reply is `P,NN` (without SD) or `C,NN` (with SD).
            const wantKind = connectionType === SMARTDOCK_CONNECTION_TYPE.WITH_SD_CARD ? 'slotWithSd' : 'slotWithoutSd';
            const line = await this._sendWithRetry(cmd, [wantKind, 'disconnected'], this._slotChangeTimeoutMs, `select slot ${slotNumber}`);
            const active = parseActiveSlot(line);
            if (!active || active.slot !== slotNumber) {
                throw new Error(`SmartDock slot select failed: requested ${slotNumber}, got "${line}" (DOCK_CMD_ERR_FAIL_SET)`);
            }
            this.activeSlot = active.slot;
            this._emitStatus(`Active slot ${active.slot} selected; settling ${this._slotChangeoverDelayMs}ms`);
            await this._delay(this._slotChangeoverDelayMs);
            // Resync the per-Shimmer stream for the newly routed slot.
            this._wired?.resyncStream();
        }
        // ---------------------------------------------------------------------------
        // Per-slot docked-Shimmer ops (compose D1 WiredShimmerClient)
        // ---------------------------------------------------------------------------
        /**
         * Select `slotNumber`, then read the docked Shimmer's identity by delegating
         * to the D1 {@link WiredShimmerClient.identify} over the per-Shimmer UART. The
         * per-Shimmer protocol (MAC/HW/FW/expansion) is NOT re-implemented here.
         */
        async identifyDockedShimmer(slotNumber) {
            return this._serialize(async () => {
                await this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD);
                const wired = await this._ensureWired();
                return wired.identify();
            });
        }
        /**
         * Select `slotNumber`, then read the docked Shimmer's battery/charging status
         * by delegating to the D1 {@link WiredShimmerClient.getStatus}.
         */
        async getDockedShimmerStatus(slotNumber) {
            return this._serialize(async () => {
                await this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD);
                const wired = await this._ensureWired();
                return wired.getStatus();
            });
        }
        /**
         * Select `slotNumber`, then read + decode the docked Shimmer's InfoMem
         * configuration (configure-while-docked, phase P2). Slot-select and the
         * per-Shimmer identify + InfoMem read run as one atomic unit under this
         * client's queue, so concurrent calls for different slots cannot interleave.
         * The docked device is (re)identified after the slot change to resolve the
         * correct InfoMem byte layout for that slot.
         */
        async readInfoMemConfig(slotNumber) {
            return this._serialize(async () => {
                await this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD);
                const wired = await this._ensureWired();
                await wired.identify();
                return wired.readInfoMemConfig();
            });
        }
        /**
         * Select `slotNumber`, then encode + write a configuration to the docked
         * Shimmer's InfoMem, atomically. See
         * {@link WiredShimmerClient.writeInfoMemConfig} for the device-write, RTC
         * (`opts.setRtc`, default true) and verify semantics.
         */
        async writeInfoMemConfig(slotNumber, config, opts = {}) {
            return this._serialize(async () => {
                await this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD);
                const wired = await this._ensureWired();
                await wired.identify();
                return wired.writeInfoMemConfig(config, opts);
            });
        }
        /** Lazily build + connect the composed D1 client over the per-Shimmer transport. */
        async _ensureWired() {
            if (!this._shimmerTransport) {
                throw new Error('SmartDockClient.identifyDockedShimmer / getDockedShimmerStatus require a per-Shimmer ' +
                    'transport: a SmartDock routes the active slot onto a separate FTDI UART port. Pass ' +
                    'it via the constructor ({ shimmerTransport }).');
            }
            if (!this._wired) {
                this._wired = new WiredShimmerClient({
                    debug: this.debug,
                    transport: this._shimmerTransport,
                });
            }
            if (!this._wiredConnected) {
                await this._wired.connect();
                this._wiredConnected = true;
            }
            return this._wired;
        }
        // ---------------------------------------------------------------------------
        // Request/response core (base ASCII channel)
        // ---------------------------------------------------------------------------
        /** Send an ASCII base command and await a response of one of `kinds`. */
        async _command(cmd, kind, timeoutMs) {
            return this._sendWithRetry(buildBaseCommand(cmd), [kind], timeoutMs, cmd);
        }
        /**
         * Write `cmdBytes` and await a matching response, re-sending the command on a
         * missed reply for a total of `SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS` (= 2)
         * attempts before failing — mirroring SmartDockUart.java:526-537
         * (`txBytesAndWaitForReply`). Retries on TIMEOUT ONLY; an explicit `E` error
         * response ({@link SmartDockTimeoutError} is not thrown for it) propagates
         * immediately, matching the Java path where `waitForSmartDockResponse` throws
         * on an error instead of returning false.
         */
        async _sendWithRetry(cmdBytes, kinds, timeoutMs, label) {
            if (!this._transport)
                throw new Error('Not connected');
            let lastErr;
            for (let attempt = 0; attempt < SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS; attempt++) {
                await this._transport.write(cmdBytes);
                try {
                    return await this._waitForResponse(kinds, timeoutMs, label);
                }
                catch (err) {
                    // Only a timeout is retryable; an error response fails fast.
                    if (err instanceof SmartDockTimeoutError) {
                        lastErr = err;
                        this._log(`command "${label}" timed out (attempt ${attempt + 1}); re-sending`);
                        continue;
                    }
                    throw err;
                }
            }
            throw lastErr instanceof Error ? lastErr : new SmartDockTimeoutError(`timeout (${label})`);
        }
        /**
         * Resolve with the first response line whose classification is in `kinds`;
         * reject on an `E` error line or timeout. Lines of any other kind (including
         * `unknown`/garbage) are ignored — this is the resync discipline.
         */
        _waitForResponse(kinds, timeoutMs, label) {
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => {
                    this._offTemp(handler);
                    reject(new SmartDockTimeoutError(`SmartDock response timeout (${label})`));
                }, timeoutMs);
                const handler = (line) => {
                    const k = classifyBaseResponse(line);
                    if (k === 'error') {
                        clearTimeout(t);
                        this._offTemp(handler);
                        reject(new Error(`SmartDock error response (${label})`));
                        return;
                    }
                    if (kinds.includes(k)) {
                        clearTimeout(t);
                        this._offTemp(handler);
                        resolve(line);
                    }
                    // else: ignore (unrelated line / garbage) and keep waiting.
                };
                this._onTemp(handler);
            });
        }
        _delay(ms) {
            return new Promise((r) => setTimeout(r, ms));
        }
        /**
         * Run `fn` after every previously-queued operation has settled, so all public
         * operations execute strictly one-at-a-time (see {@link _queue}). The queue
         * never rejects — a failed op does not poison later ones — while the caller
         * still receives `fn`'s own resolution/rejection.
         */
        _serialize(fn) {
            const run = this._queue.then(() => fn());
            this._queue = run.then(() => undefined, () => undefined);
            return run;
        }
        _drain() {
            for (;;) {
                const res = extractBaseLine(this._rxBuf);
                if (!res)
                    break;
                this._rxBuf = res.rest;
                if (res.line.length > 0)
                    this._emitTemp(res.line);
            }
        }
        _onTemp(fn) {
            this._temps.add(fn);
        }
        _offTemp(fn) {
            this._temps.delete(fn);
        }
        _emitTemp(line) {
            this._temps.forEach((fn) => {
                try {
                    fn(line);
                }
                catch (e) {
                    this._log('temp handler error', e);
                }
            });
        }
    }

    /**
     * Constants for the Shimmer3 / Shimmer3R binary SD-log file format.
     *
     * Ported from the Shimmer Java driver:
     *   com.shimmerresearch.binaryfile.ShimmerSDLog (header layout + read loop)
     *   com.shimmerresearch.driver.ShimmerObject.SDLogHeader (sensor bitmasks)
     *   com.shimmerresearch.driverUtilities.ShimmerVerDetails (HW_ID / FW_ID)
     */
    /** Shimmer hardware identifiers (ShimmerVerDetails.HW_ID). */
    const SDLOG_HW_ID = Object.freeze({
        SHIMMER_3: 3,
        SHIMMER_3R: 10,
    });
    /** Firmware identifiers (ShimmerVerDetails.FW_ID). */
    const SDLOG_FW_ID = Object.freeze({
        BTSTREAM: 1,
        SDLOG: 2,
        LOGANDSTREAM: 3,
        GQ_BLE: 5,
        GQ_802154: 9,
        STROKARE: 15,
    });
    /** SD-log header lengths in bytes, keyed by generation. */
    const SDLOG_HEADER_LENGTH = Object.freeze({
        /** SDLog v0.5.x (unsupported — rejected with LEGACY_UNSUPPORTED). */
        LEGACY: 178,
        /** Modern Shimmer3 (SDLog >= 0.8.69, LogAndStream >= 0.5.0). */
        SHIMMER3: 256,
        /** Shimmer3R. */
        SHIMMER3R: 384,
    });
    /** The 32 kHz sampling/RTC clock frequency shared by Shimmer3 and Shimmer3R. */
    const SDLOG_CLOCK_FREQ = 32768;
    /**
     * Length in bytes of the sync timestamp-offset field prefixed to the first
     * sample of each 512-byte block when "sync when logging" is enabled
     * (ShimmerObject.OFFSET_LENGTH — always 9 for modern firmware; the 5-byte
     * variant only exists on legacy SDLog 0.5.x, which is out of scope).
     */
    const SDLOG_SYNC_OFFSET_LENGTH = 9;
    /** SD sector size used for the sync-when-logging block framing. */
    const SDLOG_SYNC_BLOCK_LENGTH = 512;
    /**
     * Enabled-sensor bitmasks as stored in SD-log header bytes 3-7 (40-bit,
     * LSB-first). Ported verbatim from ShimmerObject.SDLogHeader (values > 2^31
     * are plain numbers — always test them with {@link hasSensorBit}, never with
     * 32-bit bitwise operators).
     */
    const SDLogHeaderBitmask = Object.freeze({
        ACCEL_LN: 1 << 7,
        GYRO: 1 << 6,
        MAG: 1 << 5,
        EXG1_24BIT: 1 << 4,
        EXG2_24BIT: 1 << 3,
        GSR: 1 << 2,
        EXT_EXP_A7: 1 << 1,
        EXT_EXP_A6: 1 << 0,
        BRIDGE_AMP: 1 << 15,
        ECG_TO_HR_FW: 1 << 14,
        BATTERY: 1 << 13,
        ACCEL_WR: 1 << 12,
        EXT_EXP_A15: 1 << 11,
        INT_EXP_A1: 1 << 10,
        INT_EXP_A12: 1 << 9,
        INT_EXP_A13: 1 << 8,
        INT_EXP_A14: 1 << 23,
        ACCEL_MPU: 1 << 22,
        MAG_MPU: 1 << 21,
        EXG1_16BIT: 1 << 20,
        EXG2_16BIT: 1 << 19,
        BMPX80: 1 << 18,
        MPL_TEMPERATURE: 1 << 17,
        MPL_QUAT_6DOF: 2 ** 31,
        MPL_QUAT_9DOF: 1 << 30,
        MPL_EULER_6DOF: 1 << 29,
        MPL_EULER_9DOF: 1 << 28,
        MPL_HEADING: 1 << 27,
        MPL_PEDOMETER: 1 << 26,
        MPL_TAP: 1 << 25,
        MPL_MOTION_ORIENT: 1 << 24,
        GYRO_MPU_MPL: 2 ** 39,
        ACCEL_MPU_MPL: 2 ** 38,
        MAG_MPU_MPL: 2 ** 37,
        MPL_QUAT_6DOF_RAW: 2 ** 36,
    });
    /**
     * Test a bit in the (up to 40-bit) enabled-sensors value. JavaScript bitwise
     * operators truncate to 32 bits, so masks >= 2^31 must be tested arithmetically.
     */
    function hasSensorBit(enabledSensors, mask) {
        return Math.floor(enabledSensors / mask) % 2 === 1;
    }
    /**
     * Expansion-board hardware SR codes used by the "new IMU" detection
     * (ShimmerVerDetails.HW_ID_SR_CODES).
     */
    const SDLOG_EXP_BRD_ID = Object.freeze({
        SHIMMER3: 31,
        PROTO3_MINI: 36,
        PROTO3_DELUXE: 38,
        ADXL377_ACCEL_200G: 44,
        EXG_UNIFIED: 47,
        GSR_UNIFIED: 48,
        BR_AMP_UNIFIED: 49,
    });

    /**
     * SD-log channel tables and raw datatype decoding.
     *
     * Ported from the Shimmer Java driver:
     *   ShimmerSDLog#interpretdatapacketformat  — Shimmer3 enabled-sensors channel order
     *   ShimmerObject#interpretDataPacketFormat(nChannels, signalIds) — Shimmer3R
     *     dynamic signal-ID table (HW_ID.SHIMMER_3R branches)
     *   UtilParseData#parseData(byte[], String[]) — datatype byte semantics
     *
     * Datatype string conventions (UtilParseData): suffix `r` = big-endian,
     * otherwise little-endian; `i` = signed two's complement, `u` = unsigned;
     * `i12*>` = Shimmer3R high-g accel packing (MSB << 4 | LSB >> 4).
     */
    const SDLOG_DATA_TYPE_BYTES = Object.freeze({
        u8: 1,
        u12: 2,
        u14: 2,
        u16: 2,
        u16r: 2,
        i16: 2,
        i16r: 2,
        u24: 3,
        u24r: 3,
        i24r: 3,
        u32r: 4,
        i32r: 4,
        'i12*>': 2,
    });
    function sign(value, bits) {
        return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
    }
    /**
     * Decode one channel value at `off` in `bytes`.
     *
     * Mirrors UtilParseData.parseData(byte[], String[]) exactly — including the
     * quirk that `u12`/`u14` are read as full unsigned 16-bit little-endian values
     * with no masking (the firmware guarantees the upper bits are zero).
     */
    function decodeSdLogValue(bytes, off, type) {
        switch (type) {
            case 'u8':
                return bytes[off];
            case 'u12':
            case 'u14':
            case 'u16':
                return bytes[off] | (bytes[off + 1] << 8);
            case 'u16r':
                return (bytes[off] << 8) | bytes[off + 1];
            case 'i16':
                return sign(bytes[off] | (bytes[off + 1] << 8), 16);
            case 'i16r':
                return sign((bytes[off] << 8) | bytes[off + 1], 16);
            case 'u24':
                return bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16);
            case 'u24r':
                return (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
            case 'i24r':
                return sign((bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2], 24);
            case 'u32r':
                return bytes[off] * 2 ** 24 + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
            case 'i32r':
                // JS 32-bit bitwise OR yields the signed two's-complement result directly.
                return (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
            case 'i12*>':
                // Shimmer3R high-g accel: MSB byte << 4 OR'd with upper nibble of the
                // LSB byte, then 12-bit two's complement (UtilParseData "i12*>").
                return sign((bytes[off] << 4) | (bytes[off + 1] >> 4), 12);
        }
    }
    const uncal = (name, dataType) => ({
        name,
        unit: null,
        calibrated: false,
        dataType,
        sizeBytes: SDLOG_DATA_TYPE_BYTES[dataType],
    });
    /**
     * GSR is the one channel with a reusable calibration path in this SDK (the
     * amplifier-equation conversion shared by Shimmer3Client/Shimmer3RClient), so
     * the decoder emits it calibrated, in µS.
     */
    const gsrChannel = () => ({
        name: 'GSR',
        unit: 'uSiemens',
        calibrated: true,
        dataType: 'u16',
        sizeBytes: 2,
    });
    /**
     * Build the Shimmer3 (256-byte header) channel list from the enabled-sensors
     * value. The order and datatypes replicate the "modern Shimmer3" branch of
     * ShimmerSDLog#interpretdatapacketformat (ShimmerSDLog.java lines 817-1271)
     * exactly, including the legacy-magnetometer X, Z, Y ordering.
     *
     * @param enabledSensors 40-bit enabled-sensors value from the header.
     * @param newImuSensors  True when the expansion-board bytes identify a
     *   new-IMU board (LSM303AHTR/MPU9250/BMP280 generation) — flips the mag
     *   channels to little-endian X, Y, Z and renames the BMP channels.
     */
    function buildShimmer3SdLogChannels(enabledSensors, newImuSensors) {
        const has = (mask) => hasSensorBit(enabledSensors, mask);
        const ch = [];
        if (has(SDLogHeaderBitmask.ACCEL_LN)) {
            ch.push(uncal('LN_ACCEL_X', 'u12'), uncal('LN_ACCEL_Y', 'u12'), uncal('LN_ACCEL_Z', 'u12'));
        }
        if (has(SDLogHeaderBitmask.BATTERY))
            ch.push(uncal('BATTERY', 'u12'));
        if (has(SDLogHeaderBitmask.EXT_EXP_A7))
            ch.push(uncal('EXT_EXP_ADC_A7', 'u12'));
        if (has(SDLogHeaderBitmask.EXT_EXP_A6))
            ch.push(uncal('EXT_EXP_ADC_A6', 'u12'));
        if (has(SDLogHeaderBitmask.EXT_EXP_A15))
            ch.push(uncal('EXT_EXP_ADC_A15', 'u12'));
        if (has(SDLogHeaderBitmask.INT_EXP_A12))
            ch.push(uncal('INT_EXP_ADC_A12', 'u12'));
        if (has(SDLogHeaderBitmask.INT_EXP_A13))
            ch.push(uncal('INT_EXP_ADC_A13', 'u12'));
        if (has(SDLogHeaderBitmask.INT_EXP_A14))
            ch.push(uncal('INT_EXP_ADC_A14', 'u12'));
        if (has(SDLogHeaderBitmask.BRIDGE_AMP)) {
            ch.push(uncal('BRIDGE_AMP_HIGH', 'u12'), uncal('BRIDGE_AMP_LOW', 'u12'));
        }
        if (has(SDLogHeaderBitmask.GSR))
            ch.push(gsrChannel());
        if (has(SDLogHeaderBitmask.INT_EXP_A1))
            ch.push(uncal('INT_EXP_ADC_A1', 'u12'));
        if (has(SDLogHeaderBitmask.GYRO)) {
            // Modern (non-legacy) SD logs store the MPU gyro big-endian.
            ch.push(uncal('GYRO_X', 'i16r'), uncal('GYRO_Y', 'i16r'), uncal('GYRO_Z', 'i16r'));
        }
        if (has(SDLogHeaderBitmask.ACCEL_WR)) {
            ch.push(uncal('WR_ACCEL_X', 'i16'), uncal('WR_ACCEL_Y', 'i16'), uncal('WR_ACCEL_Z', 'i16'));
        }
        if (has(SDLogHeaderBitmask.MAG)) {
            if (newImuSensors) {
                // LSM303AHTR: little-endian, natural X, Y, Z order.
                ch.push(uncal('MAG_X', 'i16'), uncal('MAG_Y', 'i16'), uncal('MAG_Z', 'i16'));
            }
            else {
                // LSM303DLHC: big-endian, X, Z, Y on-disk order.
                // HARDWARE-VERIFY: old-IMU mag channel order (X, Z, Y) and endianness
                // taken from ShimmerSDLog.java:980-990; verify against a real SR31<6 log.
                ch.push(uncal('MAG_X', 'i16r'), uncal('MAG_Z', 'i16r'), uncal('MAG_Y', 'i16r'));
            }
        }
        if (has(SDLogHeaderBitmask.ACCEL_MPU)) {
            ch.push(uncal('ACCEL_MPU_X', 'i16r'), uncal('ACCEL_MPU_Y', 'i16r'), uncal('ACCEL_MPU_Z', 'i16r'));
        }
        if (has(SDLogHeaderBitmask.MAG_MPU)) {
            ch.push(uncal('MAG_MPU_X', 'i16'), uncal('MAG_MPU_Y', 'i16'), uncal('MAG_MPU_Z', 'i16'));
        }
        if (has(SDLogHeaderBitmask.BMPX80)) {
            const suffix = newImuSensors ? 'BMP280' : 'BMP180';
            ch.push(uncal(`TEMPERATURE_${suffix}`, 'u16r'));
            ch.push(uncal(`PRESSURE_${suffix}`, 'u24r'));
        }
        if (has(SDLogHeaderBitmask.EXG1_24BIT)) {
            ch.push(uncal('Exg1_Status', 'u8'), uncal('Exg1_CH1_24Bit', 'i24r'), uncal('Exg1_CH2_24Bit', 'i24r'));
        }
        if (has(SDLogHeaderBitmask.EXG2_24BIT)) {
            ch.push(uncal('Exg2_Status', 'u8'), uncal('Exg2_CH1_24Bit', 'i24r'), uncal('Exg2_CH2_24Bit', 'i24r'));
        }
        if (has(SDLogHeaderBitmask.EXG1_16BIT)) {
            ch.push(uncal('Exg1_Status', 'u8'), uncal('Exg1_CH1_16Bit', 'i16r'), uncal('Exg1_CH2_16Bit', 'i16r'));
        }
        if (has(SDLogHeaderBitmask.EXG2_16BIT)) {
            ch.push(uncal('Exg2_Status', 'u8'), uncal('Exg2_CH1_16Bit', 'i16r'), uncal('Exg2_CH2_16Bit', 'i16r'));
        }
        if (has(SDLogHeaderBitmask.MPL_QUAT_6DOF)) {
            ch.push(uncal('QUAT_MPL_6DOF_W', 'i32r'), uncal('QUAT_MPL_6DOF_X', 'i32r'), uncal('QUAT_MPL_6DOF_Y', 'i32r'), uncal('QUAT_MPL_6DOF_Z', 'i32r'));
        }
        if (has(SDLogHeaderBitmask.MPL_QUAT_9DOF)) {
            ch.push(uncal('QUAT_MPL_9DOF_W', 'i32r'), uncal('QUAT_MPL_9DOF_X', 'i32r'), uncal('QUAT_MPL_9DOF_Y', 'i32r'), uncal('QUAT_MPL_9DOF_Z', 'i32r'));
        }
        if (has(SDLogHeaderBitmask.MPL_EULER_6DOF)) {
            ch.push(uncal('EULER_MPL_6DOF_X', 'i32r'), uncal('EULER_MPL_6DOF_Y', 'i32r'), uncal('EULER_MPL_6DOF_Z', 'i32r'));
        }
        if (has(SDLogHeaderBitmask.MPL_EULER_9DOF)) {
            ch.push(uncal('EULER_MPL_9DOF_X', 'i32r'), uncal('EULER_MPL_9DOF_Y', 'i32r'), uncal('EULER_MPL_9DOF_Z', 'i32r'));
        }
        if (has(SDLogHeaderBitmask.MPL_HEADING))
            ch.push(uncal('MPL_HEADING', 'i32r'));
        if (has(SDLogHeaderBitmask.MPL_TEMPERATURE))
            ch.push(uncal('MPL_TEMPERATURE', 'i32r'));
        if (has(SDLogHeaderBitmask.MPL_PEDOMETER)) {
            ch.push(uncal('MPL_PEDOM_CNT', 'u32r'), uncal('MPL_PEDOM_TIME', 'u32r'));
        }
        if (has(SDLogHeaderBitmask.MPL_TAP))
            ch.push(uncal('TAPDIRANDTAPCNT', 'u8'));
        if (has(SDLogHeaderBitmask.MPL_MOTION_ORIENT))
            ch.push(uncal('MOTIONANDORIENT', 'u8'));
        if (has(SDLogHeaderBitmask.GYRO_MPU_MPL)) {
            ch.push(uncal('GYRO_MPU_MPL_X', 'i32r'), uncal('GYRO_MPU_MPL_Y', 'i32r'), uncal('GYRO_MPU_MPL_Z', 'i32r'));
        }
        if (has(SDLogHeaderBitmask.ACCEL_MPU_MPL)) {
            ch.push(uncal('ACCEL_MPU_MPL_X', 'i32r'), uncal('ACCEL_MPU_MPL_Y', 'i32r'), uncal('ACCEL_MPU_MPL_Z', 'i32r'));
        }
        if (has(SDLogHeaderBitmask.MAG_MPU_MPL)) {
            ch.push(uncal('MAG_MPU_MPL_X', 'i32r'), uncal('MAG_MPU_MPL_Y', 'i32r'), uncal('MAG_MPU_MPL_Z', 'i32r'));
        }
        if (has(SDLogHeaderBitmask.MPL_QUAT_6DOF_RAW)) {
            ch.push(uncal('QUAT_DMP_6DOF_W', 'i32r'), uncal('QUAT_DMP_6DOF_X', 'i32r'), uncal('QUAT_DMP_6DOF_Y', 'i32r'), uncal('QUAT_DMP_6DOF_Z', 'i32r'));
        }
        if (has(SDLogHeaderBitmask.ECG_TO_HR_FW))
            ch.push(uncal('ECG_TO_HR_FW', 'u8'));
        return ch;
    }
    /**
     * Shimmer3R signal-ID → channel mapping, replicating the HW_ID.SHIMMER_3R
     * branches of ShimmerObject#interpretDataPacketFormat(nChannels, signalIds).
     * Names follow the SDK's streaming CHANNEL_FORMATS where an equivalent exists.
     */
    const SHIMMER3R_SIGNAL_ID_TABLE = Object.freeze({
        0x00: uncal('LN_ACCEL_X', 'i16'),
        0x01: uncal('LN_ACCEL_Y', 'i16'),
        0x02: uncal('LN_ACCEL_Z', 'i16'),
        // HARDWARE-VERIFY: the Shimmer3R dynamic table types BATTERY as signed i16
        // (ShimmerObject.java:3030-3033) even though the ADC value is unsigned —
        // ported as-is; confirm against a real Shimmer3R log with battery enabled.
        0x03: uncal('BATTERY', 'i16'),
        0x04: uncal('WR_ACCEL_X', 'i16'),
        0x05: uncal('WR_ACCEL_Y', 'i16'),
        0x06: uncal('WR_ACCEL_Z', 'i16'),
        0x07: uncal('MAG_X', 'i16'),
        0x08: uncal('MAG_Y', 'i16'),
        0x09: uncal('MAG_Z', 'i16'),
        0x0a: uncal('GYRO_X', 'i16'),
        0x0b: uncal('GYRO_Y', 'i16'),
        0x0c: uncal('GYRO_Z', 'i16'),
        0x0d: uncal('EXT_ADC_0', 'u14'),
        0x0e: uncal('EXT_ADC_1', 'u14'),
        0x0f: uncal('EXT_ADC_2', 'u14'),
        0x10: uncal('INT_ADC_3', 'u14'),
        0x11: uncal('INT_ADC_0', 'u14'),
        0x12: uncal('INT_ADC_1', 'u14'),
        0x13: uncal('INT_ADC_2', 'u14'),
        0x14: uncal('HG_ACCEL_X', 'i12*>'),
        0x15: uncal('HG_ACCEL_Y', 'i12*>'),
        0x16: uncal('HG_ACCEL_Z', 'i12*>'),
        0x17: uncal('ALT_MAG_X', 'i16'),
        0x18: uncal('ALT_MAG_Y', 'i16'),
        0x19: uncal('ALT_MAG_Z', 'i16'),
        0x1a: uncal('TEMPERATURE_BMP390', 'u24'),
        0x1b: uncal('PRESSURE_BMP390', 'u24'),
        0x1c: gsrChannel(),
        0x1d: uncal('Exg1_Status', 'u8'),
        0x1e: uncal('Exg1_CH1_24Bit', 'i24r'),
        0x1f: uncal('Exg1_CH2_24Bit', 'i24r'),
        0x20: uncal('Exg2_Status', 'u8'),
        0x21: uncal('Exg2_CH1_24Bit', 'i24r'),
        0x22: uncal('Exg2_CH2_24Bit', 'i24r'),
        0x23: uncal('Exg1_CH1_16Bit', 'i16r'),
        0x24: uncal('Exg1_CH2_16Bit', 'i16r'),
        0x25: uncal('Exg2_CH1_16Bit', 'i16r'),
        0x26: uncal('Exg2_CH2_16Bit', 'i16r'),
        0x27: uncal('BRIDGE_AMP_HIGH', 'u12'),
        0x28: uncal('BRIDGE_AMP_LOW', 'u12'),
    });
    /**
     * Build the Shimmer3R (384-byte header) channel list from the dynamic
     * channel table stored in the header (byte 314 = nChannels, bytes 315.. =
     * signal IDs). Unknown IDs fall back to a `u12` channel named after the ID,
     * matching the Java catch-all (ShimmerObject.java:3579-3583).
     */
    function buildShimmer3RSdLogChannels(signalIds) {
        const ch = [];
        for (let i = 0; i < signalIds.length; i++) {
            const id = signalIds[i];
            const spec = SHIMMER3R_SIGNAL_ID_TABLE[id];
            ch.push(spec ? { ...spec } : uncal(String(id), 'u12'));
        }
        return ch;
    }

    /**
     * SD-log header parsing for modern Shimmer3 (256-byte) and Shimmer3R
     * (384-byte) binary log files.
     *
     * Ported from the Shimmer Java driver:
     *   ShimmerSDLog#processSDLogHeader / #parseHwFwVerForMaps /
     *   #parseEnabledDerivedSensorsForMaps / #readSdConfigHeader
     *   ShimmerVerObject (firmware version-code ladder → timestamp byte width)
     *   ShimmerObject#isSupportedNewImuSensors / ShimmerVerObject
     *   #isSupportedExpansionBrdIdInSdHeader / #isSupportedEightByteDerivedSensors
     */
    const atLeast = (v, major, minor, internal) => v.major > major ||
        (v.major === major && (v.minor > minor || (v.minor === minor && v.internal >= internal)));
    /**
     * Whether SD packets carry a 3-byte (u24) timestamp for this firmware.
     * Derived from the ShimmerVerObject firmware-version-code ladder
     * (ShimmerVerObject.java:263-312) fed into
     * `ShimmerObject#updateTimestampByteLength` (:4725-4736): version code >= 6
     * selects 3 bytes, otherwise 2. Combinations that match no rule in the ladder
     * fall through to code -1 (< 6) → 2 bytes.
     *
     * Relevant rules for the HW/FW combos this decoder supports (Shimmer3 /
     * Shimmer3R × SDLog / LogAndStream):
     *   - Shimmer3R + LogAndStream >= 0.0.1  → code 8 → 3 bytes
     *   - Shimmer3R + SDLog                  → no rule → code -1 → 2 bytes
     *   - Shimmer3  + SDLog        >= 0.11.5 → code 6 (or 8 >= 0.20.1) → 3 bytes; else 2
     *   - Shimmer3  + LogAndStream >= 0.5.4  → code 6 (or higher) → 3 bytes; else 2
     */
    function sdTimestampBytes(hw, fwId, v) {
        if (hw === SDLOG_HW_ID.SHIMMER_3R) {
            // The Java ladder only maps Shimmer3R+LogAndStream (→ code 8, u24). A
            // Shimmer3R+SDLog file matches no rule → code -1 → 2-byte timestamp.
            // HARDWARE-VERIFY: a Shimmer3R+SDLog SD log likely does not exist in the
            // wild; oracle fidelity (ShimmerVerObject.java:270-273) is the tiebreak.
            if (fwId === SDLOG_FW_ID.LOGANDSTREAM)
                return atLeast(v, 0, 0, 1) ? 3 : 2;
            return 2;
        }
        if (fwId === SDLOG_FW_ID.SDLOG)
            return atLeast(v, 0, 11, 5) ? 3 : 2;
        if (fwId === SDLOG_FW_ID.LOGANDSTREAM)
            return atLeast(v, 0, 5, 4) ? 3 : 2;
        return 3;
    }
    /**
     * Sampling clock frequency used for the SD wall-clock (RTC) timestamp
     * (`ShimmerObject#getSamplingClockFreq`, ShimmerObject.java:10868-10896):
     *   - TCXO + the 20 MHz EXG-unified rev-1.1 board → 20 MHz / 64 = 312500 Hz
     *   - TCXO otherwise                              → 16.369 MHz / 64 = 255765.625 Hz
     *   - no TCXO                                     → 32768 Hz (crystal)
     * NB: only the RTC (wall-clock) conversion uses this frequency. The
     * device-clock timestamp uses `getRtcClockFreq()` = 32768 Hz always
     * (ShimmerObject.java:2824, ShimmerDevice.java:4723), and the sampling-rate
     * field is likewise divided by 32768 here — matching the Java driver, whose
     * SD-log sampling-rate math also uses the (non-TCXO) crystal for these logs.
     */
    function samplingClockFreq(tcxo, hw, expBrd) {
        if (!tcxo)
            return SDLOG_CLOCK_FREQ;
        // isTcxoClock20MHz (ShimmerObject.java:10882-10896): Shimmer3/3R + EXG
        // unified board id 47, rev 1, revSpecial 1.
        const is20MHz = (hw === SDLOG_HW_ID.SHIMMER_3 || hw === SDLOG_HW_ID.SHIMMER_3R) &&
            expBrd !== null &&
            expBrd.id === SDLOG_EXP_BRD_ID.EXG_UNIFIED &&
            expBrd.rev === 1 &&
            expBrd.revSpecial === 1;
        return is20MHz ? 312500.0 : 255765.625;
    }
    /**
     * "New IMU sensors" detection for Shimmer3 (LSM303AHTR / MPU9250 / BMP280
     * generation) — controls mag channel order/endianness and BMP naming.
     * Port of ShimmerObject.isSupportedNewImuSensors(svo, expansionBoardDetails);
     * a Shimmer3R always qualifies, a Shimmer3 without expansion-board info in
     * the header never does (Java passes a LOG_FILE placeholder board → false).
     */
    function isNewImuSensors(hw, expBrd) {
        if (hw === SDLOG_HW_ID.SHIMMER_3R)
            return true;
        if (hw !== SDLOG_HW_ID.SHIMMER_3 || expBrd === null)
            return false;
        const { id, rev, revSpecial } = expBrd;
        // HARDWARE-VERIFY: new-IMU expansion-board revision thresholds copied from
        // Configuration.Shimmer3.NEW_IMU_EXP_REV; only verifiable against real
        // boards of each revision.
        return ((id === SDLOG_EXP_BRD_ID.EXG_UNIFIED && rev >= 3) ||
            (id === SDLOG_EXP_BRD_ID.GSR_UNIFIED && rev >= 3) ||
            (id === SDLOG_EXP_BRD_ID.BR_AMP_UNIFIED && rev >= 3) ||
            (id === SDLOG_EXP_BRD_ID.SHIMMER3 && rev >= 6) ||
            revSpecial === 171 ||
            (id === SDLOG_EXP_BRD_ID.PROTO3_DELUXE && rev >= 3) ||
            (id === SDLOG_EXP_BRD_ID.PROTO3_MINI && rev >= 3));
    }
    /**
     * Whether the sync-when-logging 512-byte block framing applies. Port of the
     * guard used throughout ShimmerSDLog (interpretdatapacketformat / setup /
     * readPacketMsg): SDLog firmware always frames when the trial-config sync
     * bit is set; LogAndStream only from 0.16.11 on Shimmer3 and from any
     * version on Shimmer3R (Configuration.Shimmer3.CompatibilityInfoForMaps).
     */
    function usesSyncBlockFraming(syncWhenLogging, hw, fwId, v) {
        if (!syncWhenLogging)
            return false;
        if (fwId === SDLOG_FW_ID.SDLOG)
            return true;
        if (fwId === SDLOG_FW_ID.LOGANDSTREAM) {
            if (hw === SDLOG_HW_ID.SHIMMER_3R)
                return true;
            return atLeast(v, 0, 16, 11);
        }
        return false;
    }
    /**
     * Decode the inertial-sensor hardware ranges from the SD config setup bytes.
     *
     * The four config setup bytes live at SD header bytes 8-11 (setup0-3): the
     * existing GSR-range read from byte 11 (setup3) fixes this mapping. Bit
     * positions are ported from ConfigByteLayoutShimmer3
     * (com.shimmerresearch.driver.shimmer2r3):
     *   - WR accel range : setup0 (byte 8) bits 2-3, mask 0x03
     *       (SensorLSM303.configByteArrayParse / SensorLIS2DW12 both use
     *        bitShiftLSM303DLHCAccelRange = 2)
     *   - gyro range LSB : setup2 (byte 10) bits 0-1, mask 0x03
     *       (bitShiftMPU9150GyroRange = 0; SensorLSM6DSV reuses the same LSB field)
     *   - mag range      : setup2 (byte 10) bits 5-7, mask 0x07
     *       (bitShiftLSM303DLHCMagRange = 5)
     *   - LN accel range : setup3 (byte 11) bits 6-7, mask 0x03 — Shimmer3R
     *       (SensorLSM6DSV LN accel, bitShiftMPU9150AccelRange = 6). On Shimmer3 the
     *       LN accel is the fixed-range Kionix KXRB, so this is forced to 0 there.
     *   - gyro range MSB : setup4 (byte 12) bit 2, mask 0x01 — Shimmer3R only.
     *       The LSM6DSV has 6 gyro ranges (0-5); the MSB lives in config setup byte 4
     *       and is combined with the 2-bit LSB as `lsb | (msb << 2)`. Ported from
     *       ShimmerSDLog.processSDLogHeader 3R branch:
     *         int gyroRange    = (byteArrayInfo[10]) & 03;      // LSB (byte 10)
     *         int msbGyroRange = (byteArrayInfo[12] >> 2) & 01; // MSB (byte 12 bit 2)
     *         setGyroRange(gyroRange + (msbGyroRange << 2));
     *       This matches the streaming path (Shimmer3RClient.ts, gyroLsb | gyroMsb<<2,
     *       cfg bit 34 == setup4 bit 2) and ShimmerObject.interpretInqResponse.
     *
     * HARDWARE-VERIFY: no real Shimmer3R SD card has been available to confirm the
     * byte-12 MSB placement; the offset is taken from the Java oracle only. The
     * alt-accel (high-g) and alt-mag ranges are likewise not decoded from the SD
     * header (defaulted to 0); their per-device calibration blocks, when present,
     * override the default anyway.
     */
    function parseImuRanges(bytes, hw) {
        const setup0 = bytes[8] ?? 0;
        const setup2 = bytes[10] ?? 0;
        const setup3 = bytes[11] ?? 0;
        const setup4 = bytes[12] ?? 0;
        const wrAccel = (setup0 >> 2) & 0x03;
        const gyroLsb = setup2 & 0x03;
        // Shimmer3R gyro (LSM6DSV) has 6 ranges (0-5); the MSB rides in setup4 bit 2.
        // Shimmer3 gyro (MPU9x50) has only 4 ranges (0-3), so no MSB there.
        const gyro = hw === SDLOG_HW_ID.SHIMMER_3R ? gyroLsb | (((setup4 >> 2) & 0x01) << 2) : gyroLsb;
        const mag = (setup2 >> 5) & 0x07;
        const lnAccel = hw === SDLOG_HW_ID.SHIMMER_3R ? (setup3 >> 6) & 0x03 : 0;
        return { lnAccel, wrAccel, gyro, mag, altAccel: 0, altMag: 0 };
    }
    function macFromBytes(b) {
        let s = '';
        for (let i = 24; i <= 29; i++)
            s += b[i].toString(16).padStart(2, '0');
        return s;
    }
    /**
     * Parse an SD-log file header, including layout details needed by the packet
     * decoder. Throws {@link SdLogFormatError} for anything outside the supported
     * modern Shimmer3 / Shimmer3R formats.
     */
    function parseSdLog(bytes) {
        if (bytes.length < 40) {
            throw new SdLogFormatError('TOO_SMALL', `File is ${bytes.length} bytes — too small to contain SD-log version fields (need 40).`);
        }
        // Version fields live at fixed offsets in every header generation
        // (ShimmerSDLog#readSDVersionFromHeader).
        const hardwareVersion = (bytes[30] << 8) | bytes[31];
        const firmwareId = (bytes[34] << 8) | bytes[35];
        const fwVersion = {
            major: (bytes[36] << 8) | bytes[37],
            minor: bytes[38],
            internal: bytes[39],
        };
        if (firmwareId === SDLOG_FW_ID.SDLOG && fwVersion.major === 0 && fwVersion.minor === 5) {
            throw new SdLogFormatError('LEGACY_UNSUPPORTED', `Legacy SDLog v0.5.x file (178-byte header) is not supported.`);
        }
        if (hardwareVersion !== SDLOG_HW_ID.SHIMMER_3 && hardwareVersion !== SDLOG_HW_ID.SHIMMER_3R) {
            throw new SdLogFormatError('UNSUPPORTED_DEVICE', `Unsupported hardware version ${hardwareVersion} — only Shimmer3 (3) and Shimmer3R (10) SD logs are supported.`);
        }
        if (firmwareId !== SDLOG_FW_ID.SDLOG && firmwareId !== SDLOG_FW_ID.LOGANDSTREAM) {
            throw new SdLogFormatError('UNSUPPORTED_DEVICE', `Unsupported firmware id ${firmwareId} — only SDLog (2) and LogAndStream (3) logs are supported.`);
        }
        // Support floors for the 256-byte-header era on Shimmer3: SDLog >= 0.8.69,
        // LogAndStream >= 0.5.0. Shimmer3R firmware versioning restarted at 0.x and
        // always writes the modern 384-byte header, so no floor applies there.
        if (hardwareVersion === SDLOG_HW_ID.SHIMMER_3) {
            if (firmwareId === SDLOG_FW_ID.SDLOG && !atLeast(fwVersion, 0, 8, 69)) {
                throw new SdLogFormatError('LEGACY_UNSUPPORTED', `SDLog v${fwVersion.major}.${fwVersion.minor}.${fwVersion.internal} predates the supported floor (0.8.69).`);
            }
            if (firmwareId === SDLOG_FW_ID.LOGANDSTREAM && !atLeast(fwVersion, 0, 5, 0)) {
                throw new SdLogFormatError('LEGACY_UNSUPPORTED', `LogAndStream v${fwVersion.major}.${fwVersion.minor}.${fwVersion.internal} predates the supported floor (0.5.0).`);
            }
        }
        const headerLengthBytes = hardwareVersion === SDLOG_HW_ID.SHIMMER_3R
            ? SDLOG_HEADER_LENGTH.SHIMMER3R
            : SDLOG_HEADER_LENGTH.SHIMMER3;
        if (bytes.length < headerLengthBytes) {
            throw new SdLogFormatError('TOO_SMALL', `File is ${bytes.length} bytes but the header alone is ${headerLengthBytes} bytes.`);
        }
        // Bytes 0-1: sampling divider, LSB-first. Hz = 32768 / divider.
        const rawSamplingDivider = bytes[0] | (bytes[1] << 8);
        if (rawSamplingDivider === 0) {
            throw new SdLogFormatError('BAD_HEADER', 'Sampling-rate divider is 0.');
        }
        const samplingRateHz = SDLOG_CLOCK_FREQ / rawSamplingDivider;
        // Bytes 3-7: enabled sensors, 40-bit LSB-first, with the firmware-specific
        // masking from ShimmerSDLog#parseEnabledDerivedSensorsForMaps.
        const enabledBytes = [bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]];
        const mpu9150Dmp = ((bytes[12] >> 7) & 0x01) === 1;
        if (mpu9150Dmp || firmwareId === SDLOG_FW_ID.LOGANDSTREAM) {
            enabledBytes[2] &= -3; // disable MPU temperature (MPL_TEMPERATURE bit)
            enabledBytes[3] = 0;
            enabledBytes[4] = 0;
        }
        let enabledSensors = enabledBytes[0] +
            enabledBytes[1] * 2 ** 8 +
            enabledBytes[2] * 2 ** 16 +
            enabledBytes[3] * 2 ** 24 +
            enabledBytes[4] * 2 ** 32;
        if (firmwareId !== SDLOG_FW_ID.SDLOG) {
            enabledSensors = enabledSensors % 2 ** 24; // & 0xFFFFFF
        }
        // Bytes 40-42 (+217-221 on newer firmware): derived sensors, LSB-first.
        // Computed with BigInt because bytes 220-221 reach bit 56, beyond the 2^53
        // exact-integer range of a JS number (Java uses a `long`). `derivedSensors`
        // (number) stays exact through byte 219 / bit 47; `derivedSensorsBig`
        // (bigint) carries the full 8-byte fidelity.
        let derivedBig = BigInt(bytes[40]) + (BigInt(bytes[41]) << 8n) + (BigInt(bytes[42]) << 16n);
        const eightByteDerived = (firmwareId === SDLOG_FW_ID.SDLOG && atLeast(fwVersion, 0, 13, 1)) ||
            (firmwareId === SDLOG_FW_ID.LOGANDSTREAM && atLeast(fwVersion, 0, 7, 1));
        if (eightByteDerived) {
            for (let i = 0; i < 5; i++) {
                derivedBig += BigInt(bytes[217 + i]) << BigInt(8 * (3 + i));
            }
        }
        const derivedSensorsBig = derivedBig;
        const derivedSensors = Number(derivedBig);
        // Byte 16: trial config A.
        const buttonStart = ((bytes[16] >> 5) & 0x01) === 1;
        const syncWhenLogging = ((bytes[16] >> 2) & 0x01) === 1;
        const masterShimmer = ((bytes[16] >> 1) & 0x01) === 1;
        // Byte 17 bit 4: TCXO (temperature-compensated crystal oscillator) flag —
        // ShimmerSDLog#processSDLogHeader sets it identically on both the Shimmer3
        // (:303) and Shimmer3R (:233) branches. It only affects the SD wall-clock
        // (RTC) conversion frequency (see samplingClockFreq).
        const tcxo = ((bytes[17] >> 4) & 0x01) === 1;
        // Byte 11 bits 1-3: GSR range (0-3 fixed, 4 = auto) — same offset on both
        // the Shimmer3 and Shimmer3R header layouts.
        const gsrRange = (bytes[11] >> 1) & 0x07;
        // Bytes 44-51: RTC difference, signed 64-bit MSB-first.
        let rtc = 0n;
        for (let i = 44; i <= 51; i++)
            rtc = (rtc << 8n) | BigInt(bytes[i]);
        const rtcDifferenceTicks = BigInt.asIntN(64, rtc);
        // Bytes 52-55: config time (Unix seconds), 32-bit MSB-first.
        const configTime = bytes[52] * 2 ** 24 + bytes[53] * 2 ** 16 + bytes[54] * 2 ** 8 + bytes[55];
        // Bytes 251-255: initial timestamp ticks in the firmware's non-sequential
        // order: b[251]<<32 | b[255]<<24 | b[254]<<16 | b[253]<<8 | b[252].
        // HARDWARE-VERIFY: byte order matches ShimmerSDLog.java:419-426; only a
        // real SD card can confirm it end-to-end.
        const initialTimestampTicks = bytes[251] * 2 ** 32 +
            bytes[255] * 2 ** 24 +
            bytes[254] * 2 ** 16 +
            bytes[253] * 2 ** 8 +
            bytes[252];
        // Bytes 214-216: expansion board id/rev/special-rev, only stored by
        // SDLog >= 0.12.4 / LogAndStream >= 0.6.13
        // (ShimmerVerObject#isSupportedExpansionBrdIdInSdHeader).
        const expBrdInHeader = (firmwareId === SDLOG_FW_ID.SDLOG && atLeast(fwVersion, 0, 12, 4)) ||
            (firmwareId === SDLOG_FW_ID.LOGANDSTREAM && atLeast(fwVersion, 0, 6, 13));
        const expansionBoard = expBrdInHeader
            ? { id: bytes[214], rev: bytes[215], revSpecial: bytes[216] }
            : null;
        const newImu = isNewImuSensors(hardwareVersion, expansionBoard);
        // Calibration parameter blocks (kept raw — see SdLogCalibrationBytes).
        const pressureLen = newImu ? 24 : 22;
        const pressure = new Uint8Array(pressureLen);
        pressure.set(bytes.slice(160, 182), 0);
        if (newImu)
            pressure.set(bytes.slice(222, 224), 22); // BMP280/BMP390 extra bytes
        const calibrationBytes = {
            wrAccel: bytes.slice(76, 97),
            gyro: bytes.slice(97, 118),
            mag: bytes.slice(118, 139),
            lnAccel: bytes.slice(139, 160),
            pressure,
        };
        // Channel table.
        let channels;
        if (hardwareVersion === SDLOG_HW_ID.SHIMMER_3R) {
            calibrationBytes.altAccel = bytes.slice(256, 277);
            calibrationBytes.altMag = bytes.slice(285, 306);
            const nChannels = bytes[314];
            if (315 + nChannels > headerLengthBytes) {
                throw new SdLogFormatError('BAD_HEADER', `Shimmer3R channel table overruns the header (nChannels=${nChannels}).`);
            }
            channels = buildShimmer3RSdLogChannels(bytes.subarray(315, 315 + nChannels));
        }
        else {
            channels = buildShimmer3SdLogChannels(enabledSensors, newImu);
        }
        if (channels.length === 0) {
            throw new SdLogFormatError('BAD_HEADER', 'Header enables no data channels.');
        }
        const timestampBytes = sdTimestampBytes(hardwareVersion, firmwareId, fwVersion);
        const packetSizeBytes = timestampBytes + channels.reduce((sum, c) => sum + c.sizeBytes, 0);
        const syncFraming = usesSyncBlockFraming(syncWhenLogging, hardwareVersion, firmwareId, fwVersion);
        // ShimmerSDLog#setup(): floor((512 - OFFSET_LENGTH) / sensorPacketSize),
        // where the Java mPacketSize includes the offset field and ours does not.
        const samplesPerBlock = syncFraming
            ? Math.floor((SDLOG_SYNC_BLOCK_LENGTH - SDLOG_SYNC_OFFSET_LENGTH) / packetSizeBytes)
            : 0;
        if (syncFraming && samplesPerBlock < 1) {
            throw new SdLogFormatError('BAD_HEADER', `Packet size ${packetSizeBytes} does not fit a 512-byte sync block.`);
        }
        const wallClockFreqHz = samplingClockFreq(tcxo, hardwareVersion, expansionBoard);
        const header = {
            hardwareVersion,
            firmwareId,
            firmwareVersion: fwVersion,
            samplingRateHz,
            macAddress: macFromBytes(bytes),
            enabledSensors,
            derivedSensors,
            derivedSensorsBig,
            tcxo,
            configTime,
            rtcDifferenceTicks,
            initialTimestampTicks,
            trial: {
                id: bytes[32],
                numShimmers: bytes[33],
                syncWhenLogging,
                masterShimmer,
                buttonStart,
            },
            headerLengthBytes,
            timestampBytes,
            packetSizeBytes,
            channels,
            calibrationBytes,
            gsrRange,
            expansionBoard,
            imuRanges: parseImuRanges(bytes, hardwareVersion),
            calibration: [],
        };
        return { header, channels, syncFraming, samplesPerBlock, wallClockFreqHz };
    }
    /**
     * Parse an SD-log file header (first 256 bytes for Shimmer3, 384 bytes for
     * Shimmer3R). The whole file may be passed — only the header is read.
     */
    function parseSdLogHeader(bytes) {
        return parseSdLog(bytes).header;
    }

    /**
     * SD-log inertial calibration planning.
     *
     * For a decoded SD-log file this builds one {@link CalibPlanEntry} per inertial
     * channel group (LN accel, WR accel, gyro, mag, and the Shimmer3R alt-accel /
     * alt-mag), choosing the per-device calibration block from the header when it
     * is valid and falling back to the range-selected default otherwise — exactly
     * the CalibDetailsKinematic behaviour (a stored block overrides the default;
     * an all-0xFF/all-0x00 block keeps the default). It also flips the affected
     * channel specs to `calibrated:true` with the right unit, so the decoder can
     * emit calibrated values.
     */
    function familyOf(header) {
        if (header.hardwareVersion === SDLOG_HW_ID.SHIMMER_3R)
            return 'shimmer3r';
        return isNewImuSensors(header.hardwareVersion, header.expansionBoard)
            ? 'shimmer3-new'
            : 'shimmer3-old';
    }
    function groupSpecsFor(header) {
        const cb = header.calibrationBytes;
        const r = header.imuRanges;
        if (header.hardwareVersion === SDLOG_HW_ID.SHIMMER_3R) {
            return [
                {
                    group: 'lnAccel',
                    axisNames: ['LN_ACCEL_X', 'LN_ACCEL_Y', 'LN_ACCEL_Z'],
                    block: cb.lnAccel,
                    range: r.lnAccel,
                },
                {
                    group: 'wrAccel',
                    axisNames: ['WR_ACCEL_X', 'WR_ACCEL_Y', 'WR_ACCEL_Z'],
                    block: cb.wrAccel,
                    range: r.wrAccel,
                },
                { group: 'gyro', axisNames: ['GYRO_X', 'GYRO_Y', 'GYRO_Z'], block: cb.gyro, range: r.gyro },
                { group: 'mag', axisNames: ['MAG_X', 'MAG_Y', 'MAG_Z'], block: cb.mag, range: r.mag },
                {
                    group: 'altAccel',
                    axisNames: ['HG_ACCEL_X', 'HG_ACCEL_Y', 'HG_ACCEL_Z'],
                    block: cb.altAccel,
                    range: r.altAccel,
                },
                {
                    group: 'altMag',
                    axisNames: ['ALT_MAG_X', 'ALT_MAG_Y', 'ALT_MAG_Z'],
                    block: cb.altMag,
                    range: r.altMag,
                },
            ];
        }
        // Shimmer3 (old + new IMU).
        return [
            {
                group: 'lnAccel',
                axisNames: ['LN_ACCEL_X', 'LN_ACCEL_Y', 'LN_ACCEL_Z'],
                block: cb.lnAccel,
                range: r.lnAccel,
            },
            {
                group: 'wrAccel',
                axisNames: ['WR_ACCEL_X', 'WR_ACCEL_Y', 'WR_ACCEL_Z'],
                block: cb.wrAccel,
                range: r.wrAccel,
            },
            { group: 'gyro', axisNames: ['GYRO_X', 'GYRO_Y', 'GYRO_Z'], block: cb.gyro, range: r.gyro },
            { group: 'mag', axisNames: ['MAG_X', 'MAG_Y', 'MAG_Z'], block: cb.mag, range: r.mag },
        ];
    }
    /**
     * Build the calibration plan for a file and mark the calibrated channel specs.
     * `channels` is the same array referenced by `header.channels`, so the
     * `calibrated`/`unit` flips are visible to consumers of the header.
     */
    function buildSdLogCalibPlan(header, channels) {
        const family = familyOf(header);
        const nameToIndex = new Map();
        channels.forEach((c, i) => nameToIndex.set(c.name, i));
        const entries = [];
        const info = [];
        for (const spec of groupSpecsFor(header)) {
            const xi = nameToIndex.get(spec.axisNames[0]);
            const yi = nameToIndex.get(spec.axisNames[1]);
            const zi = nameToIndex.get(spec.axisNames[2]);
            if (xi === undefined || yi === undefined || zi === undefined)
                continue; // group not present
            const def = getDefaultCalibration(family, spec.group, spec.range);
            if (!def)
                continue; // family has no such group
            // A valid per-device block overrides the default (CalibDetailsKinematic
            // parseCalParamByteArray: all-FF/all-00 → keep default).
            const parsed = spec.block
                ? parseKinematicCalibBlock(spec.block, { sensitivityScale: def.sensitivityScale })
                : null;
            const usingDefault = parsed === null;
            const calibration = parsed ?? def.calibration;
            entries.push({ indices: [xi, yi, zi], calibration });
            info.push({
                group: spec.group,
                unit: def.unit,
                usingDefaultCalibration: usingDefault,
                source: usingDefault ? 'default' : 'sd-header',
                range: spec.range,
            });
            for (const idx of [xi, yi, zi]) {
                channels[idx].calibrated = true;
                channels[idx].unit = def.unit;
            }
        }
        return { entries, info };
    }
    /** Apply a calibration plan in place to one record's `values` array. */
    function applyCalibPlan(values, plan) {
        for (const e of plan) {
            const [xi, yi, zi] = e.indices;
            const [cx, cy, cz] = calibrateTriple(values[xi], values[yi], values[zi], e.calibration);
            values[xi] = cx;
            values[yi] = cy;
            values[zi] = cz;
        }
    }
    function calibrateTriple(x, y, z, cal) {
        const d0 = x - cal.offset[0];
        const d1 = y - cal.offset[1];
        const d2 = z - cal.offset[2];
        const m = cal.m;
        return [
            m[0] * d0 + m[1] * d1 + m[2] * d2,
            m[3] * d0 + m[4] * d1 + m[5] * d2,
            m[6] * d0 + m[7] * d1 + m[8] * d2,
        ];
    }

    /**
     * SD-log packet decoding — single file and multi-file session.
     *
     * Ported from the Shimmer Java driver:
     *   ShimmerSDLog#readPacketMsg / #isEndOfFile — read loop and sync-block
     *     accounting (the 9-byte timestamp-offset field before the first packet
     *     of each 512-byte block is consumed and DISCARDED; porting the sync
     *     algorithm itself is out of scope)
     *   ShimmerObject#unwrapTimeStamp / #parseTimestampShimmer3 — rollover
     *     unwrapping and tick→ms conversion
     *   ParserLoggedDataToDatabase#createMapOfFiles / #parseDataToDB /
     *   #compareSDHeader — numeric file ordering + cross-file consistency
     *     (modern files are self-contained: each restarts its own unwrap state
     *     and carries its own initial timestamp; only legacy 0.5.x — out of
     *     scope — carried rollover state across files)
     */
    /**
     * Convert a raw GSR sample to conductance in µS, reusing the streaming
     * clients' amplifier-equation path (Shimmer3Client/Shimmer3RClient
     * #_calibrateData) seeded with the header's GSR range setting.
     */
    // HARDWARE-VERIFY: GSR amplifier-equation calibration is shared by the SDK's
    // Shimmer3 and Shimmer3R streaming clients; confirm it holds for SD-logged
    // GSR data on older (pre-GSR+) Shimmer3 expansion boards.
    function calibrateGsr(raw, gsrRangeSetting) {
        let adc12 = raw & 0x0fff;
        let range = gsrRangeSetting;
        if (range === 4) {
            range = (raw >> 14) & 0x03; // auto-range: range travels in bits 14-15
        }
        if (range === 3 && adc12 < GSR_UNCAL_LIMIT_RANGE3) {
            adc12 = GSR_UNCAL_LIMIT_RANGE3;
        }
        let gsrkOhm = calibrateGsrDataToResistanceFromAmplifierEq(adc12, range);
        gsrkOhm = nudgeGsrResistance(gsrkOhm, gsrRangeSetting);
        return (1.0 / gsrkOhm) * 1000;
    }
    function decodeRecordsFromFile(bytes, parsed, out, budget) {
        const { header, channels, syncFraming, samplesPerBlock, wallClockFreqHz } = parsed;
        // Build the inertial calibration plan once per file. This also flips the
        // affected channel specs to calibrated:true / unit and records per-group
        // metadata on the header (header.calibration), mirroring how GSR is emitted
        // calibrated. LN accel, WR accel, gyro, mag (+ Shimmer3R alt accel/mag).
        const calibPlan = buildSdLogCalibPlan(header, channels);
        header.calibration = calibPlan.info;
        const packetSize = header.packetSizeBytes;
        const tsBytes = header.timestampBytes;
        const maxTicks = 2 ** (8 * tsBytes);
        const initialTicks = header.initialTimestampTicks;
        const rtcTicks = Number(header.rtcDifferenceTicks);
        const hasRtc = header.rtcDifferenceTicks !== 0n;
        // Per-file rollover state (ShimmerObject#unwrapTimeStamp): modern files
        // restart from cycle 0 with their own header initial timestamp.
        let cycle = 0;
        let lastUnwrapped = 0;
        // ShimmerObject#parseTimestampShimmer3 subtracts the FIRST packet's raw
        // timestamp before adding the header's initial timestamp: on modern
        // firmware the 5-byte initial timestamp is the full clock at the first
        // packet, whose low bytes are that packet's raw timestamp — without the
        // subtraction those low bytes would be double-counted
        // (mFirstTsOffsetFromInitialTsTicks in the Java driver).
        let firstRawTicks = null;
        let pos = header.headerLengthBytes;
        let samplesInBlock = 0;
        while (budget.remaining > 0) {
            // ShimmerSDLog#readPacketMsg: the first packet of the file and the first
            // packet after every `samplesPerBlock` packets is prefixed by the 9-byte
            // sync timestamp-offset field, which is read and discarded here.
            const withOffset = syncFraming && (samplesInBlock === 0 || samplesInBlock === samplesPerBlock);
            const need = withOffset ? SDLOG_SYNC_OFFSET_LENGTH + packetSize : packetSize;
            if (pos + need > bytes.length)
                break; // trailing partial packet is dropped (Java EOF)
            let p = pos;
            if (withOffset) {
                p += SDLOG_SYNC_OFFSET_LENGTH; // discard the offset value
                samplesInBlock = 0;
            }
            // Timestamp: u16/u24 little-endian, unwrapped against rollovers.
            let rawTs = bytes[p] | (bytes[p + 1] << 8);
            if (tsBytes === 3)
                rawTs |= bytes[p + 2] << 16;
            p += tsBytes;
            let unwrapped = rawTs + maxTicks * cycle;
            if (unwrapped < lastUnwrapped) {
                cycle += 1;
                unwrapped = rawTs + maxTicks * cycle;
            }
            lastUnwrapped = unwrapped;
            if (firstRawTicks === null)
                firstRawTicks = rawTs;
            const values = new Array(channels.length);
            for (let c = 0; c < channels.length; c++) {
                const spec = channels[c];
                const raw = decodeSdLogValue(bytes, p, spec.dataType);
                // GSR is calibrated inline (amplifier equation). Inertial channels are
                // marked calibrated by the plan but keep their raw value here and are
                // calibrated together (per triple) by applyCalibPlan below.
                values[c] = spec.name === 'GSR' && spec.calibrated ? calibrateGsr(raw, header.gsrRange) : raw;
                p += spec.sizeBytes;
            }
            if (calibPlan.entries.length)
                applyCalibPlan(values, calibPlan.entries);
            const absoluteTicks = initialTicks + unwrapped - firstRawTicks;
            out.push({
                // Device-clock timestamp always divides by the 32768 Hz RTC clock
                // (ShimmerObject#getRtcClockFreq); only the wall-clock (RTC) conversion
                // below honours the TCXO sampling clock (ShimmerObject#getSamplingClockFreq).
                timestampMs: (absoluteTicks / SDLOG_CLOCK_FREQ) * 1000,
                wallClockMs: hasRtc ? ((absoluteTicks + rtcTicks) / wallClockFreqHz) * 1000 : null,
                values,
            });
            samplesInBlock += 1;
            pos += need;
            budget.remaining -= 1;
        }
        if (budget.remaining === 0) {
            const nextWithOffset = syncFraming && (samplesInBlock === 0 || samplesInBlock === samplesPerBlock);
            const nextNeed = nextWithOffset ? SDLOG_SYNC_OFFSET_LENGTH + packetSize : packetSize;
            if (pos + nextNeed <= bytes.length) {
                budget.truncated = true;
            }
        }
    }
    /**
     * Decode a single SD-log binary file (e.g. `000`) into typed records.
     *
     * @throws SdLogFormatError `NO_DATA` when the file contains only a header.
     */
    function decodeSdLogFile(bytes, opts) {
        const parsed = parseSdLog(bytes);
        if (bytes.length <= parsed.header.headerLengthBytes) {
            throw new SdLogFormatError('NO_DATA', `File contains only the ${parsed.header.headerLengthBytes}-byte header — no sample data.`);
        }
        const records = [];
        const budget = {
            remaining: opts?.maxRecords ?? Number.POSITIVE_INFINITY,
            truncated: false,
        };
        decodeRecordsFromFile(bytes, parsed, records, budget);
        return { header: parsed.header, records, truncated: budget.truncated };
    }
    const isDataFileName = (name) => !name.includes('.');
    /**
     * Decode a multi-file SD session (files `000`, `001`, … within one
     * `<ShimmerName>-<SessionNumber>` folder).
     *
     * - Files whose names contain a `.` are ignored (UtilDock's "a log file is a
     *   name containing no dot" rule); remaining names must be numeric.
     * - Files are concatenated in ascending numeric order.
     * - Headers must agree on MAC address, sampling rate, enabled sensors and
     *   trial id (ParserLoggedDataToDatabase#compareSDHeader), otherwise
     *   `INCONSISTENT_SESSION` is thrown.
     * - Each file restarts its own timestamp-unwrap state and uses its own
     *   header's initial timestamp, so absolute times remain continuous across
     *   file boundaries on modern firmware.
     */
    function decodeSdSession(files, opts) {
        const dataFiles = files.filter((f) => isDataFileName(f.name));
        if (dataFiles.length === 0) {
            throw new SdLogFormatError('NO_DATA', 'No SD-log data files (dot-free numeric names) given.');
        }
        const numbered = dataFiles.map((f) => {
            if (!/^\d+$/.test(f.name)) {
                throw new SdLogFormatError('BAD_HEADER', `"${f.name}" is not a valid SD-log data file name (expected digits only, e.g. "000").`);
            }
            return { num: parseInt(f.name, 10), file: f };
        });
        numbered.sort((a, b) => a.num - b.num);
        for (let i = 1; i < numbered.length; i++) {
            if (numbered[i].num === numbered[i - 1].num) {
                throw new SdLogFormatError('INCONSISTENT_SESSION', `Duplicate log file number ${numbered[i].num} in session.`);
            }
        }
        const parsedFiles = numbered.map(({ file }) => ({
            name: file.name,
            bytes: file.bytes,
            parsed: parseSdLog(file.bytes),
        }));
        const first = parsedFiles[0].parsed.header;
        // Populate the returned header's calibration metadata (and calibrated channel
        // flags) even if the first file turns out to be header-only.
        first.calibration = buildSdLogCalibPlan(first, parsedFiles[0].parsed.channels).info;
        for (const { name, parsed } of parsedFiles) {
            const h = parsed.header;
            if (h.macAddress !== first.macAddress ||
                h.samplingRateHz !== first.samplingRateHz ||
                h.enabledSensors !== first.enabledSensors ||
                h.trial.id !== first.trial.id) {
                throw new SdLogFormatError('INCONSISTENT_SESSION', `Header of file "${name}" does not match the session's first file (MAC/rate/sensors/trial id).`);
            }
        }
        const withData = parsedFiles.filter((f) => f.bytes.length > f.parsed.header.headerLengthBytes);
        if (withData.length === 0) {
            throw new SdLogFormatError('NO_DATA', 'No file in the session contains sample data.');
        }
        const records = [];
        const budget = {
            remaining: opts?.maxRecords ?? Number.POSITIVE_INFINITY,
            truncated: false,
        };
        for (const f of withData) {
            if (budget.remaining <= 0) {
                budget.truncated = true;
                break;
            }
            decodeRecordsFromFile(f.bytes, f.parsed, records, budget);
        }
        return { header: first, records, truncated: budget.truncated };
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
    /**
     * Blob layout version. v2 is byte-for-byte identical in layout to v1 — the
     * firmware bumped it purely to force already-deployed gen-2 units to re-seed
     * with the corrected LSM6DSV/LIS2MDL alignment (its load path checks neither a
     * CRC nor the FW version, so nothing else would).
     *
     * `parseCalibrationBlob` accepts any version and reports what it read;
     * `serializeCalibrationBlob` preserves `input.formatVersion` when present and
     * only falls back to this constant. That matters when writing to a device: a
     * blob stamped with the wrong version is rejected at the device's next boot and
     * silently replaced by the seeded defaults.
     */
    const SC_CALIB_FORMAT_VERSION = 2;
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
        const payloadLength = u16le$2(msg[1], msg[2]);
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
    /**
     * GSR-capable hardware. Mirrors the firmware's authoritative
     * `ShimBrd_isGsrSupportedForHwVersion` (shimmer_boards.c):
     * - SR62 (any revision)
     * - SR61 minor >= 5
     * - SR68 minor >= 5
     *
     * Deliberately NOT {@link isVerisenseSecondGenerationHardware}: that predicate
     * requires SR68 >= 9, but GSR arrived on the SR68 at minor revision 5.
     */
    function isVerisenseGsrSupportedHardware(revHwMajor, revHwMinor) {
        const major = Number(revHwMajor);
        const minor = Number(revHwMinor);
        if (!Number.isFinite(major) || !Number.isFinite(minor))
            return false;
        return major === 62 || ((major === 61 || major === 68) && minor >= 5);
    }
    /**
     * Hardware models with a permanently-attached rechargeable LiPo battery.
     * Mirrors the firmware's authoritative `ShimBrd_isLipoPresentForHwVersion`
     * (shimmer_boards.c):
     * - SR62 (any revision)
     * - SR61 minor >= 5
     * - SR68 minor >= 9
     *
     * On these boards the operational-config battery-type bit (GEN_CFG_2 bit 0,
     * Zinc-Air/NiMH) has no effect: the firmware hard-overrides the battery type
     * to LiPo regardless of the stored bit (`setBattType`, hal_asm_battery.c).
     * Config editors should therefore disable the Battery Type field on these
     * models rather than offer a choice that does nothing (DEV-809).
     */
    function isVerisenseLipoBatteryHardware(revHwMajor, revHwMinor) {
        const major = Number(revHwMajor);
        const minor = Number(revHwMinor);
        if (!Number.isFinite(major) || !Number.isFinite(minor))
            return false;
        return major === 62 || (major === 61 && minor >= 5) || (major === 68 && minor >= 9);
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
                    : // SR68.1-8: LIS2DW12 + PPG; GSR added from SR68.5 (Model IC matrix +
                        // firmware ShimBrd_isGsrSupportedForHwVersion); skin temperature from
                        // SR68.7.
                        {
                            ...VERISENSE_SENSOR_SUPPORT_NONE,
                            accel1: true,
                            ppg: true,
                            gsr: isVerisenseGsrSupportedHardware(major, minor),
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
        // GEN_CFG_0 bit 2 is unused (was PRIORITISE_LONG_TERM_FLASH, removed in
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
            desc: 'Enable/disable pending events scheduler',
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
            key: 'LOW_BATT_AUTO_STOP_DISABLED',
            label: 'Low-Power Auto-Stop',
            desc: 'Stop recording and BLE data transfers when the battery drops below the low-power threshold. Disabling keeps the device recording until the battery is exhausted, at the risk of data loss from brown-out.',
            kind: 'bit',
            index: OP_IDX.GEN_CFG_2,
            shift: 3,
            width: 1,
            options: [
                [0, 'Enabled'],
                [1, 'Disabled'],
            ],
        },
        {
            key: 'BATT_TYPE',
            label: 'Battery Type',
            desc: 'Battery chemistry (replaceable-battery models only; Zinc-Air is legacy — new configurations should use NiMH). Models with a permanently attached LiPo (SR62, SR61.5+, SR68.9+) ignore this setting — the firmware forces LiPo (see isVerisenseLipoBatteryHardware).',
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
            desc: 'Accel ODR (LSM6DSV ODR_XL datasheet register value)',
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
            desc: 'Second-gen accel range code',
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
            desc: 'Gyro ODR (LSM6DSV ODR_G datasheet register value)',
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
            desc: 'Gyro range (LSM6DSV FS_G datasheet register value)',
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
            desc: 'Magnetometer output (sensor-hub) rate. Firmware derives the LIS2MDL ODR to keep a fresh sample available. Bounded by the accel/gyro ODR (the sensor-hub trigger).',
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
            key: 'INACTIVE_TIMEOUT_MINUTES',
            label: 'Inactive Timeout (minutes, 0 = off)',
            desc: 'Minutes the device must be completely stationary before it stops recording (1-63; 0 = stationary detection off, record regardless of movement). ' +
                'CAUTION: with "Resume Rec On Activity" disabled, hitting this timeout also turns Logging OFF in the stored config - the device will not record again until it is reconfigured.',
            kind: 'inactiveMinutes',
            index: OP_IDX.INACTIVE_TIMEOUT,
            min: 0,
            max: 63,
        },
        {
            key: 'RESUME_REC_ON_ACTIVITY',
            label: 'Resume Rec On Activity',
            desc: 'Enabled: recording pauses at the inactive timeout and automatically resumes when movement is detected. ' +
                'Disabled: hitting the timeout stops recording permanently and turns Logging off in the stored config. ' +
                'Only has an effect when Logging is enabled and the inactive timeout is above 0.',
            kind: 'inactiveResume',
            index: OP_IDX.INACTIVE_TIMEOUT,
            options: [
                [0, 'Disabled'],
                [1, 'Enabled'],
            ],
        },
        {
            key: 'BLE_CONNECTION_TRIES_PER_DAY',
            label: 'Connection Attempts per Wake',
            desc: 'Number of connection attempts the device makes each time a sync window opens (applies to all schedules).',
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
            label: 'Data Transfer Wake Interval (hrs)',
            desc: 'How often the data-transfer sync runs: 0 = off, 24 = once daily at the sync time, 1–23 = every N hours.',
            kind: 'u8',
            index: OP_IDX.BLE_DATA_TRANS_WKUP_INT_HRS,
            min: 0,
            max: 24,
        },
        {
            key: 'BLE_DATA_TRANS_WKUP_TIME',
            label: 'Data Transfer Sync Time',
            desc: 'Time of day for the data-transfer sync (minutes since midnight, 0–1439).',
            kind: 'u16',
            index: OP_IDX.BLE_DATA_TRANS_WKUP_TIME,
            min: 0,
            max: 1439,
        },
        {
            key: 'BLE_DATA_TRANS_WKUP_DUR',
            label: 'Data Transfer Active Duration (minutes)',
            desc: 'Minutes Bluetooth stays active during the data-transfer sync window.',
            kind: 'u8',
            index: OP_IDX.BLE_DATA_TRANS_WKUP_DUR,
            min: 0,
            max: 255,
        },
        {
            key: 'BLE_DATA_TRANS_RETRY_INT',
            label: 'Data Transfer Retry Interval (minutes)',
            desc: 'Minutes between connection attempts within the data-transfer sync window.',
            kind: 'u16',
            index: OP_IDX.BLE_DATA_TRANS_RETRY_INT,
            min: 0,
            max: 1439,
        },
        {
            key: 'BLE_STATUS_WKUP_INT_HOURS',
            label: 'Status Wake Interval (hrs)',
            desc: 'How often the status sync runs: 0 = off, 24 = once daily at the sync time, 1–23 = every N hours.',
            kind: 'u8',
            index: OP_IDX.BLE_STATUS_WKUP_INT_HRS,
            min: 0,
            max: 24,
        },
        {
            key: 'BLE_STATUS_WKUP_TIME',
            label: 'Status Sync Time',
            desc: 'Time of day for the status sync (minutes since midnight, 0–1439).',
            kind: 'u16',
            index: OP_IDX.BLE_STATUS_WKUP_TIME,
            min: 0,
            max: 1439,
        },
        {
            key: 'BLE_STATUS_WKUP_DUR',
            label: 'Status Active Duration (minutes)',
            desc: 'Minutes Bluetooth stays active during the status sync window.',
            kind: 'u8',
            index: OP_IDX.BLE_STATUS_WKUP_DUR,
            min: 0,
            max: 255,
        },
        {
            key: 'BLE_STATUS_RETRY_INT',
            label: 'Status Retry Interval (minutes)',
            desc: 'Minutes between connection attempts within the status sync window.',
            kind: 'u16',
            index: OP_IDX.BLE_STATUS_RETRY_INT,
            min: 0,
            max: 1439,
        },
        {
            key: 'BLE_RTC_SYNC_WKUP_INT_HOURS',
            label: 'Time Sync Wake Interval (hrs)',
            desc: 'How often the time (RTC) sync runs: 0 = off, 24 = once daily at the sync time, 1–23 = every N hours.',
            kind: 'u8',
            index: OP_IDX.BLE_RTC_SYNC_WKUP_INT_HRS,
            min: 0,
            max: 24,
        },
        {
            key: 'BLE_RTC_SYNC_WKUP_TIME',
            label: 'Time Sync Time',
            desc: 'Time of day for the time (RTC) sync (minutes since midnight, 0–1439).',
            kind: 'u16',
            index: OP_IDX.BLE_RTC_SYNC_WKUP_TIME,
            min: 0,
            max: 1439,
        },
        {
            key: 'BLE_RTC_SYNC_WKUP_DUR',
            label: 'Time Sync Active Duration (minutes)',
            desc: 'Minutes Bluetooth stays active during the time (RTC) sync window.',
            kind: 'u8',
            index: OP_IDX.BLE_RTC_SYNC_WKUP_DUR,
            min: 0,
            max: 255,
        },
        {
            key: 'BLE_RTC_SYNC_RETRY_INT',
            label: 'Time Sync Retry Interval (minutes)',
            desc: 'Minutes between connection attempts within the time (RTC) sync window.',
            kind: 'u16',
            index: OP_IDX.BLE_RTC_SYNC_RETRY_INT,
            min: 0,
            max: 1439,
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
            desc: 'Selectable GSR range setting',
            kind: 'bit',
            index: OP_IDX.ADC_CHANNEL_SETTINGS_1,
            shift: 0,
            width: 3,
            options: [
                [0, 'Range 0 (8k-63k or 125uS-15.87uS)'],
                [1, 'Range 1 (63k-220k or 15.87uS-4.5uS)'],
                [2, 'Range 2 (220k-680k or 4.5uS-1.47uS)'],
                [3, 'Range 3 (680k-4.7M or 1.47uS-0.21uS)'],
                [4, 'Auto-Range'],
            ],
        },
        {
            key: 'ADAPTIVE_SCHEDULER_FAILCOUNT_MAX',
            label: 'Fallback Trigger (missed syncs)',
            desc: 'Consecutive missed sync windows before the adaptive fallback turns on and starts retrying more often. Typical 2–3. 0 disables the fallback.',
            kind: 'u8',
            // Max is the full u8 range: the firmware disabled sentinel is 0xFF, and the
            // encoder clamps to max — a tighter cap would corrupt a disabled config.
            index: OP_IDX.ADAPTIVE_SCHEDULER_FAILCOUNT_MAX,
            min: 0,
            max: 255,
        },
        {
            key: 'ADAPTIVE_SCHEDULER_INTERVAL',
            label: 'Fallback Retry Interval (minutes)',
            desc: 'Once the fallback is on, minutes between extra BLE retry wakes. Typical ≈426 (about 7 hours). 0 (or 65535) disables the fallback.',
            kind: 'u16',
            // Max is the full u16 range: the firmware disabled sentinel is 0xFFFF, and
            // the encoder clamps to max — a tighter cap would corrupt a disabled config.
            index: OP_IDX.ADAPTIVE_SCHEDULER_INT,
            min: 0,
            max: 65535,
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
            label: 'PPG Record Interval (minutes)',
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
            desc: 'Reserved',
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
            desc: 'MLX90632 sample rate (medical output = chip refresh ÷2; extended ÷3). Drives both the chip refresh and the read poll.',
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
                'LOW_BATT_AUTO_STOP_DISABLED',
                'BATT_TYPE',
                'MAG_EN',
                'LED_MODE',
                'BLE_TX_POWER',
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
            id: 'recording_window',
            title: 'Recording Window',
            openByDefault: false,
            keys: ['START_TIME', 'END_TIME'],
        },
        {
            id: 'inactivity',
            title: 'Inactivity',
            openByDefault: false,
            keys: ['INACTIVE_TIMEOUT_MINUTES', 'RESUME_REC_ON_ACTIVITY'],
        },
        {
            id: 'ble_wake',
            title: 'BLE Wake Schedule',
            openByDefault: false,
            keys: [
                'PENDING_EVENTS_SCHEDULER_DISABLED',
                'BLE_CONNECTION_TRIES_PER_DAY',
                'ADAPTIVE_SCHEDULER_INTERVAL',
                'ADAPTIVE_SCHEDULER_FAILCOUNT_MAX',
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
            // PENDING_EVENTS and BLE retry count stay ungrouped (rendered above the
            // subpanels); the remaining fields cluster by purpose: data transfer,
            // status, RTC sync, and the adaptive scheduler.
            subgroups: [
                {
                    id: 'ble_data',
                    title: 'Data Transfer Schedule',
                    keys: [
                        'BLE_DATA_TRANS_WKUP_INT_HOURS',
                        'BLE_DATA_TRANS_WKUP_TIME',
                        'BLE_DATA_TRANS_WKUP_DUR',
                        'BLE_DATA_TRANS_RETRY_INT',
                    ],
                },
                {
                    id: 'ble_status',
                    title: 'Status Sync Schedule',
                    keys: [
                        'BLE_STATUS_WKUP_INT_HOURS',
                        'BLE_STATUS_WKUP_TIME',
                        'BLE_STATUS_WKUP_DUR',
                        'BLE_STATUS_RETRY_INT',
                    ],
                },
                {
                    id: 'ble_rtc_sync',
                    title: 'Time Sync Schedule',
                    keys: [
                        'BLE_RTC_SYNC_WKUP_INT_HOURS',
                        'BLE_RTC_SYNC_WKUP_TIME',
                        'BLE_RTC_SYNC_WKUP_DUR',
                        'BLE_RTC_SYNC_RETRY_INT',
                    ],
                },
                {
                    id: 'adaptive_scheduler',
                    title: 'Adaptive Scheduler (fallback)',
                    keys: ['ADAPTIVE_SCHEDULER_FAILCOUNT_MAX', 'ADAPTIVE_SCHEDULER_INTERVAL'],
                },
            ],
        },
        {
            id: 'adc_gsr',
            title: 'ADC / GSR',
            openByDefault: false,
            keys: ['ADC_SAMPLE_RATE', 'ADC_OVERSAMPLE_RATE', 'GSR_RANGE_SETTING'],
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
     * this map (e.g. `gen`, `ble_wake`) configure behaviour that applies to
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
     * Pad an operational config authored at a legacy/shorter length onto a blank
     * full-size (v9, {@link VERISENSE_OP_CONFIG_BYTE_SIZE}-byte) image so the
     * working config is always canonical size — otherwise trailing v9 fields
     * (e.g. the person-parameter bytes) would be absent. Configs already at or
     * beyond full size are returned as-is.
     */
    function padVerisenseOperationalConfig(bytes) {
        const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(Array.from(bytes));
        if (src.length >= VERISENSE_OP_CONFIG_BYTE_SIZE)
            return src;
        const full = createBlankVerisenseOperationalConfig(VERISENSE_OP_CONFIG_BYTE_SIZE);
        full.set(src);
        return full;
    }
    /**
     * Firmware default rate/mode codes per sensor group, for config editors that
     * auto-seed a rate when a sensor is first enabled and power it down when all
     * of its enables are cleared. Editors should only seed the `on` default when
     * the field currently holds the `off` (power-down) code, so a user-chosen
     * rate is never clobbered. Sensors whose rate field has no power-down value
     * (magnetometer LIS2MDL_ODR, PPG_SR) are omitted — their enable bit / channel
     * toggles are the on/off control. Default ODR codes mirror the standard
     * customer template (Accel1 = 50 Hz, ADC = 128 Hz).
     */
    const VERISENSE_SENSOR_RATE_DEFAULT_GROUPS = [
        { enableKeys: ['ACCEL_1_EN'], fields: [{ key: 'ODR', on: 4, off: 0 }] },
        {
            enableKeys: ['ACCEL_2_EN'],
            fields: [{ keyByGen: { dsv: 'LSM6DSV_ODR_XL', ds3: 'ODR_XL' }, on: 3, off: 0 }],
        },
        {
            enableKeys: ['GYRO_EN'],
            fields: [{ keyByGen: { dsv: 'LSM6DSV_ODR_G', ds3: 'ODR_G' }, on: 3, off: 0 }],
        },
        {
            enableKeys: ['GSR_EN', 'VBATT_EN', 'VPROG_EN'],
            fields: [{ key: 'ADC_SAMPLE_RATE', on: 19, off: 0 }],
        },
        {
            enableKeys: ['AMBIENT_LIGHT_EN'],
            fields: [{ key: 'LIGHT_SAMPLE_RATE_INDEX', on: 2, off: 0 }],
        },
        {
            enableKeys: ['SKIN_TEMP_EN'],
            fields: [{ key: 'SKIN_TEMP_SAMPLE_RATE', on: 5, off: 0 }],
        },
        { enableKeys: ['ALGO_HUB_EN'], fields: [{ key: 'ALGO_OP_MODE', on: 1, off: 0 }] },
    ];
    /** Resolve a rate-default field to its concrete schema key for the given IMU
     * generation, or null when the field has no key for that generation. */
    function resolveVerisenseSensorRateFieldKey(field, generation) {
        return field.key ?? field.keyByGen?.[generation] ?? null;
    }
    /**
     * The three firmware sync schedules (data transfer, status, RTC sync), each
     * with wake-interval-hours / wake-time / active-duration / retry-interval
     * fields. Interval semantics (from firmware `hal_rtc.c`): 0 = off, 24 = once
     * daily at the wake time, 1-23 = every N hours. Wake time is
     * minutes-since-midnight (device local time), duration is minutes 0-255,
     * retry interval is minutes 0-1439. The number of connection attempts per
     * window is the separate global `BLE_CONNECTION_TRIES_PER_DAY` field.
     */
    const VERISENSE_BLE_SYNC_SCHEDULES = [
        {
            id: 'data',
            subgroupId: 'ble_data',
            intervalKey: 'BLE_DATA_TRANS_WKUP_INT_HOURS',
            timeKey: 'BLE_DATA_TRANS_WKUP_TIME',
            durKey: 'BLE_DATA_TRANS_WKUP_DUR',
            retryKey: 'BLE_DATA_TRANS_RETRY_INT',
        },
        {
            id: 'status',
            subgroupId: 'ble_status',
            intervalKey: 'BLE_STATUS_WKUP_INT_HOURS',
            timeKey: 'BLE_STATUS_WKUP_TIME',
            durKey: 'BLE_STATUS_WKUP_DUR',
            retryKey: 'BLE_STATUS_RETRY_INT',
        },
        {
            id: 'rtcSync',
            subgroupId: 'ble_rtc_sync',
            intervalKey: 'BLE_RTC_SYNC_WKUP_INT_HOURS',
            timeKey: 'BLE_RTC_SYNC_WKUP_TIME',
            durKey: 'BLE_RTC_SYNC_WKUP_DUR',
            retryKey: 'BLE_RTC_SYNC_RETRY_INT',
        },
    ];
    /** Value ranges for the BLE sync-schedule fields (clamp editor input to
     * these before writing). */
    const VERISENSE_BLE_SCHEDULE_RANGES = Object.freeze({
        intervalHours: Object.freeze({ min: 0, max: 24 }),
        timeMins: Object.freeze({ min: 0, max: 1439 }),
        durMin: Object.freeze({ min: 0, max: 255 }),
        retryIntMin: Object.freeze({ min: 0, max: 1439 }),
    });
    /**
     * Canonical schedule defaults: 01:00 daily, 10-minute window, 15-minute
     * retry, 5 connection attempts per wake. Also the "reset" values applied
     * when the pending-events scheduler is disabled, so a disabled config lands
     * in a clean known state.
     */
    const VERISENSE_BLE_SCHEDULE_DEFAULTS = Object.freeze({
        intervalHours: 24,
        timeMins: 60,
        durMin: 10,
        retryIntMin: 15,
        connectionTries: 5,
    });
    /** Format minutes-since-midnight as `"HH:MM"`, or null when out of range.
     * Fractional input is rounded to the nearest whole minute first, so the
     * minutes component always stays in 0–59. */
    function minutesSinceMidnightToHHMM(mins) {
        if (mins == null)
            return null;
        const v = Math.round(Number(mins));
        if (!Number.isFinite(v) || v < 0 || v > 1439)
            return null;
        const h = Math.floor(v / 60);
        const m = v % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    /** Parse `"HH:MM"` (or `"H:MM"`) into minutes-since-midnight, or null when
     * malformed / out of range. */
    function hhmmToMinutesSinceMidnight(text) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
        if (!m)
            return null;
        const h = Number(m[1]);
        const mm = Number(m[2]);
        if (h < 0 || h > 23 || mm < 0 || mm > 59)
            return null;
        return h * 60 + mm;
    }
    /**
     * The stream-packet sensor IDs a device will emit for a given set of sensor
     * enables (see `VERISENSE_STREAM_SENSOR_LABELS` for the ID meanings). The
     * IMU block splits by hardware generation: first-gen streams accel2+gyro as
     * ID 3 (LSM6DS3); second-gen streams accel2+gyro+mag as ID 6 (LSM6DSV +
     * LIS2MDL). Any enabled PPG channel produces the single PPG stream (ID 4).
     */
    function expectedVerisenseStreamSensorIds(enables, opts) {
        const ids = new Set();
        if (enables.gsr || enables.vbatt || enables.vprog)
            ids.add(1);
        if (enables.accel1)
            ids.add(2);
        if (enables.accel2 || enables.gyro || enables.mag)
            ids.add(opts.secondGeneration ? 6 : 3);
        if (enables.ppg)
            ids.add(4);
        if (enables.ambientLight)
            ids.add(7);
        if (enables.algoHub)
            ids.add(8);
        if (enables.skinTemp)
            ids.add(9);
        return ids;
    }
    const STREAM_ENABLE_BY_FIELD_KEY = {
        ACCEL_1_EN: 'accel1',
        ACCEL_2_EN: 'accel2',
        GYRO_EN: 'gyro',
        MAG_EN: 'mag',
        GSR_EN: 'gsr',
        PPG_GREEN_EN: 'ppg',
        PPG_RED_EN: 'ppg',
        PPG_IR_EN: 'ppg',
        PPG_BLUE_EN: 'ppg',
        VPROG_EN: 'vprog',
        VBATT_EN: 'vbatt',
        AMBIENT_LIGHT_EN: 'ambientLight',
        SKIN_TEMP_EN: 'skinTemp',
        ALGO_HUB_EN: 'algoHub',
    };
    /** {@link expectedVerisenseStreamSensorIds} computed straight from op-config
     * bytes via the sensor-enable bit schema. */
    function expectedVerisenseStreamSensorIdsFromConfig(op, opts) {
        const enables = {};
        if (op?.length) {
            for (const f of VERISENSE_SENSOR_ENABLE_FIELDS) {
                const enableKey = STREAM_ENABLE_BY_FIELD_KEY[f.key];
                if (!enableKey)
                    continue;
                if ((((op[f.index] ?? 0) >> f.shift) & 0x01) === 1)
                    enables[enableKey] = true;
            }
        }
        return expectedVerisenseStreamSensorIds(enables, opts);
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
        /**
         * Whether this board uses the SR62 (Verisense GSR+) Shimmer3-style analog
         * front end: 3.0 V SAADC reference, 40.2/287/1000/3300 kΩ GSR feedback
         * resistors, 0.5 V GSR reference and range-3 uncal limit 683. Every other
         * GSR-capable board (SR61 >= 5, SR68 >= 5 — firmware
         * `ShimBrd_isGsrSupportedForHwVersion`) carries the second-generation DC
         * front end: 1.8 V reference, 21/150/562/1740 kΩ, 0.4986 V, limit 1134.
         *
         * Mirrors the firmware's `selectFeedbackResistorsFromHwVersion` (hal_gsr.c),
         * which keys the choice on the major revision alone (SR62 vs everything
         * else). Prefers the production-config hardware revision; falls back to the
         * caller-supplied hardware identifier when no revision has been read yet.
         * Previously this was keyed only on the `VERISENSE_PULSE_PLUS` identifier
         * string, so an SR61-5/6 presenting its true identity decoded ~1.91× high
         * (DEV-874).
         */
        usesSr62GsrFrontEnd() {
            if (this.hwRevisionMajor != null) {
                return this.hwRevisionMajor === 62;
            }
            return this.hardwareIdentifier === 'VERISENSE_GSR_PLUS';
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
            if (this.usesSr62GsrFrontEnd()) {
                refVoltage = 3.0 / 4.0;
            }
            const adcScaling = 1.0 / 4.0;
            return (uncal12bit * refVoltage) / adcRange / adcScaling;
        }
        calibrateGsrToKOhmsUsingAmplifierEq(volts, range) {
            let rFeedback = this.SR68_REF_KOHMS[range];
            let gsrRefVoltage = 0.4986;
            if (this.usesSr62GsrFrontEnd()) {
                rFeedback = this.SHIMMER3_REF_KOHMS[range];
                gsrRefVoltage = 0.5;
            }
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
                        const limit = this.usesSr62GsrFrontEnd()
                            ? this.GSR_UNCAL_LIMIT_RANGE3_SR62
                            : this.GSR_UNCAL_LIMIT_RANGE3_SR68;
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
            // ST angular-rate sensitivity: 4.375 mdps/LSB at ±125 dps, doubling per
            // range (LSM6DSV datasheet §4.3; same spec as the gen-1 LSM6DS3 and the
            // device calibration seed / calibrationDefaults GYRO_RANGES). Unlike the
            // accel, the gyro does NOT span the full 16-bit range at nominal full
            // scale, so a FS/32768 derivation reads ~12.8% low (DEV-874).
            const scale = 0.004375 * (this.gyroFsDps / 125);
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

    function u16le$1(bytes, off) {
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
                    hr: u16le$1(sensorPayloadBytes, base + 6),
                    hrConfidence: sensorPayloadBytes[base + 8] ?? 0,
                    spo2: u16le$1(sensorPayloadBytes, base + 9),
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

    // Thrown by connectWithRetry() when disconnect() is called while a connect
    // attempt is in flight. Must NOT match any of the retryable-error patterns
    // (request timeout / gatt server is disconnected / unexpected response
    // property) so it always aborts the retry loop.
    const CONNECT_CANCELLED_MESSAGE = 'Connect cancelled: disconnect requested during connect attempt.';
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
            // Byte pipe. Injected (RN / tests) or a web transport built at connect time.
            this._injectedTransport = null;
            this._transport = null;
            this._notifyUnsub = null;
            this._disconnectUnsub = null;
            // GATT handles mirrored from the active WebBluetoothTransport so the web-only
            // paths (Nordic DFU, connectWithRetry) keep reaching the live connection.
            // They stay null for injected (non-web) transports.
            this.device = null;
            this.server = null;
            this.service = null;
            this.tx = null;
            this.rx = null;
            this.port = null;
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
            // Set by disconnect() so an in-flight connectWithRetry() loop stops instead
            // of treating the resulting GATT teardown as a transient link drop.
            this._connectCancelRequested = false;
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
            this._injectedTransport = opts.transport ?? null;
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
        /** Build the default Web Bluetooth transport over the NUS service. */
        _makeWebBleTransport(opts) {
            return new WebBluetoothTransport({
                serviceUUID: NUS_SERVICE,
                // Verisense: the host writes command frames to NUS_TX and receives
                // notifications on NUS_RX (mirror image of Shimmer3R). Normal commands use
                // write-without-response; callers request write-with-response explicitly.
                writeCharUUID: NUS_TX,
                notifyCharUUID: NUS_RX,
                requestDeviceOptions: {
                    filters: opts.filters ?? [{ services: [NUS_SERVICE] }],
                    // NORDIC_DFU_SERVICE must be granted at requestDevice() time so the
                    // buttonless DFU control point is reachable from rebootToDfuBootloader().
                    optionalServices: opts.optionalServices ?? [NUS_SERVICE, NORDIC_DFU_SERVICE],
                },
                device: opts.device ?? null,
                defaultWriteWithResponse: false,
                debug: this.debug,
                logTag: '[Verisense:ble]',
            });
        }
        /** Subscribe to a transport's notify/disconnect streams. */
        _wireTransport(transport) {
            this._transport = transport;
            this._notifyUnsub = transport.onNotify((bytes) => this._feedStreamBytes(bytes));
            this._disconnectUnsub = transport.onDisconnect(() => this._handleTransportDisconnect());
        }
        /** Drop the current transport's notify/disconnect subscriptions. */
        _unwireTransport() {
            try {
                this._notifyUnsub?.();
            }
            catch {
                /* ignore */
            }
            try {
                this._disconnectUnsub?.();
            }
            catch {
                /* ignore */
            }
            this._notifyUnsub = null;
            this._disconnectUnsub = null;
        }
        /** Handle an unexpected / requested transport disconnect (link drop). */
        _handleTransportDisconnect() {
            const kind = this._transportKind === 'serial' ? 'serial' : 'ble';
            this._mode = 'idle';
            this._transportKind = null;
            if (this._suppressDisconnectedEvent)
                return;
            this.emit('disconnected', { kind });
        }
        /**
         * Mirror the active WebBluetoothTransport's GATT handles onto the legacy
         * public fields so the web-only paths (Nordic DFU, connectWithRetry) can reach
         * the live connection. Injected (non-web) transports leave them null.
         */
        _mirrorTransportHandles() {
            const t = this._transport;
            if (t instanceof WebBluetoothTransport) {
                this.device = t.device;
                this.server = t.server;
                this.tx = t.writeCharacteristic;
                this.rx = t.notifyCharacteristic;
            }
            else if (t instanceof WebSerialTransport) {
                this.port = t.port;
            }
        }
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
            // A previous session's disconnect (including the internal teardown above)
            // must not cancel this fresh connect attempt.
            this._connectCancelRequested = false;
            // Tear down any leftover wiring before building a fresh transport.
            this._unwireTransport();
            const transport = opts.transport ?? this._injectedTransport ?? this._makeWebBleTransport(opts);
            this._wireTransport(transport);
            await transport.connect();
            this._mirrorTransportHandles();
            const name = this.device?.name ?? transport.deviceName;
            this._emitStatus(`Connected: ${name ?? 'Verisense'}`);
            this.emit('connected', { name: this.device?.name, id: this.device?.id });
            await this._bootstrapConfigsAfterConnect();
            return true;
        }
        async _cleanupFailedBleConnectAttempt(retrySettleMs) {
            this._suppressDisconnectedEvent = true;
            this._unwireTransport();
            try {
                await this._transport?.disconnect();
            }
            catch {
                /* ignore */
            }
            this._transport = null;
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
                if (this._connectCancelRequested) {
                    throw new Error(CONNECT_CANCELLED_MESSAGE);
                }
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
            this._connectCancelRequested = false;
            for (let attempt = 0; attempt <= clampedMaxRetries; attempt += 1) {
                if (this._connectCancelRequested) {
                    throw new Error(CONNECT_CANCELLED_MESSAGE);
                }
                const attemptTimeoutMs = clampedDefaultTimeoutMs;
                this._bootstrapRequestTimeoutOverrideMs = attemptTimeoutMs;
                try {
                    return await this.connect(connectOpts);
                }
                catch (e) {
                    lastError = e;
                    // An explicit disconnect() during the attempt is a user cancel, not a
                    // transient link drop — tear down and stop retrying.
                    if (this._connectCancelRequested) {
                        await this._cleanupFailedBleConnectAttempt(retrySettleMs);
                        throw new Error(CONNECT_CANCELLED_MESSAGE, { cause: e });
                    }
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
                            if (this._connectCancelRequested) {
                                await this._cleanupFailedBleConnectAttempt(retrySettleMs);
                                throw new Error(CONNECT_CANCELLED_MESSAGE, { cause: bootstrapRetryError });
                            }
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
            const injected = opts.transport ?? this._injectedTransport;
            if (!injected && !('serial' in navigator)) {
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
            this._unwireTransport();
            const transport = injected ??
                new WebSerialTransport({
                    port: opts.port ?? null,
                    baudRate: opts.baudRate,
                    dataBits: opts.dataBits,
                    stopBits: opts.stopBits,
                    parity: opts.parity,
                    flowControl: opts.flowControl,
                    filters: opts.filters ?? null,
                    debug: this.debug,
                });
            this._wireTransport(transport);
            await transport.connect();
            this._mirrorTransportHandles();
            this._emitStatus('Connected via USB Serial');
            this.emit('connected', { kind: 'serial' });
            await this._bootstrapConfigsAfterConnect();
            return true;
        }
        async disconnect(opts = {}) {
            // If a connectWithRetry() loop is mid-attempt, this explicit disconnect
            // must stop it from retrying with the same device. connect() clears the
            // flag when the next fresh connect starts.
            this._connectCancelRequested = true;
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
            if (this._transportKind !== 'serial') {
                // Best-effort courtesy notification; swallow the rejection when the BLE
                // transport is not up (e.g. disconnect clicked mid-connect, tx not set).
                // Issued before teardown so it rides the still-open transport.
                void this.writeBytes(buildMessage(ASM_COMMAND.WRITE, ASM_PROPERTY.DEVICE_DISCONNECT), {
                    withResponse: false,
                }).catch(() => { });
            }
            // Tear the transport down. Suppress its own disconnect callback since we emit
            // our own 'disconnected' below (preserving the previous single emit).
            this._suppressDisconnectedEvent = true;
            this._unwireTransport();
            try {
                await this._transport?.disconnect();
            }
            catch {
                /* ignore */
            }
            this._suppressDisconnectedEvent = false;
            this._transport = null;
            this._mode = 'idle';
            this._transportKind = null;
            this.port = null;
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
            // Route through the active transport (web or injected). The transport applies
            // the correct write-with/without-response semantics.
            if (this._transport) {
                await this._transport.write(u8, { withResponse: opts.withResponse });
                return;
            }
            // Legacy fallback: a fake write characteristic injected directly onto `tx`
            // (used by unit tests that exercise the command path without a transport).
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
        /**
         * Write a raw timestamp to the device RWC. NOTE: the Verisense time-sync
         * contract is that the RWC holds the base station's LOCAL civil time (unix
         * seconds with the local timezone offset baked in), not UTC - callers
         * syncing "now" should use {@link writeTimeLocalNow} rather than passing
         * `Date.now()/1000` here.
         */
        async writeTimeUnixSeconds(unixSeconds) {
            await this.writeTime(unixSecondsToAsmRtcBytes(unixSeconds));
        }
        /**
         * Synchronise the device RWC to the host's current LOCAL civil time - the
         * documented Verisense time-sync semantics ("the Base Station's local
         * time"). The downstream file parser relies on this domain for its
         * midnight/midday CSV splits and "Local =" header times.
         *
         * @returns the unix-seconds value written (local-civil domain).
         */
        async writeTimeLocalNow() {
            const civilUnixSeconds = localCivilUnixSecondsNow();
            await this.writeTimeUnixSeconds(civilUnixSeconds);
            return civilUnixSeconds;
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
         * Request a reboot straight into the DFU bootloader over the USB serial
         * transport.
         *
         * Writes the same ASM `DFU_MODE` property, but the firmware's USB handling
         * differs from BLE: it ACKs and resets into the bootloader ~300 ms later
         * (the delay lets the ACK drain), after which THIS serial port disappears
         * and the bootloader enumerates as its own USB CDC device (0x1915/0x521F,
         * "Verisense DFU" — see `VERISENSE_USB_DFU_PORT_FILTERS`). Expect the
         * transport to drop shortly after this resolves.
         *
         * Firmware running on a BLE-only (v2) bootloader NACKs instead of
         * rebooting (`isUsbDfuUnsupportedError` classifies the rejection); fall
         * back to the BLE DFU flow there. Only meaningful on a serial connection —
         * over BLE the same property write follows the
         * {@link enableDfuServiceOnNextDisconnect} semantics.
         */
        async requestUsbDfuBootloaderReboot() {
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
                    // eslint-disable-next-line no-control-regex -- intentionally strips binary control bytes
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
                throw new Error(`Hub FW upload BEGIN failed: ${e instanceof Error ? e.message : String(e)}`, {
                    cause: e,
                });
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
                            throw new Error(`Hub FW upload failed at page ${page + 1}/${numPages} after ${attempt} attempts: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
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
        /** Read the flash lookup table. The read walks the whole flash on-device
         * and can time out on busy sensors, so `retries` re-issues the command
         * (total attempts = retries + 1) before giving up. Non-finite or negative
         * `retries` is treated as 0; rejections are always `Error` instances. */
        async readFlashLookupTable(index = 0, timeoutMs = 12000, retries = 0) {
            const extraAttempts = Number.isFinite(retries) ? Math.max(0, Math.trunc(retries)) : 0;
            let lastError = null;
            for (let attempt = 0; attempt <= extraAttempts; attempt++) {
                try {
                    return await this.readDebugCommand(DEBUG_COMMAND_ID.FLASH_LOOKUP_TABLE_READ, this._debugIndexArgs(index), timeoutMs);
                }
                catch (e) {
                    lastError = e;
                }
            }
            if (lastError instanceof Error)
                throw lastError;
            throw new Error(lastError == null ? 'readFlashLookupTable: read failed' : String(lastError));
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
            let parsed;
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
            const op = normalizeOperationalConfig(rsp?.payload);
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
                    this.applyOperationalConfig(op);
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
        /**
         * Push an operational config into every sensor decoder (rates, ranges,
         * channel enables) and cache it as the client's working config. Used
         * automatically after {@link readOpConfigFromDevice}; call it directly when
         * loading a config from a template/file without a device round-trip.
         */
        applyOperationalConfig(opConfigBytes) {
            const op = opConfigBytes instanceof Uint8Array ? opConfigBytes : new Uint8Array(opConfigBytes);
            this.operationalConfig = op;
            this.accel1.applyOperationalConfig(op);
            this.sensors[3].applyOperationalConfig(op);
            this.sensors[6].applyOperationalConfig(op);
            this.adc.applyOperationalConfig(op);
            this.ppg.applyOperationalConfig(op);
            this.sensors[7].applyOperationalConfig(op);
            this.sensors[8].applyOperationalConfig(op);
            this.sensors[9].applyOperationalConfig(op);
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
     * Verisense Nordic Secure-DFU flow helpers (DEV-845).
     *
     * The byte transport is Nordic's `web-bluetooth-dfu` library (`SecureDfu` +
     * `SecureDfuPackage`, vendored by consuming apps); this module owns everything
     * learned about running that library reliably against Verisense sensors over
     * desktop Chrome/Edge Web Bluetooth:
     *
     * - classification of transient BLE-stack errors vs DFU protocol errors
     * - a fix for the library's swallowed-rejection hang in `sendOperation`
     * - bounded + retried `setDfuMode` (with a full GATT reset between attempts)
     * - the two-phase combined-package update (SoftDevice/bootloader then
     *   application), including resume of an interrupted combined update
     * - the bootloader device-picker filter and packet-pacing defaults
     *
     * The library objects are injected (structurally typed), so this module has no
     * build-time dependency on the vendored scripts. All user-visible progress is
     * reported through an `onStatus` callback; no DOM access happens here.
     */
    /**
     * Transient connection/BLE-stack errors worth retrying. "unknown reason"
     * (NotSupportedError) is Chrome-on-Windows' generic wrapper for any GATT
     * operation the OS stack fails without an ATT error code (DEV-845) —
     * typically a startNotifications/write right after a (re)connect, or a
     * link being torn down mid-encryption. Recoverable on retry; DFU protocol
     * errors (wrong image, version too low, ...) never match.
     */
    const VERISENSE_DFU_TRANSIENT_ERROR_REGEX = /unreachable|networkerror|gatt server|disconnected|no longer in range|connection|unknown reason|notsupportederror/i;
    /** Total attempts (first try + retries) for the DFU connection-retry helpers. */
    const VERISENSE_DFU_CONNECT_ATTEMPTS = 3;
    /** Delay between DFU connection retries, letting the device finish rebooting. */
    const VERISENSE_DFU_RETRY_DELAY_MS = 2000;
    /** Time allowed for the base image's post-install reboot back into the bootloader. */
    const VERISENSE_DFU_REBOOT_DELAY_MS = 3000;
    /** Bound on `setDfuMode` (connect + notifications + one write): the happy path
     * completes in seconds, so a hit means a genuine stall — including the vendored
     * library's swallowed-rejection case that {@link patchSecureDfuSendOperation}
     * and {@link promiseWithTimeout} exist to catch. */
    const VERISENSE_DFU_SET_MODE_TIMEOUT_MS = 30000;
    /**
     * Per-packet pacing for the firmware transfer, in ms. The packet
     * characteristic is written without response; over Web Bluetooth, Chrome
     * drops packets if it outruns the device, so at 0 ms the first pass can fail
     * object CRC validation and the library silently retries the WHOLE transfer
     * at ~10 ms (the pass that succeeds). Pacing at 10 ms makes the first pass
     * succeed outright. Pass 0 ("fast") for full speed on a known-clean link.
     * (nRF Connect sidesteps this via a wired connectivity dongle rather than
     * the OS BLE stack.)
     */
    const VERISENSE_DFU_RELIABLE_PACKET_DELAY_MS = 10;
    const VERISENSE_DFU_FAST_PACKET_DELAY_MS = 0;
    /**
     * The Verisense bootloader advertises with a MAC-suffixed name; app-mode
     * sensors ("Verisense-..." without the marker) are deliberately excluded from
     * DFU device pickers to keep them unambiguous. The DFU service UUID is not
     * advertised in app mode, so it cannot be used to widen the filter; it still
     * needs to be granted via `optionalServices` for the GATT connection.
     *
     * Two prefixes exist across the fleet: v3 (BLE+USB) bootloaders advertise
     * "Verisense-DFU-XXXX" — harmonised with their USB product string so the same
     * name identifies a unit on either transport — while fielded v2 (BLE-only)
     * bootloaders advertise "Verisense-BL-XXXX" forever. Pickers must match both.
     */
    const VERISENSE_DFU_BOOTLOADER_NAME_PREFIX = 'Verisense-BL';
    const VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES = Object.freeze([
        'Verisense-DFU',
        'Verisense-BL',
    ]);
    /**
     * The library's routine object-retransmission notices (e.g. "object failed to
     * validate"). Over Web Bluetooth, firmware packets are written without
     * response and Chrome can drop one if it outruns the device; that makes a
     * 4 KB object's CRC mismatch, so the library transparently re-creates and
     * re-sends that object. The transfer still completes correctly (every object
     * is CRC-checked before Execute, and the bootloader CRC/signature-checks the
     * whole image), so these are non-issues that only alarm users. Real failures
     * still surface via the promise rejection paths.
     */
    const VERISENSE_DFU_ROUTINE_LOG_REGEX = /validat|crc|mismatch|retr|re-?send|re-?creat/i;
    /** True for library log messages that are routine retransmission noise and
     * should not be surfaced to end users (see {@link VERISENSE_DFU_ROUTINE_LOG_REGEX}). */
    function isRoutineVerisenseDfuLogMessage(message) {
        return VERISENSE_DFU_ROUTINE_LOG_REGEX.test(String(message ?? ''));
    }
    /** "attempt N of M" wording for retry status lines. The retry helpers count
     * attempts DOWN (remaining, including the one that just failed), so the
     * attempt about to start is total - remaining + 2. */
    function verisenseDfuAttemptLabel(attemptsRemaining, totalAttempts = VERISENSE_DFU_CONNECT_ATTEMPTS) {
        return `attempt ${totalAttempts - attemptsRemaining + 2} of ${totalAttempts}`;
    }
    /**
     * Fix the swallowed-rejection hang in `web-bluetooth-dfu` v1.2.1 (DEV-845):
     * upstream `SecureDfu.sendOperation` retries a failed control-point write once
     * after 500 ms, but if the retry ALSO fails the rejection is dropped and the
     * returned promise never settles — the transfer hangs forever. This replaces
     * the method with the same logic as upstream, plus: a second write failure
     * rejects the pending operation.
     *
     * Call once per page load with the vendored `SecureDfu` constructor before
     * creating instances. Safe to call repeatedly (idempotent).
     */
    function patchSecureDfuSendOperation(SecureDfuCtor) {
        const patched = function (characteristic, operation, buffer) {
            return new Promise((resolve, reject) => {
                let size = operation.length;
                if (buffer)
                    size += buffer.byteLength;
                const value = new Uint8Array(size);
                value.set(operation);
                if (buffer)
                    value.set(new Uint8Array(buffer), operation.length);
                this.notifyFns[operation[0]] = { resolve, reject };
                characteristic
                    .writeValue(value)
                    .catch((error) => {
                    this.log(error);
                    return this.delayPromise(500).then(() => characteristic.writeValue(value));
                })
                    .catch((error) => {
                    delete this.notifyFns[operation[0]];
                    reject(error);
                });
            });
        };
        SecureDfuCtor.prototype.sendOperation = patched;
    }
    /**
     * Classify known Bluetooth-stack failures seen during Verisense DFU (DEV-845).
     * Two signatures of the same Windows pairing/GATT-cache failure loop:
     * "unknown reason" (NotSupportedError) is the stack failing an operation on a
     * live link, and "GATT Server is disconnected" (NetworkError) is the sensor
     * tearing the link down mid-operation — on units without the firmware fix,
     * typically its ~400 ms security request colliding with a stale pairing key.
     * Unrecognised errors return `category: null` so their raw text passes
     * through unchanged.
     */
    function classifyVerisenseDfuError(error) {
        const rawMessage = String(error);
        const name = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
            ? error.name
            : 'GATT error';
        let category = null;
        let friendlyMessage = null;
        if (/gatt server is disconnected/i.test(rawMessage)) {
            category = 'device-disconnected';
            friendlyMessage = 'The sensor disconnected before the operation could complete';
        }
        else if (/unknown reason|notsupportederror/i.test(rawMessage)) {
            category = 'stack-operation-failed';
            friendlyMessage = 'The Bluetooth stack failed the operation unexpectedly';
        }
        return {
            category,
            friendlyMessage,
            transient: VERISENSE_DFU_TRANSIENT_ERROR_REGEX.test(rawMessage),
            name,
            rawMessage,
        };
    }
    /**
     * Reject a promise that hasn't settled within `ms`. Used to guard
     * `SecureDfu.setDfuMode()`: the library builds its buttonless branch as
     * `new Promise((resolve, reject) => { startNotifications().then(
     * ...sendOperation...).then(resolve) })` with NO `.catch(reject)`, so if
     * startNotifications() or the button-command write fails the promise never
     * settles. (The {@link patchSecureDfuSendOperation} override makes that write
     * reject rather than hang, which this same missing catch would swallow.)
     * The timeout message deliberately includes "connection" so it matches
     * {@link VERISENSE_DFU_TRANSIENT_ERROR_REGEX} and drives the retry helpers.
     * Kept as a timeout rather than re-implementing setDfuMode so the buttonless
     * reboot logic isn't duplicated, and so it defends against any stall cause.
     */
    function promiseWithTimeout(promise, ms, label) {
        let timer;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`${label} timed out after ${ms}ms (connection may have stalled)`));
            }, ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }
    /** A bundled firmware name must be a plain `.zip` filename — no path
     * separators or traversal — so a malformed/hostile manifest can't make an app
     * fetch outside its firmware folder. */
    function isSafeFirmwareArchiveName(name) {
        return typeof name === 'string' && /^[^/\\]+\.zip$/i.test(name) && !name.includes('..');
    }
    /**
     * `navigator.bluetooth.requestDevice()` options for picking a Verisense
     * bootloader (replaces the DFU library's `acceptAllDevices`; see
     * {@link VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES} for why name-prefix only and
     * why there are two). Pass the vendored library's `SecureDfu.SERVICE_UUID`.
     */
    function buildVerisenseDfuRequestDeviceOptions(dfuServiceUuid) {
        return {
            filters: VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
            optionalServices: [dfuServiceUuid],
        };
    }
    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /** Normalize an `attempts` option to a finite integer >= 1 so the retry
     * loops keep their documented "total attempts" semantics for 0/negative/NaN
     * inputs. */
    function normalizeAttempts(attempts) {
        const v = Number(attempts ?? VERISENSE_DFU_CONNECT_ATTEMPTS);
        return Number.isFinite(v) ? Math.max(1, Math.trunc(v)) : VERISENSE_DFU_CONNECT_ATTEMPTS;
    }
    /**
     * `SecureDfu.update()` with retries on connection-level errors. Combined
     * (SoftDevice+bootloader+application) packages transfer in two parts with a
     * device reset in between; the reconnect for part 2 can fail while the device
     * is still rebooting, so transient errors retry after a settle delay. DFU
     * protocol errors are not retried.
     */
    async function updateVerisenseDfuImageWithRetry(dfu, device, image, options = {}) {
        const totalAttempts = normalizeAttempts(options.attempts);
        const retryDelayMs = options.retryDelayMs ?? VERISENSE_DFU_RETRY_DELAY_MS;
        for (let attemptsRemaining = totalAttempts;; attemptsRemaining--) {
            try {
                await dfu.update(device, image.initData, image.imageData);
                return;
            }
            catch (error) {
                const transient = VERISENSE_DFU_TRANSIENT_ERROR_REGEX.test(String(error));
                if (attemptsRemaining <= 1 || !transient)
                    throw error;
                const attemptLabel = verisenseDfuAttemptLabel(attemptsRemaining, totalAttempts);
                options.onRetry?.({ stage: 'update', attemptsRemaining, attemptLabel, error });
                options.onStatus?.(`Reconnecting to bootloader (${attemptLabel})...`);
                await delay(retryDelayMs);
            }
        }
    }
    /**
     * `SecureDfu.setDfuMode()` bounded by a timeout and retried on transient
     * errors (DEV-845). setDfuMode (connect + find the buttonless characteristic
     * + startNotifications + write) is where Windows' BLE stack intermittently
     * fails with "GATT operation failed for unknown reason", typically on the
     * first GATT operation after a connect that follows a disconnect. Before each
     * retry the GATT connection is fully torn down so the next attempt starts
     * from a clean link. Protocol errors (e.g. "Unsupported device") are not
     * retried. Resolves like setDfuMode: the device when it is already in
     * bootloader mode, or null after the buttonless reboot command has been sent.
     */
    async function setVerisenseDfuModeWithRetry(dfu, device, options = {}) {
        const totalAttempts = normalizeAttempts(options.attempts);
        const retryDelayMs = options.retryDelayMs ?? VERISENSE_DFU_RETRY_DELAY_MS;
        const timeoutMs = options.setDfuModeTimeoutMs ?? VERISENSE_DFU_SET_MODE_TIMEOUT_MS;
        for (let attemptsRemaining = totalAttempts;; attemptsRemaining--) {
            try {
                const result = await promiseWithTimeout(dfu.setDfuMode(device), timeoutMs, 'Enter DFU mode');
                return result ?? null;
            }
            catch (error) {
                const transient = VERISENSE_DFU_TRANSIENT_ERROR_REGEX.test(String(error));
                if (attemptsRemaining <= 1 || !transient)
                    throw error;
                const attemptLabel = verisenseDfuAttemptLabel(attemptsRemaining, totalAttempts);
                options.onRetry?.({ stage: 'set-dfu-mode', attemptsRemaining, attemptLabel, error });
                options.onStatus?.(`Connection hiccup - retrying (${attemptLabel})...`);
                // Full connection-state reset so the retry starts from a clean link.
                if (device.gatt?.connected) {
                    device.gatt.disconnect();
                }
                await delay(retryDelayMs);
            }
        }
    }
    /**
     * Run a full Verisense DFU transfer from a loaded Nordic DFU package: base
     * image (SoftDevice/bootloader) first when present, then the application
     * image. Resumes interrupted combined updates: a bootloader only installs
     * once per version number, so if a previous (interrupted) attempt already
     * installed this base image the target rejects it with a firmware-version
     * error — that is swallowed and the flow continues to the application image.
     *
     * Progress text is reported via `options.onStatus`; transfer byte progress
     * comes from the `SecureDfu` instance's own "progress" events, which the app
     * subscribes to directly. Rejects with the raw library error on failure (run
     * it through {@link classifyVerisenseDfuError} for display).
     */
    async function runVerisenseDfuUpdate(dfu, device, dfuPackage, options = {}) {
        const rebootDelayMs = options.rebootDelayMs ?? VERISENSE_DFU_REBOOT_DELAY_MS;
        const baseImage = await dfuPackage.getBaseImage();
        if (baseImage) {
            options.onStatus?.(`Updating ${baseImage.type}: ${baseImage.imageFile}...`);
            try {
                await dfu.update(device, baseImage.initData, baseImage.imageData);
                // The base image resets the target on completion; give it time to
                // reboot back into the bootloader before part 2.
                options.onStatus?.('SoftDevice/bootloader installed - device rebooting...');
                await delay(rebootDelayMs);
            }
            catch (error) {
                if (!/firmware version is too low/i.test(String(error)))
                    throw error;
                options.onStatus?.('SoftDevice/bootloader already up to date - continuing with application...');
            }
        }
        const appImage = await dfuPackage.getAppImage();
        if (appImage) {
            options.onStatus?.(`Updating ${appImage.type}: ${appImage.imageFile}...`);
            await updateVerisenseDfuImageWithRetry(dfu, device, appImage, options);
        }
    }

    /**
     * Verisense Nordic Secure-DFU over USB CDC serial (Web Serial).
     *
     * The combined BLE+USB bootloader (v3) exposes Nordic's serial DFU transport
     * on its own USB CDC port (VID 0x1915 / PID 0x521F, product "Verisense DFU"),
     * carrying the same secure-DFU request handler as BLE — same signed `.zip`
     * packages, same object/CRC/execute protocol — but framed with SLIP
     * (RFC 1055) instead of GATT characteristics.
     *
     * This module is self-contained (no dependency on the vendored
     * `web-bluetooth-dfu` scripts): SLIP codec, CRC-32, and the serial secure-DFU
     * state machine. The byte transport is injected structurally and
     * {@link WebSerialTransport} satisfies it directly. Package parsing stays with
     * the vendored `SecureDfuPackage` (see `VerisenseDfuPackage` in `dfu.ts`) —
     * the `initData`/`imageData` buffers it yields are exactly what
     * {@link VerisenseSerialDfu.update} consumes.
     *
     * Flow (mirrors nrfutil's `dfu usb-serial`): ping → PRN 0 → MTU → command
     * object (init packet) → data objects (firmware, `max_size` chunks, each
     * CRC-validated before Execute). Writes carry no per-write response at PRN 0 —
     * USB CDC is a reliable stream — so validation happens per object via CRC_GET.
     * Interrupted transfers resume from the last completed object when the
     * device-reported CRC matches ours.
     */
    // ── SLIP framing (RFC 1055, as used by Nordic's serial DFU) ────────────────
    const SLIP_END = 0xc0;
    const SLIP_ESC = 0xdb;
    const SLIP_ESC_END = 0xdc;
    const SLIP_ESC_ESC = 0xdd;
    /** SLIP-encode one frame (terminating END appended; none prepended, matching
     * Nordic's encoder). */
    function slipEncode(frame) {
        const out = [];
        for (const byte of frame) {
            if (byte === SLIP_END)
                out.push(SLIP_ESC, SLIP_ESC_END);
            else if (byte === SLIP_ESC)
                out.push(SLIP_ESC, SLIP_ESC_ESC);
            else
                out.push(byte);
        }
        out.push(SLIP_END);
        return Uint8Array.from(out);
    }
    /**
     * Streaming SLIP decoder: feed arbitrary chunks, get back completed frames.
     * Empty frames (back-to-back ENDs) are dropped, matching Nordic's decoder.
     */
    class SlipDecoder {
        constructor() {
            this._frame = [];
            this._escaped = false;
        }
        /** Decode a chunk; returns every frame completed by it (possibly none). */
        push(chunk) {
            const frames = [];
            for (const byte of chunk) {
                if (this._escaped) {
                    this._escaped = false;
                    if (byte === SLIP_ESC_END)
                        this._frame.push(SLIP_END);
                    else if (byte === SLIP_ESC_ESC)
                        this._frame.push(SLIP_ESC);
                    // Invalid escape: RFC 1055 leaves the byte in place; keep it so a
                    // corrupt frame fails its response check rather than desyncing.
                    else
                        this._frame.push(byte);
                }
                else if (byte === SLIP_ESC) {
                    this._escaped = true;
                }
                else if (byte === SLIP_END) {
                    if (this._frame.length > 0)
                        frames.push(Uint8Array.from(this._frame));
                    this._frame = [];
                }
                else {
                    this._frame.push(byte);
                }
            }
            return frames;
        }
        reset() {
            this._frame = [];
            this._escaped = false;
        }
    }
    // ── CRC-32 (IEEE 802.3, the polynomial Nordic's DFU uses) ──────────────────
    const CRC32_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
        return table;
    })();
    /** CRC-32 of `data`, continuing from `seed` (pass a previous crc32 result to
     * extend it). Returns an unsigned 32-bit value. */
    function crc32(data, seed = 0) {
        let c = ~seed >>> 0;
        for (let i = 0; i < data.length; i++) {
            c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
        }
        return ~c >>> 0;
    }
    // ── Serial secure-DFU protocol constants ────────────────────────────────────
    /** Request opcodes (identical to the BLE control-point opcodes; over serial,
     * data writes are the explicit OBJECT_WRITE opcode instead of a second
     * characteristic). */
    const SERIAL_DFU_OP = Object.freeze({
        OBJECT_CREATE: 0x01,
        RECEIPT_NOTIF_SET: 0x02,
        CRC_GET: 0x03,
        OBJECT_EXECUTE: 0x04,
        OBJECT_SELECT: 0x06,
        MTU_GET: 0x07,
        OBJECT_WRITE: 0x08,
        PING: 0x09,
        RESPONSE: 0x60,
    });
    const SERIAL_DFU_OBJECT_TYPE = Object.freeze({
        COMMAND: 0x01, // init packet
        DATA: 0x02, // firmware image
    });
    /** Result codes carried in responses (nrf_dfu_response_t). */
    const SERIAL_DFU_RESULT_NAMES = Object.freeze({
        0x00: 'Invalid opcode',
        0x01: 'Success',
        0x02: 'Opcode not supported',
        0x03: 'Invalid parameter',
        0x04: 'Insufficient resources',
        0x05: 'Invalid object',
        0x07: 'Unsupported object type',
        0x08: 'Operation not permitted',
        0x0a: 'Operation failed',
        0x0b: 'Extended error',
    });
    /** Extended-error codes (nrf_dfu_ext_error_code_t) that follow result 0x0B. */
    const SERIAL_DFU_EXTENDED_ERROR_NAMES = Object.freeze({
        0x00: 'No error',
        0x01: 'Invalid error code',
        0x02: 'Wrong command format',
        0x03: 'Unknown command',
        0x04: 'Init command invalid',
        0x05: 'Firmware version too low',
        0x06: 'Hardware version mismatch',
        0x07: 'SoftDevice version mismatch',
        0x08: 'Signature missing',
        0x09: 'Wrong hash type',
        0x0a: 'Hash calculation failed',
        0x0b: 'Wrong signature type',
        0x0c: 'Signature verification failed',
        0x0d: 'Insufficient space',
    });
    /**
     * The v3 bootloader's USB identity in DFU mode. Deliberately distinct from
     * the application's CDC port (0x1915/0x520F) so a Web Serial picker — which
     * can only filter on VID/PID — shows exactly the bootloader.
     */
    const VERISENSE_USB_DFU_VID = 0x1915;
    const VERISENSE_USB_DFU_PID = 0x521f;
    /** `navigator.serial.requestPort()` filters for the bootloader's DFU port. */
    const VERISENSE_USB_DFU_PORT_FILTERS = Object.freeze([
        Object.freeze({ usbVendorId: VERISENSE_USB_DFU_VID, usbProductId: VERISENSE_USB_DFU_PID }),
    ]);
    /**
     * After the firmware ACKs a `DFU_MODE` request received over USB it reboots
     * ~300 ms later (the delay lets the ACK drain), the application port
     * disappears, and the bootloader enumerates as 0x1915/0x521F. Give the OS a
     * moment to enumerate before offering the picker.
     */
    const VERISENSE_USB_DFU_REENUMERATION_DELAY_MS = 2000;
    /**
     * True when a `DFU_MODE` property-write rejection means the unit cannot enter
     * DFU mode from USB: firmware on a BLE-only (v2) bootloader NACKs the request
     * (the reboot would strand the device off the bus until the bootloader's
     * inactivity timeout). The caller should fall back to the BLE DFU flow.
     *
     * Keyed on the DFU_MODE property code (0x6) in the client's NACK message
     * ("Device returned NACK command=0x.. property=0x6", unpadded hex — see
     * `validatePendingResponse` in requestValidation.ts) so NACKs from unrelated
     * requests are never misclassified as "USB DFU unsupported".
     */
    function isUsbDfuUnsupportedError(error) {
        return /NACK.*property=0x0?6\b/i.test(String(error));
    }
    const VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS = 15000;
    const VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS = 3;
    function u16le(value) {
        return [value & 0xff, (value >>> 8) & 0xff];
    }
    function u32le(value) {
        return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
    }
    function readU32le(bytes, offset) {
        return ((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) +
            bytes[offset + 3] * 0x1000000);
    }
    function opcodeName(opcode) {
        for (const [name, value] of Object.entries(SERIAL_DFU_OP)) {
            if (value === opcode)
                return name;
        }
        return `0x${opcode.toString(16)}`;
    }
    /**
     * Nordic secure DFU over a SLIP-framed serial byte stream.
     *
     * One instance drives one transfer session; construct it around a connected
     * transport whose port is the bootloader's DFU port (see
     * {@link VERISENSE_USB_DFU_PORT_FILTERS}) and call {@link update} with the
     * `initData`/`imageData` of each image in the package (base image first when
     * present, application after — same ordering as `runVerisenseDfuUpdate`).
     */
    class VerisenseSerialDfu {
        constructor(transport, options = {}) {
            this._decoder = new SlipDecoder();
            this._pending = null;
            this._unsubscribe = null;
            this._mtu = 0;
            this._transport = transport;
            this._options = options;
        }
        /** Max unencoded bytes per OBJECT_WRITE frame: worst-case SLIP encoding
         * doubles every byte, plus the terminating END, minus the opcode byte
         * (matches nrfutil's `(mtu - 1) // 2 - 1`). */
        get maxWriteSize() {
            return Math.floor((this._mtu - 1) / 2) - 1;
        }
        /**
         * Transfer one image (init packet + firmware binary). Resolves when the
         * final Execute is acknowledged — for an application image that is the
         * point where the bootloader resets to activate it, which also drops the
         * serial port; the caller should expect the port to disappear.
         */
        async update(init, image) {
            if (this._unsubscribe)
                throw new Error('A transfer is already in progress');
            this._decoder.reset();
            this._unsubscribe = this._transport.onNotify((chunk) => this._onData(chunk));
            try {
                await this._handshake();
                await this._transferInit(new Uint8Array(init));
                await this._transferFirmware(new Uint8Array(image));
            }
            finally {
                this._unsubscribe?.();
                this._unsubscribe = null;
                const pending = this._pending;
                this._pending = null;
                pending?.reject(new Error('Transfer closed'));
            }
        }
        // ── protocol steps ────────────────────────────────────────────────────────
        async _handshake() {
            const pingId = Math.floor(Math.random() * 256);
            const pong = await this._request(SERIAL_DFU_OP.PING, [pingId]);
            if (pong.length < 1 || pong[0] !== pingId) {
                throw new Error(`DFU ping mismatch (sent ${pingId}, got ${pong[0] ?? 'nothing'})`);
            }
            // PRN 0: no per-write receipts — USB CDC is reliable; objects are
            // CRC-validated explicitly before Execute.
            await this._request(SERIAL_DFU_OP.RECEIPT_NOTIF_SET, u16le(0));
            const mtuRsp = await this._request(SERIAL_DFU_OP.MTU_GET);
            if (mtuRsp.length < 2)
                throw new Error('DFU MTU response too short');
            this._mtu = mtuRsp[0] | (mtuRsp[1] << 8);
            if (this.maxWriteSize < 1)
                throw new Error(`DFU MTU unusable (${this._mtu})`);
            this._options.onLog?.(`serial DFU ready: mtu=${this._mtu} maxWrite=${this.maxWriteSize}`);
        }
        async _transferInit(init) {
            this._options.onStatus?.('Transferring init packet...');
            const sel = await this._select(SERIAL_DFU_OBJECT_TYPE.COMMAND);
            if (sel.offset === init.length && sel.crc === crc32(init)) {
                // Same init packet already transferred (interrupted attempt): just
                // (re-)execute it.
                this._options.onLog?.('init packet already transferred; executing');
                await this._request(SERIAL_DFU_OP.OBJECT_EXECUTE);
                return;
            }
            if (init.length > sel.maxSize) {
                throw new Error(`Init packet too large (${init.length} > ${sel.maxSize})`);
            }
            await this._request(SERIAL_DFU_OP.OBJECT_CREATE, [
                SERIAL_DFU_OBJECT_TYPE.COMMAND,
                ...u32le(init.length),
            ]);
            await this._writeData(init, 'init', init.length, 0);
            const { offset, crc } = await this._crcGet();
            if (offset !== init.length || crc !== crc32(init)) {
                throw new Error(`Init packet CRC mismatch (offset ${offset}/${init.length}, crc 0x${crc.toString(16)})`);
            }
            await this._request(SERIAL_DFU_OP.OBJECT_EXECUTE);
        }
        async _transferFirmware(image) {
            const sel = await this._select(SERIAL_DFU_OBJECT_TYPE.DATA);
            const attempts = this._options.objectAttempts ?? VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS;
            // Resume: trust the device-reported offset only when our CRC of that
            // prefix matches. The write position cannot be rewound arbitrarily —
            // OBJECT_CREATE always (re)creates at the device's current position, so
            // only the current (unexecuted) object can be rolled back. That is also
            // sufficient: executed objects were CRC-validated before Execute, and
            // executing a *different* image's init packet resets the stored progress
            // to zero, so a mismatch can only live in the unexecuted tail (any deeper
            // corruption surfaces as an object CRC failure below).
            let startOffset = 0;
            if (sel.offset > 0 && sel.offset <= image.length) {
                const prefixMatches = crc32(image.subarray(0, sel.offset)) === sel.crc;
                if (prefixMatches && sel.offset === image.length) {
                    this._options.onLog?.('firmware already transferred; executing');
                    await this._request(SERIAL_DFU_OP.OBJECT_EXECUTE);
                    return;
                }
                if (prefixMatches) {
                    // Partial object: re-create it from its boundary. Boundary offset:
                    // continue with the next object.
                    startOffset = sel.offset - (sel.offset % sel.maxSize);
                }
                else {
                    const remainder = sel.offset % sel.maxSize;
                    startOffset =
                        sel.offset - (remainder !== 0 ? remainder : Math.min(sel.maxSize, sel.offset));
                    this._options.onLog?.(`device-reported firmware CRC mismatch at ${sel.offset}; rolling back to ${startOffset}`);
                }
                if (startOffset > 0) {
                    this._options.onStatus?.(`Resuming firmware transfer at ${startOffset} bytes...`);
                }
            }
            this._options.onStatus?.('Transferring firmware image...');
            this._options.onProgress?.({
                object: 'firmware',
                totalBytes: image.length,
                currentBytes: startOffset,
            });
            for (let offset = startOffset; offset < image.length; offset += sel.maxSize) {
                const chunk = image.subarray(offset, Math.min(offset + sel.maxSize, image.length));
                let lastError = null;
                let done = false;
                for (let attempt = 1; attempt <= attempts && !done; attempt++) {
                    if (attempt > 1) {
                        this._options.onLog?.(`re-sending object at ${offset} (attempt ${attempt} of ${attempts})`);
                    }
                    await this._request(SERIAL_DFU_OP.OBJECT_CREATE, [
                        SERIAL_DFU_OBJECT_TYPE.DATA,
                        ...u32le(chunk.length),
                    ]);
                    await this._writeData(chunk, 'firmware', image.length, offset);
                    const { offset: devOffset, crc } = await this._crcGet();
                    const expectedCrc = crc32(image.subarray(0, offset + chunk.length));
                    if (devOffset === offset + chunk.length && crc === expectedCrc) {
                        await this._request(SERIAL_DFU_OP.OBJECT_EXECUTE);
                        done = true;
                    }
                    else {
                        lastError = new Error(`Object CRC mismatch at ${offset} (device offset ${devOffset}, crc 0x${crc.toString(16)})`);
                    }
                }
                if (!done)
                    throw lastError ?? new Error(`Object transfer failed at ${offset}`);
            }
            this._options.onStatus?.('Firmware transfer complete.');
        }
        // ── plumbing ──────────────────────────────────────────────────────────────
        async _writeData(data, object, totalBytes, baseOffset) {
            const sliceSize = this.maxWriteSize;
            for (let pos = 0; pos < data.length; pos += sliceSize) {
                const slice = data.subarray(pos, Math.min(pos + sliceSize, data.length));
                const frame = new Uint8Array(1 + slice.length);
                frame[0] = SERIAL_DFU_OP.OBJECT_WRITE;
                frame.set(slice, 1);
                await this._transport.write(slipEncode(frame));
                this._options.onProgress?.({
                    object,
                    totalBytes,
                    currentBytes: baseOffset + pos + slice.length,
                });
            }
        }
        async _select(objectType) {
            const rsp = await this._request(SERIAL_DFU_OP.OBJECT_SELECT, [objectType]);
            if (rsp.length < 12)
                throw new Error('DFU select response too short');
            return { maxSize: readU32le(rsp, 0), offset: readU32le(rsp, 4), crc: readU32le(rsp, 8) };
        }
        async _crcGet() {
            const rsp = await this._request(SERIAL_DFU_OP.CRC_GET);
            if (rsp.length < 8)
                throw new Error('DFU CRC response too short');
            return { offset: readU32le(rsp, 0), crc: readU32le(rsp, 4) };
        }
        _request(opcode, params = [], timeoutMs) {
            if (this._pending) {
                return Promise.reject(new Error('A DFU request is already pending'));
            }
            const effectiveTimeout = timeoutMs ?? this._options.requestTimeoutMs ?? VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS;
            const frame = new Uint8Array(1 + params.length);
            frame[0] = opcode;
            frame.set(params instanceof Uint8Array ? params : Uint8Array.from(params), 1);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this._pending = null;
                    reject(new Error(`DFU ${opcodeName(opcode)} timed out after ${effectiveTimeout}ms`));
                }, effectiveTimeout);
                this._pending = {
                    opcode,
                    resolve: (payload) => {
                        clearTimeout(timer);
                        this._pending = null;
                        resolve(payload);
                    },
                    reject: (error) => {
                        clearTimeout(timer);
                        this._pending = null;
                        reject(error);
                    },
                };
                this._transport.write(slipEncode(frame)).catch((error) => {
                    this._pending?.reject(new Error(`DFU ${opcodeName(opcode)} write failed: ${error}`));
                });
            });
        }
        _onData(chunk) {
            for (const frame of this._decoder.push(chunk)) {
                const pending = this._pending;
                if (!pending) {
                    this._options.onLog?.(`unexpected DFU frame (${frame.length} bytes) with no request`);
                    continue;
                }
                if (frame.length < 3 || frame[0] !== SERIAL_DFU_OP.RESPONSE || frame[1] !== pending.opcode) {
                    this._options.onLog?.(`ignoring DFU frame [${Array.from(frame.slice(0, 4))
                    .map((b) => `0x${b.toString(16)}`)
                    .join(', ')}...] while waiting for ${opcodeName(pending.opcode)}`);
                    continue;
                }
                const result = frame[2];
                if (result === 0x01) {
                    pending.resolve(frame.subarray(3));
                    continue;
                }
                let message = SERIAL_DFU_RESULT_NAMES[result] ?? `Unknown result 0x${result.toString(16)}`;
                if (result === 0x0b && frame.length >= 4) {
                    const ext = frame[3];
                    message = `${SERIAL_DFU_EXTENDED_ERROR_NAMES[ext] ?? `Extended error 0x${ext.toString(16)}`}`;
                }
                pending.reject(new Error(`DFU ${opcodeName(pending.opcode)} failed: ${message}`));
            }
        }
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
     * 2nd-generation catalog (LSM6DSV accel+gyro, LIS2DW12, LIS2MDL). Common frame
     * +X=strap, +Y=out of face, +Z=toward hand. LSM6DSV / LIS2DW12 are proper
     * rotations (det +1); the LIS2MDL frame is left-handed (det −1, a reflection).
     *
     * The LIS2DW12 matrix comes from the ST datasheet axis figures + the SR68-10
     * pin-1 placement. LSM6DSV and LIS2MDL were derived the same way originally but
     * that derivation did not survive measurement — they carry the empirically
     * validated values instead (an SR61-5 recording cross-checked against a
     * Shimmer3R logging the same motion; ASM_PC_00005 Test_063). One matrix per
     * sensor covers every gen-2 board.
     *
     * Byte-for-byte in sync with the firmware seed (asm_calibration.c) and
     * VERISENSE_CALIBRATION.md §4 — verified as of the format v2 bump.
     */
    const CALIBRATION_SENSORS_GEN2 = [
        {
            id: CalibSensorId.LSM6DSV_ACCEL,
            label: 'Accelerometer (LSM6DSV)',
            unit: 'LSB/(m/s²)',
            align: [0, 1, 0, 0, 0, 1, 1, 0, 0],
            ranges: ACCEL_RANGES,
        },
        {
            id: CalibSensorId.LSM6DSV_GYRO,
            label: 'Gyroscope (LSM6DSV)',
            unit: 'LSB/dps',
            align: [0, 1, 0, 0, 0, 1, 1, 0, 0],
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
            align: [1, 0, 0, 0, 0, 1, 0, 1, 0],
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

    /** The firmware release that renumbered the tests. */
    const RENUMBER_VERSION = { major: 2, minor: 0, internal: 10 };
    /**
     * Line starts that may appear glued onto the end of a previous line.
     *
     * The firmware assembles each line in a shared 128-byte buffer, and the
     * WS_TEST_0003 WARNING text is longer than that: `snprintf` truncates it and
     * the trailing CRLF is lost, so whatever is written next runs straight on. We
     * re-split on these anchors and note the repair.
     */
    const REPAIR_ANCHORS = [
        / - WS_TEST_\d{4} - /g,
        /LED test \(WS_TEST_\d{4}\):/g,
        /(?:MCU|I\/O status|Battery|Shimmer model|TWIM0|TWIM1 \(part ?\d\)|SPIM2|SPIM3):/g,
        /Overall Result\s*=/g,
        /\/\/\*+/g,
    ];
    /**
     * Matched in order against the text following the `WS_TEST_00NN` prefix; first
     * hit wins. Every pattern keys on wording the firmware has printed stably
     * across the renumbering, not on the test number.
     */
    const CLASSIFIERS = [
        {
            name: 'vcore',
            label: 'VCore',
            match: /VCore/i,
            extract: (body, out) => {
                const m = /VCore\s*=\s*(-?\d+)\s*mV(?:\s*\(\s*(\d+)\s*-\s*(\d+)\s*mV\s*\))?/i.exec(body);
                if (!m)
                    return;
                setNum(out, 'vcore_mv', m[1]);
                setNum(out, 'vcore_limit_low_mv', m[2]);
                setNum(out, 'vcore_limit_high_mv', m[3]);
            },
        },
        {
            name: 'mcu_temp',
            label: 'MCU temperature',
            match: /Temperature\s*=\s*-?\d/i,
            extract: (body, out) => {
                setNum(out, 'mcu_temp_c', /Temperature\s*=\s*(-?\d+)/i.exec(body)?.[1]);
            },
        },
        {
            name: 'lfclk',
            label: 'LF crystal',
            match: /LF crystal/i,
            extract: (body, out) => {
                setNum(out, 'lfclk_ppm', /error\s*=\s*([+-]?\d+(?:\.\d+)?)\s*ppm/i.exec(body)?.[1]);
                setNum(out, 'lfclk_s_per_day', /\(\s*([+-]?\d+(?:\.\d+)?)\s*s\/day\s*\)/i.exec(body)?.[1]);
                setNum(out, 'lfclk_limit_ppm', /limit\s*\+\/-\s*(\d+(?:\.\d+)?)\s*ppm/i.exec(body)?.[1]);
                setStr(out, 'lfclk_src', /LFCLK\s*src\s*=\s*([A-Za-z]+)/i.exec(body)?.[1]);
                setStr(out, 'lfclk_fail_reason', /not measurable\s*\(([^,)]+)/i.exec(body)?.[1]);
            },
        },
        {
            name: 'usb_power',
            label: 'USB power good',
            match: /USB (?:power good|not applicable)/i,
            extract: (body, out) => {
                const m = /USB power good\s*:\s*(Yes|No)/i.exec(body);
                if (m)
                    out.usb_power_good = /yes/i.test(m[1]);
            },
        },
        { name: 'eeprom', label: 'CAT24M01 EEPROM', match: /EEPROM/i },
        {
            name: 'model',
            label: 'Shimmer model',
            match: /production config|^\s*(?:PASS|FAIL)\s*$/i,
        },
        {
            name: 'battery',
            label: 'VBatt',
            match: /VBatt/i,
            resultKey: 'vbatt_result',
            extract: (body, out) => {
                const m = /VBatt\s*=\s*(-?\d+)\s*mV(?:\s*\(\s*(\d+)\s*-\s*(\d+)\s*mV\s*\))?/i.exec(body);
                if (m) {
                    setNum(out, 'vbatt_mv', m[1]);
                    setNum(out, 'vbatt_limit_low_mv', m[2]);
                    setNum(out, 'vbatt_limit_high_mv', m[3]);
                }
                // Percentage is only printed when the unit is not charging.
                setNum(out, 'batt_pct', /,\s*(\d+)\s*%/.exec(body)?.[1]);
            },
        },
        {
            name: 'charger',
            label: 'Charger status',
            match: /Charger/i,
            extract: (body, out) => {
                setStr(out, 'charger_status', /Charger status\s*:\s*(.+?)\s*$/i.exec(body)?.[1]);
            },
        },
        {
            name: 'light',
            label: 'VD6283TX Light sensor',
            match: /VD6283|Light sensor/i,
            extract: (body, out) => {
                setNum(out, 'lux', /([\d.]+)\s*Lux/i.exec(body)?.[1]);
                setNum(out, 'cct_k', /CCT\s*:\s*(\d+)\s*K/i.exec(body)?.[1]);
                const flicker = /Flicker\s*:\s*([\d.]+)\s*Hz\s*,\s*(\d+)\s*%\s*mod/i.exec(body);
                if (flicker) {
                    setNum(out, 'flicker_hz', flicker[1]);
                    setNum(out, 'flicker_mod_pct', flicker[2]);
                    out.flicker_status = 'detected';
                }
                else if (/Flicker\s*:\s*link OK/i.test(body)) {
                    out.flicker_status = 'link_ok_none_detected';
                }
                else if (/Flicker\s*:\s*FAIL\s*-\s*no signal/i.test(body)) {
                    out.flicker_status = 'no_signal';
                }
                else if (/Flicker\s*:\s*FAIL\s*-\s*no capture/i.test(body)) {
                    out.flicker_status = 'no_capture';
                }
            },
        },
        {
            name: 'skin_temp',
            label: 'Thermal sensor',
            // The firmware prints MLX90640; the part actually fitted is an MLX90632.
            match: /MLX906|Thermal sensor/i,
            extract: (body, out) => {
                setNum(out, 'mlx_ambient_c', /Ambient\s*=\s*(-?\d+)/i.exec(body)?.[1]);
                setNum(out, 'mlx_object_c', /Object\s*=\s*(-?\d+)/i.exec(body)?.[1]);
            },
        },
        {
            name: 'algo_hub',
            label: 'MAX32674C Algorithm hub',
            match: /MAX32674|Algorithm hub/i,
            resultKey: 'hub_result',
            extract: (body, out) => {
                setStr(out, 'hub_fw_version', /\(\s*v([\d.]+)\s*\)/i.exec(body)?.[1]);
                if (/Incorrect FW/i.test(body))
                    out.hub_fail_reason = 'incorrect_fw';
                else if (/bootloader mode/i.test(body))
                    out.hub_fail_reason = 'bootloader_mode';
                else if (/not responding/i.test(body))
                    out.hub_fail_reason = 'not_responding';
                else if (/not detected/i.test(body))
                    out.hub_fail_reason = 'not_detected';
            },
        },
        {
            name: 'ppg_afe',
            label: 'MAX86176 Pulse oximeter',
            match: /MAX86|Pulse oximeter/i,
            extract: (body, out) => chipDetail(body, out, 'ppg_afe'),
        },
        {
            name: 'accel2',
            label: 'LIS2DW12 Accelerometer',
            match: /LIS2DW12/i,
            extract: (body, out) => chipDetail(body, out, 'accel2'),
        },
        {
            name: 'imu',
            label: 'IMU',
            match: /LSM6DS/i,
            extract: (body, out) => chipDetail(body, out, 'imu'),
        },
        {
            name: 'mag',
            label: 'LIS2MDL Magnetometer',
            match: /LIS2MDL/i,
            extract: (body, out) => chipDetail(body, out, 'mag'),
        },
        {
            name: 'nand_health',
            label: 'NAND health test',
            match: /NAND health/i,
        },
        {
            name: 'nand',
            label: 'Main flash test',
            match: /Main flash test|read flash device ID/i,
        },
        { name: 'stf1', label: 'STF1 Flash test', match: /STF1/i },
        { name: 'stf2', label: 'STF2 Flash test', match: /STF2/i },
        { name: 'led', label: 'LED test', match: /LED test/i },
    ];
    /** Shared shape of the IMU-class self-test lines: optional temperature in
     * parentheses plus an optional failure-reason suffix. */
    function chipDetail(body, out, prefix) {
        setNum(out, `${prefix}_temp_c`, /\(\s*(-?\d+)\s*°?\s*C\s*\)/i.exec(body)?.[1]);
        const reason = /-\s*(Chip not detected|Signal issue|Temperature issue|DRDY\/INT issue|Unknown)/i.exec(body)?.[1];
        if (reason)
            out[`${prefix}_fail_reason`] = reason.trim();
    }
    function num(value) {
        if (value == null || value === '')
            return undefined;
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
    }
    function setNum(out, key, value) {
        const n = num(value);
        if (n !== undefined)
            out[key] = n;
    }
    function setStr(out, key, value) {
        const s = value?.trim();
        if (s)
            out[key] = s;
    }
    /**
     * Fold the several ways a degree sign can reach us into a single `°`.
     *
     * The firmware emits a bare `0xB0` on some builds and UTF-8 `0xC2 0xB0` on
     * others; depending on how the transport decoded the bytes we see `°`, the
     * mojibake `Â°`, or the Unicode replacement character.
     */
    function normalizeReportText(text) {
        return String(text ?? '')
            .replace(/Â°/g, '°')
            .replace(/�/g, '°');
    }
    /** Split into lines, dropping the NAND health progress dots and re-splitting
     * lines that the firmware's 128-byte buffer glued together. */
    function toLines(text, warnings) {
        const out = [];
        let stripped = 0;
        for (const raw of text.split(/\r\n|\r|\n/)) {
            // The NAND health test streams bare dots to keep the host's idle timer
            // alive; they arrive with no newline of their own.
            if (/^[.\s]*$/.test(raw) && /\./.test(raw)) {
                stripped += 1;
                continue;
            }
            const line = raw.replace(/\.{3,}\s*$/, '');
            for (const piece of repairLine(line, warnings)) {
                if (piece.trim())
                    out.push(piece);
            }
        }
        if (stripped)
            warnings.push(`stripped ${stripped} progress-dot line(s)`);
        return out;
    }
    /** Re-split one physical line wherever a known line start appears mid-line. */
    function repairLine(line, warnings) {
        let earliest = -1;
        for (const anchor of REPAIR_ANCHORS) {
            anchor.lastIndex = 0;
            let m;
            while ((m = anchor.exec(line)) !== null) {
                if (m.index > 0 && (earliest < 0 || m.index < earliest))
                    earliest = m.index;
            }
        }
        if (earliest <= 0)
            return [line];
        warnings.push(`repaired a line truncated by the firmware buffer near column ${earliest}`);
        const head = line.slice(0, earliest);
        return [head, ...repairLine(line.slice(earliest), warnings)];
    }
    /** Read the verdict keyword, if any, off the text following the test id. */
    function readVerdict(body) {
        const m = /^\s*(PASS|FAIL|WARNING)\b/i.exec(body);
        if (m)
            return m[1].toUpperCase();
        if (/not applicable/i.test(body))
            return 'NOT_APPLICABLE';
        if (body.trim())
            return 'INFO';
        return 'UNKNOWN';
    }
    /** Derive the numbering scheme from the reported firmware version. */
    function readIdScheme(version) {
        if (!version)
            return 'unknown';
        const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
        if (!m)
            return 'unknown';
        const triple = {
            major: Number(m[1]),
            minor: Number(m[2]),
            internal: Number(m[3]),
        };
        return compareVerisenseFirmwareVersion(triple, RENUMBER_VERSION) >= 0 ? 'v2_00_010' : 'legacy';
    }
    function emptyResult() {
        return {
            ok: false,
            complete: false,
            firmwareVersion: null,
            idScheme: 'unknown',
            overall: { result: null, failMaskHex: null, failMask: null, failedTestNames: [] },
            mcu: {
                macId: null,
                deviceId: null,
                part: null,
                variant: null,
                lastResetHex: null,
                lastResetReasons: null,
                bootCount: null,
            },
            model: null,
            tests: [],
            metrics: {},
            unparsedLines: [],
            parserWarnings: [],
        };
    }
    /**
     * Parse a full factory test report into structured metrics.
     *
     * Never throws: malformed or unrecognized input comes back with `ok: false`
     * and/or its lines preserved in `unparsedLines`.
     */
    function parseVerisenseFactoryTestReport(text) {
        const result = emptyResult();
        try {
            parseInto(normalizeReportText(text), result);
        }
        catch (err) {
            result.parserWarnings.push(`parser error: ${String(err?.message ?? err)}`);
        }
        return result;
    }
    function parseInto(text, result) {
        const warnings = result.parserWarnings;
        const lines = toLines(text, warnings);
        const metrics = result.metrics;
        /** Canonical name of the test each printed id was seen against, so the fail
         * mask can be decoded under whichever numbering this report used. */
        const nameById = new Map();
        let ledSeen = 0;
        /** Held in an object so the assignment inside `pushTest` stays visible to
         * the type checker at every use site. */
        const open = { test: null };
        const pushTest = (test) => {
            result.tests.push(test);
            if (test.id != null)
                nameById.set(test.id, test.name);
            open.test = test;
        };
        const addDetail = (line) => {
            const test = open.test;
            if (!test)
                return;
            test.detail = test.detail ? `${test.detail} | ${line.trim()}` : line.trim();
        };
        for (const line of lines) {
            const trimmed = line.trim();
            if (/TEST START/.test(trimmed)) {
                result.ok = true;
                continue;
            }
            if (/TEST END/.test(trimmed)) {
                result.complete = true;
                continue;
            }
            const fw = /^Firmware version\s*:\s*v?([\d.]+)/i.exec(trimmed);
            if (fw) {
                result.firmwareVersion = fw[1];
                result.idScheme = readIdScheme(fw[1]);
                metrics.fw_version = fw[1];
                continue;
            }
            const range = /Temperature pass range set to\s*(-?\d+)\s*-\s*(-?\d+)/i.exec(trimmed);
            if (range) {
                setNum(metrics, 'temp_range_low_c', range[1]);
                setNum(metrics, 'temp_range_high_c', range[2]);
                continue;
            }
            const overall = /^Overall Result\s*=\s*(PASS|FAIL)(?:\s*\(\s*(0x[0-9A-Fa-f]+)\s*\))?/i.exec(trimmed);
            if (overall) {
                result.overall.result = overall[1].toUpperCase();
                metrics.overall_result = result.overall.result;
                if (overall[2]) {
                    result.overall.failMaskHex = overall[2].toUpperCase().replace('0X', '0x');
                    result.overall.failMask = Number.parseInt(overall[2], 16);
                    metrics.fail_mask_hex = result.overall.failMaskHex;
                }
                continue;
            }
            // Section headers (`MCU:`, `SPIM3:` …) carry no data but end the previous
            // test's sub-line run.
            if (/^(?:MCU|I\/O status|Battery|Shimmer model|TWIM0|TWIM1 \(part ?\d\)|SPIM2|SPIM3)\s*:$/i.test(trimmed)) {
                open.test = null;
                continue;
            }
            if (readMcuHeaderLine(trimmed, result, metrics))
                continue;
            // `LED test (WS_TEST_0019):` — the first such block is the operational
            // status LED, the second the battery LED. Ordering survives renumbering.
            const ledHeader = /^LED test\s*\(\s*WS_TEST_(\d{4})\s*\)\s*:/i.exec(trimmed);
            if (ledHeader) {
                const name = ledSeen === 0 ? 'led_status' : 'led_batt';
                ledSeen += 1;
                pushTest({
                    id: Number(ledHeader[1]),
                    name,
                    label: name === 'led_status' ? 'LED test - operational status' : 'LED test - battery status',
                    verdict: 'INFO',
                    detail: '',
                    metrics: {},
                });
                // Deliberately no `<name>_result` metric: an INFO verdict carries no
                // data (the LED test is operator-visual narration), and which suite ran
                // is already recorded by the caller's factory-test-type column. The
                // verdict is still on the tests[] entry for anyone who wants it.
                continue;
            }
            const idLine = /^-?\s*WS_TEST_(\d{4})\s*-\s*(.*)$/i.exec(trimmed.replace(/^-\s*/, '- '));
            if (idLine) {
                const id = Number(idLine[1]);
                const body = idLine[2] ?? '';
                const verdict = readVerdict(body);
                const classifier = CLASSIFIERS.find((c) => c.match.test(body));
                let name = classifier?.name ?? `ws_test_${idLine[1]}`;
                let label = classifier?.label ?? `WS_TEST_${idLine[1]}`;
                if (name === 'led') {
                    // Not-applicable LED lines come through the id path rather than as a
                    // `LED test (…):` header.
                    name = ledSeen === 0 ? 'led_status' : 'led_batt';
                    label =
                        name === 'led_status' ? 'LED test - operational status' : 'LED test - battery status';
                    ledSeen += 1;
                }
                const testMetrics = {};
                classifier?.extract?.(body, testMetrics);
                if (!classifier)
                    scrapeGenericMetrics(body, name, testMetrics);
                // A verdict column is only worth a spreadsheet cell when it can vary:
                // PASS/FAIL/WARNING record an outcome and NOT_APPLICABLE records a
                // model gate, but INFO just means "an informational line printed" — its
                // substance is already in that line's own metrics (usb_power_good,
                // charger_status, ...), so emitting it would waste a column per test.
                if (verdict !== 'INFO') {
                    const resultKey = classifier?.resultKey ?? `${name}_result`;
                    testMetrics[resultKey] = verdict;
                }
                pushTest({ id, name, label, verdict, detail: body.trim(), metrics: testMetrics });
                Object.assign(metrics, testMetrics);
                continue;
            }
            if (readSubLine(trimmed, result, metrics, open.test, addDetail))
                continue;
            // LED narration (`- All LEDs off`, `- Left Red LED on`) belongs to the LED
            // test currently open.
            if (open.test && /^-\s*(All|Left|Right)\b.*LED/i.test(trimmed)) {
                addDetail(trimmed.replace(/^-\s*/, ''));
                continue;
            }
            result.unparsedLines.push(line);
        }
        // Decode the fail mask through the ids this report actually used.
        if (result.overall.failMask != null) {
            const names = [];
            for (let bit = 0; bit < 32; bit += 1) {
                if (!(result.overall.failMask & (1 << bit)))
                    continue;
                const id = bit + 1;
                names.push(nameById.get(id) ?? `ws_test_${String(id).padStart(4, '0')}`);
            }
            result.overall.failedTestNames = names;
        }
    }
    /** MCU identification lines printed above the first test. */
    function readMcuHeaderLine(trimmed, result, metrics) {
        const mac = /^-?\s*MAC ID\s*:\s*([0-9A-Fa-f]+)/.exec(trimmed);
        if (mac) {
            result.mcu.macId = mac[1].toUpperCase();
            // Named ble_mac, not mac_id: this is the full 12-hex BLE MAC from the
            // report, distinct from the production config's 4-hex "MAC ID" suffix that
            // callers pass as a mac_id meta column. Sharing the name collided the two.
            metrics.ble_mac = result.mcu.macId;
            return true;
        }
        const dev = /^Device ID\s*:\s*(\S+)/i.exec(trimmed);
        if (dev) {
            result.mcu.deviceId = dev[1];
            metrics.device_id = dev[1];
            return true;
        }
        const part = /^Part\s*:\s*(\S+?)\s*,\s*Variant\s*:\s*(\S+)/i.exec(trimmed);
        if (part) {
            result.mcu.part = part[1];
            result.mcu.variant = part[2];
            metrics.mcu_part = part[1];
            metrics.mcu_variant = part[2];
            return true;
        }
        const reset = /^Last reset\s*:\s*(0x[0-9A-Fa-f]+)\s*(.*?)\s*,\s*boot count\s*=\s*(\d+)/i.exec(trimmed);
        if (reset) {
            result.mcu.lastResetHex = reset[1];
            result.mcu.lastResetReasons = reset[2].replace(/^\(|\)$/g, '').trim() || null;
            result.mcu.bootCount = Number(reset[3]);
            metrics.last_reset_hex = reset[1];
            if (result.mcu.lastResetReasons)
                metrics.last_reset_reasons = result.mcu.lastResetReasons;
            setNum(metrics, 'boot_count', reset[3]);
            return true;
        }
        return false;
    }
    /**
     * Indented continuation lines, dispatched on their own wording rather than on
     * which test is open. A value always lands in the GLOBAL metrics map under its
     * own name, so the flat map is correct even when the parent line went missing;
     * it is additionally attached to the currently open test's entry when one
     * exists, so a stray sub-line after an unrelated test would show up on that
     * test's `metrics`/`detail` (the tests[] attachment is best-effort context,
     * not the source of truth).
     */
    function readSubLine(trimmed, result, metrics, current, addDetail) {
        const put = (key, value) => {
            metrics[key] = value;
            if (current)
                current.metrics[key] = value;
        };
        // --- Shimmer model block ---
        const name = /^Name\s*:\s*(.+?)(?:\s*\(\s*(SR[\d-]+)\s*\))?\s*$/i.exec(trimmed);
        if (name) {
            result.model ?? (result.model = emptyModel());
            result.model.name = name[1].trim();
            put('model_name', result.model.name);
            if (name[2]) {
                result.model.srRevision = name[2];
                put('model_sr_revision', name[2]);
            }
            addDetail(trimmed);
            return true;
        }
        const mo = /^Manufacturing Order\s*\|\s*MAC\s*:\s*([0-9A-Fa-f]+)\s*\|\s*([0-9A-Fa-f]+)/i.exec(trimmed);
        if (mo) {
            result.model ?? (result.model = emptyModel());
            result.model.manufacturingOrder = mo[1].toUpperCase();
            result.model.macSuffix = mo[2].toUpperCase();
            put('model_mo', result.model.manufacturingOrder);
            put('model_mac_suffix', result.model.macSuffix);
            addDetail(trimmed);
            return true;
        }
        const advPrefix = /^Advertising Prefix\s*:\s*(.+?)\s*$/i.exec(trimmed);
        if (advPrefix) {
            result.model ?? (result.model = emptyModel());
            result.model.advertisingPrefix = advPrefix[1];
            put('adv_prefix', advPrefix[1]);
            addDetail(trimmed);
            return true;
        }
        const passkeyId = /^Passkey ID\s*:\s*(\S+)\s*(?:\(([^)]*)\))?/i.exec(trimmed);
        if (passkeyId) {
            result.model ?? (result.model = emptyModel());
            result.model.passkeyId = passkeyId[1];
            put('passkey_id', passkeyId[1]);
            if (passkeyId[2]) {
                result.model.passkeyKind = passkeyId[2].trim();
                put('passkey_kind', result.model.passkeyKind);
            }
            addDetail(trimmed);
            return true;
        }
        // The passkey value itself is a device secret — record only that one is set.
        if (/^Passkey\s*:/i.test(trimmed)) {
            addDetail('Passkey: (not recorded)');
            return true;
        }
        // --- Main flash geometry ---
        const manufacturer = /^Manufacturer\s*=\s*(.+?)\s*$/i.exec(trimmed);
        if (manufacturer) {
            put('nand_manufacturer', manufacturer[1]);
            addDetail(trimmed);
            return true;
        }
        const model = /^Model\s*=\s*(.+?)\s*$/i.exec(trimmed);
        if (model) {
            put('nand_model', model[1]);
            addDetail(trimmed);
            return true;
        }
        const size = /^Size\s*=\s*(\d+)\s*MB/i.exec(trimmed);
        if (size) {
            put('nand_size_mb', Number(size[1]));
            addDetail(trimmed);
            return true;
        }
        // --- NAND health ---
        const census = /^Bad-block census\s*=\s*(\d+)\s*of\s*(\d+)\s*\(\s*limit\s*(\d+)\s*\)/i.exec(trimmed);
        if (census) {
            put('nand_bad_blocks', Number(census[1]));
            put('nand_bad_block_total', Number(census[2]));
            put('nand_bad_block_limit', Number(census[3]));
            addDetail(trimmed);
            return true;
        }
        const stress = /^Stress\s*=\s*(\d+)\s*blocks\s*\/\s*(\d+)\s*page checks(?:\s*\(\s*(\d+)\s*sampled blocks skipped bad\s*\))?/i.exec(trimmed);
        if (stress) {
            put('nand_stress_blocks', Number(stress[1]));
            put('nand_page_checks', Number(stress[2]));
            if (stress[3] != null)
                put('nand_blocks_skipped', Number(stress[3]));
            addDetail(trimmed);
            return true;
        }
        const pages = /^Corrupt pages\s*=\s*(\d+)\s*,\s*unstable pages\s*=\s*(\d+)\s*,\s*erase\/write fails\s*=\s*(\d+)\s*\/\s*(\d+)/i.exec(trimmed);
        if (pages) {
            put('nand_corrupt_pages', Number(pages[1]));
            put('nand_unstable_pages', Number(pages[2]));
            put('nand_erase_write_fails', `${pages[3]}/${pages[4]}`);
            addDetail(trimmed);
            return true;
        }
        // Progress line for the health test; the verdict follows separately.
        if (/^NAND health\s*:/i.test(trimmed))
            return true;
        return false;
    }
    function emptyModel() {
        return {
            name: null,
            srRevision: null,
            manufacturingOrder: null,
            macSuffix: null,
            advertisingPrefix: null,
            passkeyId: null,
            passkeyKind: null,
        };
    }
    /**
     * Fallback for a test this build of the SDK has never seen: keep any
     * `Key = value` pairs so a firmware change still lands data in the sheet.
     */
    function scrapeGenericMetrics(body, name, out) {
        const re = /([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*=\s*([-+]?\d+(?:\.\d+)?)/g;
        let m;
        while ((m = re.exec(body)) !== null) {
            const key = `${name}_${m[1]
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')}`;
            setNum(out, key, m[2]);
        }
    }
    /**
     * Render a parsed report as two CSV rows (header, values): the caller's `meta`
     * columns first, then the parsed metrics sorted by name. A metric whose name
     * collides with a meta column is dropped in favour of the meta value — the
     * caller's identity columns are authoritative, and a duplicated header name
     * breaks most CSV consumers.
     */
    function verisenseFactoryTestReportToCsvRows(parsed, meta = {}) {
        // Normalized once and used for both key discovery and value lookup, so a
        // null/undefined `parsed` from a plain-JS caller cannot throw here.
        const metrics = parsed?.metrics ?? {};
        const metaKeys = Object.keys(meta);
        const metaKeySet = new Set(metaKeys);
        const metricKeys = Object.keys(metrics)
            .filter((k) => !metaKeySet.has(k))
            .sort();
        const header = [...metaKeys, ...metricKeys].map(csvCell).join(',');
        const values = [...metaKeys.map((k) => meta[k]), ...metricKeys.map((k) => metrics[k])]
            .map(csvCell)
            .join(',');
        return [header, values];
    }

    exports.ASM_COMMAND = ASM_COMMAND;
    exports.ASM_PROPERTY = ASM_PROPERTY;
    exports.BASE_HARDWARE_IDS = BASE_HARDWARE_IDS;
    exports.BLE_LINK_MIN_FW = BLE_LINK_MIN_FW;
    exports.BRAND_BLE_MAX_CHARS = BRAND_BLE_MAX_CHARS;
    exports.BRAND_BLE_MAX_CHARS_SHIMMER3 = BRAND_BLE_MAX_CHARS_SHIMMER3;
    exports.BRAND_BT_CLASSIC_MAX_CHARS = BRAND_BT_CLASSIC_MAX_CHARS;
    exports.BRAND_PLATFORM = BRAND_PLATFORM;
    exports.BRAND_RECORD_HOST_OFFSET = BRAND_RECORD_HOST_OFFSET;
    exports.BRAND_RECORD_LAYOUT_VER = BRAND_RECORD_LAYOUT_VER;
    exports.BRAND_RECORD_MAGIC = BRAND_RECORD_MAGIC;
    exports.BRAND_RECORD_SIZE = BRAND_RECORD_SIZE;
    exports.BRAND_USB_MANUFACTURER_MAX_CHARS = BRAND_USB_MANUFACTURER_MAX_CHARS;
    exports.BRAND_USB_PRODUCT_MAX_CHARS = BRAND_USB_PRODUCT_MAX_CHARS;
    exports.BT_FEATURE = BT_FEATURE;
    exports.BaseShimmerClient = BaseShimmerClient;
    exports.CALIB_READ_SOURCE = CALIB_READ_SOURCE;
    exports.CHANNEL_FORMATS = CHANNEL_FORMATS;
    exports.CHARGING_STATUS_BYTE = CHARGING_STATUS_BYTE;
    exports.CONSENSYS_UNKNOWN_DEVICE = CONSENSYS_UNKNOWN_DEVICE;
    exports.CalibQuality = CalibQuality;
    exports.CalibSensorId = CalibSensorId;
    exports.DEBUG_COMMAND_ID = DEBUG_COMMAND_ID;
    exports.FW_ID = FW_ID;
    exports.GSR_NAME = GSR_NAME;
    exports.INERTIAL_UNITS = INERTIAL_UNITS;
    exports.INFOMEM_ADDR_FLAT = INFOMEM_ADDR_FLAT;
    exports.INFOMEM_ADDR_LEGACY = INFOMEM_ADDR_LEGACY;
    exports.INFOMEM_ANY_VERSION = ANY_VERSION;
    exports.INFOMEM_FW_ID = FW_ID$1;
    exports.INFOMEM_HW_ID = HW_ID;
    exports.INFOMEM_PAGE_SIZE = INFOMEM_PAGE_SIZE;
    exports.INFOMEM_SAMPLING_CLOCK_FREQ = INFOMEM_SAMPLING_CLOCK_FREQ;
    exports.INFOMEM_SIZE = INFOMEM_SIZE;
    exports.INFOMEM_VALIDITY_BYTES = INFOMEM_VALIDITY_BYTES;
    exports.LoopbackTransport = LoopbackTransport;
    exports.NEED_MORE = NEED_MORE$1;
    exports.NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS = NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS;
    exports.NORDIC_DFU_BUTTONLESS_WITH_BONDS = NORDIC_DFU_BUTTONLESS_WITH_BONDS;
    exports.NORDIC_DFU_OP_ENTER_BOOTLOADER = NORDIC_DFU_OP_ENTER_BOOTLOADER;
    exports.NORDIC_DFU_SERVICE = NORDIC_DFU_SERVICE;
    exports.NUS_RX = NUS_RX;
    exports.NUS_SERVICE = NUS_SERVICE;
    exports.NUS_TX = NUS_TX;
    exports.OPCODES = OPCODES;
    exports.OP_IDX = OP_IDX;
    exports.ObjectCluster = ObjectCluster;
    exports.PACKET_OVERHEAD_RESPONSE_DATA = PACKET_OVERHEAD_RESPONSE_DATA;
    exports.PACKET_OVERHEAD_RESPONSE_OTHER = PACKET_OVERHEAD_RESPONSE_OTHER;
    exports.RESYNC = RESYNC$1;
    exports.RtcDriftMonitor = RtcDriftMonitor;
    exports.SC_CALIB_FORMAT_VERSION = SC_CALIB_FORMAT_VERSION;
    exports.SC_CAL_QUALITY_MASK = SC_CAL_QUALITY_MASK;
    exports.SC_CAL_QUALITY_SHIFT = SC_CAL_QUALITY_SHIFT;
    exports.SC_CAL_RANGE_MASK = SC_CAL_RANGE_MASK;
    exports.SC_DATA_LEN_IMU = SC_DATA_LEN_IMU;
    exports.SC_GLOBAL_HEADER_BYTES = SC_GLOBAL_HEADER_BYTES;
    exports.SDK_VERSION = SDK_VERSION;
    exports.SDLOG_CLOCK_FREQ = SDLOG_CLOCK_FREQ;
    exports.SDLOG_DATA_TYPE_BYTES = SDLOG_DATA_TYPE_BYTES;
    exports.SDLOG_FW_ID = SDLOG_FW_ID;
    exports.SDLOG_HEADER_LENGTH = SDLOG_HEADER_LENGTH;
    exports.SDLOG_HW_ID = SDLOG_HW_ID;
    exports.SDLOG_SYNC_BLOCK_LENGTH = SDLOG_SYNC_BLOCK_LENGTH;
    exports.SDLOG_SYNC_OFFSET_LENGTH = SDLOG_SYNC_OFFSET_LENGTH;
    exports.SDLogHeaderBitmask = SDLogHeaderBitmask;
    exports.SD_ATTR_DIR = SD_ATTR_DIR;
    exports.SD_ATTR_NAME_TRUNCATED = SD_ATTR_NAME_TRUNCATED;
    exports.SD_BLOCK_PAYLOAD_DEFAULT = SD_BLOCK_PAYLOAD_DEFAULT;
    exports.SD_BLOCK_PAYLOAD_MAX = SD_BLOCK_PAYLOAD_MAX;
    exports.SD_BLOCK_PAYLOAD_MIN = SD_BLOCK_PAYLOAD_MIN;
    exports.SD_MAX_PATH_LEN = SD_MAX_PATH_LEN;
    exports.SD_STATUS = SD_STATUS;
    exports.SD_TRANSFER_OPCODES = SD_TRANSFER_OPCODES;
    exports.SD_XFER = SD_XFER;
    exports.SERIAL_DFU_EXTENDED_ERROR_NAMES = SERIAL_DFU_EXTENDED_ERROR_NAMES;
    exports.SERIAL_DFU_OBJECT_TYPE = SERIAL_DFU_OBJECT_TYPE;
    exports.SERIAL_DFU_OP = SERIAL_DFU_OP;
    exports.SERIAL_DFU_RESULT_NAMES = SERIAL_DFU_RESULT_NAMES;
    exports.SHIMMER3R_DEFAULTS = SHIMMER3R_DEFAULTS;
    exports.SHIMMER3R_INQ_CHANNELS_OFFSET = SHIMMER3R_INQ_CHANNELS_OFFSET;
    exports.SHIMMER3R_INQ_NUM_CHANNELS_OFFSET = SHIMMER3R_INQ_NUM_CHANNELS_OFFSET;
    exports.SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS = SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS;
    exports.SHIMMER3_ACK = ACK;
    exports.SHIMMER3_DEFAULTS = SHIMMER3_DEFAULTS;
    exports.SHIMMER3_INQ_CHANNELS_OFFSET = SHIMMER3_INQ_CHANNELS_OFFSET;
    exports.SHIMMER3_INQ_CONFIG_LENGTH = SHIMMER3_INQ_CONFIG_LENGTH;
    exports.SHIMMER3_INQ_CONFIG_OFFSET = SHIMMER3_INQ_CONFIG_OFFSET;
    exports.SHIMMER3_INQ_NUM_CHANNELS_OFFSET = SHIMMER3_INQ_NUM_CHANNELS_OFFSET;
    exports.SHIMMER3_NACK = NACK;
    exports.SHIMMER3_NEED_MORE = NEED_MORE;
    exports.SHIMMER3_RESPONSE_PAYLOAD_LENGTHS = SHIMMER3_RESPONSE_PAYLOAD_LENGTHS;
    exports.SHIMMER3_RESYNC = RESYNC;
    exports.SHIMMER3_SAMPLING_CLOCK_FREQ = SHIMMER3_SAMPLING_CLOCK_FREQ;
    exports.SHIMMER3_SPP_UUID = SHIMMER3_SPP_UUID;
    exports.SHIMMER_UART_CRC_INIT = SHIMMER_UART_CRC_INIT;
    exports.SMARTDOCK_BASE_CMD = SMARTDOCK_BASE_CMD;
    exports.SMARTDOCK_CONNECTION_TYPE = SMARTDOCK_CONNECTION_TYPE;
    exports.SMARTDOCK_DEFAULTS = SMARTDOCK_DEFAULTS;
    exports.SMARTDOCK_LINE_TERMINATOR = SMARTDOCK_LINE_TERMINATOR;
    exports.STREAM_MODE = STREAM_MODE;
    exports.SdLogFormatError = SdLogFormatError;
    exports.SdTransferError = SdTransferError;
    exports.SensorADC = SensorADC;
    exports.SensorBase = SensorBase;
    exports.SensorBitmapShimmer3 = SensorBitmapShimmer3;
    exports.SensorLIS2DW12 = SensorLIS2DW12;
    exports.SensorLSM6DS3 = SensorLSM6DS3;
    exports.SensorLSM6DSV = SensorLSM6DSV;
    exports.SensorMAX32674 = SensorMAX32674;
    exports.SensorMLX90632 = SensorMLX90632;
    exports.SensorPPG = SensorPPG;
    exports.SensorVD6283 = SensorVD6283;
    exports.Shimmer3Client = Shimmer3Client;
    exports.Shimmer3RClient = Shimmer3RClient;
    exports.SlipDecoder = SlipDecoder;
    exports.SmartDockClient = SmartDockClient;
    exports.StreamStatsTracker = StreamStatsTracker;
    exports.TEST_MODE_ID = TEST_MODE_ID;
    exports.TIMESTAMP_FIELD = TIMESTAMP_FIELD;
    exports.UART_COMPONENT = UART_COMPONENT;
    exports.UART_CONFIG_COMMANDS = UART_CONFIG_COMMANDS;
    exports.UART_DOCK_BAUD_RATE = UART_DOCK_BAUD_RATE;
    exports.UART_PACKET_CMD = UART_PACKET_CMD;
    exports.UART_PACKET_HEADER = UART_PACKET_HEADER;
    exports.UART_PROP = UART_PROP;
    exports.VERISENSE_BLE_SCHEDULE_DEFAULTS = VERISENSE_BLE_SCHEDULE_DEFAULTS;
    exports.VERISENSE_BLE_SCHEDULE_RANGES = VERISENSE_BLE_SCHEDULE_RANGES;
    exports.VERISENSE_BLE_SYNC_SCHEDULES = VERISENSE_BLE_SYNC_SCHEDULES;
    exports.VERISENSE_CALIBRATION_MIN_FW = VERISENSE_CALIBRATION_MIN_FW;
    exports.VERISENSE_DEFAULT_PASSKEY_BY_ID = VERISENSE_DEFAULT_PASSKEY_BY_ID;
    exports.VERISENSE_DFU_BOOTLOADER_NAME_PREFIX = VERISENSE_DFU_BOOTLOADER_NAME_PREFIX;
    exports.VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES = VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES;
    exports.VERISENSE_DFU_CONNECT_ATTEMPTS = VERISENSE_DFU_CONNECT_ATTEMPTS;
    exports.VERISENSE_DFU_FAST_PACKET_DELAY_MS = VERISENSE_DFU_FAST_PACKET_DELAY_MS;
    exports.VERISENSE_DFU_REBOOT_DELAY_MS = VERISENSE_DFU_REBOOT_DELAY_MS;
    exports.VERISENSE_DFU_RELIABLE_PACKET_DELAY_MS = VERISENSE_DFU_RELIABLE_PACKET_DELAY_MS;
    exports.VERISENSE_DFU_RETRY_DELAY_MS = VERISENSE_DFU_RETRY_DELAY_MS;
    exports.VERISENSE_DFU_ROUTINE_LOG_REGEX = VERISENSE_DFU_ROUTINE_LOG_REGEX;
    exports.VERISENSE_DFU_SET_MODE_TIMEOUT_MS = VERISENSE_DFU_SET_MODE_TIMEOUT_MS;
    exports.VERISENSE_DFU_TRANSIENT_ERROR_REGEX = VERISENSE_DFU_TRANSIENT_ERROR_REGEX;
    exports.VERISENSE_HW_MAJOR_FRIENDLY_NAMES = VERISENSE_HW_MAJOR_FRIENDLY_NAMES;
    exports.VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS = VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS;
    exports.VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID = VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID;
    exports.VERISENSE_OPERATIONAL_FIELD_GROUPS = VERISENSE_OPERATIONAL_FIELD_GROUPS;
    exports.VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR = VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR;
    exports.VERISENSE_OPERATIONAL_FIELD_SCHEMA = VERISENSE_OPERATIONAL_FIELD_SCHEMA;
    exports.VERISENSE_OP_CONFIG_BYTE_SIZE = VERISENSE_OP_CONFIG_BYTE_SIZE;
    exports.VERISENSE_SENSOR_ENABLE_FIELDS = VERISENSE_SENSOR_ENABLE_FIELDS;
    exports.VERISENSE_SENSOR_RATE_DEFAULT_GROUPS = VERISENSE_SENSOR_RATE_DEFAULT_GROUPS;
    exports.VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS = VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS;
    exports.VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS = VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS;
    exports.VERISENSE_STREAM_SENSOR_LABELS = VERISENSE_STREAM_SENSOR_LABELS;
    exports.VERISENSE_USB_DFU_PID = VERISENSE_USB_DFU_PID;
    exports.VERISENSE_USB_DFU_PORT_FILTERS = VERISENSE_USB_DFU_PORT_FILTERS;
    exports.VERISENSE_USB_DFU_REENUMERATION_DELAY_MS = VERISENSE_USB_DFU_REENUMERATION_DELAY_MS;
    exports.VERISENSE_USB_DFU_VID = VERISENSE_USB_DFU_VID;
    exports.VerisenseBleDevice = VerisenseBleDevice;
    exports.VerisenseSerialDfu = VerisenseSerialDfu;
    exports.WIRED_DEFAULTS = WIRED_DEFAULTS;
    exports.WIRED_NEED_MORE = NEED_MORE$2;
    exports.WIRED_RESYNC = RESYNC$2;
    exports.WebBluetoothTransport = WebBluetoothTransport;
    exports.WebSerialTransport = WebSerialTransport;
    exports.WiredShimmerClient = WiredShimmerClient;
    exports.applyDuplicateSuffix = applyDuplicateSuffix;
    exports.applyImuCalibration = applyImuCalibration;
    exports.asmRtcBytesToUnixSeconds = asmRtcBytesToUnixSeconds;
    exports.asmRtcMinutesBytesToUnixSeconds = asmRtcMinutesBytesToUnixSeconds;
    exports.badResponseReason = badResponseReason;
    exports.baseHardwareType = baseHardwareType;
    exports.battAdcToVoltage = battAdcToVoltage;
    exports.battVoltageToPercentage = battVoltageToPercentage;
    exports.brandNameProblem = brandNameProblem;
    exports.buildAbortCmd = buildAbortCmd;
    exports.buildBaseCommand = buildBaseCommand;
    exports.buildBlankBrandRecord = buildBlankBrandRecord;
    exports.buildBrandRecord = buildBrandRecord;
    exports.buildDefaultVerisenseCalibrationSet = buildDefaultVerisenseCalibrationSet;
    exports.buildDeleteCmd = buildDeleteCmd;
    exports.buildFreeSpaceCmd = buildFreeSpaceCmd;
    exports.buildHeader = buildHeader;
    exports.buildListDirCmd = buildListDirCmd;
    exports.buildMemReadPayload = buildMemReadPayload;
    exports.buildMemWritePayload = buildMemWritePayload;
    exports.buildMessage = buildMessage;
    exports.buildParsedCsvFileName = buildParsedCsvFileName;
    exports.buildProductionConfigPayload = buildProductionConfigPayload;
    exports.buildReadCmd = buildReadCmd;
    exports.buildReadPacket = buildReadPacket;
    exports.buildSelectSlotCommand = buildSelectSlotCommand;
    exports.buildShimmer3Schema = buildShimmer3Schema;
    exports.buildStatCmd = buildStatCmd;
    exports.buildUartPacket = buildUartPacket;
    exports.buildUploadBinaryFileName = buildUploadBinaryFileName;
    exports.buildVerisenseAdvertisedName = buildVerisenseAdvertisedName;
    exports.buildVerisenseDfuRequestDeviceOptions = buildVerisenseDfuRequestDeviceOptions;
    exports.buildWritePacket = buildWritePacket;
    exports.calibTsBytesToUnixSeconds = calibTsBytesToUnixSeconds;
    exports.calibrateGsrDataToResistanceFromAmplifierEq = calibrateGsrDataToResistanceFromAmplifierEq;
    exports.calibrateShimmer3RAdcChannel = calibrateShimmer3RAdcChannel;
    exports.calibrateU12AdcValue = calibrateU12AdcValue;
    exports.calibrateVector3 = calibrateVector3;
    exports.calibrationBlobCrc = calibrationBlobCrc;
    exports.checkConfigBytesValid = checkConfigBytesValid;
    exports.classifyBaseResponse = classifyBaseResponse;
    exports.classifyVerisenseDfuError = classifyVerisenseDfuError;
    exports.compareVerisenseFirmwareVersion = compareVerisenseFirmwareVersion;
    exports.computeVerisensePairingPin = computeVerisensePairingPin;
    exports.consensysBackupSegments = consensysBackupSegments;
    exports.crc16_ccitt_false = crc16_ccitt_false;
    exports.crc32 = crc32;
    exports.createBlankVerisenseOperationalConfig = createBlankVerisenseOperationalConfig;
    exports.csvCell = csvCell;
    exports.decodeSdLogFile = decodeSdLogFile;
    exports.decodeSdLogValue = decodeSdLogValue;
    exports.decodeSdSession = decodeSdSession;
    exports.decodeVerisenseBleOptimizationResult = decodeVerisenseBleOptimizationResult;
    exports.defaultVerisensePasskeyForId = defaultVerisensePasskeyForId;
    exports.deleteDownloadedFromCard = deleteDownloadedFromCard;
    exports.deriveVerisenseMacIdFromName = deriveVerisenseMacIdFromName;
    exports.describeVerisenseChargerStatus = describeVerisenseChargerStatus;
    exports.deviceWriteDivergentRanges = deviceWriteDivergentRanges;
    exports.downloadSdTree = downloadSdTree;
    exports.encodeSdPath = encodeSdPath;
    exports.enforceVerisenseCommsChannelInterlock = enforceVerisenseCommsChannelInterlock;
    exports.ensureDirectoryPath = ensureDirectoryPath;
    exports.enumerateSdTree = enumerateSdTree;
    exports.evaluateParsedFileSplit = evaluateParsedFileSplit;
    exports.expectedVerisenseStreamSensorIds = expectedVerisenseStreamSensorIds;
    exports.expectedVerisenseStreamSensorIdsFromConfig = expectedVerisenseStreamSensorIdsFromConfig;
    exports.extractBaseLine = extractBaseLine;
    exports.fatDateTimeToDate = fatDateTimeToDate;
    exports.formatByteArrayAsHex = formatByteArrayAsHex;
    exports.formatByteAsHex = formatByteAsHex;
    exports.formatPendingEventProperties = formatPendingEventProperties;
    exports.formatSchedulerPayloadForLog = formatSchedulerPayloadForLog;
    exports.formatSdImportStamp = formatSdImportStamp;
    exports.formatStatusPayloadForLog = formatStatusPayloadForLog;
    exports.formatVerisenseChargerStatus = formatVerisenseChargerStatus;
    exports.formatVerisenseFirmwareVersion = formatVerisenseFirmwareVersion;
    exports.formatVerisenseHardwareRevision = formatVerisenseHardwareRevision;
    exports.formatVerisenseUnixAndHuman = formatVerisenseUnixAndHuman;
    exports.fwCompare = fwCompare;
    exports.generateCalibDump = generateCalibDump;
    exports.generateInfoMem = generateInfoMem;
    exports.generateKinematicCalibBlock = generateKinematicCalibBlock;
    exports.getDefaultCalibration = getDefaultCalibration;
    exports.getFirstPayloadIndex = getFirstPayloadIndex;
    exports.getGroupDefaults = getGroupDefaults;
    exports.getOversamplingRatioADS1292R = getOversamplingRatioADS1292R;
    exports.getVerisenseCalibrationSensorAvailability = getVerisenseCalibrationSensorAvailability;
    exports.getVerisenseCalibrationSensors = getVerisenseCalibrationSensors;
    exports.getVerisenseHardwareCapabilities = getVerisenseHardwareCapabilities;
    exports.getVerisenseHardwareFriendlyName = getVerisenseHardwareFriendlyName;
    exports.getVerisenseHardwareRevision = getVerisenseHardwareRevision;
    exports.getVerisenseHardwareSensorSupport = getVerisenseHardwareSensorSupport;
    exports.getVerisenseStreamSensorLabel = getVerisenseStreamSensorLabel;
    exports.getVerisenseStreamingBatteryVoltageMultiplier = getVerisenseStreamingBatteryVoltageMultiplier;
    exports.getVerisenseSupportedOperationalFieldGroupIds = getVerisenseSupportedOperationalFieldGroupIds;
    exports.hasSensorBit = hasSensorBit;
    exports.hhmmToMinutesSinceMidnight = hhmmToMinutesSinceMidnight;
    exports.inferVerisenseChargerChipFamily = inferVerisenseChargerChipFamily;
    exports.inferVerisenseLookupBankCount = inferVerisenseLookupBankCount;
    exports.interpretShimmer3InquiryResponse = interpretShimmer3InquiryResponse;
    exports.isAckCommand = isAckCommand;
    exports.isBadResponse = isBadResponse;
    exports.isNackCommand = isNackCommand;
    exports.isNewImuSensors = isNewImuSensors;
    exports.isRoutineVerisenseDfuLogMessage = isRoutineVerisenseDfuLogMessage;
    exports.isSafeFirmwareArchiveName = isSafeFirmwareArchiveName;
    exports.isSdLoggingFirmware = isSdLoggingFirmware;
    exports.isSupportedEightByteDerivedSensors = isSupportedEightByteDerivedSensors;
    exports.isSupportedMpl = isSupportedMpl;
    exports.isSupportedRtcConfigViaUart = isSupportedRtcConfigViaUart;
    exports.isSupportedSdLogSync = isSupportedSdLogSync;
    exports.isUniformByteArray = isUniformByteArray;
    exports.isUsbDfuUnsupportedError = isUsbDfuUnsupportedError;
    exports.isVerisenseGsrSupportedHardware = isVerisenseGsrSupportedHardware;
    exports.isVerisenseLightDarkChannelEnabled = isVerisenseLightDarkChannelEnabled;
    exports.isVerisenseLipoBatteryHardware = isVerisenseLipoBatteryHardware;
    exports.isVerisenseSecondGenerationHardware = isVerisenseSecondGenerationHardware;
    exports.localCivilUnixSecondsNow = localCivilUnixSecondsNow;
    exports.makeKinematicCalibration = makeKinematicCalibration;
    exports.matrixInverse3x3 = matrixInverse3x3;
    exports.matrixMultiply3x3 = matrixMultiply3x3;
    exports.minutesSinceMidnightToHHMM = minutesSinceMidnightToHHMM;
    exports.msToRtcBytesLE = msToRtcBytesLE;
    exports.nextAvailableDuplicateFileName = nextAvailableDuplicateFileName;
    exports.normalizeBytePayload = normalizeBytePayload;
    exports.normalizeOperationalConfig = normalizeOperationalConfig;
    exports.nudgeGsrResistance = nudgeGsrResistance;
    exports.padVerisenseOperationalConfig = padVerisenseOperationalConfig;
    exports.parseActiveSlot = parseActiveSlot;
    exports.parseBatteryStatus = parseBatteryStatus;
    exports.parseBleLinkDebugPayload = parseBleLinkDebugPayload;
    exports.parseBrandRecord = parseBrandRecord;
    exports.parseCalibDump = parseCalibDump;
    exports.parseCalibrationBlob = parseCalibrationBlob;
    exports.parseDeleteRsp = parseDeleteRsp;
    exports.parseEventLogPayload = parseEventLogPayload;
    exports.parseExpansionBoard = parseExpansionBoard;
    exports.parseFreeSpaceRsp = parseFreeSpaceRsp;
    exports.parseHeader = parseHeader;
    exports.parseHexByteString = parseHexByteString;
    exports.parseInfoMem = parseInfoMem;
    exports.parseKinematicCalibBlock = parseKinematicCalibBlock;
    exports.parseListDirRsp = parseListDirRsp;
    exports.parseLookupTablePayload = parseLookupTablePayload;
    exports.parseMacId = parseMacId;
    exports.parseMessage = parseMessage;
    exports.parsePayloadCrcErrorBankIndexes = parsePayloadCrcErrorBankIndexes;
    exports.parsePendingEvents = parsePendingEvents;
    exports.parseProductionConfigPayload = parseProductionConfigPayload;
    exports.parseProductionConfigPayloadFull = parseProductionConfigPayloadFull;
    exports.parseRecordBufferDetailsPayload = parseRecordBufferDetailsPayload;
    exports.parseSchedulerDebugPayload = parseSchedulerDebugPayload;
    exports.parseSdLogHeader = parseSdLogHeader;
    exports.parseSdSessionName = parseSdSessionName;
    exports.parseSdTrialFolderName = parseSdTrialFolderName;
    exports.parseShimmer3DeviceVersionResponse = parseShimmer3DeviceVersionResponse;
    exports.parseShimmer3FwVersionResponse = parseShimmer3FwVersionResponse;
    exports.parseSlotOccupancy = parseSlotOccupancy;
    exports.parseSmartDockVersion = parseSmartDockVersion;
    exports.parseStatRsp = parseStatRsp;
    exports.parseStatusPayload = parseStatusPayload;
    exports.parseUartPacket = parseUartPacket;
    exports.parseVerisenseAdvertisedName = parseVerisenseAdvertisedName;
    exports.parseVerisenseFactoryTestReport = parseVerisenseFactoryTestReport;
    exports.parseVersionInfo = parseVersionInfo;
    exports.patchSecureDfuSendOperation = patchSecureDfuSendOperation;
    exports.promiseWithTimeout = promiseWithTimeout;
    exports.readVerisenseOperationalFieldValue = readVerisenseOperationalFieldValue;
    exports.resolveInfoMemLayout = resolveInfoMemLayout;
    exports.resolveVerisenseSensorRateFieldKey = resolveVerisenseSensorRateFieldKey;
    exports.runVerisenseDfuUpdate = runVerisenseDfuUpdate;
    exports.sdCrc16 = sdCrc16;
    exports.sdMessageSpan = sdMessageSpan;
    exports.sdStatusToString = sdStatusToString;
    exports.sdXferStatusToString = sdXferStatusToString;
    exports.serializeCalibrationBlob = serializeCalibrationBlob;
    exports.setVerisenseDfuModeWithRetry = setVerisenseDfuModeWithRetry;
    exports.setVerisenseOperationalBitRange = setVerisenseOperationalBitRange;
    exports.shimmer3ControlMessageLength = shimmer3ControlMessageLength;
    exports.shimmer3UsesThreeByteTimestamp = shimmer3UsesThreeByteTimestamp;
    exports.shimmer3rControlMessageLength = shimmer3rControlMessageLength;
    exports.shimmerUartCrcByte = shimmerUartCrcByte;
    exports.shimmerUartCrcCalc = shimmerUartCrcCalc;
    exports.shimmerUartCrcCheck = shimmerUartCrcCheck;
    exports.shouldOverrideCalibration = shouldOverrideCalibration;
    exports.slipEncode = slipEncode;
    exports.supportsVerisenseCalibration = supportsVerisenseCalibration;
    exports.supportsVerisenseMagnetometer = supportsVerisenseMagnetometer;
    exports.tryExtractSdMessage = tryExtractSdMessage;
    exports.unixSecondsToAsmRtcBytes = unixSecondsToAsmRtcBytes;
    exports.unixSecondsToCalibTsBytes = unixSecondsToCalibTsBytes;
    exports.updateVerisenseDfuImageWithRetry = updateVerisenseDfuImageWithRetry;
    exports.utcToLocalCivilMillis = utcToLocalCivilMillis;
    exports.verisenseDeviceFileTag = verisenseDeviceFileTag;
    exports.verisenseDfuAttemptLabel = verisenseDfuAttemptLabel;
    exports.verisenseFactoryTestReportToCsvRows = verisenseFactoryTestReportToCsvRows;
    exports.wiredPacketLength = wiredPacketLength;
    exports.writeVerisenseOperationalFieldValue = writeVerisenseOperationalFieldValue;

}));
//# sourceMappingURL=shimmer-web-sdk.umd.js.map
