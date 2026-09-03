/**
 * Device naming: read and write the EEPROM brand record that decides the name
 * a sensor advertises over classic Bluetooth, the name it advertises over BLE,
 * and the product and manufacturer strings it presents over USB.
 *
 * Extracted from the retired `eeprom-branding` demo: the current-record readout and
 * its stock/custom/invalid pill (L305-344, L705-756), the four provisioning
 * fields with their per-field validation and live preview (L346-426,
 * L592-685), the record I/O with its read-back byte compare (L691-702,
 * L977-1012), the erase-to-factory path (L1014-1038) and the restart banner
 * with its two routes (L266-303, L556-581, L940-962). The ~350 lines of
 * connect, platform-advice and event-log plumbing that demo also carried are
 * deliberately NOT here — `common/connect-ui.js` and `common/ui-chrome.js`
 * own those now.
 *
 * The panel builds its own markup inside the host element and owns the
 * `disabled` state of every control in it, so a page mounts it with one
 * `<div>` and one call. It holds no page-specific ids and reads no page
 * globals: the only things it knows about the outside world are the client it
 * is handed, the log it writes to, and the callbacks below. That is what lets
 * a combined Verisense + Shimmer3 application mount it unchanged.
 *
 * Read and write are the same two calls on every link —
 * `readDaughterCardMem(BRAND_RECORD_HOST_OFFSET, BRAND_RECORD_SIZE)` and
 * `writeDaughterCardMem(BRAND_RECORD_HOST_OFFSET, bytes)` — which
 * `Shimmer3RClient`, `Shimmer3Client` and `WiredShimmerClient` all provide,
 * so this panel needs no per-transport branch at all. The only thing the link
 * decides is whether a soft restart can be requested; see
 * {@link createBrandEditor} and `opts.mode`.
 *
 * Nothing here touches `document` at import time.
 *
 *   import { createBrandEditor } from "../common/brand-editor.js";
 */

import { el } from "./ui-chrome.js";
/* The whole namespace rather than destructured names: a vendored bundle that
   predates one of the brand-record exports then degrades to a message from
   `createBrandEditor()` instead of breaking the importing page. Destructuring
   would throw at import time and take the whole page with it. */
import * as sdk from "../vendor/shimmer-web-sdk.esm.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hardware ids, as GET_DEVICE_VERSION reports them. */
const HW_ID = Object.freeze({ SHIMMER3: 3, SHIMMER3R: 10 });

/**
 * Factory USB manufacturer string, matching BRAND_DEFAULT_USB_MANUFACTURER in
 * log-and-stream-common `EEPROM/shimmer_eeprom.h`. Pre-filled into the form so
 * rebranding only the advertising name needs no retyping, and used to tell a
 * stock record from a custom one.
 */
const STOCK_MANUFACTURER = "Shimmer Research Ltd.";

/**
 * Factory defaults per platform, mirroring BRAND_DEFAULT_* in
 * log-and-stream-common `EEPROM/shimmer_eeprom.h`.
 *
 * Deliberately keyed by hardware id and deliberately incomplete: there is no
 * entry for "unknown", so {@link createBrandEditor}'s `isStockRecord` returns
 * null rather than guessing when the sensor never said what it is.
 */
const STOCK_DEFAULTS = Object.freeze({
  [HW_ID.SHIMMER3]: Object.freeze({
    btClassic: "Shimmer3",
    ble: "S3BLE",
    usbProduct: "Shimmer",
  }),
  [HW_ID.SHIMMER3R]: Object.freeze({
    btClassic: "Shimmer3R",
    ble: "Shimmer3R",
    usbProduct: "Shimmer",
  }),
});

/**
 * Link names that carry the Bluetooth command set, and therefore SET_FEATURE.
 *
 * A soft restart is a Bluetooth command, so it is available over BLE and over
 * classic Bluetooth but NOT over the dock UART, whose protocol has no
 * equivalent property. Today the method check alone would be enough — the
 * wired client does not carry `setRebootOnDisconnect` at all — but naming the
 * link keeps the reason visible instead of leaving it an accident of feature
 * detection, exactly as `describeShimmer3Caps` does for streaming.
 */
const BLUETOOTH_LINKS = new Set(["ble", "rfcomm", "btclassic", "bt", "spp"]);

