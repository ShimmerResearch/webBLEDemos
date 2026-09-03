/**
 * Factory self-test runner: ask a Shimmer3 or Shimmer3R to run the test suite
 * its firmware runs at the factory, show the report as it prints, and hand the
 * result over as text or as parsed rows.
 *
 * Three things about the firmware shape everything here:
 *
 *  1. The report is RAW TEXT on the same link, sent after the command's
 *     acknowledgement with no opcode, no length and no checksum. The SDK's
 *     `runFactoryTest` owns that switch; this panel only receives text.
 *  2. The sensor stops everything else for the duration — up to about a
 *     minute for the LED-state walk-through — and answers nothing until the
 *     report ends. That is why the mounting page is told the link is busy for
 *     the WHOLE run, and why the copy says so before anyone clicks.
 *  3. There is no abort command. Cancel stops this page listening; the sensor
 *     keeps printing to its own end. The link is therefore still busy after a
 *     cancel, and this panel keeps reporting that until it is really free.
 *
 * The LED suites are meant to be watched: each line names the LED that should
 * be lit at that moment, so the lines arrive paced, not in a batch, and are
 * shown as they arrive rather than at the end.
 *
 * The panel builds its own markup inside the host element and owns the
 * `disabled` state of every control in it. It holds no page-specific ids and
 * reads no page globals: the client it is handed, the log it writes to and its
 * callbacks are the whole of its outside world. Nothing here touches
 * `document` at import time.
 *
 *   import { createFactoryTestPanel } from "../common/factory-test-panel.js";
 */

import { el, downloadBlob } from "./ui-chrome.js";
/* The whole namespace rather than destructured names: a vendored bundle that
   predates the factory-test exports then degrades to a message from
   `createFactoryTestPanel()` instead of breaking the importing page. */
import * as sdk from "../vendor/shimmer-web-sdk.esm.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the elapsed/remaining readout is repainted while a test runs. */
const TICK_MS = 250;

/** Narrowest timeout the firmware's shortest suite can plausibly need. */
const MIN_TIMEOUT_S = 10;
/** Widest the input accepts — past this, something is wrong with the link. */
const MAX_TIMEOUT_S = 600;

/**
 * Stick the report to its own tail only while the reader is already there.
 * Scroll back to read a line and the incoming text must not yank it away.
 */
const STICK_PX = 60;

