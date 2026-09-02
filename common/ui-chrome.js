/**
 * Page chrome shared by the webBLEDemos pages: tiny DOM helpers, the event
 * log panel, toasts, declarative control gating, ARIA tabs, downloads and
 * value formatters.
 *
 * Extracted from:
 *   - verisense-device-console/console.js — the log store, severity
 *     classification, rAF-batched flush and sticky tail (L2105-2231),
 *     `formatLogTime` (L2259-2274), the tab wiring (L7777-7817) and the
 *     declarative `data-requires-connection` gating (L1889-1975, simplified).
 *   - verisense-device-console/console-ui.js — `showToast` (L437-455).
 *   - sd-download/index.html — `$` and `fmtBytes` (L286-292).
 *
 * Nothing here touches `document` at import time; every function does its
 * DOM work when called.
 *
 *   import { $, el, createLog, showToast } from "../common/ui-chrome.js";
 */

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * `document.getElementById`, short enough to use inline.
 *
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export function $(id) {
  return document.getElementById(id);
}

/**
 * Build an element.
 *
 * `attrs` keys are set as attributes, except: `class`/`className`,
 * `text`/`textContent`, `html` (innerHTML — only ever pass markup you built),
 * `dataset` (an object of data-* values), `style` (an object of CSS
 * properties) and any `on*` key, which is added as an event listener. A null
 * or undefined value skips the attribute, so `el("input", { disabled: cond ||
 * null })` works.
 *
 * Children may be nodes, strings/numbers (appended as text), or arrays;
 * null/undefined/false children are dropped so `cond && el(…)` is safe.
 *
 * @param {string} tag
 * @param {Record<string, unknown>|null} [attrs]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null) continue;
    if (k === "class" || k === "className") node.className = String(v);
    else if (k === "text" || k === "textContent") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object")
      Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(node, c);
    else if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

/** Default line cap. Beyond this the oldest lines are dropped. */
export const LOG_MAX_LINES_DEFAULT = 2000;

/**
 * Severity of a log line, inferred from its text.
 *
 * Regex-based rather than tagged at the call site because most lines come
 * straight from `client.onStatus`, which has no severity of its own — an
 * SDK status string is the only thing there is to classify.
 *
 * @param {string} text
 * @returns {"err"|"warn"|"tx"|"rx"|"info"}
 */
export function classifyLogLine(text) {
  if (/\berror\b|\bfail(ed|ure)?\b|exception|timeout|refused/i.test(text))
    return "err";
  if (/\bwarn(ing)?\b/i.test(text)) return "warn";
  if (/\bTX\b/.test(text)) return "tx";
  if (/\bRX\b/.test(text)) return "rx";
  return "info";
}

/**
 * Local timestamp prefix for a log line: `YYYY-MM-DD HH:MM:SS:`.
 *
 * Local rather than UTC deliberately — the log is read next to the host
 * clock, and a support ticket that says 14:32 means the reporter's 14:32.
 *
 * @param {Date} [d]
 * @returns {string}
 */
