/**
 * SDK version, exported so consumers (e.g. the webBLEDemos pages, which vendor
 * the built bundle) can log which build they are actually running — a stale
 * vendored copy is otherwise indistinguishable from a firmware fault.
 *
 * Kept in sync with package.json by tests/core/version.test.ts.
 */
declare const SDK_VERSION = "0.1.25";

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
    /**
     * Called when the link drops without the application asking for it. NOT
     * called by {@link IShimmerClient.disconnect} — see
     * `BaseShimmerClient.onDisconnect` for why.
     */
    onDisconnect: ((reason?: Error) => void) | null;
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
    /**
     * Invoked when the link to the device goes away **without the application
     * asking for it**: the sensor was switched off, walked out of BLE range, or
     * its USB / classic-Bluetooth COM port was unplugged. `reason` carries the
     * transport's error when it supplied one.
     *
     * Deliberately NOT invoked by {@link disconnect}. A caller that closed the
     * link already knows it did, so firing there would make every teardown look
     * like a fault and force applications to filter their own action back out —
     * exactly the reconnect-loop trap this callback exists to avoid. Put shared
     * teardown after your own `await disconnect()` instead.
     *
     * Fires at most once per connection: a transport that reports the same drop
     * twice, or a `disconnect()` issued to clean up after a drop, is collapsed to
     * the first notification.
     */
    onDisconnect: ((reason?: Error) => void) | null;
    constructor(opts?: ShimmerClientOptions);
    /** Log to console when debug is enabled. */
    protected _log(...args: unknown[]): void;
    /** Emit a status message to `onStatus` and to the debug log. */
    protected _emitStatus(msg: string): void;
    /** Set once {@link onDisconnect} has fired (or been suppressed) for the current connection. */
    private _disconnectNotified;
    /**
     * Arm {@link onDisconnect} for a fresh connection. Sub-classes call this from
     * `connect()`, so the next drop is reported even after an earlier one.
     */
    protected _armDisconnectNotification(): void;
    /**
     * Mark the current connection's drop as already accounted for, so a transport
     * event arriving after an application-initiated `disconnect()` cannot surface
     * as a fault. Sub-classes call this from `disconnect()`.
     */
    protected _suppressDisconnectNotification(): void;
    /**
     * Report an unexpected transport drop to {@link onDisconnect}, at most once
     * per connection. Sub-classes call this from their transport-disconnect
     * handler — never from `disconnect()`. A throwing handler is logged and
     * swallowed: the drop has already happened, so there is nothing to fail.
     */
    protected _emitDisconnect(reason?: Error): void;
    abstract connect(...args: unknown[]): Promise<unknown>;
    abstract disconnect(...args: unknown[]): Promise<unknown>;
    abstract startStreaming(): Promise<void>;
    abstract stopStreaming(): Promise<void>;
}

/**
 * Which link types this browser can actually reach, and what to tell the user
 * when it cannot.
 *
 * Every consumer of this SDK was hand-writing the same advice — "Web Serial not
 * supported, use Chrome/Edge on desktop" — in its own words, in six places
 * across three repos. All six were wrong in the same way once Chrome shipped Web
 * Serial on Android, so the knowledge lives here once instead.
 *
 * The split this module insists on:
 *
 * - **Gate on capability.** `webSerial` / `webBluetooth` report whether the API's
 *   entry point is *callable* — stricter than `'serial' in navigator`, because a
 *   property that is `null`, a non-object, or an object without the entry point
 *   satisfies `in` and still throws the moment anything uses it. Whether calling
 *   would throw is a fact, and that is what a control's enabled state may rest on.
 * - **Message on platform.** `isAndroid` / `isIOS` come from the user-agent, and
 *   are used only to choose which words to show. A UA string is a guess, and
 *   guesses must never decide what a user is allowed to click.
 *
 * The awkward case that shaped the API is Android. Chrome 138+ implements Web
 * Serial there, but deliberately only for Bluetooth RFCOMM port emulation —
 * wired ports are a separate feature still rolling out. So `navigator.serial` is
 * present and callable, and `webSerial` is correctly `true`: the API is usable,
 * but only for RFCOMM. A wired dock still will not appear in the picker, and no
 * amount of feature detection separates the two. That is why
 * {@link transportAvailability} returns three states rather than a boolean:
 * `'unlikely'` is the honest answer for a wired port on Android, and it maps to
 * "leave the button enabled and warn" rather than "disable", so devices that do
 * gain wired support are not locked out.
 *
 * iOS is the opposite shape — a harder "no" than an unimplemented API. Every iOS
 * browser is WebKit, which ships neither API, and iOS exposes no
 * classic-Bluetooth serial access to third-party apps at any layer: Core
 * Bluetooth is BLE-only, and classic profiles such as SPP require MFi licensing.
 * So classic Bluetooth there is impossible rather than merely absent, and no
 * future browser release changes that. BLE via a browser that bundles its own
 * stack (Bluefy, WebBLE) is the ceiling.
 */
/**
 * The parts of `navigator` this module reads. Injectable so the logic is
 * testable without a browser — the reason this belongs in the SDK rather than
 * being copy-pasted into pages, where it could never be unit-tested.
 */
interface NavigatorLike {
    userAgent?: string;
    userAgentData?: {
        platform?: string;
    };
    maxTouchPoints?: number;
    serial?: unknown;
    bluetooth?: unknown;
}
/** A link the caller wants to offer, independent of how it is implemented. */
type TransportNeed = 'ble' | 'classicBluetooth' | 'wiredSerial';
/**
 * How likely a {@link TransportNeed} is to work here.
 *
 * - `available` — the API is present and unrestricted for this need.
 * - `unlikely` — the API is present but probably cannot serve this need. Keep the
 *   control enabled and warn; a hard disable would lock out the devices where it
 *   does work.
 * - `unavailable` — the API is absent. Disable the control.
 */
type Availability = 'available' | 'unlikely' | 'unavailable';
interface PlatformSupport {
    /**
     * `typeof navigator.serial?.requestPort === 'function'`. Safe to gate on.
     *
     * False whenever calling would throw: `serial` missing, `null`, `undefined`, a
     * non-object, an object without `requestPort`, or a `requestPort` that is not a
     * function. Note this is a stronger claim than "the property exists" — do not
     * read it as `'serial' in navigator`.
     */
    readonly webSerial: boolean;
    /**
     * `typeof navigator.bluetooth?.requestDevice === 'function'`. Safe to gate on.
     *
     * False whenever calling would throw: `bluetooth` missing, `null`, `undefined`,
     * a non-object, an object without `requestDevice`, or a `requestDevice` that is
     * not a function. All of those satisfy `'bluetooth' in navigator` while still
     * throwing synchronously on first use, which is why this is the stronger check.
     */
    readonly webBluetooth: boolean;
    /** UA hint. Advice only — never gate on this. */
    readonly isAndroid: boolean;
    /** UA hint. Advice only — never gate on this. */
    readonly isIOS: boolean;
    /**
     * Web Serial is present but expected to expose Bluetooth RFCOMM ports only,
     * so a wired dock will not appear in the picker. True on Android.
     */
    readonly serialBluetoothOnly: boolean;
}
/**
 * Snapshot what this browser can reach. Call once and pass the result around;
 * nothing here changes during a page's lifetime.
 *
 * Safe outside a browser — with no `navigator` every capability reads `false`,
 * so a Node or React Native caller gets "nothing available" rather than a throw.
 */
declare function describePlatformSupport(nav?: NavigatorLike): PlatformSupport;
/**
 * Whether to offer `need` here — see {@link Availability} for how to map the
 * three states onto a control's enabled state.
 */
declare function transportAvailability(support: PlatformSupport, need: TransportNeed): Availability;
/**
 * What to tell the user about `need` on this platform, or `null` when there is
 * nothing worth saying (the API is present and unrestricted).
 *
 * Returning `null` on the happy path is deliberate: it lets a caller write
 * `const msg = transportAdvice(...); if (msg) log(msg);` without first working
 * out whether this platform is interesting.
 */
declare function transportAdvice(support: PlatformSupport, need: TransportNeed): string | null;

/**
 * Shimmer transport abstraction (Phase 1 refactor).
 *
 * The device clients (`Shimmer3RClient`, `VerisenseBleDevice`) used to call
 * `navigator.bluetooth` / `navigator.serial` directly. That hard-wiring was the
 * single blocker to running the clients on React Native (react-native-ble-plx)
 * or over Bluetooth Classic (RFCOMM/SPP). This module extracts that byte pipe
 * behind {@link ShimmerTransport} so the clients become transport-consumers.
 *
 * Design rules the implementations MUST honour:
 *
 * - A transport does **no** protocol interpretation whatsoever — no ACK
 *   detection, no framing, no re-chunking. All framing/ACK/schema logic stays in
 *   the clients (and is pure).
 * - {@link ShimmerTransport.onNotify} delivers each inbound notification as the
 *   *exact* bytes received, preserving notification chunk boundaries. Shimmer3R's
 *   ACK-remainder handling depends on a response being piggybacked in the same
 *   chunk as its ACK, so a transport must never merge or re-split chunks.
 * - {@link TransportCapabilities} lets a client learn about an MTU-bounded pipe so
 *   it can chunk large writes when needed; a browser BLE write is MTU-bounded,
 *   RFCOMM is effectively unbounded.
 *
 * A web BLE implementation maps `write` → write-characteristic `writeValue`,
 * `onNotify` → notify-characteristic `characteristicvaluechanged`, and
 * `onDisconnect` → `gattserverdisconnected`. See {@link WebBluetoothTransport},
 * {@link WebSerialTransport}, and the in-repo {@link LoopbackTransport} used by
 * the test suites.
 */
/**
 * Which physical pipe a transport speaks over.
 *
 * Distinct from the Verisense client's public `TransportKind`
 * (`'ble' | 'serial' | null`), which describes that client's currently active
 * connection rather than a transport implementation.
 */
type ShimmerTransportKind = 'ble' | 'serial' | 'rfcomm' | 'loopback' | 'mock';
/** Device families the app understands (used for scan filtering + UI). */
type DeviceKind = 'shimmer3' | 'shimmer3r' | 'verisense';
/** Unsubscribe handle returned by the `on*` registration methods. */
type Unsubscribe = () => void;
/**
 * Optional transport capabilities the clients can query to adapt framing.
 * BLE reports an MTU-bounded `maxWriteBytes`; RFCOMM is effectively unbounded.
 */
interface TransportCapabilities {
    /**
     * Max bytes accepted by a single {@link ShimmerTransport.write}, if bounded.
     * Undefined means unbounded / unknown (the client should not chunk).
     */
    maxWriteBytes?: number;
    /**
     * True when the transport preserves message boundaries (BLE notifications
     * arrive one chunk per {@link ShimmerTransport.onNotify} call). A byte-stream
     * pipe such as Web Serial is not framed.
     */
    framed: boolean;
}
/** Per-write options. */
interface TransportWriteOptions {
    /**
     * Request an acknowledged (write-with-response) transfer. When omitted the
     * transport applies its own default (see each implementation). Ignored by
     * transports that do not distinguish the two (e.g. Web Serial).
     */
    withResponse?: boolean;
}
/**
 * A bidirectional byte pipe to a single Shimmer device.
 *
 * Lifecycle: `connect()` → any number of `write()` / notify callbacks →
 * `disconnect()`. Implementations must deliver notification payloads as the
 * exact bytes received (no protocol interpretation) so the pure protocol layer
 * above stays transport-agnostic.
 */
interface ShimmerTransport {
    /** The pipe kind — lets clients special-case (e.g. RFCOMM chunking). */
    readonly kind: ShimmerTransportKind;
    /**
     * Capability hints. `framed` is known up front; `maxWriteBytes` may only be
     * populated once connected (best-effort before then).
     */
    readonly capabilities: TransportCapabilities;
    /** Advertised device name, when the transport can supply one (for labels). */
    readonly deviceName?: string;
    /** Open the connection (and start notifications). Rejects on failure. */
    connect(): Promise<void>;
    /** Close the connection. Safe to call more than once. */
    disconnect(): Promise<void>;
    /** Send a command frame to the device (host → device). */
    write(data: Uint8Array, opts?: TransportWriteOptions): Promise<void>;
    /**
     * Register a listener for inbound notification chunks (device → host).
     * Each call delivers one notification's exact bytes. Returns an unsubscribe
     * function.
     */
    onNotify(cb: (data: Uint8Array) => void): Unsubscribe;
    /**
     * Register a listener for unexpected / requested disconnects.
     * `reason` is set when the link dropped rather than being closed by us.
     * Returns an unsubscribe function.
     */
    onDisconnect(cb: (reason?: Error) => void): Unsubscribe;
}
/**
 * A device surfaced by a {@link TransportScanner} during discovery.
 * `id` is the stable handle a transport uses to (re)connect.
 */
interface DiscoveredDevice {
    /** Stable transport-specific identifier (BLE peripheral id / MAC / mock id). */
    id: string;
    /** Advertised name, if any. */
    name: string;
    /** Best guess at the device family from the advertisement. */
    kind: DeviceKind;
    /** Received signal strength (dBm), if the transport reports it. */
    rssi?: number;
}
/**
 * Device discovery, decoupled from the connection pipe.
 *
 * On BLE this wraps a scan (Web Bluetooth `requestLEScan` / ble-plx
 * `startDeviceScan`); on RFCOMM it wraps classic inquiry. The app calls
 * `startScan`, receives {@link DiscoveredDevice}s via the callback, then
 * constructs a {@link ShimmerTransport} for the chosen device id.
 *
 * Not consumed by the SDK clients today (they select a device at connect time
 * via the platform picker); included as part of the agreed transport contract so
 * platform transports (e.g. React Native) implement a consistent shape.
 */
interface TransportScanner {
    readonly kind: ShimmerTransportKind;
    /**
     * Begin scanning. `onDevice` fires once per discovered (or updated) device.
     * Implementations should de-duplicate by `id` where the platform allows.
     */
    startScan(onDevice: (device: DiscoveredDevice) => void): Promise<void>;
    /** Stop an in-progress scan. Safe to call when not scanning. */
    stopScan(): Promise<void>;
}

/** Constructor options for {@link WebBluetoothTransport}. */
interface WebBluetoothTransportOptions {
    /** Primary GATT service UUID the write/notify characteristics live under. */
    serviceUUID: string;
    /** Characteristic the host writes command frames to (host → device). */
    writeCharUUID: string;
    /** Characteristic the host receives notifications from (device → host). */
    notifyCharUUID: string;
    /**
     * Options passed straight to `navigator.bluetooth.requestDevice`. When omitted
     * a filter on `serviceUUID` is used. Ignored when {@link device} is supplied.
     */
    requestDeviceOptions?: RequestDeviceOptions;
    /**
     * A pre-selected device (skips the `requestDevice` picker). Useful for
     * reconnect flows that already hold a `BluetoothDevice`.
     */
    device?: BluetoothDevice | null;
    /**
     * Default acknowledgement mode for {@link write} when the per-write option is
     * unset. `true` → write-with-response (`writeValue`); `false` →
     * write-without-response when the characteristic supports it, else
     * `writeValue`.
     */
    defaultWriteWithResponse?: boolean;
    /** Enable verbose console logging. */
    debug?: boolean;
    /** Log tag prefix. Defaults to `[WebBluetoothTransport]`. */
    logTag?: string;
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
declare class WebBluetoothTransport implements ShimmerTransport {
    readonly kind: ShimmerTransportKind;
    readonly capabilities: TransportCapabilities;
    private readonly _serviceUUID;
    private readonly _writeCharUUID;
    private readonly _notifyCharUUID;
    private readonly _requestDeviceOptions?;
    private readonly _defaultWriteWithResponse;
    private readonly _debug;
    private readonly _logTag;
    private _device;
    private _server;
    private _service;
    private _writeChar;
    private _notifyChar;
    private readonly _notifyCbs;
    private readonly _disconnectCbs;
    constructor(opts: WebBluetoothTransportOptions);
    /** The selected `BluetoothDevice`, once chosen. */
    get device(): BluetoothDevice | null;
    /** The connected GATT server, once connected. */
    get server(): BluetoothRemoteGATTServer | null;
    /** The write characteristic (host → device), once discovered. */
    get writeCharacteristic(): BluetoothRemoteGATTCharacteristic | null;
    /** The notify characteristic (device → host), once discovered. */
    get notifyCharacteristic(): BluetoothRemoteGATTCharacteristic | null;
    get deviceName(): string | undefined;
    private _log;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    write(data: Uint8Array, opts?: TransportWriteOptions): Promise<void>;
    onNotify(cb: (data: Uint8Array) => void): Unsubscribe;
    onDisconnect(cb: (reason?: Error) => void): Unsubscribe;
    private _onCharacteristicChanged;
    private _onGattServerDisconnected;
}

/** Constructor options for {@link WebSerialTransport}. */
interface WebSerialTransportOptions {
    /** A pre-opened / pre-selected port (skips the `requestPort` picker). */
    port?: SerialPort | null;
    baudRate?: number;
    dataBits?: number;
    stopBits?: number;
    parity?: ParityType;
    flowControl?: FlowControlType;
    /** `requestPort` filters. */
    filters?: readonly SerialPortFilter[] | null;
    /**
     * Service class IDs the port picker is *permitted* to surface Bluetooth
     * (RFCOMM/SPP) ports for — pass `[SHIMMER3_SPP_UUID]` to reach a Shimmer
     * paired over classic Bluetooth. Chrome hides Bluetooth serial ports entirely
     * unless the origin names their service class, so `filters` alone is not
     * enough.
     *
     * **This permits; it does not narrow.** On its own it makes the picker offer
     * every COM port *and* every paired Bluetooth device. To narrow the list, also
     * pass {@link filters} with the same service class:
     *
     * ```ts
     * filters: [{ bluetoothServiceClassId: SHIMMER3_SPP_UUID }],
     * allowedBluetoothServiceClassIds: [SHIMMER3_SPP_UUID],
     * ```
     */
    allowedBluetoothServiceClassIds?: readonly BluetoothServiceClassId[] | null;
    /**
     * Read buffer size handed to `port.open`. Defaults to the browser's own
     * default (8 KiB in Chrome); raise it for bulk transfers so a slow turn of
     * the read loop cannot stall the sender.
     */
    bufferSize?: number;
    /**
     * Reported {@link ShimmerTransport.kind}. Defaults to `'serial'`; pass
     * `'rfcomm'` when the port is a classic-Bluetooth virtual COM port so logs
     * and UI can tell the two apart (no client behaviour depends on it).
     */
    kind?: ShimmerTransportKind;
    /**
     * Abandon `port.open()` after this many ms (0 disables). Opening a classic
     * Bluetooth COM port is what actually establishes the RFCOMM link, so the
     * call can block for tens of seconds when the sensor is asleep or out of
     * range — where a USB CDC port either opens at once or fails at once.
     * Defaults to 15 s.
     */
    openTimeoutMs?: number;
    /**
     * DTR (data-terminal-ready) line state asserted right after the port opens.
     * Defaults to TRUE together with {@link requestToSend}: the Shimmer
     * single-slot dock wires the docked sensor's reset to the COM-port control
     * lines and holds the sensor in RESET until both DTR and RTS are asserted,
     * and asserted lines are also the safe norm for USB-CDC devices (hardware
     * that ignores them behaves the same either way). Set false only for
     * hardware that needs the line deasserted.
     */
    dataTerminalReady?: boolean;
    /** RTS (request-to-send) line state asserted right after the port opens.
     * Defaults to TRUE — see {@link dataTerminalReady}. */
    requestToSend?: boolean;
    /** Enable verbose console logging. */
    debug?: boolean;
}
/**
 * A {@link ShimmerTransport} over the Web Serial API (USB COM port).
 *
 * Web Serial is an unframed byte stream, so `capabilities.framed` is `false` and
 * the notify callback fires with whatever chunk the reader yields — the client's
 * assembler re-frames. Behaviour (open parameters, read-loop teardown, writer
 * lifecycle) is ported verbatim from `VerisenseBleDevice`'s former serial path.
 */
declare class WebSerialTransport implements ShimmerTransport {
    readonly kind: ShimmerTransportKind;
    readonly capabilities: TransportCapabilities;
    private readonly _debug;
    private readonly _openOptions;
    private readonly _filters;
    private readonly _allowedBluetoothServiceClassIds;
    private readonly _openTimeoutMs;
    private readonly _signals;
    private _port;
    private _abort;
    private _reader;
    private _readLoopTask;
    private readonly _notifyCbs;
    private readonly _disconnectCbs;
    constructor(opts?: WebSerialTransportOptions);
    /** The underlying serial port, once opened. */
    get port(): SerialPort | null;
    /**
     * Which kind of link this transport was configured to open, for choosing the
     * right advice when Web Serial is missing.
     *
     * Deliberately not `this._allowedBluetoothServiceClassIds ? ... : ...`: an
     * empty array is truthy, so `allowedBluetoothServiceClassIds: []` would be
     * called Bluetooth, and a caller who passed only a `bluetoothServiceClassId`
     * filter without the permission would be told about a wired dock. Both cases
     * would hand the user advice for the wrong link - most visibly on iOS, where
     * the two messages differ in kind rather than in wording.
     */
    private _need;
    connect(): Promise<void>;
    /**
     * `port.open()`, bounded by {@link WebSerialTransportOptions.openTimeoutMs}.
     *
     * Opening a classic-Bluetooth COM port is what brings the RFCOMM link up, so
     * an asleep or out-of-range sensor blocks here rather than failing fast. If
     * the timeout wins we still close the port should the open land later —
     * otherwise the OS keeps an orphaned handle and the next attempt fails with
     * "port already open" instead of the real reason.
     */
    private _openWithTimeout;
    write(data: Uint8Array): Promise<void>;
    disconnect(reason?: string): Promise<void>;
    onNotify(cb: (data: Uint8Array) => void): Unsubscribe;
    onDisconnect(cb: (reason?: Error) => void): Unsubscribe;
    private _emitNotify;
    private _startReadLoop;
}

/** A single recorded host → device write. */
interface LoopbackWrite {
    bytes: Uint8Array;
    withResponse?: boolean;
}
/** Constructor options for {@link LoopbackTransport}. */
interface LoopbackTransportOptions {
    /**
     * Called for every {@link LoopbackTransport.write}. Use it to script device
     * replies: inspect the outgoing frame and call {@link LoopbackTransport.notify}
     * to deliver a response. May be async (its rejection is ignored).
     */
    onWrite?: (bytes: Uint8Array, transport: LoopbackTransport) => void | Promise<void>;
    /** Override capability hints (default `{ framed: true }`, like BLE). */
    capabilities?: Partial<TransportCapabilities>;
    /** Advertised device name for labelling. */
    deviceName?: string;
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
declare class LoopbackTransport implements ShimmerTransport {
    readonly kind: ShimmerTransportKind;
    readonly capabilities: TransportCapabilities;
    readonly deviceName?: string;
    /** Every write the client has issued, in order. */
    readonly writes: LoopbackWrite[];
    /** Whether {@link connect} has run and {@link disconnect} has not. */
    connected: boolean;
    private _onWrite?;
    private readonly _notifyCbs;
    private readonly _disconnectCbs;
    constructor(opts?: LoopbackTransportOptions);
    /** Replace the write handler (e.g. after connect-time bootstrap). */
    setOnWrite(fn: ((bytes: Uint8Array, transport: LoopbackTransport) => void | Promise<void>) | undefined): void;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    write(data: Uint8Array, opts?: TransportWriteOptions): Promise<void>;
    onNotify(cb: (data: Uint8Array) => void): Unsubscribe;
    onDisconnect(cb: (reason?: Error) => void): Unsubscribe;
    /**
     * Deliver one inbound notification chunk to every {@link onNotify} listener,
     * exactly as given (no merge / re-split). Accepts a `Uint8Array` or number[].
     */
    notify(data: Uint8Array | number[]): void;
    /** Simulate a link drop / requested disconnect. */
    emitDisconnect(reason?: Error): void;
    /** The last recorded write, or undefined. */
    get lastWrite(): LoopbackWrite | undefined;
}

/**
 * True if `bytes` is non-empty and every byte equals `value` (0–255). Useful for
 * detecting uniform blobs such as erased flash (all `0xFF`) or zeroed regions.
 * Returns false for empty or nullish input.
 */
declare function isUniformByteArray(bytes: ArrayLike<number> | ArrayBuffer | null | undefined, value: number): boolean;

/**
 * CSV emission for decoded sensor data.
 *
 * A stream of {@link ObjectCluster}s is not a table: each frame carries the
 * channels that frame happened to have, in whatever order the schema listed
 * them, with a raw and a calibrated version of some signals and only one of
 * others. Turning that into a CSV means fixing a column set ONCE and then
 * projecting every frame onto it — otherwise a row silently shifts the moment a
 * frame's field list differs, and the file reads as valid data that is wrong.
 *
 * {@link objectClusterColumns} derives that column set from a representative
 * frame; {@link objectClusterRow} projects a frame onto it, writing `null`
 * where a frame lacks a column rather than dropping the cell.
 */

/**
 * Escape a value for a CSV cell (RFC 4180 style): whitespace runs — including
 * newlines — collapse to a single space, then cells containing a quote or
 * comma are quoted with internal quotes doubled. Null/undefined become the
 * empty cell.
 */
declare function csvCell(text: unknown): string;
/**
 * Join cells into one CSV line, each escaped by {@link csvCell}. No trailing
 * newline — the caller decides the line ending, which matters because a file
 * destined for Excel on Windows wants CRLF.
 */
declare function csvRow(cells: readonly unknown[]): string;
/** One column of a CSV built from {@link ObjectCluster} frames. */
interface ObjectClusterColumn {
    /** Signal name as it appears in the frame, e.g. `'GYRO_X'`. */
    readonly name: string;
    /** Which version of the signal this column holds. */
    readonly kind: FieldKind;
    /** Unit of the first frame's value, for a units header row. May be null. */
    readonly unit: string | null;
    /** Column heading: `NAME_RAW`, `NAME_CAL`, or `NAME` when kind is null. */
    readonly header: string;
}
/** Options for {@link objectClusterColumns}. */
interface ObjectClusterColumnOptions {
    /**
     * Restrict the columns to these kinds, e.g. `['cal']` for a calibrated-only
     * file or `['raw']` for one a user will calibrate themselves. Omit for every
     * kind present. Include `null` to keep the kindless channels (the timestamp,
     * typically) — a `kinds: ['cal']` file drops them, which is usually not
     * what the caller meant.
     */
    kinds?: readonly FieldKind[];
}
/**
 * Derive a CSV column set from one frame.
 *
 * Column ORDER follows `oc.fields`, so it matches the schema the device
 * negotiated rather than an alphabetical reordering the reader would have to
 * undo. A name/kind pair that appears twice in a frame contributes one column;
 * the first occurrence wins, and {@link objectClusterRow} reads that same one.
 *
 * Call this once, on the first frame, and reuse the result. Re-deriving it per
 * frame is the mistake this function exists to prevent.
 */
declare function objectClusterColumns(oc: ObjectCluster, opts?: ObjectClusterColumnOptions): ObjectClusterColumn[];
/**
 * Project a frame onto a column set: one value per column, in column order,
 * `null` for a column this frame does not carry.
 *
 * Matches on the column's kind EXACTLY, which `ObjectCluster.get` deliberately
 * does not — it treats a null `kind` as "any kind", so a kindless column would
 * pick up a raw field that shares its name. Hence the index below is keyed by
 * kind first: the three buckets can never see each other.
 *
 * The index is built once per call rather than scanning `oc.fields` per column,
 * which made the projection O(columns × fields). This runs on the streaming
 * path — a Shimmer3R can put twenty-odd channels through it at 1024 Hz, and
 * both factors grow with the channel count together — so the quadratic term is
 * the whole cost. Keyed by kind then name rather than by a joined string so
 * there is no per-field key allocation to collect afterwards.
 */
declare function objectClusterRow(oc: ObjectCluster, columns: readonly ObjectClusterColumn[]): (number | null)[];

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
interface RtcDriftSampleInput {
    /** Host wall-clock unix seconds at the midpoint of the device-time read. */
    hostSec: number;
    /** Device clock in unix seconds, as read from the device. */
    devSec: number;
    /** Read round-trip in ms (kept per sample so outliers are explainable). */
    rttMs: number;
    /** Host monotonic clock (e.g. `performance.now()`) in ms at the read. */
    perfMs: number;
}
interface RtcDriftSample extends RtcDriftSampleInput {
    /** Device-minus-host clock offset in seconds. */
    offsetSec: number;
}
/** What {@link RtcDriftMonitor.addSample} concluded about a new sample. */
type RtcDriftSampleEvent = {
    kind: 'sample';
    sample: RtcDriftSample;
}
/** The HOST wall clock stepped (NTP): the fit baseline was reset and the
 * series restarted from this sample. */
 | {
    kind: 'host-step';
    sample: RtcDriftSample;
    hostStepSec: number;
}
/** The DEVICE clock stepped between samples. */
 | {
    kind: 'device-step';
    sample: RtcDriftSample;
    deltaSec: number;
};
interface RtcDriftMonitorOptions {
    /** Offset jump treated as a device clock step (default 1 s). */
    deviceStepThresholdSeconds?: number;
    /** Wall-vs-monotonic divergence treated as a host clock step (default 0.5 s). */
    hostStepThresholdSeconds?: number;
}
declare class RtcDriftMonitor {
    readonly samples: RtcDriftSample[];
    /** Device clock steps detected across the whole run (survives rebaselines). */
    deviceSteps: number;
    /** Host (NTP) clock steps detected; each one rebaselines the fit. */
    hostSteps: number;
    private readonly deviceStepThresholdSeconds;
    private readonly hostStepThresholdSeconds;
    constructor(options?: RtcDriftMonitorOptions);
    /** Drop all samples and step counts (e.g. when starting a new run). */
    reset(): void;
    /**
     * Drop the samples but keep the step counters. Call when the device time is
     * written: a time write moves the offset baseline, so every prior sample is
     * invalid and the fit must not straddle the discontinuity.
     */
    rebaseline(): void;
    /**
     * Record one device-time reading. Attributes any offset jump before
     * recording it: wall-clock elapsed minus monotonic elapsed isolates host
     * clock steps (NTP) from device steps. A host step resets the fit baseline
     * (the fit must not straddle the discontinuity); a device step is counted
     * and kept in-series.
     */
    addSample(input: RtcDriftSampleInput): RtcDriftSampleEvent;
    /**
     * Least-squares slope of offset vs host time, in ppm (offset and time are
     * both in seconds, so the dimensionless slope × 1e6 is directly ppm).
     * Null until two samples spanning a non-zero interval exist.
     */
    ppmFit(): number | null;
    /** Elapsed span of the current sample series in minutes (0 when empty). */
    elapsedMinutes(): number;
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
    toCsvRows(metadata?: Record<string, string | number>): string[];
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
/**
 * Feature ids for the SET_FEATURE (0xB7) command: `[0xB7][featureId][value]`.
 * Mirrors the FEATURE_* enum in log-and-stream-common
 * `Comms/shimmer_bt_uart.h`.
 */
declare const BT_FEATURE: Readonly<{
    readonly NONE: 0;
    /** Shimmer3 RN4678 error LEDs. */
    readonly RN4678_ERROR_LEDS: 1;
    /**
     * Arm a one-shot soft reboot that fires when the host disconnects. Lets a
     * host apply settings only read at boot (e.g. the EEPROM brand record's
     * advertising names) without the user power-cycling the device. Firmware
     * skips the reboot while sensing, so an armed request can never truncate an
     * active SD recording.
     */
    readonly REBOOT_ON_DISCONNECT: 2;
}>;
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

/**
 * Channel format descriptor for a single Shimmer3 / Shimmer3R data channel.
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
 * Which hardware family a channel list came from.
 *
 * The channel ID byte is *not* self-describing: the same ID can mean a
 * different signal, and occupy a different number of bytes, on the two
 * generations. See {@link resolveChannelFormat}.
 */
type ShimmerGeneration = 'shimmer3' | 'shimmer3r';
/**
 * Map a DEVICE_VERSION_RESPONSE hardware id onto a generation, or `null` when
 * the id is unknown/absent (the caller then has to pick a default and say so —
 * see `Shimmer3RClient.generation`).
 */
declare function generationFromHardwareVersion(hardwareVersion: number | null | undefined): ShimmerGeneration | null;
/**
 * Mapping from channel ID byte to its format descriptor, for the channels
 * whose name, width and encoding are **identical on Shimmer3 and Shimmer3R**.
 * Channel IDs are reported in the INQUIRY_RSP payload.
 *
 * This is the base layer of a two-layer table. Prefer
 * {@link channelFormatsFor} or {@link resolveChannelFormat}, which apply the
 * per-generation layer on top — a lookup straight into this map silently
 * misses every channel in {@link CHANNEL_FORMAT_OVERRIDES}, including the
 * pressure/temperature pair whose *width* differs between the generations.
 *
 * Two entries are kept generation-independent for API stability even though
 * the firmware names them differently on each platform:
 *
 * - `0x12` → `PPG`. The firmware calls it `INTERNAL_ADC_13` on a Shimmer3 and
 *   `INTERNAL_ADC_1` on a Shimmer3R (`shimmer_sensing.h:107-122`); it is the
 *   internal ADC line the optical front end sits on, and `PPG` is the name
 *   this SDK has always emitted for it. Width and encoding are the same on
 *   both, so nothing decodes wrongly — only the label is platform-neutral.
 * - `0x14`-`0x16` → `HG_ACCEL_*`. The firmware calls these `X/Y/Z_ALT_ACCEL`.
 */
declare const CHANNEL_FORMATS: Readonly<Record<number, ChannelFormat>>;
/**
 * Per-generation channel table, layered over {@link CHANNEL_FORMATS}.
 *
 * Two kinds of entry live here, and only one of them is cosmetic:
 *
 * 1. **The ADC block, `0x0D`-`0x13`.** The IDs are reused with different
 *    meanings on the two platforms — `shimmer_sensing.h:107-122` defines
 *    `EXTERNAL_ADC_7/6/15` and `INTERNAL_ADC_1/12/13/14` under
 *    `#elif defined(SHIMMER3)` and `EXTERNAL_ADC_0/1/2` +
 *    `INTERNAL_ADC_3/0/1/2` under `#if defined(SHIMMER3R)`. All are 2 bytes
 *    little-endian on both, so picking the wrong platform costs a wrong
 *    *label*, not a wrong number.
 * 2. **`0x1A` BMP_TEMPERATURE and `0x1B` BMP_PRESSURE.** These differ in
 *    **width and byte order**, which is what makes the table generation-aware
 *    rather than merely generation-labelled:
 *
 *    - Shimmer3 carries a BMP180/BMP280 read over I²C, MSB first:
 *      2 big-endian bytes of temperature followed by 3 big-endian bytes of
 *      pressure (`LogAndStream_Shimmer3/i2c.c:389-394` emits
 *      `BMP_TEMPERATURE` then `BMP_PRESSURE` and advances `sensing.dataLen`
 *      by `BMPX80_PACKET_SIZE`, which `Shimmer_Driver/BMPX80/bmpX80.h:103-105`
 *      defines as `BMPX80_TEMP_BUFF_SIZE 0x02 + BMPX80_PRESS_BUFF_SIZE 0x03`).
 *    - Shimmer3R carries a BMP390/BMP581 read over SPI, LSB first: 3
 *      little-endian bytes each, **pressure first**
 *      (`LogAndStream_Shimmer3R/Core/Src/spi.c:739-756`, the
 *      `#if defined(SHIMMER3R)` arm, `sensing.dataLen += 3` twice).
 *
 *    So enabling the stock pressure sensor makes a Shimmer3 packet 1 byte and
 *    a Shimmer3R packet 2 bytes longer than a 2-bytes-per-channel assumption
 *    predicts, and every channel after pressure decodes from the wrong offset.
 *    The emission *order* of the pair is also reversed between the two
 *    generations, which is why a host must always take the channel order from
 *    the inquiry response rather than from a fixed list of its own.
 * 3. **`0x27`/`0x28` STRAIN_HIGH/STRAIN_LOW.** Shimmer3-only: the bridge
 *    amplifier is an expansion board with no Shimmer3R equivalent, so these
 *    are deliberately absent from the `shimmer3r` table and a Shimmer3R
 *    reporting them is reported as an unknown channel rather than guessed at.
 *
 * Names follow the SD-log channel tables in `devices/sdlog/channels.ts` so the
 * streamed and logged copies of the same signal carry the same label. The one
 * exception is the BMP pair: the SD-log header names the exact part
 * (`TEMPERATURE_BMP390`, `PRESSURE_BMP280`) because it records it, whereas the
 * inquiry response does not say which sensor is fitted, so the streaming names
 * stay unqualified.
 *
 * The ADC block's Shimmer3R names are the firmware's logical indices
 * (`EXTERNAL_ADC_0`…), which is what `devices/sdlog/channels.ts` already uses.
 * The Java driver instead names the same channels after the STM32 ADC lines
 * they sit on — `ExtAdc9`/`ExtAdc11`/`ExtAdc12`, `IntAdc17`/`IntAdc10`/
 * `IntAdc16` (`Configuration.java:594-601`, a second block of constants for the
 * same ID values) — so a Shimmer3R CSV from the Java tools labels these columns
 * differently. Same channel, same bytes, different vocabulary.
 *
 * HARDWARE-VERIFY: every width and byte order here is read out of the firmware
 * sources cited above and pinned by unit tests, but no packet from a real sensor
 * with pressure/temperature enabled has been decoded yet, on either generation.
 * The endianness in particular is inferred from the sensors' register order
 * (BMP180/BMP280 burst MSB first over I²C; BMP390/BMP581 LSB first over SPI)
 * and agrees with the Java driver's `u16r`/`u24r` vs `u24` type strings.
 */
declare const CHANNEL_FORMAT_OVERRIDES: Readonly<Record<ShimmerGeneration, Readonly<Record<number, ChannelFormat>>>>;
/**
 * The complete channel table for one hardware generation: every entry of
 * {@link CHANNEL_FORMATS} with {@link CHANNEL_FORMAT_OVERRIDES} applied on top.
 *
 * Frozen and pre-built, so this is a lookup rather than a merge per call.
 */
declare function channelFormatsFor(generation: ShimmerGeneration): Readonly<Record<number, ChannelFormat>>;
/**
 * Resolve one channel ID for one generation, or `undefined` when this SDK has
 * no description for it.
 *
 * `undefined` is the honest answer and callers must treat it as one: a channel
 * whose width is unknown makes the offset of every channel *after* it in the
 * packet unknown too, because the packet carries no per-channel length. Never
 * substitute a guessed width silently — see how
 * `Shimmer3RClient._buildSchemaFromChannels` and `buildShimmer3Schema` flag it.
 */
declare function resolveChannelFormat(id: number, generation: ShimmerGeneration): ChannelFormat | undefined;
/**
 * True when this channel ID is described differently on the two generations, by
 * label, by layout, or by existing on only one of them.
 *
 * This is the broad question, and a true answer is **not** on its own a reason
 * to distrust a frame: across most of the ADC block the difference is the
 * channel's *name* only. Use {@link channelLayoutDiffersByGeneration} for the
 * narrower question of whether the bytes would actually be misread.
 */
declare function isGenerationSensitiveChannel(id: number): boolean;
/**
 * True when assuming the wrong generation for this channel ID would **misread**
 * the bytes rather than merely mislabel them: the width, the byte order, or
 * whether the channel exists at all differs between the two generations.
 *
 * This is the predicate that gates `StreamSchema.trusted`, and it is
 * deliberately narrower than {@link isGenerationSensitiveChannel}:
 *
 * - `0x1A`/`0x1B` qualify — 2 big-endian bytes then 3 on a Shimmer3 versus 3
 *   little-endian bytes each on a Shimmer3R, emitted in the opposite order.
 * - The Shimmer3-only `0x27`/`0x28` qualify, because they resolve to nothing at
 *   all on a Shimmer3R, so assuming the wrong way either invents a width or
 *   loses one.
 * - The ADC block `0x0D`-`0x13` does **not** qualify: `u16`, little-endian, 2
 *   bytes on both generations, so guessing wrong costs a column heading rather
 *   than a number.
 *
 * Compares the *resolved* formats, not the override layers, so a channel that
 * one generation overrides back to the same layout as the shared
 * {@link CHANNEL_FORMATS} entry is correctly reported as layout-identical.
 */
declare function channelLayoutDiffersByGeneration(id: number): boolean;
/**
 * The width assumed for a channel ID this SDK cannot describe.
 *
 * Two bytes is the commonest width by far, so it is the least-bad guess and it
 * keeps a packet with one unfamiliar channel decodable instead of undecodable.
 * It is only ever a guess, though: when a schema uses it, the schema is marked
 * untrustworthy (`StreamSchema.trusted === false`, the offending IDs listed in
 * `unknownChannelIds`) and every field from the guess onwards is marked
 * `offsetTrusted: false`. A host seeing that should treat those fields as
 * unusable and update the SDK, not publish the numbers.
 */
declare const UNKNOWN_CHANNEL_ASSUMED_BYTES = 2;

/**
 * ADS1292R (EXG) register-bank codec — decode a 10-byte per-chip register
 * bank into structured, human-readable settings and encode it back, enforcing
 * the hardware "must-be" bits.
 *
 * Pure port of the Java oracle:
 *   - decode           : ShimmerObject.exgBytesGetConfigFrom
 *                        (ShimmerObject.java:6894-6940)
 *   - field bit-layout : ExGConfigBytesDetails.mMapOfExGSettingsChip1
 *                        (ExGConfigBytesDetails.java:369-451) — every field's
 *                        byteIndex / bitShift / mask
 *   - encode           : ExGConfigBytesDetails.generateExgByteArray
 *                        (ExGConfigBytesDetails.java:487-502)
 *   - must-be bits     : ExGConfigBytesDetails.setExgByteArrayConstants
 *                        (ExGConfigBytesDetails.java:507-525)
 *   - option labels    : SensorEXG.java:116-149 (GUI value lists) and the
 *                        EXG_SETTING_OPTIONS enums (ExGConfigBytesDetails.java:116-360)
 *   - gain value map   : SensorEXG.convertEXGGainSettingToValue
 *                        (SensorEXG.java:2637)
 *
 * Resolution (16- vs 24-bit) is NOT a register field — it lives in the sensor
 * bitmap. See {@link exgResolutionFromSensors} in ./presets.ts
 * (ShimmerObject.checkExgResolutionFromEnabledSensorsVar, :7255-7279).
 */
/** Number of register bytes in one ADS1292R chip bank (InfoMem EXG_BANK_LENGTH). */
declare const EXG_BANK_LENGTH = 10;
/** REG1 conversion mode (ExGConfigBytesDetails.java:119-120). */
declare const CONVERSION_MODE_LABELS: readonly ["Continuous Conversion Mode", "Single-shot mode"];
/** REG1 data rate 0-6 (SensorEXG.java:148 ListOfExGRate). */
declare const DATA_RATE_LABELS: readonly ["125 Hz", "250 Hz", "500 Hz", "1 kHz", "2 kHz", "4 kHz", "8 kHz"];
/** REG2 voltage reference (ExGConfigBytesDetails.java:142-143). */
declare const VOLTAGE_REFERENCE_LABELS: readonly ["2.42 V", "4.033 V"];
/** REG2 test-signal frequency (ExGConfigBytesDetails.java:154-155). */
declare const TEST_SIGNAL_FREQUENCY_LABELS: readonly ["DC", "1 kHz Square Wave"];
/** REG3 lead-off comparator threshold 0-7 (SensorEXG.java:136). */
declare const COMPARATOR_THRESHOLD_LABELS: readonly ["Pos:95%-Neg:5%", "Pos:92.5%-Neg:7.5%", "Pos:90%-Neg:10%", "Pos:87.5%-Neg:12.5%", "Pos:85%-Neg:15%", "Pos:80%-Neg:20%", "Pos:75%-Neg:25%", "Pos:70%-Neg:30%"];
/** REG3 lead-off current 0-3 (SensorEXG.java:134). */
declare const LEAD_OFF_CURRENT_LABELS: readonly ["6 nA", "22 nA", "6 uA", "22 uA"];
/** REG3 lead-off frequency (ExGConfigBytesDetails.java:177-178). */
declare const LEAD_OFF_FREQUENCY_LABELS: readonly ["DC lead-off detect", "AC lead-off detect (fs / 4)"];
/** REG4/REG5 PGA gain setting 0-6 → GUI label (SensorEXG.java:116 ListOfExGGain). */
declare const GAIN_LABELS: readonly ["6", "1", "2", "3", "4", "8", "12"];
/** REG4/REG5 PGA gain setting 0-6 → numeric gain (SensorEXG.convertEXGGainSettingToValue, :2637). */
declare const GAIN_VALUES: readonly [6, 1, 2, 3, 4, 8, 12];
/** REG4/REG5 channel power-down (ExGConfigBytesDetails.java:184-185). */
declare const POWER_DOWN_LABELS: readonly ["Normal operation", "Power-down"];
/** REG4/REG5 input selection 0-9 (ExGConfigBytesDetails.java:196-234). */
declare const INPUT_SELECTION_LABELS: readonly ["Normal electrode input", "Input shorted", "RLD_MEASURE", "Supply measurement", "Temperature sensor", "Test signal", "RLD_DRP (positive side connected to RLDIN)", "RLD_DRM (negative side connected to RLDIN)", "RLD_DRPM (both connected to RLDIN)", "Route IN3P/IN3N to channel 1 inputs"];
/** REG6 PGA chop frequency (ExGConfigBytesDetails.java:240-242; value 1 is reserved). */
declare const CHOP_FREQUENCY_LABELS: readonly ["fMOD / 16", "reserved", "fMOD / 2", "fMOD / 4"];
/** REG9 respiration phase at 32 kHz, 0-15 (SensorEXG.java:143). */
declare const RESPIRATION_PHASE_32KHZ_LABELS: readonly ["0°", "11.25°", "22.5°", "33.75°", "45°", "56.25°", "67.5°", "78.75°", "90°", "101.25°", "112.5°", "123.75°", "135°", "146.25°", "157.5°", "168.75°"];
/** REG9 respiration phase at 64 kHz, 0-7 (SensorEXG.java:145). */
declare const RESPIRATION_PHASE_64KHZ_LABELS: readonly ["0°", "22.5°", "45°", "67.5°", "90°", "112.5°", "135°", "157.5°"];
/** REG10 respiration control frequency (SensorEXG.java:140). */
declare const RESPIRATION_FREQUENCY_LABELS: readonly ["32 kHz", "64 kHz"];
/** REG10 RLD reference signal (ExGConfigBytesDetails.java:357-358). */
declare const RLD_REFERENCE_SIGNAL_LABELS: readonly ["Fed externally", "(AVDD - AVSS) / 2"];
/** REG9 respiration control clock (ExGConfigBytesDetails.java:342-343). */
declare const RESPIRATION_CONTROL_LABELS: readonly ["Internal clock", "External Clock"];
/**
 * Lead-off detection mode (the "Lead-Off Detection" GUI knob). The GUI exposes
 * only Off / DC Current (SensorEXG.ListOfExGLeadOffDetection, SensorEXG.java:132);
 * the setter also supports an AC-current mode (value 2) which the GUI does not
 * offer (see the knob helpers in ./knobs.ts).
 */
declare const LEAD_OFF_DETECTION_LABELS: readonly ["Off", "DC Current"];
/**
 * Reference-electrode options as `{ value, label }`, verbatim from the Java
 * "All" list ListOfExGReferenceElectrodeAll / …ConfigValuesAll
 * (SensorEXG.java:123-124): Fixed Potential (0), Inverse of Ch1 (3), Inverse
 * Wilson CT (13), 3-Ch Single-ended (7). The value is the REG6 low-nibble RLD
 * input-routing code, NOT an index — see setEXGReferenceElectrode
 * (SensorEXG.java:2483-2489). The 3-Ch single-ended entry is kept for data
 * fidelity but EX4 builds no special UI for it (docs/handoff/13 EX4 descope).
 */
declare const REFERENCE_ELECTRODE_OPTIONS: ReadonlyArray<{
    value: number;
    label: string;
}>;
/** Every ADS1292R register field, keyed by a stable name. */
declare const FIELDS: {
    readonly conversionMode: {
        readonly byteIndex: 0;
        readonly bitShift: 7;
        readonly mask: 1;
    };
    readonly dataRate: {
        readonly byteIndex: 0;
        readonly bitShift: 0;
        readonly mask: 7;
    };
    readonly leadOffComparators: {
        readonly byteIndex: 1;
        readonly bitShift: 6;
        readonly mask: 1;
    };
    readonly referenceBuffer: {
        readonly byteIndex: 1;
        readonly bitShift: 5;
        readonly mask: 1;
    };
    readonly voltageReference: {
        readonly byteIndex: 1;
        readonly bitShift: 4;
        readonly mask: 1;
    };
    readonly oscillatorClockConnection: {
        readonly byteIndex: 1;
        readonly bitShift: 3;
        readonly mask: 1;
    };
    readonly testSignalSelection: {
        readonly byteIndex: 1;
        readonly bitShift: 1;
        readonly mask: 1;
    };
    readonly testSignalFrequency: {
        readonly byteIndex: 1;
        readonly bitShift: 0;
        readonly mask: 1;
    };
    readonly comparatorThreshold: {
        readonly byteIndex: 2;
        readonly bitShift: 5;
        readonly mask: 7;
    };
    readonly leadOffCurrent: {
        readonly byteIndex: 2;
        readonly bitShift: 2;
        readonly mask: 3;
    };
    readonly leadOffFrequency: {
        readonly byteIndex: 2;
        readonly bitShift: 0;
        readonly mask: 1;
    };
    readonly ch1PowerDown: {
        readonly byteIndex: 3;
        readonly bitShift: 7;
        readonly mask: 1;
    };
    readonly ch1Gain: {
        readonly byteIndex: 3;
        readonly bitShift: 4;
        readonly mask: 7;
    };
    readonly ch1InputSelection: {
        readonly byteIndex: 3;
        readonly bitShift: 0;
        readonly mask: 15;
    };
    readonly ch2PowerDown: {
        readonly byteIndex: 4;
        readonly bitShift: 7;
        readonly mask: 1;
    };
    readonly ch2Gain: {
        readonly byteIndex: 4;
        readonly bitShift: 4;
        readonly mask: 7;
    };
    readonly ch2InputSelection: {
        readonly byteIndex: 4;
        readonly bitShift: 0;
        readonly mask: 15;
    };
    readonly chopFrequency: {
        readonly byteIndex: 5;
        readonly bitShift: 6;
        readonly mask: 3;
    };
    readonly rldBufferPower: {
        readonly byteIndex: 5;
        readonly bitShift: 5;
        readonly mask: 1;
    };
    readonly rldLeadOffSenseFunction: {
        readonly byteIndex: 5;
        readonly bitShift: 4;
        readonly mask: 1;
    };
    readonly ch2RldNegInputs: {
        readonly byteIndex: 5;
        readonly bitShift: 3;
        readonly mask: 1;
    };
    readonly ch2RldPosInputs: {
        readonly byteIndex: 5;
        readonly bitShift: 2;
        readonly mask: 1;
    };
    readonly ch1RldNegInputs: {
        readonly byteIndex: 5;
        readonly bitShift: 1;
        readonly mask: 1;
    };
    readonly ch1RldPosInputs: {
        readonly byteIndex: 5;
        readonly bitShift: 0;
        readonly mask: 1;
    };
    readonly ch2FlipCurrent: {
        readonly byteIndex: 6;
        readonly bitShift: 5;
        readonly mask: 1;
    };
    readonly ch1FlipCurrent: {
        readonly byteIndex: 6;
        readonly bitShift: 4;
        readonly mask: 1;
    };
    readonly ch2LeadOffDetectNegInputs: {
        readonly byteIndex: 6;
        readonly bitShift: 3;
        readonly mask: 1;
    };
    readonly ch2LeadOffDetectPosInputs: {
        readonly byteIndex: 6;
        readonly bitShift: 2;
        readonly mask: 1;
    };
    readonly ch1LeadOffDetectNegInputs: {
        readonly byteIndex: 6;
        readonly bitShift: 1;
        readonly mask: 1;
    };
    readonly ch1LeadOffDetectPosInputs: {
        readonly byteIndex: 6;
        readonly bitShift: 0;
        readonly mask: 1;
    };
    readonly clockDividerSelection: {
        readonly byteIndex: 7;
        readonly bitShift: 6;
        readonly mask: 1;
    };
    readonly rldLeadOffStatus: {
        readonly byteIndex: 7;
        readonly bitShift: 4;
        readonly mask: 1;
    };
    readonly ch2NegElectrodeStatus: {
        readonly byteIndex: 7;
        readonly bitShift: 3;
        readonly mask: 1;
    };
    readonly ch2PosElectrodeStatus: {
        readonly byteIndex: 7;
        readonly bitShift: 2;
        readonly mask: 1;
    };
    readonly ch1NegElectrodeStatus: {
        readonly byteIndex: 7;
        readonly bitShift: 1;
        readonly mask: 1;
    };
    readonly ch1PosElectrodeStatus: {
        readonly byteIndex: 7;
        readonly bitShift: 0;
        readonly mask: 1;
    };
    readonly respirationDemodCircuitry: {
        readonly byteIndex: 8;
        readonly bitShift: 7;
        readonly mask: 1;
    };
    readonly respirationModCircuitry: {
        readonly byteIndex: 8;
        readonly bitShift: 6;
        readonly mask: 1;
    };
    readonly respirationPhase: {
        readonly byteIndex: 8;
        readonly bitShift: 2;
        readonly mask: 15;
    };
    readonly respirationControl: {
        readonly byteIndex: 8;
        readonly bitShift: 0;
        readonly mask: 1;
    };
    readonly respirationCalibration: {
        readonly byteIndex: 9;
        readonly bitShift: 7;
        readonly mask: 1;
    };
    readonly respirationControlFrequency: {
        readonly byteIndex: 9;
        readonly bitShift: 2;
        readonly mask: 1;
    };
    readonly rldReferenceSignal: {
        readonly byteIndex: 9;
        readonly bitShift: 1;
        readonly mask: 1;
    };
};
type FieldName = keyof typeof FIELDS;
/**
 * The stable name of a single ADS1292R register field (the keys of the internal
 * bit-layout table). Exported so the per-knob edit layer (./knobs.ts) can
 * address individual fields by name and reuse this module's bit-layout as the
 * single source of truth, rather than duplicating byteIndex/shift/mask.
 */
type ExgFieldName = FieldName;
/**
 * Read one register field's raw config value out of a 10-byte bank. Companion
 * to {@link setExgFieldPreserving}; both consult the internal bit-layout table.
 */
declare function readExgField(bank: Uint8Array, name: ExgFieldName): number;
/**
 * Write one register field's value into a 10-byte bank IN PLACE, clearing that
 * field's bits first so every OTHER bit in the byte is preserved (unlike the
 * encode-time {@link writeField}, which assumes a freshly zeroed bank and only
 * ORs bits in). This is the primitive the per-knob edit layer builds on: it lets
 * a single knob change exactly its field and leave the rest of the populated
 * bank untouched. Does NOT re-apply the must-be bits — callers do that once
 * after all field writes (see ./knobs.ts).
 */
declare function setExgFieldPreserving(bank: Uint8Array, name: ExgFieldName, value: number): void;
/** A decoded register field: raw config value plus a human-readable label. */
interface ExgFieldValue {
    /** Raw config value as read from the register bits. */
    value: number;
    /** Human-readable label from the Java GUI value lists. */
    label: string;
}
/** A decoded PGA-gain field with its numeric gain value. */
interface ExgGainValue extends ExgFieldValue {
    /** Numeric PGA gain (6,1,2,3,4,8,12) — SensorEXG.convertEXGGainSettingToValue. */
    gain: number;
}
/** Per-channel (CH1/CH2) settings from REG4/REG5. */
interface ExgChannelSettings {
    powerDown: ExgFieldValue;
    gain: ExgGainValue;
    inputSelection: ExgFieldValue;
}
/** Lead-off detection settings (REG2 comparator enable + REG3 + REG7 per-lead). */
interface ExgLeadOffSettings {
    /** True when the lead-off comparators are powered on (REG2 bit6). */
    detectionEnabled: boolean;
    comparators: ExgFieldValue;
    current: ExgFieldValue;
    comparatorThreshold: ExgFieldValue;
    frequency: ExgFieldValue;
    ch1: {
        posInput: ExgFieldValue;
        negInput: ExgFieldValue;
        flipCurrent: ExgFieldValue;
    };
    ch2: {
        posInput: ExgFieldValue;
        negInput: ExgFieldValue;
        flipCurrent: ExgFieldValue;
    };
}
/** Respiration circuitry settings (REG9/REG10 — only meaningful on chip 2). */
interface ExgRespirationSettings {
    /** True when both the modulation and demodulation circuits are on. */
    enabled: boolean;
    demod: ExgFieldValue;
    mod: ExgFieldValue;
    phase: ExgFieldValue;
    control: ExgFieldValue;
    calibration: ExgFieldValue;
    frequency: ExgFieldValue;
}
/** Right-leg-drive (RLD) routing (REG6 + REG10 reference). */
interface ExgRldSettings {
    bufferPower: ExgFieldValue;
    leadOffSenseFunction: ExgFieldValue;
    chopFrequency: ExgFieldValue;
    referenceSignal: ExgFieldValue;
    ch1: {
        posInput: ExgFieldValue;
        negInput: ExgFieldValue;
    };
    ch2: {
        posInput: ExgFieldValue;
        negInput: ExgFieldValue;
    };
}
/** Test-signal settings (REG2). */
interface ExgTestSignalSettings {
    enabled: ExgFieldValue;
    frequency: ExgFieldValue;
}
/** Read-only lead-off status bits (REG8). */
interface ExgStatusBits {
    clockDivider: ExgFieldValue;
    rldLeadOff: ExgFieldValue;
    ch1PosElectrode: ExgFieldValue;
    ch1NegElectrode: ExgFieldValue;
    ch2PosElectrode: ExgFieldValue;
    ch2NegElectrode: ExgFieldValue;
}
/** Fully decoded ADS1292R register bank for one chip. */
interface DecodedExgRegisters {
    conversionMode: ExgFieldValue;
    dataRate: ExgFieldValue;
    referenceBuffer: ExgFieldValue;
    voltageReference: ExgFieldValue;
    oscillatorClockConnection: ExgFieldValue;
    testSignal: ExgTestSignalSettings;
    /** CH1 settings (REG4). */
    ch1: ExgChannelSettings;
    /** CH2 settings (REG5). */
    ch2: ExgChannelSettings;
    /** Reference-electrode selection (byte5 & 0x0F, ShimmerObject.java:6912). */
    referenceElectrode: ExgFieldValue;
    leadOff: ExgLeadOffSettings;
    rld: ExgRldSettings;
    respiration: ExgRespirationSettings;
    /** Read-only status bits (REG8) — cleared on write by the must-be constants. */
    status: ExgStatusBits;
    /** The 10 raw register bytes this was decoded from. */
    raw: number[];
}
/**
 * Decode a single 10-byte ADS1292R register bank into structured settings.
 * Mirrors ShimmerObject.exgBytesGetConfigFrom (ShimmerObject.java:6894-6940)
 * combined with ExGConfigBytesDetails.updateFromRegisterArray (:528-539).
 *
 * @throws RangeError when the bank is not exactly 10 bytes.
 */
declare function decodeExgRegisters(bank: Uint8Array): DecodedExgRegisters;
/**
 * Force the ADS1292R "must-be" bits listed in the datasheet, exactly as
 * ExGConfigBytesDetails.setExgByteArrayConstants (ExGConfigBytesDetails.java:507-525).
 * Mutates and returns the array.
 */
declare function applyExgMustBeBits(bank: Uint8Array): Uint8Array;
/**
 * Encode structured settings back into a 10-byte register bank, applying the
 * mandatory must-be bits. Inverse of {@link decodeExgRegisters}; mirrors
 * ExGConfigBytesDetails.generateExgByteArray (ExGConfigBytesDetails.java:487-502).
 *
 * A round-trip `encodeExgRegisters(decodeExgRegisters(bank))` reproduces
 * `bank` for any bank already satisfying the must-be bits (all Java presets do).
 */
declare function encodeExgRegisters(settings: DecodedExgRegisters): Uint8Array;

/**
 * ADS1292R (EXG) per-knob EDITING — change a single named setting on a pair of
 * register banks, enforcing the hardware "must-be" bits and preserving every
 * other bit, with typed validation and the desktop's respiration coupling rules.
 *
 * Where EX2's `apply.ts` writes a WHOLE preset, this module (EX4) is the
 * per-knob layer the docked config editor stages individual edits through. It is
 * pure and transport-free.
 *
 * Java oracle:
 *   - knob set + GUI labels : SensorEXG.GuiLabelConfig (SensorEXG.java:157-168),
 *     value lists SensorEXG.java:116-149.
 *   - which chip(s) each knob writes: the SensorEXG setters behind
 *     setConfigValueUsingConfigLabel (SensorEXG.java:2948-2998):
 *       · Gain  — setExGGainSetting(chipID, channel, v) per chip+channel
 *                 (SensorEXG.java:2314-2331); the GUI's single "Gain" knob sets
 *                 all four via setExGGainSetting(v) (:2333-2338).
 *       · Rate  — setEXGRateSetting(v) writes REG1 on BOTH chips (:2468-2471).
 *       · Reference electrode — setEXGReferenceElectrode(v) writes the four REG6
 *                 RLD-input bits on CHIP1 only (:2483-2489).
 *       · Lead-off detection — setEXGLeadOffCurrentMode(mode) flips comparators /
 *                 RLD sense / per-lead detect bits across BOTH chips
 *                 (:2495-2575); Off=0 / DC=1 ported (AC=2 descoped, GUI omits it).
 *       · Lead-off current — setEXGLeadOffDetectionCurrent(v) REG3 both chips
 *                 (:2600-2604).
 *       · Lead-off comparator threshold — setEXGLeadOffComparatorTreshold(v) REG3
 *                 both chips (:2610-2614).
 *       · Respiration freq — setEXG2RespirationDetectFreq(v) CHIP2 only, and
 *                 FORCES the phase to the frequency's canonical default
 *                 (:2618-2628, see the freq-flip note below).
 *       · Respiration phase — setEXG2RespirationDetectPhase(v) CHIP2 only
 *                 (:2634-2635).
 *   - phase-by-frequency lists : ListOfExGRespirationDetectPhase32khz (16 steps,
 *     values 0-15) / …64khz (8 steps, values 0-7), SensorEXG.java:143-146.
 *   - freq-flip behaviour : setEXG2RespirationDetectFreq re-validates the phase
 *     against the new list (checkWhichExgRespPhaseValuesToUse, :2883-2907,
 *     resets to configvalues[0] if the current phase is now illegal) and THEN
 *     sets a canonical phase: 112.5° (reg value 10) at 32 kHz, 157.5° (reg value
 *     7) at 64 kHz (:2622-2627). We port that net effect: flipping the frequency
 *     auto-remaps the phase to that frequency's default.
 *   - respiration-locked-unless-enabled : the desktop only opens the freq/phase
 *     popups when the respiration sensor is enabled (PanelAdvancedExG.java:340,
 *     357-361, 416-420). We reject freq/phase/control edits when chip-2
 *     respiration (demod+mod) is off — see the contract note on the knob table.
 */
/** The two per-chip register banks the editor stages edits against. */
interface ExgBanks {
    /** EXG1 (chip-1) register bank — 10 bytes. */
    exg1: Uint8Array;
    /** EXG2 (chip-2) register bank — 10 bytes. */
    exg2: Uint8Array;
}
/** A selectable value for a knob: raw register/config value + human label. */
interface ExgKnobOption {
    value: number;
    label: string;
}
/**
 * Every editable EXG knob, keyed by a stable name. Chip addressing is explicit
 * in the name where it matters: the four gain knobs name their chip AND channel
 * ('exg1Ch1Gain' = chip-1 CH1), and the respiration knobs are chip-2 only.
 */
type ExgKnobField = 'exg1Ch1Gain' | 'exg1Ch2Gain' | 'exg2Ch1Gain' | 'exg2Ch2Gain' | 'dataRate' | 'referenceElectrode' | 'leadOffDetection' | 'leadOffCurrent' | 'leadOffComparatorThreshold' | 'respirationEnable' | 'respirationFrequency' | 'respirationPhase';
/** A single staged knob edit: which field, and the raw value to set. */
interface ExgKnobEdit {
    field: ExgKnobField;
    value: number;
}
/** Base class for all knob-edit errors (so callers can `instanceof` one type). */
declare class ExgKnobError extends Error {
}
/** Thrown when a knob field name is not recognised. */
declare class UnknownExgKnobError extends ExgKnobError {
    readonly field: string;
    constructor(field: string);
}
/** Thrown when a value is not one of the knob's legal options. */
declare class ExgKnobValueError extends ExgKnobError {
    readonly field: ExgKnobField;
    readonly value: number;
    readonly allowed: readonly number[];
    constructor(field: ExgKnobField, value: number, allowed: readonly number[]);
}
/**
 * Thrown when a respiration-only knob (frequency / phase) is edited while
 * chip-2 respiration is disabled (the desktop locks these — see the module
 * header). Enable respiration first (the `respirationEnable` knob, or the EX2
 * Respiration preset).
 */
declare class ExgRespirationLockedError extends ExgKnobError {
    readonly field: ExgKnobField;
    constructor(field: ExgKnobField);
}
/** Per-channel PGA gain options (label = GUI gain, value = REG4/5 setting 0-6). */
declare const GAIN_OPTIONS: readonly ExgKnobOption[];
/** REG1 data-rate options (values 0-6). */
declare const DATA_RATE_OPTIONS: readonly ExgKnobOption[];
/** REG3 lead-off current options (values 0-3). */
declare const LEAD_OFF_CURRENT_OPTIONS: readonly ExgKnobOption[];
/** REG3 lead-off comparator-threshold options (values 0-7). */
declare const LEAD_OFF_COMPARATOR_OPTIONS: readonly ExgKnobOption[];
/** Lead-off detection mode options — Off (0) / DC Current (1). */
declare const LEAD_OFF_DETECTION_OPTIONS: readonly ExgKnobOption[];
/** Respiration detection-frequency options — 32 kHz (0) / 64 kHz (1). */
declare const RESPIRATION_FREQUENCY_OPTIONS: readonly ExgKnobOption[];
/**
 * Legal respiration-phase options for a given detection frequency. At 32 kHz
 * (freq value 0) there are 16 phase steps (values 0-15); at 64 kHz (value 1)
 * there are 8 (values 0-7). Verbatim from SensorEXG.java:143-146.
 */
declare function respirationPhaseOptions(freq: number): ExgKnobOption[];
interface KnobSpec {
    /** Desktop GUI label (SensorEXG.GuiLabelConfig). */
    label: string;
    /** Which banks this knob writes (for must-be re-application + docs). */
    banks: ReadonlyArray<'exg1' | 'exg2'>;
    /** Fixed option list, or undefined when it depends on the banks (phase). */
    options?: readonly ExgKnobOption[];
    /** Resolve the option list from the current banks (respiration phase). */
    dynamicOptions?: (banks: ExgBanks) => ExgKnobOption[];
    /** True when the edit is rejected unless chip-2 respiration is enabled. */
    requiresRespiration: boolean;
    /** Apply the (already-validated) value to a mutable clone of the banks. */
    apply: (banks: ExgBanks, value: number) => void;
}
/** The complete editable-knob registry. */
declare const EXG_KNOBS: Readonly<Record<ExgKnobField, KnobSpec>>;
/**
 * The current legal option list for a knob, given the banks (needed for the
 * respiration phase list, which follows the current detection frequency).
 *
 * @throws UnknownExgKnobError for an unrecognised field.
 */
declare function exgKnobOptions(field: ExgKnobField, banks: ExgBanks): ExgKnobOption[];
/** True when chip-2 respiration (both demod + mod circuits) is enabled. */
declare function isExgRespirationEnabled(banks: ExgBanks): boolean;
/**
 * Set ONE knob to `value`, returning NEW banks with the field changed, the
 * must-be bits re-enforced, and every other bit preserved. Pure — the inputs
 * are not mutated.
 *
 * Respiration contract: `respirationFrequency` and `respirationPhase` are
 * REJECTED (throw {@link ExgRespirationLockedError}) unless chip-2 respiration
 * is enabled — matching the desktop, which greys these knobs out until the
 * respiration sensor is on (PanelAdvancedExG.java:340,357-361,416-420). The
 * app disables the corresponding controls, so this throw is a backstop rather
 * than a normal path. `respirationEnable` is the toggle itself and is never
 * gated.
 *
 * Phase/frequency coupling: setting `respirationFrequency` also auto-remaps the
 * phase to that frequency's canonical default (112.5° at 32 kHz, 157.5° at
 * 64 kHz), so the stored phase is never left illegal for the new frequency
 * (matches SensorEXG.setEXG2RespirationDetectFreq). Setting `respirationPhase`
 * directly to a value that is illegal for the CURRENT frequency throws
 * {@link ExgKnobValueError}.
 *
 * @throws RangeError when a bank is not 10 bytes.
 * @throws UnknownExgKnobError for an unrecognised field.
 * @throws ExgKnobValueError when the value is not a legal option.
 * @throws ExgRespirationLockedError for a locked respiration edit.
 */
declare function updateExgSetting(banks: ExgBanks, field: ExgKnobField, value: number): ExgBanks;
/**
 * Apply a batch of knob edits in order, threading each edit's result into the
 * next. Later edits win over earlier ones, and each edit sees the banks as left
 * by the previous (so e.g. a `respirationEnable: 1` edit can precede — and
 * unlock — a `respirationPhase` edit in the same batch). Pure.
 *
 * @throws the same typed errors as {@link updateExgSetting}, on the first
 * offending edit.
 */
declare function applyExgKnobEdits(banks: ExgBanks, edits: readonly ExgKnobEdit[]): ExgBanks;
/**
 * Read the current value of every knob out of a pair of banks — the inverse of
 * a full set. Handy for seeding an editor from the device's current config and
 * for round-trip tests. The respiration-enable and lead-off-detection knobs are
 * derived (they are macros over several bits), everything else reads its field.
 */
declare function readExgKnobs(banks: ExgBanks): Record<ExgKnobField, number>;

/**
 * ADS1292R (EXG) preset detection and resolution derivation.
 *
 * Pure port of the Java oracle:
 *   - preset register arrays : SensorEXG.setDefault... / setEXG... (the commented
 *     reference byte arrays in SensorEXG.java:1782-1783 ECG, 1813-1814 EMG,
 *     1845-1846 test, 1872-1873 respiration, 1921-1922 custom)
 *   - preset detection       : SensorEXG.isEXGUsingDefault*
 *     (SensorEXG.java:2680-2763), invoked in the order
 *     Respiration → ECG → EMG → TestSignal → Custom
 *     (ShimmerObject.java:1791-1820)
 *   - resolution ↔ bitmap    : ShimmerObject.checkExgResolutionFromEnabledSensorsVar
 *     (ShimmerObject.java:7255-7279), using the ConfigByteLayoutShimmer3
 *     sensor-bitmap masks (ConfigByteLayoutShimmer3.java:300-303).
 */
/** A recognised EXG preset, or 'custom' / 'off'. */
type ExgPreset = 'ecg' | 'emg' | 'test-signal' | 'respiration' | 'custom' | 'off';
/** EXG resolution derived from the sensor bitmap. */
type ExgResolution = '16bit' | '24bit';
/**
 * Canonical per-chip register arrays for each preset, verbatim from the Java
 * oracle's reference byte arrays (SensorEXG.java, decimal values). The register
 * bytes are identical for the 16-bit and 24-bit variants of a preset — only the
 * sensor bitmap differs (see {@link exgResolutionFromSensors}).
 */
declare const EXG_PRESET_ARRAYS: Readonly<{
    /** SensorEXG.java:1782-1783 */
    readonly ecg: {
        readonly exg1: readonly number[];
        readonly exg2: readonly number[];
    };
    /** SensorEXG.java:1813-1814 */
    readonly emg: {
        readonly exg1: readonly number[];
        readonly exg2: readonly number[];
    };
    /** SensorEXG.java:1845 */
    readonly 'test-signal': {
        readonly exg1: readonly number[];
        readonly exg2: readonly number[];
    };
    /** SensorEXG.java:1872-1873 */
    readonly respiration: {
        readonly exg1: readonly number[];
        readonly exg2: readonly number[];
    };
    /** SensorEXG.java:1921-1922 */
    readonly custom: {
        readonly exg1: readonly number[];
        readonly exg2: readonly number[];
    };
}>;
/**
 * Derive EXG resolution from the enabled-sensors bitmap. Resolution is not a
 * register field — it lives entirely in the sensor bitmap. Mirrors
 * ShimmerObject.checkExgResolutionFromEnabledSensorsVar (:7255-7279): the
 * 16-bit flags take precedence over the 24-bit flags.
 *
 * @returns '16bit' | '24bit', or null when no EXG chip is enabled.
 */
declare function exgResolutionFromSensors(enabledSensors: number): ExgResolution | null;
/**
 * Detect which preset a pair of register banks represents.
 *
 * Detection is TOLERANT, exactly as the Java oracle's isEXGUsingDefault*
 * checks (SensorEXG.java:2680-2763): it keys only off the CH1/CH2
 * input-selection nibbles (byte3/byte4 low nibble) plus the chip-2 respiration
 * modulation/demodulation bits, and — when {@link enabledSensors} is supplied
 * — the resolution flags. (Respiration is the exception: it keys off the
 * respiration bits and the resolution flags only, never the nibbles — see
 * below.) It does NOT compare the full byte arrays, so the
 * fields the firmware rewrites (the data-rate/oversampling bits in byte0, the
 * oscillator-clock bit in byte1, PGA gain, etc.) do not affect the result.
 * This is why the 16-bit-only hardcoded 3R preset arrays — which differ from
 * the Java reference arrays in byte1 (oscillator-clock bit) and the rate bits —
 * still detect correctly.
 *
 * The resolution gate mirrors Java: ECG/TestSignal/Respiration require both
 * chips at the same resolution; EMG requires chip 1 only. When
 * {@link enabledSensors} is omitted the resolution gate is relaxed (detection
 * proceeds purely on the input-selection/respiration fields), and empty banks
 * report 'off'.
 *
 * Evaluation order is Respiration → ECG → EMG → TestSignal → Custom
 * (ShimmerObject.java:1791-1820): respiration shares the ECG input selections
 * and is distinguished only by its modulation/demodulation bits, so it must be
 * tested first.
 *
 * **Respiration is detected on those two bits alone**, without looking at the
 * input-selection nibbles — so a bank that enables the respiration circuitry
 * over some other input selection is reported as 'respiration' rather than
 * 'custom'. That is deliberate, and it is what the oracle does: the driver's
 * `isEXGUsingDefaultRespirationConfiguration` (SensorEXG.java:1871-1884) tests
 * both chips' resolution flags and the chip-2 modulation and demodulation bits,
 * and the line that would also have required the ECG input selections is
 * commented out in its source. Tightening it here would be worse than the
 * looseness: a sensor that Consensys calls a respiration configuration would
 * then be called 'custom' by this SDK, and the point of this codec is that the
 * two agree about the same device.
 *
 * @throws RangeError when either bank is not exactly 10 bytes.
 */
declare function detectExgPreset(exg1: Uint8Array, exg2: Uint8Array, enabledSensors?: number): ExgPreset;
/** Human-readable label for a detected preset (for read-only display). */
declare function exgPresetLabel(preset: ExgPreset): string;

/**
 * ADS1292R (EXG) preset APPLICATION — turn a chosen preset + resolution into the
 * two register banks and the enabled-sensors bitmap to write.
 *
 * Pure, transport-free port of the Java oracle's preset setters. Where EX1
 * (`presets.ts`) ships the reference register arrays and preset *detection*,
 * this module ships the *write* side: the resolution↔bitmap coupling, the
 * sampling-rate→data-rate coupling, and the sensor-conflict clearing that
 * desktop performs when a preset tile is clicked.
 *
 * Java oracle:
 *   - preset setters        : SensorEXG.setDefaultECGConfiguration (:1781),
 *     setDefaultEMGConfiguration (:1812), setEXGTestSignal (:1844),
 *     setDefaultRespirationConfiguration (:1871). Each calls clearExgConfig()
 *     then setExgChannelBitsPerMode(sensorId) then a series of named field
 *     writes then setDefaultExgCommon(samplingRate).
 *   - resolution↔bitmap     : SensorEXG.setExgChannelBitsPerMode (:2150-2183) +
 *     updateEnabledSensorsFromExgResolution (:2108-2148). Resolution is NOT a
 *     register field — it lives only in the sensor bitmap.
 *   - rate coupling         : SensorEXG.setDefaultExgCommon (:1999-2005) calls
 *     setExGRateFromFreq (:2784-2806), which rewrites REG1 data-rate on BOTH
 *     chips (setEXGRateSetting, :2468-2471) from the device sampling rate.
 *   - oscillator clock      : setDefaultExgCommon sets CHIP1 REG2 oscillator-
 *     clock-connection ON when the chip clocks are joined
 *     (ShimmerVerObject.isSupportedExgChipClocksJoined, :712-723).
 *   - conflict clearing     : ShimmerDevice.sensorMapConflictCheckandCorrect
 *     (:2497-2512) disables every sensor in a sensor's conflict list; EXG's
 *     conflict list is SensorEXG.sDRefEcg etc. (:332-344).
 */

/**
 * Sensors that conflict with any EXG preset, as the Shimmer3 streaming
 * enabled-sensors bitmap masks (Configuration.Shimmer3.SensorBitmap). Ported
 * from the EXG SensorDetailsRef conflict lists (SensorEXG.java:332-344 ECG,
 * identical set for EMG/Test/Respiration): the internal ADC channels, GSR, the
 * resistance amp, and the bridge amp. The resistance amp shares the bridge-amp
 * bit on Shimmer3 (Configuration.java:643), so clearing SENSOR_BRIDGE_AMP
 * covers both.
 *
 * NAMING: the internal-ADC labels below are the Java driver's Shimmer3-era
 * names (A1/A12/A13/A14, the MSP430 ADC input numbers). This SDK's own
 * `SensorBitmapShimmer3` names the SAME four bits A3/A0/A1/A2, following the
 * Shimmer3R firmware — so 0x000400 is `SENSOR_INT_A1` in Java but
 * `SENSOR_INT_A3` here, and 0x000100 is `SENSOR_INT_A13` there and
 * `SENSOR_INT_A1` here. The masks are what matter and they agree; only the
 * display names differ by generation.
 */
declare const EXG_CONFLICTING_SENSORS: ReadonlyArray<{
    mask: number;
    label: string;
}>;
/**
 * Report which currently-enabled sensors conflict with turning on EXG. Ported
 * from ShimmerDevice.sensorMapConflictCheckandCorrect (ShimmerDevice.java:2497)
 * reading the EXG conflict list — desktop *disables* these when an EXG tile is
 * clicked, so {@link applyExgPreset} clears them from the returned bitmap and
 * the UI can warn "disables: …" ahead of the write.
 */
declare function exgConflictingSensors(enabledSensors: number): Array<{
    mask: number;
    label: string;
}>;
/**
 * Map a device sampling rate (Hz) to the ADS1292R REG1 data-rate setting (0-6).
 * Byte-for-byte port of SensorEXG.setExGRateFromFreq (SensorEXG.java:2784-2806),
 * including the >8 kHz → 500 Hz fallback. NB the thresholds are `<=` here,
 * distinct from the Shimmer3R live-BT oversampling helper
 * `getOversamplingRatioADS1292R` (calibration.ts:89) which uses strict `<` and
 * so differs at the exact boundary rates — that helper is the live-BT streaming
 * path and is deliberately NOT used for the docked InfoMem write, which mirrors
 * the desktop config-generation path (this function).
 */
declare function exgRateSettingFromFreq(freq: number): number;
/** Inputs {@link applyExgPreset} needs from the current device configuration. */
interface ExgApplyInput {
    /** Current EXG1 (chip-1) register bank — 10 bytes. */
    exg1: Uint8Array;
    /** Current EXG2 (chip-2) register bank — 10 bytes. */
    exg2: Uint8Array;
    /** Current enabled-sensors bitmap (Shimmer3 streaming bitmap). */
    enabledSensors: number;
    /**
     * Device sampling rate in Hz. When a sampling-rate edit is also pending in the
     * same batch, pass the EDITED rate so the preset's data-rate bits match the
     * rate the device will actually run at.
     */
    samplingRateHz: number;
    /** HW_ID (3 = Shimmer3, 10 = Shimmer3R). Drives the joined-clock bit. */
    hardwareVersion?: number;
}
/** The banks + bitmap {@link applyExgPreset} produces, ready to fold into a config. */
interface ExgApplyResult {
    /** New EXG1 register bank (10 bytes). */
    exg1: Uint8Array;
    /** New EXG2 register bank (10 bytes). */
    exg2: Uint8Array;
    /** New enabled-sensors bitmap (resolution flags set, conflicts cleared). */
    enabledSensors: number;
}
/** A preset that can be *applied* (written). 'custom' is detect-only; 'off' clears EXG. */
type ApplicableExgPreset = 'ecg' | 'emg' | 'test-signal' | 'respiration' | 'off';
/**
 * Clear the four EXG resolution flags (the bits that enable the ADS1292R chips
 * in the Shimmer3 streaming bitmap) from an enabled-sensors mask, leaving every
 * non-EXG sensor untouched. This is how the Java driver DISABLES EXG live: it
 * never pushes zeroed register banks to the chip — the ADS1292R forces the
 * must-be bits (CONFIG2 bit7=1 etc., ExGConfigBytesDetails.java:507-525) so an
 * all-zero write would fail read-back — it simply drops the EXG bits from the
 * enabled-sensors bitmap and re-writes that (writeEnabledSensors is "always the
 * last command", ShimmerBluetooth.java:2732,2735; readEXGConfigurations /
 * writeEXGConfiguration only run while EXG stays enabled, :2670,4014-4018). The
 * live `applyExgPresetLive('off')` path uses this instead of {@link applyExgPreset}
 * so it never writes — nor read-back-verifies — a zeroed bank. See the docked-vs-
 * live asymmetry note on {@link applyExgPreset} step (2).
 */
declare function clearExgResolutionFlags(enabledSensors: number): number;
/**
 * Apply an EXG preset + resolution to a device configuration, returning the two
 * register banks and the updated enabled-sensors bitmap to write. Pure — does
 * not mutate the input.
 *
 * Ports the Java preset setters (SensorEXG.setDefault*) as a whole:
 *  1. Clears the four EXG resolution flags (clearExgConfig →
 *     setExgChannelBitsPerMode(-1) resets them, :2150-2154).
 *  2. For 'off', returns zeroed banks with no EXG flags set.
 *  3. Clears conflicting sensors from the bitmap
 *     (sensorMapConflictCheckandCorrect, ShimmerDevice.java:2497-2512).
 *  4. Sets the resolution flags for the chips this preset uses — EMG is chip-1
 *     only, every other preset is both chips (setExgChannelBitsPerMode,
 *     :2162-2182). Respiration is NOT forced to 24-bit: it honours the chosen
 *     resolution on both chips, exactly like ECG.
 *  5. Takes the preset register arrays (identical for 16- and 24-bit — the
 *     resolution lives only in the bitmap, see step 4).
 *  6. Rewrites REG1 data-rate on both chips from {@link ExgApplyInput.samplingRateHz}
 *     (setDefaultExgCommon → setExGRateFromFreq, :2003 / :2784).
 *  7. Sets the CHIP1 oscillator-clock-connection bit when the hardware joins the
 *     chip clocks (:2000-2002); otherwise preserves the device's existing bit.
 *  8. Re-applies the mandatory must-be bits.
 *
 * @throws RangeError when either input bank is not exactly 10 bytes.
 */
declare function applyExgPreset(input: ExgApplyInput, preset: ApplicableExgPreset, resolution: ExgResolution): ExgApplyResult;

/**
 * ADS1292R (EXG) LIVE Bluetooth/BLE framing — the GET/SET register commands and
 * the read-back response decode used by the over-the-air (not docked) path.
 *
 * Pure, transport-free port of the Java oracle's EXG BT command flow
 * (com.shimmerresearch.bluetooth.ShimmerBluetooth). Where EX1 (`registers.ts`)
 * and EX2 (`apply.ts`) build the 10-byte-per-chip register banks, this module
 * turns a bank into the exact LiteProtocol instruction bytes and decodes the
 * response — so both `Shimmer3RClient` and `Shimmer3Client` share one framing
 * definition rather than each hand-rolling the byte layout.
 *
 * LiteProtocol opcodes (ShimmerLiteProtocolInstructionSet.java):
 *   SET_EXG_REGS_COMMAND = 97 (0x61) @:479, EXG_REGS_RESPONSE = 98 (0x62) @:1604,
 *   GET_EXG_REGS_COMMAND = 99 (0x63) @:1058.
 *
 * @packageDocumentation
 */
/** SET_EXG_REGS_COMMAND opcode (ShimmerLiteProtocolInstructionSet.java:479, value 97). */
declare const SET_EXG_REGS_COMMAND = 97;
/** EXG_REGS_RESPONSE opcode (ShimmerLiteProtocolInstructionSet.java:1604, value 98). */
declare const EXG_REGS_RESPONSE = 98;
/** GET_EXG_REGS_COMMAND opcode (ShimmerLiteProtocolInstructionSet.java:1058, value 99). */
declare const GET_EXG_REGS_COMMAND = 99;
/**
 * Number of payload bytes AFTER the {@link EXG_REGS_RESPONSE} opcode for a
 * full-bank read. The Java driver declares this response length as 11
 * (ShimmerBluetooth.java:468) and reads exactly 11 bytes (`readBytes(11, …)`,
 * ShimmerBluetooth.java:1642).
 *
 * The 11 bytes are `[count][reg0..reg9]`. Payload byte 0 is the number of
 * registers the firmware is returning, echoed back from the request — the
 * firmware writes the opcode then `exgLength`
 * (`log-and-stream-common/Comms/shimmer_bt_uart.c:2223-2229`, both the Shimmer3
 * and Shimmer3R trees) — which makes the response length-prefixed and, since
 * this SDK only ever asks for a whole 10-register bank, always 11 here. The
 * driver ignores that byte and copies the registers from offset 1
 * (`System.arraycopy(bufferAns, 1, …, 0, 10)`, ShimmerBluetooth.java:1646-1651),
 * because the chip identity is tracked host-side from the preceding GET
 * instruction rather than read back from the response
 * (`mTempChipID = insBytes[1]`, ShimmerBluetooth.java:1087-1089).
 */
declare const EXG_REGS_RESPONSE_PAYLOAD_LENGTH = 11;
/** EXG chip index — the `EXG_CHIP_INDEX` ordinal used in the instruction header. */
declare const EXG_CHIP1 = 0;
/** EXG chip index — chip 2. */
declare const EXG_CHIP2 = 1;
/** Chip index accepted by the framing builders. */
type ExgChipIndex = typeof EXG_CHIP1 | typeof EXG_CHIP2;
/**
 * Build the GET_EXG_REGS instruction for one chip:
 * `{0x63, chipID, 0, 10}` — read 10 registers starting at offset 0.
 * Byte-for-byte port of ShimmerBluetooth.readEXGConfigurations
 * (`writeInstruction(new byte[]{GET_EXG_REGS_COMMAND,(byte)(chipID.ordinal()),0,10})`,
 * ShimmerBluetooth.java:4027).
 */
declare function buildGetExgRegsCommand(chip: ExgChipIndex): Uint8Array;
/**
 * Build the SET_EXG_REGS instruction for one chip:
 * `{0x61, chipID, 0, 10, reg0..reg9}` — a single 14-byte write (the 10 register
 * bytes fit one instruction, never chunked). Byte-for-byte port of
 * ShimmerBluetooth.writeEXGConfiguration
 * (`writeInstruction(new byte[]{SET_EXG_REGS_COMMAND,(byte)(chipID.ordinal()),0,10,reg[0]..reg[9]})`,
 * ShimmerBluetooth.java:4224).
 *
 * @throws RangeError when `bank` is not exactly 10 bytes.
 */
declare function buildSetExgRegsCommand(chip: ExgChipIndex, bank: Uint8Array): Uint8Array;
/**
 * Extract the 10-byte register bank from an EXG_REGS_RESPONSE frame.
 *
 * The frame is `[0x62][count][reg0..reg9]` (opcode + {@link EXG_REGS_RESPONSE_PAYLOAD_LENGTH}
 * payload bytes). Mirrors the Java `System.arraycopy(bufferAns, 1, …, 0, 10)`
 * (ShimmerBluetooth.java:1646): the byte immediately after the opcode is the
 * register count, which the driver ignores, and the 10 register bytes follow.
 *
 * @param frame the complete response including the leading 0x62 opcode.
 * @throws RangeError when the frame is too short or does not start with 0x62.
 */
declare function decodeExgRegsResponse(frame: Uint8Array): Uint8Array;
/**
 * Register index of REG8 (LOFF_STAT) within the 10-byte bank — the read-only
 * lead-off status register (ExGConfigBytesDetails REG8). Its bits reflect the
 * chip's live lead-off state, so the device never echoes back what was written;
 * {@link exgBanksEqualIgnoringStatus} excludes it from read-back comparison.
 */
declare const EXG_REG8_STATUS_INDEX = 7;
/**
 * Compare two 10-byte register banks for read-back verification, ignoring the
 * read-only REG8 (LOFF_STAT) status byte at index {@link EXG_REG8_STATUS_INDEX}.
 * Every other register is host-writable and must echo back exactly.
 */
declare function exgBanksEqualIgnoringStatus(a: Uint8Array, b: Uint8Array): boolean;

/**
 * Building the streaming packet schema from an inquiry response's channel list.
 *
 * Shared by both families: `Shimmer3RClient` (framed BLE) and
 * `buildShimmer3Schema` (unframed classic Bluetooth) put the same channel-ID
 * bytes through the same table, and any difference in how they treat a channel
 * they do not recognise would be a difference in how quietly they corrupt data.
 * So the logic lives here once.
 *
 * The packet itself carries no per-channel length — a data frame is a preamble
 * byte, a timestamp, and then the channels' bytes back to back in the order the
 * inquiry listed them. The channel ID is therefore the *only* thing that says
 * how wide a channel is, and a wrong width does not fail: it shifts every
 * channel after it and decodes plausible-looking rubbish. That is why an
 * unrecognised ID has to be reported rather than assumed away.
 */

/** One decoded channel within a streaming data frame. */
interface StreamSchemaField {
    id: number;
    name: string;
    fmt: string;
    endian: string;
    sizeBytes: number;
    /**
     * True when this SDK has no description for the channel ID and
     * {@link UNKNOWN_CHANNEL_ASSUMED_BYTES} was assumed. The value decoded into
     * this field is meaningless.
     */
    assumed?: boolean;
    /**
     * False when this field's byte offset within the frame sits **after** an
     * assumed width, so the offset — and therefore the value — cannot be relied
     * on. Absent or true means the offset came entirely from described channels.
     *
     * A field that is itself {@link assumed} keeps `offsetTrusted: true`: where it
     * *starts* is known, because everything before it was described. What is not
     * known is where it ends, which is why the fields after it are the ones
     * marked. So the two flags answer different questions — `assumed` says this
     * value is meaningless, `offsetTrusted` says this value may have been read
     * from the wrong place — and a host wanting only trustworthy numbers has to
     * check both.
     */
    offsetTrusted?: boolean;
}
/** Describes how to slice a streaming data frame, built from an inquiry. */
interface StreamSchemaBase {
    timestampFmt: TimestampFmt;
    fields: StreamSchemaField[];
    /** Total bytes per frame, including the preamble byte. */
    frameBytes: number;
    enabledSensors: number;
    dataPreambleByte: number;
    /** Which generation's channel table resolved the IDs. */
    generation?: ShimmerGeneration;
    /**
     * True when {@link generation} was a default rather than something the device
     * was asked for. Harmless unless the channel list contains a
     * generation-sensitive channel, in which case {@link trusted} is false.
     */
    generationAssumed?: boolean;
    /**
     * Channel IDs in the inquiry that this SDK cannot describe. Empty when every
     * channel was recognised.
     */
    unknownChannelIds?: number[];
    /**
     * False when the field offsets, and hence `frameBytes`, may not match the
     * packet the firmware is actually sending. Absent or true means they do.
     *
     * A host must check this before publishing or storing the decoded values: a
     * false here means at least one channel's width was guessed, or the hardware
     * generation was, and the numbers after that point are not measurements. The
     * fixes, in order of preference, are to update this SDK so the channel is
     * described, to call `readDeviceVersion()` before `inquiry()` so the
     * generation is known rather than assumed, or to disable the offending sensor.
     */
    trusted?: boolean;
}
/** What {@link buildStreamSchema} needs beyond the channel list. */
interface BuildStreamSchemaOptions {
    /** Generation whose channel table resolves the IDs. */
    generation: ShimmerGeneration;
    /** True when `generation` is this SDK's default rather than the device's answer. */
    generationAssumed?: boolean;
    /** Frame preamble byte (DATA_PACKET, 0x00 on both families). */
    dataPreambleByte?: number;
    /**
     * Called once per problem found, with a sentence fit for a status log. Wired
     * to the client's `onStatus` so an unrecognised channel is visible to the
     * host rather than only to the schema.
     */
    onProblem?: (message: string) => void;
}
/**
 * Build a stream schema from the channel-ID list reported by an inquiry.
 *
 * Mirrors `ShimmerObject#interpretDataPacketFormat`, with one deliberate
 * departure: where the Java driver falls through to a default width for an
 * unrecognised signal ID, this records the guess. See
 * {@link StreamSchemaBase.trusted}.
 */
declare function buildStreamSchema(channelIds: ArrayLike<number>, timestampFmt: TimestampFmt, opts: BuildStreamSchemaOptions): Required<Pick<StreamSchemaBase, 'generation' | 'unknownChannelIds' | 'trusted'>> & StreamSchemaBase;

/**
 * Decoded STATUS_RESPONSE payload: what the sensor is doing right now.
 *
 * The firmware sends this both on request (GET_STATUS_COMMAND) and unprompted
 * whenever one of these conditions changes, so it is the device's own account of
 * its state rather than anything the host has inferred.
 */
interface Shimmer3DeviceStatus {
    /** Sitting in a dock or base (its charger is connected). */
    docked: boolean;
    /** Sampling sensors — for a stream, an SD recording, or both. */
    sensing: boolean;
    /** The real-world clock has been set since the sensor last lost power. */
    rtcSet: boolean;
    /** Writing samples to the SD card. */
    sdLogging: boolean;
    /** Sending samples over the Bluetooth link. */
    streaming: boolean;
    /** An SD card is inserted. */
    sdPresent: boolean;
    /** The firmware could not open or write its SD file. */
    sdError: boolean;
    /** The red LED is lit (the firmware's own toggle-LED command state). */
    redLedOn: boolean;
    /**
     * USB plugged in — Shimmer3R only. `null` on a Shimmer3, whose firmware omits
     * the second status byte entirely rather than sending a zero, so "unknown" and
     * "unplugged" stay distinguishable.
     */
    usbPluggedIn: boolean | null;
    /** The status bytes as received, for logging. */
    raw: Uint8Array;
}
/**
 * Decode the status bytes of a STATUS_RESPONSE.
 *
 * Takes the payload ONLY — the bytes after `[0x8A][0x71]`. It cannot be lenient
 * about a leading header the way `parseShimmer3DeviceVersionResponse` is,
 * because a status byte of 0x8A is a perfectly ordinary reading (red LED + SD
 * logging + sensing), so there is nothing to test a header against.
 *
 * Bit assignment from `ShimBt_assembleStatusBytes`
 * (log-and-stream-common `Comms/shimmer_bt_uart.c:2920-2932`): bit 7
 * toggleLedRedCmd, 6 sdBadFile, 5 sdInserted, 4 btStreaming, 3 sdLogging,
 * 2 RTC set, 1 sensing, 0 docked.
 *
 * The second byte (usbPluggedIn) exists only under `#if defined(SHIMMER3R)`, so
 * `STATUS_BYTE_COUNT` is 2 on a Shimmer3R and 1 on a Shimmer3
 * (`Comms/shimmer_bt_uart.h:259-263`) — hence the nullable field rather than a
 * plain boolean.
 */
declare function parseShimmer3StatusBytes(bytes: Uint8Array): Shimmer3DeviceStatus;

/**
 * Transport-agnostic capture state machine for a Shimmer factory self-test.
 *
 * The firmware answers `SET_FACTORY_TEST` with a generic ACK first
 * (log-and-stream-common `Comms/shimmer_bt_uart.c:1618` — TASK_BT_RESPOND
 * outranks TASK_FACTORY_TEST) and only then runs the suite
 * (`shimmer_taskList.c:164`), printing the report as **raw ASCII on the same
 * link, with no framing and no CRC** — one write per line via
 * `ShimBt_writeToTxBufAndSend(str, len, SHIMMER_CMD)`
 * (`Test/shimmer_test.c:22-61` builds the envelope). There is no abort command:
 * once the suite starts, the firmware's main loop is blocked until it prints its
 * `TEST END` banner, so a host that gives up must keep swallowing bytes rather
 * than hand them to a framer that would resync through them one at a time.
 *
 * That is what this class is: the byte-level half of the runner, with no
 * knowledge of BLE, serial or the dock UART. A client supplies an
 * {@link AckClassifier} for its own link's ACK/NACK encoding and then simply
 * feeds it every inbound chunk; what comes back is whatever was NOT report
 * traffic, which the client routes as usual.
 *
 * Phases are `ack → text → done`:
 *  - **ack** — the classifier runs on the head of each chunk until it reaches a
 *    verdict. It runs on the head of the SAME chunk that carries text, because
 *    over BLE the ACK and the report's first bytes arrive in ONE notification.
 *  - **text** — printable bytes are kept (TAB/CR/LF and 0x20–0x7E), everything
 *    else is counted as noise and dropped. `TEST START` arms an idle timer that
 *    RESOLVES: an incomplete report is a short report, not an error. The
 *    `TEST END` line resolves synchronously and hands back the bytes after it —
 *    a deferred status push or a late ACK glued to the banner belongs to the
 *    client, not to the report.
 *  - **draining** — entered on timeout or abort, never on success. The result
 *    promise has already rejected; bytes keep being swallowed until the report
 *    ends, the link falls silent, or the hard cap expires.
 *
 * HARDWARE-VERIFY: that the ACK and the report's first bytes really do share one
 * BLE notification, and that a `[0x8A][0x71]` status push can arrive glued to
 * the `TEST END` banner, are the two shapes this class is built around; both are
 * reasoned from the firmware's single-buffer TX path and have not yet been
 * observed on a real Shimmer3/3R.
 */
/** What the capture is doing right now. */
type FactoryTestState = 'idle' | 'running' | 'draining';
/** Why a factory-test run failed. */
type FactoryTestFailureReason = 
/** The firmware refused the command (it is sensing, or SD sync is enabled). */
'nack'
/** Nothing at all came back within {@link FACTORY_TEST_ACK_TIMEOUT_MS}. */
 | 'no-response'
/** No `TEST END` within the overall timeout. */
 | 'timeout'
/** Another factory test is running, or its report is still draining. */
 | 'busy'
/** The link dropped mid-test. */
 | 'disconnected';
/** An error raised by the factory-test runner, tagged with a machine-readable reason. */
declare class FactoryTestError extends Error {
    readonly reason: FactoryTestFailureReason;
    constructor(reason: FactoryTestFailureReason, message: string);
}
/**
 * What an {@link AckClassifier} makes of the head of the buffer it was given.
 *
 * `consumed` is how many bytes the verdict accounts for; the rest of the buffer
 * is report text (after `ack`) or the caller's traffic (after `nack`).
 */
type AckVerdict = 
/** Not enough bytes yet to tell — keep accumulating. */
{
    kind: 'need-more';
}
/** The command was accepted; the report follows. */
 | {
    kind: 'ack';
    consumed: number;
    detail?: string;
}
/** The command was refused. */
 | {
    kind: 'nack';
    consumed: number;
    detail?: string;
}
/** Link noise to step over (a CRC-failed packet, a resync byte). */
 | {
    kind: 'ignore';
    consumed: number;
    detail?: string;
}
/** No ACK is coming — this is already report text. */
 | {
    kind: 'text';
};
/**
 * The refusal message the runner raises when the firmware NACKs the command.
 *
 * `ShimBt_isCmdBlockedWhileSensing` (`Comms/shimmer_bt_uart.c:2985`) refuses
 * `SET_FACTORY_TEST` outright while the device is sensing — streaming, or
 * logging to the SD card from its own button — and the same NACK comes back
 * when SD sync is enabled.
 */
declare const FACTORY_TEST_NACK_MESSAGE: string;
/**
 * How long the runner waits for the firmware's generic ACK — or for the first
 * report byte, since over one link those can arrive together — before deciding
 * the command never landed.
 */
declare const FACTORY_TEST_ACK_TIMEOUT_MS = 2000;
/**
 * Floor for the post-`TEST START` idle timer. A slow section of the suite (the
 * LED walk-through steps every 5 s) must not look like a finished report, so a
 * caller cannot ask for a shorter completion idle than this.
 */
declare const FACTORY_TEST_IDLE_FLOOR_MS = 10000;
/** Default silence, while draining, after which the report is assumed over. */
declare const FACTORY_TEST_DRAIN_IDLE_MS = 10000;
/** Options shared by every client's `runFactoryTest`. */
interface FactoryTestRunOptions {
    /**
     * Overall budget from the write to the `TEST END` line. Defaults to the
     * per-type value in `SHIMMER3_FACTORY_TEST_TYPES`. On expiry the result
     * rejects with reason `timeout` and the capture starts draining.
     */
    timeoutMs?: number;
    /**
     * Silence after `TEST START` that ends the report successfully. Floored at
     * {@link FACTORY_TEST_IDLE_FLOOR_MS}.
     */
    completionIdleMs?: number;
    /** Silence that ends the post-failure drain. Defaults to {@link FACTORY_TEST_DRAIN_IDLE_MS}. */
    drainIdleMs?: number;
    /**
     * Ask the sensor what it is doing before writing the command, so a refusal is
     * reported as "it is sensing" rather than as a bare NACK. Default `true`. A
     * status read that itself fails never aborts the run.
     */
    preflight?: boolean;
    /** Abort the wait (the sensor keeps printing — see the class docblock). */
    signal?: AbortSignal | null;
    /** Called once per fed chunk with that chunk's text and the aggregate so far. */
    onChunk?: (chunk: string, aggregate: string) => void;
    /** Called per completed line, with the trailing CR/LF stripped. */
    onLine?: (line: string) => void;
    /** Called when non-printable bytes were dropped from a chunk. */
    onNoise?: (droppedBytes: number) => void;
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
declare const UART_PACKET_HEADER = 36;
/**
 * Serial-line settings for the dock FTDI UART (SerialPortCommJssc.connect:
 * 8 data bits, 1 stop bit, no parity, no flow control; baud below). These are
 * transport-level hints — the codec/client are byte-pipe-agnostic — surfaced so
 * a Web Serial / native transport can configure the port. Baud from
 * AbstractSerialPortHal.SHIMMER_UART_BAUD_RATES.SHIMMER3_DOCKED = 115200.
 */
declare const UART_DOCK_BAUD_RATE = 115200;
/**
 * UART packet commands (`enum UART_PACKET_CMD`, UartPacketDetails.java:34-54).
 * WRITE/READ are host→device requests; the rest are device→host responses.
 */
declare const UART_PACKET_CMD: Readonly<{
    /** Host→device: set a component property (expects ACK). */
    readonly WRITE: 1;
    /** Device→host: the data payload for a READ (carries component+property). */
    readonly DATA_RESPONSE: 2;
    /** Host→device: get a component property (expects DATA_RESPONSE). */
    readonly READ: 3;
    /** Device→host: unrecognised command. */
    readonly BAD_CMD_RESPONSE: 252;
    /** Device→host: bad argument. */
    readonly BAD_ARG_RESPONSE: 253;
    /** Device→host: CRC mismatch on the received command. */
    readonly BAD_CRC_RESPONSE: 254;
    /** Device→host: command accepted (the response to a successful WRITE). */
    readonly ACK_RESPONSE: 255;
}>;
type UartPacketCmd = (typeof UART_PACKET_CMD)[keyof typeof UART_PACKET_CMD];
/**
 * UART components — the addressable sub-systems (`enum UART_COMPONENT`,
 * UartPacketDetails.java:57-80).
 */
declare const UART_COMPONENT: Readonly<{
    readonly MAIN_PROCESSOR: 1;
    readonly BAT: 2;
    readonly DAUGHTER_CARD: 3;
    readonly PPG: 4;
    readonly GSR: 5;
    readonly LSM303DLHC_ACCEL: 6;
    readonly MPU9X50_ACCEL: 7;
    readonly BEACON: 8;
    readonly RADIO_802154: 9;
    readonly RADIO_BLUETOOTH: 10;
    readonly TEST: 11;
}>;
type UartComponent = (typeof UART_COMPONENT)[keyof typeof UART_COMPONENT];
/** Access permission for a component/property (UartComponentPropertyDetails.PERMISSION). */
type UartPermission = 'READ_ONLY' | 'WRITE_ONLY' | 'READ_WRITE';
/**
 * A component+property address, mirroring the Java
 * `UartComponentPropertyDetails` (component byte, property byte, permission,
 * human name). `mCompPropByteArray` in Java is simply `[component, property]`.
 */
interface UartComponentProperty {
    readonly component: UartComponent;
    readonly property: number;
    readonly permission: UartPermission;
    /** Human-readable name (matches the Java `mPropertyName`). */
    readonly name: string;
}
/**
 * The component/property table (`UART_COMPONENT_AND_PROPERTY`,
 * UartPacketDetails.java:98-160). Only the groups relevant to a docked
 * Shimmer3/3R identify + status + config path are surfaced, plus the factory
 * self-test; the GQ-only 802.15.4 radio entries are omitted (see README).
 */
declare const UART_PROP: Readonly<{
    MAIN_PROCESSOR: Readonly<{
        ENABLE: UartComponentProperty;
        SAMPLE_RATE: UartComponentProperty;
        MAC: UartComponentProperty;
        VER: UartComponentProperty;
        RTC_CFG_TIME: UartComponentProperty;
        CURR_LOCAL_TIME: UartComponentProperty;
        INFOMEM: UartComponentProperty;
        LED0_STATE: UartComponentProperty;
        DEVICE_BOOT: UartComponentProperty;
        ENTER_BOOTLOADER: UartComponentProperty;
    }>;
    /**
     * The factory self-test, addressed as a component whose PROPERTY byte is the
     * test type — there is no payload
     * (log-and-stream-common `Comms/shimmer_dock_usart.c:473-486`, which checks
     * the property against `FACTORY_TEST_COUNT` and answers BAD_CMD above it).
     * The same `factory_test_t` values the Bluetooth command takes
     * (`Test/shimmer_test.h:21-27`).
     *
     * Write-only, and unlike every other entry here the ACK is not the end of it:
     * the firmware then prints its report as raw text on this link. See
     * `WiredShimmerClient.runFactoryTest`.
     */
    TEST: Readonly<{
        MAIN: UartComponentProperty;
        LEDS: UartComponentProperty;
        ICS: UartComponentProperty;
        LED_STATES: UartComponentProperty;
    }>;
    BAT: Readonly<{
        ENABLE: UartComponentProperty;
        VALUE: UartComponentProperty;
        FREQ_DIVIDER: UartComponentProperty;
    }>;
    GSR: Readonly<{
        ENABLE: UartComponentProperty;
        RANGE: UartComponentProperty;
        FREQ_DIVIDER: UartComponentProperty;
    }>;
    PPG: Readonly<{
        ENABLE: UartComponentProperty;
        FREQ_DIVIDER: UartComponentProperty;
    }>;
    DAUGHTER_CARD: Readonly<{
        CARD_ID: UartComponentProperty;
        CARD_MEM: UartComponentProperty;
    }>;
    LSM303DLHC_ACCEL: Readonly<{
        ENABLE: UartComponentProperty;
        DATA_RATE: UartComponentProperty;
        RANGE: UartComponentProperty;
        LP_MODE: UartComponentProperty;
        HR_MODE: UartComponentProperty;
        FREQ_DIVIDER: UartComponentProperty;
        CALIBRATION: UartComponentProperty;
    }>;
    BEACON: Readonly<{
        ENABLE: UartComponentProperty;
        FREQ_DIVIDER: UartComponentProperty;
    }>;
    BLUETOOTH: Readonly<{
        VER: UartComponentProperty;
    }>;
}>;
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
declare const UART_CONFIG_COMMANDS: readonly UartComponentProperty[];
/**
 * Packet framing overhead (UartPacketDetails.java:30-31).
 * DATA = header + cmd + length + component + property (CRC counted in length).
 * OTHER = header + cmd + CRC-LSB + CRC-MSB.
 */
declare const PACKET_OVERHEAD_RESPONSE_DATA = 5;
declare const PACKET_OVERHEAD_RESPONSE_OTHER = 4;
/**
 * Request/response timing (AbstractCommsProtocolWired.java).
 * SERIAL_PORT_TIMEOUT = 500 ms (line 69), polled at 100 ms intervals in
 * `waitForResponse` (line 507). Retry is a dock-layer concern
 * (`AbstractDock.READ_MAC_RETRY_ATTEMPTS = 2`), not the comms layer.
 */
declare const WIRED_DEFAULTS: Readonly<{
    /** Per-request response timeout (ms). Matches Java SERIAL_PORT_TIMEOUT. */
    RESPONSE_TIMEOUT_MS: 500;
    /** MAC-read retry attempts, from AbstractDock.READ_MAC_RETRY_ATTEMPTS. */
    MAC_READ_RETRIES: 2;
}>;
/** Charging-status raw bytes (ShimmerBattStatusDetails.CHARGING_STATUS_BYTE). */
declare const CHARGING_STATUS_BYTE: Readonly<{
    readonly SUSPENDED: 192;
    readonly FULLY_CHARGED: 64;
    readonly PRECONDITIONING: 128;
    readonly BAD_BATTERY: 0;
    readonly UNKNOWN: 255;
}>;
/** Parsed charging state (ShimmerBattStatusDetails.CHARGING_STATUS). */
type ChargingStatus = 'SUSPENDED' | 'FULLY_CHARGED' | 'CHARGING' | 'BAD_BATTERY' | 'UNKNOWN' | 'CHECKING' | 'ERROR';

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
declare function buildUartPacket(command: number, arg: UartComponentProperty | null, payload?: Uint8Array | null): Uint8Array;
/** Build a READ (get) request for a component/property. */
declare function buildReadPacket(arg: UartComponentProperty): Uint8Array;
/** Build a WRITE (set) request for a component/property with a value payload. */
declare function buildWritePacket(arg: UartComponentProperty, value: Uint8Array): Uint8Array;
/**
 * Build the memory-read payload used by INFOMEM / daughter-card reads:
 * `[sizeByte] [addressBytes...]`. The address is 2 bytes little-endian, except
 * for `DAUGHTER_CARD.CARD_ID` where it is a single byte
 * (AbstractCommsProtocolWired#shimmerUartGetMemCommand, :293-309).
 */
declare function buildMemReadPayload(arg: UartComponentProperty, address: number, size: number): Uint8Array;
/**
 * Build the memory-write payload: `[sizeByte] [addressBytes...] [data...]`
 * (AbstractCommsProtocolWired#shimmerUartSetMemCommand, :341-360). `size` is the
 * data length. Address encoding matches {@link buildMemReadPayload}.
 */
declare function buildMemWritePayload(arg: UartComponentProperty, address: number, data: Uint8Array): Uint8Array;
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
declare function msToRtcBytesLE(milliseconds: number): Uint8Array;
/**
 * Whether the docked device supports setting its real-world clock over the dock
 * UART. Faithful port of `ShimmerVerObject.isSupportedRtcConfigViaUart(hwVer, fwId)`
 * (ShimmerVerObject.java:405-418) — desktop `CallableWriteConfig` only issues the
 * RTC write when this is true (BasicDock.java:1564), and SKIPS it otherwise. For
 * the Shimmer3/3R scope: Shimmer3 requires SDLog/LogAndStream/StroKare firmware;
 * Shimmer3R is supported on any firmware. The GQ/Shimmer4 branches are ported
 * verbatim for completeness.
 */
declare function isSupportedRtcConfigViaUart(hwVer: number, fwId: number): boolean;
/** Sentinel: not enough bytes buffered yet to know the message length. */
declare const NEED_MORE$2 = -1;
/** Sentinel: leading byte is not a valid header/command — caller drops 1 byte. */
declare const RESYNC$2 = 0;
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
declare function wiredPacketLength(buf: Uint8Array): number;
/** A parsed inbound UART packet (UartRxPacketObject fields). */
interface UartRxPacket {
    command: number;
    /** Present only for DATA_RESPONSE / READ / WRITE. */
    component: number | null;
    property: number | null;
    /** The data payload (excludes component/property and CRC). Empty for ACK/bad. */
    payload: Uint8Array;
    /** Whether the trailing CRC validated. */
    crcOk: boolean;
    /** Total packet length consumed. */
    length: number;
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
declare function parseUartPacket(buf: Uint8Array): UartRxPacket;
/** True when a parsed command byte is one of the device error responses. */
declare function isBadResponse(command: number): boolean;
/** Map a bad-response command byte to a human-readable reason. */
declare function badResponseReason(command: number): string;
/**
 * Format a MAC-address payload as a 12-char UPPERCASE hex string (no
 * separators), taking the first 6 bytes in the order the device sends them.
 * Mirrors `CommsProtocolWiredShimmerViaDock#readMacId` (:40-53) +
 * `UtilShimmer.bytesToHexString`, whose `hexArray = "0123456789ABCDEF"` renders
 * uppercase — matching this SDK's Verisense MAC/hex rendering.
 */
declare function parseMacId(payload: Uint8Array): string;
/** Parsed HW/FW version (ShimmerVerObject). */
interface WiredVersionInfo {
    hardwareVersion: number;
    firmwareIdentifier: number;
    firmwareVersionMajor: number;
    firmwareVersionMinor: number;
    firmwareVersionInternal: number;
}
/**
 * Parse a VER response payload. Accepts the 7-byte (1-byte HW version) or
 * 8-byte (2-byte HW version) layout, matching
 * `ShimmerVerObject#parseVersionByteArray` (ShimmerVerObject.java:193-217):
 *   7-byte: [hw][fwId LE(2)][major LE(2)][minor][internal]
 *   8-byte: [hw LE(2)][fwId LE(2)][major LE(2)][minor][internal]
 */
declare function parseVersionInfo(payload: Uint8Array): WiredVersionInfo;
/** Parsed battery status (ShimmerBattStatusDetails). */
interface WiredBatteryStatus {
    /** Raw 12-bit ADC value. */
    adcValue: number;
    /** Battery voltage in volts. */
    voltage: number;
    /** Estimated charge %, clamped 0–100 (null when voltage is implausible). */
    percentage: number | null;
    /** Raw charging-status byte. */
    chargingStatusRaw: number;
    /** Decoded charging state. */
    chargingStatus: ChargingStatus;
}
/**
 * Convert a raw 12-bit battery ADC value to volts.
 * `adcValToBattVoltage` (ShimmerBattStatusDetails.java:143-147): the U12 ADC is
 * calibrated to millivolts (Vref=3 V, gain=1, offset=0 — reusing the shared
 * {@link calibrateU12AdcValue}), scaled by the on-board divider factor 1.988,
 * then converted mV→V.
 */
declare function battAdcToVoltage(adcValue: number): number;
/**
 * 4th-order polynomial charge-% estimate from voltage
 * (ShimmerBattStatusDetails#battVoltageToBattPercentage, :175-181), with the
 * pre-clamp to [3.2, 4.167] V and post-clamp to [0, 100]
 * (#calculateBattPercentage, :155-173).
 */
declare function battVoltageToPercentage(voltage: number): number;
/**
 * Parse a BAT.VALUE response payload (needs ≥3 bytes). ADC is a 12-bit
 * little-endian value in bytes [0..1] (LSB first), charging status byte [2]
 * (ShimmerBattStatusDetails.java:74-82).
 */
declare function parseBatteryStatus(payload: Uint8Array): WiredBatteryStatus;
/** Parsed daughter-card (expansion board) ID (ExpansionBoardDetails.java:57-60). */
interface ExpansionBoardInfo {
    boardId: number;
    boardRev: number;
    specialRev: number;
}
/**
 * Parse the first 3 bytes of a daughter-card CARD_ID read as
 * `[boardId, boardRev, specialRev]` (ExpansionBoardDetails.java:58-60). Returns
 * null when the board is absent (an unwritten card memory reads back all 0xFF).
 */
declare function parseExpansionBoard(payload: Uint8Array): ExpansionBoardInfo | null;

/**
 * Classify the head of a dock-UART RX buffer for a factory-test capture.
 *
 * The firmware answers the test command with an ordinary ACK packet and then
 * prints its report as raw text on the same link (`shimmer_dock_usart.c:473-486`
 * for the command, `hal_FactoryTest.c` for the printing) — so this has to tell
 * "a framed packet" from "the report has started", on a stream that may deliver
 * either a byte at a time.
 *
 * A CRC-bad packet is skipped one byte rather than treated as text: the report
 * has not started yet, and a single corrupt byte must not turn the rest of a
 * legitimate packet into report content.
 */
declare function classifyFactoryTestAckPacket(buf: Uint8Array): AckVerdict;

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
declare const ACK: 255;
/** The Shimmer3 negative-acknowledgement byte (LiteProtocol). */
declare const NACK: 254;
/**
 * Well-known SPP (Serial Port Profile) service UUID used to open an RFCOMM
 * socket to a classic Shimmer3. Documented here for the platform transport
 * (e.g. the React Native Android module calls
 * `createRfcommSocketToServiceRecord(SPP_UUID)`); the SDK client itself is
 * transport-agnostic and never touches it.
 */
declare const SHIMMER3_SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb";
/** 0-based offset (within the opcode-prefixed message) of the config word. */
declare const SHIMMER3_INQ_CONFIG_OFFSET = 3;
/** Config word width in bytes (Shimmer3 = 4; Shimmer3R = 7). */
declare const SHIMMER3_INQ_CONFIG_LENGTH = 4;
/** Offset of the numChannels byte within the opcode-prefixed message. */
declare const SHIMMER3_INQ_NUM_CHANNELS_OFFSET: number;
/** Offset of the first channel-ID byte within the opcode-prefixed message. */
declare const SHIMMER3_INQ_CHANNELS_OFFSET: number;
/** The sampling clock frequency (Hz) used for divisor↔rate conversion. */
declare const SHIMMER3_SAMPLING_CLOCK_FREQ = 32768;
/**
 * One decoded channel within a streaming data frame.
 *
 * Structurally identical to the Shimmer3R client's field type — the two
 * families share the channel vocabulary — and kept as its own name because it
 * is exported. See {@link StreamSchemaField} for what `assumed` and
 * `offsetTrusted` mean.
 */
type Shimmer3ChannelField = StreamSchemaField;
/**
 * Describes how to slice a streaming data frame, built from an inquiry.
 *
 * `dataPreambleByte` is 0x00 (DATA_PACKET) and `frameBytes` includes it.
 * `trusted` is the field to check before believing the numbers — see
 * {@link StreamSchemaBase.trusted}.
 */
type Shimmer3StreamSchema = StreamSchemaBase;
/** Typed result of decoding an INQUIRY_RESPONSE. */
interface Shimmer3InquiryResult {
    opcode: number;
    /** Raw 16-bit sampling divisor from the response. */
    adcRaw: number;
    samplingRateHz: number;
    /** 32-bit config word (configByte0). */
    configByte0: number;
    gsrRange: number;
    internalExpPower: number;
    accelRange: number;
    gyroRange: number;
    magRange: number;
    numChannels: number;
    bufferSize: number;
    channelIds: number[];
    schema: Shimmer3StreamSchema;
    /** The exact response bytes decoded (opcode-inclusive slice). */
    bytes: Uint8Array;
}
/**
 * Build a stream schema from the channel-ID list reported by the inquiry.
 *
 * Mirrors ShimmerObject#interpretDataPacketFormat. The generation is fixed at
 * `'shimmer3'`: this file is the classic-Bluetooth Shimmer3 path, so unlike
 * `Shimmer3RClient` — which the same firmware answers on both platforms — there
 * is nothing to determine and nothing to assume. That matters for the BMP
 * channels, which are 2-byte big-endian temperature + 3-byte big-endian
 * pressure here and 3 little-endian bytes each on a Shimmer3R
 * (see `CHANNEL_FORMAT_OVERRIDES`).
 *
 * The only Shimmer3-relevant knob is the timestamp width (u24 for firmware code
 * ≥ 6, else u16 — see ShimmerObject#updateTimestampByteLength).
 *
 * @param onProblem optional sink for the message an unrecognised channel ID
 *   produces; `Shimmer3Client` wires it to `onStatus`. The schema's `trusted`
 *   and `unknownChannelIds` say the same thing to code rather than to a log.
 */
declare function buildShimmer3Schema(channelIds: number[], timestampFmt: TimestampFmt, onProblem?: (message: string) => void): Shimmer3StreamSchema;
/**
 * Decode an INQUIRY_RESPONSE using the Shimmer3 (classic) layout.
 *
 * Accepts the message with or without the leading 0x02 opcode byte (the
 * byte-stream parser always includes it; a caller passing a bare body also
 * works, matching Shimmer3RClient's `base` handling).
 *
 * Ported from ShimmerObject#interpretInqResponse, HW_ID.SHIMMER_3 branch.
 *
 * @param onProblem optional sink for schema problems (an unrecognised channel
 *   ID); see {@link buildShimmer3Schema}.
 */
declare function interpretShimmer3InquiryResponse(u8: Uint8Array, timestampFmt?: TimestampFmt, onProblem?: (message: string) => void): Shimmer3InquiryResult;
/** Parsed DEVICE_VERSION (a.k.a. Shimmer HW version) response. */
interface Shimmer3DeviceVersion {
    hardwareVersion: number;
}
/** Decode a DEVICE_VERSION_RESPONSE (0x25) — 1 payload byte = HW version.
 *  Ported from ShimmerBluetooth (GET_SHIMMER_VERSION_RESPONSE handler). */
declare function parseShimmer3DeviceVersionResponse(u8: Uint8Array): Shimmer3DeviceVersion;
/**
 * Firmware identifier (type) values, from
 * com.shimmerresearch.driverUtilities.ShimmerVerDetails.FW_ID.
 */
declare const FW_ID$1: Readonly<{
    readonly BTSTREAM: 1;
    readonly SDLOG: 2;
    readonly LOGANDSTREAM: 3;
}>;
/** Parsed FW_VERSION_RESPONSE. */
interface Shimmer3FwVersion {
    /** Firmware type — one of {@link FW_ID} (BtStream / SDLog / LogAndStream). */
    firmwareIdentifier: number;
    major: number;
    minor: number;
    internal: number;
}
/**
 * Decode a FW_VERSION_RESPONSE (0x2F) — 6 payload bytes.
 * Ported from ShimmerBluetooth (FW_VERSION_RESPONSE handler):
 *   id  = b1<<8 | b0   (little-endian)
 *   maj = b3<<8 | b2
 *   min = b4
 *   int = b5
 */
declare function parseShimmer3FwVersionResponse(u8: Uint8Array): Shimmer3FwVersion;
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
declare function shimmer3UsesThreeByteTimestamp(v: Shimmer3FwVersion): boolean;
/**
 * Derive the `ShimmerVerObject` "firmware version code" from a parsed FW version
 * plus a hardware id — a port of the ladder at ShimmerVerObject.java:266-311.
 *
 * The code is a single monotonically-increasing capability number derived from
 * the (HW id, FW id, major.minor.internal) tuple; the Java driver gates several
 * protocol features on it rather than on the raw version. Returns `-1` when no
 * rung matches (firmware older than every known threshold), exactly as Java
 * initialises it.
 *
 * Only the rungs reachable by the hardware this SDK talks to are ported.
 * Java also awards code 7 on a bare hardware-id match for Shimmer4-SDK and
 * Arduino, code 6 for the two ShimmerGQ 802.15.4 boards and code 5 for SWEATCH,
 * none of which these clients connect to; and code 7 on `mFirmwareIdentifier ==
 * FW_ID.STROKARE`, a bespoke firmware build this SDK has no FW_ID for. A device
 * running one of those would land one rung lower here than in Java — still
 * above the ExG gate below in every case, so the difference is inert.
 *
 * `compareVersions` semantics (UtilShimmer.java:620-629, via :536-543): same HW
 * id AND same FW id AND `this` version >= the target, comparing major, then
 * minor, then internal with `>=`.
 */
declare function deriveShimmer3FirmwareVersionCode(fw: Shimmer3FwVersion, hardwareVersion: number): number;
/**
 * Whether this firmware carries the live ExG GET/SET register commands — the
 * gate the Java driver applies before every ExG read and write:
 * `(getFirmwareVersionInternal() >= 8 && getFirmwareVersionCode() == 2) ||
 * getFirmwareVersionCode() > 2` (ShimmerBluetooth.java:4015,4026,4205,4223).
 *
 * `firmwareVersionCode == 2` is exactly classic-Shimmer3 BtStream in
 * [0.2.0, 0.3.0), which only gained the ExG commands at internal 8 — hence the
 * extra `internal >= 8` leg. Everything newer (code > 2: all LogAndStream,
 * BtStream >= 0.3.0, SDLog, and every Shimmer3R) has them unconditionally.
 * BtStream 0.1.x (code 1) and anything below every rung (code -1) are rejected.
 */
declare function shimmer3SupportsExg(fw: Shimmer3FwVersion, hardwareVersion: number): boolean;
/**
 * Fixed payload lengths (bytes AFTER the opcode) for the control responses the
 * v1 client consumes. INQUIRY_RESPONSE is variable and handled specially in
 * {@link shimmer3ControlMessageLength}. Extend this table to teach the
 * byte-stream parser about further GET responses.
 *
 * Lengths taken from the `readBytes(n, ...)` calls in ShimmerBluetooth and the
 * LiteProtocol instruction-set response_size annotations.
 */
declare const SHIMMER3_RESPONSE_PAYLOAD_LENGTHS: Readonly<Record<number, number>>;
/** Sentinel: need more bytes before the message length can be determined. */
declare const NEED_MORE$1 = -1;
/** Sentinel: leading byte is not a recognised control opcode — caller resyncs. */
declare const RESYNC$1 = 0;
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
declare function shimmer3ControlMessageLength(buf: Uint8Array): number;

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
/** A parsed/instantiated kinematic calibration set with precomputed matrix M. */
interface KinematicCalibration {
    /** Offset vector B (raw ADC counts), per axis. */
    offset: [number, number, number];
    /** Diagonal sensitivity K (counts per physical unit), per axis. */
    sensitivity: [number, number, number];
    /** Alignment matrix R, row-major 3x3 (length 9). */
    alignment: number[];
    /**
     * Precomputed M = inv(R)·inv(K), row-major 3x3 (length 9). Applied as
     * C = M·(U − B) by {@link calibrateVector3}.
     */
    m: number[];
}
/**
 * Invert a 3x3 matrix (row-major, length 9) via the adjugate/determinant.
 * Ported verbatim from UtilCalibration.matrixInverse3x3 (:133-162). Returns
 * `null` when the matrix is singular (determinant 0).
 */
declare function matrixInverse3x3(m: readonly number[]): number[] | null;
/** Multiply two 3x3 row-major matrices (length 9 each). */
declare function matrixMultiply3x3(x: readonly number[], y: readonly number[]): number[];
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
declare function makeKinematicCalibration(offset: readonly [number, number, number], sensitivity: readonly [number, number, number], alignment: readonly number[]): KinematicCalibration;
/**
 * Apply a calibration set to one raw tri-axial sample:
 *
 *     C = M · (U − B)
 *
 * with M = inv(R)·inv(K) precomputed in {@link KinematicCalibration.m}.
 */
declare function calibrateVector3(raw: readonly [number, number, number], cal: KinematicCalibration): [number, number, number];
/** Options for {@link parseKinematicCalibBlock}. */
interface ParseKinematicOptions {
    /**
     * Sensitivity scale factor (CALIBRATION_SCALE_FACTOR). The stored sensitivity
     * i16s are divided by this. 100 for gyro (CalibDetailsKinematic gyro sets
     * mSensitivityScaleFactor = ONE_HUNDRED), 1 for accel/mag. Alignment is always
     * divided by 100; offset is never scaled.
     */
    sensitivityScale?: number;
}
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
declare function parseKinematicCalibBlock(bytes: Uint8Array, opts?: ParseKinematicOptions): KinematicCalibration | null;
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
declare function generateKinematicCalibBlock(offset: readonly [number, number, number], sensitivity: readonly [number, number, number], alignment: readonly number[], opts?: ParseKinematicOptions): Uint8Array;

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

/** IMU sensor family selected from HW version + new-IMU detection. */
type ImuFamily = 'shimmer3-old' | 'shimmer3-new' | 'shimmer3r';
/** Inertial channel group. */
type InertialGroup = 'lnAccel' | 'wrAccel' | 'gyro' | 'mag' | 'altAccel' | 'altMag';
/** Emitted unit strings — exact Java strings (Configuration.java :162-164). */
declare const INERTIAL_UNITS: Readonly<{
    readonly accel: "m/(s^2)";
    readonly gyro: "deg/s";
    readonly mag: "local_flux";
}>;
/** Default calibration info for one channel group of one family. */
interface GroupDefaults {
    /** Emitted unit string. */
    unit: string;
    /** Sensitivity scale factor for parsing a device block of this group (gyro=100). */
    sensitivityScale: number;
    /** Default calibration keyed by hardware range value. */
    byRange: Readonly<Record<number, KinematicCalibration>>;
    /** Range value to fall back to when the active range is unknown/unmapped. */
    fallbackRange: number;
}
/** Return the default group table for a family, or null if the group is absent. */
declare function getGroupDefaults(family: ImuFamily, group: InertialGroup): GroupDefaults | null;
/**
 * Select the default {@link KinematicCalibration} for a family/group/range.
 * Falls back to the group's `fallbackRange` when the range value has no entry.
 * Returns `null` when the family has no such group.
 */
declare function getDefaultCalibration(family: ImuFamily, group: InertialGroup, range: number): {
    calibration: KinematicCalibration;
    unit: string;
    sensitivityScale: number;
} | null;

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
 * Largest calibration dump a host will accept — `MAX_CALIB_DUMP_MAX`, the
 * ceiling the Java driver passes to every `readMem`/`writeMem` of the dump
 * (LiteProtocol.java:128, ShimmerDevice.java:87).
 *
 * A dump read starts by trusting a length the device sent, so it needs a bound:
 * without one, a corrupt or unprovisioned header can ask a host to page
 * through 65 kB of nothing. The firmware's own calibration RAM is smaller
 * still — `SHIMMER_CALIB_RAM_MAX` is 1024 bytes on both Shimmer3 and
 * Shimmer3R (`Calibration/shimmer_calibration.h:16-20`) — so a real device
 * cannot produce a dump anywhere near this ceiling; it is the Java driver's
 * number, kept so the two implementations reject the same inputs.
 */
declare const MAX_CALIB_DUMP_BYTES = 4096;
/** One record parsed from a calibration dump. */
interface CalibDumpRecord {
    sensorId: number;
    range: number;
    /** Calibration payload length (21 for a kinematic block). */
    calibLen: number;
    /** 8-byte calibration timestamp (LSB first). All-zero = default/seeded. */
    timestampTicks: Uint8Array;
    /** Raw calibration payload bytes. */
    calibBytes: Uint8Array;
    /** True when the timestamp is all-zero (a default/seeded calibration). */
    isDefault: boolean;
}
/** Version identity from a calibration dump header. */
interface CalibDumpVersion {
    hardwareId: number;
    firmwareId: number;
    firmwareMajor: number;
    firmwareMinor: number;
    firmwareInternal: number;
}
/** Parsed calibration dump. */
interface CalibDump {
    packetLength: number;
    version: CalibDumpVersion;
    records: CalibDumpRecord[];
}
/**
 * Parse a 0x9A calibration dump. Tolerant of a trailing partial record (the
 * Java loop `while(remainingBytes.length>12)` stops before an incomplete one).
 * An all-zero buffer yields an empty record list (Java early-returns).
 */
declare function parseCalibDump(bytes: Uint8Array): CalibDump;
/**
 * Serialize a calibration dump (inverse of {@link parseCalibDump}) — used by
 * tests to build round-trippable fixtures.
 */
declare function generateCalibDump(version: CalibDumpVersion, records: CalibDumpRecord[]): Uint8Array;
/**
 * Calibration read-source priority ladder (CalibDetails.CALIB_READ_SOURCE
 * :20-28). A calibration from a higher-priority source overrides one from a
 * lower-priority source; equal priority also overrides (Java uses `>=`).
 */
declare const CALIB_READ_SOURCE: Readonly<{
    readonly UNKNOWN: 0;
    readonly SD_HEADER: 1;
    readonly LEGACY_BT_COMMAND: 2;
    readonly INFOMEM: 3;
    readonly RADIO_DUMP: 4;
    readonly FILE_DUMP: 5;
    readonly USER_MODIFIED: 6;
}>;
type CalibReadSource = (typeof CALIB_READ_SOURCE)[keyof typeof CALIB_READ_SOURCE];
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
declare function shouldOverrideCalibration(current: CalibReadSource, incoming: CalibReadSource, currentTimeMs?: number, incomingTimeMs?: number): boolean;

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

/** Per-group hardware ranges tracked by a streaming client. */
interface StreamingImuRanges {
    lnAccel: number;
    wrAccel: number;
    gyro: number;
    mag: number;
    altAccel: number;
    altMag: number;
}

/**
 * Public types for the Shimmer3-family InfoMem (configuration-memory) codec.
 *
 * The InfoMem is the 384-byte region of the MSP430/STM32 microcontroller
 * memory that holds a Shimmer's full device configuration (sampling rate,
 * enabled sensors, calibration, SD-logging / trial settings, sync node list,
 * …). It is the SAME configuration surface the Consensys desktop app reads and
 * writes when a Shimmer3/3R is docked — see the Java driver's
 * `ShimmerObject#configBytesParse` / `#configBytesGenerate` and
 * `ConfigByteLayoutShimmer3`.
 *
 * This module ports the read/parse and generate/write halves so a docked
 * Shimmer can be configured over the dock UART (configure-while-docked).
 */
/**
 * Firmware / hardware identity needed to resolve the correct InfoMem byte
 * layout (the Java `ConfigByteLayoutShimmer3` constructor mutates offsets and
 * the address base by firmware version and hardware id). This is exactly the
 * information the wired VER response already yields
 * ({@link import('../dock/protocol.js').WiredVersionInfo}).
 */
interface InfoMemContext {
    /** Hardware version code (HW_ID): Shimmer3 = 3, Shimmer3R = 10. */
    hardwareVersion: number;
    /** Firmware identifier (FW_ID): BtStream = 1, SDLog = 2, LogAndStream = 3, StroKare = 15. */
    firmwareId: number;
    /** Firmware version triplet. */
    firmwareVersion: {
        major: number;
        minor: number;
        internal: number;
    };
}
/**
 * IMU sensor rate/range settings held in the InfoMem config-setup bytes.
 *
 * The SAME bits mean different things on Shimmer3 and Shimmer3R because the
 * firmware reuses them for the newer parts — the field names here follow the
 * firmware `gConfigBytes` struct (the neutral, part-independent naming), with
 * each Java accessor named in the JSDoc.
 */
interface InfoMemImuConfig {
    /**
     * Wide-range accel range. ConfigSetupByte0 (idx 6) bits 2-3
     * (`bitShiftLSM303DLHCAccelRange`, FW `wrAccelRange`). LSM303DLHC/LSM303AH on
     * Shimmer3, LIS2DW12 on Shimmer3R; 0-3 = ±2/4/8/16 g on both.
     */
    wrAccelRange: number;
    /**
     * Wide-range accel sampling rate. ConfigSetupByte0 bits 4-7
     * (`bitShiftLSM303DLHCAccelSamplingRate`, FW `wrAccelRate`). Register-code
     * enum whose labels depend on the part AND on {@link wrAccelLpm}.
     */
    wrAccelRate: number;
    /**
     * Wide-range accel low-power mode. ConfigSetupByte0 bit 1
     * (`bitShiftLSM303DLHCAccelLPM`, FW `wrAccelLpModeLsb`).
     *
     * The firmware also has a `wrAccelLpModeMsb` at ConfigSetupByte4 bit 1 with
     * no Java equivalent; it is not modelled and its bit survives round-trip.
     */
    wrAccelLpm: boolean;
    /**
     * Wide-range accel high-resolution mode. ConfigSetupByte0 bit 0
     * (`bitShiftLSM303DLHCAccelHRM`, FW `wrAccelHrMode`).
     */
    wrAccelHrm: boolean;
    /**
     * Gyro range — COMPOSITE. Low 2 bits at ConfigSetupByte2 (idx 8) bits 0-1
     * (`bitShiftMPU9150GyroRange`, FW `gyroRangeLsb`) plus, on Shimmer3R only, a
     * 3rd bit at ConfigSetupByte4 (idx 130) bit 2 (`bitShiftLSM6DSVGyroRangeMSB`,
     * FW `gyroRangeMsb`), combined as `(msb << 2) | lsb`
     * (SensorLSM6DSV.java:1017). 0-3 on Shimmer3 (MPU9x50 ±250…±2000 dps), 0-5
     * on Shimmer3R (LSM6DSV ±125…±4000 dps).
     */
    gyroRange: number;
    /**
     * IMU accel+gyro sampling rate — the whole of ConfigSetupByte1 (idx 7)
     * (`bitShiftMPU9150AccelGyroSamplingRate`, FW `gyroRate`). A raw MPU9x50
     * rate-divider byte 0-255 on Shimmer3; an LSM6DSV ODR enum 0-12 on
     * Shimmer3R.
     */
    imuRate: number;
    /**
     * Mag range. ConfigSetupByte2 bits 5-7 (`bitShiftLSM303DLHCMagRange`).
     * On Shimmer3 this is the LSM303DLHC mag range (FW `magRange`, 1-7); on
     * Shimmer3R the firmware names it `altMagRange` and it carries the LIS3MDL
     * ALT-mag range 0-3 (SensorLIS3MDL.java:806) — the LIS2MDL "mag" has a fixed
     * range and its range write is commented out in SensorLIS2MDL.java:579.
     */
    magRange: number;
    /**
     * Mag sampling rate. ConfigSetupByte2 bits 2-4
     * (`bitShiftLSM303DLHCMagSamplingRate`, FW `magRate`). NOT composite: the
     * declared `bitShiftLIS2MDLMagRateMSB` is commented out in both
     * SensorLIS2MDL.configBytesGenerate (@581) and .configBytesParse (@602), and
     * the firmware struct has no mag-rate MSB bit anywhere.
     */
    magRate: number;
    /**
     * ConfigSetupByte3 (idx 9) bits 6-7 (`bitShiftMPU9150AccelRange`). On
     * Shimmer3 the ALT-accel (MPU9x50) range (FW `altAccelRange`); on Shimmer3R
     * the firmware names the same bits `lnAccelRange` and Java writes the
     * LSM6DSV low-noise accel range there (SensorLSM6DSV.java:979). 0-3 =
     * ±2/4/8/16 g in both cases.
     */
    altAccelRange: number;
    /**
     * Pressure oversampling ratio — COMPOSITE. Low 2 bits at ConfigSetupByte3
     * bits 4-5 (`bitShiftBMPX80PressureResolution`, FW
     * `pressureOversamplingRatioLsb`) plus, on Shimmer3R only, a 3rd bit at
     * ConfigSetupByte4 bit 0 (`bitShiftBMP390PressureResolution`, FW
     * `pressureOversamplingRatioMsb`), combined as `(msb << 2) | lsb`
     * (SensorBMP390.java:490, SensorBMP581.java:371). 0-3 on Shimmer3
     * (BMP180/BMP280), 0-5 (BMP390) / 0-7 (BMP581) on Shimmer3R.
     */
    pressureOversampling: number;
    /**
     * Alt-mag (LIS3MDL) sampling rate. ConfigSetupByte5 (idx 131) bits 0-5
     * (`maskLIS3MDLAltMagSamplingRate` 0x3F, SensorLIS3MDL.java:809; FW
     * `altMagRate`). Raw LIS3MDL CTRL_REG1 code, e.g. 0x01 = 1000 Hz.
     *
     * The byte means this on **both** generations — the field sits outside every
     * `#if` in the shared firmware's config struct (`Configuration/
     * shimmer_config.h`, "Idx 131") — but only a Shimmer3R carries the LIS3MDL
     * it configures, so on a Shimmer3 it is inert rather than absent. It is
     * parsed and written back unconditionally so a read-modify-write preserves
     * whatever the byte held; a host should offer it only where the hardware has
     * the part, which is what the field schema's `appliesTo` expresses.
     */
    altMagRate: number;
    /**
     * Alt-accel (ADXL371) sampling rate. ConfigSetupByte4 bits 6-7
     * (`bitShiftADXL371AltAccelSamplingRate`, SensorADXL371.java:356; FW
     * `altAccelRate`). 0-3 = 320/640/1280/2560 Hz.
     *
     * As with {@link InfoMemImuConfig.altMagRate}, the byte carries this meaning
     * on both generations and is inert on a Shimmer3, which has no ADXL371.
     */
    altAccelRate: number;
}
/** SD-logging / sync timing bytes in InfoMem C. */
interface InfoMemSdConfig {
    /**
     * Sync broadcast interval in seconds. `idxSDBTInterval` (idx 219, FW
     * `btIntervalSecs`), ShimmerObject.java:5313.
     */
    btInterval: number;
    /**
     * Estimated experiment length, big-endian u16 at idx 220 (MSB) / 221 (LSB)
     * — ShimmerObject.java:5316-5317, used for SD sync.
     *
     * UNIT MISMATCH: the Java accessor is `getTrialDurationEstimatedInSecs()`
     * while the firmware struct field is
     * `experimentLengthEstimatedInSecMsb/Lsb`; the Java layout comment says
     * "Maximum and Estimated Length in minutes". The codec stores the raw u16
     * either way — HARDWARE-VERIFY the unit before labelling it in a UI.
     */
    estimatedExpLengthMin: number;
    /**
     * Maximum experiment length (auto-stop), big-endian u16 at idx 222 (MSB) /
     * 223 (LSB) — ShimmerObject.java:5318-5319. Firmware struct field is
     * `experimentLengthMaxInMinutesMsb/Lsb` (minutes) while the Java accessor is
     * `getTrialDurationMaximumInSecs()`; see the note on
     * {@link estimatedExpLengthMin}.
     */
    maxExpLengthMin: number;
}
/**
 * The six 21-byte kinematic calibration blocks, kept VERBATIM (bias/
 * sensitivity big-endian i16, alignment 3×3 i8 ×0.01 — see
 * `parseKinematicCalibBlock` / `generateKinematicCalibBlock` in
 * `devices/calibration/kinematic.ts`). The codec never re-encodes them, so an
 * unedited config round-trips byte-identically; a caller that wants to change
 * a calibration replaces the whole 21-byte array.
 */
interface InfoMemCalibrationBlocks {
    /** Low-noise accel: `idxAnalogAccelCalibration` (34), FW NV_LN_ACCEL_CALIBRATION. */
    lnAccel: Uint8Array;
    /** Gyro: `idxMPU9150GyroCalibration` (55), FW NV_GYRO_CALIBRATION. */
    gyro: Uint8Array;
    /** Mag: `idxLSM303DLHCMagCalibration` (76), FW NV_MAG_CALIBRATION. */
    mag: Uint8Array;
    /** Wide-range accel: `idxLSM303DLHCAccelCalibration` (97), FW NV_WR_ACCEL_CALIBRATION. */
    wrAccel: Uint8Array;
    /**
     * Alt-accel (ADXL371): `idxADXL371AltAccelCalibration` (133), FW
     * NV_ALT_ACCEL_CALIBRATION. Shimmer3R only — on Shimmer3 those bytes are the
     * (unmodelled) MPL accel calibration region, so the field is absent.
     */
    altAccel?: Uint8Array;
    /**
     * Alt-mag (LIS3MDL): `idxLIS3MDLAltMagCalibration` (154), FW
     * NV_ALT_MAG_CALIBRATION. Shimmer3R only — on Shimmer3 those bytes are the
     * (unmodelled) MPL mag calibration region, so the field is absent.
     */
    altMag?: Uint8Array;
}
/**
 * A decoded Shimmer3/3R device configuration. Read via {@link parseInfoMem};
 * write via {@link generateInfoMem}. Field-level semantics mirror the Java
 * `ShimmerObject` config accessors.
 */
interface InfoMemDeviceConfig {
    /** Sampling rate in Hz (`32768 / divider`, divider stored LSB-first at bytes 0-1). */
    samplingRateHz: number;
    /**
     * Enabled-sensors bitmap. Bits 0-23 are sensors bytes 0-2 (always present);
     * bits 24-39 (sensors bytes 3-4) are only populated on MPL firmware
     * (Shimmer3 + SDLog in [0.7.0, 0.8.0)), which no supported device runs, so in
     * practice this is a 24-bit field. Kept as a `number` (max 40 bits < 2^53).
     */
    enabledSensors: number;
    /** Derived-channels bitmap (up to 8 bytes / 64 bits → `bigint`). */
    derivedSensors: bigint;
    /** GSR range (ConfigSetupByte3 bits 1-3): 0-3 fixed, 4 = auto. */
    gsrRange: number;
    /** Internal expansion-board power enable (ConfigSetupByte3 bit 0). */
    expPowerEnabled: boolean;
    /** Device (Shimmer) name, ≤ 12 ASCII chars. */
    deviceName: string;
    /** Trial / experiment name, ≤ 12 ASCII chars. */
    trialName: string;
    /** Configuration timestamp (Unix seconds), stored big-endian at config-time bytes. */
    configTime: number;
    /** SD-logging / multi-Shimmer trial settings. */
    trial: {
        /** Trial id byte. */
        id: number;
        /** Number of Shimmers in the trial. */
        numShimmers: number;
        /** Sync-when-logging (ExperimentConfig0 bit 2). */
        syncWhenLogging: boolean;
        /** This Shimmer is the sync master (ExperimentConfig0 bit 1). */
        masterShimmer: boolean;
        /** Start logging on button press (ExperimentConfig0 bit 5). */
        buttonStart: boolean;
        /** Single-touch start (ExperimentConfig1 bit 7). */
        singleTouch: boolean;
        /** TCXO enabled (ExperimentConfig1 bit 4). */
        tcxo: boolean;
        /** Bluetooth disabled while logging (ExperimentConfig0 bit 3). */
        disableBluetooth: boolean;
    };
    /** Bluetooth baud-rate index byte. */
    btBaudRate: number;
    /**
     * MAC address as read from InfoMem, 12-char UPPERCASE hex. Read-only /
     * informational: on a device write the MAC is forced to all-0xFF so the
     * firmware re-reads it from the Bluetooth transceiver (see
     * {@link generateInfoMem}).
     */
    macAddress: string;
    /** Raw 10-byte ADS1292R chip-1 (EXG1) register bank. */
    exg1: Uint8Array;
    /** Raw 10-byte ADS1292R chip-2 (EXG2) register bank. */
    exg2: Uint8Array;
    /** IMU rate/range settings from the config-setup bytes. */
    imu: InfoMemImuConfig;
    /** SD-logging interval / experiment-length bytes. */
    sd: InfoMemSdConfig;
    /** The six 21-byte kinematic calibration blocks, verbatim. */
    calibration: InfoMemCalibrationBlocks;
    /**
     * Multi-Shimmer sync node MAC list (InfoMem B, `idxNode0` = 256 + i*6, at
     * most 21 entries), as 12-char UPPERCASE hex. Parsing stops at the first
     * all-0xFF slot (ShimmerObject.java:5359-5366); generate pads the unused
     * slots back to 0xFF.
     */
    syncNodes: string[];
    /** The full InfoMem bytes this config was parsed from (defensive copy). */
    raw: Uint8Array;
    /**
     * False when the first 6 InfoMem bytes are all 0xFF — an unconfigured device
     * (the Java driver loads defaults in this case). When false, the decoded
     * fields are neutral defaults and only {@link raw} is meaningful.
     */
    valid: boolean;
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

/** Hardware version codes (`ShimmerVerDetails.HW_ID`). */
declare const HW_ID: Readonly<{
    readonly SHIMMER_3: 3;
    readonly SHIMMER_3R: 10;
}>;
/** Firmware identifier codes (`ShimmerVerDetails.FW_ID`). */
declare const FW_ID: Readonly<{
    readonly BTSTREAM: 1;
    readonly SDLOG: 2;
    readonly LOGANDSTREAM: 3;
    readonly GQ_802154: 9;
    readonly SHIMMER4_SDK_STOCK: 12;
    readonly STROKARE: 15;
}>;
/** `ShimmerVerDetails.ANY_VERSION` — wildcard for a version-field comparison. */
declare const ANY_VERSION = -1;
/** Total InfoMem config length used by Shimmer3/3R (D+C+B pages). */
declare const INFOMEM_SIZE = 384;
/** One InfoMem page (D/C/B) = 128 bytes; also the UART transfer chunk size. */
declare const INFOMEM_PAGE_SIZE = 128;
/** Number of validity sentinel bytes checked at the start of the InfoMem. */
declare const INFOMEM_VALIDITY_BYTES = 6;
/** Legacy MSP430 absolute page addresses (`ConfigByteLayout` defaults). */
declare const INFOMEM_ADDR_LEGACY: Readonly<{
    readonly D: 6144;
    readonly C: 6272;
    readonly B: 6400;
}>;
/** 0-based flat page addresses used by newer firmware / all Shimmer3R. */
declare const INFOMEM_ADDR_FLAT: Readonly<{
    readonly D: 0;
    readonly C: 128;
    readonly B: 256;
}>;
/**
 * True when the context firmware matches `fwId` (or `fwId` is
 * {@link ANY_VERSION}) AND the context version is >= the given threshold.
 * Major/minor use strict `>`, internal uses `>=`, exactly as
 * `UtilShimmer.compareVersions` (UtilShimmer.java:582-629). Passing
 * {@link ANY_VERSION} for the version fields makes the version test always pass
 * (any real version is `> -1`), matching the Java `ANY_VERSION` idiom.
 */
declare function fwCompare(ctx: InfoMemContext, fwId: number, major: number, minor: number, internal: number): boolean;
/**
 * `ShimmerVerObject#isSupportedMpl` (@390): Shimmer3 + SDLog in the half-open
 * window [0.7.0, 0.8.0). No supported/target device runs this, so enabled-
 * sensor bytes 3-4 (bits 24-39) are effectively never populated.
 */
declare function isSupportedMpl(ctx: InfoMemContext): boolean;
/**
 * `ShimmerVerObject#isSupportedEightByteDerivedSensors` (@472): SDLog>=0.13.1,
 * LogAndStream>=0.7.1, GQ_802154>=0.3.2, Shimmer4>=0.0.23, or StroKare (any).
 */
declare function isSupportedEightByteDerivedSensors(ctx: InfoMemContext): boolean;
/**
 * `ShimmerDevice#isSupportedSdLogSync` (@2091): SDLog (any), Shimmer3R+
 * LogAndStream (any), Shimmer3+LogAndStream>=0.16.11, or StroKare. Gates the
 * trial id / number-of-Shimmers, sync bits, sync-node list.
 */
declare function isSupportedSdLogSync(ctx: InfoMemContext): boolean;
/**
 * SDLog / LogAndStream / StroKare firmware — the family that stores the
 * experiment-config bytes (button-start, disable-BT, TCXO) and honours the
 * device-write MAC-0xFF + config-file-creation-flag semantics
 * (ShimmerObject.java:5035,5054,5278,5312,5320).
 */
declare function isSdLoggingFirmware(ctx: InfoMemContext): boolean;
/**
 * A fully-resolved InfoMem byte layout: every offset already reflects the
 * firmware/hardware-conditional mutations from the Java constructor, so callers
 * index directly without re-deriving branches.
 */
interface InfoMemLayout {
    addrD: number;
    addrC: number;
    addrB: number;
    /** True when the flat 0-based address base is used (vs. legacy 0x1800). */
    flatAddressing: boolean;
    idxSamplingRate: number;
    idxBufferSize: number;
    idxSensors0: number;
    idxSensors1: number;
    idxSensors2: number;
    idxConfigSetupByte0: number;
    idxConfigSetupByte1: number;
    idxConfigSetupByte2: number;
    idxConfigSetupByte3: number;
    idxExg1: number;
    idxExg2: number;
    idxBtCommBaudRate: number;
    /** LN-accel (KXRB5/KXTC9 on Shimmer3, LSM6DSV accel on Shimmer3R) 21-byte kinematic calib block. */
    idxAnalogAccelCalibration: number;
    /** Gyro (MPU9x50 on Shimmer3, LSM6DSV on Shimmer3R) 21-byte kinematic calib block. */
    idxMPU9150GyroCalibration: number;
    /** Mag (LSM303DLHC/AH on Shimmer3, LIS2MDL on Shimmer3R) 21-byte kinematic calib block. */
    idxLSM303DLHCMagCalibration: number;
    /** WR-accel (LSM303DLHC/AH on Shimmer3, LIS2DW12 on Shimmer3R) 21-byte kinematic calib block. */
    idxLSM303DLHCAccelCalibration: number;
    /** Alt-accel (ADXL371, Shimmer3R only) 21-byte kinematic calib block. */
    idxADXL371AltAccelCalibration: number;
    /** Alt-mag (LIS3MDL, Shimmer3R only) 21-byte kinematic calib block. */
    idxLIS3MDLAltMagCalibration: number;
    idxDerivedSensors0: number;
    idxDerivedSensors1: number;
    idxDerivedSensors2: number;
    idxDerivedSensors3: number;
    idxDerivedSensors4: number;
    idxDerivedSensors5: number;
    idxDerivedSensors6: number;
    idxDerivedSensors7: number;
    idxSensors3: number;
    idxSensors4: number;
    idxConfigSetupByte4: number;
    idxConfigSetupByte5: number;
    idxConfigSetupByte6: number;
    idxSDShimmerName: number;
    idxSDEXPIDName: number;
    idxSDConfigTime0: number;
    idxSDConfigTime1: number;
    idxSDConfigTime2: number;
    idxSDConfigTime3: number;
    idxSDMyTrialID: number;
    idxSDNumOfShimmers: number;
    idxSDExperimentConfig0: number;
    idxSDExperimentConfig1: number;
    idxSDBTInterval: number;
    idxEstimatedExpLengthMsb: number;
    idxEstimatedExpLengthLsb: number;
    idxMaxExpLengthMsb: number;
    idxMaxExpLengthLsb: number;
    idxMacAddress: number;
    idxSDConfigDelayFlag: number;
    idxBtFactoryReset: number;
    idxNode0: number;
    /** `ConfigByteLayoutShimmer3.lengthGeneralCalibrationBytes` (@238) — always 21. */
    lengthGeneralCalibrationBytes: number;
    supportsMpl: boolean;
    supportsEightByteDerived: boolean;
    supportsSdLogSync: boolean;
    isSdLoggingFirmware: boolean;
    /** True for HW_ID.SHIMMER_3R — gates the Shimmer3R-only composite MSB bits. */
    isShimmer3R: boolean;
}
declare const MAX_SYNC_NODES = 21;
/** One 21-byte kinematic calibration block (`lengthGeneralCalibrationBytes`). */
declare const GENERAL_CALIBRATION_LENGTH = 21;
/**
 * Bit positions within the InfoMem config-setup bytes. Every entry cites its
 * `ConfigByteLayoutShimmer3` declaration; where the Java DECLARATION comment
 * ("//Config ByteN") disagrees with the byte the Java code actually indexes, or
 * with the firmware `gConfigBytes` struct, the firmware wins and the
 * disagreement is called out inline.
 */
declare const BIT_SHIFT: Readonly<{
    /** WR-accel sampling rate. `bitShiftLSM303DLHCAccelSamplingRate` (@124); FW `wrAccelRate` bits 4-7. */
    readonly WR_ACCEL_RATE: 4;
    /** WR-accel range. `bitShiftLSM303DLHCAccelRange` (@126); FW `wrAccelRange` bits 2-3. */
    readonly WR_ACCEL_RANGE: 2;
    /** WR-accel low-power mode (LSB). `bitShiftLSM303DLHCAccelLPM` (@129); FW `wrAccelLpModeLsb` bit 1. */
    readonly WR_ACCEL_LPM: 1;
    /** WR-accel high-resolution mode. `bitShiftLSM303DLHCAccelHRM` (@132); FW `wrAccelHrMode` bit 0. */
    readonly WR_ACCEL_HRM: 0;
    /** IMU (MPU9x50 / LSM6DSV) accel+gyro rate. `bitShiftMPU9150AccelGyroSamplingRate` (@139); FW `gyroRate`. */
    readonly IMU_RATE: 0;
    /** Mag range. `bitShiftLSM303DLHCMagRange` (@143); FW `magRange` (S3) / `altMagRange` (S3R) bits 5-7. */
    readonly MAG_RANGE: 5;
    /** Mag sampling rate. `bitShiftLSM303DLHCMagSamplingRate` (@145); FW `magRate` bits 2-4. */
    readonly MAG_RATE: 2;
    /** Gyro range, LOW 2 bits. `bitShiftMPU9150GyroRange` (@147); FW `gyroRangeLsb` bits 0-1. */
    readonly GYRO_RANGE_LSB: 0;
    /** Alt-accel range (S3 MPU9x50) / LN-accel range (S3R LSM6DSV). `bitShiftMPU9150AccelRange` (@150); FW bits 6-7. */
    readonly ALT_ACCEL_RANGE: 6;
    /** Pressure oversampling, LOW 2 bits. `bitShiftBMPX80PressureResolution` (@152); FW `pressureOversamplingRatioLsb` bits 4-5. */
    readonly PRESSURE_OVERSAMPLING_LSB: 4;
    readonly GSR_RANGE: 1;
    readonly EXP_POWER: 0;
    /**
     * Alt-accel (ADXL371) sampling rate. `bitShiftADXL371AltAccelSamplingRate`
     * (@161) used with `idxConfigSetupByte4` in SensorADXL371.java:356/370;
     * FW `altAccelRate` bits 6-7 of idx 130. Java and firmware AGREE.
     */
    readonly ALT_ACCEL_RATE: 6;
    /**
     * Gyro range MSB (3rd bit). `bitShiftLSM6DSVGyroRangeMSB` (@163) used with
     * `idxConfigSetupByte4` in SensorLSM6DSV.java:980/1015; FW `gyroRangeMsb`
     * bit 2 of idx 130. Java and firmware AGREE.
     */
    readonly GYRO_RANGE_MSB: 2;
    /**
     * Pressure oversampling MSB (3rd bit). Java declares this as
     * `bitShiftBMP390PressureResolution` under a "//Config Byte0" comment
     * (@134-135) — that comment is WRONG: both SensorBMP390.java:499 and
     * SensorBMP581.java:380 index `idxConfigSetupByte4`, and the firmware struct
     * has `pressureOversamplingRatioMsb` as bit 0 of idx 130. FIRMWARE WINS →
     * ConfigSetupByte4 bit 0, not ConfigSetupByte0.
     */
    readonly PRESSURE_OVERSAMPLING_MSB: 0;
    /**
     * WR-accel low-power-mode MSB — FIRMWARE-ONLY (`wrAccelLpModeMsb`, bit 1 of
     * idx 130). The Java driver has no equivalent field and never writes it, so
     * the codec does not model it either; the bit survives round-trip untouched.
     */
    readonly WR_ACCEL_LPM_MSB: 1;
    /**
     * Alt-mag (LIS3MDL) sampling rate. Java declares
     * `bitShiftLIS3MDLAltMagSamplingRate` (@158) under a "//Config Byte4"
     * comment — that comment is WRONG: SensorLIS3MDL.java:809/831 index
     * `idxConfigSetupByte5`, and the firmware struct has `altMagRate` as bits
     * 0-5 of idx 131. FIRMWARE WINS → ConfigSetupByte5 bits 0-5.
     */
    readonly ALT_MAG_RATE: 0;
    /**
     * `bitShiftLIS2MDLMagRateMSB` (@167). NOT MODELLED: every use in
     * SensorLIS2MDL.java (@581 generate, @602 parse) is COMMENTED OUT, and the
     * firmware struct has idx 131 bits 6-7 as `unusedByte131Bit6/7` with no mag
     * MSB anywhere. LIS2MDL mag rate is the plain 3-bit ConfigSetupByte2 field.
     * Kept here only so the constant table is complete against the Java source;
     * writing it would corrupt `altMagRate` bits 3-5.
     */
    readonly LIS2MDL_MAG_RATE_MSB_UNUSED: 3;
    readonly BUTTON_START: 5;
    readonly DISABLE_BLUETOOTH: 3;
    readonly SYNC_WHEN_LOGGING: 2;
    readonly MASTER_SHIMMER: 1;
    readonly SINGLE_TOUCH: 7;
    readonly TCXO: 4;
    readonly SD_CFG_FILE_WRITE_FLAG: 0;
}>;
declare const MASK: Readonly<{
    readonly WR_ACCEL_RATE: 15;
    readonly WR_ACCEL_RANGE: 3;
    readonly WR_ACCEL_LPM: 1;
    readonly WR_ACCEL_HRM: 1;
    readonly IMU_RATE: 255;
    readonly MAG_RANGE: 7;
    readonly MAG_RATE: 7;
    readonly GYRO_RANGE_LSB: 3;
    readonly ALT_ACCEL_RANGE: 3;
    readonly PRESSURE_OVERSAMPLING_LSB: 3;
    readonly GSR_RANGE: 7;
    readonly EXP_POWER: 1;
    readonly ALT_ACCEL_RATE: 3;
    readonly GYRO_RANGE_MSB: 1;
    readonly PRESSURE_OVERSAMPLING_MSB: 1;
    readonly WR_ACCEL_LPM_MSB: 1;
    readonly ALT_MAG_RATE: 63;
    readonly LIS2MDL_MAG_RATE_MSB_UNUSED: 7;
    readonly ONE_BIT: 1;
    readonly DERIVED_BYTE: 255;
    readonly SD_CFG_FILE_WRITE_FLAG: 1;
}>;
/**
 * Resolve the InfoMem layout for a firmware/hardware context, applying the
 * same ordered constructor branches as `ConfigByteLayoutShimmer3` (oldest →
 * newest). Returns a frozen, fully-derived {@link InfoMemLayout}.
 */
declare function resolveInfoMemLayout(ctx: InfoMemContext): InfoMemLayout;
/**
 * The "first 6 bytes all 0xFF ⇒ unconfigured/invalid" check
 * (ConfigByteLayout.checkConfigBytesValid @90). Returns true when the InfoMem
 * holds a real configuration.
 */
declare function checkConfigBytesValid(bytes: Uint8Array): boolean;

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
declare const INFOMEM_SAMPLING_CLOCK_FREQ = 32768;
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
declare function parseInfoMem(bytes: Uint8Array, ctx: InfoMemContext): InfoMemDeviceConfig;

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

interface GenerateInfoMemOptions {
    /**
     * Byte array whose unmodelled regions are preserved. Defaults to the
     * config's own {@link InfoMemDeviceConfig.raw}. Copied (min length) into the
     * output before the modelled fields are layered on top.
     */
    base?: Uint8Array;
    /**
     * When true, apply the device-write finalization (MAC → 0xFF, config-file-
     * creation flag set). Use when the bytes are about to be written to the
     * device over the dock UART. Default false (produces a "for storage"
     * representation that leaves the MAC and config-delay byte as-is).
     */
    forDeviceWrite?: boolean;
}
/** Byte ranges that {@link generateInfoMem} intentionally leaves diverged after a device write. */
interface DeviceWriteDivergentRanges {
    /** MAC address bytes (forced to 0xFF). */
    mac: {
        start: number;
        length: number;
    };
    /** Config-delay / config-file-creation-flag byte. */
    configDelayFlag: {
        start: number;
        length: number;
    };
}
/**
 * Encode a {@link InfoMemDeviceConfig} to a {@link INFOMEM_SIZE}-byte InfoMem
 * array ready to write to the device (128-byte chunks) or store.
 */
declare function generateInfoMem(config: InfoMemDeviceConfig, ctx: InfoMemContext, opts?: GenerateInfoMemOptions): Uint8Array;
/**
 * Byte ranges that {@link generateInfoMem} with `forDeviceWrite` intentionally
 * leaves diverged from the input config — used by the write-back verify to
 * exclude them from the byte comparison.
 */
declare function deviceWriteDivergentRanges(ctx: InfoMemContext): DeviceWriteDivergentRanges;
/**
 * Byte-compare `written` against `readback` over the full InfoMem, ignoring the
 * ranges a device write intentionally leaves diverged — pass
 * {@link deviceWriteDivergentRanges} for the context that was written.
 *
 * This is what makes a write-back verify meaningful. A read-back after a device
 * write is NEVER byte-identical to what was sent: the firmware overwrites the
 * MAC bytes with the address it reads from its own Bluetooth transceiver, and
 * it rewrites the config-delay / config-file-creation flag byte as it
 * regenerates its SD configuration. Comparing the whole image would therefore
 * report a mismatch on every successful write, and comparing nothing would
 * report success on a corrupt one.
 *
 * Shared by the dock and radio config-write paths so both draw the exclusion
 * line in exactly the same place.
 */
declare function compareInfoMemExcluding(written: Uint8Array, readback: Uint8Array, ranges: DeviceWriteDivergentRanges): boolean;

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
 * Map a channel/signal ID from an inquiry response onto the
 * {@link SensorBitmapShimmer3} bit that enables it, or 0 when the ID has no
 * enable bit of its own.
 *
 * ORing these over a channel list reconstructs the enabled-sensor mask the
 * device is actually running, which is what `SET_SENSORS_CMD` would have to
 * send to reproduce it. Ported from
 * `ShimmerObject#interpretDataPacketFormat`, whose Shimmer3 and Shimmer3R
 * branches map the two generations' names for the shared ADC IDs onto the same
 * bits (`ShimmerObject.java:4081-4126`) — e.g. 0x0D is `ExtAdc7` on a Shimmer3
 * and `ExtAdc9` on a Shimmer3R, and both set `SENSOR_EXT_A0`. So this mapping
 * needs no generation of its own, unlike the channel *format* table.
 */
declare function channelIdToSensorBit(id: number): number;

/**
 * Configuration option tables for the Shimmer3 / Shimmer3R families.
 *
 * Every table is the set of values a firmware config field will accept, paired
 * with the label the Shimmer software has shown for it since Consensys. They
 * are ported VERBATIM from the Java driver
 * (`Shimmer-Java-Android-API/ShimmerDriver/.../com/shimmerresearch/`), values
 * and labels alike, with a `file:line` citation above each one.
 *
 * Verbatim matters more here than tidiness. These are the strings a researcher
 * recorded in a trial log next to their data, so a host that renames "Ultra
 * High" to "Very High" makes two records of the same setting disagree — and the
 * config values are register encodings, several of which are neither
 * contiguous nor monotonic. Where the Java list looks wrong (a duplicated
 * label, a gap in the values, a config array longer than its labels) that
 * oddity is reproduced and the comment says why, because the firmware is what
 * the Java list describes.
 *
 * The two families share this file because they share the command set: a table
 * belongs to a CHIP, not to a platform, and which chip answers is what changed
 * between a Shimmer3 (MPU9X50, LSM303DLHC/AH, BMP180/280) and a Shimmer3R
 * (LSM6DSV, LIS2DW12, LIS2MDL/LIS3MDL, ADXL371, BMP390/581).
 */

/**
 * One selectable option: `[configValue, label]`.
 *
 * Same shape as `VerisenseOperationalFieldOption`, so a UI that renders one
 * family's options renders the other's unchanged.
 */
type Shimmer3SensorOption = readonly [number, string];
/** `SensorLSM6DSV.java:61-67` (ListofLSM6DSVAccelRange[ConfigValues]). */
declare const SHIMMER3_LSM6DSV_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLSM6DSV.java:274-275` (ListofGyroRange / ListofLSM6DSVGyroRangeConfigValues). */
declare const SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorLSM6DSV.java:276-278` (ListofLSM6DSVGyroRate / …ConfigValues).
 *
 * One rate drives both halves of the chip — the Java field is
 * `mLSM6DSVGyroAccelRate` — so there is no separate accelerometer table.
 *
 * The Java config-value array runs 0-13 while the label array stops at 12, so
 * its last entry pairs with nothing; only the 13 labelled values are listed
 * here.
 */
declare const SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLIS2DW12.java:117-122, 236` (ListofLIS2DW12AccelRange[ConfigValues]). */
declare const SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * High-performance-mode rates, `SensorLIS2DW12.java:238-239`.
 *
 * Values 1 and 2 both read "12.5Hz": in high-performance mode the chip's
 * lowest two ODR codes land on the same output rate. Reproduced from the Java
 * list rather than de-duplicated, because both codes are writable.
 */
declare const SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * Low-power-mode rates, `SensorLIS2DW12.java:241-242`.
 *
 * Values 6-9 all read "200.0Hz" — low-power mode cannot go faster, so the
 * higher ODR codes saturate. Again as the Java list has it.
 */
declare const SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorADXL371.java:179-180` (ListofADXL371AccelRate[ConfigValues]). */
declare const SHIMMER3_ADXL371_ACCEL_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorADXL371.java:181-182` (ListofADXL371AccelRange[ConfigValues]).
 * A single fixed range — the option exists so the UI can show it, not choose.
 */
declare const SHIMMER3_ADXL371_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLIS2MDL.java:147-148` (ListofLIS2MDLMagRate[ConfigValues]). */
declare const SHIMMER3_LIS2MDL_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLIS2MDL.java:150-151` (ListofLIS2MDLMagRange[ConfigValues]) — fixed range. */
declare const SHIMMER3_LIS2MDL_MAG_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorLIS3MDL.java:177-178` (ListofLIS3MDLAltMagRate[ConfigValues]).
 *
 * These config values are raw CTRL_REG1 codes, not indexes: 0x01, 0x11, 0x21,
 * 0x31, 0x3E, 0x3A, 0x08. They are neither contiguous nor monotonic — 0x3E
 * (80Hz) is numerically above 0x3A (20Hz), and 0x08 (10Hz) is below all of
 * them. Keep them exactly as they are; deriving them from the label order
 * would write the wrong register.
 */
declare const SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLIS3MDL.java:179-180` (ListofLIS3MDLAltMagRange[ConfigValues]). */
declare const SHIMMER3_LIS3MDL_ALT_MAG_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorBMP390.java:124-125` (ListofPressureResolutionBMP390[ConfigValues]). */
declare const SHIMMER3_BMP390_PRESSURE_OVERSAMPLING_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorBMP390.java:126-127` (ListofPressureRateBMP390[ConfigValues]). */
declare const SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorBMP581.java:107-108` (ListofPressureResolutionBMP581[ConfigValues]). */
declare const SHIMMER3_BMP581_PRESSURE_OVERSAMPLING_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorBMP581.java:109-110` — the Java source aliases the BMP390 arrays
 * rather than copying them, so this aliases the table for the same reason: one
 * definition, and the two cannot drift apart.
 */
declare const SHIMMER3_BMP581_PRESSURE_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorBMP180.java:107-108` (ListofPressureResolution[ConfigValues]). */
declare const SHIMMER3_BMP180_PRESSURE_RESOLUTION_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorBMP280.java:112-113` (ListofPressureResolutionBMP280[ConfigValues]).
 * The top label reads "Ultra High" where the BMP180's reads "Very High"; the
 * difference is in the Java source and is kept.
 */
declare const SHIMMER3_BMP280_PRESSURE_RESOLUTION_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorGSR.java:115-127` (ListofGSRRangeResistance / ListofGSRRangeConfigValues).
 * The same four hardware ranges the Shimmer software labels by resistance.
 */
declare const SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorGSR.java:121-127` (ListofGSRRangeConductance / ListofGSRRangeConfigValues).
 * The identical ranges expressed as conductance, which is why the numbers run
 * downwards. Offer whichever unit the study reports in — the config value is
 * the same either way.
 */
declare const SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLSM303.java:83-86` labels, `SensorLSM303DLHC.java:325` values. */
declare const SHIMMER3_LSM303DLHC_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * High-resolution-mode rates, `SensorLSM303DLHC.java:327-328`.
 *
 * The values skip 8: that ODR code is the low-power-only 1620Hz setting, so in
 * high-resolution mode 1344Hz is code 9. A table generated from label indexes
 * would silently select 1620Hz here.
 */
declare const SHIMMER3_LSM303DLHC_ACCEL_RATE_HR_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * Low-power-mode rates, `SensorLSM303DLHC.java:330-331`. 1620Hz and 5376Hz are
 * available in low-power mode only (the Java comment says as much).
 */
declare const SHIMMER3_LSM303DLHC_ACCEL_RATE_LPM_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorLSM303DLHC.java:357-358` (ListofLSM303DLHCMagRange[ConfigValues]).
 * Values start at 1 — the Java comment reads "no '0' option" — so the first
 * label is NOT config value 0.
 */
declare const SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLSM303DLHC.java:354-355` (ListofLSM303DLHCMagRate[ConfigValues]). */
declare const SHIMMER3_LSM303DLHC_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorLSM303.java:83-86` labels, `SensorLSM303AH.java:174` values.
 *
 * The values are `{0, 2, 3, 1}`: this chip's FS bits do not run in range
 * order, so ±4g is code 2, ±8g code 3 and ±16g code 1. Pairing labels with
 * their index — the obvious "simplification" — swaps ±4g with ±16g and
 * miscalibrates every sample by a factor of four.
 */
declare const SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/** High-resolution-mode rates, `SensorLSM303AH.java:176-177`. */
declare const SHIMMER3_LSM303AH_ACCEL_RATE_HR_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * Low-power-mode rates, `SensorLSM303AH.java:179-180`.
 * Values jump from 0 straight to 8-15: low-power ODR codes live in the upper
 * half of the field, so only "Power-down" is shared with the table above.
 */
declare const SHIMMER3_LSM303AH_ACCEL_RATE_LPM_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLSM303AH.java:202-203` (ListofLSM303AHMagRate[ConfigValues]). */
declare const SHIMMER3_LSM303AH_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorLSM303AH.java:205-206` (ListofLSM303AHMagRange[ConfigValues]) — fixed range. */
declare const SHIMMER3_LSM303AH_MAG_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `SensorMPU9X50.java:366-367` (ListofGyroRange / ListofMPU9X50GyroRangeConfigValues).
 * Four ranges, where the Shimmer3R's LSM6DSV offers six — the reason a caller
 * must know which platform it is configuring before validating a gyro range.
 */
declare const SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorMPU9X50.java:369-370` (ListofMPU9X50AccelRange[ConfigValues]). */
declare const SHIMMER3_MPU9X50_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[];
/** `SensorMPU9X50.java:371-372` (ListofMPU9X50MagRate[ConfigValues]). */
declare const SHIMMER3_MPU9X50_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * `Configuration.java:649-650`
 * (Shimmer3.ListofBluetoothBaudRates[ConfigValues]).
 *
 * 115200 is config value 0 and heads the list, so the labels are NOT in
 * ascending rate order. That is the firmware's default-first ordering, kept as
 * it is.
 */
declare const SHIMMER3_BT_BAUD_RATE_OPTIONS: readonly Shimmer3SensorOption[];
/**
 * The sampling rates the Shimmer software offers for a Shimmer3 / Shimmer3R.
 *
 * NOT ported from the Java driver: it has no such list. Java holds a sampling
 * rate as a double and converts it to a divisor on the way out, so the picker
 * values live in the Consensys UI rather than in the driver.
 * (`Configuration.java:2365` is the ShimmerGqBle divider list — a different
 * device, and dividers rather than rates.) These are the conventional Shimmer3
 * rates: the ones that divide 32768 exactly, plus 1Hz and the 10.2 / 51.2 /
 * 102.4 / 204.8 family every Shimmer trial has used.
 *
 * Any positive rate is legal — the firmware takes a divisor, not an index — so
 * treat this as a picker's contents, not a validation set.
 */
declare const SHIMMER3_SAMPLING_RATES_HZ: readonly number[];
/**
 * Convert a sampling rate to the 16-bit divisor SET_SAMPLING_RATE_COMMAND
 * carries: `floor(32768 / rateHz)`, clamped to 1…0xFFFF.
 *
 * Mirrors `Shimmer3RClient.setSamplingRate` (and Java's
 * `ShimmerObject#setSamplingRateShimmer`). The floor is why a requested rate
 * and the applied one differ: run the result back through
 * {@link divisorToSamplingRate} to find out what the device will actually do
 * before telling a user it is sampling at their number.
 */
declare function samplingRateToDivisor(rateHz: number): number;
/** The rate a given divisor actually produces: `32768 / divisor`. */
declare function divisorToSamplingRate(divisor: number): number;
/** A friendly name for one bit of the Shimmer3 sensor-enable bitmap. */
interface Shimmer3SensorLabel {
    /** Display name, following the Shimmer software's own vocabulary. */
    readonly label: string;
    /**
     * True when a Shimmer3R serves this bit.
     *
     * It is true for every bit, and that is the finding rather than an oversight:
     * the enable bitmap is identical across the two platforms. What changed
     * between them is which chip answers a bit — SENSOR_GYRO is an MPU9X50 on a
     * Shimmer3 and an LSM6DSV on a Shimmer3R — which is why the option tables
     * above come in per-chip pairs while this map does not. The flag is kept
     * explicit so a caller gates on a stated fact instead of assuming, and so a
     * future divergence has one place to land.
     */
    readonly shimmer3r: boolean;
}
/**
 * Friendly labels for the sensor-enable bits, keyed by
 * {@link SensorBitmapShimmer3}.
 *
 * The ADC channels are the one place the two platforms disagree on wording, not
 * on availability: a Shimmer3's external channels are named for the MSP430 pins
 * (A7 / A6 / A15) and a Shimmer3R's are numbered 0-2 (`SensorADC.java:425-453`,
 * `Sensing/shimmer_sensing.h:105-122`). The labels below give both, because a
 * host that shows only one set leaves half its users unable to find their
 * channel.
 */
declare const SHIMMER3_SENSOR_LABELS: Readonly<Record<SensorBitmapShimmer3Key, Shimmer3SensorLabel>>;
/** Label for one sensor-enable bit, or null when the bit is not a known sensor. */
declare function shimmer3SensorLabel(mask: number): string | null;

/**
 * Declarative field schema for the Shimmer3/Shimmer3R InfoMem, so a generic UI
 * can render the whole configuration surface without hard-coding byte offsets.
 *
 * Shape mirrors `VerisenseOperationalFieldDefinition`
 * (devices/verisense/operationalConfig.ts:14-25) with ONE structural
 * difference: a Verisense field carries a literal `index`, whereas a Shimmer3
 * byte offset is firmware/hardware-conditional, so a field here carries a
 * `layoutKey` that {@link resolveFieldIndex} resolves against a
 * {@link InfoMemLayout} at runtime.
 *
 * SCOPE DECISION — LogAndStream only. This schema deliberately contains ONLY
 * options that LogAndStream firmware honours:
 *
 *  - No MPL / MPU9150-DMP fields (ConfigSetupByte4/5/6 MPL bits, the three MPL
 *    calibration blocks). They are SDLog-0.7.x-only, are never surfaced in host
 *    UI by product decision, and only need to survive round-trip.
 *  - No SDLog-only or BtStream-only settings (e.g. the showErrorLedsRwc /
 *    showErrorLedsSd bits, whose masks `ConfigByteLayoutShimmer3` zeroes unless
 *    a specific firmware generation is detected, and the `bufferSize` byte that
 *    "FW [is] not using" — ShimmerObject.java:5191).
 *  - Sensors0-4 and the derived-channel bitmaps are not fields here: they are
 *    per-channel enable bitmaps driven by the sensor/channel map, not scalar
 *    settings, and belong to a different UI surface.
 */

/**
 * Which Shimmer3-family part set a device has. Selects which fields are
 * meaningful and which option labels apply.
 *
 * HARDWARE-VERIFY: the old-IMU / new-IMU split for hardware id 3 is derived
 * from the expansion-board revision (`Configuration.Shimmer3.NEW_IMU_EXP_REV`,
 * Configuration.java:1300-1309) and can only be confirmed against physical
 * boards of each revision.
 */
type Shimmer3Generation = 'shimmer3-old-imu' | 'shimmer3-new-imu' | 'shimmer3r';
/**
 * How a field's value is encoded in the InfoMem bytes.
 *
 * `bytes10` and `bytes21` are opaque, fixed-length byte runs handed back and
 * taken verbatim: the 10-byte ADS1292R ExG register banks and the 21-byte
 * kinematic calibration blocks respectively. Neither has a scalar reading a
 * generic editor could offer, so the kind exists to say "this field is that
 * many bytes wide" — a `u8` there would put a 0-255 spinner on the first byte
 * and leave the rest of the run unreachable.
 */
type InfoMemFieldKind = 'bit' | 'u8' | 'u16le' | 'u16be' | 'u32be' | 'ascii12' | 'bytes10' | 'bytes21' | 'mac6[]';
/**
 * `[value, label]`, same tuple shape as the Java `Listof…ConfigValues` pairs.
 *
 * An alias of {@link Shimmer3SensorOption} rather than a second declaration of
 * the same tuple, so a field's `options` can BE a shared table from
 * `devices/shimmer3/sensorOptions.ts` — the same array object, not a copy of it.
 */
type InfoMemFieldOption = Shimmer3SensorOption;
interface InfoMemFieldDefinition {
    /** Stable identifier, unique across the schema. */
    readonly key: string;
    /** Short UI label. */
    readonly label: string;
    /** One-line description including the byte/bit citation. */
    readonly desc: string;
    readonly kind: InfoMemFieldKind;
    /**
     * Name of the {@link InfoMemLayout} index property holding this field's byte
     * offset — resolved by {@link resolveFieldIndex}, never a literal index.
     */
    readonly layoutKey: keyof InfoMemLayout;
    /** Bit position within the byte (`bit` kind only). */
    readonly shift?: number;
    /** Bit width within the byte (`bit` kind only). */
    readonly width?: number;
    /**
     * COMPOSITE fields only: the layout key of the byte holding the field's high
     * bit(s). `layoutKey`/`shift`/`width` describe the LOW part, this pair the
     * high part, and the value is `(msb << width) | lsb` — exactly the Java
     * combination in SensorLSM6DSV.java:1017 and SensorBMP390.java:490.
     *
     * Both composite fields are Shimmer3R-only (`appliesTo: ['shimmer3r']`),
     * because on Shimmer3 the MSB byte (ConfigSetupByte4) holds MPL settings.
     */
    readonly msbLayoutKey?: keyof InfoMemLayout;
    /** COMPOSITE fields only: bit position of the high bit within its byte. */
    readonly msbShift?: number;
    /** COMPOSITE fields only: bit width of the high part (default 1). */
    readonly msbWidth?: number;
    readonly min?: number;
    readonly max?: number;
    readonly options?: readonly InfoMemFieldOption[];
    /** Key into {@link SHIMMER3_INFOMEM_FIELD_GROUPS}. */
    readonly group: string;
    readonly appliesTo: readonly Shimmer3Generation[];
    /** Dotted path into {@link InfoMemDeviceConfig}, e.g. `imu.gyroRange`. */
    readonly configKey: string;
}
interface InfoMemFieldSubgroup {
    readonly id: string;
    readonly title: string;
}
interface InfoMemFieldGroup {
    readonly id: string;
    readonly title: string;
    readonly openByDefault?: boolean;
    readonly subgroups?: readonly InfoMemFieldSubgroup[];
}
declare const SHIMMER3_INFOMEM_FIELD_GROUPS: readonly InfoMemFieldGroup[];
declare const SHIMMER3_INFOMEM_FIELD_SCHEMA: readonly InfoMemFieldDefinition[];
/** Resolve a field's byte offset against a firmware/hardware-resolved layout. */
declare function resolveFieldIndex(field: InfoMemFieldDefinition, layout: InfoMemLayout): number;
/**
 * Read one schema field's raw value straight out of an InfoMem byte array.
 *
 * A COMPOSITE `bit` field (one declaring `msbLayoutKey`) returns the FULL
 * combined value, `(msb << width) | lsb`, matching
 * {@link import('./parse.js').parseInfoMem}.
 */
declare function readInfoMemFieldValue(bytes: Uint8Array, field: InfoMemFieldDefinition, layout: InfoMemLayout): number | string | Uint8Array | string[];
/**
 * Write one schema field's raw value into an InfoMem byte array, in place.
 *
 * `bit` fields are read-modify-write, so the other bits of the byte survive. A
 * COMPOSITE field splits the value across its two declared bytes, so both are
 * updated (and both read-modify-write).
 */
declare function writeInfoMemFieldValue(bytes: Uint8Array, field: InfoMemFieldDefinition, layout: InfoMemLayout, value: number | string | Uint8Array | readonly string[]): void;
/** The schema fields that apply to a given part generation, in schema order. */
declare function infoMemFieldsFor(generation: Shimmer3Generation): InfoMemFieldDefinition[];
/**
 * Expansion-board revision that marks a Shimmer3 base board as "new IMU"
 * (LSM303AH + ICM20948 instead of LSM303DLHC + MPU9150).
 * `Configuration.Shimmer3.NEW_IMU_EXP_REV` (Configuration.java:1300-1309).
 *
 * HARDWARE-VERIFY: this table is transcribed from the Java driver and has not
 * been checked against physical boards of each revision.
 */
declare const NEW_IMU_EXP_REV: Readonly<{
    /** SR31-6-0 and later base board (HW_ID_SR_CODES.SHIMMER3 = 31). */
    readonly IMU: 6;
    /** SR48-3-0 GSR-unified. */
    readonly GSR_UNIFIED: 3;
    /** SR47-3-0 ExG-unified (SR48-2 was skipped). */
    readonly EXG_UNIFIED: 3;
    /** SR49-3-0 bridge-amp-unified. */
    readonly BRIDGE_AMP: 3;
    readonly PROTO3_DELUXE: 3;
    readonly PROTO3_MINI: 3;
    /** SRx-x-171: any expansion board attached to a new-IMU base board. */
    readonly ANY_EXP_BRD_WITH_SPECIAL_REV: 171;
}>;
/**
 * Decide which part generation a device is.
 *
 * - hardware id 10 (`HW_ID.SHIMMER_3R`) → `'shimmer3r'`
 * - hardware id 3 → new-vs-old IMU from the expansion-board revision:
 *   revision >= the board's {@link NEW_IMU_EXP_REV} threshold (or the
 *   `ANY_EXP_BRD_WITH_SPECIAL_REV` sentinel 171) means new IMU
 * - anything else, or no board info → `'shimmer3-old-imu'` (the safe default:
 *   the LSM303DLHC/MPU9150 option tables are the older, narrower ones)
 */
declare function inferShimmer3Generation(ctx: InfoMemContext, expansionBoard?: {
    boardId: number;
    boardRev: number;
}): Shimmer3Generation;

/**
 * Wire protocol for Shimmer3R SD-card file transfer over BLE.
 *
 * Mirrors the firmware implementation in
 * `log-and-stream-common/Comms/shimmer_sd_file_transfer.{c,h}` (FW >= v1.01.011;
 * v1.01.009/.010 speak the protocol but corrupt every block — see
 * Shimmer3RClient.supportsSdTransfer).
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
declare const SD_TRANSFER_OPCODES: {
    readonly LIST_DIR_COMMAND: 204;
    readonly LIST_DIR_RESPONSE: 193;
    readonly FILE_STAT_COMMAND: 194;
    readonly FILE_STAT_RESPONSE: 195;
    readonly FILE_READ_COMMAND: 196;
    readonly FILE_DATA_RESPONSE: 197;
    readonly FILE_STATUS_RESPONSE: 198;
    readonly TRANSFER_ABORT_COMMAND: 199;
    readonly FREE_SPACE_COMMAND: 200;
    readonly FREE_SPACE_RESPONSE: 201;
    readonly DELETE_COMMAND: 202;
    readonly DELETE_RESPONSE: 203;
};
/** Status byte of the one-shot responses. 0x01–0x13 are raw FatFs FRESULTs. */
declare const SD_STATUS: {
    readonly OK: 0;
    readonly SD_UNAVAILABLE: 240;
    readonly BUSY: 241;
    readonly BAD_ARGS: 242;
    /** Host-side only, never on the wire: the connected firmware's version is
     * below the transfer gate (see Shimmer3RClient.supportsSdTransfer). */
    readonly UNSUPPORTED_FW: 255;
};
/** Codes carried in SD_FILE_STATUS_RESPONSE frames. */
declare const SD_XFER: {
    readonly WINDOW_COMPLETE: 0;
    readonly EOF: 1;
    readonly HOST_ABORT: 2;
    readonly SD_LOST: 3;
    readonly FS_ERROR: 4;
    readonly SUPERSEDED: 5;
    readonly DENIED: 6;
    readonly NOT_FOUND: 7;
};
declare const SD_ATTR_DIR = 1;
declare const SD_ATTR_NAME_TRUNCATED = 2;
declare const SD_MAX_PATH_LEN = 96;
declare const SD_BLOCK_PAYLOAD_MIN = 64;
declare const SD_BLOCK_PAYLOAD_MAX = 1024;
declare const SD_BLOCK_PAYLOAD_DEFAULT = 512;
interface SdDirEntry {
    name: string;
    isDir: boolean;
    /** Truncated by the firmware to 64 bytes; such entries cannot be addressed by path. */
    nameTruncated: boolean;
    size: number;
    fdate: number;
    ftime: number;
    /** Decoded FAT timestamp, or null when the card holds no timestamp (e.g. a file
     * that was still open for logging when it was last written). */
    mtime: Date | null;
}
interface SdFileStat {
    size: number;
    isDir: boolean;
    fdate: number;
    ftime: number;
    mtime: Date | null;
}
interface SdCardSpace {
    freeKB: number;
    totalKB: number;
}
interface SdDataFrame {
    kind: 'data';
    sessionId: number;
    seq: number;
    payload: Uint8Array;
    crcOk: boolean;
}
interface SdStatusFrame {
    kind: 'status';
    sessionId: number;
    status: number;
    nextOffset: number;
    crcOk: boolean;
}
interface SdOneShotResponse {
    kind: 'oneshot';
    opcode: number;
    /** Complete response bytes, opcode included. */
    body: Uint8Array;
}
type SdMessage = SdDataFrame | SdStatusFrame | SdOneShotResponse;
/** Error carrying the in-band status byte of a refused/failed SD command. */
declare class SdTransferError extends Error {
    readonly status: number;
    constructor(message: string, status: number);
}
declare function sdStatusToString(status: number): string;
declare function sdXferStatusToString(status: number): string;
/** Shimmer CRC16 over `len` bytes of `data` (defaults to all of it). */
declare function sdCrc16(data: Uint8Array, len?: number): number;
/** Encode and validate a card path (ASCII, 1..96 bytes). */
declare function encodeSdPath(path: string): Uint8Array;
/** Decode a FAT date/time pair; null when unset or invalid. */
declare function fatDateTimeToDate(fdate: number, ftime: number): Date | null;
declare function buildListDirCmd(path: string, startIdx?: number, maxEntries?: number): Uint8Array;
declare function buildStatCmd(path: string): Uint8Array;
declare function buildDeleteCmd(path: string): Uint8Array;
declare function buildFreeSpaceCmd(): Uint8Array;
declare function buildAbortCmd(): Uint8Array;
declare function buildReadCmd(path: string, offset: number, windowLen: number, blockPayloadLen?: number): Uint8Array;
interface SdListDirPage {
    status: number;
    startIdx: number;
    entries: SdDirEntry[];
    hasMore: boolean;
}
declare function parseListDirRsp(buf: Uint8Array): SdListDirPage;
declare function parseStatRsp(buf: Uint8Array): {
    status: number;
    stat: SdFileStat;
};
declare function parseFreeSpaceRsp(buf: Uint8Array): {
    status: number;
    space: SdCardSpace;
};
declare function parseDeleteRsp(buf: Uint8Array): {
    status: number;
};
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
declare function sdMessageSpan(buf: Uint8Array): number;
interface SdExtractResult {
    /** Bytes to drop from the front of the buffer (0 = need more data). */
    consumed: number;
    msg?: SdMessage;
    /** True when a data/status frame was recognised but failed its CRC; the
     * extractor resynchronises one byte at a time in that case. */
    crcError?: boolean;
}
/**
 * Try to extract one SD-transfer message from the front of `buf`.
 * Unknown bytes are skipped one at a time (resync) so interleaved traffic
 * (e.g. unsolicited instream status responses) cannot jam the stream.
 */
declare function tryExtractSdMessage(buf: Uint8Array): SdExtractResult;

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
    /**
     * Inject a transport (byte pipe) instead of the default Web Bluetooth one. Lets
     * non-browser runtimes (React Native, Bluetooth Classic) or tests drive the
     * client. When omitted, `connect()` builds a {@link WebBluetoothTransport} over
     * the configured service/characteristic UUIDs, so browser usage is unchanged.
     */
    transport?: ShimmerTransport;
    /**
     * Emit calibrated (`'cal'`) inertial channel values alongside the raw ones.
     * Default true. Set false to keep the pre-calibration behaviour (raw only).
     */
    emitCalibratedInertial?: boolean;
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
    /**
     * The selected `BluetoothDevice` when connected over the default Web Bluetooth
     * transport; `null` for injected transports (React Native / loopback).
     */
    device: BluetoothDevice | null;
    private _injectedTransport;
    private _transport;
    private _notifyUnsub;
    private _disconnectUnsub;
    private _rxBuf;
    private _temps;
    private schema;
    private forceTimestampFmt;
    private _lastAckRemainder;
    private _expectingAck;
    private _streaming;
    private _lastTs;
    /** True while the active transport is a byte stream with no message framing. */
    private _unframed;
    /** Re-framing accumulator, used only when {@link _unframed}. */
    private _ctrlBuf;
    /**
     * How many bytes a STATUS_RESPONSE payload carries: 2 on a Shimmer3R, 1 on a
     * Shimmer3 (`STATUS_BYTE_COUNT`, log-and-stream-common
     * `Comms/shimmer_bt_uart.h:259-263`). Assumed 2 until
     * {@link readDeviceVersion} says otherwise, and handed to the framer so a
     * byte stream splits the message in the right place.
     */
    private _statusPayloadBytes;
    /**
     * Non-zero while a {@link getStatus} round trip is outstanding, so its answer
     * is not also reported as an unsolicited push. Counted rather than flagged:
     * two callers may be awaiting at once.
     */
    private _statusReadsInFlight;
    /**
     * The in-flight factory-test capture, or null when none is running.
     *
     * Non-null for the whole time the link is unusable — from the write until the
     * report ends, INCLUDING the drain after a cancelled or timed-out run, because
     * the firmware has no abort command and keeps printing regardless. Every
     * command write is refused while it is set; see {@link runFactoryTest}.
     */
    private _factoryTest;
    /**
     * How many status payload bytes a STATUS_RESPONSE must carry before it is
     * worth parsing.
     *
     * Once {@link readDeviceVersion} has answered, {@link _statusPayloadBytes} is
     * a contract — the firmware sends exactly that many — so a shorter message is
     * a truncated one, not a shorter platform. Parsing it anyway would report
     * `usbPluggedIn: null`, which means "this hardware has no such field" and NOT
     * "the byte did not arrive"; the caller cannot tell those apart, so the
     * shorter message must not be surfaced as a status at all.
     *
     * Before the platform is known the 2 is only a guess biased towards this
     * client's namesake, so demanding it would reject — or time out on — the
     * perfectly valid one-byte status a Shimmer3 sends.
     */
    private get _minStatusPayloadBytes();
    enabledSensors: number;
    samplingRateHz: number;
    gsrRangeSetting: number;
    ExpPower: number;
    /**
     * Inertial-sensor hardware ranges, refreshed from each inquiry's config word.
     * Used to select the default calibration for streaming inertial channels.
     */
    imuRanges: StreamingImuRanges;
    /** When false, inertial channels are emitted raw-only (no `'cal'` field). Default true. */
    emitCalibratedInertial: boolean;
    /**
     * Device calibrations fetched via {@link readCalibration}. These override the
     * range-selected defaults (calibration source-priority ladder).
     */
    private _deviceCalibrations;
    /** Minimum valid GSR conductance in µS (below this, connectivity = "Disconnected"). */
    readonly LIMIT_MIN_VALID_USIEMENS = 0.03;
    onInquiry: ((info: ReturnType<Shimmer3RClient['_interpretInquiryResponseShimmer3R']>) => void) | null;
    onExpPowerChanged: ((expPower: number) => void) | null;
    /**
     * Invoked for a STATUS_RESPONSE the host did not ask for. The firmware pushes
     * one whenever docking, SD logging, streaming or the USB rail changes
     * (`ShimBt_instreamStatusRespSend`, log-and-stream-common
     * `Comms/shimmer_bt_uart.c:2445-2469`), so this is how a host learns the user
     * pressed the button or seated the sensor in a dock.
     *
     * The answer to a {@link getStatus} call is NOT delivered here — that would
     * report every state twice.
     *
     * A push whose payload is short of the connected platform's status length is
     * dropped (with a debug log) rather than parsed, so `usbPluggedIn: null` here
     * always means "a Shimmer3, which has no such field" and never "the byte went
     * missing". See {@link readDeviceVersion} for how that length is learnt.
     *
     * **Only fires while idle.** Once streaming, every inbound byte belongs to the
     * data plane and goes to the schema parser, which has no way to tell a status
     * push from sample bytes and will consume it. Do not rely on this callback to
     * notice that a recording stopped mid-stream; poll {@link getStatus} instead.
     */
    onDeviceStatus: ((status: Shimmer3DeviceStatus) => void) | null;
    /**
     * Invoked whenever {@link factoryTestState} changes, synchronously. A host uses
     * it to hold its own "the link is busy" gate through the whole run — including
     * the `draining` phase after a cancel, when the sensor is still printing and no
     * other command will be accepted.
     */
    onFactoryTestStateChange: ((state: FactoryTestState) => void) | null;
    constructor(opts?: Shimmer3RClientOptions);
    /** Best-effort label for `ObjectCluster`s and status messages. */
    private _deviceLabel;
    /** Build the default Web Bluetooth transport over the configured UUIDs. */
    private _makeWebTransport;
    protected _log(...args: unknown[]): void;
    /**
     * Open a connection. In a browser this triggers the Web Bluetooth device
     * picker (unchanged behaviour). Pass a {@link ShimmerTransport} to drive the
     * client over a different pipe (React Native, Bluetooth Classic, tests); it
     * takes precedence over any transport supplied to the constructor.
     */
    connect(transport?: ShimmerTransport): Promise<void>;
    disconnect(): Promise<void>;
    /** Handle an unexpected transport disconnect (the link dropped under us). */
    private _handleTransportDisconnect;
    /**
     * Abandon an in-flight factory-test capture because the link has gone. No
     * drain: draining exists only to keep a still-arriving report out of the
     * framer, and nothing is arriving on a link that is closed.
     */
    private _failFactoryTest;
    /**
     * Transport entry point. A framed transport (BLE) delivers one firmware
     * message per call and goes straight to {@link _handleFramedChunk}; an
     * unframed one (Web Serial over USB or over a classic-Bluetooth COM port)
     * is re-framed first, then funnelled through the very same handler.
     *
     * A running factory test is served FIRST, before either path. Its report is
     * bare ASCII with no opcode, no length and no CRC, so the framer would treat
     * every line as garbage and resync through it one byte at a time — and the
     * temp handlers, which only ever see whole framed messages, would never see it
     * at all. What the capture hands back is what was NOT report traffic (a status
     * push glued after `TEST END`, a late ACK), and that continues down the normal
     * path.
     */
    private _handleNotify;
    private _handleFramedChunk;
    /**
     * Surface a STATUS_RESPONSE nobody asked for on {@link onDeviceStatus}.
     *
     * Called for control-plane messages only, so it never sees stream data — and
     * so a push that lands mid-stream is lost to the schema parser instead, as
     * {@link onDeviceStatus} documents.
     */
    private _maybeEmitDeviceStatus;
    /**
     * Re-frame an unframed transport's read into whole firmware messages, then
     * replay them through {@link _handleFramedChunk} so every command, waiter and
     * SD handler above behaves exactly as it does over BLE.
     *
     * Without this a serial read can split a response down the middle (the waiter
     * resolves with a truncated buffer) or carry two messages at once (the second
     * is swallowed as the first's ACK remainder).
     */
    private _handleUnframedChunk;
    /**
     * Merge a bare ACK with the message that follows it, emulating BLE: the module
     * packs an ACK and the response the firmware wrote straight after it into ONE
     * notification, and the waiters rely on that — `_waitForAck` hands the
     * remainder over synchronously via `_lastAckRemainder`. Emitted as two
     * separate messages, the response would arrive before the caller's `await`
     * continuation had registered its response handler, and be dropped.
     *
     * Two ACKs are never merged: the second would masquerade as the first's
     * response body.
     */
    /**
     * The framer, told how wide this platform's status response is.
     *
     * Only STATUS_RESPONSE's length depends on that — one byte on a Shimmer3, two
     * on a Shimmer3R — and only this client knows which is answering. Both the
     * drain and the coalescing check go through here rather than calling the
     * framer directly, because supplying the option in one place and forgetting
     * it in the other is not a hypothetical: it made a complete Shimmer3 status
     * look perpetually one byte short, so the ACK and its response were never
     * coalesced and the waiter timed out.
     */
    private _controlMessageLength;
    private _coalesceAckWithResponse;
    /** Run the schema parser if one has been built, swallowing parse errors. */
    private _parseStreamIfPossible;
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
    /**
     * Set the wide-range accelerometer (LIS2DW12) range.
     *
     * Also updates {@link imuRanges} so streaming calibration picks the matching
     * sensitivity straight away. An inquiry would refresh it from the config word
     * anyway, but callers are free to set the range after their last inquiry.
     *
     * @param wrAccelRange 0 = ±2 g, 1 = ±4 g, 2 = ±8 g, 3 = ±16 g.
     */
    setWrAccelRange(wrAccelRange: number): Promise<{
        wrAccelRange: number;
        ackRemainder: Uint8Array | null;
    }>;
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
    setGyroRange(gyroRange: number): Promise<{
        gyroRange: number;
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
        schema: StreamSchemaBase;
        bytes: Uint8Array<ArrayBuffer>;
    }>;
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
     *
     * `headerBytes` is how many bytes sit between the opcode and the payload:
     * 1 for the `[len]` of an InfoMem or daughter-card read, 3 for the
     * `[len][offsetLo][offsetHi]` a calibration-dump reply echoes back
     * (`Comms/shimmer_bt_uart.c:2119-2127`). The whole header is recognised — and
     * skipped — on the same condition either way, that its first byte is the
     * length that was asked for, so a response with no header at all still
     * reaches the caller intact.
     */
    private _readLengthPrefixedResponse;
    readInfoMem(address: number, length: number): Promise<Uint8Array>;
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
    setRebootOnDisconnect(enabled: boolean): Promise<void>;
    /**
     * Read from the daughter-card (expansion board) EEPROM memory. `offset` is a
     * HOST offset — firmware maps it past the first (HW details) EEPROM page, so
     * host offsets 0..2031 cover absolute EEPROM bytes 16..2047.
     */
    readDaughterCardMem(offset: number, length: number): Promise<Uint8Array>;
    /**
     * Write to the daughter-card (expansion board) EEPROM memory. `offset` is a
     * HOST offset (see {@link readDaughterCardMem}). Max 128 bytes per write.
     */
    writeDaughterCardMem(offset: number, data: Uint8Array): Promise<void>;
    /**
     * Read the device's MAC address from InfoMem and return it as 12 uppercase hex
     * characters (e.g. "2601140185B8") — byte order as stored, matching the
     * identifier format used by Verisense.
     */
    getMacAddress(): Promise<string>;
    /**
     * Write one chunk of the device's InfoMem (SET_INFOMEM_COMMAND 0x8C, args
     * `[len][offsetLo][offsetHi][data…]`), resolving on the firmware's ACK — the
     * counterpart of {@link readInfoMem}, and the primitive that made configuring
     * a sensor over the radio possible at all: until this existed the client could
     * read the configuration image a page at a time and had no way to put one
     * back.
     *
     * `data` is at most 128 bytes, the firmware's own ceiling for the command
     * (`Comms/shimmer_bt_uart.c:1322-1327`, which also requires
     * `offset + len <= NV_NUM_RWMEM_BYTES`, 512 on this firmware); a longer chunk
     * or an out-of-range offset is NACKed rather than truncated. Most callers want
     * {@link writeInfoMemBytes} or {@link writeInfoMemConfig}, which chunk a whole
     * image for them; this is the byte-level escape hatch.
     *
     * The firmware refuses every SET while it is sensing
     * (`ShimBt_isCmdBlockedWhileSensing`, 0x8C included), so a write during
     * streaming or SD logging comes back as a NACK.
     *
     * HARDWARE-VERIFY: no real Shimmer3R has taken an InfoMem write over this
     * transport yet — the command layout is the Java driver's and the firmware's,
     * but the round trip is unconfirmed.
     */
    writeInfoMem(address: number, data: Uint8Array): Promise<void>;
    /**
     * Read the whole {@link INFOMEM_SIZE}-byte configuration image in 128-byte
     * page reads (D → C → B), reassembled in order.
     *
     * The page addresses sent depend on the firmware and hardware — legacy MSP430
     * absolute 0x1800/0x1880/0x1900 versus flat 0/128/256 — and are resolved by
     * {@link resolveInfoMemLayout} from the device's own version replies, never
     * hard-coded here. A Shimmer3 on old firmware genuinely addresses its InfoMem
     * differently from a Shimmer3R, and this client talks to both, so the version
     * reads that {@link _infoMemCtx} performs are load-bearing rather than
     * defensive.
     */
    readInfoMemBytes(): Promise<Uint8Array>;
    /**
     * Write a whole {@link INFOMEM_SIZE}-byte configuration image, chunked, each
     * chunk resolving on its own ACK.
     *
     * `opts.chunkBytes` defaults to **64 over a framed (BLE) transport and 128
     * over an unframed one**. 128 is the firmware's ceiling and the page size the
     * dock path uses, and it is what a byte stream — classic Bluetooth over
     * RFCOMM, or the dock UART — carries happily. Over BLE the proven size is 64:
     * that is what the brand-record write survives on real hardware, where a
     * 128-byte command has to cross four notifications into a firmware receive
     * buffer that has overflowed on smaller records before (DEV-802). Pass
     * `chunkBytes` to override either default.
     *
     * Note that 64-byte chunks split each page in two, and the firmware does its
     * own bookkeeping on a chunk that starts exactly at a page base: writing
     * offset 0 makes it regenerate the calibration dump from config bytes, and
     * writing offset 128 makes it overwrite the MAC bytes and (on a Shimmer3R)
     * regenerate the dump again (`Comms/shimmer_bt_uart.c:1322-1360`). It also
     * runs `checkAndCorrectConfig` after every chunk, so a page is briefly half
     * old and half new — the same window the page-at-a-time dock write has
     * between pages, not a new one.
     *
     * Refuses while this client believes it is streaming: the firmware NACKs a
     * SET mid-stream, and a NACK partway through would leave a half-written image
     * on the device, which is far worse than not starting.
     */
    writeInfoMemBytes(bytes: Uint8Array, opts?: {
        chunkBytes?: number;
    }): Promise<void>;
    /**
     * Read and decode the device's configuration — {@link readInfoMemBytes}
     * followed by {@link parseInfoMem} against the same resolved layout, so every
     * field arrives named rather than as an offset a caller has to know.
     */
    readInfoMemConfig(): Promise<InfoMemDeviceConfig>;
    /**
     * Encode and write a configuration to the device over the radio — the
     * radio-side counterpart of `WiredShimmerClient.writeInfoMemConfig`, with the
     * same ordering and the same verify semantics, so a host can offer one
     * configuration screen for a docked and a connected sensor.
     *
     * The image is generated with device-write finalization: the MAC is forced to
     * all-0xFF and the config-file-creation flag is set, so the firmware re-reads
     * its MAC from the Bluetooth transceiver and regenerates its SD configuration.
     *
     * When `opts.setRtc` (default `true`, matching both the dock client and
     * desktop Consensys), the real-world clock is written FIRST from the host
     * time and only then the InfoMem — the order desktop
     * `CallableWriteConfig.call()` uses (BasicDock.java:1556-1587). An RTC failure
     * ABORTS the config write rather than being tolerated: the InfoMem write is
     * not attempted, matching the Java rethrow. The clock is written as a plain
     * Unix epoch; {@link setRtcTime} carries the detail.
     *
     * `opts.verify` (default `true`) re-reads the image afterwards and byte-
     * compares it against what was sent, EXCLUDING the ranges a device write
     * legitimately diverges in — the MAC the firmware overwrites and the
     * config-delay/config-file-creation flag byte it rewrites
     * ({@link deviceWriteDivergentRanges}). Returns `{ verified: boolean }`, or
     * `{ verified: null }` when verification was not attempted.
     *
     * Refuses before writing anything if this client believes it is streaming.
     *
     * HARDWARE-VERIFY: that the device accepts the write, applies it, and
     * regenerates its SD configuration can only be confirmed on real hardware.
     */
    writeInfoMemConfig(config: InfoMemDeviceConfig, opts?: {
        verify?: boolean;
        setRtc?: boolean;
    }): Promise<{
        verified: boolean | null;
    }>;
    /**
     * Ask the firmware to regenerate its SD-card configuration file from the
     * current InfoMem (UPD_SDLOG_CFG_COMMAND 0x9C, no arguments, ACK only).
     *
     * A configuration write updates the InfoMem the firmware samples with; the
     * text configuration file on the SD card, which a later offline analysis
     * reads to learn what the recording was configured as, is only rewritten when
     * the firmware is told to. Call this after {@link writeInfoMemConfig} when the
     * sensor will record to its card, so the card and the InfoMem agree.
     *
     * NACKed while sensing, like every other SET.
     */
    updateSdLogConfig(): Promise<void>;
    /**
     * Ask the firmware to apply its in-RAM calibration dump to its configuration
     * bytes and SD header, and to persist it (UPD_CALIB_DUMP_COMMAND 0x9B, no
     * arguments, ACK only).
     *
     * This is what makes a {@link writeCalibDump} take effect. The firmware also
     * applies a dump by itself the moment the bytes it has received add up to the
     * length the dump's own header declared
     * (`ShimCalib_ramWrite`, `Calibration/shimmer_calibration.c:330-370`), so on a
     * complete write this is a re-apply rather than the only trigger — which is
     * exactly why it is worth sending: it is also the way to apply a dump whose
     * declared length the host did not finish delivering.
     *
     * NACKed while sensing.
     */
    updateCalibDump(): Promise<void>;
    /**
     * Build the InfoMem layout context from the device's own version replies.
     *
     * Both reads are cached on the client (and cleared on reconnect), so asking
     * for it costs at most one round trip each per connection — cheap enough that
     * every InfoMem entry point can ask rather than making callers remember to
     * call {@link readDeviceVersion} first, which is the dock client's contract
     * only because a dock caches an identity for a slot.
     */
    private _infoMemCtx;
    /**
     * Chunk size for an InfoMem write: the caller's value when given, else 64 on
     * a framed (BLE) transport and the firmware's full 128 on a byte stream.
     * See {@link writeInfoMemBytes} for why the BLE default is lower.
     */
    private _infoMemChunkBytes;
    /**
     * Refuse a configuration write while this client believes it is streaming.
     *
     * The firmware would NACK it (`ShimBt_isCmdBlockedWhileSensing`), and a NACK
     * arriving partway through a chunked write leaves a half-written image on the
     * device. A named refusal also reads far better than the ACK timeout the same
     * situation used to produce.
     *
     * The guard is **only** as good as `_streaming`, which tracks the streams
     * this client started. The firmware blocks configuration writes for anything
     * it considers sensing, SD logging included, and this client holds no local
     * SD-logging flag — `readStatus()` is the only way to learn about a log
     * started before it connected or by another host. So a write can still be
     * refused by the device after passing this check; that refusal arrives as a
     * NACK and is reported as one. The message says as much rather than implying
     * the check covers both.
     */
    /**
     * Refuse a configuration write the firmware would reject anyway.
     *
     * Covers what this client started, streaming or streaming-plus-SD-logging,
     * since both set the same flag. It cannot cover a recording the client did
     * not start — one begun with the sensor's own button, or by a scheduled
     * trial — because no local flag is set for those; there the device NACKs the
     * write, which surfaces as a failure rather than as this refusal.
     * {@link getStatus} reports the sensor's actual sensing and SD-logging state
     * for a caller that wants to know before trying.
     */
    private _assertNotSensingForConfigWrite;
    /** Paged InfoMem read (D → C → B) against an already-resolved context. */
    private _readInfoMemBytesImpl;
    /**
     * Chunked InfoMem write against an already-resolved context.
     *
     * Addresses advance flat from the D-page base rather than being taken per
     * page, which is correct for both address bases because the three pages are
     * contiguous in each (0/128/256, and 0x1800/0x1880/0x1900). With the default
     * 128-byte chunk this reproduces the dock client's page-at-a-time write
     * exactly.
     */
    private _writeInfoMemBytesImpl;
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
    getRtcTime(): Promise<{
        ticks: bigint;
        unixMs: number;
    }>;
    /**
     * Set the device's real-world clock (SET_RWC_COMMAND) to the given Unix
     * millisecond time, encoded as 64-bit little-endian 32768 Hz ticks via the
     * same {@link msToRtcBytesLE} helper as the dock path (truncating, matching
     * the Java driver's `(long)(ms * 32.768)`). Call with `Date.now()` to sync
     * the device clock to the host before a drift run.
     * The value is a plain Unix epoch: desktop Consensys and the Java dock
     * driver both write `System.currentTimeMillis() * 32.768`, and hardware set
     * by either reads back as UTC. (The Verisense console's local-civil
     * convention is that product's, not this one's — do not carry it across.)
     * For drift measurement only the rate matters, not the epoch.
     */
    setRtcTime(unixMs: number): Promise<void>;
    /**
     * Read both ExG chips' 10-byte register banks over the radio
     * (GET_EXG_REGS ×2 → EXG_REGS_RESPONSE decode). Ported from
     * ShimmerBluetooth.readEXGConfigurations, which issues one GET for CHIP1 then
     * one for CHIP2 (ShimmerBluetooth.java:4014-4018).
     *
     * @throws Error when not connected, or while streaming — the read-back needs
     *   the control plane, which the data plane owns for the duration of a stream.
     */
    readExgConfig(timeoutMs?: number): Promise<{
        exg1: Uint8Array;
        exg2: Uint8Array;
    }>;
    /**
     * Read one chip's bank. EXG_REGS_RESPONSE is `[0x62][count][reg0..reg9]` — the
     * byte after the opcode is the register COUNT the firmware is returning, which
     * it echoes from the request (`*(resPacket + packet_length++) = exgLength`,
     * `log-and-stream-common/Comms/shimmer_bt_uart.c:2227-2229`). That is the same
     * length-prefixed shape as an InfoMem or daughter-card read, so this reuses
     * {@link _readLengthPrefixedResponse} and inherits its ACK-piggyback handling,
     * notification reassembly, and tolerance of firmware that omits the prefix.
     */
    private _readExgChip;
    /**
     * Write both ExG chips' 10-byte register banks over the radio
     * (SET_EXG_REGS ×2), then read them back and verify.
     *
     * Ports ShimmerBluetooth.writeEXGConfiguration (:4222-4226) — one 14-byte
     * instruction per chip — with the Shimmer3R-specific oversampling-ratio
     * injection into REG1 (see {@link _injectOversamplingRatio}).
     *
     * WRITE-SAFETY DEVIATION FROM JAVA: the Java driver fires SET_EXG_REGS and does
     * not verify, relying on a timeout→disconnect failsafe if the write silently
     * fails (ShimmerBluetooth.java:4212-4216; the register array is cached
     * driver-side on the bare ACK, :2132). The safer flow is ported instead:
     * SET → await ACK → GET read-back → compare, ignoring only the read-only REG8
     * status byte → throw on mismatch. A bad or no-op write therefore surfaces here
     * rather than as a puzzling disconnect later.
     *
     * @throws Error when not connected, while streaming, or on a read-back mismatch.
     * @throws RangeError when either bank is not exactly 10 bytes.
     */
    writeExgConfig(exg1: Uint8Array, exg2: Uint8Array): Promise<void>;
    /**
     * Shimmer3R-only: overwrite REG1's (bank byte 0) low 3 bits with the ADS1292R
     * oversampling ratio for the current sampling rate. This reproduces exactly
     * what the previous `_writeExgPages` did — `exg[4] = ((exg[4] >> 3) << 3) |
     * ratio`, where byte 4 of the old 14-byte instruction was register byte 0 — and
     * keeps using {@link getOversamplingRatioADS1292R} rather than the codec's
     * `exgRateSettingFromFreq`. The two disagree on purpose: this one uses strict
     * `<` thresholds (calibration.ts:89, the live-BT path) where the docked
     * InfoMem/config-generation path uses `<=` (SensorEXG.setExGRateFromFreq), so
     * they differ at exactly the boundary rates. Classic Shimmer3 does neither —
     * ShimmerBluetooth.writeEXGConfiguration writes reg[0] verbatim (:4224).
     */
    private _injectOversamplingRatio;
    /**
     * Apply an ExG preset live: derive the register banks and the enabled-sensors
     * bitmap from the client's current inquiry state (sampling rate, enabled
     * sensors) via the codec's `applyExgPreset`, write the registers, then update
     * the bitmap.
     *
     * ORDER: ExG registers first, enabled sensors LAST. The desktop write flow
     * marks `writeEnabledSensors(...)` "this should always be the last command"
     * (ShimmerBluetooth.java:2732,2735) and runs `writeEXGConfiguration()` earlier
     * in the same flow (:2670). {@link setSensors} re-inquires, so the streaming
     * schema and `enabledSensors` end up reflecting the new preset.
     */
    applyExgPresetLive(preset: ApplicableExgPreset, resolution: ExgResolution): Promise<void>;
    /**
     * Enable EMG (ADS1292R) in 16-bit mode.
     *
     * Thin wrapper over {@link applyExgPresetLive} so the preset bytes have exactly
     * one source (`EXG_PRESET_ARRAYS` in `../exg/presets.ts`). NOTE that, following
     * the Java driver, the EMG preset powers chip 2 down and so enables the chip-1
     * resolution flag ONLY (SensorEXG.setExgChannelBitsPerMode, :2162-2182); the
     * hardcoded version of this helper enabled both chips' 16-bit flags and
     * streamed two channels of powered-down noise.
     */
    enableEMG16Bit(): Promise<void>;
    /**
     * Enable the ExG test signal in 16-bit mode (useful for verifying ExG hardware).
     * Thin wrapper over {@link applyExgPresetLive} — see {@link enableEMG16Bit}.
     */
    enableEXGTestSignal16Bit(): Promise<void>;
    /**
     * Enable ECG in 16-bit mode on EXG1 & EXG2.
     * Thin wrapper over {@link applyExgPresetLive} — see {@link enableEMG16Bit}.
     */
    enableECG16Bit(): Promise<void>;
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
    readCalibration(timeoutMs?: number): Promise<InertialGroup[]>;
    private _readOneCalibration;
    /**
     * Read the device's whole calibration dump (GET_CALIB_DUMP_COMMAND 0x9A →
     * `[0x99][len][offsetLo][offsetHi][data…]`), paged, and return both the raw
     * bytes and the parsed {@link CalibDump}.
     *
     * The dump is the device's own record of every per-sensor calibration it
     * holds — sensor id, range, when it was calibrated, and the 21-byte block
     * itself — which is more than {@link readCalibration} can learn from the
     * per-sensor GET commands: those return a block with no provenance, so a host
     * cannot tell a factory calibration from a default the firmware seeded.
     *
     * The dump's own length is the first thing read: the first two payload bytes
     * at offset 0 are a little-endian u16 and the total size is that value **+ 2**
     * (the length field is not counted in it), so this reads 128 bytes, takes the
     * total from the header, and pages the remainder. A length of 0 or one beyond
     * {@link MAX_CALIB_DUMP_BYTES} is rejected rather than paged after — an
     * unprovisioned or corrupt header would otherwise ask the host to walk 64 kB
     * of nothing.
     *
     * HARDWARE-VERIFY: unexercised against a real Shimmer3R. The chunked read
     * sequence is ported from the Java driver's `readMem(GET_CALIB_DUMP_COMMAND…)`
     * (ShimmerBluetooth.java:4450-4453) and matches the firmware handler, but the
     * round trip is unconfirmed — which is why {@link readCalibration} still
     * prefers the per-sensor commands for streaming calibration.
     */
    readCalibDump(): Promise<{
        bytes: Uint8Array;
        dump: CalibDump;
    }>;
    /**
     * Write a calibration dump (SET_CALIB_DUMP_COMMAND 0x98, args
     * `[len][offsetLo][offsetHi][data…]`), chunked from offset 0, each chunk
     * resolving on its ACK, then — unless `opts.update` is `false` — apply it with
     * {@link updateCalibDump}.
     *
     * Writing must start at offset 0 and run forward: the firmware takes the
     * total length from the header bytes of the FIRST chunk and counts the
     * remainder in ("starting with offset > 2 is not accepted",
     * `Calibration/shimmer_calibration.c:343-346`), so an out-of-order write is
     * silently discarded — and discarded without a NACK, since the handler
     * ignores `ShimCalib_ramWrite`'s failure return. Chunk size follows the same
     * rule as {@link writeInfoMemBytes}: 64 over BLE, 128 over a byte stream.
     *
     * A dump written here is NOT the last word on the device's calibration: the
     * firmware regenerates its dump FROM the configuration bytes whenever InfoMem
     * page D (or, on a Shimmer3R, page C) is written
     * (`Comms/shimmer_bt_uart.c:1345-1360`), so a later
     * {@link writeInfoMemConfig} supersedes it. Write the dump after the
     * configuration, not before.
     *
     * Refuses while streaming; the firmware NACKs a SET while sensing.
     *
     * HARDWARE-VERIFY: unexercised against real hardware.
     */
    writeCalibDump(bytes: Uint8Array, opts?: {
        update?: boolean;
        chunkBytes?: number;
    }): Promise<void>;
    /**
     * One GET_CALIB_DUMP round trip. The reply carries a 3-byte
     * `[len][offsetLo][offsetHi]` header before its payload — the firmware echoes
     * the request back — so the shared length-prefixed reader is told to skip
     * three rather than one.
     */
    private _readCalibDumpChunk;
    startStreaming(): Promise<void>;
    /**
     * Stop streaming (STOP_STREAMING_COMMAND 0x20), best-effort: the command goes
     * out and the state is cleared without waiting for the ACK the firmware sends
     * back.
     *
     * Not waiting is deliberate. Stream packets keep arriving for hundreds of ms
     * after the stop, and the framed path routes a notification to its ACK branch
     * on the first byte alone — so with an ACK outstanding a residual frame that
     * happened to begin 0xFF would be taken for the ACK and its tail forwarded to
     * the control plane, which is how a stray 0xFE fabricates a NACK and a stray
     * 0x02 frames a bogus inquiry. A notification is not frame-aligned, which is
     * why the stream parser resyncs on a double preamble, so that first byte can
     * be anything. `Shimmer3Client.stopStreaming` answers the same problem the
     * long way, draining to quiescence before it re-enables the control plane;
     * over BLE, where a notification is already one whole message, simply not
     * waiting is enough — and it costs nothing against firmware that does not
     * ACK a stop mid-stream at all.
     *
     * The price is that the ACK is still in flight when the next command goes
     * out, and `_expectingAck` counts rather than queues, so it is spent on that
     * command. {@link withoutLeadingAck} is what keeps that from costing the
     * command its own reply — read it before making this wait for the ACK after
     * all.
     */
    stopStreaming(): Promise<void>;
    /** Start streaming AND SD card logging simultaneously. */
    startStreamingAndLogging(): Promise<void>;
    /**
     * Stop streaming AND SD card logging (STOP_SDBT_COMMAND 0x97), best-effort
     * and without waiting for its ACK, for the reasons {@link stopStreaming}
     * gives.
     */
    stopStreamingAndLogging(): Promise<void>;
    private _interpretInquiryResponseShimmer3R;
    /**
     * Which generation's channel table this client uses to decode a packet.
     *
     * Read from the cached DEVICE_VERSION_RESPONSE when the host has asked for it
     * ({@link readDeviceVersion}); `'shimmer3r'` otherwise, because that is what
     * this client is named for and what its default transport connects to.
     *
     * The default is not always harmless. This client also drives a classic
     * Shimmer3 over an RFCOMM byte stream (the two platforms share this command
     * set), and the two generations disagree about the width of the
     * pressure/temperature channels — a Shimmer3 sends 2 big-endian bytes of
     * temperature where a Shimmer3R sends 3 little-endian ones, and reverses the
     * order of the pair. So call `readDeviceVersion()` before `inquiry()` on any
     * link that might be a Shimmer3; `inquiry()` deliberately does not send that
     * command itself, to keep the schema rebuild after `setSensors()` a single
     * round trip. When the generation is assumed *and* the channel list contains a
     * channel that depends on it, the schema says so (`trusted === false`) and a
     * status message names the channels.
     */
    get generation(): ShimmerGeneration;
    /** True when {@link generation} is this SDK's default rather than the device's answer. */
    get generationIsAssumed(): boolean;
    private _buildSchemaFromChannels;
    private _calibrateData;
    private _parseBySchema;
    private _write;
    private _writeExpectingAck;
    private _waitForAck;
    private _waitForResponse;
    /**
     * Await an instream response — one of the messages the firmware answers
     * behind the shared `[0x8A]` prefix, where the byte after it selects the
     * message rather than the leading opcode.
     *
     * @param subOpcode   The byte after 0x8A (STATUS_RESPONSE, VBATT_RESPONSE …).
     * @param payloadLen  Minimum payload the message must carry to count, so a
     *   truncated one is waited past rather than parsed. A *minimum*, not an
     *   exact length: a Shimmer3 sends one status byte where a Shimmer3R sends
     *   two, and a caller that has not yet asked which it is talking to must not
     *   time out on the shorter answer.
     */
    private _waitForInstreamResponse;
    private _onTemp;
    private _offTemp;
    private _emitTemp;
    private _fwVersionCache;
    private _deviceVersionCache;
    /**
     * Read (and cache) the hardware version via GET_DEVICE_VERSION_COMMAND
     * (0x3F → `[0x25][hw]`). 3 = Shimmer3, 10 = Shimmer3R.
     *
     * Worth asking even though this client is named for the Shimmer3R: the two
     * platforms share this firmware and this command set, so a Shimmer3 reached
     * over classic Bluetooth answers here too — and answers some commands with
     * fewer bytes than a Shimmer3R does (see {@link getStatus}). Cached, so the
     * gating call sites can ask freely.
     */
    readDeviceVersion(): Promise<Shimmer3DeviceVersion>;
    /**
     * Ask what the sensor is doing: docked, sensing, logging, streaming, SD card
     * present, RTC set (GET_STATUS_COMMAND 0x72 → `[0x8A][0x71][status0]…`).
     *
     * This is the only way to learn several of those. An inquiry reports the
     * *configuration*; only the status bytes say whether a recording is actually
     * running, whether the clock has been set since the sensor last lost power,
     * or whether the firmware failed to open its SD file.
     *
     * Call {@link readDeviceVersion} first when the platform is unknown: a
     * Shimmer3 answers with one status byte where a Shimmer3R sends two, and over
     * a byte stream the framer needs to know which before it can split the
     * message. Getting it wrong there consumes the ACK that follows.
     *
     * Calling it first also sharpens the failure mode here: with the platform
     * known, an answer shorter than that platform's status is a truncated message
     * and this rejects on timeout rather than returning a status whose
     * `usbPluggedIn` is `null`. While the platform is unknown the short answer is
     * still accepted, because it is indistinguishable from a Shimmer3's.
     */
    getStatus(): Promise<Shimmer3DeviceStatus>;
    /**
     * Read the battery ADC and charger state (GET_VBATT_COMMAND 0x95 →
     * `[0x8A][0x94][raw x3]`).
     *
     * The three payload bytes are the firmware's own `BattStatusRaw` union
     * (`Battery/shimmer_battery.h:60-74`): a little-endian 12-bit ADC reading
     * followed by the charger chip's STAT1/STAT2 bits. That is the same record the
     * dock UART carries, so this reuses {@link parseBatteryStatus} rather than
     * adding a second reading of the same bytes — including its voltage curve and
     * the percentage it declines to report when the reading is out of range.
     */
    getBattery(): Promise<WiredBatteryStatus>;
    /** Read (and cache) the firmware version via GET_FW_VERSION_COMMAND. */
    readFwVersion(): Promise<{
        fwId: number;
        major: number;
        minor: number;
        patch: number;
    }>;
    /**
     * True when the connected firmware serves the SD file-transfer commands
     * AND transfers them intact (LogAndStream_Shimmer3R >= v1.01.011).
     * v1.01.009 and v1.01.010 implement the protocol but ship every 512-byte
     * block shifted 3 bytes with a zero-padded tail — the firmware's sector DMA
     * landed below the misaligned payload buffer and the frame CRC was computed
     * after the fact, so the corruption arrives as valid frames the host cannot
     * detect. Those versions are therefore gated out. Firmware older than that
     * silently ignores unknown opcodes, so version gating is the only reliable
     * probe.
     */
    supportsSdTransfer(): Promise<boolean>;
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
    runDataRateTest(durationMs?: number, onProgress?: (bytesSoFar: number, elapsedMs: number) => void): Promise<{
        bytesReceived: number;
        durationMs: number;
        kBps: number;
    }>;
    /**
     * What the factory-test runner is doing: `idle` when the link is free,
     * `running` while the report is being captured, `draining` while a cancelled
     * or timed-out report is still being swallowed.
     */
    get factoryTestState(): FactoryTestState;
    /**
     * Resolve when the link is free again. Never rejects — a failed run still
     * releases the link, and this is the wait a host needs after cancelling one.
     */
    whenFactoryTestIdle(): Promise<void>;
    /**
     * Run the sensor's built-in factory self-test and return its report.
     *
     * `SET_FACTORY_TEST` (0xA8) with one type byte
     * (`Comms/shimmer_bt_uart.c:1285-1293`) makes the firmware ACK and then print
     * the same report it prints on the production line — as raw ASCII on this very
     * link, with no framing and no CRC (`Test/shimmer_test.c:22-61`). The
     * {@link FactoryTestCapture} owns those bytes for the duration; see its
     * docblock for the phases and the tail handoff.
     *
     * Three things about this command are unlike every other one here:
     * - **It cannot be stopped.** The firmware has no abort; its main loop is
     *   blocked for the whole suite (`shimmer_taskList.c:164`). `opts.signal`
     *   stops this client *listening*, and the link stays busy until the report
     *   ends — {@link whenFactoryTestIdle} is how a host waits that out.
     * - **Nothing else may be written meanwhile.** Every other command rejects
     *   with a {@link FactoryTestError} of reason `busy` until the capture is idle.
     * - **It is refused while sensing.** `ShimBt_isCmdBlockedWhileSensing`
     *   (`Comms/shimmer_bt_uart.c:2985`) NACKs it while streaming or logging, and
     *   also when SD sync is enabled.
     *
     * @param type 0 MAIN, 1 LEDS, 2 ICS, 3 LED_STATES (`Test/shimmer_test.h:21-27`).
     * @param opts see {@link FactoryTestRunOptions}; `timeoutMs` defaults to the
     *   type's own entry in `SHIMMER3_FACTORY_TEST_TYPES`.
     * @returns the report text, CRLF line endings intact.
     * @throws RangeError for a type the firmware would ACK and then print nothing
     *   for; {@link FactoryTestError} with reason `nack` (sensing), `busy`
     *   (another run), `no-response`, `timeout` or `disconnected`; or a
     *   `DOMException` named `AbortError` when `opts.signal` fires.
     *
     * HARDWARE-VERIFY: no real Shimmer3 or Shimmer3R has run this path yet.
     */
    runFactoryTest(type: number, opts?: FactoryTestRunOptions): Promise<string>;
    /**
     * Let go of the link at the end of a run: clear the capture, then drop
     * anything the report left in the accumulators. Called from the capture's own
     * `idle` transition, so it happens before the tail bytes it hands back are
     * routed through the framer.
     */
    private _releaseFactoryTest;
    /**
     * Flip the firmware's red-LED override (`TOGGLE_LED_COMMAND` 0x06,
     * `Comms/shimmer_bt_uart.c:603, :910-914`).
     *
     * The command toggles `shimmerStatus.toggleLedRedCmd`, and while it is set the
     * LED manager holds the LOWER LED solid red (`LEDs/shimmer_leds.c:425-428`) —
     * above the SD-error and battery indications, below a button press. That makes
     * it the "which sensor is this one" aid.
     *
     * Two things to know: the flag is **never cleared by the firmware**, so it
     * survives a disconnect and stays lit until it is toggled again or the sensor
     * loses power; and it is readable back as status bit 7
     * (`ShimBt_assembleStatusBytes`, `:2920-2932`) — {@link Shimmer3DeviceStatus}
     * `redLedOn` — which is what {@link setRedLed} uses to make "on"/"off" mean
     * something.
     *
     * While streaming this writes without waiting for the ACK: every inbound byte
     * belongs to the data plane then, so the ACK would be consumed by the schema
     * parser and the wait would time out on a command the firmware did in fact run.
     *
     * HARDWARE-VERIFY: that the lower LED visibly lights, and that the flag really
     * does survive a disconnect, want confirming on a sensor.
     */
    toggleLed(): Promise<void>;
    /**
     * Drive the red-LED override to a definite state rather than flipping it.
     *
     * The firmware offers only a toggle, so this is a read-modify-verify:
     * {@link getStatus} for the current bit, {@link toggleLed} only if it differs,
     * then a second read to confirm. Calling it twice with the same argument
     * writes nothing the second time.
     *
     * @returns the LED state read back from the sensor.
     * @throws when the sensor is streaming (the status reads are unavailable), or
     *   when the read-back does not match — which means something else moved the
     *   flag between the two reads, and silently reporting success would be worse
     *   than saying so.
     */
    setRedLed(on: boolean): Promise<boolean>;
    private _sdRx;
    private _sdUsers;
    private _sdHandlerAttached;
    private _sdExpect;
    private _sdFrameListener;
    private _sdCrcErrorListener;
    private _sdKnownSession;
    private _sdAcquire;
    private _sdRelease;
    private _sdChunkHandler;
    /**
     * Enforce the {@link supportsSdTransfer} gate on every SD entry point, so a
     * caller that skips the advisory check cannot pull silently-corrupted data
     * off a v1.01.009/.010 device. Must complete BEFORE the synchronous
     * single-slot checks (`_sdExpect`, `_sdFrameListener`): those are
     * check-then-set atomically only while no await sits between them.
     * (The first call costs one GET_FW_VERSION round trip; readFwVersion
     * caches it for the rest of the connection.)
     */
    private _ensureSdTransferSupported;
    /** Send an SD command and await its reassembled one-shot response. */
    private _sdCommand;
    /**
     * List a directory on the SD card, transparently following the firmware's
     * startIdx paging. Path example: `'data'` or
     * `'data/DefaultTrial_123/Shimmer_ABCD-000'`.
     */
    sdListDir(path: string, opts?: {
        maxEntriesPerPage?: number;
    }): Promise<SdDirEntry[]>;
    /** Stat one file or directory on the SD card. */
    sdStatFile(path: string): Promise<SdFileStat>;
    /** Query free/total space on the SD card (in KB). */
    sdGetFreeSpace(): Promise<SdCardSpace>;
    /**
     * Delete one file (or empty directory) on the SD card. The firmware only
     * permits paths strictly under `data/`.
     */
    sdDeletePath(path: string): Promise<void>;
    /** Ask the firmware to abandon the in-flight read window, if any.
     * Deliberately NOT gated on {@link supportsSdTransfer}: it runs in cleanup
     * paths (abort signals, disconnects) where an extra version probe could
     * fail, and old firmware just ignores the unknown opcode. */
    sdAbortTransfer(): Promise<void>;
    /**
     * Read one window of a file. The firmware streams the window as CRC'd
     * blocks; `onBlock` is invoked for each verified block in order. Resolves
     * with the closing status frame. Rejects on stall, CRC failure or sequence
     * gap — the caller re-requests from its last good offset (the firmware is
     * stateless, so a fresh window is always a valid resume).
     */
    sdReadFileWindow(path: string, offset: number, windowLen: number, opts?: {
        blockPayloadLen?: number;
        stallTimeoutMs?: number;
        signal?: AbortSignal;
        onBlock?: (payload: Uint8Array, absOffset: number) => void;
    }): Promise<{
        status: number;
        nextOffset: number;
        bytesReceived: number;
    }>;
}

/**
 * Reading a protocol off an unframed pipe: the sentinels every framer returns,
 * and the drain loop that turns a framer into message boundaries.
 *
 * A **framer** is a pure function `(buf) => number` reporting how many bytes the
 * message at the head of `buf` occupies — the length knowledge the Java driver
 * encodes in its blocking `readBytes(n)` calls, expressed as a function. Each
 * device family owns its own (`shimmer3ControlMessageLength`,
 * `shimmer3rControlMessageLength`, the dock's `wiredPacketLength`), because that
 * part genuinely differs per protocol.
 *
 * The **drain** ({@link drainByteStream}) is the part that does not differ, so it
 * lives here once: accumulate, extract every complete message, resynchronise
 * past what cannot be framed, hand back the tail. `Shimmer3Client` and
 * `Shimmer3RClient` both run on it, differing only in their framer and in two
 * small hooks ({@link DrainOptions.inspect}, {@link DrainOptions.coalesce}).
 *
 * `src/devices/shimmer3/protocol.ts` and `src/devices/dock/protocol.ts` each
 * predate this module and export their own identically-valued sentinel copies;
 * they are public API and are left alone. New framers should import from here.
 */
/** Not enough bytes buffered yet to determine the message length. */
declare const NEED_MORE = -1;
/**
 * The leading byte is not the start of a message we understand — the caller
 * should drop one byte and retry (resynchronise) rather than guess a length.
 */
declare const RESYNC = 0;
/** A framer: total length of the message at the head of `buf`, or a sentinel. */
type MessageLengthFn = (buf: Uint8Array) => number;
/**
 * What {@link drainByteStream} should do with the byte at the head of the
 * buffer, before any framing is attempted.
 *
 * - `frame` — the normal path: consult the framer.
 * - `drop` — consume this one byte and carry on. For an opcode that is only
 *   valid in a context the caller tracks (an INQUIRY_RESPONSE with no inquiry
 *   outstanding is a stray stream byte, and framing it would swallow real
 *   control traffic).
 * - `stop` — end the drain, leaving this byte and everything after it in
 *   {@link DrainResult.rest}. For bytes that belong to another plane entirely,
 *   such as stream data whose length only the schema knows.
 */
type DrainVerdict = 'frame' | 'drop' | 'stop';
/**
 * Why a byte was consumed without becoming a message (for logging).
 *
 * - `resync` — the framer could not size a message here.
 * - `gated` — {@link DrainOptions.inspect} rejected the byte as out of context.
 * - `rejected` — the framer sized a message but {@link DrainOptions.decode}
 *   refused it (a failed CRC, a malformed body).
 */
type DropReason = 'resync' | 'gated' | 'rejected';
interface DrainOptions<T = Uint8Array> {
    /** Framer for the protocol being drained. */
    messageLength: MessageLengthFn;
    /**
     * Turn a framed message into whatever the caller's handlers consume, or return
     * `null` to refuse it. Omit to receive the raw bytes.
     *
     * Refusal deliberately resynchronises by **one byte**, not by the whole span:
     * a packet that framed but failed its CRC is evidence that the framing itself
     * was wrong — the real packet header may be a byte or two further on, and
     * skipping the whole supposed length would step over it. This mirrors the Java
     * driver's `parseSinglePacket` CRC-fail path.
     */
    decode?: (msg: Uint8Array) => T | null;
    /**
     * Per-head-byte gate, evaluated before framing. Defaults to always `frame`.
     * Called with the whole remaining buffer so a gate can look past byte 0.
     */
    inspect?: (buf: Uint8Array) => DrainVerdict;
    /**
     * Chance to merge the message that follows `msg` into it, returning how many
     * extra bytes to consume (0 = leave them for the next iteration). `rest`
     * starts immediately after `msg`.
     *
     * This exists because BLE coalesces an ACK with the response written straight
     * after it into a single notification, and clients built against BLE depend on
     * that. A drain that emitted them separately would deliver the response before
     * the awaiting caller had registered its handler.
     */
    coalesce?: (msg: Uint8Array, rest: Uint8Array) => number;
    /**
     * Dispatch each message the moment it is extracted, before the next head byte
     * is inspected. When omitted, messages are collected into
     * {@link DrainResult.messages} and the caller dispatches them afterwards.
     *
     * **Use this whenever `inspect` or `coalesce` read state that a handler
     * mutates synchronously.** Both Shimmer clients do: delivering a response
     * decrements the gate counters (`_awaitInq`/`_awaitCmd`) or the expected-ACK
     * count inside the handler, not on a later microtask. Collecting first would
     * evaluate every hook against the state as it was before *any* message was
     * delivered — so a stray 0x02 following a genuine INQUIRY_RESPONSE in the same
     * read would still look "awaited" and get framed, swallowing the bytes behind
     * it instead of being dropped.
     *
     * **Must not throw.** An exception here escapes `drainByteStream`, so the
     * caller never receives {@link DrainResult.rest} and never advances its
     * accumulator — every message in that read would be delivered again on the
     * next one. All three in-tree callers dispatch through an emit helper that
     * swallows handler exceptions, which is what makes this safe today.
     */
    onMessage?: (msg: T) => void;
    /** Notified for every byte dropped, so callers can log without duplicating the loop. */
    onDrop?: (byte: number, reason: DropReason) => void;
}
interface DrainResult<T = Uint8Array> {
    /** Complete messages, in wire order — decoded when a `decode` was supplied. */
    messages: T[];
    /** Bytes not consumed — the caller stores this back as its accumulator. */
    rest: Uint8Array;
    /** True when {@link DrainOptions.inspect} returned `stop`. */
    stopped: boolean;
}
/**
 * Rebuild message boundaries from an unframed byte stream.
 *
 * The shared half of what a client reading from Web Serial, RFCOMM/SPP or a dock
 * UART has to do: accumulate, extract every complete message the framer can
 * size, drop what cannot be framed one byte at a time (never guessing a length),
 * and hand back the incomplete tail. Pure — no client state is touched — so the
 * awkward cases are unit-testable without a transport.
 *
 * Byte-at-a-time resynchronisation is the deliberate choice over flushing the
 * buffer on garbage: a corrupt byte then costs one byte, not every valid message
 * queued behind it.
 *
 * Pass {@link DrainOptions.onMessage} to have each message dispatched as it is
 * extracted. That ordering matters whenever `inspect` or `coalesce` consult state
 * a handler mutates synchronously — see that option's note.
 */
declare function drainByteStream(buf: Uint8Array, opts: DrainOptions<Uint8Array> & {
    decode?: undefined;
}): DrainResult<Uint8Array>;
/**
 * Drain into decoded values of type `T`.
 *
 * `decode` is REQUIRED in this form, and that is the whole point of splitting
 * the signature: `T` is only ever inhabited by what `decode` returns, so
 * `drainByteStream<MyPacket>(buf, { messageLength, onMessage })` — no `decode` —
 * must not compile. It used to, and the implementation's cast then handed
 * `onMessage` a raw `Uint8Array` that the compiler believed was a `MyPacket`.
 */
declare function drainByteStream<T>(buf: Uint8Array, opts: DrainOptions<T> & {
    decode: (msg: Uint8Array) => T | null;
}): DrainResult<T>;

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
declare const SHIMMER3R_INQ_NUM_CHANNELS_OFFSET = 10;
/** Offset of the first channel-ID byte within an INQUIRY_RESPONSE. */
declare const SHIMMER3R_INQ_CHANNELS_OFFSET: number;
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
declare const SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS: Readonly<Record<number, number>>;
/**
 * How many status bytes a STATUS_RESPONSE carries — the one length in this
 * protocol that depends on which platform answered rather than on the bytes
 * themselves.
 */
interface Shimmer3RFramingOptions {
    /**
     * 2 on a Shimmer3R, 1 on a Shimmer3 (`STATUS_BYTE_COUNT`,
     * log-and-stream-common `Comms/shimmer_bt_uart.h:259-263`). Defaults to 2:
     * this framer belongs to the Shimmer3R client, and a client that has not yet
     * asked for the hardware version is talking to a Shimmer3R until told
     * otherwise. Get it wrong on a Shimmer3 and the framer eats the byte after
     * the status — an ACK, usually — so the client should pass 1 as soon as
     * `readDeviceVersion` reports hardware 3.
     */
    statusPayloadBytes?: 1 | 2;
}
/**
 * Total length (INCLUDING the leading opcode) of the control message at the
 * head of `buf`, or {@link NEED_MORE} when more bytes are required to tell, or
 * {@link RESYNC} when the leading byte starts nothing we recognise.
 *
 * Deliberately does NOT frame DATA_PACKET (0x00): stream data is length-defined
 * by the negotiated schema rather than by the protocol, so the client routes it
 * to its schema parser instead of through this function.
 */
declare function shimmer3rControlMessageLength(buf: Uint8Array, opts?: Shimmer3RFramingOptions): number;

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
 * The Shimmer3/Shimmer3R factory self-test: the type table and the two
 * LiteProtocol helpers a Bluetooth client needs to drive it.
 *
 * `SET_FACTORY_TEST` (0xA8, `Comms/shimmer_bt_uart.h:210`, one argument byte per
 * the command's entry in the argument table at `:695`, handler at
 * `Comms/shimmer_bt_uart.c:1285-1293`) selects one of the four suites the
 * firmware runs at the factory. Everything in this module is pure — the runner
 * itself lives in `../factoryTest/capture.ts` and the clients.
 *
 * The suites are shared between the two families: `log-and-stream-common` is
 * built into both the Shimmer3 (MSP430) and Shimmer3R (STM32) firmware, so the
 * type numbering, the ACK-then-report sequence and the report envelope are the
 * same on either. The bodies differ — only the Shimmer3R prints test IDs.
 */

/**
 * The factory-test types, exactly as the firmware enumerates them
 * (`Test/shimmer_test.h:21-27`). A type of 4 or more is silently ACKed and
 * produces NO report, which is why {@link requireShimmer3FactoryTestType}
 * refuses it rather than letting a caller wait out a timeout for a report the
 * firmware was never going to print.
 */
declare const SHIMMER3_FACTORY_TEST_TYPE: Readonly<{
    /** Everything: the IC suite, the LED walk-through and an overall verdict. */
    readonly MAIN: 0;
    /** The LEDs only — nothing to pass or fail, so no overall verdict. */
    readonly LEDS: 1;
    /** The ICs only, with an overall verdict. */
    readonly ICS: 2;
    /** The operational LED-state walk-through — again no overall verdict. */
    readonly LED_STATES: 3;
}>;
/** A factory-test type value (0–3). */
type Shimmer3FactoryTestType = (typeof SHIMMER3_FACTORY_TEST_TYPE)[keyof typeof SHIMMER3_FACTORY_TEST_TYPE];
/** Everything a host needs to offer one factory-test type in a UI. */
interface Shimmer3FactoryTestTypeInfo {
    /** The argument byte for `SET_FACTORY_TEST`. */
    readonly value: number;
    /** The firmware's own enumerator name. */
    readonly name: 'MAIN' | 'LEDS' | 'ICS' | 'LED_STATES';
    /** Short human label for a picker. */
    readonly label: string;
    /** One sentence explaining what the sensor will do. */
    readonly description: string;
    /**
     * Roughly how long the suite takes. The firmware's main loop is blocked for
     * the whole of it, so this is also how long the link is unusable.
     */
    readonly expectedDurationMs: number;
    /** Default overall budget for a run of this type — comfortably past the expected duration. */
    readonly defaultTimeoutMs: number;
    /** Whether the report ends with an `Overall Result =` line. */
    readonly hasOverall: boolean;
}
/**
 * The four types in firmware order.
 *
 * The durations are the firmware's own step counts, not measurements: the LED
 * suite is 9 steps of 2 s, and the operational-state walk-through holds 15
 * states for 5 s each — 2 with Bluetooth disabled, 6 with it enabled, 5 under
 * SD sync and 2 others, one `platform_delayMs` apiece
 * (`Test/shimmer_test_leds_states.c`). The IC suite's chip probes dominate
 * MAIN. HARDWARE-VERIFY: they have not been timed on a real Shimmer3 or
 * Shimmer3R, so the default timeouts carry generous headroom over them.
 */
declare const SHIMMER3_FACTORY_TEST_TYPES: readonly Shimmer3FactoryTestTypeInfo[];
/** Look up a type's table entry, or `null` when the value is not one of the four. */
declare function shimmer3FactoryTestTypeInfo(value: number): Shimmer3FactoryTestTypeInfo | null;
/**
 * Look up a type's table entry, or throw.
 *
 * @throws RangeError when `value` is not 0–3. The firmware ACKs a larger type
 *   and then prints nothing at all (`Test/shimmer_test.h:21-27`), so a run with
 *   one would hang until its timeout with no way to tell it from a dead link.
 */
declare function requireShimmer3FactoryTestType(value: number): Shimmer3FactoryTestTypeInfo;
/** Build the two-byte `SET_FACTORY_TEST` command for a type. */
declare function buildSetFactoryTestCommand(type: number): Uint8Array;
/**
 * Classify the head of a LiteProtocol chunk during a factory-test run.
 *
 * The firmware answers the command with the generic one-byte ACK (0xFF) or NACK
 * (0xFE) and then prints the report as bare ASCII on the same link, so anything
 * that is not one of those two bytes is already report text. Both answers are
 * one byte, so this never needs more.
 */
declare function classifyLiteProtocolAck(buf: Uint8Array): AckVerdict;

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
declare const BRAND_RECORD_HOST_OFFSET = 1936;
declare const BRAND_RECORD_SIZE = 80;
declare const BRAND_RECORD_MAGIC = 21314;
declare const BRAND_RECORD_LAYOUT_VER = 2;
declare const BRAND_BT_CLASSIC_MAX_CHARS = 16;
declare const BRAND_BLE_MAX_CHARS = 10;
declare const BRAND_USB_PRODUCT_MAX_CHARS = 16;
/** Long enough for the stock "Shimmer Research Ltd." (21 chars). */
declare const BRAND_USB_MANUFACTURER_MAX_CHARS = 24;
/**
 * Shimmer3 firmware truncates the BLE prefix to 8 chars so "<prefix>-XXXX"
 * fits the RN4678's 31-byte advertisement payload. Shimmer3R allows the full
 * field width.
 */
declare const BRAND_BLE_MAX_CHARS_SHIMMER3 = 8;
/** `flags` bits 1-2: which platform seeded a stock (non-customer) record. */
declare const BRAND_PLATFORM: Readonly<{
    readonly UNKNOWN: 0;
    readonly SHIMMER3: 1;
    readonly SHIMMER3R: 2;
    readonly SHIMMER4_SDK: 3;
}>;
interface BrandRecord {
    /** True when magic, layout version, lengths, charset and CRC all check out. */
    valid: boolean;
    /** Populated when `valid` is false — first failed check, for display. */
    invalidReason?: string;
    /** Classic BT name prefix (firmware appends the MAC suffix). */
    btClassic: string;
    /** BLE name prefix. */
    ble: string;
    /** USB product-name prefix (firmware appends the MAC suffix). */
    usbProduct: string;
    /** USB iManufacturer string, verbatim. */
    usbManufacturer: string;
    /** BRAND_PLATFORM value stamped by the seeding firmware. */
    seededPlatform: number;
}
interface BrandRecordFields {
    btClassic: string;
    ble: string;
    usbProduct: string;
    usbManufacturer: string;
    /** Defaults to BRAND_PLATFORM.UNKNOWN — informational only. */
    seededPlatform?: number;
}
/**
 * Firmware-mirrored character rule: 1..max printable ASCII (0x20–0x7E),
 * comma excluded (it would corrupt the RN4X `S-,<name>` command).
 * Returns null when OK, else a human-readable reason.
 */
declare function brandNameProblem(name: string, maxChars: number): string | null;
/** Decode and validate a brand record read from the device. */
declare function parseBrandRecord(bytes: Uint8Array): BrandRecord;
/**
 * Serialise a brand record ready to write to the device. Throws on names that
 * the firmware would reject (so callers surface errors before writing).
 */
declare function buildBrandRecord(fields: BrandRecordFields): Uint8Array;
/**
 * An all-0xFF (erased) record. Writing this restores the platform defaults:
 * firmware re-seeds them at the next boot.
 */
declare function buildBlankBrandRecord(): Uint8Array;

/**
 * High-level SD-card download orchestration for the Shimmer3R.
 *
 * Walks the on-card tree with the client's SD commands, mirrors the directory
 * structure on the host via the File System Access API, and pulls each file
 * down in windows with resume-from-on-disk-size semantics — the same shape as
 * the field-proven Verisense `transferLoggedData` flow.
 */

/**
 * Where the downloaded files are placed under the destination folder.
 *
 * - `card` mirrors the on-card tree as-is:
 *   `data/<TrialName>_<ConfigTime>/<ShimmerName>-<NNN>/<file>`
 * - `consensysBackup` nests that same tree under the two levels Consensys
 *   expects inside its workspace `Backup` folder:
 *   `<import-stamp>/<ShimmerName>/data/<TrialName>_<ConfigTime>/<ShimmerName>-<NNN>/<file>`
 *   so the download can be imported via
 *   *Application Settings -> Manage Data -> Import Data From Backup Directory*.
 */
type SdDestinationLayout = 'card' | 'consensysBackup';
/** Device-name folder used when a session folder is not `<Name>-<NNN>`. */
declare const CONSENSYS_UNKNOWN_DEVICE = "Unknown_Shimmer";
/**
 * Format an import-time folder name as Consensys does: `yyyy-MM-dd_HH.mm.ss`
 * in local time (e.g. `2025-06-25_15.30.36`).
 */
declare function formatSdImportStamp(date?: Date): string;
/**
 * Map a card directory chain to its Consensys Backup destination.
 *
 * The device name is taken from the session folder (`<ShimmerName>-<NNN>`)
 * rather than from the connected device, so sessions recorded under a previous
 * device name - or on a card that has been moved between devices - still file
 * under the name they were recorded with, which is what Consensys shows.
 */
declare function consensysBackupSegments(cardDirSegments: string[], importStamp: string): string[];
interface SdRemoteFile {
    /** Full on-card path, e.g. `data/DefaultTrial_123/Shimmer_ABCD-000/000`. */
    path: string;
    size: number;
    mtime: Date | null;
}
interface SdRemoteTree {
    /** Directories in discovery order (parents before children), full paths. */
    dirs: string[];
    files: SdRemoteFile[];
    totalBytes: number;
}
interface SdTransferProgress {
    phase: 'enumerate' | 'download' | 'delete';
    /** On-card path of the file currently transferring (download phase). */
    currentFile?: string;
    fileBytesDone?: number;
    fileBytesTotal?: number;
    bytesDone: number;
    bytesTotal: number;
    filesDone: number;
    filesTotal: number;
    /** Rolling throughput estimate over the current file, in KB/s. */
    kbps?: number;
}
interface DownloadSdTreeOptions {
    /** Root to walk on the card. @default 'data' */
    rootPath?: string;
    /** Bytes requested per SD_FILE_READ window. @default 131072 */
    windowLen?: number;
    /** Payload bytes per streamed block (64..1024). @default 512 */
    blockPayloadLen?: number;
    /** Resume partially-downloaded files from their on-disk size. @default true */
    resume?: boolean;
    /** Skip files whose on-disk size already matches the card. @default true */
    skipExisting?: boolean;
    /**
     * After a file downloads completely (size verified), delete it from the
     * card; session/trial directories that emptied out are removed afterwards.
     * @default false
     */
    deleteAfterVerify?: boolean;
    /** Windows retried per file before the file is marked failed. @default 3 */
    maxRetriesPerFile?: number;
    /** Per-window stall watchdog passed to sdReadFileWindow. @default 6000 */
    stallTimeoutMs?: number;
    /** Destination folder layout. @default 'card' */
    layout?: SdDestinationLayout;
    /**
     * Import-time folder name for `consensysBackup` (one per download run).
     * Defaults to the current local time via {@link formatSdImportStamp}.
     */
    importStamp?: string;
    signal?: AbortSignal;
    onProgress?: (p: SdTransferProgress) => void;
}
interface SdTransferSummary {
    /** Import folder used for `consensysBackup`; undefined for `card`. */
    importStamp?: string;
    filesDownloaded: number;
    filesSkipped: number;
    filesFailed: {
        path: string;
        error: string;
    }[];
    bytesDownloaded: number;
    deletedFromCard: string[];
}
/** Recursively enumerate the on-card tree below `rootPath` (depth-first). */
declare function enumerateSdTree(client: Shimmer3RClient, rootPath?: string, opts?: {
    signal?: AbortSignal;
    maxDepth?: number;
}): Promise<SdRemoteTree>;
/**
 * Download the card's `rootPath` tree into `destRoot`, recreating the on-card
 * directory structure. Re-running with the same destination resumes: complete
 * files are skipped and partial files continue from their on-disk size.
 */
declare function downloadSdTree(client: Shimmer3RClient, destRoot: FileSystemDirectoryHandle, opts?: DownloadSdTreeOptions): Promise<SdTransferSummary>;
/**
 * Delete verified files from the card (files first, then any directories that
 * emptied out, deepest first). Only paths under `data/` are accepted by the
 * firmware. Returns the paths actually deleted; failures are skipped.
 */
declare function deleteDownloadedFromCard(client: Shimmer3RClient, filePaths: string[], dirPaths?: string[], opts?: {
    signal?: AbortSignal;
}): Promise<string[]>;

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
/**
 * Ensure a nested directory path exists under a root directory handle, creating
 * each level as needed, and return the leaf handle. Browser-only (File System
 * Access API) — the app obtains `root` from `showDirectoryPicker()` when the
 * user selects an output location at transfer start.
 */
declare function ensureDirectoryPath(root: FileSystemDirectoryHandle, segments: string[]): Promise<FileSystemDirectoryHandle>;
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

/**
 * Classic-Bluetooth (RFCOMM/SPP) Shimmer3 constants.
 *
 * The LiteProtocol opcode set, sensor bitmap, channel formats and timestamp
 * descriptors are byte-for-byte identical to the Shimmer3R, so they are
 * re-exported from `../shimmer3r/` rather than duplicated. Only the values that
 * are genuinely Shimmer3-classic-specific live here.
 */

/**
 * The `WebSerialTransport` options that reach a Shimmer over classic Bluetooth.
 *
 * Both Bluetooth fields are required and they do different jobs, which is the
 * whole reason this is a constant rather than something each caller assembles:
 * `allowedBluetoothServiceClassIds` only *permits* Bluetooth ports to appear at
 * all, while `filters` is what *narrows* the picker to Shimmers. Supply the
 * permission alone and the picker lists every serial port and every paired
 * Bluetooth device, which is unusable — a mistake that has been made once
 * already, in the demos this constant replaces.
 *
 * Spread it and add whatever the call site needs on top:
 *
 * ```ts
 * new WebSerialTransport({ ...SHIMMER3_SPP_SERIAL_OPTIONS, bufferSize: 64 * 1024 })
 * ```
 *
 * Works on desktop Chrome/Edge 117+ and — because Android's Web Serial serves
 * RFCOMM and nothing else — on Android Chrome 138+, where the sensor must be
 * paired in system settings first. See `describePlatformSupport`.
 */
declare const SHIMMER3_SPP_SERIAL_OPTIONS: Readonly<{
    readonly filters: readonly Readonly<{
        bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb";
    }>[];
    readonly allowedBluetoothServiceClassIds: readonly string[];
    readonly kind: "rfcomm";
}>;
/**
 * Connect-handshake defaults, ported from the timings/sequence in
 * com.shimmerresearch.bluetooth.ShimmerBluetooth.
 */
declare const SHIMMER3_DEFAULTS: Readonly<{
    /**
     * How long to drain-and-discard bytes after the dummy read that flushes the
     * RFCOMM buffer on connect. ShimmerBluetooth's dummy read polls the serial
     * buffer with short sleeps; 250 ms comfortably covers an ACK + response at
     * classic-BT latencies.
     */
    DUMMY_READ_DRAIN_MS: 250;
    /** Per-command ACK timeout (ms). */
    ACK_TIMEOUT_MS: 1500;
    /** Response (post-ACK) timeout (ms). */
    RESPONSE_TIMEOUT_MS: 2000;
    /**
     * Default streaming timestamp width. Classic Shimmer3 LogAndStream firmware
     * with version code ≥ 6 uses a 3-byte timestamp
     * (ShimmerObject#updateTimestampByteLength); older firmware uses 2 bytes.
     */
    TIMESTAMP_FMT: "u24";
}>;

interface Shimmer3ClientOptions extends ShimmerClientOptions {
    /**
     * The RFCOMM/SPP byte pipe to the classic Shimmer3. **Required** — classic
     * Bluetooth is impossible in a browser, so unlike {@link Shimmer3RClient} this
     * client never builds a default transport. Supply one here or to
     * {@link Shimmer3Client.connect}.
     */
    transport?: ShimmerTransport;
    /**
     * Force a specific streaming timestamp width. When omitted the width is chosen
     * from the firmware version reported during the connect handshake (u24 for
     * firmware code ≥ 6, else u16 — ShimmerObject#updateTimestampByteLength).
     */
    timestampFmt?: TimestampFmt;
    /**
     * Send a best-effort STOP_STREAMING before the buffer-flush dummy read on
     * connect, so reconnecting to a device left mid-stream is clean. Default true.
     */
    stopStreamingOnConnect?: boolean;
    /**
     * IMU generation for default inertial calibration selection. `'old'` =
     * LSM303DLHC accel/mag + MPU9x50 gyro (Shimmer3 SR<6); `'new'` = LSM303AHTR
     * accel/mag (new-IMU boards). Default `'old'`.
     *
     * HARDWARE-VERIFY: the streaming protocol does not expose the daughter-card
     * revision, so the generation cannot be auto-detected here; set this to match
     * the device when using the new-IMU boards.
     */
    imuGeneration?: 'old' | 'new';
    /**
     * Emit calibrated (`'cal'`) inertial channel values alongside the raw ones.
     * Default true. Set false to keep the pre-calibration behaviour (raw only).
     */
    emitCalibratedInertial?: boolean;
}
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
declare class Shimmer3Client extends BaseShimmerClient {
    private _injectedTransport;
    private _transport;
    private _notifyUnsub;
    private _disconnectUnsub;
    private _rxBuf;
    private _temps;
    private schema;
    private _forceTimestampFmt;
    private _timestampFmt;
    private _stopStreamingOnConnect;
    private _streaming;
    private _streamStarting;
    private _lastTs;
    /** Bumped once per inbound transport chunk — used for quiescence detection. */
    private _rxSeq;
    /** While true, {@link _handleNotify} only accumulates; a drain loop owns `_rxBuf`. */
    private _drainingResidual;
    /** Number of {@link _waitForResponse} calls currently awaiting an INQUIRY_RESPONSE. */
    private _awaitInq;
    /**
     * Number of command handlers ({@link _waitForAck} / {@link _waitForResponse})
     * currently awaiting a response. Gates NACK framing in {@link _drainControl}
     * so a stray 0xFE arriving with no command in flight cannot fabricate a NACK.
     */
    private _awaitCmd;
    deviceVersion: Shimmer3DeviceVersion | null;
    firmwareVersion: Shimmer3FwVersion | null;
    enabledSensors: number;
    samplingRateHz: number;
    gsrRangeSetting: number;
    ExpPower: number;
    /** Inertial-sensor hardware ranges, refreshed from each inquiry's config word. */
    imuRanges: StreamingImuRanges;
    /** When false, inertial channels are emitted raw-only (no `'cal'` field). Default true. */
    emitCalibratedInertial: boolean;
    private _imuFamily;
    private _deviceCalibrations;
    /** Minimum valid GSR conductance in µS (below this, connectivity = "Disconnected"). */
    readonly LIMIT_MIN_VALID_USIEMENS = 0.03;
    onInquiry: ((info: Shimmer3InquiryResult) => void) | null;
    onExpPowerChanged: ((expPower: number) => void) | null;
    constructor(opts?: Shimmer3ClientOptions);
    protected _log(...args: unknown[]): void;
    /** Best-effort label for `ObjectCluster`s and status messages. */
    private _deviceLabel;
    /** The streaming timestamp width currently in effect. */
    get timestampFmt(): TimestampFmt;
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
    connect(transport?: ShimmerTransport): Promise<void>;
    private _handshake;
    disconnect(): Promise<void>;
    /** Handle an unexpected transport disconnect (the link dropped under us). */
    private _handleTransportDisconnect;
    private _handleNotify;
    /**
     * Extract every complete control message currently buffered and dispatch each
     * to the temp handlers, then keep the incomplete tail for the next chunk. This
     * is what makes the unframed RFCOMM stream behave like framed BLE for the
     * ACK/response machinery below.
     */
    private _drainControl;
    /**
     * Gate the head byte before framing is attempted.
     *
     * Three bytes are only control traffic in the right context, and framing one
     * out of context would swallow the real control bytes behind it:
     *
     * - DATA_PACKET (0x00) while a stream is (about to be) live belongs to the
     *   stream parser — stop and leave it buffered.
     * - INQUIRY_RESPONSE (0x02) with no inquiry outstanding is a stray/stream
     *   byte; framing it would consume `9 + numChannels` bytes of garbage.
     * - NACK (0xFE) with no command outstanding is likewise dropped. This diverges
     *   from the Java driver (ShimmerObject processes every 0xFE unconditionally)
     *   but strictly reduces the risk of a leaked stream byte being read as a NACK.
     *   Defence-in-depth: `_onTemp` handlers are only added while `_awaitCmd > 0`,
     *   so an ungated stray 0xFE would emit to no listener anyway — this keeps that
     *   invariant explicit and survives refactors that add a longer-lived listener.
     */
    private _inspectControlHead;
    getEnabledSensors(): number;
    getInternalExpPower(): number;
    /**
     * Enable sensors via a 24-bit bitmask (SET_SENSORS_COMMAND). Automatically
     * re-inquires after the ACK to rebuild the stream schema, matching
     * {@link Shimmer3RClient.setSensors}.
     */
    setSensors(sensors: number): Promise<{
        sensors: number;
        enabledSensors: number;
    }>;
    /**
     * Set the sampling rate (SET_SAMPLING_RATE_COMMAND). The firmware takes a
     * 16-bit divisor `floor(32768 / rateHz)`; identical to Shimmer3R.
     */
    setSamplingRate(rateHz: number): Promise<{
        requestedHz: number;
        appliedHz: number;
        divisor: number;
    }>;
    /**
     * Set the GSR measurement range (SET_GSR_RANGE_COMMAND).
     * @param gsrRange 0 = 8–63 kΩ, 1 = 63–220 kΩ, 2 = 220–680 kΩ, 3 = 680–4700 kΩ, 4 = Auto.
     */
    setGSRRange(gsrRange: number): Promise<{
        gsrRange: number;
    }>;
    /**
     * Control the internal expansion power rail (required for ExG/EMG/ECG).
     * @param expPower 0 = disable, 1 = enable.
     */
    setInternalExpPower(expPower: 0 | 1): Promise<{
        expPower: number;
    }>;
    /**
     * Assert this device's firmware has the live ExG GET/SET commands, so an ExG
     * call on firmware without them fails immediately instead of hanging until the
     * response timeout. Applies the Java gate via {@link shimmer3SupportsExg}
     * (ShimmerBluetooth.java:4015,4026,4205,4223), which derives the firmware
     * version code from the parsed FW version plus the hardware id exactly as
     * ShimmerVerObject does. Old BtStream (code 1, or code 2 below internal 8) is
     * rejected up front.
     *
     * @throws Error when not connected, before the connect handshake has learned
     *   the versions, or on firmware without the ExG command set.
     */
    private _assertExgSupported;
    /**
     * Read both ExG chips' 10-byte register banks (GET_EXG_REGS ×2 →
     * EXG_REGS_RESPONSE decode). Ported from
     * ShimmerBluetooth.readEXGConfigurations (:4014-4018): CHIP1 then CHIP2.
     *
     * @throws Error when the firmware lacks ExG support, when not connected, or
     *   while streaming (the control plane belongs to the stream parser then).
     */
    readExgConfig(timeoutMs?: 2000): Promise<{
        exg1: Uint8Array;
        exg2: Uint8Array;
    }>;
    private _readExgChip;
    /**
     * Write both ExG chips' 10-byte register banks (SET_EXG_REGS ×2), then read
     * them back and verify. The banks go out verbatim — the oversampling-ratio
     * injection is Shimmer3R-only.
     *
     * WRITE-SAFETY DEVIATION FROM JAVA: Java applies SET_EXG_REGS immediately and
     * does not verify, relying on a timeout→disconnect failsafe
     * (ShimmerBluetooth.java:4212-4216). The safer flow is ported instead: SET →
     * await ACK → GET read-back → compare, ignoring only the read-only REG8 status
     * byte → throw on mismatch.
     *
     * @throws Error when unsupported, not connected, streaming, or on a mismatch.
     * @throws RangeError when either bank is not exactly 10 bytes.
     */
    writeExgConfig(exg1: Uint8Array, exg2: Uint8Array): Promise<void>;
    /**
     * Apply an ExG preset live: derive the register banks and the enabled-sensors
     * bitmap from the current inquiry state via the codec's `applyExgPreset`, write
     * the registers, then set the enabled sensors LAST — the desktop flow marks
     * `writeEnabledSensors(...)` "this should always be the last command"
     * (ShimmerBluetooth.java:2732,2735) and runs `writeEXGConfiguration()` earlier
     * (:2670).
     *
     * The device's own hardware version is passed through, so the joined-clock bit
     * follows `ShimmerVerObject.isSupportedExgChipClocksJoined` (:712-723) rather
     * than being forced on: a classic Shimmer3 keeps whatever bit it already had
     * (its unified-ExG board revision is not knowable from the hardware id), while
     * a Shimmer3R always gets it set.
     */
    applyExgPresetLive(preset: ApplicableExgPreset, resolution: ExgResolution): Promise<void>;
    /**
     * Send INQUIRY_COMMAND and parse the (Shimmer3-layout) response, building the
     * stream schema. Tolerant of an optional leading ACK before the response.
     */
    inquiry(): Promise<Shimmer3InquiryResult>;
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
    setRebootOnDisconnect(enabled: boolean): Promise<void>;
    /**
     * Read from the daughter-card EEPROM memory. `offset` is a HOST offset —
     * firmware maps it past the first (HW details) EEPROM page, so host offsets
     * 0..2031 cover absolute EEPROM bytes 16..2047.
     */
    readDaughterCardMem(offset: number, length: number): Promise<Uint8Array>;
    /**
     * Read the device configuration memory (InfoMem) via GET_INFOMEM_COMMAND.
     *
     * `address` is a **wire** address, not an index into the 384-byte InfoMem
     * image: older firmware addresses the D/C/B pages at 0x1800/0x1880/0x1900
     * while newer firmware and all Shimmer3Rs use a flat 0/128/256. Use
     * {@link resolveInfoMemLayout} to pick the right page base for the connected
     * device — {@link getMacAddress} shows the pattern. Max 128 bytes per read
     * (one page), which the firmware enforces too.
     */
    readInfoMem(address: number, length: number): Promise<Uint8Array>;
    /**
     * Read the device's Bluetooth MAC as a 12-char uppercase hex string.
     *
     * The MAC lives in InfoMem rather than behind a command of its own, so this
     * resolves the layout for the connected device first: `idxMacAddress` (224) is
     * an index into the InfoMem image, which only equals the wire address on
     * firmware that uses flat page addressing. Older firmware needs the C-page
     * base instead, hence the page/offset split below.
     *
     * Requires a completed {@link connect} handshake — the layout depends on the
     * hardware and firmware version it reads.
     */
    getMacAddress(): Promise<string>;
    /**
     * Write to the daughter-card EEPROM memory. `offset` is a HOST offset (see
     * {@link readDaughterCardMem}). Max 128 bytes per write.
     */
    writeDaughterCardMem(offset: number, data: Uint8Array): Promise<void>;
    startStreaming(): Promise<void>;
    stopStreaming(): Promise<void>;
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
    private _drainQuiescent;
    private _parseStream;
    /** Inline GSR calibration, matching Shimmer3RClient. */
    private _calibrateData;
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
    readCalibration(timeoutMs?: 2000): Promise<InertialGroup[]>;
    private _write;
    private _writeExpectingAck;
    /** Resolve on the next ACK control message; reject on NACK or timeout. */
    private _waitForAck;
    /**
     * Resolve on the next control message whose opcode matches `expectedOpcode`.
     * Leading ACKs are ignored (classic firmware may or may not ACK-prefix a
     * response); a NACK rejects.
     */
    private _waitForResponse;
    private _onTemp;
    private _offTemp;
    private _emitTemp;
}

interface WiredShimmerClientOptions extends ShimmerClientOptions {
    /**
     * The dock UART byte pipe (a `ShimmerTransport` over the dock's FTDI serial
     * port). **Required** — a docked Shimmer is only reachable over this wired
     * link, so unlike the BLE clients this one never builds a default transport;
     * `connect()` without one throws. The transport should report
     * `capabilities.framed = false` (serial is an unframed byte stream). See
     * `UART_DOCK_BAUD_RATE` (115200 8N1) for how to configure the port.
     */
    transport?: ShimmerTransport;
}
/** Result of {@link WiredShimmerClient.identify}. */
interface WiredIdentity {
    /** 12-char UPPERCASE hex MAC, in device byte order. */
    mac: string;
    /** Hardware version (from the VER response). */
    hardwareVersion: number;
    /** Full firmware/hardware version info. */
    firmwareVersion: WiredVersionInfo;
    /** Daughter-card / expansion board, or null when none is fitted. */
    expansionBoard: ExpansionBoardInfo | null;
}
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
declare class WiredShimmerClient extends BaseShimmerClient {
    private _injectedTransport;
    private _transport;
    private _notifyUnsub;
    private _disconnectUnsub;
    private _rxBuf;
    private _temps;
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
    private _queue;
    /**
     * The in-flight factory-test capture, or null when none is running. Non-null
     * for the whole time the report owns the link — including the drain after a
     * cancelled or timed-out run, because the firmware has no abort command and
     * keeps printing regardless.
     */
    private _factoryTest;
    /**
     * Invoked whenever {@link factoryTestState} changes, synchronously. A host
     * uses it to hold its own "the link is busy" gate through the whole run,
     * including the `draining` phase when the sensor is still printing.
     */
    onFactoryTestStateChange: ((state: FactoryTestState) => void) | null;
    identity: WiredIdentity | null;
    constructor(opts?: WiredShimmerClientOptions);
    protected _log(...args: unknown[]): void;
    private _deviceLabel;
    /**
     * Open the dock UART connection. A transport is REQUIRED (constructor option
     * or this parameter). Mirrors `BasicDock#setupDock` (open port); the identify
     * / status reads are exposed as explicit methods rather than run implicitly,
     * so callers control ordering (the Java auto-read order is preserved in
     * {@link identify}).
     */
    connect(transport?: ShimmerTransport): Promise<void>;
    disconnect(): Promise<void>;
    /** Handle an unexpected transport disconnect (the dock UART went away). */
    private _handleTransportDisconnect;
    /**
     * Discard any buffered inbound bytes, resyncing the byte stream. Used by
     * {@link SmartDockClient} after a SmartDock slot change: switching the active
     * slot re-routes the per-Shimmer UART to a different device, so any bytes left
     * over from the previous slot must be dropped before the next request. (The
     * `_drain` parser is already tolerant of leading garbage / bad CRC, so this is
     * belt-and-braces rather than strictly required.)
     */
    resyncStream(): void;
    /**
     * What the factory-test runner is doing: `idle` when the link is free,
     * `running` while a report is being captured, `draining` while a cancelled or
     * timed-out report is still being swallowed.
     */
    get factoryTestState(): FactoryTestState;
    /**
     * Resolve when the link is free again. Never rejects — a failed run still
     * releases the link, and this is the wait a host needs after cancelling one.
     */
    whenFactoryTestIdle(): Promise<void>;
    /**
     * Run the docked sensor's factory self-test and return its report.
     *
     * The dock protocol addresses the test as a WRITE to `UART_COMPONENT.TEST`
     * whose PROPERTY byte is the test type, with no payload
     * (`Comms/shimmer_dock_usart.c:473-486`). The firmware ACKs it and then prints
     * the same report the Bluetooth command produces — as raw text on this link,
     * with no packet framing and no CRC. A type the firmware does not know is
     * answered BAD_CMD, which surfaces here as a `nack`.
     *
     * On a Shimmer3R the report goes to the USB CDC port when the sensor is
     * plugged in by USB and to the dock UART otherwise (`hal_FactoryTest.c`), so
     * this one method serves a docked sensor and a USB-C-connected one alike.
     *
     * Two caveats worth passing on to whoever reads the report:
     * - The whole run holds this client's command queue. Nothing else reaches the
     *   sensor until the report ends — which is the truth about the firmware, not
     *   a limitation here: its main loop is blocked for the duration.
     * - **The ExG chip test cannot pass from the dock.** Shimmer3 firmware prints
     *   `- FAIL: ADS1292R test will not work from dock` because the dock UART and
     *   that chip share pins. A FAIL on that line from this transport says nothing
     *   about the board; run the test over Bluetooth to judge it.
     *
     * @param type 0 MAIN, 1 LEDS, 2 ICS, 3 LED_STATES (`Test/shimmer_test.h:21-27`).
     * @param opts see {@link FactoryTestRunOptions}; `timeoutMs` defaults to the
     *   type's own entry in `SHIMMER3_FACTORY_TEST_TYPES`. `preflight` is ignored:
     *   the dock protocol has no equivalent status read.
     * @returns the report text, CRLF line endings intact.
     *
     * HARDWARE-VERIFY: no docked Shimmer3 or USB-C Shimmer3R has run this path.
     */
    runFactoryTest(type: number, opts?: FactoryTestRunOptions): Promise<string>;
    private _runFactoryTestImpl;
    /**
     * Let go of the link at the end of a run: clear the capture, then drop
     * anything the report left in the accumulator. Called from the capture's own
     * `idle` transition, so it happens before the tail bytes it hands back are
     * routed through the packet parser.
     */
    private _releaseFactoryTest;
    /**
     * Abandon an in-flight capture because the link has gone. No drain: draining
     * exists to keep a still-arriving report out of the packet parser, and nothing
     * is arriving on a link that is closed.
     */
    private _failFactoryTest;
    /** Streaming is not part of the dock UART protocol. */
    startStreaming(): Promise<void>;
    stopStreaming(): Promise<void>;
    /**
     * Read the docked device's identity. Follows the order of
     * `BasicDock#internalReadShimmerDetails` (MAC → HW/FW version → daughter-card
     * ID). Battery is read separately via {@link getStatus}. The three reads run
     * as one atomic serialized unit (see {@link _serialize}).
     */
    identify(): Promise<WiredIdentity>;
    private _identifyImpl;
    /** Read battery voltage / % / charging state (BAT.VALUE). */
    getStatus(): Promise<WiredBatteryStatus>;
    private _getStatusImpl;
    /**
     * Read the MAC address (MAIN_PROCESSOR.MAC), retrying a total of
     * `WIRED_DEFAULTS.MAC_READ_RETRIES` (= 2) attempts as the Java dock does
     * (`AbstractDock.readMacId`, AbstractDock.java:1153 `for(i=0;i<
     * READ_MAC_RETRY_ATTEMPTS;i++)` → 2 total attempts).
     */
    readMac(): Promise<string>;
    private _readMacImpl;
    /** Read the HW/FW version (MAIN_PROCESSOR.VER). */
    readVersion(): Promise<WiredVersionInfo>;
    private _readVersionImpl;
    /**
     * Read the daughter-card (expansion board) ID — the first 16 bytes of the
     * card memory (`DAUGHTER_CARD.CARD_ID`, address 0). Returns null when no board
     * is fitted. Cheap enough to include in {@link identify}.
     */
    readExpansionBoard(): Promise<ExpansionBoardInfo | null>;
    private _readExpansionBoardImpl;
    /**
     * Read from the daughter-card EEPROM memory (`DAUGHTER_CARD.CARD_MEM`).
     * `address` is a HOST offset — firmware maps it past the first (HW details)
     * EEPROM page, so host offsets 0..2031 cover absolute EEPROM bytes 16..2047.
     */
    readDaughterCardMem(address: number, size: number): Promise<Uint8Array>;
    /**
     * Write to the daughter-card EEPROM memory (`DAUGHTER_CARD.CARD_MEM`).
     * `address` is a HOST offset (see {@link readDaughterCardMem}).
     */
    writeDaughterCardMem(address: number, data: Uint8Array): Promise<void>;
    /** Read one config property's raw payload (READ). */
    getConfig(arg: UartComponentProperty): Promise<Uint8Array>;
    /** Write one config property (WRITE), resolving on ACK. */
    setConfig(arg: UartComponentProperty, value: Uint8Array): Promise<void>;
    /**
     * Read every property in `UART_CONFIG_COMMANDS` (the Java
     * `mListOfUartCommandsConfig` order). Individual reads that error (e.g. a
     * property the docked firmware does not implement) are captured rather than
     * aborting the batch — the returned map's value is the raw payload or the
     * Error for that property.
     */
    getConfigAll(): Promise<Map<UartComponentProperty, Uint8Array | Error>>;
    private _getConfigAllImpl;
    /**
     * Raw InfoMem read (`MAIN_PROCESSOR.INFOMEM`). Returns `size` bytes from
     * `address`. The InfoMem *layout* is deliberately NOT interpreted in D1 — this
     * is a byte-level escape hatch.
     */
    readInfoMem(address: number, size: number): Promise<Uint8Array>;
    /** Raw InfoMem write (`MAIN_PROCESSOR.INFOMEM`), resolving on ACK. */
    writeInfoMem(address: number, data: Uint8Array): Promise<void>;
    /**
     * Read the full {@link INFOMEM_SIZE}-byte InfoMem in 128-byte page chunks
     * (D → C → B), reassembled in order. The page addresses sent depend on the
     * firmware/hardware (legacy MSP430 0x1800/… vs. flat 0/128/256), resolved
     * from the cached {@link identity} — call {@link identify} (or
     * {@link readVersion}) first.
     */
    readInfoMemBytes(): Promise<Uint8Array>;
    /**
     * Write the full {@link INFOMEM_SIZE}-byte InfoMem in 128-byte page chunks,
     * each resolving on its per-chunk ACK (the write guarantee is per-chunk
     * CRC + ACK). Requires a cached {@link identity} for the page addressing.
     */
    writeInfoMemBytes(bytes: Uint8Array): Promise<void>;
    /**
     * Read + decode the docked device's configuration. Uses the cached
     * {@link identity} (already-read version info) as the {@link InfoMemContext}.
     */
    readInfoMemConfig(): Promise<InfoMemDeviceConfig>;
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
    writeRtcFromHostTime(nowMs?: number): Promise<void>;
    /** Non-serialized RTC write — callers must already hold the queue. */
    private _writeRtcFromHostTimeImpl;
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
    writeInfoMemConfig(config: InfoMemDeviceConfig, opts?: {
        verify?: boolean;
        setRtc?: boolean;
    }): Promise<{
        verified: boolean | null;
    }>;
    /** Build the InfoMem layout context from the cached identity (requires identify/readVersion). */
    private _infoMemCtx;
    /** Non-serialized chunked read (D/C/B pages) — callers must already hold the queue. */
    private _readInfoMemBytesImpl;
    /** Non-serialized chunked write (D/C/B pages) — callers must already hold the queue. */
    private _writeInfoMemBytesImpl;
    /**
     * Run `fn` after every previously-queued operation has settled, so all public
     * command methods execute strictly one-at-a-time (see {@link _queue}). The
     * queue itself never rejects — a failed op does not poison later ones — while
     * the caller still receives `fn`'s own resolution/rejection.
     */
    private _serialize;
    /** Send a READ and await the matching DATA_RESPONSE payload. */
    private _read;
    /** Send a memory READ and await the matching DATA_RESPONSE payload. */
    private _readMem;
    /** Send a WRITE with a value and await ACK. */
    private _write;
    /** Send a WRITE with a pre-built payload (e.g. mem write) and await ACK. */
    private _writeRaw;
    /** Resolve with the payload of a DATA_RESPONSE matching comp+prop; reject on bad/timeout. */
    private _waitForDataResponse;
    /** Resolve on the next ACK; reject on bad response or timeout. */
    private _waitForAck;
    private _handleNotify;
    /**
     * Extract every complete packet currently buffered and dispatch each to the
     * temp handlers, keeping the incomplete tail for the next chunk.
     *
     * Runs on the shared {@link drainByteStream} loop, decoding straight to
     * {@link UartRxPacket} so the temp handlers receive parsed packets. A packet
     * that frames but fails its CRC (or will not parse) is refused, and the drain
     * resyncs by ONE byte rather than skipping the whole supposed length —
     * matching the Java `parseSinglePacket` CRC-fail path, on the reasoning that a
     * bad CRC means the framing itself was probably wrong.
     */
    private _drain;
    private _onTemp;
    private _offTemp;
    private _emitTemp;
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
declare const SHIMMER_UART_CRC_INIT = 45258;
/**
 * Fold a single byte into the running CRC.
 * Ported from `ShimmerCrc.shimmerUartCrcByte` (ShimmerCrc.java:12-21).
 *
 * NB: only the first and last lines mask to 0xFFFF, exactly as in Java — the
 * intermediate byte-swap / shift / XOR steps run on the full 32-bit word. Adding
 * intermediate masks changes the result, so do not "tidy" this.
 */
declare function shimmerUartCrcByte(crc: number, b: number): number;
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
declare function shimmerUartCrcCalc(msg: Uint8Array, len?: number): [number, number];
/**
 * Validate a full packet whose last two bytes are the CRC (LSB then MSB).
 * Recomputes over `msg[0 .. length-2)` and compares, matching
 * `ShimmerCrc.shimmerUartCrcCheck` (ShimmerCrc.java:52-60).
 */
declare function shimmerUartCrcCheck(msg: Uint8Array): boolean;

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
declare const SMARTDOCK_LINE_TERMINATOR = "\r\n";
/**
 * SmartDock connection type for a slot select (SmartDockActiveSlotDetails.java:13-15).
 * D2 is read-only and only ever uses `WITHOUT_SD_CARD` (partial connect, enough
 * to read the docked Shimmer over the per-Shimmer UART); `WITH_SD_CARD` (full
 * connect for mass-storage) is defined for completeness but NOT driven.
 */
declare const SMARTDOCK_CONNECTION_TYPE: Readonly<{
    readonly DISCONNECTED: 0;
    readonly WITH_SD_CARD: 1;
    readonly WITHOUT_SD_CARD: 2;
}>;
type SmartDockConnectionType = (typeof SMARTDOCK_CONNECTION_TYPE)[keyof typeof SMARTDOCK_CONNECTION_TYPE];
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
declare const SMARTDOCK_BASE_CMD: Readonly<{
    /** `SDV$` → version info. */
    readonly GET_VERSION: "SDV$";
    /** `SDQ$` → per-slot occupancy bitmap. */
    readonly QUERY_CONNECTED_SLOTS: "SDQ$";
    /** `SDP$` → current active slot (without-SD form). */
    readonly GET_ACTIVE_SLOT: "SDP$";
    /** `SDP` prefix → set active slot WITHOUT SD access (append `,NN$`). */
    readonly SET_SLOT_WITHOUT_SD: "SDP";
    /** `SDC` prefix → set active slot WITH SD access (append `,NN$`). Not driven in D2. */
    readonly SET_SLOT_WITH_SD: "SDC";
    /** `SDD$` → disconnect all slots. */
    readonly DISCONNECT_ALL: "SDD$";
}>;
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
declare const SMARTDOCK_DEFAULTS: Readonly<{
    RESPONSE_TIMEOUT_MS: 1000;
    SLOT_CHANGE_TIMEOUT_MS: 10000;
    SLOT_CHANGEOVER_DELAY_MS: 1500;
    CMD_RETRY_ATTEMPTS: 2;
}>;
/**
 * Base hardware IDs from the version response's hardware-version field
 * (HwDriverShimmerDeviceDetails.java:248-250 `BASE_HARDWARE_IDS`).
 */
declare const BASE_HARDWARE_IDS: Readonly<{
    readonly BASE15U: 1;
    readonly BASE6U: 2;
}>;
/** The SmartDock family a base belongs to (derived from its hardware-version). */
type SmartDockHardwareType = 'base6' | 'base15' | 'basic' | 'unknown';
/**
 * Map a base hardware-version byte to a family + slot count
 * (HwDriverShimmerDeviceDetails.java:313-321: BASE15→15 slots, BASE6→6 slots,
 * BASICDOCK→1). NB: in the Java driver the slot count actually comes from the
 * USB device descriptor, not the version byte — see the SmartDock README
 * hardware-verify note.
 */
declare function baseHardwareType(hardwareVersion: number): {
    hardwareType: SmartDockHardwareType;
    slotCount: number;
};
/** Encode a base ASCII command string to bytes (UTF-8 == ASCII for this set). */
declare function buildBaseCommand(cmd: string): Uint8Array;
/**
 * Build a slot-select command: `SDP,NN$` (without SD) or `SDC,NN$` (with SD),
 * or `SDD$` (disconnect all). Slot is formatted `%02d`
 * (SmartDockUart.java:194-231). Slot values 1..15 (1-based, matching the UI /
 * the Java `SmartDockActiveSlotDetails.mSlot`).
 */
declare function buildSelectSlotCommand(slot: number, connectionType: SmartDockConnectionType): Uint8Array;
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
declare function extractBaseLine(buf: Uint8Array): {
    line: string;
    rest: Uint8Array;
} | null;
/** The kinds of base response line we recognise. */
type SmartDockResponseKind = 'version' | 'occupancy' | 'slotWithoutSd' | 'slotWithSd' | 'disconnected' | 'error' | 'boot' | 'unknown';
/** Parsed SmartDock HW/FW version (SmartDockVerInfoDetails.java). */
interface SmartDockVersionInfo {
    hardwareVersion: number;
    firmwareIdentifier: number;
    firmwareVersionMajor: number;
    firmwareVersionMinor: number;
    firmwareVersionInternal: number;
}
/** Parsed active-slot response (SmartDockActiveSlotDetails). */
interface SmartDockActiveSlot {
    /** 1-based slot number, or -1 when disconnected. */
    slot: number;
    connectionType: SmartDockConnectionType;
}
/**
 * Classify a base response line by its leading character
 * (SmartDockUartListener.java:71-296). Used to route a line to the awaiting
 * operation and to discard unrelated / garbage lines (resync discipline).
 */
declare function classifyBaseResponse(line: string): SmartDockResponseKind;
/**
 * Parse a `V,<hw>,<fwId>,<major>,<minor>,<internal>` version line
 * (SmartDockUart.java:796-806). Returns null when malformed (wrong prefix or not
 * exactly 5 comma-separated integers after `V,`).
 */
declare function parseSmartDockVersion(line: string): SmartDockVersionInfo | null;
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
declare function parseSlotOccupancy(line: string): boolean[] | null;
/**
 * Parse an active-slot response line into slot + connection type
 * (SmartDockUart.java:810-869):
 * - `P,NN` → WITHOUT_SD, slot NN
 * - `C,NN` → WITH_SD, slot NN
 * - `C` / `D` → DISCONNECTED, slot -1
 * Returns null when the numeric slot is malformed.
 */
declare function parseActiveSlot(line: string): SmartDockActiveSlot | null;

interface SmartDockClientOptions extends ShimmerClientOptions {
    /**
     * The SmartDock **base control** UART (a `ShimmerTransport` over the base's
     * FTDI serial port carrying the ASCII `SDx$` command channel). **Required** —
     * a SmartDock is only reachable over this wired link, so `connect()` throws
     * without one. The transport should report `capabilities.framed = false`
     * (serial is an unframed byte stream); configure the port per
     * `UART_DOCK_BAUD_RATE` (115200 8N1).
     */
    transport?: ShimmerTransport;
    /**
     * The **per-Shimmer** UART channel (a *separate* FTDI serial port on the
     * SmartDock, onto which the base routes whichever slot is active). Required
     * only for {@link SmartDockClient.identifyDockedShimmer} /
     * {@link SmartDockClient.getDockedShimmerStatus}, which drive the D1
     * `WiredShimmerClient` against the active slot. In the Java driver these are
     * two distinct COM ports (SmartDock.java:226-229). Omit it if you only need
     * dock info / occupancy / slot selection.
     */
    shimmerTransport?: ShimmerTransport;
    /** Timeout overrides (defaults ported from Java; see {@link SMARTDOCK_DEFAULTS}). */
    timeouts?: Partial<{
        /** Normal base-command reply timeout (ms). Default 1000. */
        responseTimeoutMs: number;
        /** Slot-change confirmation timeout (ms). Default 10000. */
        slotChangeTimeoutMs: number;
        /** Post-slot-change settle delay (ms). Default 1500. */
        slotChangeoverDelayMs: number;
    }>;
}
/** Result of {@link SmartDockClient.getDockInfo}. */
interface SmartDockInfo {
    /** Base family derived from the version response's hardware-version field. */
    hardwareType: SmartDockHardwareType;
    /** Full parsed HW/FW version. */
    firmwareVersion: SmartDockVersionInfo;
    /**
     * Number of slots. Derived from `hardwareType` (base6→6, base15→15). 0 when
     * the hardware version is unrecognised — call {@link SmartDockClient.getSlotOccupancy}
     * to discover the count from the wire in that case.
     */
    slotCount: number;
}
/** One slot's occupancy. */
interface SlotOccupancy {
    /** 1-based slot number. */
    slot: number;
    /** True when a Shimmer is docked in this slot. */
    occupied: boolean;
}
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
declare class SmartDockClient extends BaseShimmerClient {
    private _injectedTransport;
    private _transport;
    private _notifyUnsub;
    private _disconnectUnsub;
    private _rxBuf;
    private _temps;
    /**
     * Serialization queue: all public operations chain onto this so slot
     * select + per-slot reads run as atomic, non-interleaved units. Concurrent
     * `selectSlot` / `identifyDockedShimmer` / `getDockedShimmerStatus` otherwise
     * race on the shared {@link activeSlot} and single {@link _wired} client,
     * mis-attributing one slot's data to another. See {@link _serialize}.
     */
    private _queue;
    private _shimmerTransport;
    private _wired;
    private _wiredConnected;
    private readonly _responseTimeoutMs;
    private readonly _slotChangeTimeoutMs;
    private readonly _slotChangeoverDelayMs;
    /** Cached dock info (from the last {@link getDockInfo}). */
    dockInfo: SmartDockInfo | null;
    /** The last active slot confirmed by {@link selectSlot} (1-based; -1 when disconnected). */
    activeSlot: number;
    constructor(opts?: SmartDockClientOptions);
    protected _log(...args: unknown[]): void;
    private _deviceLabel;
    /**
     * Open the SmartDock base UART connection. A base transport is REQUIRED
     * (constructor option or this parameter). The per-Shimmer transport (if
     * supplied) is opened lazily on the first docked-Shimmer op.
     */
    connect(transport?: ShimmerTransport): Promise<void>;
    disconnect(): Promise<void>;
    private _handleTransportDisconnect;
    /** Streaming is not part of the SmartDock protocol. */
    startStreaming(): Promise<void>;
    stopStreaming(): Promise<void>;
    /**
     * Read the base HW/FW version and derive its family + slot count. Sends
     * `SDV$` and parses the `V,<hw>,<fwId>,<major>,<minor>,<internal>` reply
     * (SmartDockUart.java:148-157, :796-806).
     */
    getDockInfo(): Promise<SmartDockInfo>;
    private _getDockInfoImpl;
    /**
     * Query which slots are occupied. Sends `SDQ$` and parses the
     * `Q,<map>` bitmap (one ASCII `0`/`1` per slot) into per-slot occupancy
     * (SmartDockUart.java:162-171, SmartDockUartListener.java:140-181). The number
     * of entries is the base's slot count as reported on the wire.
     */
    getSlotOccupancy(): Promise<SlotOccupancy[]>;
    private _getSlotOccupancyImpl;
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
    selectSlot(slotNumber: number): Promise<void>;
    /** Disconnect all slots (`SDD$`); no slot is active afterwards. */
    disconnectAllSlots(): Promise<void>;
    private _disconnectAllSlotsImpl;
    private _selectSlotInternal;
    /**
     * Select `slotNumber`, then read the docked Shimmer's identity by delegating
     * to the D1 {@link WiredShimmerClient.identify} over the per-Shimmer UART. The
     * per-Shimmer protocol (MAC/HW/FW/expansion) is NOT re-implemented here.
     */
    identifyDockedShimmer(slotNumber: number): Promise<WiredIdentity>;
    /**
     * Select `slotNumber`, then read the docked Shimmer's battery/charging status
     * by delegating to the D1 {@link WiredShimmerClient.getStatus}.
     */
    getDockedShimmerStatus(slotNumber: number): Promise<WiredBatteryStatus>;
    /**
     * Select `slotNumber`, then read + decode the docked Shimmer's InfoMem
     * configuration (configure-while-docked, phase P2). Slot-select and the
     * per-Shimmer identify + InfoMem read run as one atomic unit under this
     * client's queue, so concurrent calls for different slots cannot interleave.
     * The docked device is (re)identified after the slot change to resolve the
     * correct InfoMem byte layout for that slot.
     */
    readInfoMemConfig(slotNumber: number): Promise<InfoMemDeviceConfig>;
    /**
     * Select `slotNumber`, then encode + write a configuration to the docked
     * Shimmer's InfoMem, atomically. See
     * {@link WiredShimmerClient.writeInfoMemConfig} for the device-write, RTC
     * (`opts.setRtc`, default true) and verify semantics.
     */
    writeInfoMemConfig(slotNumber: number, config: InfoMemDeviceConfig, opts?: {
        verify?: boolean;
        setRtc?: boolean;
    }): Promise<{
        verified: boolean | null;
    }>;
    /** Lazily build + connect the composed D1 client over the per-Shimmer transport. */
    private _ensureWired;
    /** Send an ASCII base command and await a response of one of `kinds`. */
    private _command;
    /**
     * Write `cmdBytes` and await a matching response, re-sending the command on a
     * missed reply for a total of `SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS` (= 2)
     * attempts before failing — mirroring SmartDockUart.java:526-537
     * (`txBytesAndWaitForReply`). Retries on TIMEOUT ONLY; an explicit `E` error
     * response ({@link SmartDockTimeoutError} is not thrown for it) propagates
     * immediately, matching the Java path where `waitForSmartDockResponse` throws
     * on an error instead of returning false.
     */
    private _sendWithRetry;
    /**
     * Resolve with the first response line whose classification is in `kinds`;
     * reject on an `E` error line or timeout. Lines of any other kind (including
     * `unknown`/garbage) are ignored — this is the resync discipline.
     */
    private _waitForResponse;
    private _delay;
    /**
     * Run `fn` after every previously-queued operation has settled, so all public
     * operations execute strictly one-at-a-time (see {@link _queue}). The queue
     * never rejects — a failed op does not poison later ones — while the caller
     * still receives `fn`'s own resolution/rejection.
     */
    private _serialize;
    private _handleNotify;
    private _drain;
    private _onTemp;
    private _offTemp;
    private _emitTemp;
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
declare const SDLOG_HW_ID: Readonly<{
    readonly SHIMMER_3: 3;
    readonly SHIMMER_3R: 10;
}>;
/** Firmware identifiers (ShimmerVerDetails.FW_ID). */
declare const SDLOG_FW_ID: Readonly<{
    readonly BTSTREAM: 1;
    readonly SDLOG: 2;
    readonly LOGANDSTREAM: 3;
    readonly GQ_BLE: 5;
    readonly GQ_802154: 9;
    readonly STROKARE: 15;
}>;
/** SD-log header lengths in bytes, keyed by generation. */
declare const SDLOG_HEADER_LENGTH: Readonly<{
    /** SDLog v0.5.x (unsupported — rejected with LEGACY_UNSUPPORTED). */
    readonly LEGACY: 178;
    /** Modern Shimmer3 (SDLog >= 0.8.69, LogAndStream >= 0.5.0). */
    readonly SHIMMER3: 256;
    /** Shimmer3R. */
    readonly SHIMMER3R: 384;
}>;
/** The 32 kHz sampling/RTC clock frequency shared by Shimmer3 and Shimmer3R. */
declare const SDLOG_CLOCK_FREQ = 32768;
/**
 * Length in bytes of the sync timestamp-offset field prefixed to the first
 * sample of each 512-byte block when "sync when logging" is enabled
 * (ShimmerObject.OFFSET_LENGTH — always 9 for modern firmware; the 5-byte
 * variant only exists on legacy SDLog 0.5.x, which is out of scope).
 */
declare const SDLOG_SYNC_OFFSET_LENGTH = 9;
/** SD sector size used for the sync-when-logging block framing. */
declare const SDLOG_SYNC_BLOCK_LENGTH = 512;
/**
 * Enabled-sensor bitmasks as stored in SD-log header bytes 3-7 (40-bit,
 * LSB-first). Ported verbatim from ShimmerObject.SDLogHeader (values > 2^31
 * are plain numbers — always test them with {@link hasSensorBit}, never with
 * 32-bit bitwise operators).
 */
declare const SDLogHeaderBitmask: Readonly<{
    readonly ACCEL_LN: number;
    readonly GYRO: number;
    readonly MAG: number;
    readonly EXG1_24BIT: number;
    readonly EXG2_24BIT: number;
    readonly GSR: number;
    readonly EXT_EXP_A7: number;
    readonly EXT_EXP_A6: number;
    readonly BRIDGE_AMP: number;
    readonly ECG_TO_HR_FW: number;
    readonly BATTERY: number;
    readonly ACCEL_WR: number;
    readonly EXT_EXP_A15: number;
    readonly INT_EXP_A1: number;
    readonly INT_EXP_A12: number;
    readonly INT_EXP_A13: number;
    readonly INT_EXP_A14: number;
    readonly ACCEL_MPU: number;
    readonly MAG_MPU: number;
    readonly EXG1_16BIT: number;
    readonly EXG2_16BIT: number;
    readonly BMPX80: number;
    readonly MPL_TEMPERATURE: number;
    readonly MPL_QUAT_6DOF: number;
    readonly MPL_QUAT_9DOF: number;
    readonly MPL_EULER_6DOF: number;
    readonly MPL_EULER_9DOF: number;
    readonly MPL_HEADING: number;
    readonly MPL_PEDOMETER: number;
    readonly MPL_TAP: number;
    readonly MPL_MOTION_ORIENT: number;
    readonly GYRO_MPU_MPL: number;
    readonly ACCEL_MPU_MPL: number;
    readonly MAG_MPU_MPL: number;
    readonly MPL_QUAT_6DOF_RAW: number;
}>;
/**
 * Test a bit in the (up to 40-bit) enabled-sensors value. JavaScript bitwise
 * operators truncate to 32 bits, so masks >= 2^31 must be tested arithmetically.
 */
declare function hasSensorBit(enabledSensors: number, mask: number): boolean;

/**
 * Public types for the Shimmer3 / Shimmer3R binary SD-log decoder.
 */
/** One decoded channel within an SD-log data packet. */
interface SdLogChannel {
    /** Signal name, following the SDK's streaming channel naming where a streaming equivalent exists. */
    name: string;
    /** Unit of the emitted value, or null when the value is uncalibrated/raw. */
    unit: string | null;
    /** True when the SDK applies calibration to this channel's values. */
    calibrated: boolean;
}
/** Raw calibration parameter blocks copied verbatim from the SD-log header. */
interface SdLogCalibrationBytes {
    /** Wide-range (digital) accelerometer block — header offset 76, 21 bytes. */
    wrAccel: Uint8Array;
    /** Gyroscope block — header offset 97, 21 bytes. */
    gyro: Uint8Array;
    /** Magnetometer block — header offset 118, 21 bytes. */
    mag: Uint8Array;
    /** Low-noise (analog) accelerometer block — header offset 139, 21 bytes. */
    lnAccel: Uint8Array;
    /**
     * Pressure/temperature block — header offset 160, 22 bytes, plus header
     * bytes 222-223 appended (24 bytes total) when the device carries a
     * BMP280/BMP390 (new-IMU boards and every Shimmer3R).
     */
    pressure: Uint8Array;
    /** Shimmer3R alternative (high-g) accel block — header offset 256, 21 bytes. */
    altAccel?: Uint8Array;
    /** Shimmer3R alternative magnetometer block — header offset 285, 21 bytes. */
    altMag?: Uint8Array;
}
/** Expansion-board identity from SD-log header bytes 214-216 (when present). */
interface SdLogExpansionBoard {
    id: number;
    rev: number;
    revSpecial: number;
}
/** Parsed SD-log file header. */
interface SdLogHeader {
    hardwareVersion: number;
    firmwareId: number;
    firmwareVersion: {
        major: number;
        minor: number;
        internal: number;
    };
    samplingRateHz: number;
    macAddress: string;
    /** 40-bit enabled-sensors value (header bytes 3-7, after firmware-specific masking). */
    enabledSensors: number;
    /**
     * Derived-sensors value (header bytes 40-42, plus 217-221 on newer
     * firmware). Exact only through byte 219 / bit 47 — bytes 220-221 reach
     * bit 56, beyond a JS number's 2^53 exact-integer range. For full fidelity
     * above bit 52 use {@link derivedSensorsBig}.
     */
    derivedSensors: number;
    /**
     * Full-fidelity derived-sensors value as a BigInt (Java uses a `long`),
     * carrying all 8 bytes exactly. Prefer this when testing bits at or above
     * byte 220 (bit 56).
     */
    derivedSensorsBig: bigint;
    /**
     * TCXO (temperature-compensated crystal oscillator) flag — SD header
     * byte 17 bit 4. Affects only the wall-clock (RTC) tick→ms conversion.
     */
    tcxo: boolean;
    /** Config time — Unix seconds, header bytes 52-55 MSB-first. */
    configTime: number;
    /** RTC difference in 32.768 kHz ticks — header bytes 44-51, signed 64-bit MSB-first. */
    rtcDifferenceTicks: bigint;
    /** Initial timestamp in ticks — header bytes 251-255 (non-sequential packing). */
    initialTimestampTicks: number;
    trial: {
        id: number;
        numShimmers: number;
        syncWhenLogging: boolean;
        masterShimmer: boolean;
        buttonStart: boolean;
    };
    headerLengthBytes: number;
    timestampBytes: 2 | 3;
    /**
     * Bytes per data packet: timestamp + all enabled channels. The 9-byte sync
     * timestamp-offset field prefixed to the first packet of each 512-byte
     * block (when trial.syncWhenLogging is set) is NOT included — the decoder
     * strips it transparently.
     */
    packetSizeBytes: number;
    /** Decoded channel list, in on-disk packet order (timestamp excluded). */
    channels: SdLogChannel[];
    /** Raw calibration blocks from the header, kept for future calibrated decoding. */
    calibrationBytes: SdLogCalibrationBytes;
    /** GSR hardware range setting from the header (0-3 fixed, 4 = auto). */
    gsrRange: number;
    /**
     * Raw 10-byte ADS1292R chip-1 (ExG1) register bank, from SD header bytes
     * 56-65 (ShimmerSDLog.java:253 Shimmer3R, :323 Shimmer3). Decode it with
     * `decodeExgRegisters`, or identify the whole-device preset with
     * `detectExgPreset(exg1, exg2)`. All-zero on a non-ExG device.
     */
    exg1: Uint8Array;
    /** Raw 10-byte ADS1292R chip-2 (ExG2) register bank, from header bytes 66-75. */
    exg2: Uint8Array;
    /** Expansion-board identity, when the firmware stores it in the header. */
    expansionBoard: SdLogExpansionBoard | null;
    /**
     * Inertial-sensor hardware ranges decoded from the SD config setup bytes,
     * used to select the correct default calibration when the header carries no
     * per-device calibration block for a channel group. Values are the raw
     * config-value indices (see the per-sensor range tables in the Java driver).
     */
    imuRanges: SdLogImuRanges;
    /**
     * Per-group inertial calibration metadata, one entry per calibrated channel
     * group present in this file. Additive: absent groups (or non-inertial
     * files) yield an empty array.
     */
    calibration: SdLogChannelCalibrationInfo[];
}
/** Inertial-sensor hardware ranges from the SD config setup bytes. */
interface SdLogImuRanges {
    /** Low-noise (analog) accel range. Shimmer3 LN accel (Kionix) is fixed → 0. */
    lnAccel: number;
    /** Wide-range (digital) accel range. */
    wrAccel: number;
    /** Gyroscope range. */
    gyro: number;
    /** Magnetometer range (LSM303DLHC uses 1-7; single-range sensors use 0). */
    mag: number;
    /** Shimmer3R alternative (high-g) accel range. */
    altAccel: number;
    /** Shimmer3R alternative magnetometer range. */
    altMag: number;
}
/** Calibration metadata for one inertial channel group in an SD-log file. */
interface SdLogChannelCalibrationInfo {
    /** Channel group: lnAccel | wrAccel | gyro | mag | altAccel | altMag. */
    group: string;
    /** Emitted unit for the group's channels ('m/(s^2)' | 'deg/s' | 'local_flux'). */
    unit: string;
    /** True when the range-selected default was used (no valid device block). */
    usingDefaultCalibration: boolean;
    /** Where the applied calibration came from. */
    source: 'sd-header' | 'default';
    /** The hardware range value used to select the calibration. */
    range: number;
}
/** Machine-readable reasons for rejecting an SD-log input. */
type SdLogFormatErrorCode = 'LEGACY_UNSUPPORTED' | 'UNSUPPORTED_DEVICE' | 'NO_DATA' | 'TOO_SMALL' | 'BAD_HEADER' | 'INCONSISTENT_SESSION';
/** Typed error thrown by the SD-log parsing/decoding entry points. */
declare class SdLogFormatError extends Error {
    code: SdLogFormatErrorCode;
    constructor(code: SdLogFormatErrorCode, message: string);
}
/** One decoded sample. `values` aligns 1:1 with `SdLogHeader.channels`. */
interface SdLogRecord {
    /**
     * Device-clock time in milliseconds:
     * (initialTimestampTicks + unwrapped ticks - first packet's raw ticks)
     * / 32768 * 1000, exactly as the Java driver computes the SD calibrated
     * timestamp (parseTimestampShimmer3 with mFirstTsOffsetFromInitialTsTicks).
     * On modern firmware this equals the device's full 40-bit clock in ms.
     */
    timestampMs: number;
    /**
     * Wall-clock (RTC) time in Unix milliseconds — timestampMs shifted by the
     * header's rtcDifferenceTicks — or null when the RTC difference is unset (0).
     */
    wallClockMs: number | null;
    values: number[];
}

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

/** Raw encodings used by SD-log channels (subset of UtilParseData's set). */
type SdLogDataType = 'u8' | 'u12' | 'u14' | 'u16' | 'u16r' | 'i16' | 'i16r' | 'u24' | 'u24r' | 'i24r' | 'u32r' | 'i32r' | 'i12*>';
declare const SDLOG_DATA_TYPE_BYTES: Readonly<Record<SdLogDataType, number>>;
/** Internal channel descriptor: public shape plus the raw encoding. */
interface SdLogChannelSpec extends SdLogChannel {
    dataType: SdLogDataType;
    sizeBytes: number;
}
/**
 * Decode one channel value at `off` in `bytes`.
 *
 * Mirrors UtilParseData.parseData(byte[], String[]) exactly — including the
 * quirk that `u12`/`u14` are read as full unsigned 16-bit little-endian values
 * with no masking (the firmware guarantees the upper bits are zero).
 */
declare function decodeSdLogValue(bytes: Uint8Array, off: number, type: SdLogDataType): number;

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

/**
 * "New IMU sensors" detection for Shimmer3 (LSM303AHTR / MPU9250 / BMP280
 * generation) — controls mag channel order/endianness and BMP naming.
 * Port of ShimmerObject.isSupportedNewImuSensors(svo, expansionBoardDetails);
 * a Shimmer3R always qualifies, a Shimmer3 without expansion-board info in
 * the header never does (Java passes a LOG_FILE placeholder board → false).
 */
declare function isNewImuSensors(hw: number, expBrd: SdLogExpansionBoard | null): boolean;
/**
 * Parse an SD-log file header (first 256 bytes for Shimmer3, 384 bytes for
 * Shimmer3R). The whole file may be passed — only the header is read.
 */
declare function parseSdLogHeader(bytes: Uint8Array): SdLogHeader;

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

/** Options accepted by {@link decodeSdLogFile} and {@link decodeSdSession}. */
interface SdLogDecodeOptions {
    /** Stop after this many records (the result is flagged `truncated`). */
    maxRecords?: number;
}
/** Result of decoding one SD-log file or a whole session. */
interface SdLogDecodeResult {
    header: SdLogHeader;
    records: SdLogRecord[];
    /** True when decoding stopped early because `maxRecords` was reached. */
    truncated: boolean;
}
/**
 * Decode a single SD-log binary file (e.g. `000`) into typed records.
 *
 * @throws SdLogFormatError `NO_DATA` when the file contains only a header.
 */
declare function decodeSdLogFile(bytes: Uint8Array, opts?: SdLogDecodeOptions): SdLogDecodeResult;
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
declare function decodeSdSession(files: {
    name: string;
    bytes: Uint8Array;
}[], opts?: SdLogDecodeOptions): SdLogDecodeResult;

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
declare function parseSdSessionName(folder: string): {
    shimmerName: string;
    sessionNumber: number;
};
/**
 * Split a trial folder name (`<TrialName>_<ConfigTime>`) on its last `_`.
 * The trial name may itself contain underscores; the config time is kept as
 * the raw string written by the firmware.
 */
declare function parseSdTrialFolderName(folder: string): {
    trialName: string;
    configTime: string;
};

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
declare const SC_CALIB_FORMAT_VERSION = 2;
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
declare function utcToLocalCivilMillis(utcMillis?: number): number;
/** Current time in the Verisense local-civil RWC domain, in whole unix seconds. */
declare function localCivilUnixSecondsNow(): number;
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
    /**
     * Byte 65 bit0 (second status-flags byte — byte 26's flags are full): the
     * installed bootloader's DFU mode has the USB CDC transport (settings page
     * reports bootloader version >= 3), so USB DFU is available on this unit.
     * Null when the firmware predates the field (payload < 66 bytes) — treat
     * as unknown, not as unsupported.
     */
    usbDfuBootloader: boolean | null;
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
/** Upper bound for a plausible device timestamp (2100-01-01 UTC in unix
 * seconds). Values beyond this are uninitialised/garbage bytes, not dates. */
declare const VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS = 4102444800;
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
/** Decoded view of the BLE-link `optimizationResult` byte returned by the
 * optimize debug command: bit 7 = device reports "not connected" (the other
 * bits are then meaningless), bit 0 = a PHY change was requested, bit 1 = a
 * connection-interval change was requested, bit 2 = a data-length change was
 * requested. */
interface VerisenseBleOptimizationResult {
    notConnected: boolean;
    phyRequested: boolean;
    connIntervalRequested: boolean;
    dataLengthRequested: boolean;
    resultMask: number;
}
/** Decode the `optimizationResult` byte from {@link parseBleLinkDebugPayload}
 * (see {@link VerisenseBleOptimizationResult} for the bit meanings). */
declare function decodeVerisenseBleOptimizationResult(resultByte: number): VerisenseBleOptimizationResult;
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
/**
 * Firmware default passkeys by passkey ID: a production config programmed
 * with passkey ID "01" pairs with the fixed PIN "123456". Other IDs have no
 * fixed default (ID "00" uses the per-device derived PIN — see
 * {@link computeVerisensePairingPin}).
 */
declare const VERISENSE_DEFAULT_PASSKEY_BY_ID: Readonly<Record<string, string>>;
/** The fixed passkey for a passkey ID, or undefined when the ID has none
 * (leave the passkey bytes unset in the production config). */
declare function defaultVerisensePasskeyForId(passkeyId: string | null | undefined): string | undefined;
/** Component parts of a Verisense advertised BLE name. */
interface VerisenseAdvertisedNameParts {
    /** Name prefix from the production config (normally "Verisense"). */
    prefix: string;
    /** 2-char passkey ID from the production config. */
    passkeyId: string;
    /** 12-hex unique identifier (8-hex manufacturing order + 4-hex MAC ID). */
    uniqueId: string;
}
/**
 * Build the name a Verisense sensor advertises over BLE:
 * `<prefix>-<passkeyId>-<uniqueId>` (e.g. "Verisense-01-25112101B10F").
 * Returns null when any part is missing — matches how apps derive the name
 * from a parsed production config that may be blank/erased.
 */
declare function buildVerisenseAdvertisedName(parts: Partial<VerisenseAdvertisedNameParts>): string | null;
/**
 * Split a Verisense advertised name back into its parts. The unique ID is the
 * final `-`-separated token; the passkey ID the token before it; anything
 * earlier (which may itself contain `-`) is the prefix. Returns null when the
 * name does not have at least three tokens.
 */
declare function parseVerisenseAdvertisedName(name: string | null | undefined): VerisenseAdvertisedNameParts | null;
/**
 * The 4-hex MAC ID from a Verisense advertised name (the advertised name ends
 * with the unique ID = manufacturing order + MAC; its last 4 hex chars are
 * the MAC ID). Returns null when the tail is not valid hex.
 */
declare function deriveVerisenseMacIdFromName(name: string | null | undefined): string | null;
/**
 * Short device tag for file names (e.g. "…-B10F-…"): the last 4 hex chars of
 * a device unique ID or advertised name. Returns "" when unknown so callers
 * can omit it cleanly.
 */
declare function verisenseDeviceFileTag(idOrName: string | null | undefined): string;

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
 * GSR-capable hardware. Mirrors the firmware's authoritative
 * `ShimBrd_isGsrSupportedForHwVersion` (shimmer_boards.c):
 * - SR62 (any revision)
 * - SR61 minor >= 5
 * - SR68 minor >= 5
 *
 * Deliberately NOT {@link isVerisenseSecondGenerationHardware}: that predicate
 * requires SR68 >= 9, but GSR arrived on the SR68 at minor revision 5.
 */
declare function isVerisenseGsrSupportedHardware(revHwMajor: number, revHwMinor: number): boolean;
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
declare function isVerisenseLipoBatteryHardware(revHwMajor: number, revHwMinor: number): boolean;
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
 * Pad an operational config authored at a legacy/shorter length onto a blank
 * full-size (v9, {@link VERISENSE_OP_CONFIG_BYTE_SIZE}-byte) image so the
 * working config is always canonical size — otherwise trailing v9 fields
 * (e.g. the person-parameter bytes) would be absent. Configs already at or
 * beyond full size are returned as-is.
 */
declare function padVerisenseOperationalConfig(bytes: Uint8Array | ArrayLike<number>): Uint8Array;
/** Which IMU generation an op-config field key targets: 'ds3' = first-gen
 * LSM6DS3, 'dsv' = second-gen LSM6DSV (+LIS2MDL mag). */
type VerisenseImuGeneration = 'ds3' | 'dsv';
interface VerisenseSensorRateDefaultField {
    /** Field key in {@link VERISENSE_OPERATIONAL_FIELD_SCHEMA}, when the field
     * is the same on both IMU generations. */
    readonly key?: string;
    /** Generation-specific field keys (accel2/gyro ODR live in different
     * fields on LSM6DS3 vs LSM6DSV configs). */
    readonly keyByGen?: Readonly<Record<VerisenseImuGeneration, string>>;
    /** Default rate/mode code to seed when the sensor is enabled. */
    readonly on: number;
    /** Power-down code to write when every enable in the group is off. */
    readonly off: number;
}
interface VerisenseSensorRateDefaultGroup {
    /** Sensor-enable field keys (see {@link VERISENSE_SENSOR_ENABLE_FIELDS})
     * that share the rate/mode field(s) below. */
    readonly enableKeys: readonly string[];
    readonly fields: readonly VerisenseSensorRateDefaultField[];
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
declare const VERISENSE_SENSOR_RATE_DEFAULT_GROUPS: readonly VerisenseSensorRateDefaultGroup[];
/** Resolve a rate-default field to its concrete schema key for the given IMU
 * generation, or null when the field has no key for that generation. */
declare function resolveVerisenseSensorRateFieldKey(field: VerisenseSensorRateDefaultField, generation: VerisenseImuGeneration): string | null;
/** One of the three firmware BLE wake/sync schedules and its four op-config
 * field keys (see the BLE Wake Schedule field group). */
interface VerisenseBleSyncSchedule {
    readonly id: 'data' | 'status' | 'rtcSync';
    /** Field-group subgroup id used by the operational field schema. */
    readonly subgroupId: string;
    readonly intervalKey: string;
    readonly timeKey: string;
    readonly durKey: string;
    readonly retryKey: string;
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
declare const VERISENSE_BLE_SYNC_SCHEDULES: readonly VerisenseBleSyncSchedule[];
/** Value ranges for the BLE sync-schedule fields (clamp editor input to
 * these before writing). */
declare const VERISENSE_BLE_SCHEDULE_RANGES: Readonly<{
    intervalHours: Readonly<{
        min: 0;
        max: 24;
    }>;
    timeMins: Readonly<{
        min: 0;
        max: 1439;
    }>;
    durMin: Readonly<{
        min: 0;
        max: 255;
    }>;
    retryIntMin: Readonly<{
        min: 0;
        max: 1439;
    }>;
}>;
/**
 * Canonical schedule defaults: 01:00 daily, 10-minute window, 15-minute
 * retry, 5 connection attempts per wake. Also the "reset" values applied
 * when the pending-events scheduler is disabled, so a disabled config lands
 * in a clean known state.
 */
declare const VERISENSE_BLE_SCHEDULE_DEFAULTS: Readonly<{
    intervalHours: 24;
    timeMins: 60;
    durMin: 10;
    retryIntMin: 15;
    connectionTries: 5;
}>;
/** Format minutes-since-midnight as `"HH:MM"`, or null when out of range.
 * Fractional input is rounded to the nearest whole minute first, so the
 * minutes component always stays in 0–59. */
declare function minutesSinceMidnightToHHMM(mins: number | null | undefined): string | null;
/** Parse `"HH:MM"` (or `"H:MM"`) into minutes-since-midnight, or null when
 * malformed / out of range. */
declare function hhmmToMinutesSinceMidnight(text: string | null | undefined): number | null;
/** Boolean sensor enables used to predict which stream sensor IDs a config
 * will produce (see {@link expectedVerisenseStreamSensorIds}). */
interface VerisenseStreamSensorEnables {
    gsr?: boolean;
    vbatt?: boolean;
    vprog?: boolean;
    accel1?: boolean;
    accel2?: boolean;
    gyro?: boolean;
    mag?: boolean;
    ppg?: boolean;
    ambientLight?: boolean;
    skinTemp?: boolean;
    algoHub?: boolean;
}
/**
 * The stream-packet sensor IDs a device will emit for a given set of sensor
 * enables (see `VERISENSE_STREAM_SENSOR_LABELS` for the ID meanings). The
 * IMU block splits by hardware generation: first-gen streams accel2+gyro as
 * ID 3 (LSM6DS3); second-gen streams accel2+gyro+mag as ID 6 (LSM6DSV +
 * LIS2MDL). Any enabled PPG channel produces the single PPG stream (ID 4).
 */
declare function expectedVerisenseStreamSensorIds(enables: VerisenseStreamSensorEnables, opts: {
    secondGeneration: boolean;
}): Set<number>;
/** {@link expectedVerisenseStreamSensorIds} computed straight from op-config
 * bytes via the sensor-enable bit schema. */
declare function expectedVerisenseStreamSensorIdsFromConfig(op: Uint8Array | null | undefined, opts: {
    secondGeneration: boolean;
}): Set<number>;

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
    private usesSr62GsrFrontEnd;
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
    /**
     * Inject a transport (byte pipe) instead of the default web ones. Lets
     * non-browser runtimes (React Native, Bluetooth Classic) or tests drive the
     * client. When omitted, `connect()` builds a Web Bluetooth transport and
     * `connectSerial()` a Web Serial transport, so browser usage is unchanged.
     */
    transport?: ShimmerTransport;
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
    private _injectedTransport;
    private _transport;
    private _notifyUnsub;
    private _disconnectUnsub;
    device: BluetoothDevice | null;
    private server;
    private service;
    tx: BluetoothRemoteGATTCharacteristic | null;
    rx: BluetoothRemoteGATTCharacteristic | null;
    port: SerialPort | null;
    private _suppressDisconnectedEvent;
    private _mode;
    private _rxStreamBuf;
    private _pending;
    private _loggedChain;
    private _sync;
    private _testReportMode;
    private _throughputTestMode;
    private _bootstrapRequestTimeoutOverrideMs;
    private _connectCancelRequested;
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
    /** Build the default Web Bluetooth transport over the NUS service. */
    private _makeWebBleTransport;
    /** Subscribe to a transport's notify/disconnect streams. */
    private _wireTransport;
    /** Drop the current transport's notify/disconnect subscriptions. */
    private _unwireTransport;
    /** Handle an unexpected / requested transport disconnect (link drop). */
    private _handleTransportDisconnect;
    /**
     * Mirror the active WebBluetoothTransport's GATT handles onto the legacy
     * public fields so the web-only paths (Nordic DFU, connectWithRetry) can reach
     * the live connection. Injected (non-web) transports leave them null.
     */
    private _mirrorTransportHandles;
    connect(opts?: {
        device?: BluetoothDevice | null;
        filters?: BluetoothLEScanFilter[];
        optionalServices?: BluetoothServiceUUID[];
        transport?: ShimmerTransport;
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
        transport?: ShimmerTransport;
    }): Promise<boolean>;
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
    /**
     * Write a raw timestamp to the device RWC. NOTE: the Verisense time-sync
     * contract is that the RWC holds the base station's LOCAL civil time (unix
     * seconds with the local timezone offset baked in), not UTC - callers
     * syncing "now" should use {@link writeTimeLocalNow} rather than passing
     * `Date.now()/1000` here.
     */
    writeTimeUnixSeconds(unixSeconds: number): Promise<void>;
    /**
     * Synchronise the device RWC to the host's current LOCAL civil time - the
     * documented Verisense time-sync semantics ("the Base Station's local
     * time"). The downstream file parser relies on this domain for its
     * midnight/midday CSV splits and "Local =" header times.
     *
     * @returns the unix-seconds value written (local-civil domain).
     */
    writeTimeLocalNow(): Promise<number>;
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
    requestUsbDfuBootloaderReboot(): Promise<void>;
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
    /** Read the flash lookup table. The read walks the whole flash on-device
     * and can time out on busy sensors, so `retries` re-issues the command
     * (total attempts = retries + 1) before giving up. Non-finite or negative
     * `retries` is treated as 0; rejections are always `Error` instances. */
    readFlashLookupTable(index?: number, timeoutMs?: number, retries?: number): Promise<{
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
    /**
     * Push an operational config into every sensor decoder (rates, ranges,
     * channel enables) and cache it as the client's working config. Used
     * automatically after {@link readOpConfigFromDevice}; call it directly when
     * loading a config from a template/file without a device round-trip.
     */
    applyOperationalConfig(opConfigBytes: Uint8Array | number[]): void;
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
declare const VERISENSE_DFU_TRANSIENT_ERROR_REGEX: RegExp;
/** Total attempts (first try + retries) for the DFU connection-retry helpers. */
declare const VERISENSE_DFU_CONNECT_ATTEMPTS = 3;
/** Delay between DFU connection retries, letting the device finish rebooting. */
declare const VERISENSE_DFU_RETRY_DELAY_MS = 2000;
/** Time allowed for the base image's post-install reboot back into the bootloader. */
declare const VERISENSE_DFU_REBOOT_DELAY_MS = 3000;
/** Bound on `setDfuMode` (connect + notifications + one write): the happy path
 * completes in seconds, so a hit means a genuine stall — including the vendored
 * library's swallowed-rejection case that {@link patchSecureDfuSendOperation}
 * and {@link promiseWithTimeout} exist to catch. */
declare const VERISENSE_DFU_SET_MODE_TIMEOUT_MS = 30000;
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
declare const VERISENSE_DFU_RELIABLE_PACKET_DELAY_MS = 10;
declare const VERISENSE_DFU_FAST_PACKET_DELAY_MS = 0;
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
declare const VERISENSE_DFU_BOOTLOADER_NAME_PREFIX = "Verisense-BL";
declare const VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES: readonly string[];
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
declare const VERISENSE_DFU_ROUTINE_LOG_REGEX: RegExp;
/** True for library log messages that are routine retransmission noise and
 * should not be surfaced to end users (see {@link VERISENSE_DFU_ROUTINE_LOG_REGEX}). */
declare function isRoutineVerisenseDfuLogMessage(message: string): boolean;
/** "attempt N of M" wording for retry status lines. The retry helpers count
 * attempts DOWN (remaining, including the one that just failed), so the
 * attempt about to start is total - remaining + 2. */
declare function verisenseDfuAttemptLabel(attemptsRemaining: number, totalAttempts?: number): string;
/** A firmware image entry from a Nordic DFU package (`SecureDfuPackage`). */
interface VerisenseDfuImage {
    type?: string;
    initFile?: string;
    imageFile?: string;
    initData: ArrayBuffer;
    imageData: ArrayBuffer;
}
/** Structural view of Nordic's `SecureDfuPackage` (base = SoftDevice /
 * bootloader / both; app = application image). */
interface VerisenseDfuPackage {
    getBaseImage(): Promise<VerisenseDfuImage | null | undefined>;
    getAppImage(): Promise<VerisenseDfuImage | null | undefined>;
}
/** Structural view of the `SecureDfu` instance methods this module drives. */
interface SecureDfuLike {
    /** Resolves with the device when it is already in bootloader mode, or
     * null/undefined after the buttonless reboot command has been sent. */
    setDfuMode(device: BluetoothDevice): Promise<BluetoothDevice | null | undefined>;
    update(device: BluetoothDevice, init: ArrayBuffer, image: ArrayBuffer): Promise<unknown>;
}
interface SecureDfuSendOperationInternals {
    notifyFns: Record<number, {
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
    }>;
    log(message: unknown): void;
    delayPromise(ms: number): Promise<unknown>;
}
type SecureDfuSendOperation = (this: SecureDfuSendOperationInternals, characteristic: {
    writeValue(value: BufferSource): Promise<unknown>;
}, operation: ArrayLike<number>, buffer?: ArrayBuffer) => Promise<unknown>;
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
declare function patchSecureDfuSendOperation(SecureDfuCtor: {
    prototype: SecureDfuSendOperationInternals & {
        sendOperation: SecureDfuSendOperation;
    };
}): void;
/** How a DFU-flow error should be presented / handled. */
type VerisenseDfuErrorCategory = 'device-disconnected' | 'stack-operation-failed';
interface VerisenseDfuErrorInfo {
    /** Known Bluetooth-stack failure signature, or null for anything else
     * (including genuine DFU protocol errors, which pass through untouched). */
    category: VerisenseDfuErrorCategory | null;
    /** Plain-language, platform-neutral description for the category, or null.
     * Apps typically append their own platform-specific remediation hint (e.g.
     * "remove the sensor in Windows Bluetooth settings, then retry"). */
    friendlyMessage: string | null;
    /** True when the error matches {@link VERISENSE_DFU_TRANSIENT_ERROR_REGEX}
     * and is worth retrying. */
    transient: boolean;
    /** DOMException/Error name when available, else "GATT error". */
    name: string;
    rawMessage: string;
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
declare function classifyVerisenseDfuError(error: unknown): VerisenseDfuErrorInfo;
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
declare function promiseWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>;
/** A bundled firmware name must be a plain `.zip` filename — no path
 * separators or traversal — so a malformed/hostile manifest can't make an app
 * fetch outside its firmware folder. */
declare function isSafeFirmwareArchiveName(name: unknown): name is string;
/**
 * `navigator.bluetooth.requestDevice()` options for picking a Verisense
 * bootloader (replaces the DFU library's `acceptAllDevices`; see
 * {@link VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES} for why name-prefix only and
 * why there are two). Pass the vendored library's `SecureDfu.SERVICE_UUID`.
 */
declare function buildVerisenseDfuRequestDeviceOptions(dfuServiceUuid: string | number): {
    filters: {
        namePrefix: string;
    }[];
    optionalServices: (string | number)[];
};
interface VerisenseDfuRetryInfo {
    stage: 'set-dfu-mode' | 'update';
    /** Attempts left including the retry about to run. */
    attemptsRemaining: number;
    /** Ready-made "attempt N of M" wording for status lines. */
    attemptLabel: string;
    error: unknown;
}
interface VerisenseDfuFlowOptions {
    /** Total attempts for connection-level retries (default
     * {@link VERISENSE_DFU_CONNECT_ATTEMPTS}). */
    attempts?: number;
    /** Delay between retries (default {@link VERISENSE_DFU_RETRY_DELAY_MS}). */
    retryDelayMs?: number;
    /** Bound on setDfuMode (default {@link VERISENSE_DFU_SET_MODE_TIMEOUT_MS}). */
    setDfuModeTimeoutMs?: number;
    /** Wait after the base image installs, for the reboot back into the
     * bootloader (default {@link VERISENSE_DFU_REBOOT_DELAY_MS}). */
    rebootDelayMs?: number;
    /** User-facing progress text (the same strings the Verisense console shows). */
    onStatus?: (message: string) => void;
    /** Called before each connection-level retry; protocol errors never retry. */
    onRetry?: (info: VerisenseDfuRetryInfo) => void;
}
/**
 * `SecureDfu.update()` with retries on connection-level errors. Combined
 * (SoftDevice+bootloader+application) packages transfer in two parts with a
 * device reset in between; the reconnect for part 2 can fail while the device
 * is still rebooting, so transient errors retry after a settle delay. DFU
 * protocol errors are not retried.
 */
declare function updateVerisenseDfuImageWithRetry(dfu: SecureDfuLike, device: BluetoothDevice, image: VerisenseDfuImage, options?: VerisenseDfuFlowOptions): Promise<void>;
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
declare function setVerisenseDfuModeWithRetry(dfu: SecureDfuLike, device: BluetoothDevice, options?: VerisenseDfuFlowOptions): Promise<BluetoothDevice | null>;
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
declare function runVerisenseDfuUpdate(dfu: SecureDfuLike, device: BluetoothDevice, dfuPackage: VerisenseDfuPackage, options?: VerisenseDfuFlowOptions): Promise<void>;

/** SLIP-encode one frame (terminating END appended; none prepended, matching
 * Nordic's encoder). */
declare function slipEncode(frame: Uint8Array | number[]): Uint8Array;
/**
 * Streaming SLIP decoder: feed arbitrary chunks, get back completed frames.
 * Empty frames (back-to-back ENDs) are dropped, matching Nordic's decoder.
 */
declare class SlipDecoder {
    private _frame;
    private _escaped;
    /** Decode a chunk; returns every frame completed by it (possibly none). */
    push(chunk: Uint8Array): Uint8Array[];
    reset(): void;
}
/** CRC-32 of `data`, continuing from `seed` (pass a previous crc32 result to
 * extend it). Returns an unsigned 32-bit value. */
declare function crc32(data: Uint8Array, seed?: number): number;
/** Request opcodes (identical to the BLE control-point opcodes; over serial,
 * data writes are the explicit OBJECT_WRITE opcode instead of a second
 * characteristic). */
declare const SERIAL_DFU_OP: Readonly<{
    OBJECT_CREATE: 1;
    RECEIPT_NOTIF_SET: 2;
    CRC_GET: 3;
    OBJECT_EXECUTE: 4;
    OBJECT_SELECT: 6;
    MTU_GET: 7;
    OBJECT_WRITE: 8;
    PING: 9;
    RESPONSE: 96;
}>;
declare const SERIAL_DFU_OBJECT_TYPE: Readonly<{
    COMMAND: 1;
    DATA: 2;
}>;
/** Result codes carried in responses (nrf_dfu_response_t). */
declare const SERIAL_DFU_RESULT_NAMES: Readonly<Record<number, string>>;
/** Extended-error codes (nrf_dfu_ext_error_code_t) that follow result 0x0B. */
declare const SERIAL_DFU_EXTENDED_ERROR_NAMES: Readonly<Record<number, string>>;
/**
 * The v3 bootloader's USB identity in DFU mode. Deliberately distinct from
 * the application's CDC port (0x1915/0x520F) so a Web Serial picker — which
 * can only filter on VID/PID — shows exactly the bootloader.
 */
declare const VERISENSE_USB_DFU_VID = 6421;
declare const VERISENSE_USB_DFU_PID = 21023;
/** `navigator.serial.requestPort()` filters for the bootloader's DFU port. */
declare const VERISENSE_USB_DFU_PORT_FILTERS: ReadonlyArray<{
    usbVendorId: number;
    usbProductId: number;
}>;
/**
 * After the firmware ACKs a `DFU_MODE` request received over USB it reboots
 * ~300 ms later (the delay lets the ACK drain), the application port
 * disappears, and the bootloader enumerates as 0x1915/0x521F. Give the OS a
 * moment to enumerate before offering the picker.
 */
declare const VERISENSE_USB_DFU_REENUMERATION_DELAY_MS = 2000;
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
declare function isUsbDfuUnsupportedError(error: unknown): boolean;
/** The slice of {@link WebSerialTransport} this module drives (structural, so
 * tests can supply a mock and no import cycle is created). */
interface SerialDfuTransportLike {
    write(data: Uint8Array): Promise<void>;
    onNotify(cb: (data: Uint8Array) => void): () => void;
}
interface VerisenseSerialDfuProgress {
    object: 'init' | 'firmware';
    totalBytes: number;
    currentBytes: number;
}
interface VerisenseSerialDfuOptions {
    /** User-facing progress text (same role as the BLE flow's onStatus). */
    onStatus?: (message: string) => void;
    /** Byte-level transfer progress (same field names as the vendored
     * `SecureDfu` "progress" events, so UI code is shared). */
    onProgress?: (progress: VerisenseSerialDfuProgress) => void;
    /** Diagnostic log lines (protocol chatter; not for end users). */
    onLog?: (message: string) => void;
    /**
     * Bound on each request/response exchange. Execute of the final data object
     * covers the bootloader's signature verification and can take several
     * seconds; the default is generous because USB itself is not the
     * bottleneck.
     */
    requestTimeoutMs?: number;
    /** Attempts per data object before giving up (a CRC mismatch re-creates and
     * re-sends just that object). */
    objectAttempts?: number;
}
declare const VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS = 15000;
declare const VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS = 3;
/**
 * Nordic secure DFU over a SLIP-framed serial byte stream.
 *
 * One instance drives one transfer session; construct it around a connected
 * transport whose port is the bootloader's DFU port (see
 * {@link VERISENSE_USB_DFU_PORT_FILTERS}) and call {@link update} with the
 * `initData`/`imageData` of each image in the package (base image first when
 * present, application after — same ordering as `runVerisenseDfuUpdate`).
 */
declare class VerisenseSerialDfu {
    private readonly _transport;
    private readonly _options;
    private readonly _decoder;
    private _pending;
    private _unsubscribe;
    private _mtu;
    constructor(transport: SerialDfuTransportLike, options?: VerisenseSerialDfuOptions);
    /** Max unencoded bytes per OBJECT_WRITE frame: worst-case SLIP encoding
     * doubles every byte, plus the terminating END, minus the opcode byte
     * (matches nrfutil's `(mtu - 1) // 2 - 1`). */
    get maxWriteSize(): number;
    /**
     * Transfer one image (init packet + firmware binary). Resolves when the
     * final Execute is acknowledged — for an application image that is the
     * point where the bootloader resets to activate it, which also drops the
     * serial port; the caller should expect the port to disappear.
     */
    update(init: ArrayBuffer, image: ArrayBuffer): Promise<void>;
    private _handshake;
    private _transferInit;
    private _transferFirmware;
    private _writeData;
    private _select;
    private _crcGet;
    private _request;
    private _onData;
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

/**
 * Shared core for the plain-text factory test reports printed by every Shimmer
 * firmware family — Verisense (`Includes/ASM_common_source/Test/hal_factoryTest.c`)
 * and Shimmer3/Shimmer3R (`log-and-stream-common/Test/shimmer_test.c` plus each
 * board's `hal_FactoryTest.c`).
 *
 * The envelope is identical across families (a `TEST START` banner, a
 * `Firmware version:` line, a body of ` - <verdict>: <detail>` lines, an
 * optional `Overall Result = FAIL (0x…)` bitmask, a `TEST END` banner), so the
 * line loop, the truncation repair, the verdict tiers, the bitmask decode and
 * the CSV writer live here once. Everything a family prints differently is a
 * field of the `FactoryTestGrammar` it passes in.
 *
 * Two properties drive the whole design, and both came from Verisense:
 *
 * 1. **Tests are identified by line content, never by the printed test
 *    number.** Verisense renumbered its ids at firmware v2.00.010, so the same
 *    number means different tests across builds while the descriptive text
 *    stayed stable. Printed ids are still recorded per test and collected into
 *    an observed id-to-name map, which is what decodes the fail mask — so the
 *    mask is read correctly under either numbering.
 *
 * 2. **The report format is unversioned and still changing.** Nothing here
 *    throws: unrecognized test lines become generic entries, unrecognized text
 *    is preserved verbatim in `unparsedLines`, and the caller keeps the raw
 *    report alongside the parse.
 */
/** Verdict carried by a single report line. */
type FactoryTestVerdict = 'PASS' | 'FAIL' | 'WARNING' | 'NOT_APPLICABLE' | 'INFO' | 'UNKNOWN';
/** A value extracted from the report, as it should land in a spreadsheet cell. */
type FactoryTestMetricValue = number | string | boolean;
/** One test as it appeared in the report. */
interface FactoryTestResult {
    /** The test number printed in *this* report, or null if the line carried
     * none (Shimmer3 prints no numbers at all). Not stable across firmware
     * versions — see `name`. */
    id: number | null;
    /** Canonical snake_case key derived from the line's content. Stable across
     * firmware versions; this is what column names are built from. */
    name: string;
    /** Human-readable test name, e.g. `'VD6283TX Light sensor'`. */
    label: string;
    verdict: FactoryTestVerdict;
    /** The report text for this test, sub-lines joined with `' | '`. */
    detail: string;
    metrics: Record<string, FactoryTestMetricValue>;
}
/** Overall verdict block printed just before the TEST END banner. */
interface FactoryTestOverall {
    /** null when the report never reached its footer (e.g. a blank board aborts
     * the run at the Shimmer model test), and for the suites that print no
     * overall verdict at all (the LED walks). */
    result: 'PASS' | 'FAIL' | null;
    failMaskHex: string | null;
    failMask: number | null;
    /** Canonical names of the tests whose bits are set, resolved through the ids
     * actually observed in this report. */
    failedTestNames: string[];
}
/** The fields every family's parse result carries. */
interface FactoryTestReportParsedBase {
    /** The TEST START banner was found. */
    ok: boolean;
    /** The TEST END banner was found — a report can be valid but truncated. */
    complete: boolean;
    /** Dotted firmware version from the `Firmware version:` line, e.g. `'2.00.024'`. */
    firmwareVersion: string | null;
    overall: FactoryTestOverall;
    /** Tests in the order they were printed. */
    tests: FactoryTestResult[];
    /** Every metric merged into one flat map — one spreadsheet column per key. */
    metrics: Record<string, FactoryTestMetricValue>;
    /** Lines no rule recognized. Never dropped, so nothing is silently lost. */
    unparsedLines: string[];
    /** Anomalies worth surfacing (repaired truncation, stripped progress dots…). */
    parserWarnings: string[];
}
/** One content rule: the first whose `match` hits the line body wins. */
interface FactoryTestClassifier {
    name: string;
    label: string;
    match: RegExp;
    /** Column holding this test's verdict. Defaults to `<name>_result`. */
    resultKey?: string;
    extract?: (body: string, out: Record<string, FactoryTestMetricValue>) => void;
}
/** What a grammar hook is handed for the line it is being offered. */
interface FactoryTestLineContext<R extends FactoryTestReportParsedBase> {
    /** The result being built. */
    result: R;
    /** The flat, report-wide metrics map. */
    metrics: Record<string, FactoryTestMetricValue>;
    /** The test this line would attach to, or null between tests. */
    current: FactoryTestResult | null;
    /** Append a test to the report; returns the entry that ended up holding it
     * (a different object when `mergeRepeatedNames` folded it into an earlier
     * test of the same name). */
    pushTest: (test: FactoryTestResult) => FactoryTestResult;
    /** Append this line's text to the open test's `detail`. */
    addDetail: (line: string) => void;
    /** Record a parser warning. */
    warn: (message: string) => void;
}
/** A hook offered one trimmed line; returns true when it consumed it. */
type FactoryTestLineRule<R extends FactoryTestReportParsedBase> = (trimmed: string, ctx: FactoryTestLineContext<R>) => boolean;
/**
 * Everything one firmware family prints differently.
 *
 * Flags default to off, which is the Verisense behaviour the shared core was
 * extracted from: a grammar that sets none of them parses exactly as the
 * standalone Verisense parser did.
 */
interface FactoryTestGrammar<R extends FactoryTestReportParsedBase> {
    /** Test-number prefix, e.g. `'WS_TEST'` or `'S3R_TEST'`. Also seeds the
     * fallback name for a test no classifier recognized (`ws_test_0027`). */
    idToken: string;
    /** Content rules, matched in order against the text after the id prefix. */
    classifiers: FactoryTestClassifier[];
    /** Section headers that carry no data but end the open test's sub-line run. */
    sectionHeadings: RegExp;
    /** Line starts that may appear glued onto the end of a previous line, because
     * the firmware assembles each line in a fixed-size buffer and drops the CRLF
     * of anything that overruns it. */
    repairAnchors: RegExp[];
    /** `Firmware version:` line; capture group 1 is the dotted version. */
    firmwareVersion?: RegExp;
    /** LED test heading; capture group 1 is the printed id, if the family prints
     * one inside the heading. */
    ledHeading?: RegExp;
    /** Classifier name that means "this line is the LED test", so an id line for
     * it is routed through `ledTest` as the heading would have been. */
    ledClassifierName?: string;
    /** Name/label for the `index`-th LED test block in the report. */
    ledTest?: (index: number, id: number | null) => {
        name: string;
        label: string;
    };
    /** Operator-visual narration lines belonging to the open LED test. */
    ledNarration?: RegExp;
    /** Second chance to name a test whose line content no classifier recognized,
     * from the number the firmware printed. Content still wins, because the
     * numbering is the part that has moved between firmware releases; this is
     * for the lines that carry a bare verdict and no describing words at all
     * (Shimmer3R prints ` - S3R_TEST_0026 - PASS` for the microphone). A name
     * found here is looked up among the classifiers for its label and extractor. */
    testNameById?: (id: number) => string | undefined;
    /** Name used for a fail-mask bit whose id was never seen in this report.
     * Defaults to `<idToken lowercased>_00NN`. */
    maskTestName?: (id: number) => string;
    /** Accept ` - PASS: …` lines that carry no test number, as Shimmer3 prints
     * them. Off for families that always print a number. */
    idlessVerdictLines?: boolean;
    /** Attach an unrecognized *indented* line to the open test as detail rather
     * than filing it under `unparsedLines`. */
    attachIndentedSubLines?: boolean;
    /** Fold a second test of the same canonical name into the first,
     * worst-verdict-wins (Shimmer3/3R print one line per ADS1292R chip, and one
     * line per LED, for what is a single test). */
    mergeRepeatedNames?: boolean;
    /** Fold transport-mangled characters before parsing. Defaults to the degree
     * sign normalizer. */
    normalizeText?: (text: string) => string;
    /** Identification lines printed above the first test. */
    headerLine?: FactoryTestLineRule<R>;
    /** Indented continuation lines belonging to a test. */
    subLine?: FactoryTestLineRule<R>;
    /** Last chance before a line is filed as unparsed. */
    extraLine?: FactoryTestLineRule<R>;
}
/** Which firmware family printed a report. */
type FactoryTestReportFamily = 'verisense' | 'shimmer3r' | 'shimmer3' | 'unknown';
/**
 * Guess which firmware family printed a report.
 *
 * The test-number prefix is decisive when one is printed. Shimmer3 (MSP430)
 * prints none, so it is recognized by its section headings instead — which
 * also means an LED-states walk, printed by identical shared code on both
 * Shimmer boards and carrying no numbers, reports as `'shimmer3'` whichever
 * board ran it. That is the right parse either way: with no ids to resolve,
 * the two Shimmer grammars differ only in names this report does not contain.
 */
declare function detectFactoryTestReportFamily(text: string): FactoryTestReportFamily;
/**
 * Render a parsed report as two CSV rows (header, values): the caller's `meta`
 * columns first, then the parsed metrics sorted by name. A metric whose name
 * collides with a meta column is dropped in favour of the meta value — the
 * caller's identity columns are authoritative, and a duplicated header name
 * breaks most CSV consumers.
 */
declare function factoryTestReportToCsvRows(parsed: FactoryTestReportParsedBase, meta?: Record<string, string | number | boolean | null>): string[];

/**
 * Verisense grammar for the shared factory-test report parser.
 *
 * The report is printed by `Includes/ASM_common_source/Test/hal_factoryTest.c`.
 * Everything generic about it — the banners, the verdict tiers, the truncation
 * repair, the `Overall Result` bitmask decode and the CSV writer — now lives in
 * `../factoryTest/report.ts`, shared with the Shimmer3/3R families. What is
 * left here is what only Verisense prints: the `WS_TEST_` numbering, the
 * twenty content rules, the MCU header block and the indented production-config
 * and NAND blocks.
 *
 * Two properties drive the design, and both are Verisense's:
 *
 * 1. **Tests are identified by line content, never by the printed
 *    `WS_TEST_00NN` number.** The IDs were renumbered at firmware v2.00.010
 *    (the LF-crystal test took 0003 and everything from the old 0003 up to
 *    0019 shifted by one), so the same number means different tests across
 *    builds while the descriptive text stayed stable. Printed IDs are still
 *    recorded per test and collected into an observed id-to-name map, which is
 *    what decodes the `Overall Result = FAIL (0x…)` bitmask — so the mask is
 *    read correctly under either numbering.
 *
 * 2. **The report format is unversioned and still changing.** Nothing here
 *    throws: unrecognized test lines become generic entries, unrecognized text
 *    is preserved verbatim in `unparsedLines`, and the caller keeps the raw
 *    report alongside the parse.
 */
/** Verdict carried by a single report line. */
type VerisenseFactoryTestVerdict = FactoryTestVerdict;
/** A value extracted from the report, as it should land in a spreadsheet cell. */
type VerisenseFactoryTestMetricValue = FactoryTestMetricValue;
/** One test as it appeared in the report. */
type VerisenseFactoryTestResult = FactoryTestResult;
/** Overall verdict block printed just before the TEST END banner. */
type VerisenseFactoryTestOverall = FactoryTestOverall;
/** MCU header block printed above the first test. */
interface VerisenseFactoryTestMcuInfo {
    macId: string | null;
    deviceId: string | null;
    part: string | null;
    variant: string | null;
    lastResetHex: string | null;
    lastResetReasons: string | null;
    bootCount: number | null;
}
/** The indented production-config block printed by the Shimmer model test. */
interface VerisenseFactoryTestModelInfo {
    name: string | null;
    srRevision: string | null;
    manufacturingOrder: string | null;
    macSuffix: string | null;
    advertisingPrefix: string | null;
    passkeyId: string | null;
    passkeyKind: string | null;
}
/** Everything a single report yields. */
interface VerisenseFactoryTestReportParsed extends FactoryTestReportParsedBase {
    /** Which `WS_TEST_00NN` numbering this report uses, derived from the firmware
     * version. Informational: parsing never depends on it. */
    idScheme: 'legacy' | 'v2_00_010' | 'unknown';
    mcu: VerisenseFactoryTestMcuInfo;
    model: VerisenseFactoryTestModelInfo | null;
}
/**
 * Parse a full Verisense factory test report into structured metrics.
 *
 * Never throws: malformed or unrecognized input comes back with `ok: false`
 * and/or its lines preserved in `unparsedLines`.
 */
declare function parseVerisenseFactoryTestReport(text: string): VerisenseFactoryTestReportParsed;
/**
 * Render a parsed report as two CSV rows (header, values): the caller's `meta`
 * columns first, then the parsed metrics sorted by name. A metric whose name
 * collides with a meta column is dropped in favour of the meta value — the
 * caller's identity columns are authoritative, and a duplicated header name
 * breaks most CSV consumers.
 */
declare const verisenseFactoryTestReportToCsvRows: typeof factoryTestReportToCsvRows;

/**
 * Shimmer3 and Shimmer3R grammar for the shared factory-test report parser.
 *
 * The report envelope is printed by the shared LogAndStream code
 * (`log-and-stream-common/Test/shimmer_test.c:22-61`) and is byte-identical to
 * the Verisense one; the body comes from each board's own file:
 *
 * - Shimmer3R: `Shimmer_Driver/hal_FactoryTest.c`, which numbers every test
 *   `S3R_TEST_00NN` and sets bit n-1 of the `Overall Result = FAIL (0x…)` mask
 *   (`Shimmer_Driver/hal_FactoryTest.h:96-124`). The numbers are sparse — 0003,
 *   0007-0026 and 0028 — and 0027 appears only in the LED heading, never in the
 *   mask, because the LED walk is an operator-visual check with no verdict.
 * - Shimmer3 (MSP430): `Shimmer_Driver/5xx_HAL/hal_FactoryTest.c:65-420`, which
 *   prints no numbers at all and never sets the mask, so its report always ends
 *   `Overall Result = PASS` and its tests are identified purely by content.
 * - The operational-LED-state walk, `log-and-stream-common/Test/
 *   shimmer_test_leds_states.c`, is shared by both boards and prints neither
 *   numbers nor an overall verdict.
 *
 * Because the numbering is the volatile part, content rules resolve a test
 * first and the id table only answers for the lines that carry a bare verdict
 * and no describing words (the microphone prints ` - S3R_TEST_0026 - PASS`).
 *
 * Nothing here throws: empty, truncated and unrecognized input all come back as
 * a result with `ok: false` and the lines preserved.
 *
 * HARDWARE-VERIFY: every line shape below is transcribed from firmware source,
 * not from a report captured off a bench unit. The Shimmer3R BT module version
 * string and the SD card CID line in particular are reconstructed from their
 * `sprintf` formats.
 */
/** Which of the two Shimmer boards printed a report. */
type ShimmerFactoryTestReportFamily = 'shimmer3r' | 'shimmer3' | 'unknown';
/** The `- I/O status:` block, printed by both boards. */
interface ShimmerFactoryTestIoStatus {
    docked: boolean | null;
    btConnected: boolean | null;
    buttonPressed: boolean | null;
    usbConnected: boolean | null;
}
/** MCU identification block printed under the `MCU:` heading. */
interface ShimmerFactoryTestMcuInfo {
    /** The Bluetooth module's MAC, printed under `BT Module:`. */
    macId: string | null;
    deviceId: string | null;
    revisionId: string | null;
    uniqueId: string | null;
    /** Shimmer3 only; the MSP430 decodes its reset cause to words. */
    lastResetReason: string | null;
    /** Shimmer3R only: the LSE drive level the boot bring-up settled on. */
    lseDrive: string | null;
    io: ShimmerFactoryTestIoStatus;
}
/** The daughter-card identity printed by the Shimmer model test. */
interface ShimmerFactoryTestModelInfo {
    name: string | null;
    srRevision: string | null;
}
/** Everything a single Shimmer3/3R report yields. */
interface ShimmerFactoryTestReportParsed extends FactoryTestReportParsedBase {
    family: ShimmerFactoryTestReportFamily;
    /** `Date (yyyy-mm-dd):` from the report header, Shimmer3R only. */
    reportDate: string | null;
    /** `Time (hh:mm:ss):` from the report header, always UTC, Shimmer3R only. */
    reportTimeUtc: string | null;
    mcu: ShimmerFactoryTestMcuInfo;
    model: ShimmerFactoryTestModelInfo | null;
}
/**
 * Shimmer3R test numbers, from the bitmask enum in
 * `Shimmer_Driver/hal_FactoryTest.h:96-124`. Bit n-1 of the `Overall Result`
 * mask is test n.
 *
 * 0027 is deliberately absent: the shipped reports already print
 * `LED test (S3R_TEST_0027)`, so the number is spoken for, but the LED walk has
 * no pass/fail bit and can never appear in the mask.
 */
declare const SHIMMER3R_FACTORY_TEST_ID_NAMES: Readonly<Record<number, string>>;
/**
 * Matched in order against the text following the test number (or, on
 * Shimmer3, following the bare `- `); first hit wins. Every pattern keys on
 * wording rather than on a number, so one list serves both boards and survives
 * a renumbering.
 */
declare const SHIMMER_FACTORY_TEST_CLASSIFIERS: FactoryTestClassifier[];
/**
 * Parse a Shimmer3 or Shimmer3R factory test report into structured metrics.
 *
 * The family is detected from the report itself, so the caller does not have to
 * know which board it is talking to — useful because the same page drives both.
 * A report from neither board still parses under the id-less grammar and comes
 * back with `family: 'unknown'` and a parser warning saying so.
 *
 * Never throws: empty, truncated and garbage input all return a result.
 */
declare function parseShimmerFactoryTestReport(text: string): ShimmerFactoryTestReportParsed;
/**
 * Render a parsed report as two CSV rows (header, values): the caller's `meta`
 * columns first, then the parsed metrics sorted by name. A metric whose name
 * collides with a meta column is dropped in favour of the meta value.
 */
declare function shimmerFactoryTestReportToCsvRows(parsed: ShimmerFactoryTestReportParsed, meta?: Record<string, string | number | boolean | null>): string[];

export { ASM_COMMAND, ASM_PROPERTY, BASE_HARDWARE_IDS, BLE_LINK_MIN_FW, BRAND_BLE_MAX_CHARS, BRAND_BLE_MAX_CHARS_SHIMMER3, BRAND_BT_CLASSIC_MAX_CHARS, BRAND_PLATFORM, BRAND_RECORD_HOST_OFFSET, BRAND_RECORD_LAYOUT_VER, BRAND_RECORD_MAGIC, BRAND_RECORD_SIZE, BRAND_USB_MANUFACTURER_MAX_CHARS, BRAND_USB_PRODUCT_MAX_CHARS, BT_FEATURE, BaseShimmerClient, CALIB_READ_SOURCE, CHANNEL_FORMATS, CHANNEL_FORMAT_OVERRIDES, CHARGING_STATUS_BYTE, CHOP_FREQUENCY_LABELS, COMPARATOR_THRESHOLD_LABELS, CONSENSYS_UNKNOWN_DEVICE, CONVERSION_MODE_LABELS, CalibQuality, CalibSensorId, DATA_RATE_LABELS, DATA_RATE_OPTIONS, DEBUG_COMMAND_ID, EXG_BANK_LENGTH, EXG_CHIP1, EXG_CHIP2, EXG_CONFLICTING_SENSORS, EXG_KNOBS, EXG_PRESET_ARRAYS, EXG_REG8_STATUS_INDEX, EXG_REGS_RESPONSE, EXG_REGS_RESPONSE_PAYLOAD_LENGTH, ExgKnobError, ExgKnobValueError, ExgRespirationLockedError, FACTORY_TEST_ACK_TIMEOUT_MS, FACTORY_TEST_DRAIN_IDLE_MS, FACTORY_TEST_IDLE_FLOOR_MS, FACTORY_TEST_NACK_MESSAGE, FW_ID$1 as FW_ID, FactoryTestError, GAIN_LABELS, GAIN_OPTIONS, GAIN_VALUES, GET_EXG_REGS_COMMAND, GSR_NAME, INERTIAL_UNITS, INFOMEM_ADDR_FLAT, INFOMEM_ADDR_LEGACY, ANY_VERSION as INFOMEM_ANY_VERSION, BIT_SHIFT as INFOMEM_BIT_SHIFT, FW_ID as INFOMEM_FW_ID, GENERAL_CALIBRATION_LENGTH as INFOMEM_GENERAL_CALIBRATION_LENGTH, HW_ID as INFOMEM_HW_ID, MASK as INFOMEM_MASK, MAX_SYNC_NODES as INFOMEM_MAX_SYNC_NODES, INFOMEM_PAGE_SIZE, INFOMEM_SAMPLING_CLOCK_FREQ, INFOMEM_SIZE, INFOMEM_VALIDITY_BYTES, INPUT_SELECTION_LABELS, LEAD_OFF_COMPARATOR_OPTIONS, LEAD_OFF_CURRENT_LABELS, LEAD_OFF_CURRENT_OPTIONS, LEAD_OFF_DETECTION_LABELS, LEAD_OFF_DETECTION_OPTIONS, LEAD_OFF_FREQUENCY_LABELS, LoopbackTransport, MAX_CALIB_DUMP_BYTES, NEED_MORE, NEW_IMU_EXP_REV, NORDIC_DFU_BUTTONLESS_WITHOUT_BONDS, NORDIC_DFU_BUTTONLESS_WITH_BONDS, NORDIC_DFU_OP_ENTER_BOOTLOADER, NORDIC_DFU_SERVICE, NUS_RX, NUS_SERVICE, NUS_TX, OPCODES, OP_IDX, ObjectCluster, PACKET_OVERHEAD_RESPONSE_DATA, PACKET_OVERHEAD_RESPONSE_OTHER, POWER_DOWN_LABELS, REFERENCE_ELECTRODE_OPTIONS, RESPIRATION_CONTROL_LABELS, RESPIRATION_FREQUENCY_LABELS, RESPIRATION_FREQUENCY_OPTIONS, RESPIRATION_PHASE_32KHZ_LABELS, RESPIRATION_PHASE_64KHZ_LABELS, RESYNC, RLD_REFERENCE_SIGNAL_LABELS, RtcDriftMonitor, SC_CALIB_FORMAT_VERSION, SC_CAL_QUALITY_MASK, SC_CAL_QUALITY_SHIFT, SC_CAL_RANGE_MASK, SC_DATA_LEN_IMU, SC_GLOBAL_HEADER_BYTES, SDK_VERSION, SDLOG_CLOCK_FREQ, SDLOG_DATA_TYPE_BYTES, SDLOG_FW_ID, SDLOG_HEADER_LENGTH, SDLOG_HW_ID, SDLOG_SYNC_BLOCK_LENGTH, SDLOG_SYNC_OFFSET_LENGTH, SDLogHeaderBitmask, SD_ATTR_DIR, SD_ATTR_NAME_TRUNCATED, SD_BLOCK_PAYLOAD_DEFAULT, SD_BLOCK_PAYLOAD_MAX, SD_BLOCK_PAYLOAD_MIN, SD_MAX_PATH_LEN, SD_STATUS, SD_TRANSFER_OPCODES, SD_XFER, SERIAL_DFU_EXTENDED_ERROR_NAMES, SERIAL_DFU_OBJECT_TYPE, SERIAL_DFU_OP, SERIAL_DFU_RESULT_NAMES, SET_EXG_REGS_COMMAND, SHIMMER3R_DEFAULTS, SHIMMER3R_FACTORY_TEST_ID_NAMES, SHIMMER3R_INQ_CHANNELS_OFFSET, SHIMMER3R_INQ_NUM_CHANNELS_OFFSET, SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS, ACK as SHIMMER3_ACK, SHIMMER3_ADXL371_ACCEL_RANGE_OPTIONS, SHIMMER3_ADXL371_ACCEL_RATE_OPTIONS, SHIMMER3_BMP180_PRESSURE_RESOLUTION_OPTIONS, SHIMMER3_BMP280_PRESSURE_RESOLUTION_OPTIONS, SHIMMER3_BMP390_PRESSURE_OVERSAMPLING_OPTIONS, SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS, SHIMMER3_BMP581_PRESSURE_OVERSAMPLING_OPTIONS, SHIMMER3_BMP581_PRESSURE_RATE_OPTIONS, SHIMMER3_BT_BAUD_RATE_OPTIONS, SHIMMER3_DEFAULTS, SHIMMER3_FACTORY_TEST_TYPE, SHIMMER3_FACTORY_TEST_TYPES, SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS, SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS, SHIMMER3_INFOMEM_FIELD_GROUPS, SHIMMER3_INFOMEM_FIELD_SCHEMA, SHIMMER3_INQ_CHANNELS_OFFSET, SHIMMER3_INQ_CONFIG_LENGTH, SHIMMER3_INQ_CONFIG_OFFSET, SHIMMER3_INQ_NUM_CHANNELS_OFFSET, SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS, SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS, SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS, SHIMMER3_LIS2MDL_MAG_RANGE_OPTIONS, SHIMMER3_LIS2MDL_MAG_RATE_OPTIONS, SHIMMER3_LIS3MDL_ALT_MAG_RANGE_OPTIONS, SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS, SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS, SHIMMER3_LSM303AH_ACCEL_RATE_HR_OPTIONS, SHIMMER3_LSM303AH_ACCEL_RATE_LPM_OPTIONS, SHIMMER3_LSM303AH_MAG_RANGE_OPTIONS, SHIMMER3_LSM303AH_MAG_RATE_OPTIONS, SHIMMER3_LSM303DLHC_ACCEL_RANGE_OPTIONS, SHIMMER3_LSM303DLHC_ACCEL_RATE_HR_OPTIONS, SHIMMER3_LSM303DLHC_ACCEL_RATE_LPM_OPTIONS, SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS, SHIMMER3_LSM303DLHC_MAG_RATE_OPTIONS, SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS, SHIMMER3_LSM6DSV_ACCEL_RANGE_OPTIONS, SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS, SHIMMER3_MPU9X50_ACCEL_RANGE_OPTIONS, SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS, SHIMMER3_MPU9X50_MAG_RATE_OPTIONS, NACK as SHIMMER3_NACK, NEED_MORE$1 as SHIMMER3_NEED_MORE, SHIMMER3_RESPONSE_PAYLOAD_LENGTHS, RESYNC$1 as SHIMMER3_RESYNC, SHIMMER3_SAMPLING_CLOCK_FREQ, SHIMMER3_SAMPLING_RATES_HZ, SHIMMER3_SENSOR_LABELS, SHIMMER3_SPP_SERIAL_OPTIONS, SHIMMER3_SPP_UUID, SHIMMER_FACTORY_TEST_CLASSIFIERS, SHIMMER_UART_CRC_INIT, SMARTDOCK_BASE_CMD, SMARTDOCK_CONNECTION_TYPE, SMARTDOCK_DEFAULTS, SMARTDOCK_LINE_TERMINATOR, STREAM_MODE, SdLogFormatError, SdTransferError, SensorADC, SensorBase, SensorBitmapShimmer3, SensorLIS2DW12, SensorLSM6DS3, SensorLSM6DSV, SensorMAX32674, SensorMLX90632, SensorPPG, SensorVD6283, Shimmer3Client, Shimmer3RClient, SlipDecoder, SmartDockClient, StreamStatsTracker, TEST_MODE_ID, TEST_SIGNAL_FREQUENCY_LABELS, TIMESTAMP_FIELD, UART_COMPONENT, UART_CONFIG_COMMANDS, UART_DOCK_BAUD_RATE, UART_PACKET_CMD, UART_PACKET_HEADER, UART_PROP, UNKNOWN_CHANNEL_ASSUMED_BYTES, UnknownExgKnobError, VERISENSE_BLE_SCHEDULE_DEFAULTS, VERISENSE_BLE_SCHEDULE_RANGES, VERISENSE_BLE_SYNC_SCHEDULES, VERISENSE_CALIBRATION_MIN_FW, VERISENSE_DEFAULT_PASSKEY_BY_ID, VERISENSE_DFU_BOOTLOADER_NAME_PREFIX, VERISENSE_DFU_BOOTLOADER_NAME_PREFIXES, VERISENSE_DFU_CONNECT_ATTEMPTS, VERISENSE_DFU_FAST_PACKET_DELAY_MS, VERISENSE_DFU_REBOOT_DELAY_MS, VERISENSE_DFU_RELIABLE_PACKET_DELAY_MS, VERISENSE_DFU_RETRY_DELAY_MS, VERISENSE_DFU_ROUTINE_LOG_REGEX, VERISENSE_DFU_SET_MODE_TIMEOUT_MS, VERISENSE_DFU_TRANSIENT_ERROR_REGEX, VERISENSE_HW_MAJOR_FRIENDLY_NAMES, VERISENSE_MAX_PLAUSIBLE_UNIX_SECONDS, VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID, VERISENSE_OPERATIONAL_FIELD_GROUPS, VERISENSE_OPERATIONAL_FIELD_GROUP_SENSOR, VERISENSE_OPERATIONAL_FIELD_SCHEMA, VERISENSE_OP_CONFIG_BYTE_SIZE, VERISENSE_SENSOR_ENABLE_FIELDS, VERISENSE_SENSOR_RATE_DEFAULT_GROUPS, VERISENSE_SERIAL_DFU_OBJECT_ATTEMPTS, VERISENSE_SERIAL_DFU_REQUEST_TIMEOUT_MS, VERISENSE_STREAM_SENSOR_LABELS, VERISENSE_USB_DFU_PID, VERISENSE_USB_DFU_PORT_FILTERS, VERISENSE_USB_DFU_REENUMERATION_DELAY_MS, VERISENSE_USB_DFU_VID, VOLTAGE_REFERENCE_LABELS, VerisenseBleDevice, VerisenseSerialDfu, WIRED_DEFAULTS, NEED_MORE$2 as WIRED_NEED_MORE, RESYNC$2 as WIRED_RESYNC, WebBluetoothTransport, WebSerialTransport, WiredShimmerClient, applyDuplicateSuffix, applyExgKnobEdits, applyExgMustBeBits, applyExgPreset, applyImuCalibration, asmRtcBytesToUnixSeconds, asmRtcMinutesBytesToUnixSeconds, badResponseReason, baseHardwareType, battAdcToVoltage, battVoltageToPercentage, brandNameProblem, buildAbortCmd, buildBaseCommand, buildBlankBrandRecord, buildBrandRecord, buildDefaultVerisenseCalibrationSet, buildDeleteCmd, buildFreeSpaceCmd, buildGetExgRegsCommand, buildHeader, buildListDirCmd, buildMemReadPayload, buildMemWritePayload, buildMessage, buildParsedCsvFileName, buildProductionConfigPayload, buildReadCmd, buildReadPacket, buildSelectSlotCommand, buildSetExgRegsCommand, buildSetFactoryTestCommand, buildShimmer3Schema, buildStatCmd, buildStreamSchema, buildUartPacket, buildUploadBinaryFileName, buildVerisenseAdvertisedName, buildVerisenseDfuRequestDeviceOptions, buildWritePacket, calibTsBytesToUnixSeconds, calibrateGsrDataToResistanceFromAmplifierEq, calibrateShimmer3RAdcChannel, calibrateU12AdcValue, calibrateVector3, calibrationBlobCrc, channelFormatsFor, channelIdToSensorBit, channelLayoutDiffersByGeneration, checkConfigBytesValid, classifyBaseResponse, classifyFactoryTestAckPacket, classifyLiteProtocolAck, classifyVerisenseDfuError, clearExgResolutionFlags, compareInfoMemExcluding, compareVerisenseFirmwareVersion, computeVerisensePairingPin, consensysBackupSegments, crc16_ccitt_false, crc32, createBlankVerisenseOperationalConfig, csvCell, csvRow, decodeExgRegisters, decodeExgRegsResponse, decodeSdLogFile, decodeSdLogValue, decodeSdSession, decodeVerisenseBleOptimizationResult, defaultVerisensePasskeyForId, deleteDownloadedFromCard, deriveShimmer3FirmwareVersionCode, deriveVerisenseMacIdFromName, describePlatformSupport, describeVerisenseChargerStatus, detectExgPreset, detectFactoryTestReportFamily, deviceWriteDivergentRanges, divisorToSamplingRate, downloadSdTree, drainByteStream, encodeExgRegisters, encodeSdPath, enforceVerisenseCommsChannelInterlock, ensureDirectoryPath, enumerateSdTree, evaluateParsedFileSplit, exgBanksEqualIgnoringStatus, exgConflictingSensors, exgKnobOptions, exgPresetLabel, exgRateSettingFromFreq, exgResolutionFromSensors, expectedVerisenseStreamSensorIds, expectedVerisenseStreamSensorIdsFromConfig, extractBaseLine, factoryTestReportToCsvRows, fatDateTimeToDate, formatByteArrayAsHex, formatByteAsHex, formatPendingEventProperties, formatSchedulerPayloadForLog, formatSdImportStamp, formatStatusPayloadForLog, formatVerisenseChargerStatus, formatVerisenseFirmwareVersion, formatVerisenseHardwareRevision, formatVerisenseUnixAndHuman, fwCompare, generateCalibDump, generateInfoMem, generateKinematicCalibBlock, generationFromHardwareVersion, getDefaultCalibration, getFirstPayloadIndex, getGroupDefaults, getOversamplingRatioADS1292R, getVerisenseCalibrationSensorAvailability, getVerisenseCalibrationSensors, getVerisenseHardwareCapabilities, getVerisenseHardwareFriendlyName, getVerisenseHardwareRevision, getVerisenseHardwareSensorSupport, getVerisenseStreamSensorLabel, getVerisenseStreamingBatteryVoltageMultiplier, getVerisenseSupportedOperationalFieldGroupIds, hasSensorBit, hhmmToMinutesSinceMidnight, inferShimmer3Generation, inferVerisenseChargerChipFamily, inferVerisenseLookupBankCount, infoMemFieldsFor, interpretShimmer3InquiryResponse, isAckCommand, isBadResponse, isExgRespirationEnabled, isGenerationSensitiveChannel, isNackCommand, isNewImuSensors, isRoutineVerisenseDfuLogMessage, isSafeFirmwareArchiveName, isSdLoggingFirmware, isSupportedEightByteDerivedSensors, isSupportedMpl, isSupportedRtcConfigViaUart, isSupportedSdLogSync, isUniformByteArray, isUsbDfuUnsupportedError, isVerisenseGsrSupportedHardware, isVerisenseLightDarkChannelEnabled, isVerisenseLipoBatteryHardware, isVerisenseSecondGenerationHardware, localCivilUnixSecondsNow, makeKinematicCalibration, matrixInverse3x3, matrixMultiply3x3, minutesSinceMidnightToHHMM, msToRtcBytesLE, nextAvailableDuplicateFileName, normalizeBytePayload, normalizeOperationalConfig, nudgeGsrResistance, objectClusterColumns, objectClusterRow, padVerisenseOperationalConfig, parseActiveSlot, parseBatteryStatus, parseBleLinkDebugPayload, parseBrandRecord, parseCalibDump, parseCalibrationBlob, parseDeleteRsp, parseEventLogPayload, parseExpansionBoard, parseFreeSpaceRsp, parseHeader, parseHexByteString, parseInfoMem, parseKinematicCalibBlock, parseListDirRsp, parseLookupTablePayload, parseMacId, parseMessage, parsePayloadCrcErrorBankIndexes, parsePendingEvents, parseProductionConfigPayload, parseProductionConfigPayloadFull, parseRecordBufferDetailsPayload, parseSchedulerDebugPayload, parseSdLogHeader, parseSdSessionName, parseSdTrialFolderName, parseShimmer3DeviceVersionResponse, parseShimmer3FwVersionResponse, parseShimmer3StatusBytes, parseShimmerFactoryTestReport, parseSlotOccupancy, parseSmartDockVersion, parseStatRsp, parseStatusPayload, parseUartPacket, parseVerisenseAdvertisedName, parseVerisenseFactoryTestReport, parseVersionInfo, patchSecureDfuSendOperation, promiseWithTimeout, readExgField, readExgKnobs, readInfoMemFieldValue, readVerisenseOperationalFieldValue, requireShimmer3FactoryTestType, resolveChannelFormat, resolveFieldIndex, resolveInfoMemLayout, resolveVerisenseSensorRateFieldKey, respirationPhaseOptions, runVerisenseDfuUpdate, samplingRateToDivisor, sdCrc16, sdMessageSpan, sdStatusToString, sdXferStatusToString, serializeCalibrationBlob, setExgFieldPreserving, setVerisenseDfuModeWithRetry, setVerisenseOperationalBitRange, shimmer3ControlMessageLength, shimmer3FactoryTestTypeInfo, shimmer3SensorLabel, shimmer3SupportsExg, shimmer3UsesThreeByteTimestamp, shimmer3rControlMessageLength, shimmerFactoryTestReportToCsvRows, shimmerUartCrcByte, shimmerUartCrcCalc, shimmerUartCrcCheck, shouldOverrideCalibration, slipEncode, supportsVerisenseCalibration, supportsVerisenseMagnetometer, transportAdvice, transportAvailability, tryExtractSdMessage, unixSecondsToAsmRtcBytes, unixSecondsToCalibTsBytes, updateExgSetting, updateVerisenseDfuImageWithRetry, utcToLocalCivilMillis, verisenseDeviceFileTag, verisenseDfuAttemptLabel, verisenseFactoryTestReportToCsvRows, wiredPacketLength, writeInfoMemFieldValue, writeVerisenseOperationalFieldValue };
export type { ADCBatterySample, ADCGSRSample, ADCPayloadSample, AckVerdict, ApplicableExgPreset, AsmCommand, AsmProperty, Availability, BleLinkAutoOptimizeOptions, BleLinkAutoOptimizeResult, BleLinkAutoOptimizeSample, BleLinkAutoOptimizeStopReason, BleThroughputTestOptions, BleThroughputTestResult, BrandRecord, BrandRecordFields, BuildStreamSchemaOptions, CalibDump, CalibDumpRecord, CalibDumpVersion, CalibReadSource, CalibrationBlock, CalibrationBlockInput, CalibrationSet, CalibrationSetInput, ChannelFormat, ChargingStatus, DebugCommandId, DecodedExgRegisters, DeviceKind, DeviceMode, DeviceWriteDivergentRanges, DiscoveredDevice, DownloadSdTreeOptions, DrainOptions, DrainResult, DrainVerdict, DropReason, EvaluateParsedSplitInput, ExgApplyInput, ExgApplyResult, ExgBanks, ExgChannelSettings, ExgChipIndex, ExgFieldName, ExgFieldValue, ExgGainValue, ExgKnobEdit, ExgKnobField, ExgKnobOption, ExgLeadOffSettings, ExgPreset, ExgResolution, ExgRespirationSettings, ExgRldSettings, ExgStatusBits, ExgTestSignalSettings, ExpansionBoardInfo, FactoryTestClassifier, FactoryTestFailureReason, FactoryTestGrammar, FactoryTestLineContext, FactoryTestLineRule, FactoryTestMetricValue, FactoryTestOverall, FactoryTestReportFamily, FactoryTestReportParsedBase, FactoryTestResult, FactoryTestRunOptions, FactoryTestState, FactoryTestVerdict, FieldKind, GenerateInfoMemOptions, GroupDefaults, IShimmerClient, ImuCalibration, ImuFamily, InertialCalibration, InertialGroup, InfoMemCalibrationBlocks, InfoMemContext, InfoMemDeviceConfig, InfoMemFieldDefinition, InfoMemFieldGroup, InfoMemFieldKind, InfoMemFieldOption, InfoMemFieldSubgroup, InfoMemImuConfig, InfoMemLayout, InfoMemSdConfig, KinematicCalibration, LIS2DW12Sample, LSM6DS3Sample, LSM6DSVSample, LoopbackTransportOptions, LoopbackWrite, MAX32674Sample, MLX90632Sample, MessageLengthFn, NavigatorLike, ObjectClusterColumn, ObjectClusterColumnOptions, OpIdx, Opcode, PPGChannelSample, PPGSample, ParseKinematicOptions, ParsedSplitReason, PendingEventPropertyLabel, PlatformSupport, ProductionConfig, ProductionConfigBuildOptions, ProductionConfigFull, RtcDriftMonitorOptions, RtcDriftSample, RtcDriftSampleEvent, RtcDriftSampleInput, RunHardwareTestReportOptions, SdCardSpace, SdDataFrame, SdDestinationLayout, SdDirEntry, SdExtractResult, SdFileStat, SdListDirPage, SdLogCalibrationBytes, SdLogChannel, SdLogChannelCalibrationInfo, SdLogChannelSpec, SdLogDataType, SdLogDecodeOptions, SdLogDecodeResult, SdLogExpansionBoard, SdLogFormatErrorCode, SdLogHeader, SdLogImuRanges, SdLogRecord, SdMessage, SdOneShotResponse, SdRemoteFile, SdRemoteTree, SdStatusFrame, SdTransferProgress, SdTransferSummary, SecureDfuLike, SensorBitmapShimmer3Key, SensorField, SensorMap, SensorStreamStats, SerialDfuTransportLike, Shimmer3ChannelField, Shimmer3ClientOptions, Shimmer3DeviceStatus, Shimmer3DeviceVersion, Shimmer3FactoryTestType, Shimmer3FactoryTestTypeInfo, Shimmer3FwVersion, Shimmer3Generation, Shimmer3InquiryResult, Shimmer3RClientOptions, Shimmer3RFramingOptions, Shimmer3SensorLabel, Shimmer3SensorOption, Shimmer3StreamSchema, ShimmerClientOptions, ShimmerFactoryTestIoStatus, ShimmerFactoryTestMcuInfo, ShimmerFactoryTestModelInfo, ShimmerFactoryTestReportFamily, ShimmerFactoryTestReportParsed, ShimmerGeneration, ShimmerTransport, ShimmerTransportKind, SlotOccupancy, SmartDockActiveSlot, SmartDockClientOptions, SmartDockConnectionType, SmartDockHardwareType, SmartDockInfo, SmartDockResponseKind, SmartDockVersionInfo, StreamContribution, StreamLossStats, StreamPacket, StreamSchemaBase, StreamSchemaField, StreamStatsSnapshot, TestModeId, TimestampFmt, TransferLoggedDataOptions, TransferLoggedDataResult, TransportCapabilities, TransportKind, TransportNeed, TransportScanner, TransportWriteOptions, UartComponent, UartComponentProperty, UartPacketCmd, UartPermission, UartRxPacket, Unsubscribe, VD6283Sample, VerisenseAdvertisedNameParts, VerisenseBleLinkDebugPayload, VerisenseBleOptimizationResult, VerisenseBleSyncSchedule, VerisenseCalibrationAvailability, VerisenseCalibrationRange, VerisenseCalibrationSensor, VerisenseChargerChipFamily, VerisenseClientOptions, VerisenseCommandResponse, VerisenseConnectRetryInfo, VerisenseConnectWithRetryOptions, VerisenseDfuErrorCategory, VerisenseDfuErrorInfo, VerisenseDfuFlowOptions, VerisenseDfuImage, VerisenseDfuPackage, VerisenseDfuRetryInfo, VerisenseEventLogEntry, VerisenseFactoryTestMcuInfo, VerisenseFactoryTestMetricValue, VerisenseFactoryTestModelInfo, VerisenseFactoryTestOverall, VerisenseFactoryTestReportParsed, VerisenseFactoryTestResult, VerisenseFactoryTestVerdict, VerisenseFirmwareVersion, VerisenseHardwareCapabilities, VerisenseHardwareRevision, VerisenseHardwareRevisionSource, VerisenseHardwareSensorSupport, VerisenseImuGeneration, VerisenseLookupTableEntry, VerisenseLookupTablePayload, VerisenseMessage, VerisenseOperationalField, VerisenseOperationalFieldDefinition, VerisenseOperationalFieldGroupDefinition, VerisenseOperationalFieldKind, VerisenseOperationalFieldOption, VerisenseOperationalSensorEnableField, VerisenseRecordBufferDetails, VerisenseSchedulerDebugPayload, VerisenseSchedulerDebugPayloadForLog, VerisenseSensorRateDefaultField, VerisenseSensorRateDefaultGroup, VerisenseSerialDfuOptions, VerisenseSerialDfuProgress, VerisenseStatusPayload, VerisenseStatusPayloadForLog, VerisenseStreamSensorEnables, VerisenseUnixAndHumanTimestamp, WebBluetoothTransportOptions, WebSerialTransportOptions, WiredBatteryStatus, WiredIdentity, WiredShimmerClientOptions, WiredVersionInfo };
