/**
 * Connect / disconnect chrome shared by the webBLEDemos pages: capability
 * gating for the three connect buttons, the connect-failure diagnostics that
 * were worth more than the rest of the session when a link misbehaved, port
 * identity logging, platform advice and disconnect detection.
 *
 * Ported from the two pages that grew this logic independently:
 *   - sd-download/index.html    — setConnected (L370-387), connectVia
 *                                 (L470-550), connectFailureHints (L559-576),
 *                                 logPortIdentity (L600-624), the startup
 *                                 advice (L872-885)
 *   - eeprom-branding/index.html — the three-button setConnected (L527-544),
 *                                 the classic-BT catch (L875-889), the SDK
 *                                 version probe (L1053-1063) and the
 *                                 transportAdvice loop (L1075-1078)
 *
 * The controller never constructs a client itself — the page supplies
 * factories — so the same code drives Shimmer3RClient, Shimmer3Client,
 * WiredShimmerClient and, later, Verisense.
 *
 * No DOM access at import time.
 *
 *   import { createConnectController } from "../common/connect-ui.js";
 */

/**
 * Human label per connect mode, used in log lines and hint text.
 * `rfcomm` rather than `btclassic` because that is what the link actually is
 * (a Bluetooth serial port), and it distinguishes it from BLE at a glance.
 */
const MODE_LABELS = Object.freeze({
  ble: "BLE",
  rfcomm: "classic Bluetooth",
  usb: "wired serial",
});

/** Which `TransportNeed` each mode rides, for transportAdvice(). */
const MODE_NEEDS = Object.freeze({
  ble: "ble",
  rfcomm: "classicBluetooth",
  usb: "wiredSerial",
});

/**
 * The exact status string the SDK emits when the link drops. Matched as an
 * equality test, not a regex: "disconnect" appears in plenty of benign status
 * lines ("disconnecting…", "requested disconnect"), and treating one of those
 * as a real drop tears down a live session.
 */
export const SDK_DISCONNECT_STATUS = "Device disconnected";

/** Oldest vendored SDK whose BLE record reads are not truncated. */
const MIN_USEFUL_SDK = "0.1.12";

/**
 * Create the connect controller.
 *
 * @param {object} cfg
 * @param {object} cfg.els  buttons and status elements; all optional, so a
 *   page that offers only BLE just omits `usb`/`bt`
 * @param {HTMLButtonElement} [cfg.els.ble]     "Connect BLE"
 * @param {HTMLButtonElement} [cfg.els.usb]     "Connect USB / dock"
 * @param {HTMLButtonElement} [cfg.els.bt]      "Connect classic Bluetooth"
 * @param {HTMLButtonElement} [cfg.els.disconnect]
 * @param {HTMLElement} [cfg.els.pill]    connection pill (`.pill`, gets `.on`)
 * @param {HTMLElement} [cfg.els.info]    free-text status line
 * @param {HTMLElement} [cfg.els.banner]  `.banner` for platform advice
 * @param {{log: Function, warn?: Function, error?: Function}|Function} cfg.log
 *   a `createLog()` handle, or a bare `log(msg)` function
 * @param {object} cfg.sdkNs the whole vendored SDK namespace object — passed
 *   as a namespace, not destructured, so a bundle missing a newer export
 *   degrades to a warning instead of breaking the page's import
 * @param {object} cfg.makeClients factories keyed by mode. Each returns either
 *   a client, or `{client, transport}` when the page built the transport
 *   itself (the classic-BT path needs the transport for logPortIdentity)
 * @param {() => unknown} [cfg.makeClients.ble]
 * @param {() => unknown} [cfg.makeClients.bt]
 * @param {() => unknown} [cfg.makeClients.usb]
 * @param {(session: object) => unknown} [cfg.afterConnect] post-connect hook;
 *   its failure is logged and never tears down the connection it reports on
 * @param {(reason?: Error|string) => void} [cfg.onDisconnected]
 * @param {boolean} [cfg.announceStartup=true] log the SDK version and the
 *   per-transport platform advice on creation
 * @returns {{
 *   connectVia: (mode: "ble"|"rfcomm"|"usb") => Promise<boolean>,
 *   disconnect: () => Promise<void>,
 *   readonly session: object|null,
 *   setConnected: (on: boolean, label?: string) => void,
 *   support: object,
 *   connectFailureHints: (mode: string, err: unknown) => string[],
 *   logPortIdentity: (transport: unknown) => void,
 * }}
 */