/** The four names in the record, in the order the form shows them. */
const FIELD_DEFS = Object.freeze([
  Object.freeze({
    key: "btClassic",
    label: "Classic Bluetooth prefix",
    placeholder: "e.g. YourBrand",
    blankProblem: "enter a name",
    hint: "The one name everything else falls back to.",
  }),
  Object.freeze({
    key: "ble",
    label: "BLE prefix",
    placeholder: "derived from the classic Bluetooth prefix",
    blankProblem: "enter a name",
    hint: "Leave blank to reuse the classic Bluetooth prefix.",
  }),
  Object.freeze({
    key: "usbProduct",
    label: "USB product prefix",
    placeholder: "derived from the classic Bluetooth prefix",
    blankProblem: "enter a name",
    hint: "Leave blank to reuse the classic Bluetooth prefix.",
  }),
  Object.freeze({
    key: "usbManufacturer",
    label: "USB manufacturer",
    placeholder: "e.g. YourBrand Ltd.",
    blankProblem: "enter a manufacturer name",
    /* Never derived: the USB device descriptor uses this string verbatim, so
       there is nothing sensible to derive it FROM. A blank one is reported as
       an error rather than silently filled, because it is pre-filled — an
       empty box means the user cleared it on purpose. */
    hint: "Used verbatim; never derived from the other names.",
  }),
]);

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Mount the device-naming editor inside `host`.
 *
 * @param {HTMLElement} host an empty container; its contents are replaced
 * @param {object} opts
 * @param {object|(() => object|null)} opts.client the connected client, or a
 *   getter for it. Pass the GETTER form from a page whose client comes and
 *   goes with the link — the panel is mounted once and then reads whatever is
 *   current, so it can never hold a stale client.
 * @param {number|null|(() => number|null)} [opts.identifiedHardwareVersion]
 *   the hardware id the sensor ACTUALLY REPORTED, or `null`/`undefined` when
 *   identification failed.
 *
 *   READ THIS BEFORE WIRING IT UP. It must be the raw identification result,
 *   never a defaulted one. Pages routinely default an unknown hardware
 *   version to a Shimmer3R when they build an InfoMem context, because the
 *   field schema needs *some* layout to render; passing that default here
 *   defeats the conservative BLE cap in precisely the case it exists for —
 *   an unidentified Shimmer3 would be offered a 10-character BLE prefix that
 *   its own firmware truncates to 8 on air. When in doubt pass nothing: the
 *   panel then assumes the shorter cap, which is safe on both platforms.
 * @param {string|null|(() => string|null)} [opts.macSuffix] last four MAC
 *   characters, for the name preview; `null` when it could not be read
 * @param {string|null|(() => string|null)} [opts.mode] which link the client
 *   is on — see {@link BLUETOOTH_LINKS}. Only decides whether the soft
 *   restart is offered; reading and writing work on every link.
 * @param {{log: Function, warn: Function, error: Function}} [opts.log]
 * @param {(busy: boolean) => void} [opts.onBusyChange] called when a record
 *   read, write or erase starts and finishes. A host page folds this into its
 *   own busy state, so the controls that share the link (Apply, an SD
 *   transfer) are refused while a name write is in flight.
 * @param {(message: string, kind?: string) => void} [opts.toast] optional
 *   transient notification hook, e.g. `showToast` from `ui-chrome.js`
 * @param {(text: string) => boolean} [opts.confirm] confirmation prompt;
 *   defaults to `window.confirm`
 * @param {() => Promise<void>|void} [opts.disconnect] how the host page drops
 *   the link after a soft restart is armed. Defaults to `client.disconnect()`,
 *   which is right for a single-purpose page and wrong for one that also has a
 *   recording to close, so pass the page's own teardown.
 * @returns {{
 *   read: () => Promise<object|null>,
 *   write: () => Promise<boolean>,
 *   restoreDefaults: () => Promise<boolean>,
 *   armRestart: () => Promise<boolean>,
 *   record: () => object|null,
 *   fields: () => {btClassic: string, ble: string, usbProduct: string, usbManufacturer: string},
 *   setFields: (patch: object) => void,
 *   bleCap: () => number,
 *   stockDefaults: () => object|null,
 *   isStockRecord: (record?: object|null) => boolean|null,
 *   canSoftRestart: () => boolean,
 *   dismissRestartBanner: () => void,
 *   setEnabled: (enabled: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createBrandEditor(host, opts = {}) {
  const getClient =
    typeof opts.client === "function" ? opts.client : () => opts.client ?? null;
  const log = opts.log ?? { log() {}, warn() {}, error() {} };
  const toast = opts.toast ?? (() => {});
  const ask = opts.confirm ?? ((text) => window.confirm(text));
  const getHardware = asGetter(opts.identifiedHardwareVersion);
  const getMacSuffix = asGetter(opts.macSuffix);
  const getMode = asGetter(opts.mode);

  /** The record last read from (or verified on) the sensor, or null. */
  let record = null;
  /** A record read, write or erase is in flight. */
  let busy = false;
  /** The floor the host page sets: can this link reach the record at all? */
  let enabled = false;
  /**
   * Sticky once the firmware has NACKed the soft-restart feature id, so the
   * banner keeps offering the manual power-cycle rather than a button that has
   * already been refused once.
   */
  let softRestartRefused = false;
  let destroyed = false;

  /* A vendored bundle from before the brand record shipped: say so once,
     here, rather than throwing from the first button press. The constants
     matter as much as the functions — an undefined offset or length would
     reach `readDaughterCardMem` and fail there instead, where the message
     would be about a bad argument rather than about a stale bundle. */
  const missing = [
    ...[
      "parseBrandRecord",
      "buildBrandRecord",
      "buildBlankBrandRecord",
      "brandNameProblem",
    ].filter((name) => typeof sdk[name] !== "function"),
    ...[
      "BRAND_RECORD_HOST_OFFSET",
      "BRAND_RECORD_SIZE",
      "BRAND_BT_CLASSIC_MAX_CHARS",
      "BRAND_BLE_MAX_CHARS",
      "BRAND_BLE_MAX_CHARS_SHIMMER3",
      "BRAND_USB_PRODUCT_MAX_CHARS",
      "BRAND_USB_MANUFACTURER_MAX_CHARS",
    ].filter((name) => typeof sdk[name] !== "number"),
  ];
  if (missing.length) {
    host.replaceChildren(
      el(
        "div",
        { class: "banner err" },
        `This page is running an SDK bundle with no brand-record support (missing ${missing.join(", ")}). Re-vendor the SDK to read or change the names this sensor advertises.`,
      ),
    );
    log.error(
      `device naming unavailable: the vendored SDK has no ${missing.join(", ")}`,
    );
    return inertPanel();
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  const stat = (key, label) =>
    el(
      "div",
      {},
      el("span", { class: "stat-label" }, label),
      el("span", { class: "stat-value", dataset: { brandStat: key } }, "–"),
    );

  const statsStrip = el(
    "div",
    { class: "stats" },
    stat("btClassic", "Classic Bluetooth"),
    stat("ble", "BLE"),
    stat("usbProduct", "USB product"),
    stat("usbManufacturer", "USB manufacturer"),
    stat("device", "Sensor"),
    stat("mac", "MAC suffix"),
  );

  const setStat = (key, text) => {
    const node = statsStrip.querySelector(`[data-brand-stat="${key}"]`);
    if (node) node.textContent = text ?? "–";
  };

  /* `data-brand-role` on every control the panel owns. Not decoration: it is
     how a mounting application (or a test) addresses one of these without the
     panel having to plant ids that would collide if it were mounted twice on
     one page. */
  const recordPill = el(
    "span",
    { class: "pill", dataset: { brandRole: "recordPill" } },
    "not read",
  );
  const btnRead = el(
    "button",
    { type: "button", dataset: { brandRole: "read" } },
    "Read names from sensor",
  );
  const recordNote = el("div", {
    class: "field-hint",
    dataset: { brandRole: "recordNote" },
  });

  /** key -> {input, preview, error, wrap} */
  const rows = new Map();
  for (const def of FIELD_DEFS) {
    const input = el("input", {
      type: "text",
      placeholder: def.placeholder,
      autocomplete: "off",
      spellcheck: "false",
      dataset: { brandInput: def.key },
      oninput: sync,
      onchange: sync,
    });
    const preview = el("div", {
      class: "brand-preview",
      dataset: { brandPreview: def.key },
    });
    const error = el("div", {
      class: "brand-error",
      dataset: { brandError: def.key },
    });
    const wrap = el(
      "div",
      { class: "field", dataset: { brandField: def.key } },
      /* The input sits INSIDE its label rather than being tied to it by id: a
         panel a page can mount twice must not plant a fixed id. */
      el("label", {}, def.label, input),
      el("div", { class: "field-hint" }, def.hint),
      preview,
      error,
    );
    rows.set(def.key, { def, input, preview, error, wrap });
  }

  const btnWrite = el(
    "button",
    { type: "button", class: "primary", dataset: { brandRole: "write" } },
    "Write names to sensor",
  );
  const btnRestore = el(
    "button",
    {
      type: "button",
      class: "danger",
      dataset: { brandRole: "restore" },
      title:
        "Erases the brand record. The firmware re-seeds the factory names at " +
        "the next restart.",
    },
    "Restore factory names",
  );

  // The restart banner, hidden until a write or an erase has landed.
  const restartAuto = el(
    "div",
    { dataset: { brandRole: "restartAuto" } },
    "Restart now arms a one-shot restart and drops the link — the sensor " +
      "restarts by itself as the link goes, then advertises the new names.",
  );
  const restartManual = el(
    "div",
    { dataset: { brandRole: "restartManual" } },
    "This link cannot ask for a restart — the dock/USB serial protocol has no " +
      "such command — so power-cycle the sensor by hand:",
    el(
      "ol",
      { class: "brand-steps" },
      el("li", {}, "Disconnect this page from the sensor, or unplug it."),
      el(
        "li",
        {},
        "Shimmer3: undock and re-dock it, or briefly press the reset pin " +
          "through the hole in the enclosure. Shimmer3R: hold the button to " +
          "power it off, then on again, or undock and re-dock it.",
      ),
      el(
        "li",
        {},
        "Reconnect and read the names again to confirm, or look for the new " +
          "name in a Bluetooth scan.",
      ),
    ),
  );
  const btnRestart = el(
    "button",
    { type: "button", class: "primary", dataset: { brandRole: "restart" } },
    "Restart now",
  );
  const btnDismiss = el(
    "button",
    { type: "button", class: "secondary", dataset: { brandRole: "dismiss" } },
    "Dismiss",
  );
  const restartCard = el(
    "div",
    { class: "card", dataset: { brandRole: "restart-banner" }, hidden: true },
    el(
      "div",
      { class: "banner warn" },
      el(
        "strong",
        {},
        "Restart needed — the new names are stored but not in use yet",
      ),
      el(
        "div",
        {},
        "The Bluetooth module only picks up its name when Bluetooth starts, " +
          "and the BLE advertising name cannot change while advertising is " +
          "running, so the sensor has to restart before it announces itself " +
          "differently.",
      ),
      restartAuto,
      restartManual,
      el("div", { class: "row" }, btnRestart, btnDismiss),
    ),
  );

  host.replaceChildren(
    restartCard,
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-title" }, "Names on this sensor ", recordPill),
      statsStrip,
      el("div", { class: "row" }, btnRead),
      recordNote,
    ),
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-title" }, "New names"),
      el(
        "div",
        { class: "grid" },
        FIELD_DEFS.map((def) => rows.get(def.key).wrap),
      ),
      el("div", { class: "row" }, btnWrite, btnRestore),
      el(
        "div",
        { class: "field-hint" },
        "Printable ASCII, no commas. The firmware appends the MAC suffix to " +
          "the classic Bluetooth, BLE and USB product names; the USB " +
          "manufacturer string is used exactly as typed. The record is never " +
          "write-protected — it stays rewritable and erasable from here — and " +
          "every write is CRC-protected, so a garbled record simply reverts " +
          "to the factory names at the next restart.",
      ),
    ),
  );

  // -------------------------------------------------------------------------
  // Hardware-dependent rules
  // -------------------------------------------------------------------------

  /**
   * The BLE prefix length this sensor can actually advertise.
   *
   * The full field width is offered ONLY when the sensor is positively
   * identified as a Shimmer3R. Anything else — a Shimmer3, or a sensor whose
   * identification failed — gets the shorter Shimmer3 cap, because Shimmer3
   * firmware truncates the prefix to 8 characters so "<prefix>-XXXX" fits the
   * RN4678's 31-byte advertisement. Guessing the wrong way here writes a name
   * the device silently shortens on air, which is invisible from this page.
   */
  function bleCap() {
    return getHardware() === HW_ID.SHIMMER3R
      ? sdk.BRAND_BLE_MAX_CHARS
      : sdk.BRAND_BLE_MAX_CHARS_SHIMMER3;
  }

  function capFor(key) {
    if (key === "btClassic") return sdk.BRAND_BT_CLASSIC_MAX_CHARS;
    if (key === "ble") return bleCap();
    if (key === "usbProduct") return sdk.BRAND_USB_PRODUCT_MAX_CHARS;
    return sdk.BRAND_USB_MANUFACTURER_MAX_CHARS;
  }

  function deviceLabel() {
    const hw = getHardware();
    if (hw === HW_ID.SHIMMER3) return "Shimmer3";
    if (hw === HW_ID.SHIMMER3R) return "Shimmer3R";
    return "not identified";
  }

  /** The factory names for this platform, or null when it is unknown. */
  function stockDefaults() {
    const d = STOCK_DEFAULTS[getHardware()];
    return d ? { ...d, usbManufacturer: STOCK_MANUFACTURER } : null;
  }

  /**
   * Is this record the factory one?
   *
   * Returns **null** when the hardware version is unknown: there is no
   * platform to compare against, and reporting "custom" for a record that may
   * be perfectly stock would send somebody looking for a brand that is not
   * there. Declining to judge is the honest third answer.
   *
   * Derived by comparing the names rather than read from a flag, because
   * firmware no longer stores one — the stock manufacturer string lives in the
   * record itself, so the record is applied unconditionally.
   *
   * @param {object|null} [rec] defaults to the record last read
   * @returns {boolean|null}
   */
  function isStockRecord(rec = record) {
    const d = stockDefaults();
    if (!rec || !d) return null;
    return (
      rec.btClassic === d.btClassic &&
      rec.ble === d.ble &&
      rec.usbProduct === d.usbProduct &&
      rec.usbManufacturer === d.usbManufacturer
    );
  }

  /**
   * Can this link ask the sensor to restart itself?
   *
   * SET_FEATURE / FEATURE_REBOOT_ON_DISCONNECT is a Bluetooth command, so a
   * BLE or classic-Bluetooth link can arm it; the dock UART cannot.
   */
  function canSoftRestart() {
    if (softRestartRefused) return false;
    const client = getClient();
    return (
      BLUETOOTH_LINKS.has(String(getMode() ?? "")) &&
      typeof client?.setRebootOnDisconnect === "function"
    );
  }

  // -------------------------------------------------------------------------
  // The form
  // -------------------------------------------------------------------------

  /**
   * What will actually be written, after the derivation rules.
   *
   * The BLE and USB *product* prefixes fall back to the classic Bluetooth
   * prefix when left blank, so a customer need only type one name. The USB
   * *manufacturer* never derives: the device descriptor uses it verbatim.
   *
   * A TYPED name is taken exactly as typed, so one that is too long is
   * refused by the validation below rather than quietly shortened; only a
   * DERIVED name is truncated to fit, because nobody typed it and the
   * alternative is refusing a classic prefix for being too long for a field
   * the user never filled in. The original demo truncated both, and its BLE
   * box kept a fixed maxlength of 10 while the cap could be 8 — so on a
   * Shimmer3 a name typed in full was silently cut by two characters with
   * nothing on screen to say so.
   *
   * @returns {{btClassic: string, ble: string, usbProduct: string, usbManufacturer: string}}
   */
  function effectiveFields() {
    const btClassic = rows.get("btClassic").input.value.trim();
    const rawBle = rows.get("ble").input.value.trim();
    const rawProduct = rows.get("usbProduct").input.value.trim();
    return {
      btClassic,
      ble: rawBle || btClassic.slice(0, bleCap()),
      usbProduct:
        rawProduct || btClassic.slice(0, sdk.BRAND_USB_PRODUCT_MAX_CHARS),
      usbManufacturer: rows.get("usbManufacturer").input.value.trim(),
    };
  }

  /** Per-field problem, or null. Keyed the same as {@link effectiveFields}. */
  function fieldProblems(eff = effectiveFields()) {
    const out = {};
    for (const def of FIELD_DEFS) {
      const value = eff[def.key];
      out[def.key] = value
        ? sdk.brandNameProblem(value, capFor(def.key))
        : def.blankProblem;
    }
    return out;
  }

  /** The advertised name a prefix produces, per platform. */
  function previewFor(key, eff) {
    const hw = getHardware();
    const sfx = getMacSuffix() || "XXXX";
    const value = eff[key];
    if (!value) return "";
    if (key === "usbManufacturer") {
      if (hw === HW_ID.SHIMMER3) {
        /* A Shimmer3's USB is the dock's own bridge chip, so this string never
           reaches a USB descriptor; the RN4678 does carry a 7-character
           manufacturer field, which is where it lands instead. */
        return `→ BLE module manufacturer "${value.slice(0, 7)}" (the field fits 7 characters)`;
      }
      return `→ USB manufacturer "${value}"`;
    }
    if (key === "usbProduct") {
      if (hw === HW_ID.SHIMMER3) {
        return "→ unused on a Shimmer3 — its USB is the dock's own bridge chip";
      }
      if (hw === HW_ID.SHIMMER3R) return `→ USB product "${value} ${sfx}"`;
      return `→ USB product "${value} ${sfx}" on a Shimmer3R; unused on a Shimmer3`;
    }
    const tail = key === "ble" ? "-BLE" : "-BT";
    if (hw === HW_ID.SHIMMER3) return `→ ${value}-${sfx}`;
    if (hw === HW_ID.SHIMMER3R) return `→ ${value}-${sfx}${tail}`;
    /* Hardware not identified. The BLE cap has already been narrowed to the
       Shimmer3 one; the SHAPE of the advertised name still differs between the
       platforms, and asserting either would be a claim this panel cannot
       back. */
    return `→ ${value}-${sfx} on a Shimmer3, ${value}-${sfx}${tail} on a Shimmer3R`;
  }

  /**
   * One writer for every `disabled` in this panel, plus the validation and the
   * preview, so there is a single place that decides what the form looks like.
   *
   * `enabled` is the host page's floor — can this link reach the record at all
   * — and nothing here lifts it.
   */
  function sync() {
    if (destroyed) return;
    const client = getClient();
    const usable = enabled && !!client && !busy;
    const eff = effectiveFields();
    const problems = fieldProblems(eff);
    const anyProblem = FIELD_DEFS.some((def) => problems[def.key]);

    for (const def of FIELD_DEFS) {
      const row = rows.get(def.key);
      const problem = problems[def.key];
      row.input.disabled = busy;
      row.input.maxLength = capFor(def.key);
      row.preview.textContent = previewFor(def.key, eff);
      /* Quiet while there is nothing to write to: an empty form under a
         disconnected page is not a mistake anyone has made yet. */
      row.error.textContent = usable ? (problem ?? "") : "";
      row.input.classList.toggle("bad", !!(usable && problem));
    }

    /* Derivation truncates rather than refusing — a 16-character classic
       prefix cannot fit the BLE field — so say so where it happens, because
       the value that gets written is otherwise indistinguishable from one
       that was typed. */
    for (const key of ["ble", "usbProduct"]) {
      const row = rows.get(key);
      if (!row.input.value.trim() && eff[key] && eff[key] !== eff.btClassic) {
        row.preview.textContent +=
          "  (truncated from the classic Bluetooth prefix)";
      }
    }

    btnRead.disabled = !usable;
    btnWrite.disabled = !usable || anyProblem;
    btnRestore.disabled = !usable;
    btnRestart.disabled = !usable || !canSoftRestart();
    paintRestartBanner();
  }

  /**
   * The guard every device operation starts with.
   *
   * `enabled` is checked here and not only on the buttons: it is the host
   * page's statement that this link can be used for this right now — a stream
   * is not running, an SD transfer is not holding the link — and a
   * programmatic caller must be held to it too, or a name write could
   * interleave with a file transfer's block stream on the one link they share.
   *
   * @param {string} what
   * @returns {object|null} the client to use, or null when it must not proceed
   */
  function clientFor(what) {
    const client = getClient();
    if (!client) {
      log.warn(`Connect a sensor before ${what}.`);
      return null;
    }
    if (!enabled) {
      log.warn(
        `Not ${what}: the sensor's names cannot be reached over this link right now.`,
      );
      return null;
    }
    if (busy) {
      log.warn("A device-naming operation is already running.");
      return null;
    }
    return client;
  }

  function setBusy(next) {
    if (busy === next) return;
    busy = next;
    sync();
    try {
      opts.onBusyChange?.(next);
    } catch (err) {
      log.warn(`device-naming busy handler failed: ${err?.message ?? err}`);
    }
  }

  /** Fill the form. Values are taken as typed, not as effective. */
  function setFields(patch = {}) {
    for (const def of FIELD_DEFS) {
      if (patch[def.key] === undefined) continue;
      rows.get(def.key).input.value = String(patch[def.key] ?? "");
    }
    sync();
  }

  // -------------------------------------------------------------------------
  // The readout
  // -------------------------------------------------------------------------

  function showRecord(rec) {
    record = rec;
    setStat("btClassic", rec.btClassic || "–");
    setStat("ble", rec.ble || "–");
    setStat("usbProduct", rec.usbProduct || "–");
    setStat("usbManufacturer", rec.usbManufacturer || "–");
    setStat("device", deviceLabel());
    setStat("mac", getMacSuffix() || "unknown");

    if (!rec.valid) {
      recordPill.textContent = `invalid: ${rec.invalidReason}`;
      recordPill.className = "pill err";
      recordNote.textContent =
        `The record does not check out (${rec.invalidReason}), so the sensor ` +
        "is using its factory names. This is not a fault: the firmware " +
        "re-seeds the factory record at the next restart.";
      sync();
      return;
    }

    const stock = isStockRecord(rec);
    const platform =
      Object.entries(sdk.BRAND_PLATFORM ?? {}).find(
        ([, v]) => v === rec.seededPlatform,
      )?.[0] ?? "an unknown platform";
    recordPill.textContent =
      stock === null
        ? "valid"
        : stock
          ? "valid · factory names"
          : "valid · custom names";
    recordPill.className = "pill on";
    recordNote.textContent =
      stock === null
        ? "This sensor did not report which hardware it is, so this page " +
          "cannot say whether these are the factory names or a custom set — " +
          "and it assumes the shorter Shimmer3 limit for the BLE prefix."
        : stock
          ? `These are the factory names, seeded by ${platform}.`
          : "These are custom names, not the factory set.";
    sync();
  }

  /** Forget the sensor: no record, no readouts. */
  function clearRecord() {
    record = null;
    for (const key of [
      "btClassic",
      "ble",
      "usbProduct",
      "usbManufacturer",
      "device",
      "mac",
    ]) {
      setStat(key, "–");
    }
    recordPill.textContent = "not read";
    recordPill.className = "pill";
    recordNote.textContent = "";
    softRestartRefused = false;
  }

  // -------------------------------------------------------------------------
  // The restart banner
  // -------------------------------------------------------------------------

  /**
   * Show whichever restart route this link actually has.
   *
   * Called from `sync`, so the route follows the link rather than being
   * decided once: a page that reconnects over the dock after arming a restart
   * over BLE gets the manual walkthrough without the panel being rebuilt.
   */
  function paintRestartBanner() {
    const auto = canSoftRestart();
    restartAuto.hidden = !auto;
    restartManual.hidden = auto;
    btnRestart.hidden = !auto;
  }

  function showRestartBanner() {
    paintRestartBanner();
    restartCard.hidden = false;
    restartCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function dismissRestartBanner() {
    restartCard.hidden = true;
  }

  // -------------------------------------------------------------------------
  // Record I/O
  // -------------------------------------------------------------------------

  /**
   * Rephrase a read failure as something the reader can act on.
   *
   * A truncated response and a stale SDK bundle look identical from the
   * outside — both report fewer bytes than were asked for — and the fix for
   * one is nothing like the fix for the other.
   */
  function readFailureHint(err) {
    const raw = String(err?.message ?? err ?? "unknown error");
    if (/response truncated/i.test(raw)) {
      return `${raw} — the link dropped mid-response; try again, and check the sensor is in range`;
    }
    if (/returned \d+ of \d+ bytes/.test(raw)) {
      return `${raw} — this page is running a stale SDK bundle (it needs 0.1.12 or later); hard-refresh, or re-vendor the SDK`;
    }
    if (/NACK/i.test(raw)) {
      return `${raw} — the sensor refused the read; its firmware may predate the brand record`;
    }
    return `${raw} — check the firmware supports the brand record`;
  }

  function firstDifference(a, b) {
    if (a.length !== b.length) return Math.min(a.length, b.length);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
    return -1;
  }

  function readBytes(client) {
    return client.readDaughterCardMem(
      sdk.BRAND_RECORD_HOST_OFFSET,
      sdk.BRAND_RECORD_SIZE,
    );
  }

  /**
   * Read the record and show it.
   *
   * @returns {Promise<object|null>} the parsed record, or null on failure
   */
  async function read() {
    const client = clientFor("reading the names it advertises");
    if (!client) return null;
    setBusy(true);
    try {
      log.log(
        `reading the brand record (${sdk.BRAND_RECORD_SIZE} B at expansion-board offset ${sdk.BRAND_RECORD_HOST_OFFSET})…`,
      );
      const bytes = await readBytes(client);
      const rec = sdk.parseBrandRecord(bytes);
      showRecord(rec);
      /* The manufacturer box follows the DEVICE, not the factory string.
         Pre-filling it with "Shimmer Research Ltd." and never updating it
         would silently reset a customer's own manufacturer the next time
         somebody changed only the Bluetooth name. */
      setFields({
        usbManufacturer:
          rec.valid && rec.usbManufacturer
            ? rec.usbManufacturer
            : STOCK_MANUFACTURER,
      });
      log.log(
        rec.valid
          ? `names on the sensor: classic Bluetooth "${rec.btClassic}" · BLE "${rec.ble}" · USB product "${rec.usbProduct}" · USB manufacturer "${rec.usbManufacturer}"`
          : `the brand record is invalid (${rec.invalidReason}) — the sensor is using its factory names`,
      );
      return rec;
    } catch (err) {
      const message = `Reading the names failed: ${readFailureHint(err)}`;
      log.error(message);
      toast(message, "err");
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** `  Label   old -> new` lines for a confirmation prompt. */
  function changeLines(next) {
    const pad = Math.max(...FIELD_DEFS.map((d) => d.label.length));
    return FIELD_DEFS.map((def) => {
      const was = record?.valid ? record[def.key] : null;
      const label = def.label.padEnd(pad);
      if (next[def.key] === undefined) return `  ${label}  ${was ?? "?"}`;
      if (was === null) return `  ${label}  → ${next[def.key]}`;
      if (was === next[def.key]) {
        return `  ${label}  ${was}   (unchanged)`;
      }
      return `  ${label}  ${was} → ${next[def.key]}`;
    }).join("\n");
  }

  /**
   * Write the form to the sensor, then read it back and byte-compare.
   *
   * @returns {Promise<boolean>} true when the write verified
   */
  async function write() {
    const client = clientFor("changing the names it advertises");
    if (!client) return false;
    const eff = effectiveFields();
    const problems = fieldProblems(eff);
    const bad = FIELD_DEFS.filter((def) => problems[def.key]);
    if (bad.length) {
      /* Should be unreachable from the button, which is disabled — but this is
         also the programmatic entry point, and a write that shipped a name the
         firmware rejects would leave the record CRC-valid and wrong. */
      log.warn(
        `not writing: ${bad.map((def) => `${def.label} — ${problems[def.key]}`).join("; ")}`,
      );
      sync();
      return false;
    }

    let bytes;
    try {
      /* Always the SDK's builder, never a hand-rolled record: it owns the
         magic, the layout version, the length bytes and the CRC, and a record
         whose CRC is wrong is one the firmware throws away at the next boot. */
      bytes = sdk.buildBrandRecord(eff);
    } catch (err) {
      log.error(`the brand record could not be built: ${err?.message ?? err}`);
      return false;
    }

    if (
      !ask(
        "Change the names this sensor advertises?\n\n" +
          `${changeLines(eff)}\n\n` +
          (record?.valid
            ? ""
            : "The record currently on the sensor is blank or invalid, so " +
              "there is nothing to compare against.\n\n") +
          "The record is written, read back and compared byte for byte. The " +
          "new names are only advertised after the sensor restarts.",
      )
    ) {
      log.log("name change cancelled");
      return false;
    }

    setBusy(true);
    try {
      log.log(
        `writing names: classic Bluetooth "${eff.btClassic}" · BLE "${eff.ble}" · USB product "${eff.usbProduct}" · USB manufacturer "${eff.usbManufacturer}"`,
      );
      await client.writeDaughterCardMem(sdk.BRAND_RECORD_HOST_OFFSET, bytes);
      const verify = await readBytes(client);
      const at = firstDifference(bytes, verify);
      if (at >= 0) {
        const message =
          `The names were written but the read-back differs at byte ${at}, ` +
          "so the record is NOT provisioned correctly — try the write again.";
        log.error(message);
        toast(message, "err");
        showRecord(sdk.parseBrandRecord(verify));
        return false;
      }
      showRecord(sdk.parseBrandRecord(verify));
      log.log(
        "names written and verified — the read-back matches byte for byte",
      );
      toast(
        "Names written and verified. The sensor has to restart before it advertises them.",
        "ok",
      );
      showRestartBanner();
      return true;
    } catch (err) {
      const message = `Writing the names failed: ${err?.message ?? err}`;
      log.error(message);
      toast(message, "err");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Erase the record so the firmware re-seeds the factory names.
   *
   * Erasing rather than writing this page's own idea of the factory names is
   * deliberate: the firmware is the authority on what "factory" means for the
   * platform it is running on, {@link STOCK_DEFAULTS} is only a transcription
   * of a C header, and an erase is the one restore that also works on a sensor
   * that never said what hardware it is.
   *
   * @returns {Promise<boolean>} true when the erase verified
   */
  async function restoreDefaults() {
    const client = clientFor("restoring its factory names");
    if (!client) return false;
    const d = stockDefaults();
    if (
      !ask(
        "Erase the brand record and go back to the factory names?\n\n" +
          `${changeLines(d ?? {})}\n\n` +
          (d
            ? ""
            : "This sensor did not report which hardware it is, so the exact " +
              "factory names cannot be shown here — the firmware picks the " +
              "right ones for its own platform.\n\n") +
          "The record is erased. The firmware re-seeds the factory names at " +
          "the next restart.",
      )
    ) {
      log.log("factory-name restore cancelled");
      return false;
    }

    setBusy(true);
    try {
      const blank = sdk.buildBlankBrandRecord();
      log.log("erasing the brand record…");
      await client.writeDaughterCardMem(sdk.BRAND_RECORD_HOST_OFFSET, blank);
      const verify = await readBytes(client);
      const at = firstDifference(blank, verify);
      const rec = sdk.parseBrandRecord(verify);
      showRecord(rec);
      if (at >= 0 || rec.valid) {
        const message =
          at >= 0
            ? `The erase did not take: byte ${at} still differs from an erased record.`
            : "The erase did not take: the record still reads as valid.";
        log.error(message);
        toast(message, "err");
        return false;
      }
      setFields({
        btClassic: "",
        ble: "",
        usbProduct: "",
        usbManufacturer: STOCK_MANUFACTURER,
      });
      log.log(
        "erase verified — the firmware re-seeds the factory names at the next restart",
      );
      toast(
        "Brand record erased. The factory names come back when the sensor restarts.",
        "ok",
      );
      showRestartBanner();
      return true;
    } catch (err) {
      const message = `Erasing the brand record failed: ${err?.message ?? err}`;
      log.error(message);
      toast(message, "err");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Arm the one-shot soft restart, then drop the link so it fires.
   *
   * The restart cannot happen while still connected — the Bluetooth module has
   * to come up again to re-read its name — so arming and disconnecting are one
   * action, not two.
   *
   * @returns {Promise<boolean>} true when the restart was armed and the link
   *   dropped
   */
  async function armRestart() {
    const client = clientFor("asking the sensor to restart");
    if (!client) return false;
    if (!canSoftRestart()) {
      log.warn(
        "This link cannot ask the sensor to restart — power-cycle it by hand.",
      );
      paintRestartBanner();
      return false;
    }
    setBusy(true);
    try {
      log.log("arming the restart that fires when this host disconnects…");
      await client.setRebootOnDisconnect(true);
    } catch (err) {
      /* Firmware without FEATURE_REBOOT_ON_DISCONNECT NACKs the unknown
         feature id. Fall back to the manual instructions rather than leaving
         the reader believing a restart has been arranged. */
      softRestartRefused = true;
      const message = `The sensor would not arm a restart (${err?.message ?? err}) — power-cycle it by hand instead.`;
      log.error(message);
      toast(message, "warn");
      paintRestartBanner();
      return false;
    } finally {
      setBusy(false);
    }
    log.log("restart armed — disconnecting so the sensor restarts");
    try {
      await (opts.disconnect ? opts.disconnect() : client.disconnect());
    } catch (err) {
      log.warn(`disconnect reported an error: ${err?.message ?? err}`);
    }
    dismissRestartBanner();
    log.log(
      "the sensor should be restarting; reconnect in a few seconds and read the names to confirm",
    );
    return true;
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
  btnRestore.addEventListener("click", () => {
    restoreDefaults().catch(() => {});
  });
  btnRestart.addEventListener("click", () => {
    armRestart().catch(() => {});
  });
  btnDismiss.addEventListener("click", dismissRestartBanner);

  setFields({ usbManufacturer: STOCK_MANUFACTURER });
  clearRecord();
  sync();

  return {
    read,
    write,
    restoreDefaults,
    armRestart,
    record: () => record,
    fields: effectiveFields,
    setFields,
    bleCap,
    stockDefaults,
    isStockRecord,
    canSoftRestart,
    dismissRestartBanner,
    setEnabled(next) {
      const was = enabled;
      enabled = !!next;
      /* On the falling edge only. A link that can no longer reach the record
         has no record to show, and keeping a stale one would let the next
         sensor to connect be judged stock or custom on the last one's names —
         but this runs on every re-gate, so it must not fire while already
         disabled or it would wipe the panel continuously.
         NOTE for the host page: do NOT fold this panel's own busy state back
         into what you pass here, or the read that follows a write clears the
         record the write just verified. The panel already refuses a second
         operation itself.
         The restart banner deliberately SURVIVES this: on a link that cannot
         soft-restart, its instructions are what the reader needs *after*
         disconnecting. */
      if (was && !enabled) clearRecord();
      sync();
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
 * brand-record support. A host page then gates and mounts exactly as it
 * always does and gets a message on screen instead of a thrown import.
 */
function inertPanel() {
  const no = async () => false;
  return {
    read: async () => null,
    write: no,
    restoreDefaults: no,
    armRestart: no,
    record: () => null,
    fields: () => ({
      btClassic: "",
      ble: "",
      usbProduct: "",
      usbManufacturer: "",
    }),
    setFields() {},
    bleCap: () => 0,
    stockDefaults: () => null,
    isStockRecord: () => null,
    canSoftRestart: () => false,
    dismissRestartBanner() {},
    setEnabled() {},
    destroy() {},
  };
}
