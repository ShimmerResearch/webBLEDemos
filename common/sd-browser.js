/**
 * SD-card browser and downloader: list a Shimmer3R's card, choose a folder on
 * this host, and pull sessions off the card with progress, a rolling
 * throughput readout, an ETA and a resumable abort.
 *
 * Extracted from `sd-download/index.html`: the card readouts and the
 * link-speed test (L182-211, L433-463), the selectable tree (L655-715), the
 * destination folder remembered in IndexedDB (L304-369, L717-740), the layout
 * choice and its path preview (L401-424), and the download run with its
 * rolling-rate/ETA maths and delete-after-verified guard (L742-867). The ~350
 * lines of connect, platform-advice and event-log plumbing that demo also
 * carried are deliberately NOT here — `common/connect-ui.js` and
 * `common/ui-chrome.js` own those now.
 *
 * The panel builds its own markup inside the host element and owns the
 * `disabled` state of every control in it, so a page mounts it with one
 * `<div>` and one call. It holds no page-specific ids and reads no page
 * globals: the only things it knows about the outside world are the client it
 * is handed, the log it writes to, and the two callbacks below. That is what
 * lets a combined Verisense + Shimmer3 application mount it unchanged.
 *
 * Nothing here touches `document` at import time.
 *
 *   import { createSdBrowser } from "../common/sd-browser.js";
 */

import { el, fmtBytes as defaultFmtBytes } from "./ui-chrome.js";
/* The whole namespace rather than destructured names: a vendored bundle that
   predates one of the SD-transfer exports then degrades to a message from
   `mount()` instead of breaking the importing page. */
import * as sdk from "../shimmer-extension/vendor/shimmer-web-sdk.esm.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The only tree the firmware lets a host read or delete under. */
const CARD_ROOT = "data";

/**
 * The picked folder handle is persisted so the user chooses once. A browser
 * NEVER exposes the absolute path of a directory it handed out, and
 * `showDirectoryPicker` cannot be given one, so remembering the handle itself
 * is the only way to avoid re-picking on every visit.
 */
const DB_NAME = "shimmer-sd-download";
const DB_STORE = "handles";
const DEST_KEY = "destRoot";

/**
 * Picker id. The browser reopens a picker with the same `id` in the place it
 * was last used — the closest thing to a default location there is, given an
 * absolute path cannot be supplied.
 */
const PICKER_ID = "shimmer-consensys-backup";

/** Rolling-throughput window. Long enough to ride out one stalled window. */
const RATE_WINDOW_MS = 5000;

/** Default length of the firmware data-rate test. */
const LINK_TEST_MS = 5000;

/**
 * Windows is the only platform where the Consensys workspace has a
 * predictable location worth suggesting. What keeps mobile out of this panel
 * is `showDirectoryPicker`, which is Chromium-desktop only — not the link
 * layer: Android Chrome has both Web Bluetooth and (for RFCOMM) Web Serial,
 * and on iOS a bundled-stack browser can run a page like this over BLE.
 * Either way there is no destination folder to pick.
 */
const CONSENSYS_BACKUP_HINT =
  String.raw`Tip: choose %USERPROFILE%\Shimmer_Workspace\Backup so Consensys can ` +
  "import this directly (Application Settings → Manage Data → Import Data " +
  "From Backup Directory). The folder is remembered for next time.";

const LAYOUTS = Object.freeze([
  { id: "consensysBackup", label: "Consensys Backup (importable)" },
  { id: "card", label: "Mirror SD card structure" },
]);

// ---------------------------------------------------------------------------
// The remembered destination folder
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Remember a directory handle for the next visit. Best-effort: a browser in
 * private mode, or one that refuses to structured-clone a file handle, is a
 * reason to re-pick, not a reason to fail the download.
 */
