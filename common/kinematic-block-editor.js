/**
 * The configuration form's editor for a 21-byte kinematic calibration block.
 *
 * A `bytes21` calibration field renders by default as forty-two hex
 * characters in one text box. That is what the bytes are, and it is unreadable:
 * the same numbers on the Calibration tab are three labelled grids — an offset
 * vector, a sensitivity vector and a 3x3 alignment matrix — and there is no
 * reason the configuration image's own copy of them should be harder to read
 * than the calibration dump's. This module makes the Configure tab's
 * Calibration section look like the Calibration tab, range and all.
 *
 * It is a separate module from `config-form.js` because that module has, by
 * design, NO dependency on the SDK bundle (see its header), and decoding these
 * bytes needs the SDK's codec for this encoding. So config-form takes an
 * `editorFor` hook and this is what a page hands it:
 *
 *   import { createKinematicBlockEditorFactory } from "../common/kinematic-block-editor.js";
 *
 *   const editorFor = createKinematicBlockEditorFactory({
 *     fields: sdk.infoMemFieldsFor(generation),
 *     generation: () => generation,
 *   });
 *   createConfigForm(host, { fields, groups, layout, codec, editorFor });
 *
 * WHY IT IS EDITABLE, and the Calibration tab's InfoMem view is not: the
 * configuration image belongs to this form. The Calibration tab says so in as
 * many words when it falls back to showing the image — it stays read-only
 * there precisely so that two panels are never writing one image. Here the
 * boxes go through config-form's ordinary commit path, so what reaches the
 * bytes is one writer, validated first, and the dirty pill, Discard, Apply and
 * the hex view need to know nothing about this module at all.
 */

import { el } from "./ui-chrome.js";
import * as sdk from "../vendor/shimmer-web-sdk.esm.js";

/** Kinematic block length, and the field kind that names it. */
const BLOCK_BYTES = 21;
const BLOCK_KIND = `bytes${BLOCK_BYTES}`;

/** Prefix every calibration-block field key carries in the schema. */
const KEY_PREFIX = "calib.";

/** Axis labels down the side of every grid, as on the Calibration tab. */
const AXES = Object.freeze(["x", "y", "z"]);

/**
 * What the three parts can hold, from the byte layout: offset and sensitivity
 * are big-endian i16, alignment is i8. Mirrors the same constants in
 * `calibration-editor.js` — the format is the format, and both editors have to
 * refuse the same values.
 */
const I16_MIN = -32768;
const I16_MAX = 32767;
const I8_MIN = -128;
const I8_MAX = 127;

/** A number as short as it can be written without changing it. */
function num(v) {
  if (!Number.isFinite(v)) return "";
  return String(Number(v.toFixed(6)));
}

/**
 * What one box may hold, in the units shown on screen — so a refusal names
 * the number the user typed rather than the integer it scales to.
 */
function limitsFor(part, sensitivityScale) {
  if (part === "offset") {
    return {
      scale: 1,
      min: I16_MIN,
      max: I16_MAX,
      describe: `a whole number from ${I16_MIN} to ${I16_MAX}`,
    };
  }
  if (part === "sens") {
    const scale = sensitivityScale || 1;
    return {
      scale,
      min: I16_MIN / scale,
      max: I16_MAX / scale,
      describe:
        scale === 1
          ? `a whole number from ${I16_MIN} to ${I16_MAX}`
          : `${num(I16_MIN / scale)} to ${num(I16_MAX / scale)} in steps of ${num(1 / scale)}`,
    };
  }
  return {
    scale: 100,
    min: I8_MIN / 100,
    max: I8_MAX / 100,
    describe: `${num(I8_MIN / 100)} to ${num(I8_MAX / 100)} in steps of 0.01`,
  };
}

/**
 * Validate one typed value against what the format can hold.
 *
 * Refuses rather than clamps, for the same reason the Calibration tab does: a
 * silently clamped offset is a calibration nobody asked for, written under the
 * name of one somebody did.
 *
 * @returns {{value: number}|{problem: string}}
 */
function checkValue(text, part, sensitivityScale) {
  const raw = String(text ?? "").trim();
  if (!raw) return { problem: "needs a value" };
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
    return { problem: "not a number" };
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) return { problem: "not a number" };
  const lim = limitsFor(part, sensitivityScale);
  if (v < lim.min || v > lim.max) {
    return { problem: `out of range — ${lim.describe}` };
  }
  /* The encoder rounds sensitivity and alignment and TRUNCATES offset. A value
     that would not survive that round trip is refused here, so the number in
     the box is always the number that reaches the device. */
  const settled = Math.round(v * lim.scale) / lim.scale;
  if (Math.abs(settled - v) > 1e-9) {
    return {
      problem:
        lim.scale === 1
          ? "must be a whole number"
          : `must be a multiple of ${num(1 / lim.scale)}`,
    };
  }
  return { value: v };
}