export function formatLogTime(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}:`
  );
}

/**
 * Attach a filterable, capped, timestamped event log to `container`
 * (typically `<div class="log">`).
 *
 * The full text is kept in a JS array, not in the DOM: the DOM holds only
 * the lines that pass the current filter, so filtering is a re-render from
 * the store and the download always contains everything.
 *
 * @param {HTMLElement} container the scrolling panel
 * @param {object} [opts]
 * @param {number} [opts.maxLines=2000]
 * @param {HTMLInputElement} [opts.filterInput] free-text filter
 * @param {HTMLSelectElement} [opts.severitySelect] values:
 *   `all` | `err` | `warnup` (warn and worse) | `txrx`
 * @param {HTMLElement} [opts.downloadButton]
 * @param {HTMLElement} [opts.clearButton]
 * @param {HTMLElement} [opts.countEl] shows "shown / total lines" when filtering
 * @param {string} [opts.fileName="event-log.txt"]
 * @param {boolean} [opts.timestamps=true] prefix each line with the host time
 * @returns {{
 *   log: (...args: unknown[]) => void,
 *   warn: (...args: unknown[]) => void,
 *   error: (...args: unknown[]) => void,
 *   clear: () => void,
 *   text: () => string,
 *   setFilter: (text?: string, severity?: string) => void,
 *   lineCount: () => number,
 * }}
 */
export function createLog(container, opts = {}) {
  const maxLines = opts.maxLines ?? LOG_MAX_LINES_DEFAULT;
  const timestamps = opts.timestamps !== false;
  const fileName = opts.fileName ?? "event-log.txt";

  /** @type {{text: string, sev: string}[]} */
  const lines = [];
  /** @type {{text: string, sev: string}[]} */
  let pending = [];
  let flushScheduled = false;
  let filterText = "";
  let filterSev = "all";

  const matches = (l) => {
    if (filterSev === "err" && l.sev !== "err") return false;
    if (filterSev === "warnup" && l.sev !== "err" && l.sev !== "warn")
      return false;
    if (filterSev === "txrx" && l.sev !== "tx" && l.sev !== "rx") return false;
    if (filterText && !l.text.toLowerCase().includes(filterText)) return false;
    return true;
  };

  const makeNode = (l) => {
    const div = document.createElement("div");
    div.className = "log-line sev-" + l.sev;
    div.textContent = l.text;
    return div;
  };

  // Only auto-scroll while the user is already at (or near) the tail, so
  // scrolling up to inspect something isn't yanked back down by new lines.
  const nearBottom = () =>
    container.scrollHeight - container.scrollTop - container.clientHeight < 60;

  const updateCount = () => {
    if (!opts.countEl) return;
    const filtering = filterText || filterSev !== "all";
    opts.countEl.textContent = filtering
      ? `${container.childElementCount} / ${lines.length} lines`
      : "";
  };

  // One DOM write per animation frame, however many lines arrived: at 512 Hz
  // an un-batched log is the single most expensive thing on the page.
  const flush = () => {
    flushScheduled = false;
    if (!pending.length) return;
    const stick = nearBottom();
    const frag = document.createDocumentFragment();
    for (const l of pending) if (matches(l)) frag.appendChild(makeNode(l));
    pending = [];
    container.appendChild(frag);
    while (container.childElementCount > maxLines)
      container.removeChild(container.firstElementChild);
    if (stick) container.scrollTop = container.scrollHeight;
    updateCount();
  };

  const push = (text, sev) => {
    const line = { text, sev: sev || classifyLogLine(text) };
    lines.push(line);
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    pending.push(line);
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flush);
    }
  };

  /** Full re-render from the store; used when the filter changes. */
  const rerender = () => {
    const frag = document.createDocumentFragment();
    for (const l of lines) if (matches(l)) frag.appendChild(makeNode(l));
    pending = [];
    container.replaceChildren(frag);
    container.scrollTop = container.scrollHeight;
    updateCount();
  };

  const join = (args) =>
    args
      .map((v) =>
        typeof v === "string"
          ? v
          : v instanceof Error
            ? (v.message ?? String(v))
            : safeStringify(v),
      )
      .join(" ");

  const emit = (args, sev) => {
    const body = join(args);
    push(timestamps ? `${formatLogTime()} ${body}` : body, sev);
  };

  const api = {
    log: (...args) => emit(args, null),
    warn: (...args) => emit(args, "warn"),
    error: (...args) => emit(args, "err"),
    clear: () => {
      lines.length = 0;
      pending = [];
      container.replaceChildren();
      updateCount();
    },
    text: () => lines.map((l) => l.text).join("\n"),
    setFilter: (text, severity) => {
      if (text !== undefined) filterText = String(text ?? "").toLowerCase();
      if (severity !== undefined) filterSev = severity || "all";
      rerender();
    },
    lineCount: () => lines.length,
  };

  opts.filterInput?.addEventListener("input", () =>
    api.setFilter(opts.filterInput.value, undefined),
  );
  opts.severitySelect?.addEventListener("change", () =>
    api.setFilter(undefined, opts.severitySelect.value),
  );
  opts.clearButton?.addEventListener("click", () => api.clear());
  opts.downloadButton?.addEventListener("click", () =>
    downloadBlob(fileName, new Blob([api.text()], { type: "text/plain" })),
  );

  return api;
}

/** JSON.stringify that survives circular objects and BigInt. */
function safeStringify(v) {
  try {
    return JSON.stringify(v, (_k, val) =>
      typeof val === "bigint" ? String(val) : val,
    );
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/** Never stack more than this many toasts — the oldest is dropped. */
const TOAST_MAX = 5;

/**
 * Show a transient bottom-right notification. Click to dismiss.
 *
 * The `.toast-stack#toasts` container is created on first use, so a page
 * needs no markup for this.
 *
 * @param {string} message
 * @param {"ok"|"err"|"warn"|"info"} [kind="info"]
 * @param {{ttlMs?: number}} [opts] default 8000 ms for `err`, else 4500 ms
 * @returns {HTMLElement} the toast element
 */