export function createConnectController(cfg) {
  const els = cfg.els ?? {};
  const sdkNs = cfg.sdkNs ?? {};
  const makeClients = cfg.makeClients ?? {};

  const logger =
    typeof cfg.log === "function" ? { log: cfg.log } : (cfg.log ?? {});
  const log = (msg) => logger.log?.(String(msg));
  const warn = (msg) => (logger.warn ?? logger.log)?.(String(msg));
  const error = (msg) => (logger.error ?? logger.log)?.(String(msg));

  /* Capability snapshot, hoisted above the first setConnected(false) below:
   * setConnected reads `support`, so taking the snapshot afterwards would
   * gate the buttons on `undefined` on the very first paint. */
  const support = sdkNs.describePlatformSupport?.() ?? {
    webSerial: typeof navigator?.serial?.requestPort === "function",
    webBluetooth: typeof navigator?.bluetooth?.requestDevice === "function",
    isAndroid: false,
    isIOS: false,
    serialBluetoothOnly: false,
  };

  /** @type {{client: unknown, mode: string, transport: unknown, label: string}|null} */
  let session = null;
  let connecting = false;
  /** Guards the disconnect path against firing twice for one drop. */
  let disconnectReported = false;
  /** Detach the SDK disconnect subscription, when it returned one. */
  let detachDisconnect = null;

  // -------------------------------------------------------------------------
  // Button state
  // -------------------------------------------------------------------------

  /**
   * Apply the connected/disconnected state to the chrome.
   *
   * Capability is a floor the connected-state cannot lift. Assigning
   * `disabled = on` alone re-enabled every button on each disconnect, so on a
   * browser with only some of these APIs — desktop Firefox has Web Serial but
   * no Web Bluetooth — one connect/disconnect cycle handed the user a button
   * that cannot work.
   *
   * The wired/dock button is the exception that proves the rule: it gates on
   * webSerial only, because on Android that is true while a wired port is
   * merely "unlikely" — advised about below, deliberately not disabled.
   *
   * @param {boolean} on
   * @param {string} [label] pill text while connected
   */
  function setConnected(on, label) {
    if (els.ble) els.ble.disabled = on || connecting || !support.webBluetooth;
    if (els.bt) els.bt.disabled = on || connecting || !support.webSerial;
    if (els.usb) els.usb.disabled = on || connecting || !support.webSerial;
    if (els.disconnect) els.disconnect.disabled = !on;
    if (els.pill) {
      els.pill.textContent = on ? (label ?? session?.label ?? "connected") : "disconnected";
      els.pill.classList.toggle("on", !!on);
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /**
   * Extra guidance for a failed connect.
   *
   * The Web Serial picker is drawn by the browser and cannot be filtered by
   * device name — the API only filters on USB VID/PID or Bluetooth service
   * class, and a port's name is not even readable via getInfo(). So when the
   * wrong entry is picked, the best we can do is explain the symptom
   * afterwards.
   *
   * @param {"ble"|"rfcomm"|"usb"|string} mode
   * @param {unknown} err
   * @returns {string[]}
   */
  function connectFailureHints(mode, err) {
    if (mode !== "rfcomm") return [];
    const message = String(err?.message ?? err ?? "");
    const hints = [];
    if (/timeout/i.test(message)) {
      /* A Shimmer3R pairs as two separate Bluetooth entries: "…-BT"
       * (classic, speaks this protocol) and "…-BLE" (GATT, does not). The
       * SPP service-class filter should keep the BLE one out of the picker,
       * but if it appears anyway, opening it succeeds and then nothing ever
       * answers — which looks exactly like this. */
      hints.push(
        'the port opened but the sensor never answered — if you picked a "…-BLE" entry, choose the "…-BT" one instead (or use Connect BLE)',
      );
    }
    hints.push(
      "also check the sensor is paired with this host, powered, in range, and not held open by another app (e.g. Consensys)",
    );
    return hints;
  }

  /**
   * What the picker really gave us.
   *
   * getInfo() reports the RFCOMM service class the port was matched on, which
   * is the one fact that tells you why a paired sensor did or did not appear:
   * if this is not 00001101-0000-1000-8000-00805f9b34fb then the sensor
   * exposes a non-standard service class, and SHIMMER3_SPP_SERIAL_OPTIONS is
   * filtering on the wrong UUID. Cheap to log every time and useless to guess
   * at afterwards.
   *
   * @param {unknown} transport a WebSerialTransport (anything else is a no-op)
   */
  function logPortIdentity(transport) {
    const port = transport?.port;
    if (!port?.getInfo) return;
    try {
      const info = port.getInfo();
      log(`port: ${JSON.stringify(info)}`);
      if (info.bluetoothServiceClassId) {
        const spp = sdkNs.SHIMMER3_SPP_UUID;
        const isSpp =
          !spp ||
          String(info.bluetoothServiceClassId).toLowerCase() ===
            String(spp).toLowerCase();
        const line =
          `service class ${info.bluetoothServiceClassId}` +
          (isSpp ? " (standard SPP)" : " — NOT standard SPP");
        if (isSpp) log(line);
        else error(line);
      } else {
        error(
          "port reports no Bluetooth service class — not an RFCOMM port (a wired serial port may have been picked)",
        );
      }
    } catch (e) {
      error(`port.getInfo() failed: ${e?.message ?? e}`);
    }
  }

  // -------------------------------------------------------------------------
  // Disconnect detection
  // -------------------------------------------------------------------------

  /**
   * Report a link that went away on its own (not a user disconnect).
   * Idempotent: one drop can reach us through both the SDK hook and the
   * status string, and it should tear the session down once.
   */
  function handleDropped(reason) {
    if (disconnectReported) return;
    disconnectReported = true;
    const why = reason?.message ?? reason ?? "link lost";
    error(`disconnected: ${why}`);
    teardown();
    cfg.onDisconnected?.(reason);
  }

  function teardown() {
    try {
      detachDisconnect?.();
    } catch {
      /* nothing to detach */
    }
    detachDisconnect = null;
    session = null;
    setConnected(false);
  }

  /**
   * Wire status and disconnect callbacks on a freshly built client.
   *
   * Two paths, because the SDK grew the client-level hook after these pages
   * were written:
   *  - `client.onDisconnect` where it exists (added in SDK 0.1.22) — either a
   *    settable callback property or a subscribe method returning an
   *    unsubscribe, so both shapes are accepted;
   *  - otherwise watch `onStatus` for the exact SDK_DISCONNECT_STATUS string.
   *
   * Either way the page's own `onStatus` — which a factory may have assigned
   * before returning the client — is wrapped, not replaced, so it still
   * fires.
   */
  function wireClient(client) {
    const pageStatus =
      typeof client.onStatus === "function" ? client.onStatus : null;

    let hasHook = false;
    if (typeof client.onDisconnect === "function") {
      // Subscribe-method shape: onDisconnect(cb) -> unsubscribe.
      try {
        const off = client.onDisconnect((reason) => handleDropped(reason));
        detachDisconnect = typeof off === "function" ? off : null;
        hasHook = true;
      } catch {
        hasHook = false;
      }
    } else if ("onDisconnect" in client) {
      // Callback-property shape, like onStatus.
      client.onDisconnect = (reason) => handleDropped(reason);
      detachDisconnect = () => {
        client.onDisconnect = null;
      };
      hasHook = true;
    }

    client.onStatus = (msg) => {
      log(msg);
      pageStatus?.call(client, msg);
      if (!hasHook && String(msg) === SDK_DISCONNECT_STATUS) {
        handleDropped(new Error(SDK_DISCONNECT_STATUS));
      }
    };
  }

  // -------------------------------------------------------------------------
  // Connect / disconnect
  // -------------------------------------------------------------------------

  /**
   * Connect over `mode`, then hand the session to `afterConnect`.
   *
   * @param {"ble"|"rfcomm"|"usb"} mode
   * @returns {Promise<boolean>} true when a session is live
   */
  async function connectVia(mode) {
    if (session) {
      warn("already connected — disconnect first");
      return false;
    }
    const factory = makeClients[mode === "rfcomm" ? "bt" : mode];
    if (!factory) {
      error(`no client factory for ${MODE_LABELS[mode] ?? mode}`);
      return false;
    }
    const linkName = MODE_LABELS[mode] ?? mode;

    /* Declared OUTSIDE the try so the catch can still reach it. If connect()
     * rejects after the port opened, WebSerialTransport leaves the COM port
     * open, and a port nothing references can never be closed — the next
     * attempt then fails with "port already open" until the page is
     * reloaded. */
    let client = null;
    let transport = null;
    connecting = true;
    setConnected(false);
    try {
      const built = factory();
      // A factory may hand back the transport it built (the classic-BT path
      // needs it for logPortIdentity), or just the client.
      if (built && typeof built === "object" && "client" in built) {
        client = built.client;
        transport = built.transport ?? null;
      } else {
        client = built;
      }
      if (!client) throw new Error("client factory returned nothing");

      disconnectReported = false;
      wireClient(client);
      log(`connecting over ${linkName}…`);
      await client.connect();

      connecting = false;
      session = { client, mode, transport, label: linkName };
      setConnected(true, linkName);

      if (mode === "rfcomm" && transport) logPortIdentity(transport);

      /* Before anything else can fail: identifying what we connected to is
       * worth more than the rest of the session when a link misbehaves.
       * Diagnostic only, so a failure inside the hook is logged and never
       * allowed to tear down the connection it is reporting on. */
      try {
        await cfg.afterConnect?.(session);
      } catch (hookErr) {
        error(`post-connect diagnostics failed: ${hookErr?.message ?? hookErr}`);
      }
      return true;
    } catch (e) {
      /* Release the link before dropping the reference (see the comment on
       * `client` above). */
      try {
        await client?.disconnect();
      } catch {
        /* already down */
      }
      error(`Connect failed over ${linkName}: ${e?.message ?? e}`);
      for (const hint of connectFailureHints(mode, e)) warn(hint);
      connecting = false;
      teardown();
      return false;
    }
  }

  /**
   * Close the live session. A user-initiated disconnect, so it does NOT call
   * `onDisconnected` — the page asked for this and already knows.
   */
  async function disconnect() {
    const live = session;
    // Set before awaiting: the SDK emits its disconnect status from inside
    // this call, and that must not be reported as a dropped link.
    disconnectReported = true;
    if (!live) {
      setConnected(false);
      return;
    }
    try {
      await live.client?.disconnect();
    } catch (e) {
      warn(`disconnect reported an error: ${e?.message ?? e}`);
    } finally {
      teardown();
      log("disconnected");
    }
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  setConnected(false);

  if (cfg.announceStartup !== false) {
    /* Log which SDK build this page actually runs — a stale vendored bundle
     * is otherwise indistinguishable from a firmware fault. Read off the
     * namespace object so an older bundle (no SDK_VERSION export) degrades
     * to a warning instead of breaking the import. */
    if (sdkNs.SDK_VERSION) {
      log(`vendored shimmer-web-sdk v${sdkNs.SDK_VERSION}`);
    } else {
      warn(
        `WARNING: vendored shimmer-web-sdk predates v${MIN_USEFUL_SDK} — BLE record reads will truncate; re-vendor the SDK bundle`,
      );
    }

    /* Capability and guidance both come from the SDK, so every consumer says
     * the same accurate thing about each link: it owns the awkward facts
     * (Android serves Web Serial for RFCOMM only; iOS cannot reach classic
     * Bluetooth at any layer) and returns null when a link simply works.
     *
     * The dock deliberately gets the middle "unlikely" state as advice rather
     * than a disable: on Android `serial` in navigator is true while wired
     * ports are still rolling out, and no feature detection separates the
     * two, so a hard disable would lock out the phones where it does land. */
    const offered = [
      els.ble && "ble",
      els.bt && "rfcomm",
      els.usb && "usb",
    ].filter(Boolean);
    let firstAdvice = null;
    for (const mode of offered) {
      const advice = sdkNs.transportAdvice?.(support, MODE_NEEDS[mode]);
      if (!advice) continue;
      const blocked =
        mode === "ble" ? !support.webBluetooth : !support.webSerial;
      if (blocked) error(`note: ${advice}`);
      else warn(`note: ${advice}`);
      if (blocked && !firstAdvice) firstAdvice = advice;
    }
    // A banner only for a link that cannot work at all — advice about a
    // merely unlikely link belongs in the log, not above the page.
    if (firstAdvice && els.banner) {
      els.banner.className = "banner err";
      els.banner.textContent = firstAdvice;
    }
  }

  return {
    connectVia,
    disconnect,
    get session() {
      return session;
    },
    setConnected,
    support,
    connectFailureHints,
    logPortIdentity,
  };
}
