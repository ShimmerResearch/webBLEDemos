/**
 * Generic, schema-driven configuration form.
 *
 * Renders one editable control per declarative field definition, grouped into
 * collapsible panels, and edits the device's configuration image IN PLACE.
 *
 * THE WORKING DOCUMENT IS THE BYTE IMAGE. There is no parallel JavaScript
 * object model of the configuration: every control reads and writes the
 * 384-byte InfoMem image through the injected codec, so any byte no field
 * models (the MPL regions, the reserved bits, the sensor bitmaps) survives a
 * read/edit/write round-trip untouched. That is the whole reason this module
 * takes a `codec` instead of a parsed config object.
 *
 * The schema and the codec are INJECTED, never imported. This module has no
 * dependency on the SDK bundle, so it renders a Shimmer3/3R InfoMem today and
 * a Verisense operational config (or anything else with the same field shape)
 * tomorrow, and it can be developed before the SDK that describes the fields
 * has even been vendored.
 *
 * Follows the pattern of the Verisense device console's op-config editor
 * (verisense-device-console/console.js: `renderAllOpFieldsEditor` L571-762,
 * the unsupported-group relocation L764-821 and the sync/apply/dirty passes
 * L823-927), with three deliberate departures:
 *
 *   1. Dirty state is computed from the BYTES, not from the control values.
 *      The console compares a control's string value against a captured
 *      string; here a field is dirty when its decoded value differs from the
 *      decode of the baseline image. Loading a preset, writing a byte by hand
 *      or reverting one field therefore all mark exactly the fields that
 *      really changed.
 *   2. Invalid input never reaches the image. The console writes whatever the
 *      control holds; here a value is validated first, and a rejected value
 *      leaves the bytes alone and flags the control.
 *   3. Support (the "not on this hardware" relocation) is per FIELD, not per
 *      group. A group relocates when it has no supported members left.
 *
 * Nothing here touches `document` at import time.
 *
 *   import { createConfigForm } from "../common/config-form.js";
 */

import { el } from "./ui-chrome.js";

/** Shimmer3/3R InfoMem image length. Also the default working-image size. */
export const CONFIG_IMAGE_SIZE_DEFAULT = 384;

/** Title of the collapsed panel unsupported groups are moved into. */
const UNSUPPORTED_TITLE = "Not available on this hardware";

/** ASCII bytes an `ascii12` field may hold — printable, no DEL. */
const ASCII_MIN = 0x20;
const ASCII_MAX = 0x7e;

/**
 * Kinds that decode to a plain number, and so render as a number input.
 * `bit` is handled separately (it can be a checkbox or a select).
 */
const NUMERIC_KINDS = new Set(["bit", "u8", "u16le", "u16be", "u32be"]);

/** One MAC is 6 bytes, i.e. 12 hex characters. */
const MAC_HEX_LENGTH = 12;

/** Default cap on a `mac6[]` list when the field declares no `max`. */
const MAC_LIST_MAX_DEFAULT = 21;

/**
 * Length of a raw byte-block kind, or null when the kind is not one.
 *
 * The schema names these by their length (`bytes21` for a kinematic
 * calibration block, `bytes10` for an ADS1292R register bank), so the length
 * is parsed out of the kind rather than tabulated. A `bytes6` added tomorrow
 * therefore renders correctly with no change here — which is the point: the
 * ExG banks arrived as `u8` and became `bytes10` mid-development, and a
 * hard-coded table would have silently rendered the new kind as a number
 * input and written ten zeroes over the register bank on the first commit.
 *
 * @param {string} kind
 * @returns {number|null}
 */