export function showToast(message, kind = "info", opts = {}) {
  let stack = document.getElementById("toasts");
  if (!stack) {
    stack = el("div", { id: "toasts", class: "toast-stack" });
    // aria-live so a toast is announced; "polite" because none of these
    // interrupt anything the user is doing.
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const node = el("div", {
    class: "toast " + (kind || "info"),
    text: String(message),
    title: "Click to dismiss",
  });
  const ttl = opts.ttlMs ?? (kind === "err" ? 8000 : 4500);
  let timer = setTimeout(dismiss, ttl);
  function dismiss() {
    clearTimeout(timer);
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 180);
  }
  node.addEventListener("click", dismiss);
  stack.appendChild(node);
  while (stack.childElementCount > TOAST_MAX)
    stack.removeChild(stack.firstElementChild);
  return node;
}

// ---------------------------------------------------------------------------
// Declarative control gating
// ---------------------------------------------------------------------------

/**
 * Declarative enable/disable for every control under `root`.
 *
 * Tag a control in the markup and it follows the device state with no
 * per-control JS:
 *
 *   data-requires="connected"  connected at all
 *   data-requires="idle"       connected, not streaming, not busy — the state
 *                              a command needs, because the sensor services
 *                              one operation at a time and issuing a second
 *                              during a stream can lock it up
 *   data-requires="streaming"  only while streaming (e.g. Stop)
 *   data-requires="recording"  only while logging to the card
 *
 * Optionally add `data-cap="stream|sdbt|infomem|calib|rtc|ranges|exg"`: the
 * control also stays disabled unless `state.caps[cap]` is true. Capability is
 * a floor the connected-state cannot lift, exactly as on the connect buttons
 * — a firmware that cannot do SD-over-Bluetooth should never hand the user a
 * live SD button just because something connected.
 *
 * Simplified from console.js L1889-1975: that version hard-codes an id list
 * and re-applies half a dozen feature gates. Here the markup carries the
 * requirement and the page owns nothing but the state object.
 *
 * @param {HTMLElement|Document} [root=document]
 * @returns {{apply: (state: {
 *   connected?: boolean, streaming?: boolean, recording?: boolean,
 *   busy?: boolean, caps?: Record<string, boolean>
 * }) => void}}
 */