async function rememberDest(handle) {
  const db = await openDb();
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(handle, DEST_KEY);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

async function recallDest() {
  try {
    const db = await openDb();
    try {
      return (
        (await new Promise((res, rej) => {
          const tx = db.transaction(DB_STORE, "readonly");
          const r = tx.objectStore(DB_STORE).get(DEST_KEY);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        })) ?? null
      );
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Re-grant write access to a remembered handle if the browser has forgotten
 * it. MUST be called from inside a user gesture — which is why it runs on the
 * download click rather than when the handle is restored on load.
 */
async function ensureWritable(handle) {
  const opts = { mode: "readwrite" };
  if (typeof handle.queryPermission !== "function") return true;
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Seconds as `4s` / `12m 07s`. Kept here rather than in `ui-chrome.js`'s
 * `fmtDuration` because an ETA reads better coarse: a download that will take
 * `7m 42s` does not become clearer as `7:42.3`.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function fmtEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Mount the SD browser inside `host`.
 *
 * @param {HTMLElement} host an empty container; its contents are replaced
 * @param {object} opts
 * @param {object|(() => object|null)} opts.client the connected Shimmer3R
 *   client, or a getter for it. Pass the GETTER form from a page whose client
 *   comes and goes with the link — the panel is mounted once and then reads
 *   whatever is current, so it can never hold a stale client.
 * @param {{log: Function, warn: Function, error: Function}} [opts.log]
 * @param {(busy: boolean) => void} [opts.onBusyChange] called when a transfer
 *   or a link test starts and finishes. A host page folds this into its own
 *   busy state, so the controls that share the link (Apply, a configuration
 *   read) are refused while a download is in flight.
 * @param {(n: number) => string} [opts.fmtBytes] byte formatter
 * @param {string} [opts.rootPath="data"] tree to walk on the card
 * @returns {{
 *   refresh: () => Promise<void>,
 *   renderTree: () => void,
 *   selectedPaths: () => string[],
 *   setLayout: (layout: string) => void,
 *   pickDestination: () => Promise<boolean>,
 *   download: (paths: string[], opts?: {deleteVerified?: boolean}) => Promise<void>,
 *   abort: () => void,
 *   measureLinkSpeed: (durationMs?: number) => Promise<void>,
 *   setEnabled: (enabled: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createSdBrowser(host, opts = {}) {
  const getClient =
    typeof opts.client === "function" ? opts.client : () => opts.client ?? null;
  const log = opts.log ?? { log() {}, warn() {}, error() {} };
  const fmtBytes = opts.fmtBytes ?? defaultFmtBytes;
  const rootPath = opts.rootPath ?? CARD_ROOT;

  /** The last card listing, or null. */
  let tree = null;
  /** The destination directory handle, or null. */
  let destRoot = null;
  /** Non-null only while a download is running. */
  let abortCtl = null;
  /**
   * The Consensys import folder an aborted or partly-failed run left behind,
   * so the next run continues into it. Cleared by a run that completes.
   */
  let pendingStamp = null;
  /** A transfer or a link test is in flight. */
  let busy = false;
  /** The floor the host page sets: is the link able to do this at all? */
  let enabled = false;
  let layout = LAYOUTS[0].id;
  let destroyed = false;

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  const stat = (key, label) =>
    el(
      "div",
      {},
      el("span", { class: "stat-label" }, label),
      el("span", { class: "stat-value", dataset: { sdStat: key } }, "–"),
    );

  const statsStrip = el(
    "div",
    { class: "stats" },
    stat("free", "Free on card"),
    stat("capacity", "Card capacity"),
    stat("files", "Files"),
    stat("bytes", "Total size"),
    stat("link", "Link speed"),
  );

  const setStat = (key, text) => {
    const node = statsStrip.querySelector(`[data-sd-stat="${key}"]`);
    if (node) node.textContent = text;
  };

  /* `data-sd-role` on every control the panel owns. Not decoration: it is
     how a mounting application (or a test) addresses one of these without
     the panel having to plant ids that would collide if it were mounted
     twice on one page. */
  const btnRefresh = el(
    "button",
    { type: "button", dataset: { sdRole: "refresh" } },
    "Refresh card contents",
  );
  const btnLinkTest = el(
    "button",
    {
      type: "button",
      dataset: { sdRole: "linkTest" },
      title:
        "Free-runs the firmware's data-rate test, which measures the link " +
        "itself rather than the file-transfer protocol",
    },
    `Measure link speed (${LINK_TEST_MS / 1000} s)`,
  );
  const treeState = el("span", {
    class: "muted",
    dataset: { sdRole: "state" },
  });
  const treeHost = el("div", { class: "sd-tree", dataset: { sdRole: "tree" } });

  const layoutSelect = el(
    "select",
    {
      "aria-label": "Folder layout",
      dataset: { sdRole: "layout" },
      onchange: (e) => setLayout(e.target.value),
    },
    LAYOUTS.map((l) => el("option", { value: l.id }, l.label)),
  );
  const pathHint = el("div", {
    class: "banner info",
    dataset: { sdRole: "hint" },
  });
  const btnPickDest = el(
    "button",
    { type: "button", dataset: { sdRole: "pickDest" } },
    "Choose destination folder…",
  );
  const destLabel = el(
    "span",
    { class: "muted", dataset: { sdRole: "dest" } },
    "No folder selected",
  );
  const destPreview = el("div", {
    class: "row muted",
    dataset: { sdRole: "preview" },
  });
  const chkDelete = el("input", {
    type: "checkbox",
    checked: true,
    dataset: { sdRole: "delete" },
  });

  const btnDownloadSel = el(
    "button",
    {
      type: "button",
      class: "primary",
      dataset: { sdRole: "downloadSelected" },
    },
    "Download selected",
  );
  const btnDownloadAll = el(
    "button",
    { type: "button", dataset: { sdRole: "downloadAll" } },
    "Download all",
  );
  const btnAbort = el(
    "button",
    { type: "button", class: "danger", dataset: { sdRole: "abort" } },
    "Abort",
  );
  const progress = el("progress", {
    class: "sd-progress",
    dataset: { sdRole: "bar" },
    max: "100",
    value: "0",
  });
  const progLabel = el(
    "div",
    { class: "row muted", dataset: { sdRole: "progress" } },
    "Idle",
  );
  const fileLabel = el("div", {
    class: "row muted",
    dataset: { sdRole: "file" },
  });

  host.replaceChildren(
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-title" }, "Card"),
      statsStrip,
      el("div", { class: "row" }, btnRefresh, btnLinkTest, treeState),
      treeHost,
    ),
    el(
      "div",
      { class: "card" },
      el("div", { class: "card-title" }, "Download"),
      /* The select sits INSIDE its label rather than being tied to it by id:
         a panel that a page can mount twice must not plant a fixed id. */
      el(
        "div",
        { class: "row" },
        el("label", { class: "muted" }, "Folder layout ", layoutSelect),
      ),
      pathHint,
      el("div", { class: "row" }, btnPickDest, destLabel),
      destPreview,
      el(
        "div",
        { class: "row" },
        el("label", {}, chkDelete, " Delete from card after verified download"),
      ),
      el("div", { class: "row" }, btnDownloadSel, btnDownloadAll, btnAbort),
      el("div", { class: "row" }, progress),
      progLabel,
      fileLabel,
    ),
  );

  // -------------------------------------------------------------------------
  // Control state
  // -------------------------------------------------------------------------

  /**
   * One writer for every `disabled` in this panel.
   *
   * `enabled` is the host page's floor — is this link and this firmware able
   * to transfer files at all — and nothing here lifts it. The destination
   * controls are the exception: choosing (or being reminded of) a folder is
   * host state, not device state, so it stays available while disconnected,
   * exactly as saving a configuration image does.
   */
  function syncControls() {
    if (destroyed) return;
    const usable = enabled && !!getClient() && !busy;
    const ready = usable && !!destRoot && !!tree;
    btnRefresh.disabled = !usable;
    btnLinkTest.disabled = !usable;
    btnDownloadSel.disabled = !ready || selectedPaths().length === 0;
    btnDownloadAll.disabled = !ready || !tree?.files.length;
    btnAbort.disabled = abortCtl === null;
    btnPickDest.disabled = busy || !("showDirectoryPicker" in window);
    layoutSelect.disabled = busy;
    chkDelete.disabled = busy;
    for (const box of treeHost.querySelectorAll("input[type=checkbox]")) {
      box.disabled = !usable;
    }
  }

  function setBusy(next) {
    if (busy === next) return;
    busy = next;
    syncControls();
    try {
      opts.onBusyChange?.(next);
    } catch (err) {
      log.warn(`SD busy handler failed: ${err?.message ?? err}`);
    }
  }

  // -------------------------------------------------------------------------
  // The tree
  // -------------------------------------------------------------------------

  /**
   * Group the flat file list by session directory.
   *
   * The session folder is the selectable unit because that is the unit the
   * SDK's `downloadSdTree({rootPath})` transfers, and the unit a researcher
   * thinks in: one recording. Files are listed underneath, unselectable, so
   * what a tick is about to pull down is visible without a second click.
   */
  function renderTree() {
    if (destroyed) return;
    const bySession = new Map();
    for (const f of tree?.files ?? []) {
      const dir = f.path.slice(0, f.path.lastIndexOf("/"));
      if (!bySession.has(dir)) bySession.set(dir, { files: [], bytes: 0 });
      const s = bySession.get(dir);
      s.files.push(f);
      s.bytes += f.size;
    }

    if (!bySession.size) {
      treeHost.replaceChildren(
        el("div", { class: "muted" }, "No data files on card."),
      );
      syncControls();
      return;
    }

    const list = el(
      "ul",
      {},
      Array.from(bySession, ([dir, info]) =>
        el(
          "li",
          {},
          el(
            "label",
            {},
            el("input", {
              type: "checkbox",
              dataset: { sdPath: dir },
              onchange: syncControls,
            }),
            dir,
          ),
          el(
            "span",
            { class: "sd-size" },
            `${info.files.length} file(s), ${fmtBytes(info.bytes)}`,
          ),
          el(
            "ul",
            {},
            info.files.map((f) =>
              el(
                "li",
                { class: "sd-file" },
                f.path.slice(f.path.lastIndexOf("/") + 1),
                el("span", { class: "sd-size" }, fmtBytes(f.size)),
              ),
            ),
          ),
        ),
      ),
    );
    treeHost.replaceChildren(list);
    syncControls();
  }

  /** Forget the card: no listing, no readouts, no progress. */
  function clearCard() {
    tree = null;
    renderTree();
    for (const key of ["free", "capacity", "files", "bytes", "link"]) {
      setStat(key, "–");
    }
    treeState.textContent = "";
    progLabel.textContent = "Idle";
    fileLabel.textContent = "";
    progress.max = 100;
    progress.value = 0;
  }

  /** The card paths whose checkbox is ticked. */
  function selectedPaths() {
    return Array.from(
      treeHost.querySelectorAll("input[type=checkbox]:checked"),
      (box) => box.dataset.sdPath,
    );
  }

  /** Free space, then the tree. Both tolerate a refusal with a reason. */
  async function refresh() {
    const client = getClient();
    if (!client) return;

    if (typeof client.sdGetFreeSpace === "function") {
      try {
        const space = await client.sdGetFreeSpace();
        setStat("free", fmtBytes(space.freeKB * 1024));
        setStat("capacity", fmtBytes(space.totalKB * 1024));
      } catch (err) {
        log.warn(`Free-space query failed: ${err?.message ?? err}`);
      }
    }

    treeState.textContent = "Listing card…";
    try {
      tree = await sdk.enumerateSdTree(client, rootPath);
      renderTree();
      setStat("files", String(tree.files.length));
      setStat("bytes", fmtBytes(tree.totalBytes));
      treeState.textContent = "";
      log.log(
        `card listed: ${tree.files.length} file(s) under ${rootPath}/, ` +
          `${fmtBytes(tree.totalBytes)} in ${tree.dirs.length} folder(s)`,
      );
    } catch (err) {
      tree = null;
      treeHost.replaceChildren();
      /* An SdTransferError carries the firmware's own in-band status byte —
         "SD unavailable (docked, USB-C plugged, no card or bad card)" is a
         different problem from a link that stopped answering, and the reader
         can act on the difference. */
      treeState.textContent =
        err instanceof sdk.SdTransferError
          ? `Cannot list card: ${err.message}`
          : `Listing failed: ${err?.message ?? err}`;
      log.error(treeState.textContent);
      renderTree();
    }
    syncControls();
  }

  // -------------------------------------------------------------------------
  // Destination
  // -------------------------------------------------------------------------

  function setLayout(next) {
    layout = LAYOUTS.some((l) => l.id === next) ? next : LAYOUTS[0].id;
    if (layoutSelect.value !== layout) layoutSelect.value = layout;
    refreshDestPreview();
  }

  /** Show the path the current layout will actually produce. */
  function refreshDestPreview() {
    if (!destRoot) {
      destPreview.textContent = "";
      return;
    }
    // The folder a download would go into RIGHT NOW, which after an aborted
    // run is the one it left unfinished rather than a fresh one.
    const stamp = pendingStamp ?? sdk.formatSdImportStamp();
    destPreview.textContent =
      layout === "consensysBackup"
        ? `Files will be written to ${destRoot.name}/${stamp}/<ShimmerName>/${rootPath}/…`
        : `Files will be written to ${destRoot.name}/${rootPath}/…`;
  }

  function setDestLabel(remembered) {
    destLabel.textContent = destRoot
      ? `Saving into: ${destRoot.name}${remembered ? " (remembered)" : ""}`
      : "No folder selected";
    refreshDestPreview();
  }

  /** @returns {Promise<boolean>} true when a folder is now chosen */
  async function pickDestination() {
    if (!("showDirectoryPicker" in window)) {
      log.error(
        "File System Access API unavailable in this browser — a destination folder cannot be chosen here.",
      );
      return false;
    }
    try {
      destRoot = await window.showDirectoryPicker({
        mode: "readwrite",
        id: PICKER_ID,
        startIn: destRoot ?? undefined,
      });
      setDestLabel(false);
      log.log(`destination folder chosen: ${destRoot.name}`);
      try {
        await rememberDest(destRoot);
      } catch (err) {
        log.warn(
          `Could not remember the destination folder: ${err?.message ?? err}`,
        );
      }
      return true;
    } catch {
      /* the user cancelled the picker */
      return false;
    } finally {
      syncControls();
    }
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * Rolling throughput over the last ~5 s of progress events.
   *
   * Instantaneous rate from one window is unreadable and an average over the
   * whole run under-reports a link that has since sped up, so this keeps a
   * short sample window. Returns null — meaning "show no rate" — until there
   * is a sample pair far enough apart to divide by.
   */
  function makeRollingRate() {
    const samples = [];
    return (bytesDone) => {
      const now = Date.now();
      samples.push({ t: now, b: bytesDone });
      while (samples.length >= 2 && now - samples[0].t > RATE_WINDOW_MS) {
        samples.shift();
      }
      if (samples.length < 2) return null;
      const dt = (now - samples[0].t) / 1000;
      return dt > 0.5 ? (bytesDone - samples[0].b) / 1024 / dt : null;
    };
  }

  /**
   * Ask before deleting, naming the scope rather than warning generically.
   *
   * Deleting is the default, so a vague warning is one nobody reads. The
   * counts come from the last listing; only files this host has downloaded
   * AND verified by size are ever deleted, and that guard lives in the SDK's
   * `downloadSdTree` — this dialog only reports what it is about to attempt.
   */
  function confirmDelete(rootPaths) {
    const doomed = (tree?.files ?? []).filter((f) =>
      rootPaths.some((r) => f.path === r || f.path.startsWith(r + "/")),
    );
    const sessions = new Set(
      doomed.map((f) => f.path.slice(0, f.path.lastIndexOf("/"))),
    );
    const bytes = doomed.reduce((n, f) => n + f.size, 0);
    return window.confirm(
      "After each file is downloaded and verified it will be DELETED " +
        "from the SD card.\n\nAbout to transfer, then delete:\n" +
        `  ${doomed.length} file(s), ${fmtBytes(bytes)}\n` +
        `  ${sessions.size} session folder(s)\n\n` +
        'Untick "Delete from card after verified download" to keep the ' +
        "data on the card.\n\nContinue?",
    );
  }

  /**
   * Download `rootPaths` (card paths) into the chosen destination.
   *
   * @param {string[]} rootPaths
   * @param {{deleteVerified?: boolean}} [runOpts]
   */
  async function download(rootPaths, runOpts = {}) {
    const client = getClient();
    if (!client) {
      log.warn("Connect a sensor before downloading from its card.");
      return;
    }
    if (!destRoot) {
      log.warn("Choose a destination folder before downloading.");
      return;
    }
    if (!rootPaths.length) {
      log.warn("Nothing selected to download.");
      return;
    }
    if (busy) {
      log.warn("A card operation is already running.");
      return;
    }

    const deleteAfterVerify = runOpts.deleteVerified ?? chkDelete.checked;
    if (deleteAfterVerify && !confirmDelete(rootPaths)) return;

    /* A remembered handle may need write access re-granted, and the browser
       only grants it from inside a user gesture — which is why this sits on
       the click path with nothing slow awaited in front of it. */
    if (!(await ensureWritable(destRoot))) {
      log.error("Write access to the destination folder was not granted.");
      return;
    }

    /* One import folder for the whole run, so selecting several sessions
       still produces a single Consensys import rather than one per session.
       An unfinished run keeps its folder for the NEXT run: the stamp is what
       decides the destination path, so minting a fresh one after an abort
       would file the rest of the transfer in a second folder beside the
       first — resuming nothing and leaving two half-imports for Consensys to
       find. `pendingStamp` is cleared only by a run that completes. */
    const importStamp = pendingStamp ?? sdk.formatSdImportStamp();
    if (layout === "consensysBackup") {
      log.log(
        pendingStamp
          ? `resuming into the Consensys import folder ${importStamp}/ that the last run left unfinished`
          : `writing Consensys import folder ${importStamp}/`,
      );
    }

    abortCtl = new AbortController();
    setBusy(true);
    syncControls();
    progress.max = 100;
    progress.value = 0;
    progLabel.textContent = "Listing card…";
    fileLabel.textContent = "";

    const startedAt = Date.now();
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    let bytes = 0;
    /* Assume the worst until the run says otherwise, so every path out of the
       try — including one added later — keeps the import folder for a
       re-run rather than orphaning it. */
    let unfinished = true;

    try {
      for (const root of rootPaths) {
        log.log(`downloading ${root}…`);
        const rollingRate = makeRollingRate();
        const summary = await sdk.downloadSdTree(client, destRoot, {
          rootPath: root,
          deleteAfterVerify,
          layout,
          importStamp,
          signal: abortCtl.signal,
          onProgress: (p) => {
            /* The enumerate event fires before anything is known — every
               count in it is zero — and it stands until the first read
               window completes, which on a slow link is a whole second.
               "enumerate: 0/0 files, 0 B / 0 B" is a worse thing to leave on
               screen for that second than the sentence already there. */
            if (p.phase === "enumerate") return;
            if (p.bytesTotal > 0) {
              progress.max = p.bytesTotal;
              progress.value = p.bytesDone;
            }
            const rate =
              p.phase === "download" ? rollingRate(p.bytesDone) : null;
            const eta = rate
              ? fmtEta((p.bytesTotal - p.bytesDone) / 1024 / rate)
              : "–";
            progLabel.textContent =
              `${p.phase}: ${p.filesDone}/${p.filesTotal} files, ` +
              `${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}` +
              (rate ? ` @ ${rate.toFixed(1)} KB/s, ETA ${eta}` : "");
            fileLabel.textContent = p.currentFile
              ? `${p.currentFile} (${fmtBytes(p.fileBytesDone)} / ${fmtBytes(p.fileBytesTotal)})`
              : "";
          },
        });
        downloaded += summary.filesDownloaded;
        skipped += summary.filesSkipped;
        failed += summary.filesFailed.length;
        bytes += summary.bytesDownloaded;
        for (const f of summary.filesFailed) {
          log.error(`FAILED ${f.path}: ${f.error}`);
        }
        for (const d of summary.deletedFromCard) {
          log.log(`deleted from card: ${d}`);
        }
      }
      const elapsedS = (Date.now() - startedAt) / 1000;
      const avg =
        bytes > 0 && elapsedS > 0
          ? ` (avg ${(bytes / 1024 / elapsedS).toFixed(1)} KB/s)`
          : "";
      log.log(
        `done in ${elapsedS.toFixed(1)}s — ${downloaded} downloaded, ` +
          `${skipped} already up to date, ${failed} failed, ` +
          `${fmtBytes(bytes)} transferred${avg}.`,
      );
      progLabel.textContent = "Done";
      fileLabel.textContent = "";
      // Nothing left over, so the next run starts its own import folder.
      unfinished = failed > 0;
    } catch (err) {
      /* An abort is not a failure: the firmware is stateless per read window,
         so the next run resumes from the size already on disk — into this
         same import folder, which is what `pendingStamp` preserves. */
      if (err?.name === "AbortError") {
        log.log("download aborted — re-run to resume from where it stopped.");
        progLabel.textContent = "Aborted (resumable)";
      } else {
        log.error(`Download failed: ${err?.message ?? err}`);
        progLabel.textContent = `Failed: ${err?.message ?? err}`;
      }
    } finally {
      pendingStamp = unfinished ? importStamp : null;
      abortCtl = null;
      setBusy(false);
      refreshDestPreview();
      syncControls();
    }

    // The card has changed under us if anything was deleted, and the file
    // sizes on it are what the next run resumes against.
    await refresh();
  }

  function abort() {
    if (!abortCtl) return;
    log.warn("aborting the SD transfer…");
    try {
      abortCtl.abort();
    } catch {
      /* already settled */
    }
  }

  // -------------------------------------------------------------------------
  // Link speed
  // -------------------------------------------------------------------------

  /**
   * Measure the raw link with the firmware's data-rate test.
   *
   * This measures the pipe — BLE connection interval and MTU, or RFCOMM
   * buffering — not the file-transfer protocol, so it is the honest upper
   * bound to quote before a long download, and a direct A/B between BLE and
   * classic Bluetooth on the same host.
   */
  async function measureLinkSpeed(durationMs = LINK_TEST_MS) {
    const client = getClient();
    if (typeof client?.runDataRateTest !== "function") {
      log.warn("This SDK build has no data-rate test.");
      return;
    }
    if (busy) {
      log.warn("A card operation is already running.");
      return;
    }
    setBusy(true);
    log.log(
      `measuring raw link speed (${(durationMs / 1000).toFixed(0)} s, firmware data-rate test)…`,
    );
    try {
      const res = await client.runDataRateTest(durationMs, (bytes, ms) => {
        setStat("link", `${(bytes / 1024 / (ms / 1000)).toFixed(1)} KB/s`);
      });
      setStat("link", `${res.kBps.toFixed(1)} KB/s`);
      log.log(
        `raw link speed: ${res.kBps.toFixed(1)} KB/s ` +
          `(${fmtBytes(res.bytesReceived)} in ${(res.durationMs / 1000).toFixed(1)}s).`,
      );
      if (res.kBps > 0) {
        log.log(
          "as a guide (file transfer adds ~2% framing overhead): " +
            `1 MB ≈ ${fmtEta(1024 / res.kBps)}, ` +
            `5 MB ≈ ${fmtEta((5 * 1024) / res.kBps)}, ` +
            `20 MB ≈ ${fmtEta((20 * 1024) / res.kBps)}.`,
        );
        if (tree && tree.totalBytes > 0) {
          log.log(
            `everything currently on this card (${fmtBytes(tree.totalBytes)}) ≈ ` +
              `${fmtEta(tree.totalBytes / 1024 / res.kBps)}.`,
          );
        }
      }
    } catch (err) {
      log.error(`Link speed test failed: ${err?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  btnRefresh.addEventListener("click", () => {
    refresh().catch((err) => log.error(`refresh failed: ${err?.message}`));
  });
  btnLinkTest.addEventListener("click", () => {
    measureLinkSpeed().catch(() => {});
  });
  /* NOT deferred behind anything: showDirectoryPicker is gesture-gated, so it
     has to be reached straight off the click. */
  btnPickDest.addEventListener("click", () => {
    pickDestination().catch(() => {});
  });
  btnDownloadSel.addEventListener("click", () => {
    download(selectedPaths()).catch(() => {});
  });
  btnDownloadAll.addEventListener("click", () => {
    download([rootPath]).catch(() => {});
  });
  btnAbort.addEventListener("click", abort);

  if (!("showDirectoryPicker" in window)) {
    pathHint.className = "banner warn";
    pathHint.textContent =
      "This browser has no File System Access API, so a destination folder " +
      "cannot be chosen — downloading needs a Chromium-based desktop browser.";
  } else if (
    /Windows/i.test(navigator.userAgentData?.platform || navigator.userAgent)
  ) {
    pathHint.textContent = CONSENSYS_BACKUP_HINT;
  }

  setLayout(layout);
  syncControls();

  /* Restore the folder chosen on a previous visit. Write access is
     re-confirmed on the first download click rather than now, because the
     browser only grants a permission from inside a user gesture. */
  void (async () => {
    const saved = await recallDest();
    if (destroyed || !saved) return;
    destRoot = saved;
    setDestLabel(true);
    log.log(`destination folder restored: ${saved.name}`);
    syncControls();
  })();

  return {
    refresh,
    renderTree,
    selectedPaths,
    setLayout,
    pickDestination,
    download,
    abort,
    measureLinkSpeed,
    setEnabled(next) {
      const was = enabled;
      enabled = !!next;
      /* On the falling edge only. A link that can no longer transfer has no
         card to show, and dropping the listing keeps a stale tree from being
         downloaded against the next sensor to connect — but this runs on
         every re-gate, so it must not fire while already disabled or it
         would wipe the panel continuously.
         NOTE for the host page: do NOT fold this panel's own transfer-busy
         state back into what you pass here, or the first progress event
         clears the very progress it is reporting. The panel already refuses
         a second operation itself. */
      if (was && !enabled) clearCard();
      syncControls();
    },
    destroy() {
      destroyed = true;
      abort();
      host.replaceChildren();
    },
  };
}