/**
 * The range field that governs a calibration group, by key.
 *
 * Found by pattern rather than tabulated, because the schema names these
 * per-part: the wide-range accelerometer's range is `wrAccelRange` on one
 * generation and `wrAccelRange.lsm303ah` on another, and the gyro's is
 * `gyroRange.mpu9x50` or `gyroRange.lsm6dsv`. A table would need an entry per
 * part and would silently stop finding the range for the next one added.
 *
 * Returns null where the part genuinely has no range field — the Shimmer3R's
 * LIS2MDL magnetometer has exactly one range, so the schema declares none, and
 * that is not a lookup failure.
 *
 * @param {readonly object[]} fields the schema fields for THIS generation
 * @param {string} group e.g. `lnAccel`
 * @returns {string|null}
 */
/**
 * The defaults-table family for a generation string.
 *
 * `inferShimmer3Generation` and `getGroupDefaults` name the same three parts
 * differently — `shimmer3-new-imu` against `shimmer3-new` — so somebody has
 * to translate. Returns null for anything else, including the null a page
 * passes when the sensor never said what it is: the defaults are then simply
 * not shown, which is better than showing another part's.
 *
 * @param {string|null|undefined} generation
 * @returns {"shimmer3-old"|"shimmer3-new"|"shimmer3r"|null}
 */
export function calibrationFamilyFor(generation) {
  if (generation === "shimmer3r") return "shimmer3r";
  if (generation === "shimmer3-new-imu") return "shimmer3-new";
  if (generation === "shimmer3-old-imu") return "shimmer3-old";
  return null;
}

function rangeFieldKeyFor(fields, group) {
  const re = new RegExp(`^${group}Range(\\.|$)`);
  const hit = (fields ?? []).find((f) => re.test(String(f.key)));
  return hit ? String(hit.key) : null;
}

/**
 * Build the `editorFor` hook `createConfigForm` takes.
 *
 * @param {object} opts
 * @param {readonly object[]} opts.fields the schema fields handed to the same
 *   form, used only to find each group's range field
 * @param {string|null|(() => string|null)} [opts.generation] what
 *   `inferShimmer3Generation` returned — `"shimmer3r"`, `"shimmer3-new-imu"`
 *   or `"shimmer3-old-imu"`. A getter, so the boxes follow a
 *   re-identification without the form being rebuilt. It is needed for one
 *   thing only: which factory defaults a block with nothing stored falls back
 *   to. Pass nothing and such a block shows empty boxes instead.
 * @returns {(field: object, api: object) => object|null}
 */