export function createGate(root = document) {
  const REQUIREMENTS = {
    connected: (s) => !!s.connected,
    idle: (s) => !!s.connected && !s.streaming && !s.busy,
    streaming: (s) => !!s.connected && !!s.streaming,
    recording: (s) => !!s.connected && !!s.recording,
  };

  return {
    apply(state = {}) {
      const caps = state.caps ?? {};
      for (const node of root.querySelectorAll("[data-requires]")) {
        const test = REQUIREMENTS[node.dataset.requires];
        // An unknown requirement is a markup typo. Leave the control alone
        // rather than silently disabling it forever, which reads as a bug in
        // the device rather than in the HTML.
        if (!test) continue;
        let enabled = test(state);
        const cap = node.dataset.cap;
        if (enabled && cap) enabled = !!caps[cap];
        node.disabled = !enabled;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * Wire a WAI-ARIA tablist.
 *
 * Markup: `.tabs > button[data-tab="panelId"]` plus `.tab` panels carrying
 * those ids. Roles, `aria-selected`, `aria-controls`/`aria-labelledby` and
 * the roving tabindex are all set here rather than in the markup, so the
 * buttons and panels stay a single source of truth.
 *
 * Arrow keys move between tabs (Home/End to the ends), per the WAI-ARIA tabs
 * pattern. Source: console.js L7777-7817.
 *
 * @param {HTMLElement|Document} [root=document]
 * @param {{onSelect?: (panelId: string) => void}} [opts]
 * @returns {{select: (panelId: string) => void, selected: () => string|null}}
 */
export function initTabs(root = document, opts = {}) {
  const list = root.querySelector(".tabs");
  const buttons = Array.from(root.querySelectorAll(".tabs [data-tab]"));
  const panels = Array.from(root.querySelectorAll(".tab"));
  if (list) list.setAttribute("role", "tablist");
  if (!buttons.length) return { select: () => {}, selected: () => null };

  const select = (btn) => {
    if (!btn) return;
    const target = btn.dataset.tab;
    for (const b of buttons) {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.tabIndex = active ? 0 : -1;
    }
    for (const p of panels) p.classList.toggle("active", p.id === target);
    opts.onSelect?.(target);
  };

  for (const btn of buttons) {
    const target = btn.dataset.tab;
    btn.setAttribute("role", "tab");
    if (target) {
      btn.setAttribute("aria-controls", target);
      if (!btn.id) btn.id = "tabbtn-" + target;
      const panel = root.querySelector("#" + CSS.escape(target));
      if (panel) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", btn.id);
      }
    }
    const active = btn.classList.contains("active");
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.tabIndex = active ? 0 : -1;
    btn.addEventListener("click", () => select(btn));
    btn.addEventListener("keydown", (e) => {
      let idx = buttons.indexOf(btn);
      if (e.key === "ArrowRight") idx = (idx + 1) % buttons.length;
      else if (e.key === "ArrowLeft")
        idx = (idx - 1 + buttons.length) % buttons.length;
      else if (e.key === "Home") idx = 0;
      else if (e.key === "End") idx = buttons.length - 1;
      else return;
      e.preventDefault();
      buttons[idx].focus();
      select(buttons[idx]);
    });
  }

  // Nothing marked active in the markup: open the first tab, so the page is
  // never a row of tabs above an empty area.
  if (!buttons.some((b) => b.classList.contains("active"))) select(buttons[0]);

  return {
    select: (panelId) => select(buttons.find((b) => b.dataset.tab === panelId)),
    selected: () =>
      buttons.find((b) => b.getAttribute("aria-selected") === "true")?.dataset
        .tab ?? null,
  };
}

// ---------------------------------------------------------------------------
// Downloads and formatters
// ---------------------------------------------------------------------------

/**
 * Save a Blob to the host's downloads folder.
 *
 * @param {string} filename
 * @param {Blob} blob
 */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a delay: some browsers invalidate the URL before the
  // download starts if it is revoked synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Byte count as B / KB / MB / GB. Source: sd-download/index.html L286-292.
 *
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Sample rate in Hz. Shimmer rates are divisor-derived and rarely integral
 * (32768/640 = 51.2), so one decimal is kept unless the value is whole.
 *
 * No kHz below 10 kHz: a Shimmer3R rate of 1024 Hz reads worse as
 * "1.02 kHz" than as the exact number the config actually holds.
 *
 * @param {number|null|undefined} hz
 * @returns {string}
 */
export function fmtHz(hz) {
  if (hz == null || !Number.isFinite(hz)) return "–";
  if (hz >= 10000) return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 2)} kHz`;
  if (Number.isInteger(hz)) return `${hz} Hz`;
  return `${hz.toFixed(hz < 10 ? 2 : 1)} Hz`;
}

/**
 * Elapsed time from milliseconds: `12.3 s`, `4:07`, `1:02:33`.
 *
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const total = Math.max(0, Math.floor(ms / 1000));
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}