/** The three verdict words the firmware prints, and their classes. */
const VERDICT_CLASS = Object.freeze({
  PASS: "tr-pass",
  FAIL: "tr-fail",
  WARNING: "tr-warn",
});
const VERDICT_RE = /\b(PASS|FAIL|WARNING)\b/g;

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Mount the self-test panel inside `host`.
 *
 * @param {HTMLElement} host an empty container; its contents are replaced
 * @param {object} opts
 * @param {object|(() => object|null)} opts.client the connected client, or a
 *   getter for it. Pass the GETTER form from a page whose client comes and
 *   goes with the link — the panel is mounted once and reads whatever is
 *   current, so it can never hold a stale client.
 * @param {string|(() => string|null)} [opts.mode] `"ble"`, `"rfcomm"` or
 *   `"usb"`, or a getter. Only used to describe the run in the log and the
 *   exported metadata: every link can run the test.
 * @param {number|null|(() => number|null)} [opts.identifiedHardwareVersion]
 *   the hardware version the sensor actually reported, or a getter for it.
 *   Recorded in the exported metadata; never defaulted, because "we did not
 *   ask" and "it said 10" are different facts about a report.
 * @param {{log: Function, warn: Function, error: Function}} [opts.log]
 * @param {(message: string, kind?: string) => void} [opts.toast]
 * @param {(busy: boolean) => void} [opts.onBusyChange] true from the moment
 *   Run is pressed until the link is genuinely free again — which is AFTER a
 *   cancel, because the sensor goes on printing. A host page folds this into
 *   its own busy state so everything else that shares the link is refused
 *   with a reason while the sensor is unreachable.
 * @param {() => string|null} [opts.canRun] the page's reason a run must be
 *   refused right now, or null to go ahead. Asked on every click, so a page
 *   never has to keep this panel's enabled state in step with its own.
 * @param {string|(() => string)} [opts.fileNamePrefix] leading part of saved
 *   file names
 * @param {() => string} [opts.deviceLabel] what to call the sensor in the
 *   exported metadata
 * @returns {{
 *   run: (type?: number) => Promise<boolean>,
 *   cancel: (reason?: string) => void,
 *   running: () => boolean,
 *   draining: () => boolean,
 *   lastReport: () => object|null,
 *   setEnabled: (enabled: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createFactoryTestPanel(host, opts = {}) {
  const getClient =
    typeof opts.client === "function" ? opts.client : () => opts.client ?? null;
  const getMode =
    typeof opts.mode === "function" ? opts.mode : () => opts.mode ?? null;
  const getHardwareVersion =
    typeof opts.identifiedHardwareVersion === "function"
      ? opts.identifiedHardwareVersion
      : () => opts.identifiedHardwareVersion ?? null;
  const log = opts.log ?? { log() {}, warn() {}, error() {} };
  const toast = opts.toast ?? (() => {});
  const onBusyChange = opts.onBusyChange ?? (() => {});
  const canRun = opts.canRun ?? (() => null);
  const namePrefix =
    typeof opts.fileNamePrefix === "function"
      ? opts.fileNamePrefix
      : () => opts.fileNamePrefix ?? "shimmer";
  const deviceLabel = opts.deviceLabel ?? (() => "");

  /* A vendored bundle from before the self-test shipped. Say so here, once,
     rather than throwing from the first Run: the page mounts this panel
     unconditionally and gets a banner where the runner would have been.
     The CSV helper is deliberately NOT required — without it the panel drops
     one button and still runs the test and saves the text, which is the part
     that cannot be reproduced later. */
  const missingSdk = [];
  if (
    !Array.isArray(sdk.SHIMMER3_FACTORY_TEST_TYPES) ||
    sdk.SHIMMER3_FACTORY_TEST_TYPES.length === 0
  )
    missingSdk.push("SHIMMER3_FACTORY_TEST_TYPES");
  if (typeof sdk.parseShimmerFactoryTestReport !== "function")
    missingSdk.push("parseShimmerFactoryTestReport");
  if (missingSdk.length) {
    host.replaceChildren(
      el(
        "div",
        { class: "banner err" },
        `This page is running an SDK bundle with no factory self-test support (missing ${missingSdk.join(", ")}). Re-vendor the SDK to run the sensor's self-test.`,
      ),
    );
    log.error(
      `Factory self-test unavailable: the vendored SDK has no ${missingSdk.join(", ")}`,
    );
    return inertPanel();
  }

  const TYPES = sdk.SHIMMER3_FACTORY_TEST_TYPES;
  const canCsv = typeof sdk.shimmerFactoryTestReportToCsvRows === "function";

  /** Non-null only while a run is in flight. */
  let abortCtl = null;
  /** True from Run until the report ends (or the drain after a cancel does). */
  let busy = false;
  /** True while the sensor is still printing to a page that stopped reading. */
  let drainingNow = false;
  /** The last completed report, whatever its verdict. */
  let report = null;
  /** The floor the host page sets: may a run be STARTED at all. */
  let enabled = false;
  /** The user has typed a timeout, so a type change must not overwrite it. */
  let timeoutTouched = false;
  let destroyed = false;
  let ticker = null;
  let startedAtMs = 0;
  let expectedMs = 0;
  /** Text received but not yet terminated by a newline. */
  let pending = "";
  /** The node holding `pending`, replaced in place as more arrives. */
  let tailNode = null;

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  const typeSelect = el(
    "select",
    { dataset: { testRole: "type" } },
    ...TYPES.map((t) =>
      el("option", { value: String(t.value) }, t.label ?? t.name),
    ),
  );

  const timeoutInput = el("input", {
    type: "number",
    min: String(MIN_TIMEOUT_S),
    max: String(MAX_TIMEOUT_S),
    step: "5",
    dataset: { testRole: "timeout" },
    style: { width: "6em" },
  });

  const btnRun = el(
    "button",
    { type: "button", class: "primary", dataset: { testRole: "run" } },
    "Run self-test",
  );
  const btnCancel = el(
    "button",
    { type: "button", dataset: { testRole: "cancel" } },
    "Cancel",
  );
  const btnCopy = el(
    "button",
    { type: "button", dataset: { testRole: "copy" } },
    "Copy",
  );
  const btnTxt = el(
    "button",
    { type: "button", dataset: { testRole: "saveTxt" } },
    "Save .txt",
  );
  const btnCsv = canCsv
    ? el("button", { type: "button", dataset: { testRole: "csv" } }, "Save CSV")
    : null;

  const typeHint = el("div", { class: "field-hint" });
  const statusLine = el("span", {
    class: "muted",
    dataset: { testRole: "status" },
  });
  const progressPill = el(
    "span",
    { class: "pill", dataset: { testRole: "progress" }, hidden: true },
    "",
  );
  const summaryLine = el("span", {
    class: "pill",
    dataset: { testRole: "summary" },
    hidden: true,
  });

  const reportBlock = el("div", {
    class: "test-report",
    dataset: { testRole: "report" },
    tabindex: "0",
  });

  host.replaceChildren(
    el(
      "div",
      { class: "row" },
      el("label", {}, "Test", typeSelect),
      el("label", {}, "Give up after (s)", timeoutInput),
      btnRun,
      btnCancel,
      progressPill,
    ),
    typeHint,
    el("div", { class: "row" }, statusLine, summaryLine),
    reportBlock,
    el("div", { class: "row" }, btnCopy, btnTxt, btnCsv),
  );

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  function selectedType() {
    const value = Number(typeSelect.value);
    return TYPES.find((t) => t.value === value) ?? TYPES[0];
  }

  /** Seconds below which a timeout would cut the chosen suite off mid-report. */
  function floorSecondsFor(info) {
    const expected = Number(info?.expectedDurationMs) || 0;
    return Math.max(MIN_TIMEOUT_S, Math.ceil((expected * 1.5) / 1000));
  }

  function applyTypeToTimeout() {
    const info = selectedType();
    const floor = floorSecondsFor(info);
    timeoutInput.min = String(floor);
    const preferred = Math.round((Number(info.defaultTimeoutMs) || 0) / 1000);
    if (!timeoutTouched && preferred > 0)
      timeoutInput.value = String(preferred);
    /* A timeout under the suite's own expected duration is not a shorter
       wait, it is a report that ends in the middle. Raise it rather than
       letting the run be set up to fail. */
    if (Number(timeoutInput.value) < floor) {
      timeoutInput.value = String(floor);
      if (timeoutTouched)
        log.warn(
          `the ${info.label ?? info.name} test takes about ${Math.round((Number(info.expectedDurationMs) || 0) / 1000)} s, so the timeout was raised to ${floor} s`,
        );
    }
    typeHint.textContent = info.description ?? "";
  }

  function timeoutMs() {
    const info = selectedType();
    const s = Math.min(
      MAX_TIMEOUT_S,
      Math.max(floorSecondsFor(info), Number(timeoutInput.value) || 0),
    );
    timeoutInput.value = String(s);
    return s * 1000;
  }

  function syncControls() {
    const idle = !busy;
    typeSelect.disabled = !enabled || !idle;
    timeoutInput.disabled = !enabled || !idle;
    btnRun.disabled = !enabled || !idle;
    /* Cancel and the exports do NOT take the page's floor: cancelling is how
       a run is escaped, and a report already on screen stays saveable even
       after the link has gone. */
    btnCancel.disabled = !abortCtl;
    btnCancel.hidden = !abortCtl;
    const hasReport = !!report?.text;
    btnCopy.disabled = !hasReport;
    btnTxt.disabled = !hasReport;
    if (btnCsv) btnCsv.disabled = !hasReport || !report?.parsed;
  }

  function setBusy(next) {
    if (busy === next) return;
    busy = next;
    syncControls();
    try {
      onBusyChange(busy);
    } catch (e) {
      log.warn(`busy callback failed: ${String(e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering the report as it arrives
  // -------------------------------------------------------------------------

  function clearReport() {
    reportBlock.replaceChildren();
    pending = "";
    tailNode = null;
    summaryLine.hidden = true;
    summaryLine.textContent = "";
    summaryLine.className = "pill";
  }

  /** One complete line, with its verdict words picked out. */
  function appendLine(line) {
    const frag = document.createDocumentFragment();
    let at = 0;
    VERDICT_RE.lastIndex = 0;
    for (let m = VERDICT_RE.exec(line); m; m = VERDICT_RE.exec(line)) {
      if (m.index > at)
        frag.appendChild(document.createTextNode(line.slice(at, m.index)));
      frag.appendChild(el("span", { class: VERDICT_CLASS[m[1]] ?? "" }, m[1]));
      at = m.index + m[1].length;
    }
    if (at < line.length)
      frag.appendChild(document.createTextNode(line.slice(at)));
    reportBlock.appendChild(frag);
  }

  /**
   * Add received text. Complete lines are coloured; the unterminated tail is
   * shown plain and replaced as it grows, so a paced LED test reads as it
   * happens instead of appearing a line at a time after the fact.
   *
   * Text nodes throughout, never `innerHTML`: a report is device output, and
   * device output containing `<` must render as `<`.
   */
  function pushText(chunk) {
    if (!chunk) return;
    const stick =
      reportBlock.scrollHeight -
        reportBlock.scrollTop -
        reportBlock.clientHeight <=
      STICK_PX;
    if (tailNode) {
      tailNode.remove();
      tailNode = null;
    }
    pending += chunk;
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      appendLine(pending.slice(0, nl + 1));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
    if (pending) {
      tailNode = document.createTextNode(pending);
      reportBlock.appendChild(tailNode);
    }
    if (stick) reportBlock.scrollTop = reportBlock.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // Progress and status
  // -------------------------------------------------------------------------

  function startTicker() {
    stopTicker();
    ticker = setInterval(paintProgress, TICK_MS);
    paintProgress();
  }

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    progressPill.hidden = true;
  }

  function paintProgress() {
    const elapsed = Math.max(0, Date.now() - startedAtMs);
    const s = Math.round(elapsed / 1000);
    const expectedS = Math.round(expectedMs / 1000);
    progressPill.hidden = false;
    progressPill.textContent = expectedS
      ? `${s} s of about ${expectedS} s`
      : `${s} s`;
    if (drainingNow) return;
    if (expectedMs && elapsed > expectedMs * 1.5) {
      statusLine.textContent =
        "Taking longer than expected. The report ends with a TEST END line — " +
        "if it never comes, cancel and reconnect.";
    }
  }

  function paintSummary(parsed, info) {
    summaryLine.hidden = false;
    const failed = parsed?.overall?.failedTestNames ?? [];
    if (parsed?.overall?.result === "PASS") {
      summaryLine.className = "pill on";
      summaryLine.textContent = "Overall: PASS";
    } else if (parsed?.overall?.result === "FAIL") {
      summaryLine.className = "pill err";
      const mask = parsed.overall.failMaskHex
        ? ` (${parsed.overall.failMaskHex})`
        : "";
      summaryLine.textContent =
        `Overall: FAIL${mask}` +
        (failed.length ? ` — failed: ${failed.join(", ")}` : "");
    } else if (parsed && !parsed.complete) {
      summaryLine.className = "pill warn";
      summaryLine.textContent =
        "Incomplete — the report ended before its TEST END line.";
    } else if (info && info.hasOverall === false) {
      summaryLine.className = "pill";
      summaryLine.textContent =
        "Completed — this test prints no overall verdict; check the LEDs against the lines above.";
    } else {
      summaryLine.className = "pill warn";
      summaryLine.textContent = "Completed — no overall verdict was printed.";
    }
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  /**
   * Ask the sensor to run one self-test and collect its report.
   *
   * @param {number} [type] a `SHIMMER3_FACTORY_TEST_TYPES` value; defaults to
   *   whatever the select shows
   * @returns {Promise<boolean>} true when a report was received in full
   */
  async function run(type) {
    if (busy) {
      toast("A self-test is already running.", "warn");
      return false;
    }
    if (type != null) {
      const wanted = TYPES.find((t) => t.value === Number(type));
      if (wanted) typeSelect.value = String(wanted.value);
    }
    const info = selectedType();

    const refusal = canRun();
    if (refusal) {
      statusLine.textContent = refusal;
      toast(refusal, "warn");
      return false;
    }
    const client = getClient();
    if (!client) {
      toast("Connect to a sensor first.", "warn");
      return false;
    }
    if (typeof client.runFactoryTest !== "function") {
      const why =
        "This link's client cannot run the self-test (no runFactoryTest). Re-vendor the SDK bundle.";
      statusLine.textContent = why;
      log.error(why);
      toast(why, "err");
      return false;
    }

    /* Clear the previous report BEFORE anything can await: a run that is
       cancelled or fails must not leave the exports offering the last
       sensor's result under this one's name. */
    report = null;
    clearReport();
    abortCtl = new AbortController();
    startedAtMs = Date.now();
    expectedMs = Number(info.expectedDurationMs) || 0;
    drainingNow = false;
    statusLine.textContent = "Waiting for the report to start…";
    setBusy(true);
    syncControls();
    startTicker();

    const ms = timeoutMs();
    log.log(
      `self-test (${info.label ?? info.name}) started over ${getMode() ?? "the link"}; the sensor answers nothing else until its report ends`,
    );

    let text = "";
    try {
      text = await client.runFactoryTest(info.value, {
        timeoutMs: ms,
        signal: abortCtl.signal,
        onChunk: (chunk) => pushText(chunk),
      });
    } catch (e) {
      await finishFailed(e, info);
      return false;
    }

    stopTicker();
    abortCtl = null;
    /* The SDK resolves with everything it received; the panel may have
       rendered less if a chunk arrived without a trailing newline. */
    if (text.length > renderedLength()) pushText(text.slice(renderedLength()));
    if (pending) {
      pushText("\n");
      pending = "";
    }

    let parsed = null;
    try {
      parsed = sdk.parseShimmerFactoryTestReport(text);
    } catch (e) {
      log.warn(`the report could not be parsed: ${String(e)}`);
    }
    const finishedAt = new Date();
    report = {
      text,
      parsed,
      type: info.value,
      typeName: info.name,
      typeLabel: info.label ?? info.name,
      startedAtIso: new Date(startedAtMs).toISOString(),
      finishedAtIso: finishedAt.toISOString(),
      durationMs: Date.now() - startedAtMs,
      mode: getMode(),
      hardwareVersion: getHardwareVersion(),
      device: deviceLabel(),
    };
    paintSummary(parsed, info);
    const seconds = Math.round(report.durationMs / 1000);
    statusLine.textContent = `Finished in ${seconds} s.`;
    setBusy(false);
    syncControls();

    const overall = parsed?.overall?.result;
    if (overall === "FAIL") {
      const failed = parsed.overall.failedTestNames ?? [];
      log.error(
        `self-test (${report.typeLabel}) FAILED${parsed.overall.failMaskHex ? ` ${parsed.overall.failMaskHex}` : ""}${failed.length ? `: ${failed.join(", ")}` : ""}`,
      );
      /* Only the failing lines reach the event log. Mirroring all ~75 lines
         of a report into it would bury everything else the log is for, and
         the report itself is on screen and saveable. */
      for (const t of parsed.tests ?? []) {
        if (t.verdict === "FAIL")
          log.error(`  ${t.label ?? t.name}: ${t.detail ?? "FAIL"}`);
      }
      toast("Self-test finished: FAIL. See the report.", "err");
    } else if (!parsed?.complete) {
      log.warn(
        `self-test (${report.typeLabel}) ended before its TEST END line after ${seconds} s`,
      );
      toast("The report ended early — see the panel.", "warn");
    } else {
      log.log(
        `self-test (${report.typeLabel}) finished in ${seconds} s${overall ? `: ${overall}` : ""}`,
      );
    }
    return true;
  }

  /** Characters already rendered, tail included. */
  function renderedLength() {
    return reportBlock.textContent.length;
  }

  /** Turn a failed or cancelled run into a sentence, then wait out the sensor. */
  async function finishFailed(err, info) {
    stopTicker();
    abortCtl = null;
    const message = String(err?.message ?? err ?? "");
    const reason = err?.reason ?? null;
    const aborted = err?.name === "AbortError" || /abort|cancel/i.test(message);

    if (reason === "nack" || /NACK|refus/i.test(message)) {
      const why =
        "The sensor refused the self-test. Its firmware refuses one while it is sensing — " +
        "stop the stream, or a recording started from the sensor's own button, and try again.";
      statusLine.textContent = why;
      log.error(`self-test refused by the sensor: ${message}`);
      toast(why, "err");
      setBusy(false);
      syncControls();
      return;
    }
    if (
      reason === "disconnected" ||
      /disconnect|not connected/i.test(message)
    ) {
      statusLine.textContent = "The link dropped during the self-test.";
      log.error(`self-test lost the link: ${message}`);
      setBusy(false);
      syncControls();
      return;
    }
    if (aborted) {
      log.warn(
        `self-test cancelled; the sensor keeps printing until its report ends`,
      );
      await drain(info, "Cancelled");
      return;
    }
    if (reason === "timeout" || /timeout/i.test(message)) {
      const secs = Math.round(timeoutMs() / 1000);
      statusLine.textContent =
        `No TEST END within ${secs} s. The sensor may still be printing — ` +
        "if the next command fails, disconnect and reconnect.";
      log.error(`self-test timed out after ${secs} s`);
      toast("The self-test timed out.", "err");
      await drain(info, "Timed out");
      return;
    }
    statusLine.textContent = `The self-test failed: ${message}`;
    log.error(`self-test failed: ${message}`);
    toast("The self-test failed. See the event log.", "err");
    setBusy(false);
    syncControls();
  }

  /**
   * Hold the link busy until the sensor has really finished.
   *
   * There is no abort command: after a cancel or a timeout the sensor goes on
   * printing to its own TEST END. Releasing the page's busy flag now would let
   * the next command go out into a link that cannot answer, which presents as
   * a dead sensor rather than as a test still running. The SDK keeps swallowing
   * the text and tells us when it is idle; on a bundle without that, fall back
   * to the time the chosen suite still had to run.
   */
  async function drain(info, prefix) {
    const client = getClient();
    const expected = Number(info?.expectedDurationMs) || 0;
    const leftMs = Math.max(0, expected * 1.2 - (Date.now() - startedAtMs));
    drainingNow = true;
    syncControls();
    const say = (msLeft) => {
      const s = Math.max(0, Math.round(msLeft / 1000));
      statusLine.textContent =
        `${prefix} — the sensor is still running the test and this page has stopped listening. ` +
        `The link stays busy until its report ends${s ? `, about ${s} s more` : ""}.`;
    };
    say(leftMs);

    if (client && typeof client.whenFactoryTestIdle === "function") {
      const countdown = setInterval(
        () => say(leftMs - (Date.now() - startedAtMs)),
        TICK_MS * 4,
      );
      try {
        await client.whenFactoryTestIdle();
      } catch {
        /* An idle promise never rejects, but a stale bundle might. */
      }
      clearInterval(countdown);
    } else if (leftMs > 0) {
      await new Promise((r) => setTimeout(r, leftMs));
    }
    if (destroyed) return;
    drainingNow = false;
    statusLine.textContent = `${prefix}. The link is free again.`;
    setBusy(false);
    syncControls();
  }

  /**
   * Stop listening to a running report.
   *
   * `reason === "disconnect"` skips the drain: there is no link left to wait
   * for, so holding the page busy would strand it.
   */
  function cancel(reason) {
    if (!abortCtl && !busy) return;
    if (reason === "disconnect") {
      abortCtl?.abort(new Error("disconnected"));
      abortCtl = null;
      stopTicker();
      drainingNow = false;
      setBusy(false);
      syncControls();
      return;
    }
    abortCtl?.abort(new Error("cancelled by the user"));
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  function stamp() {
    return new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
  }

  function baseName() {
    return `${namePrefix()}_selftest-${(report?.typeName ?? "main").toLowerCase()}_${stamp()}`;
  }

  async function copy() {
    if (!report?.text) return;
    try {
      await navigator.clipboard.writeText(report.text);
      toast("Report copied.", "ok");
    } catch (e) {
      log.warn(`copy failed: ${String(e)}`);
      toast(
        "This browser would not let the page copy to the clipboard.",
        "warn",
      );
    }
  }

  function saveTxt() {
    if (!report?.text) return;
    /* The report is saved exactly as the sensor sent it, CR LF and all: it is
       a record of what a device printed, not a document to tidy up. */
    downloadBlob(
      `${baseName()}.txt`,
      new Blob([report.text], { type: "text/plain;charset=utf-8" }),
    );
    log.log(`self-test report saved as ${baseName()}.txt`);
  }

  function saveCsv() {
    if (!report?.parsed || !canCsv) return;
    const rows = sdk.shimmerFactoryTestReportToCsvRows(report.parsed, {
      device: report.device || "",
      link: report.mode ?? "",
      hardware_version:
        report.hardwareVersion == null ? "" : report.hardwareVersion,
      factory_test_type: report.type,
      factory_test_label: report.typeName,
      started_at: report.startedAtIso,
      finished_at: report.finishedAtIso,
      exported: new Date().toISOString(),
    });
    /* Typed escape, never a literal BOM character: a formatter or an editor
       that "cleans up" the file would silently drop a pasted one, and then
       Excel reads the degree signs as mojibake. */
    downloadBlob(
      `${baseName()}.csv`,
      new Blob(["\ufeff", rows.join("\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    log.log(`self-test report saved as ${baseName()}.csv`);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  typeSelect.addEventListener("change", applyTypeToTimeout);
  timeoutInput.addEventListener("input", () => {
    timeoutTouched = true;
  });
  timeoutInput.addEventListener("change", applyTypeToTimeout);
  btnRun.addEventListener("click", () => void run());
  btnCancel.addEventListener("click", () => cancel("user"));
  btnCopy.addEventListener("click", () => void copy());
  btnTxt.addEventListener("click", saveTxt);
  btnCsv?.addEventListener("click", saveCsv);

  applyTypeToTimeout();
  syncControls();

  return {
    run,
    cancel,
    running: () => !!abortCtl,
    draining: () => drainingNow,
    lastReport: () => report,
    setEnabled(next) {
      enabled = !!next;
      /* Deliberately does NOT touch a run in progress. This is the floor for
         STARTING one: a page that folded its own "a self-test is busy" state
         back in here would disable Cancel at the moment it is needed. */
      syncControls();
    },
    destroy() {
      destroyed = true;
      cancel("disconnect");
      stopTicker();
      host.replaceChildren();
    },
  };
}

/**
 * The same surface, doing nothing, for a bundle that cannot run the test.
 *
 * Returned rather than throwing so a page can mount the panel unconditionally
 * and get a banner where the runner would have been, instead of losing every
 * tab built after this one.
 */
function inertPanel() {
  return {
    run: async () => false,
    cancel() {},
    running: () => false,
    draining: () => false,
    lastReport: () => null,
    setEnabled() {},
    destroy() {},
  };
}