export function createKinematicBlockEditorFactory(opts = {}) {
  const fields = opts.fields ?? [];
  const getGeneration =
    typeof opts.generation === "function"
      ? opts.generation
      : () => opts.generation ?? null;

  return function editorFor(field, api) {
    /* Only the calibration blocks. Another `bytes21` field added to the schema
       tomorrow is not a kinematic block just because it is the same length,
       so the key prefix has to agree as well as the kind. */
    if (field?.kind !== BLOCK_KIND) return null;
    if (!String(field.key ?? "").startsWith(KEY_PREFIX)) return null;

    const group = String(field.key).slice(KEY_PREFIX.length);
    const rangeKey = rangeFieldKeyFor(fields, group);

    // ---- the parts

    const rangePill = el("span", { class: "pill" }, "range unknown");
    const chip = el("span", { class: "cal-chip" }, "kinematic block");
    const problemNode = el("div", { class: "cal-error", hidden: true });
    const stateNote = el("div", { class: "field-hint muted" });

    /** part -> the three (or nine) inputs, in row-major order. */
    const cells = { offset: [], sens: [], align: [] };

    const makeInput = (part, i) => {
      const input = el("input", {
        type: "text",
        class: "mono cal-cell",
        inputmode: "decimal",
        autocomplete: "off",
        spellcheck: "false",
        dataset: { calPart: part, calIndex: String(i) },
        "aria-label": `${field.label} ${part} ${
          part === "align"
            ? `row ${Math.floor(i / 3) + 1} column ${(i % 3) + 1}`
            : AXES[i]
        }`,
      });
      /* Committed on `change`, exactly as every other control in the form is:
         "1" on the way to "1.5" is a different calibration, and committing it
         per keystroke would write it. `input` only restyles. */
      input.addEventListener("change", () => api.onEdit());
      input.addEventListener("input", () => paintProblems(collect().problems));
      cells[part].push(input);
      return input;
    };

    const makeGrid = (part, title, unitText, count) => {
      const body = el("div", {
        class: count === 9 ? "cal-matrix cols-3" : "cal-matrix cols-1",
      });
      for (let r = 0; r < 3; r++) {
        body.appendChild(el("div", { class: "cal-axis" }, AXES[r]));
        for (let c = 0; c < count / 3; c++) {
          body.appendChild(makeInput(part, r * (count / 3) + c));
        }
      }
      return el(
        "div",
        { class: "cal-block" },
        el(
          "div",
          { class: "cal-block-title" },
          title,
          el("span", { class: "cal-unit" }, unitText),
        ),
        body,
      );
    };

    const offsetGrid = makeGrid("offset", "Offset", "raw counts", 3);
    const sensGrid = makeGrid("sens", "Sensitivity", "counts per unit", 3);
    const alignGrid = makeGrid("align", "Alignment", "unitless, −1.28…1.27", 9);
    /* Kept so the unit can be corrected once the family is known — the
       sensitivity unit is per sensor group (m/(s^2), deg/s, local_flux) and
       the family is what says which. */
    const sensUnitNode = sensGrid.querySelector(".cal-unit");

    const node = el(
      "div",
      {
        class: "cal-inline",
        dataset: { calInlineGroup: group },
        id: api.id,
      },
      el("div", { class: "row cal-inline-head" }, chip, rangePill),
      el("div", { class: "cal-grids" }, offsetGrid, sensGrid, alignGrid),
      problemNode,
      stateNote,
    );

    // ---- state the boxes are painted from

    /** The scale sensitivity is stored at: 100 for the gyro, 1 elsewhere. */
    let sensitivityScale = 1;
    /** True while the boxes hold factory defaults rather than stored values. */
    let showingDefaults = false;

    function groupDefaults() {
      const fam = calibrationFamilyFor(getGeneration());
      if (!fam) return null;
      try {
        return sdk.getGroupDefaults(fam, group) ?? null;
      } catch {
        /* A group this family does not have. Not an error: the form has
           already decided this field applies, and the defaults are a
           nicety. */
        return null;
      }
    }

    /** The range the image is configured for, or null when unknowable. */
    function configuredRange() {
      if (!rangeKey) return null;
      const d = api.describe(rangeKey);
      if (!d) return null;
      const n = Number(d.value);
      return Number.isFinite(n) ? { value: n, label: d.label } : null;
    }

    function paintRange() {
      const cfg = configuredRange();
      if (!rangeKey) {
        rangePill.textContent = "single range";
        rangePill.className = "pill";
        rangePill.title =
          "This part has one range, so the configuration declares none and " +
          "the block below is the calibration for it.";
        return;
      }
      if (!cfg) {
        rangePill.textContent = "range unknown";
        rangePill.className = "pill";
        rangePill.title =
          "The configuration image has not been read, so which range this " +
          "block belongs to is not yet known.";
        return;
      }
      rangePill.textContent = `configured: ${cfg.label}`;
      rangePill.className = "pill on";
      rangePill.title =
        `Taken from the ${rangeKey} field of this same image, so it follows ` +
        "an edit to the range immediately. The configuration image holds ONE " +
        "block per sensor, and this is the range the sensor is set to — " +
        "which is what makes the numbers below meaningful.";
    }

    /** Read every box, validating as it goes. */
    function collect() {
      const problems = [];
      const values = { offset: [], sens: [], align: [] };
      for (const part of ["offset", "sens", "align"]) {
        for (let i = 0; i < cells[part].length; i++) {
          const r = checkValue(cells[part][i].value, part, sensitivityScale);
          if ("problem" in r) {
            problems.push({ part, index: i, problem: r.problem });
            values[part].push(0);
          } else {
            values[part].push(r.value);
          }
        }
      }
      return { values, problems };
    }

    function paintProblems(problems) {
      const bad = new Set(problems.map((p) => `${p.part}:${p.index}`));
      for (const part of ["offset", "sens", "align"]) {
        cells[part].forEach((input, i) => {
          input.classList.toggle("bad", bad.has(`${part}:${i}`));
        });
      }
      if (!problems.length) {
        problemNode.hidden = true;
        problemNode.textContent = "";
        return;
      }
      const first = problems[0];
      problemNode.hidden = false;
      problemNode.textContent =
        `${problems.length} value${problems.length === 1 ? "" : "s"} the ` +
        `calibration format cannot hold — ${first.part} ${
          first.part === "align"
            ? `row ${Math.floor(first.index / 3) + 1} column ${(first.index % 3) + 1}`
            : AXES[first.index]
        } ${first.problem}.`;
    }

    // ---- the config-form contract

    return {
      node,

      set(value) {
        const bytes =
          value instanceof Uint8Array ? value : new Uint8Array(BLOCK_BYTES);
        const defaults = groupDefaults();
        sensitivityScale = defaults?.sensitivityScale ?? 1;
        if (sensUnitNode) {
          sensUnitNode.textContent = defaults?.unit
            ? `counts per ${defaults.unit}`
            : "counts per unit";
        }
        paintRange();

        const parsed = sdk.parseKinematicCalibBlock(bytes, {
          sensitivityScale,
        });
        showingDefaults = false;

        if (parsed) {
          fill(parsed);
          stateNote.textContent = "";
        } else {
          /* All 0x00 or all 0xFF: the firmware reads that as "nothing stored"
             and falls back to its own defaults, so those are what the sensor
             would actually use and what the boxes show — greyed, exactly as
             the Calibration tab greys them, so nobody mistakes them for
             measured values. Showing forty-two zeroes instead would be
             literally true about the bytes and misleading about the sensor. */
          const cfg = configuredRange();
          const fallback = defaults
            ? (defaults.byRange[cfg?.value ?? defaults.fallbackRange] ??
              defaults.byRange[defaults.fallbackRange])
            : null;
          if (fallback) {
            fill(fallback);
            showingDefaults = true;
            stateNote.textContent =
              "This block holds no calibration — every byte is 0x00 or 0xFF — " +
              "so the greyed values above are the factory defaults the " +
              "firmware falls back to for this range. Editing any box writes " +
              "the whole block, defaults and all.";
          } else {
            clear();
            stateNote.textContent =
              "This block holds no calibration — every byte is 0x00 or 0xFF. " +
              "Which factory defaults the firmware falls back to depends on " +
              "the hardware, and the sensor has not said what it is.";
          }
        }
        for (const part of ["offset", "sens", "align"]) {
          for (const input of cells[part])
            input.classList.toggle("faint", showingDefaults);
        }
        paintProblems([]);
      },

      get() {
        const { values, problems } = collect();
        paintProblems(problems);
        if (problems.length) {
          const first = problems[0];
          return {
            ok: false,
            error: `${first.part} ${
              first.part === "align"
                ? `row ${Math.floor(first.index / 3) + 1} column ${(first.index % 3) + 1}`
                : AXES[first.index]
            } ${first.problem}`,
          };
        }
        /* The moment anything is committed these are real values, not the
           greyed placeholder — the whole block goes to the bytes. */
        showingDefaults = false;
        for (const part of ["offset", "sens", "align"]) {
          for (const input of cells[part]) input.classList.remove("faint");
        }
        stateNote.textContent = "";
        return {
          ok: true,
          value: sdk.generateKinematicCalibBlock(
            values.offset,
            values.sens,
            values.align,
            { sensitivityScale },
          ),
        };
      },

      setDisabled(disabled, reason) {
        for (const part of ["offset", "sens", "align"]) {
          for (const input of cells[part]) {
            input.disabled = disabled;
            input.title = reason || "";
          }
        }
        node.dataset.calDisabled = disabled ? "true" : "false";
      },

      setInvalid(message) {
        /* config-form's own error line is already showing `message`; the
           per-box styling is this module's job and `collect` has just done
           it, so there is nothing to add. Present so the hook is complete. */
        if (!message) paintProblems([]);
      },

      focus() {
        cells.offset[0]?.focus({ preventScroll: true });
      },
    };

    /**
     * Paint one `KinematicCalibration` into the boxes.
     *
     * Takes the same shape whether it came from `parseKinematicCalibBlock` or
     * out of the defaults table: both go through `makeKinematicCalibration`,
     * so both are `{offset, sensitivity, alignment}` with flat arrays.
     */
    function fill(cal) {
      const put = (part, list) => {
        cells[part].forEach((input, i) => {
          input.value = num(Number(list?.[i] ?? 0));
        });
      };
      put("offset", cal.offset);
      put("sens", cal.sensitivity);
      put("align", cal.alignment);
    }

    function clear() {
      for (const part of ["offset", "sens", "align"]) {
        for (const input of cells[part]) input.value = "";
      }
    }
  };
}