function byteBlockLength(kind) {
  const m = /^bytes(\d+)$/.exec(String(kind));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Instance counter, so two forms on one page cannot collide on element ids. */
let instanceSeq = 0;

// ---------------------------------------------------------------------------
// Encoding tooltips
// ---------------------------------------------------------------------------

function hex2(n) {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

/**
 * `byte 130, bits 6-7 (mask 0xC0)` for one bitfield slice.
 *
 * The mask is the IN-BYTE mask, i.e. already shifted into place, because the
 * reader hovering this is holding a register map or a hex dump and wants the
 * bits as they sit in that byte. An unshifted 0x03 for bits 6-7 is a mask of
 * the field's VALUE, which is not a thing anyone can look up.
 *
 * Each slice of a composite field is shifted by its OWN shift, so the two
 * halves of the LSM6DSV gyro range read `mask 0x03` and `mask 0x04` — the
 * bytes they live in, not one mask applied twice.
 */
function bitSpanText(index, shift, width) {
  const bits =
    width === 1 ? `bit ${shift}` : `bits ${shift}-${shift + width - 1}`;
  const mask = ((1 << width) - 1) << shift;
  return `byte ${index}, ${bits} (mask 0x${hex2(mask)})`;
}

function byteSpanText(index, length) {
  return length === 1
    ? `byte ${index}`
    : `bytes ${index}-${index + length - 1}`;
}

/**
 * Human description of where a field physically lives, for the control's
 * `title`. Kept out of the visible helper text (the console does the same):
 * the byte/bit citation is what a firmware engineer wants on hover and what
 * everyone else wants out of the way.
 *
 * A COMPOSITE field — one declaring `msbLayoutKey`, whose value is split
 * across two non-adjacent bytes — reads as both slices joined by `+`.
 *
 * @param {object} field
 * @param {number} index resolved byte offset of the field (or its low part)
 * @param {number|undefined} msbIndex resolved offset of the high part
 * @returns {string}
 */
export function encodingTooltip(field, index, msbIndex) {
  switch (field.kind) {
    case "bit": {
      const low = bitSpanText(index, field.shift ?? 0, field.width ?? 1);
      if (msbIndex === undefined) return low;
      const high = bitSpanText(
        msbIndex,
        field.msbShift ?? 0,
        field.msbWidth ?? 1,
      );
      return `${low} + ${high}`;
    }
    case "u8":
      return byteSpanText(index, 1);
    case "u16le":
      return `${byteSpanText(index, 2)} (little-endian)`;
    case "u16be":
      return `${byteSpanText(index, 2)} (big-endian)`;
    case "u32be":
      return `${byteSpanText(index, 4)} (big-endian)`;
    case "ascii12":
      return `${byteSpanText(index, 12)} (ASCII, 0xFF-padded)`;
    case "mac6[]": {
      const slots = field.max ?? MAC_LIST_MAX_DEFAULT;
      return `${byteSpanText(index, slots * 6)} (${slots} slots x 6 bytes)`;
    }
    default: {
      const block = byteBlockLength(field.kind);
      if (block !== null) return `${byteSpanText(index, block)} (raw)`;
      return `${byteSpanText(index, 1)} (unrecognised encoding '${field.kind}')`;
    }
  }
}

/**
 * Largest value a field can hold, from its declared `max` or, failing that,
 * from the width its encoding gives it.
 *
 * For a `bit` field the derived maximum includes the composite high part, so
 * the LSM6DSV gyro range (2 low bits + 1 high bit) accepts 0-7 rather than
 * silently clamping to 0-3.
 *
 * @param {object} field
 * @returns {number|undefined}
 */
export function derivedMax(field) {
  if (typeof field.max === "number" && field.kind !== "ascii12") {
    return field.max;
  }
  switch (field.kind) {
    case "bit": {
      const width =
        (field.width ?? 1) + (field.msbLayoutKey ? (field.msbWidth ?? 1) : 0);
      return (1 << width) - 1;
    }
    case "u8":
      return 0xff;
    case "u16le":
    case "u16be":
      return 0xffff;
    case "u32be":
      return 0xffffffff;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += hex2(b);
  return s;
}

/** True when two decoded field values are the same value. */
function sameValue(a, b) {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * A decoded value as a person would read it — the option label where the
 * schema has one, so a confirm dialog says "± 4 g", not "1".
 *
 * @param {object} field
 * @param {number|string|Uint8Array|string[]} value
 * @returns {string}
 */
export function displayValue(field, value) {
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(none)";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  if (field.options) {
    const hit = field.options.find(([v]) => v === value);
    if (hit) return hit[1];
    return `${value} (not in this part's table)`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Per-kind validation
// ---------------------------------------------------------------------------

/**
 * Turn a control's raw string into a value the codec can write, or explain
 * why it cannot be written.
 *
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
function parseControlValue(field, raw) {
  switch (field.kind) {
    case "ascii12": {
      const s = String(raw);
      if (s.length > 12) return { ok: false, error: "at most 12 characters" };
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < ASCII_MIN || c > ASCII_MAX) {
          return {
            ok: false,
            error: `character ${i + 1} is not printable ASCII`,
          };
        }
      }
      return { ok: true, value: s };
    }
    case "mac6[]": {
      const limit = field.max ?? MAC_LIST_MAX_DEFAULT;
      const macs = [];
      const lines = String(raw).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        // Blank lines are ignored, so a trailing newline is not an error and
        // a list can be edited without fighting the whitespace.
        const mac = lines[i].replace(/[\s:-]/g, "").toUpperCase();
        if (!mac) continue;
        if (!/^[0-9A-F]{12}$/.test(mac)) {
          return {
            ok: false,
            error: `line ${i + 1} is not ${MAC_HEX_LENGTH} hex digits`,
          };
        }
        macs.push(mac);
      }
      if (macs.length > limit) {
        return { ok: false, error: `at most ${limit} addresses` };
      }
      return { ok: true, value: macs };
    }
    default: {
      const block = byteBlockLength(field.kind);
      if (block !== null) {
        const hex = String(raw)
          .replace(/[\s:-]/g, "")
          .toUpperCase();
        if (!/^[0-9A-F]*$/.test(hex)) {
          return { ok: false, error: "hex digits only" };
        }
        if (hex.length !== block * 2) {
          return {
            ok: false,
            error: `${block * 2} hex characters needed, ${hex.length} given`,
          };
        }
        const out = new Uint8Array(block);
        for (let i = 0; i < block; i++) {
          out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return { ok: true, value: out };
      }
      // Numeric kinds are named, not assumed: an encoding this module does
      // not know must be refused, never parsed as a number and written over
      // the field's bytes. (`buildControl` renders such a field read-only, so
      // this is the second of two guards.)
      if (!NUMERIC_KINDS.has(field.kind)) {
        return {
          ok: false,
          error: `unrecognised field encoding '${field.kind}'`,
        };
      }
      const s = String(raw).trim();
      if (s === "") return { ok: false, error: "a number is needed" };
      const n = Number(s);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, error: "a whole number is needed" };
      }
      const min = typeof field.min === "number" ? field.min : 0;
      const max = derivedMax(field);
      if (n < min) return { ok: false, error: `at least ${min}` };
      if (max !== undefined && n > max) {
        return { ok: false, error: `at most ${max}` };
      }
      return { ok: true, value: n };
    }
  }
}

/** The string a control should show for a decoded value. */
function formatForControl(field, value) {
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.join("\n");
  return String(value);
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * Build a configuration form inside `host`.
 *
 * @param {HTMLElement} host container the form is rendered into (emptied)
 * @param {object} cfg
 * @param {readonly object[]} cfg.fields field definitions, ALREADY filtered
 *   for the device generation (`infoMemFieldsFor(generation)`), in the order
 *   they should appear within their group
 * @param {readonly object[]} cfg.groups group definitions, in display order;
 *   `{id, title, openByDefault?, subgroups?: [{id, title}]}`
 * @param {object} cfg.layout the resolved layout the codec resolves indexes
 *   against
 * @param {{
 *   resolveFieldIndex: (field: object, layout: object) => number,
 *   readInfoMemFieldValue: (bytes: Uint8Array, field: object, layout: object)
 *     => number|string|Uint8Array|string[],
 *   writeInfoMemFieldValue: (bytes: Uint8Array, field: object, layout: object,
 *     value: unknown) => void,
 * }} cfg.codec the SDK's three field accessors, injected
 * @param {number} [cfg.imageSize=384] working-image length
 * @param {Uint8Array} [cfg.image] initial working image; defaults to a
 *   zero-filled buffer, so the form renders before anything has been read
 * @param {(key: string, value: unknown, dirtyKeys: string[]) => void}
 *   [cfg.onChange] fired only on a VALID commit
 * @param {(dirtyCount: number) => void} [cfg.onDirtyChange]
 * @returns {{
 *   setImage: (bytes: Uint8Array) => void,
 *   getImage: () => Uint8Array,
 *   captureBaseline: () => void,
 *   dirtyKeys: () => string[],
 *   dirtyFields: () => {key: string, label: string, from: string, to: string}[],
 *   revert: () => void,
 *   setEnabled: (enabled: boolean) => void,
 *   setFieldSupport: (key: string, supported: boolean, reason?: string) => void,
 *   focusField: (key: string) => void,
 *   destroy: () => void,
 * }}
 */
export function createConfigForm(host, cfg) {
  const {
    fields = [],
    groups = [],
    layout,
    codec,
    onChange,
    onDirtyChange,
  } = cfg ?? {};

  if (!host) throw new TypeError("createConfigForm needs a host element");
  if (!codec?.readInfoMemFieldValue || !codec?.writeInfoMemFieldValue) {
    throw new TypeError(
      "createConfigForm needs codec.readInfoMemFieldValue / .writeInfoMemFieldValue",
    );
  }

  const imageSize = cfg.imageSize ?? CONFIG_IMAGE_SIZE_DEFAULT;
  const idPrefix = `cf${++instanceSeq}`;

  /** The working document. Every control reads and writes THIS array. */
  let image = adoptImage(cfg.image, imageSize);
  /** The last-known-clean copy of the image; dirty state is measured off it. */
  let baseline = new Uint8Array(image);

  let enabled = true;

  /** @type {Map<string, object>} field key -> entry */
  const entries = new Map();
  /** @type {Map<string, HTMLElement>} group id -> its <details> */
  const groupNodes = new Map();
  /** @type {Map<string, HTMLElement>} group id -> its [data-group-body] slot */
  const groupBodies = new Map();
  /** @type {Map<string, HTMLElement>} group/subgroup id -> the .grid it fills */
  const grids = new Map();

  // Two hosts, as in the console: the groups this hardware supports, and a
  // collapsed panel for the rest. Relocation moves the same <details> node
  // between them, so it is non-destructive — open state, control values and
  // event listeners all survive, and moving a group back is just as cheap.
  const supportedHost = el("div", { class: "config-groups" });
  const unsupportedBody = el("div", { class: "config-groups" });
  const unsupportedSection = el(
    "details",
    { class: "group", hidden: true },
    el("summary", {}, UNSUPPORTED_TITLE),
    el(
      "div",
      { class: "group-body" },
      el("div", {
        class: "field-hint",
        text:
          "These settings are still part of the configuration and are written " +
          "to the sensor unchanged, but this hardware has no matching part.",
      }),
      unsupportedBody,
    ),
  );

  host.replaceChildren(supportedHost, unsupportedSection);

  render();
  repopulate();

  // ---- Rendering ---------------------------------------------------------

  function render() {
    for (const g of groups) {
      const details = el("details", {
        class: "group",
        dataset: { groupId: g.id },
      });
      if (g.openByDefault) details.open = true;
      details.appendChild(el("summary", {}, g.title));

      const body = el("div", {
        class: "group-body",
        dataset: { groupBody: g.id },
      });
      groupBodies.set(g.id, body);
      // Ungrouped fields fill this grid; labelled subpanels follow it.
      const grid = el("div", { class: "grid" });
      body.appendChild(grid);
      grids.set(g.id, grid);

      for (const sg of g.subgroups ?? []) {
        const subGrid = el("div", { class: "grid" });
        const sub = el(
          "details",
          {
            class: "group",
            open: true,
            dataset: { subgroupId: sg.id },
          },
          el("summary", {}, sg.title),
          el("div", { class: "group-body" }, subGrid),
        );
        body.appendChild(sub);
        grids.set(sg.id, subGrid);
      }

      details.appendChild(body);
      supportedHost.appendChild(details);
      groupNodes.set(g.id, details);
    }

    for (const field of fields) {
      const entry = buildField(field);
      if (!entry) continue;
      entries.set(field.key, entry);
      // A field may name a subgroup as its group ("sdLogging.startup"); fall
      // back to the group's own grid, and then to the first grid there is, so
      // a schema/group mismatch shows the field somewhere rather than losing
      // it silently.
      const grid =
        grids.get(field.group) ??
        grids.get(String(field.group).split(".")[0]) ??
        grids.values().next().value;
      grid?.appendChild(entry.wrap);
    }

    refreshGroupPlacement();
  }

  /** One `.field` card: label, control, helper text, error, support note. */
  function buildField(field) {
    let index;
    try {
      index = codec.resolveFieldIndex
        ? codec.resolveFieldIndex(field, layout)
        : layout?.[field.layoutKey];
    } catch {
      index = undefined;
    }
    if (typeof index !== "number") {
      // An unresolvable layout key means this field does not exist in this
      // firmware's layout at all. Rendering a control that writes byte
      // `undefined` would corrupt the image, so drop the field instead.
      return null;
    }
    const msbIndex =
      field.msbLayoutKey === undefined
        ? undefined
        : typeof layout?.[field.msbLayoutKey] === "number"
          ? layout[field.msbLayoutKey]
          : undefined;

    const slug = String(field.key).replace(/[^A-Za-z0-9_-]/g, "-");
    const id = `${idPrefix}-${slug}`;
    const hintId = `${id}-hint`;
    const errId = `${id}-err`;
    const noteId = `${id}-note`;
    const tooltip = encodingTooltip(field, index, msbIndex);

    const control = buildControl(field, id);
    control.dataset.fieldKey = field.key;
    control.title = tooltip;
    control.setAttribute("aria-describedby", `${hintId} ${errId} ${noteId}`);

    const label = el("label", { for: id, title: tooltip }, field.label);
    const hint = el("div", { class: "field-hint", id: hintId }, field.desc);
    // aria-live so a rejected value is announced when it is rejected, not
    // only when the control is next focused.
    const error = el("div", {
      class: "field-hint",
      id: errId,
      hidden: true,
      style: { color: "var(--danger)" },
      "aria-live": "polite",
    });
    const note = el("div", {
      class: "field-hint muted",
      id: noteId,
      hidden: true,
    });

    const wrap = el(
      "div",
      { class: "field", dataset: { fieldKey: field.key }, title: tooltip },
      label,
      control,
      hint,
      error,
      note,
    );

    const entry = {
      field,
      index,
      msbIndex,
      tooltip,
      wrap,
      control,
      error,
      note,
      supported: true,
      reason: "",
    };

    // Numeric, text, hex and MAC controls all commit on `change`, never per
    // keystroke: "13" on the way to "130" is out of range for plenty of
    // fields, and a per-keystroke commit would either reject it or write it.
    control.addEventListener("change", () => commit(entry));
    if (byteBlockLength(field.kind) !== null || field.kind === "mac6[]") {
      // Hex and MAC input gets live validity styling while typing — the error
      // is what tells the user the length is still wrong — but still only
      // commits on change.
      control.addEventListener("input", () => validateOnly(entry));
    }

    return entry;
  }

  function buildControl(field, id) {
    const options = field.options;
    if (options?.length) {
      return el(
        "select",
        { id },
        options.map(([value, text]) =>
          el("option", { value: String(value) }, text),
        ),
      );
    }
    switch (field.kind) {
      case "bit":
        if ((field.width ?? 1) === 1 && field.msbLayoutKey === undefined) {
          // A single unlabelled bit is a checkbox. `width: auto` because
          // theme.css stretches `.field input` to the full card width, which
          // a checkbox must not do.
          return el("input", {
            id,
            type: "checkbox",
            style: { width: "auto", alignSelf: "flex-start" },
          });
        }
        return numberControl(field, id);
      case "ascii12":
        return el("input", {
          id,
          type: "text",
          maxlength: "12",
          autocomplete: "off",
          spellcheck: "false",
        });
      case "mac6[]":
        return el("textarea", {
          id,
          rows: "4",
          autocomplete: "off",
          spellcheck: "false",
          placeholder: "one 12-hex-digit address per line",
        });
      // Listed explicitly rather than left to fall through to `default`: the
      // default is now the byte-block/unknown branch, and a numeric kind that
      // reached it would render read-only and silently stop being editable.
      case "u8":
      case "u16le":
      case "u16be":
      case "u32be":
        return numberControl(field, id);
      default: {
        const block = byteBlockLength(field.kind);
        if (block !== null) {
          return el("input", {
            id,
            type: "text",
            class: "mono",
            maxlength: String(block * 2),
            autocomplete: "off",
            spellcheck: "false",
            placeholder: `${block * 2} hex characters`,
          });
        }
        // An encoding this module does not recognise. A number input would be
        // the WRONG guess for a block or a string kind, and committing it
        // would write a plain number over the field's bytes, so render a
        // read-only display of what the codec decoded instead. The bytes stay
        // exactly as they were and the page is told, rather than the image
        // being quietly corrupted by a control that guessed.
        return el("input", {
          id,
          type: "text",
          class: "mono",
          readonly: true,
          title: `Unrecognised field encoding '${field.kind}' — shown read-only`,
        });
      }
    }
  }

  function numberControl(field, id) {
    const max = derivedMax(field);
    return el("input", {
      id,
      type: "number",
      step: "1",
      min: String(typeof field.min === "number" ? field.min : 0),
      max: max === undefined ? null : String(max),
      inputmode: "numeric",
    });
  }

  // ---- Populate / commit ------------------------------------------------

  /** Push every field's decoded value from the image into its control. */
  function repopulate() {
    for (const entry of entries.values()) {
      clearError(entry);
      setControlValue(entry, read(entry.field));
    }
    refreshDirty();
  }

  function read(field, bytes = image) {
    return codec.readInfoMemFieldValue(bytes, field, layout);
  }

  function setControlValue(entry, value) {
    const { field, control } = entry;
    if (control.type === "checkbox") {
      control.checked = Number(value) !== 0;
      return;
    }
    if (control.tagName === "SELECT") {
      // The image can hold a value this part's option table does not list —
      // an unprovisioned InfoMem, or a config written by another firmware
      // generation. A select with no matching option would read back as "" on
      // the next commit and zero the field, so surface the raw value as a
      // temporary option instead. It disappears as soon as the user picks a
      // real one, and the bytes are never touched by merely displaying it.
      for (const opt of Array.from(control.options)) {
        if (opt.dataset.synthetic) opt.remove();
      }
      const wanted = String(value);
      if (!Array.from(control.options).some((o) => o.value === wanted)) {
        control.insertBefore(
          el(
            "option",
            {
              value: wanted,
              dataset: { synthetic: "1" },
            },
            `${wanted} (not in this part's table)`,
          ),
          control.firstChild,
        );
      }
      control.value = wanted;
      return;
    }
    control.value = formatForControl(field, value);
  }

  /** Validate without writing; used for live styling while typing. */
  function validateOnly(entry) {
    const parsed = parseControlValue(entry.field, entry.control.value);
    if (parsed.ok) clearError(entry);
    else showError(entry, parsed.error);
    return parsed;
  }

  /**
   * Validate the control, and on success write it into the image.
   *
   * A rejected value leaves the bytes exactly as they were — the point of
   * validating before writing rather than after.
   */
  function commit(entry) {
    const { field, control } = entry;
    // A read-only control is a display of bytes this module cannot encode.
    // Never write from one, however the change event arrived.
    if (control.readOnly) return;
    const raw =
      control.type === "checkbox" ? (control.checked ? 1 : 0) : control.value;
    const parsed = parseControlValue(field, raw);
    if (!parsed.ok) {
      showError(entry, parsed.error);
      refreshDirty();
      return;
    }
    clearError(entry);
    codec.writeInfoMemFieldValue(image, field, layout, parsed.value);
    // Re-show the decode rather than the typed text, so "0a" becomes "0A",
    // " 51 " becomes "51" and a select drops its synthetic option — the
    // control always shows what the bytes now actually say.
    setControlValue(entry, read(field));
    refreshDirty();
    onChange?.(field.key, parsed.value, dirtyKeys());
  }

  function showError(entry, message) {
    entry.error.textContent = message;
    entry.error.hidden = false;
    entry.control.setAttribute("aria-invalid", "true");
    entry.control.style.borderColor = "var(--danger)";
    entry.control.style.background = "var(--danger-bg)";
  }

  function clearError(entry) {
    entry.error.textContent = "";
    entry.error.hidden = true;
    entry.control.removeAttribute("aria-invalid");
    entry.control.style.borderColor = "";
    entry.control.style.background = "";
  }

  // ---- Dirty state ------------------------------------------------------

  function isDirty(entry) {
    return !sameValue(read(entry.field), read(entry.field, baseline));
  }

  function refreshDirty() {
    let count = 0;
    for (const entry of entries.values()) {
      const dirty = isDirty(entry);
      if (dirty) count++;
      entry.wrap.classList.toggle("dirty", dirty);
    }
    onDirtyChange?.(count);
    return count;
  }

  function dirtyKeys() {
    const keys = [];
    for (const [key, entry] of entries) if (isDirty(entry)) keys.push(key);
    return keys;
  }

  // ---- Support and relocation -------------------------------------------

  /**
   * Move each group into the supported host or the collapsed panel, in schema
   * order, so both hosts always list groups canonically however often support
   * changes.
   */
  function refreshGroupPlacement() {
    let unsupportedGroups = 0;
    for (const g of groups) {
      const details = groupNodes.get(g.id);
      if (!details) continue;

      const members = [...entries.values()].filter(
        (e) =>
          e.field.group === g.id ||
          String(e.field.group).startsWith(`${g.id}.`),
      );
      // An empty group (the sensor-enable bitmaps are not schema fields, so
      // "Sensor Enables" arrives with none) is hidden unless the page has put
      // its own controls into the group's [data-group-body] slot. Held as a
      // direct reference rather than looked up by selector, so a group id
      // with a quote or a dot in it cannot break the query.
      const injected = groupBodies.get(g.id);
      const hasOwnContent =
        !!injected &&
        [...injected.children].some(
          (c) => !c.classList.contains("grid") && c.tagName !== "DETAILS",
        );
      if (!members.length) {
        details.hidden = !hasOwnContent;
        supportedHost.appendChild(details);
        continue;
      }
      details.hidden = false;

      const supported = members.some((e) => e.supported);
      (supported ? supportedHost : unsupportedBody).appendChild(details);
      if (!supported) unsupportedGroups++;
    }
    unsupportedSection.hidden = unsupportedGroups === 0;
  }

  function applyEnabled(entry) {
    entry.control.disabled = !enabled || !entry.supported;
    entry.control.title = entry.supported
      ? entry.tooltip
      : `${entry.reason || UNSUPPORTED_TITLE} — ${entry.tooltip}`;
  }

  // ---- Public API -------------------------------------------------------

  return {
    setImage(bytes) {
      image = adoptImage(bytes, imageSize);
      baseline = new Uint8Array(image);
      repopulate();
    },

    getImage() {
      return image;
    },

    captureBaseline() {
      baseline = new Uint8Array(image);
      refreshDirty();
    },

    dirtyKeys,

    dirtyFields() {
      const out = [];
      for (const [key, entry] of entries) {
        if (!isDirty(entry)) continue;
        out.push({
          key,
          label: entry.field.label,
          from: displayValue(entry.field, read(entry.field, baseline)),
          to: displayValue(entry.field, read(entry.field)),
        });
      }
      return out;
    },

    revert() {
      // In place, so `getImage()` stays a valid live reference across a
      // revert — a page holding it does not have to re-fetch.
      image.set(baseline);
      repopulate();
    },

    setEnabled(next) {
      enabled = !!next;
      for (const entry of entries.values()) applyEnabled(entry);
    },

    setFieldSupport(key, supported, reason = "") {
      const entry = entries.get(key);
      if (!entry) return;
      entry.supported = !!supported;
      entry.reason = reason;
      entry.note.textContent = reason;
      entry.note.hidden = !reason || entry.supported;
      entry.wrap.classList.toggle("unsupported", !entry.supported);
      applyEnabled(entry);
      refreshGroupPlacement();
    },

    focusField(key) {
      const entry = entries.get(key);
      if (!entry) return;
      // Open every collapsed ancestor first, or focus() lands on a control
      // inside a closed <details> and nothing appears to happen.
      for (let n = entry.wrap.parentElement; n; n = n.parentElement) {
        if (n.tagName === "DETAILS") n.open = true;
        if (n === host) break;
      }
      entry.control.focus({ preventScroll: true });
      entry.wrap.scrollIntoView({ block: "nearest" });
    },

    destroy() {
      // Every listener is on a node inside `host`, so dropping the subtree
      // drops the listeners with it.
      host.replaceChildren();
      entries.clear();
      groupNodes.clear();
      groupBodies.clear();
      grids.clear();
    },
  };
}

/**
 * Take the caller's buffer as the working image where possible.
 *
 * Adopting rather than copying is deliberate: the page reads the InfoMem into
 * one array, hands it here, edits it through the form and writes that same
 * array back, so there is exactly one copy of the configuration in flight and
 * no way for a stale duplicate to be the one that gets written. A buffer of
 * the wrong length cannot be adopted, so it is copied into a right-sized one.
 */
function adoptImage(bytes, size) {
  if (!bytes) return new Uint8Array(size);
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("config image must be a Uint8Array");
  }
  if (bytes.length === size) return bytes;
  const out = new Uint8Array(size);
  out.set(bytes.subarray(0, Math.min(bytes.length, size)), 0);
  return out;
}
