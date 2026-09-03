/**
 * common/dev/verify.mjs — the full verification pass for ShimmerCapture,
 * driven over CDP against the ?mock=1 transport. Zero dependencies (Node 24's
 * built-in WebSocket), and it writes nothing to disk: the report is stdout,
 * and the "filesystem" the SD checks download into lives inside the page.
 *
 * It lives in the repo rather than beside it because a good half of what it
 * asserts is repo policy — which files may import the extension's private SDK
 * copy, and which busy flag every panel's refusal text has to be able to
 * name — and policy has to be able to change in the same commit as the code
 * it polices.
 *
 * To run it, from the repo root:
 *
 *   npx http-server . -p 8129 -c-1          # serves the REPO ROOT, not the demo
 *   chrome --headless=new --remote-debugging-port=9333 \
 *          --user-data-dir=<a scratch dir> --no-first-run --disable-gpu about:blank
 *   node common/dev/verify.mjs [port]       # port defaults to 9333
 *
 * Set VERIFY_BASE if the server is somewhere else; it must end in the demo's
 * folder, because the cross-demo checks walk up from it to the repo root.
 *
 * If a check ever does need a screenshot or a dump to look at afterwards, it
 * goes in os.tmpdir() — never in the working tree, which this pass has to be
 * able to run against without dirtying.
 */
const PORT = process.argv[2] ?? "9333";
const BASE = process.env.VERIFY_BASE ?? "http://localhost:8129/ShimmerCapture/";

const targets = await (
  await fetch(`http://127.0.0.1:${PORT}/json/list`)
).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    consoleErrors.push(m.params.entry.text + " " + (m.params.entry.url ?? ""));
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(
      "EXCEPTION " +
        (m.params.exceptionDetails.exception?.description ??
          m.params.exceptionDetails.text),
    );
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      "page threw: " +
        (r.exceptionDetails.exception?.description ??
          JSON.stringify(r.exceptionDetails)),
    );
  }
  return r.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`,
  );
};

async function goto(url) {
  await send("Page.navigate", { url });
  // Poll for the page's own module script having run rather than sleeping a
  // fixed time: the module graph grew when the SD panel joined it, and a
  // fixed 1.4 s stopped being enough. The probe used to be "does #sdPanel
  // have children", which aged every time a panel was added ahead of it; the
  // page now sets data-booted as the very last statement of startup for this,
  // so the probe means "everything is up" no matter what joins the graph next.
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    const r = await send("Runtime.evaluate", {
      expression: "document.documentElement.dataset.booted === 'true'",
      returnByValue: true,
    });
    if (r.result.value) return;
  }
  throw new Error(`page did not finish booting: ${url}`);
}

const CONNECT = `
  delete window.showSaveFilePicker;
  window.__blobs = [];
  const realCOU = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__blobs.push(b); return realCOU(b); };
  window.confirm = (t) => { window.__confirm = t; return true; };
  document.getElementById('btnMock').click();
  for (let i = 0; i < 80 && !document.getElementById('rateHelper'); i++)
    await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 400));
  return document.getElementById('connPill').textContent;
`;

/* The Test tab's two panels, reached the way the page itself labels them:
   by data-role rather than by id, because both are shared modules that render
   into a host element and nothing outside them should depend on their
   internal ids. `opCount` counts what actually went out on the wire. */
const TEST = `
  const P = () => document.getElementById('selfTestPanel');
  const role = (r) => P().querySelector('[data-test-role="' + r + '"]');
  const D = () => document.getElementById('driftPanel');
  const drole = (r) => D().querySelector('[data-drift-role="' + r + '"]');
  const dstat = (r) => D().querySelector('[data-drift-stat="' + r + '"]')?.textContent;
  const opCount = (op) => (window.mockTransport?.writes ?? []).filter(w => (w.bytes ?? w.data)[0] === op).length;
`;

// ===========================================================================
console.log("\n--- framed (BLE-like) ---");
await goto(`${BASE}?mock=1`);
/* One localStorage key survives between runs and changes what the page looks
   like: whether the log drawer is open. A previous run (or a hand probe) that
   left it open makes the plot-width check below measure the wrong thing, so
   the pass starts from the state a first visit is in. */
await evaluate(
  `try { localStorage.removeItem('shimmerCaptureLogDrawer'); } catch {} return 1;`,
);
await goto(`${BASE}?mock=1`);
check(
  "mock button offered under ?mock=1",
  await evaluate(`return !document.getElementById('btnMock').hidden`),
);

// --- 1. connect button order: the two Bluetooth links sit together ---------
const linkOrder = await evaluate(`
  const row = document.getElementById('btnBle').parentElement;
  const kids = [...row.children];
  return {
    ids: kids.filter(n => n.tagName === 'BUTTON').map(n => n.id),
    sepAfterBt: kids[kids.indexOf(document.getElementById('btnBt')) + 1]
      ?.className,
  };
`);
check(
  "connect buttons read BLE, classic Bluetooth, then the wired link",
  linkOrder.ids.slice(0, 3).join(",") === "btnBle,btnBt,btnUsb" &&
    linkOrder.ids[3] === "btnMock" &&
    linkOrder.sepAfterBt === "link-sep",
  linkOrder.ids.join(" → "),
);

// --- 4. the link-speed button's new home, before anything is connected ----
const linkIdle = await evaluate(`
  const sdk = await import('/vendor/shimmer-web-sdk.esm.js');
  const btn = document.getElementById('btnLinkTest');
  const wired = new sdk.WiredShimmerClient({ transport: new sdk.LoopbackTransport() });
  const radio = new sdk.Shimmer3RClient({ debug: false });
  return {
    inLinkCard: btn.closest('.card') === document.getElementById('btnBle').closest('.card'),
    notInSdPanel: !document.getElementById('sdPanel').contains(btn) &&
      document.querySelector('#sdPanel [data-sd-role="linkTest"]') === null,
    disabled: btn.disabled,
    note: document.getElementById('linkTestNote').textContent,
    pill: document.getElementById('linkSpeedPill').textContent,
    cap: btn.dataset.cap, requires: btn.dataset.requires,
    // Why the button is Bluetooth-only: the dock command set has no
    // data-rate test, so the wired client does not carry the method.
    dockHasTest: typeof wired.runDataRateTest === 'function',
    radioHasTest: typeof radio.runDataRateTest === 'function',
  };
`);
check(
  "the link-speed button moved out of the SD panel and into the Sensor link card",
  linkIdle.inLinkCard &&
    linkIdle.notInSdPanel &&
    linkIdle.cap === "linkTest" &&
    linkIdle.requires === "idle" &&
    linkIdle.pill === "not measured",
  `data-requires=${linkIdle.requires} data-cap=${linkIdle.cap}`,
);
check(
  "disconnected it is refused with a reason, and the dock link genuinely cannot run it",
  linkIdle.disabled &&
    /Connect over BLE or classic Bluetooth/.test(linkIdle.note) &&
    linkIdle.dockHasTest === false &&
    linkIdle.radioHasTest === true,
  linkIdle.note,
);

// --- 2a. the TX/RX filter and the tap that feeds it -----------------------
// The filter selects what is SHOWN; the tap decides what is PRODUCED. Every
// combination that yields an empty log has to say which control to reach for.
const tapNote = await evaluate(`
  const sev = document.getElementById('logSeverity');
  const chk = document.getElementById('chkRawBytes');
  const data = document.getElementById('chkRawData');
  const note = () => document.getElementById('tapNote').textContent;
  const set = (el, v) => { el.value !== undefined && el.type !== 'checkbox'
    ? (el.value = v) : (el.checked = v); el.dispatchEvent(new Event('change')); };
  const out = {};
  out.quietAtRest = note();
  out.dataDisabledAtRest = data.disabled;
  set(sev, 'txrx');
  out.filterNoProducer = note();
  set(chk, true);
  out.dataEnabled = !data.disabled;
  out.producerNoDevice = note();
  set(sev, 'err');
  out.producerHiddenByFilter = note();
  set(sev, 'all');
  out.quietWhenAgreed = note();
  set(chk, false);
  set(sev, 'all');
  out.restored = note() === '' && !chk.checked && !data.checked && data.disabled;
  return out;
`);
check(
  "the TX/RX filter explains itself when the tap that feeds it is off",
  tapNote.quietAtRest === "" &&
    tapNote.dataDisabledAtRest &&
    /Raw TX\/RX logging is off/.test(tapNote.filterNoProducer) &&
    /Log raw TX\/RX bytes/.test(tapNote.filterNoProducer),
  tapNote.filterNoProducer,
);
check(
  "and says the other three things that can leave that filter empty",
  tapNote.dataEnabled &&
    /Nothing is connected yet/.test(tapNote.producerNoDevice) &&
    /this filter hides them/.test(tapNote.producerHiddenByFilter) &&
    tapNote.quietWhenAgreed === "" &&
    tapNote.restored,
  `${tapNote.producerNoDevice} || ${tapNote.producerHiddenByFilter}`,
);

// --- 2b. the BLE transport the page now builds itself ----------------------
// Field for field against the one Shimmer3RClient builds when it is left to
// its own devices — that is the whole risk of taking the job off it.
const bleT = await evaluate(`
  const sdk = await import('/vendor/shimmer-web-sdk.esm.js');
  const { createTransportTap } = await import('/common/transport-tap.js');
  const client = new sdk.Shimmer3RClient({ debug: false });
  const reference = client._makeWebTransport();
  const mine = window.makeBleTransport();
  const tapped = createTransportTap(mine, { log: () => {} });
  const keys = Object.keys(reference).filter(k => k.startsWith('_'));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return {
    keys,
    differing: keys.filter(k => !same(reference[k], mine[k])),
    service: mine._serviceUUID,
    writeChar: mine._writeCharUUID,
    notifyChar: mine._notifyCharUUID,
    withResponse: mine._defaultWriteWithResponse,
    fromSdkDefaults:
      mine._serviceUUID === sdk.SHIMMER3R_DEFAULTS.SERVICE_UUID &&
      mine._writeCharUUID === sdk.SHIMMER3R_DEFAULTS.CHAR_RX_UUID &&
      mine._notifyCharUUID === sdk.SHIMMER3R_DEFAULTS.CHAR_TX_UUID,
    // The client does \`if (t instanceof WebBluetoothTransport) this.device =
    // t.device\`, so a wrapper that broke instanceof would quietly cost the
    // client its device handle.
    tapKeepsInstanceof: tapped instanceof sdk.WebBluetoothTransport,
    tapForwardsGetters:
      tapped.kind === mine.kind &&
      tapped._serviceUUID === mine._serviceUUID &&
      tapped.capabilities.framed === mine.capabilities.framed &&
      tapped.device === null,
    tapOverridesTwo:
      tapped.write !== mine.write && tapped.onNotify !== mine.onNotify &&
      typeof tapped.tap.setEnabled === 'function',
  };
`);
check(
  "the page's own BLE transport matches the one the client would have built",
  bleT.differing.length === 0 &&
    bleT.keys.length >= 6 &&
    bleT.fromSdkDefaults &&
    bleT.withResponse === true,
  `${bleT.keys.length} fields compared, write-with-response=${bleT.withResponse}`,
);
check(
  "the tap is transparent: instanceof, getters and capabilities all survive it",
  bleT.tapKeepsInstanceof && bleT.tapForwardsGetters && bleT.tapOverridesTwo,
  `instanceof=${bleT.tapKeepsInstanceof} getters=${bleT.tapForwardsGetters}`,
);

check("connect pill after mock connect", (await evaluate(CONNECT)) === "mock");

const ident = await evaluate(`
  const t = id => document.getElementById(id).textContent;
  return { name:t('idName'), mac:t('idMac'), hw:t('idHw'), fw:t('idFw'),
    batt:t('idBatt'), link:t('idLink'), imPill:t('imPill'),
    rate:document.getElementById('ratePill').textContent,
    fields:document.querySelectorAll('#configForm .field').length,
    sensorBoxes:document.querySelectorAll('[data-sensor-bit]').length,
    checked:[...document.querySelectorAll('[data-sensor-bit]')].filter(b=>b.checked).length,
    hexRows:document.querySelectorAll('.hexview-row').length,
    flags:document.querySelectorAll('#statusFlags .flag').length };
`);
check(
  "identity line populated",
  ident.name.includes("Shimmer3R") &&
    ident.mac === "000666668091" &&
    ident.hw.includes("id 10") &&
    ident.fw.includes("LogAndStream"),
  JSON.stringify(ident),
);
check(
  "form + sensor grid + hex view built",
  ident.fields === 40 &&
    ident.sensorBoxes === 17 &&
    ident.checked === 3 &&
    ident.hexRows === 24,
);

// ---- field edit lands on the byte the tooltip names
const edit = await evaluate(`
  const tip = k => (document.querySelector('#configForm .field[data-field-key="'+k+'"] select, #configForm .field[data-field-key="'+k+'"] input')||{}).title;
  const wrap = document.querySelector('#configForm .field[data-field-key="wrAccelRange"]');
  const ctl = wrap.querySelector('select');
  const tooltip = ctl.title;
  const composites = { gyro: tip('gyroRange.lsm6dsv'), press: tip('pressureOversampling.bmp390_581') };
  ctl.value = [...ctl.options].map(o=>o.value).find(v => v !== ctl.value);
  ctl.dispatchEvent(new Event('change', {bubbles:true}));
  await new Promise(r=>setTimeout(r,80));
  return { tooltip, composites, dirty: wrap.classList.contains('dirty'),
    pill: document.getElementById('dirtyPill').textContent,
    changed: [...document.querySelectorAll('.hexview-byte.changed')].map(c=>c.title) };
`);
check(
  "edit marks dirty and changes the byte the in-byte-mask tooltip names",
  edit.dirty &&
    edit.changed.length === 1 &&
    edit.changed[0] === "byte 6 (0x6)" &&
    // in-byte mask: bits 2-3 is 0x0C, not the unshifted 0x03
    edit.tooltip === "byte 6, bits 2-3 (mask 0x0C)" &&
    // each half of a composite is shifted by its OWN shift
    edit.composites.gyro ===
      "byte 8, bits 0-1 (mask 0x03) + byte 130, bit 2 (mask 0x04)" &&
    edit.composites.press ===
      "byte 9, bits 4-5 (mask 0x30) + byte 130, bit 0 (mask 0x01)",
  `${edit.tooltip} -> ${edit.changed.join()} / ${edit.pill} | gyro: ${edit.composites.gyro} | pressure: ${edit.composites.press}`,
);

// ---- rate helper
const rate = await evaluate(`
  const h = document.getElementById('rateHelper');
  h.value = '204.8'; h.dispatchEvent(new Event('change', {bubbles:true}));
  await new Promise(r=>setTimeout(r,80));
  return { pill: document.getElementById('ratePill').textContent,
    divider: document.querySelector('#configForm .field[data-field-key="samplingRate"] input').value,
    changed: [...document.querySelectorAll('.hexview-byte.changed')].map(c=>c.title) };
`);
check(
  "common-rate helper writes the divider",
  rate.pill === "204.8 Hz" &&
    rate.divider === "160" &&
    rate.changed.includes("byte 0 (0x0)"),
  JSON.stringify(rate),
);

// ---- sensor toggle
const sens = await evaluate(`
  const b = [...document.querySelectorAll('[data-sensor-bit]')].find(x => x.closest('label').textContent.includes('Pressure'));
  b.checked = true; b.dispatchEvent(new Event('change', {bubbles:true}));
  await new Promise(r=>setTimeout(r,80));
  return { pill: document.getElementById('dirtyPill').textContent,
    changed: [...document.querySelectorAll('.hexview-byte.changed')].map(c=>c.title) };
`);
check(
  "sensor toggle counts as a change and moves sensors2",
  sens.pill === "3 changes" && sens.changed.includes("byte 5 (0x5)"),
  JSON.stringify(sens),
);

// ---- apply: order, confirm text, re-read
const apply = await evaluate(`
  window.mockTransport.writes.length = 0;
  const t0 = performance.now();
  document.getElementById('btnApply').click();
  for (let i = 0; i < 300; i++) {
    await new Promise(r=>setTimeout(r,100));
    if (document.getElementById('dirtyPill').hidden) break;
  }
  const ops = window.mockTransport.writes.map(w => w.bytes[0]);
  const seq = [];
  for (const o of ops) {
    const k = '0x' + o.toString(16).padStart(2,'0');
    if (!seq.length || seq[seq.length-1].op !== k) seq.push({op:k, n:1});
    else seq[seq.length-1].n++;
  }
  return { elapsedMs: Math.round(performance.now()-t0), seq, confirm: window.__confirm,
    dirtyHidden: document.getElementById('dirtyPill').hidden,
    changedAfter: document.querySelectorAll('.hexview-byte.changed').length,
    row0: [...document.querySelectorAll('.hexview-row')][0].textContent };
`);
const opString = apply.seq
  .map((s) => s.op + (s.n > 1 ? "x" + s.n : ""))
  .join(" ");
check(
  "apply runs the firmware's order",
  opString === "0x8cx6 0x9c 0x08 0x01 0x05 0x09 0x01 0x8ex3",
  opString,
);
check(
  "apply confirm lists changes and the 7 steps",
  /Sampling Rate: 640 . 160/.test(apply.confirm) &&
    /WR Accel Range/.test(apply.confirm) &&
    /Enabled sensors: 0x0000E0 . 0x0400E0/.test(apply.confirm) &&
    /7\. Re-read the configuration image/.test(apply.confirm),
  apply.confirm.split("\n").filter(Boolean).length + " lines",
);
check(
  "apply re-reads and re-baselines",
  apply.dirtyHidden &&
    apply.changedAfter === 0 &&
    apply.row0.startsWith("0000A00001E00004"),
  apply.row0,
);

// ===========================================================================
// SD card tab
//
// showDirectoryPicker cannot be driven headlessly (and cannot be driven at
// all without a user gesture), so the destination handle is STUBBED: MEMFS
// below is an in-memory FileSystemDirectoryHandle good enough for the SDK's
// ensureDirectoryPath / getFileHandle / createWritable / getFile calls. The
// bytes it collects are then compared against what the mock served, so the
// transfer itself is verified end to end even though the picker is not.
// ===========================================================================
console.log("\n--- SD card tab ---");

const MEMFS = `
window.__mkfs = (label) => {
  const files = new Map();
  const fileHandle = (path) => ({
    kind: 'file', name: path.slice(path.lastIndexOf('/') + 1),
    async getFile() {
      const b = files.get(path) ?? new Uint8Array(0);
      return { size: b.length, arrayBuffer: async () => b.slice().buffer };
    },
    async createWritable(o) {
      let buf = o && o.keepExistingData
        ? new Uint8Array(files.get(path) ?? [])
        : new Uint8Array(0);
      return {
        async write(c) {
          const d = new Uint8Array(c.data);
          const p = c.position ?? 0;
          if (p + d.length > buf.length) {
            const n = new Uint8Array(p + d.length); n.set(buf); buf = n;
          }
          buf.set(d, p);
        },
        async close() { files.set(path, buf); },
      };
    },
  });
  const dirHandle = (prefix) => ({
    kind: 'directory',
    name: prefix ? prefix.slice(prefix.lastIndexOf('/') + 1) : label,
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getDirectoryHandle(seg) {
      return dirHandle(prefix ? prefix + '/' + seg : seg);
    },
    async getFileHandle(seg, o) {
      const p = prefix ? prefix + '/' + seg : seg;
      if (!files.has(p)) {
        if (!o || !o.create) throw new DOMException('missing', 'NotFoundError');
        files.set(p, new Uint8Array(0));
      }
      return fileHandle(p);
    },
  });
  return { root: dirHandle(''), files };
};
window.__useFs = async (label) => {
  window.__fs = window.__mkfs(label);
  window.showDirectoryPicker = async () => window.__fs.root;
  return window.sdBrowser.pickDestination();
};
window.__sdRole = (r) => document.querySelector('[data-sd-role="' + r + '"]');
window.__sdStats = () => {
  const out = {};
  for (const s of document.querySelectorAll('#sdPanel [data-sd-stat]'))
    out[s.dataset.sdStat] = s.textContent;
  return out;
};
window.__opCount = (op) =>
  window.mockTransport.writes.filter((w) => w.bytes[0] === op).length;
`;

// ---- the capability key the whole tab hangs off
const sdCaps = await evaluate(`
  const m = await import('/common/shimmer3-config-schema.js');
  const full = { sdListDir(){}, sdReadFileWindow(){} };
  return {
    ble: m.describeShimmer3Caps(full, 'ble').sdTransfer,
    rfcomm: m.describeShimmer3Caps(full, 'rfcomm').sdTransfer,
    usb: m.describeShimmer3Caps(full, 'usb').sdTransfer,
    noMethods: m.describeShimmer3Caps({}, 'ble').sdTransfer,
  };
`);
check(
  "sdTransfer capability is radio-only, so the USB dock link can never offer the tab",
  sdCaps.ble === true &&
    sdCaps.rfcomm === true &&
    sdCaps.usb === false &&
    sdCaps.noMethods === false,
  JSON.stringify(sdCaps),
);

// ---- the tree, the readouts, and that listing actually paged
const sdTree = await evaluate(
  MEMFS +
    `
  window.mockTransport.writes.length = 0;
  document.querySelector('.tabs [data-tab="tabSd"]').click();
  await window.sdBrowser.refresh();
  const rows = [...document.querySelectorAll('[data-sd-role="tree"] > ul > li')].map(li => ({
    path: li.querySelector('label').textContent.trim(),
    meta: li.querySelector(':scope > .sd-size').textContent,
    files: [...li.querySelectorAll('ul > li')].map(f => f.textContent),
  }));
  return { rows, stats: window.__sdStats(),
    listCmds: window.__opCount(0xCC), freeCmds: window.__opCount(0xC8),
    tabDisabled: document.getElementById('tabBtnSd').disabled,
    banner: document.getElementById('sdBanner').textContent,
    card: window.mockTransport.sdCard.files };
`,
);
check(
  "the synthetic card renders as a two-session tree with per-file sizes",
  sdTree.rows.length === 2 &&
    sdTree.rows[0].path === "data/DefaultTrial_5f2c1a90/Shimmer_8091-000" &&
    sdTree.rows[0].meta === "2 file(s), 327.2 KB" &&
    sdTree.rows[0].files.length === 2 &&
    sdTree.rows[0].files[0] === "000286.2 KB" &&
    sdTree.rows[1].files.length === 3,
  sdTree.rows.map((r) => `${r.path} [${r.meta}]`).join(" | "),
);
check(
  "card readouts show free space, capacity, file count and total bytes",
  sdTree.stats.files === "5" &&
    sdTree.stats.bytes === "351.4 KB" &&
    /GB$/.test(sdTree.stats.free) &&
    sdTree.stats.capacity === "29.72 GB" &&
    sdTree.freeCmds === 1,
  JSON.stringify(sdTree.stats),
);
check(
  "listing four directories took five SD_LIST_DIR pages, so paging was followed",
  sdTree.listCmds === 5 && sdTree.tabDisabled === false && sdTree.banner === "",
  `${sdTree.listCmds} list commands`,
);

// ---- download, byte-for-byte against what the mock served
const sdDownload = await evaluate(`
  window.mockTransport.writes.length = 0;
  const picked = await window.__useFs('MemDest');
  const dest = window.__sdRole('dest').textContent;
  const preview = window.__sdRole('preview').textContent;
  const session = 'data/DefaultTrial_5f2c1a90/Shimmer_8091-001';
  await window.sdBrowser.download([session], { deleteVerified: false });
  const cmp = [...window.__fs.files.keys()].map(hostPath => {
    const cardPath = hostPath.slice(hostPath.indexOf('/data/') + 1);
    const want = window.mockTransport.sdCard.bytes(cardPath);
    const got = window.__fs.files.get(hostPath);
    let mismatchAt = -1;
    if (!want) mismatchAt = -3;
    else if (want.length !== got.length) mismatchAt = -2;
    else for (let i = 0; i < want.length; i++)
      if (want[i] !== got[i]) { mismatchAt = i; break; }
    return { hostPath, cardPath, bytes: got.length, mismatchAt };
  });
  return { picked, dest, preview, cmp,
    progress: window.__sdRole('progress').textContent,
    readCmds: window.__opCount(0xC4),
    cardIntact: window.mockTransport.sdCard.files.length };
`);
const stampRe = /^\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}$/;
check(
  "a picked destination is reported with the path the layout will produce",
  sdDownload.picked === true &&
    sdDownload.dest === "Saving into: MemDest" &&
    /^Files will be written to MemDest\/\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}\/<ShimmerName>\/data\/…$/.test(
      sdDownload.preview,
    ),
  `${sdDownload.dest} — ${sdDownload.preview}`,
);
check(
  "downloading a session writes every file byte-for-byte, in the Consensys Backup layout",
  sdDownload.cmp.length === 3 &&
    sdDownload.cmp.every((f) => f.mismatchAt === -1) &&
    sdDownload.cmp.every(
      (f) =>
        stampRe.test(f.hostPath.split("/")[0]) &&
        f.hostPath.split("/")[1] === "Shimmer_8091",
    ) &&
    sdDownload.cmp.map((f) => f.bytes).join() === "17622,6145,931" &&
    sdDownload.progress === "Done" &&
    sdDownload.cardIntact === 5,
  sdDownload.cmp
    .map((f) => `${f.hostPath} ${f.bytes}B ok=${f.mismatchAt === -1}`)
    .join(" | "),
);

// ---- rolling rate and ETA, over a file that spans three read windows
const sdRate = await evaluate(`
  await window.__useFs('RateDest');
  const label = window.__sdRole('progress');
  const seen = [];
  const run = window.sdBrowser.download(
    ['data/DefaultTrial_5f2c1a90/Shimmer_8091-000'], { deleteVerified: false });
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 100));
    const t = label.textContent;
    if (t && seen[seen.length - 1] !== t) seen.push(t);
    if (t === 'Done' || /^Failed|^Aborted/.test(t)) break;
  }
  await run;
  const withRate = seen.filter(t => /@ [\\d.]+ KB\\/s, ETA /.test(t));
  const rates = withRate.map(t => Number(/@ ([\\d.]+) KB/.exec(t)[1]));
  const etas = withRate.map(t => /ETA (.+)$/.exec(t)[1]);
  return { seen, withRate, rates, etas, final: label.textContent,
    big: window.__fs.files.get([...window.__fs.files.keys()].find(k => k.endsWith('-000/000'))).length };
`);
check(
  "progress reports a rolling throughput and an ETA while a multi-window file transfers",
  sdRate.withRate.length >= 2 &&
    sdRate.rates.every((r) => r > 20 && r < 1000) &&
    sdRate.etas.every((e) => /^\d+m \d{2}s$|^\d+s$/.test(e)) &&
    sdRate.final === "Done" &&
    sdRate.big === 293117,
  `${sdRate.withRate.length} labels with a rate: ${sdRate.rates.join("/")} KB/s, ETA ${sdRate.etas.join("/")}`,
);

// ---- apply and streaming both refused while a transfer holds the link
const sdContend = await evaluate(`
  await window.__useFs('ContendDest');
  const run = window.sdBrowser.download(['data'], { deleteVerified: false });
  // The SDK emits nothing between "enumerate" and the first completed read
  // window, so wait for the download phase rather than guessing a delay.
  const label = window.__sdRole('progress');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (/^download: /.test(label.textContent)) break;
  }
  const during = {
    apply: document.getElementById('btnApply').disabled,
    read: document.getElementById('btnRead').disabled,
    imWrite: document.getElementById('btnImWrite').disabled,
    streamStart: document.getElementById('btnStreamStart').disabled,
    note: document.getElementById('applyNote').textContent,
    refresh: window.__sdRole('refresh').disabled,
    dlAll: window.__sdRole('downloadAll').disabled,
    abort: window.__sdRole('abort').disabled,
    progress: window.__sdRole('progress').textContent,
    file: window.__sdRole('file').textContent,
    treeRows: document.querySelectorAll('[data-sd-role="tree"] > ul > li').length,
  };
  window.sdBrowser.abort();
  await run;
  await new Promise(r => setTimeout(r, 400));
  const partial = [...window.__fs.files.entries()].map(([k, v]) => [k.slice(k.indexOf('/data/') + 1), v.length]);
  return { during, partial,
    final: window.__sdRole('progress').textContent,
    sawAbortCmd: window.mockTransport.writes.some(w => w.bytes[0] === 0xC7),
    cardIntact: window.mockTransport.sdCard.files.length,
    after: { apply: document.getElementById('btnApply').disabled,
      note: document.getElementById('applyNote').textContent,
      refresh: window.__sdRole('refresh').disabled } };
`);
check(
  "a transfer in flight refuses apply, a configuration read and a stream start, with a reason",
  sdContend.during.apply &&
    sdContend.during.read &&
    sdContend.during.imWrite &&
    sdContend.during.streamStart &&
    /a download and a configuration write cannot share the link/.test(
      sdContend.during.note,
    ),
  sdContend.during.note,
);
check(
  "the panel keeps its tree and its progress while transferring, and only Abort stays live",
  sdContend.during.refresh &&
    sdContend.during.dlAll &&
    !sdContend.during.abort &&
    sdContend.during.treeRows === 2 &&
    /^download: /.test(sdContend.during.progress) &&
    /Shimmer_8091-000\/000 \(/.test(sdContend.during.file),
  `${sdContend.during.progress} — ${sdContend.during.file}`,
);
check(
  "abort stops the transfer mid-file, leaves the part already written, and touches nothing on the card",
  sdContend.final === "Aborted (resumable)" &&
    sdContend.sawAbortCmd &&
    sdContend.cardIntact === 5 &&
    sdContend.partial.length === 1 &&
    sdContend.partial[0][1] > 0 &&
    sdContend.partial[0][1] < 293117,
  `${sdContend.final}; on disk ${sdContend.partial.map((p) => p.join("=")).join()} of 293117`,
);
check(
  "the page is handed back once the transfer stops",
  !sdContend.after.apply &&
    sdContend.after.note === "" &&
    !sdContend.after.refresh,
);

// ---- an aborted download resumes into the same import folder
const sdResume = await evaluate(`
  const partialKey = [...window.__fs.files.keys()].find(k => k.endsWith('-000/000'));
  const before = window.__fs.files.get(partialKey).length;
  const preview = window.__sdRole('preview').textContent;
  window.mockTransport.writes.length = 0;
  await window.sdBrowser.download(
    ['data/DefaultTrial_5f2c1a90/Shimmer_8091-000'], { deleteVerified: false });
  const keys = [...window.__fs.files.keys()].filter(k => k.endsWith('-000/000'));
  const got = window.__fs.files.get(partialKey);
  const want = window.mockTransport.sdCard.bytes('data/DefaultTrial_5f2c1a90/Shimmer_8091-000/000');
  let mismatchAt = -1;
  if (!want) mismatchAt = -3;
  else if (want.length !== got.length) mismatchAt = -2;
  else for (let i = 0; i < want.length; i++)
    if (want[i] !== got[i]) { mismatchAt = i; break; }
  const first = window.mockTransport.writes.find(w => w.bytes[0] === 0xC4);
  return { before, copies: keys.length, size: got.length, mismatchAt,
    stampReused: preview.includes(partialKey.split('/')[0]),
    previewAfter: window.__sdRole('preview').textContent,
    firstOffset: first ? new DataView(new Uint8Array(first.bytes).buffer).getUint32(1, true) : null };
`);
check(
  "re-running after an abort resumes into the same import folder, from the bytes on disk",
  sdResume.before > 0 &&
    sdResume.stampReused &&
    sdResume.copies === 1 &&
    sdResume.firstOffset === sdResume.before &&
    sdResume.size === 293117 &&
    sdResume.mismatchAt === -1,
  `resumed at offset ${sdResume.firstOffset} (${sdResume.before} B on disk) → ${sdResume.size} B` +
    `, mismatchAt ${sdResume.mismatchAt}, ${sdResume.copies} copy on disk`,
);

// ---- delete only what was downloaded AND verified
const sdDelete = await evaluate(`
  await window.__useFs('DelDest');
  window.mockTransport.writes.length = 0;
  const before = window.mockTransport.sdCard.files.map(f => f.path);
  await window.sdBrowser.download(
    ['data/DefaultTrial_5f2c1a90/Shimmer_8091-001'], { deleteVerified: true });
  return { before, after: window.mockTransport.sdCard.files.map(f => f.path),
    dirs: window.mockTransport.sdCard.dirs,
    deleteCmds: window.__opCount(0xCA),
    confirm: window.__confirm,
    stats: window.__sdStats(),
    logs: [...document.querySelectorAll('#log .log-line')].map(l => l.textContent)
      .filter(l => /deleted from card/.test(l)) };
`);
check(
  "delete-after-verified names the scope before deleting",
  /3 file\(s\), 24\.1 KB/.test(sdDelete.confirm) &&
    /1 session folder\(s\)/.test(sdDelete.confirm),
  sdDelete.confirm.split("\n").filter(Boolean).slice(2, 5).join(" / "),
);
check(
  "only the three verified files leave the card; the other session is untouched",
  sdDelete.before.length === 5 &&
    sdDelete.after.length === 2 &&
    sdDelete.after.every((p) => p.includes("-000/")) &&
    sdDelete.deleteCmds === 3 &&
    sdDelete.logs.length === 3 &&
    sdDelete.stats.files === "2",
  `${sdDelete.before.length} → ${sdDelete.after.length} files, ${sdDelete.deleteCmds} SD_DELETE commands`,
);

// ---- the link-speed test
const sdLink = await evaluate(`
  await window.sdBrowser.measureLinkSpeed(1200);
  // The event log flushes on an animation frame, so the last lines are not
  // in the DOM the instant the call returns.
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)));
  return { link: window.__sdStats().link,
    on: window.mockTransport.writes.some(w => w.bytes[0] === 0xA4 && w.bytes[1] === 1),
    off: window.mockTransport.writes.some(w => w.bytes[0] === 0xA4 && w.bytes[1] === 0),
    guide: [...document.querySelectorAll('#log .log-line')].map(l => l.textContent)
      .filter(l => /raw link speed: |as a guide|currently on this card/.test(l)) };
`);
const linkKBps = Number(/^([\d.]+) KB\/s$/.exec(sdLink.link)?.[1]);
check(
  "the link-speed test runs the firmware data-rate test and reports a plausible rate",
  sdLink.on &&
    sdLink.off &&
    linkKBps > 100 &&
    linkKBps < 300 &&
    sdLink.guide.length === 3 &&
    /1 MB ≈ \d+s, 5 MB ≈ /.test(sdLink.guide[1]),
  `${sdLink.link} — ${sdLink.guide[1]?.slice(-72) ?? "no guide line"}`,
);

// ---- 4. and the button that starts it now lives with the connect buttons
const linkBtn = await evaluate(`
  const btn = document.getElementById('btnLinkTest');
  const pill = document.getElementById('linkSpeedPill');
  const linkCard = document.getElementById('btnBle').closest('.card');
  const before = { inLinkCard: btn.closest('.card') === linkCard,
    disabled: btn.disabled, note: document.getElementById('linkTestNote').textContent,
    title: btn.title };
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  const during = { pill: pill.textContent, disabled: btn.disabled,
    applyNote: document.getElementById('applyNote').textContent,
    note: document.getElementById('linkTestNote').textContent };
  for (let i = 0; i < 100 && document.getElementById('btnLinkTest').disabled; i++)
    await new Promise(r => setTimeout(r, 100));
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)));
  return { before, during, after: pill.textContent,
    stat: window.__sdStats().link,
    noteAfter: document.getElementById('linkTestNote').textContent };
`);
check(
  "the link-speed button works from the Sensor link card and reports beside itself",
  linkBtn.before.inLinkCard &&
    !linkBtn.before.disabled &&
    linkBtn.before.note === "" &&
    /measures the pipe itself/.test(linkBtn.before.title) &&
    /KB\/s/.test(linkBtn.after) &&
    linkBtn.after === linkBtn.stat &&
    linkBtn.noteAfter === "",
  `pill ${linkBtn.after}, card stat ${linkBtn.stat}`,
);
check(
  "and while it runs it names itself as the thing holding the link",
  linkBtn.during.disabled &&
    /^(measuring…|[\d.]+ KB\/s …)$/.test(linkBtn.during.pill) &&
    /link-speed test/.test(linkBtn.during.applyNote) &&
    /Measuring/.test(linkBtn.during.note),
  `${linkBtn.during.pill} | ${linkBtn.during.applyNote}`,
);

// ---- stream, stats, plot, apply refused while streaming
const stream = await evaluate(`
  document.querySelector('.tabs [data-tab="tabStream"]').click();
  document.getElementById('btnStreamStart').click();
  await new Promise(r=>setTimeout(r,4000));
  const charts = [...document.querySelectorAll('.plot-panel canvas')].map(c => {
    const ch = Chart.getChart(c);
    return { title: ch.options.plugins.title.text, traces: ch.data.datasets.map(d=>d.label),
      points: ch.data.datasets.map(d=>d.data.length) };
  });
  const cells = {};
  for (const d of document.querySelectorAll('#stats > div'))
    cells[d.querySelector('.stat-label').textContent] = d.querySelector('.stat-value').textContent;
  // 5. Plots keep the whole page width with the log drawer collapsed — the
  // reason the log is a bottom drawer and not a right-hand rail. Scrolled to
  // the very foot of the page, the last one still clears the drawer, which is
  // what "never permanently covers content" means.
  const plotBox = document.querySelector('.plot-panel').getBoundingClientRect();
  const pageBox = document.querySelector('.page').getBoundingClientRect();
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise(r => requestAnimationFrame(r));
  const panels = document.querySelectorAll('.plot-panel');
  return { charts, cells,
    drawerOpen: document.documentElement.dataset.logOpen,
    plotWidth: plotBox.width, pageWidth: pageBox.width,
    scrolledTo: window.scrollY,
    plotBottomClear: panels[panels.length - 1].getBoundingClientRect().bottom <=
      document.getElementById('logDrawer').getBoundingClientRect().top + 1,
    applyDisabled: document.getElementById('btnApply').disabled,
    applyNote: document.getElementById('applyNote').textContent,
    btStop: !document.getElementById('btnStreamStop').disabled,
    sdStop: !document.getElementById('btnSdStop').disabled,
    recStart: !document.getElementById('btnRecStart').disabled };
`);
check(
  "plots keep the full page width with the drawer collapsed, and clear of it",
  stream.drawerOpen === "false" &&
    stream.plotWidth > stream.pageWidth - 26 &&
    stream.plotBottomClear,
  `plot ${Math.round(stream.plotWidth)}px inside a ${Math.round(stream.pageWidth)}px page; ` +
    `scrolled to ${Math.round(stream.scrolledTo)}px, last panel clear=${stream.plotBottomClear}`,
);
check(
  "stream draws one panel per sensor group with points",
  stream.charts.length === 3 &&
    stream.charts.every((c) => c.points.every((p) => p > 50)),
  stream.charts.map((c) => `${c.title}: ${c.points.join("/")} pts`).join(", "),
);
check(
  "stats strip reads a sane rate and 0% loss",
  stream.cells.Rate === "204.8 Hz" &&
    stream.cells.Expected === "204.8 Hz" &&
    stream.cells.Loss === "0.0 %",
  JSON.stringify(stream.cells),
);
check(
  "apply refused while streaming, with a reason",
  stream.applyDisabled &&
    /NACKs configuration commands while sensing/.test(stream.applyNote),
  stream.applyNote,
);
check(
  "only the Bluetooth stop button is live while streaming without SD",
  stream.btStop && !stream.sdStop,
);

// ---- the SD tab is refused while the sensor is sensing
const sdWhileStreaming = await evaluate(`
  return { tabDisabled: document.getElementById('tabBtnSd').disabled,
    tabTitle: document.getElementById('tabBtnSd').title,
    banner: document.getElementById('sdBanner').textContent,
    refresh: window.__sdRole('refresh').disabled,
    dlAll: window.__sdRole('downloadAll').disabled,
    // 4. The link test is no longer a card control at all.
    linkTestRoleGone: window.__sdRole('linkTest') === null,
    linkTest: document.getElementById('btnLinkTest').disabled,
    linkTestNote: document.getElementById('linkTestNote').textContent,
    linkTestTitle: document.getElementById('btnLinkTest').title,
    treeRows: document.querySelectorAll('[data-sd-role="tree"] > ul > li').length,
    stats: window.__sdStats() };
`);
check(
  "the SD tab is closed off while the sensor is sensing, with the reason on it",
  sdWhileStreaming.tabDisabled &&
    /refuses every SD command while it is/.test(sdWhileStreaming.banner) &&
    sdWhileStreaming.banner === sdWhileStreaming.tabTitle &&
    sdWhileStreaming.refresh &&
    sdWhileStreaming.dlAll &&
    sdWhileStreaming.treeRows === 0 &&
    sdWhileStreaming.stats.files === "–",
  sdWhileStreaming.banner.slice(0, 80) + "…",
);
check(
  "the link-speed test is refused while streaming, and says why rather than just greying",
  sdWhileStreaming.linkTestRoleGone &&
    sdWhileStreaming.linkTest &&
    /deliberately saturates the link/.test(sdWhileStreaming.linkTestNote) &&
    /Stop the stream first/.test(sdWhileStreaming.linkTestNote) &&
    sdWhileStreaming.linkTestTitle === sdWhileStreaming.linkTestNote,
  sdWhileStreaming.linkTestNote.slice(0, 80) + "…",
);

// ---- record, then a dropped link mid-stream
const rec = await evaluate(`
  document.getElementById('btnRecStart').click();
  await new Promise(r=>setTimeout(r,3000));
  const mid = { pill: document.getElementById('recPill').textContent,
    rows: document.getElementById('recRows').textContent };
  window.mockTransport.emitDisconnect(new Error('cable yanked (mock)'));
  await new Promise(r=>setTimeout(r,1500));
  const after = { connPill: document.getElementById('connPill').textContent,
    recPill: document.getElementById('recPill').textContent,
    rows: document.getElementById('recRows').textContent,
    bytes: document.getElementById('recBytes').textContent,
    idName: document.getElementById('idName').textContent,
    bleEnabled: !document.getElementById('btnBle').disabled,
    stopDisabled: document.getElementById('btnStreamStop').disabled,
    streamTabEnabled: !document.getElementById('tabBtnStream').disabled,
    toasts: [...document.querySelectorAll('.toast')].map(t=>t.textContent) };
  let csv = null;
  if (window.__blobs.length) {
    const txt = await window.__blobs[window.__blobs.length-1].text();
    const lines = txt.split(/\\r?\\n/).filter(Boolean);
    csv = { header: lines[0], units: lines[1], cols: lines[0].split(',').length,
      dataRows: lines.length - 2, lastCols: lines[lines.length-1].split(',').length };
  }
  return { mid, after, csv, blobs: window.__blobs.length };
`);
check(
  "recording accepts rows while streaming",
  Number(rec.mid.rows.replace(/,/g, "")) > 100 && rec.mid.pill === "recording",
  JSON.stringify(rec.mid),
);
check(
  "dropped link finishes the recording and keeps the CSV",
  rec.blobs === 1 &&
    rec.csv &&
    rec.csv.dataRows > 100 &&
    rec.csv.cols === rec.csv.lastCols,
  `${rec.csv?.dataRows} rows, ${rec.csv?.cols} columns, reported ${rec.after.rows} / ${rec.after.bytes}`,
);
check(
  "CSV header matches the stream columns",
  rec.csv.header.startsWith("HostTime_ms,TIMESTAMP,LN_ACCEL_X_RAW") &&
    rec.csv.units.startsWith("ms,ticks,"),
  rec.csv.header.slice(0, 90) + "…",
);
check(
  "row count matches what the page reported",
  String(rec.csv.dataRows) === rec.after.rows.replace(/,/g, ""),
  `csv ${rec.csv.dataRows} vs page ${rec.after.rows}`,
);
check(
  "UI recovers after the drop",
  rec.after.connPill === "disconnected" &&
    rec.after.recPill === "not recording" &&
    rec.after.idName === "–" &&
    rec.after.bleEnabled &&
    rec.after.stopDisabled &&
    rec.after.streamTabEnabled,
  JSON.stringify(rec.after.toasts),
);

// ===========================================================================
console.log("\n--- unframed (classic-Bluetooth-like, 3-byte dribble) ---");
await goto(`${BASE}?mock=1&framed=0&rate=102.4`);
check(
  "connect over the unframed transport",
  (await evaluate(CONNECT)) === "mock",
);
const un = await evaluate(`
  const t = id => document.getElementById(id).textContent;
  return { name:t('idName'), mac:t('idMac'), fw:t('idFw'), link:t('idLink'),
    imPill:t('imPill'), rate:document.getElementById('ratePill').textContent,
    fields:document.querySelectorAll('#configForm .field').length };
`);
check(
  "unframed link reads identity and the whole image",
  un.name.endsWith("-BT") &&
    un.mac === "000666668091" &&
    un.imPill === "384 bytes read" &&
    un.rate === "102.4 Hz" &&
    un.fields === 40,
  JSON.stringify(un),
);

// ---- InfoMem save -> mutate -> load round trip
const round = await evaluate(`
  document.getElementById('btnImSave').click();
  await new Promise(r=>setTimeout(r,250));
  const saved = new Uint8Array(await window.__blobs[0].arrayBuffer());
  const wr = document.querySelector('#configForm .field[data-field-key="wrAccelRange"] select');
  wr.value = [...wr.options].map(o=>o.value).find(v => v !== wr.value);
  wr.dispatchEvent(new Event('change', {bubbles:true}));
  await new Promise(r=>setTimeout(r,80));
  const mutated = { pill: document.getElementById('dirtyPill').textContent,
    changed: document.querySelectorAll('.hexview-byte.changed').length };
  const dt = new DataTransfer();
  dt.items.add(new File([saved], 'roundtrip.bin', {type:'application/octet-stream'}));
  const input = document.getElementById('imFile');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', {bubbles:true}));
  await new Promise(r=>setTimeout(r,300));
  return { savedBytes: saved.length, mutated,
    loaded: { pill: document.getElementById('dirtyPill').textContent,
      hidden: document.getElementById('dirtyPill').hidden,
      changed: document.querySelectorAll('.hexview-byte.changed').length,
      banner: document.getElementById('imBanner').textContent } };
`);
check(
  "InfoMem hex view round-trips a Save then Load",
  round.savedBytes === 384 &&
    round.mutated.changed === 1 &&
    round.loaded.changed === 0 &&
    round.loaded.hidden &&
    /0 of 384 bytes differ/.test(round.loaded.banner),
  `saved ${round.savedBytes} B, after edit ${round.mutated.changed} changed byte, after load ${round.loaded.changed}`,
);

// ---- a card download over the byte-stream link: the SD frames have to
//      survive the SDK's re-framing, arriving 3 bytes at a time
const sdUnframed = await evaluate(
  MEMFS +
    `
  window.mockTransport.writes.length = 0;
  document.querySelector('.tabs [data-tab="tabSd"]').click();
  await window.sdBrowser.refresh();
  await window.__useFs('UnframedDest');
  await window.sdBrowser.download(
    ['data/DefaultTrial_5f2c1a90/Shimmer_8091-001'], { deleteVerified: false });
  const cmp = [...window.__fs.files.keys()].map(hostPath => {
    const cardPath = hostPath.slice(hostPath.indexOf('/data/') + 1);
    const want = window.mockTransport.sdCard.bytes(cardPath);
    const got = window.__fs.files.get(hostPath);
    let mismatchAt = -1;
    if (!want) mismatchAt = -3;
    else if (want.length !== got.length) mismatchAt = -2;
    else for (let i = 0; i < want.length; i++)
      if (want[i] !== got[i]) { mismatchAt = i; break; }
    return { cardPath, bytes: got.length, mismatchAt };
  });
  return { cmp, stats: window.__sdStats(),
    rows: document.querySelectorAll('[data-sd-role="tree"] > ul > li').length,
    progress: window.__sdRole('progress').textContent };
`,
);
check(
  "the card downloads intact over the unframed link too, 3 bytes at a time",
  sdUnframed.rows === 2 &&
    sdUnframed.stats.bytes === "351.4 KB" &&
    sdUnframed.cmp.length === 3 &&
    sdUnframed.cmp.every((f) => f.mismatchAt === -1) &&
    sdUnframed.cmp.map((f) => f.bytes).join() === "17622,6145,931" &&
    sdUnframed.progress === "Done",
  sdUnframed.cmp
    .map(
      (f) =>
        `${f.cardPath.split("/").pop()} ${f.bytes}B ok=${f.mismatchAt === -1}`,
    )
    .join(" | "),
);

// ---- streaming and SD logging on the unframed link
const sd = await evaluate(`
  document.querySelector('.tabs [data-tab="tabStream"]').click();
  document.getElementById('btnSdStart').click();
  await new Promise(r=>setTimeout(r,3000));
  const cells = {};
  for (const d of document.querySelectorAll('#stats > div'))
    cells[d.querySelector('.stat-label').textContent] = d.querySelector('.stat-value').textContent;
  const ops = window.mockTransport.writes.map(w => w.bytes[0]);
  const during = { cells,
    btStop: !document.getElementById('btnStreamStop').disabled,
    sdStop: !document.getElementById('btnSdStop').disabled,
    applyNote: document.getElementById('applyNote').textContent,
    sawStartSdbt: ops.includes(0x70) };
  document.getElementById('btnSdStop').click();
  await new Promise(r=>setTimeout(r,1200));
  const ops2 = window.mockTransport.writes.map(w => w.bytes[0]);
  return { during, sawStopSdbt: ops2.includes(0x97),
    afterStop: { btStop: !document.getElementById('btnStreamStop').disabled,
      applyDisabled: document.getElementById('btnApply').disabled,
      applyNote: document.getElementById('applyNote').textContent } };
`);
check(
  "stream + SD logging sends START_SDBT (0x70) and STOP_SDBT (0x97)",
  sd.during.sawStartSdbt && sd.sawStopSdbt,
);
check(
  "only the SD stop button is live while logging",
  !sd.during.btStop && sd.during.sdStop,
);
check(
  "apply is refused while logging to the card",
  /NACKs configuration commands while sensing/.test(sd.during.applyNote),
  sd.during.applyNote,
);
check(
  "apply is offered again once logging stops",
  !sd.afterStop.btStop && sd.afterStop.applyNote === "",
);
check(
  "SD stream stats are sane at 102.4 Hz",
  sd.during.cells.Rate === "102.4 Hz" && sd.during.cells.Loss === "0.0 %",
  JSON.stringify(sd.during.cells),
);

// ===========================================================================
// Device naming
//
// A page load of its own, because the last check in here arms a restart and
// disconnects — and because the mock's synthetic EEPROM should start from the
// stock record for the stock-detection checks.
// ===========================================================================
console.log("\n--- device naming ---");
await goto(`${BASE}?mock=1`);
check(
  "connect for the device-naming pass",
  (await evaluate(CONNECT)) === "mock",
);

/* Shared helpers for this section. MEMFS comes along because it carries
   `__opCount` and `__sdRole`, and a `goto` has wiped the previous load's
   injections. */
const BRAND =
  MEMFS +
  `
window.__brandStats = () => {
  const out = {};
  for (const s of document.querySelectorAll('#brandPanel [data-brand-stat]'))
    out[s.dataset.brandStat] = s.textContent;
  return out;
};
window.__brandRole = (r) => document.querySelector('[data-brand-role="' + r + '"]');
window.__brandInput = (k) => document.querySelector('[data-brand-input="' + k + '"]');
window.__brandError = (k) => document.querySelector('[data-brand-error="' + k + '"]').textContent;
window.__brandPreview = (k) => document.querySelector('[data-brand-preview="' + k + '"]').textContent;
window.__type = (k, v) => {
  const i = window.__brandInput(k);
  i.value = v;
  i.dispatchEvent(new Event('input', { bubbles: true }));
};
window.__sameBytes = (a, b) => {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
};
`;

// ---- the capability key the whole tab hangs off
const brandCaps = await evaluate(`
  const m = await import('/common/shimmer3-config-schema.js');
  const full = { readDaughterCardMem(){}, writeDaughterCardMem(){} };
  return {
    ble: m.describeShimmer3Caps(full, 'ble').branding,
    rfcomm: m.describeShimmer3Caps(full, 'rfcomm').branding,
    usb: m.describeShimmer3Caps(full, 'usb').branding,
    readOnly: m.describeShimmer3Caps({ readDaughterCardMem(){} }, 'ble').branding,
    noMethods: m.describeShimmer3Caps({}, 'ble').branding,
  };
`);
check(
  "the branding capability is offered on every link, including the USB dock",
  brandCaps.ble === true &&
    brandCaps.rfcomm === true &&
    brandCaps.usb === true &&
    brandCaps.readOnly === false &&
    brandCaps.noMethods === false,
  JSON.stringify(brandCaps),
);

// ---- the stock record the mock was seeded with
const brandStock = await evaluate(
  BRAND +
    `
  window.mockTransport.writes.length = 0;
  document.querySelector('.tabs [data-tab="tabBrand"]').click();
  for (let i = 0; i < 60 && !window.brandEditor.record(); i++)
    await new Promise(r => setTimeout(r, 100));
  const sdk = await import('/vendor/shimmer-web-sdk.esm.js');
  const onDevice = window.mockTransport.eeprom.brandBytes();
  return { stats: window.__brandStats(),
    pill: window.__brandRole('recordPill').textContent,
    pillClass: window.__brandRole('recordPill').className,
    note: window.__brandRole('recordNote').textContent,
    isStock: window.brandEditor.isStockRecord(),
    bleCap: window.brandEditor.bleCap(),
    bleMaxAttr: window.__brandInput('ble').maxLength,
    reads: window.__opCount(0x69), writes: window.__opCount(0x67),
    parsed: sdk.parseBrandRecord(onDevice),
    matchesStock: window.__sameBytes(onDevice, window.mockTransport.eeprom.stockBrandBytes()),
    banner: document.getElementById('brandBanner').textContent };
`,
);
check(
  "opening the tab reads the record once and reports the stock names as stock",
  brandStock.reads === 1 &&
    brandStock.writes === 0 &&
    brandStock.isStock === true &&
    brandStock.pill === "valid · factory names" &&
    brandStock.pillClass === "pill on" &&
    /seeded by SHIMMER3R/.test(brandStock.note) &&
    brandStock.stats.btClassic === "Shimmer3R" &&
    brandStock.stats.ble === "Shimmer3R" &&
    brandStock.stats.usbProduct === "Shimmer" &&
    brandStock.stats.usbManufacturer === "Shimmer Research Ltd." &&
    brandStock.stats.device === "Shimmer3R" &&
    brandStock.stats.mac === "8091" &&
    brandStock.banner === "",
  `${brandStock.pill} — ${JSON.stringify(brandStock.stats)}`,
);
check(
  "an identified Shimmer3R gets the full 10-character BLE cap",
  brandStock.bleCap === 10 && brandStock.bleMaxAttr === 10,
  `cap ${brandStock.bleCap}, maxlength ${brandStock.bleMaxAttr}`,
);

// ---- per-field validation, and that nothing reaches the sensor while it fails
const brandBad = await evaluate(`
  window.mockTransport.writes.length = 0;
  const cases = {};
  const record = (name) => {
    cases[name] = {
      errors: { bt: window.__brandError('btClassic'), ble: window.__brandError('ble'),
        product: window.__brandError('usbProduct'), man: window.__brandError('usbManufacturer') },
      write: window.__brandRole('write').disabled,
      bad: [...document.querySelectorAll('#brandPanel input.bad')].map(i => i.dataset.brandInput),
    };
  };
  record('empty');
  window.__type('btClassic', 'ThisNameIsFarTooLong');
  record('tooLong');
  window.__type('btClassic', 'Has,Comma');
  record('comma');
  /* Attempted from HERE, with a name the firmware would reject: the button is
     disabled, so this is the programmatic door, and it has to be shut too. */
  const attempted = await window.brandEditor.write();
  window.__type('btClassic', 'Acme');
  window.__type('ble', 'ElevenChars');
  record('bleOverCap');
  window.__type('ble', '');
  window.__type('usbManufacturer', '');
  record('noManufacturer');
  window.__type('usbManufacturer', 'Acme Instruments Ltd.');
  record('ok');
  return { cases, attempted, writes: window.__opCount(0x67),
    lastLog: [...document.querySelectorAll('#log .log-line')].slice(-2).map(l => l.textContent) };
`);
check(
  "each name is refused on its own, with Write disabled and nothing sent",
  brandBad.cases.empty.write &&
    brandBad.cases.empty.errors.bt === "enter a name" &&
    brandBad.cases.tooLong.write &&
    /longer than 16/.test(brandBad.cases.tooLong.errors.bt) &&
    brandBad.cases.tooLong.bad.join() === "btClassic" &&
    brandBad.cases.comma.write &&
    /comma/i.test(brandBad.cases.comma.errors.bt) &&
    brandBad.cases.bleOverCap.write &&
    /longer than 10/.test(brandBad.cases.bleOverCap.errors.ble) &&
    brandBad.cases.bleOverCap.bad.join() === "ble" &&
    brandBad.cases.noManufacturer.write &&
    brandBad.cases.noManufacturer.errors.man === "enter a manufacturer name" &&
    !brandBad.cases.ok.write &&
    brandBad.cases.ok.bad.length === 0 &&
    // and the programmatic door is shut as well
    brandBad.attempted === false &&
    brandBad.writes === 0,
  `empty:"${brandBad.cases.empty.errors.bt}" long:"${brandBad.cases.tooLong.errors.bt}" ` +
    `comma:"${brandBad.cases.comma.errors.bt}" ble:"${brandBad.cases.bleOverCap.errors.ble}" ` +
    `man:"${brandBad.cases.noManufacturer.errors.man}" — ${brandBad.writes} commands sent`,
);

// ---- a name write: derived fallbacks, the confirmation, the byte compare
const brandWrite = await evaluate(`
  window.mockTransport.writes.length = 0;
  const sdk = await import('/vendor/shimmer-web-sdk.esm.js');
  window.__type('btClassic', 'AcmeWristband');
  window.__type('ble', '');
  window.__type('usbProduct', '');
  window.__type('usbManufacturer', 'Acme Instruments Ltd.');
  const previews = { bt: window.__brandPreview('btClassic'), ble: window.__brandPreview('ble'),
    product: window.__brandPreview('usbProduct'), man: window.__brandPreview('usbManufacturer') };
  const effective = window.brandEditor.fields();
  const ok = await window.brandEditor.write();
  const cmd = window.mockTransport.writes.find(w => w.bytes[0] === 0x67);
  const onDevice = window.mockTransport.eeprom.brandBytes();
  const expected = sdk.buildBrandRecord(effective);
  return { ok, effective, previews, confirm: window.__confirm,
    stats: window.__brandStats(),
    pill: window.__brandRole('recordPill').textContent,
    isStock: window.brandEditor.isStockRecord(),
    writes: window.__opCount(0x67), reads: window.__opCount(0x69),
    cmdOffset: cmd ? cmd.bytes[2] | (cmd.bytes[3] << 8) : null,
    cmdLen: cmd ? cmd.bytes[1] : null,
    sentMatchesBuilt: window.__sameBytes(cmd.bytes.slice(4), expected),
    deviceMatchesBuilt: window.__sameBytes(onDevice, expected),
    parsed: sdk.parseBrandRecord(onDevice),
    banner: !window.__brandRole('restart-banner').hidden,
    autoHidden: window.__brandRole('restartAuto').hidden,
    manualHidden: window.__brandRole('restartManual').hidden,
    toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent) };
`);
check(
  "the BLE and USB-product prefixes derive from the classic one, capped, and that is what is written",
  brandWrite.effective.btClassic === "AcmeWristband" &&
    brandWrite.effective.ble === "AcmeWristb" &&
    brandWrite.effective.usbProduct === "AcmeWristband" &&
    brandWrite.parsed.ble === "AcmeWristb" &&
    brandWrite.parsed.usbProduct === "AcmeWristband" &&
    /AcmeWristb-8091-BLE/.test(brandWrite.previews.ble) &&
    /truncated from the classic Bluetooth prefix/.test(
      brandWrite.previews.ble,
    ) &&
    /USB product "AcmeWristband 8091"/.test(brandWrite.previews.product),
  `BLE "${brandWrite.effective.ble}" (cap 10) · product "${brandWrite.effective.usbProduct}" · ${brandWrite.previews.ble}`,
);
check(
  "the write goes to the record offset as one CRC'd 80-byte command and verifies byte for byte",
  brandWrite.ok === true &&
    brandWrite.writes === 1 &&
    brandWrite.reads === 1 &&
    brandWrite.cmdOffset === 1936 &&
    brandWrite.cmdLen === 80 &&
    brandWrite.sentMatchesBuilt === -1 &&
    brandWrite.deviceMatchesBuilt === -1 &&
    brandWrite.parsed.valid === true &&
    brandWrite.isStock === false &&
    brandWrite.pill === "valid · custom names",
  `${brandWrite.cmdLen} B at host offset ${brandWrite.cmdOffset}, read back and compared, now "${brandWrite.pill}"`,
);
check(
  "the confirmation shows the old name next to the new one before anything is written",
  /Shimmer3R → AcmeWristband/.test(brandWrite.confirm) &&
    /Shimmer Research Ltd\. → Acme Instruments Ltd\./.test(
      brandWrite.confirm,
    ) &&
    /read back and compared byte for byte/.test(brandWrite.confirm),
  brandWrite.confirm.split("\n").filter(Boolean).slice(1, 5).join(" / "),
);
check(
  "a verified write raises the restart banner, on its Bluetooth route",
  brandWrite.banner &&
    !brandWrite.autoHidden &&
    brandWrite.manualHidden &&
    brandWrite.toasts.some((t) => /written and verified/.test(t)),
  brandWrite.toasts.join(" | "),
);

// ---- the link is shared: a name write and a stream / a card transfer cannot
const brandContend = await evaluate(
  MEMFS +
    `
  document.querySelector('.tabs [data-tab="tabStream"]').click();
  document.getElementById('btnStreamStart').click();
  await new Promise(r => setTimeout(r, 1200));
  window.mockTransport.writes.length = 0;
  const streaming = {
    tab: document.getElementById('tabBtnBrand').disabled,
    title: document.getElementById('tabBtnBrand').title,
    banner: document.getElementById('brandBanner').textContent,
    write: window.__brandRole('write').disabled,
    read: window.__brandRole('read').disabled,
    attempted: await window.brandEditor.write(),
    cmds: window.__opCount(0x67),
  };
  document.getElementById('btnStreamStop').click();
  await new Promise(r => setTimeout(r, 800));

  document.querySelector('.tabs [data-tab="tabSd"]').click();
  await window.sdBrowser.refresh();
  await window.__useFs('BrandContendDest');
  const run = window.sdBrowser.download(['data'], { deleteVerified: false });
  const label = window.__sdRole('progress');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (/^download: /.test(label.textContent)) break;
  }
  window.mockTransport.writes.length = 0;
  const transferring = {
    tab: document.getElementById('tabBtnBrand').disabled,
    banner: document.getElementById('brandBanner').textContent,
    write: window.__brandRole('write').disabled,
    attempted: await window.brandEditor.write(),
    cmds: window.__opCount(0x67),
  };
  window.sdBrowser.abort();
  await run;
  await new Promise(r => setTimeout(r, 500));
  return { streaming, transferring,
    after: { tab: document.getElementById('tabBtnBrand').disabled,
      banner: document.getElementById('brandBanner').textContent,
      write: window.__brandRole('write').disabled } };
`,
);
check(
  "a name write is refused while the sensor is sensing, with the restart reason given",
  brandContend.streaming.tab &&
    brandContend.streaming.write &&
    brandContend.streaming.read &&
    brandContend.streaming.attempted === false &&
    brandContend.streaming.cmds === 0 &&
    /skips a restart while it is sensing/.test(brandContend.streaming.banner) &&
    brandContend.streaming.title === brandContend.streaming.banner,
  brandContend.streaming.banner.slice(0, 100) + "…",
);
check(
  "a name write is refused while an SD transfer holds the link, and offered again after",
  brandContend.transferring.tab &&
    brandContend.transferring.write &&
    brandContend.transferring.attempted === false &&
    brandContend.transferring.cmds === 0 &&
    /cannot share it/.test(brandContend.transferring.banner) &&
    !brandContend.after.tab &&
    !brandContend.after.write &&
    brandContend.after.banner === "",
  brandContend.transferring.banner.slice(0, 90) + "…",
);

// ---- and the other direction: an SD transfer is refused while a name writes
const brandBlocksSd = await evaluate(`
  document.querySelector('.tabs [data-tab="tabBrand"]').click();
  /* Streaming dropped the panel's floor, which cleared the record, so
     re-opening the tab re-reads it — wait for that rather than racing it. */
  for (let i = 0; i < 60 && !window.brandEditor.record(); i++)
    await new Promise(r => setTimeout(r, 100));
  window.__type('btClassic', 'AcmeTwo');
  const run = window.brandEditor.write();
  /* Poll rather than guess a delay: the write is two round trips, and the
     mock answers on a zero-delay timer. */
  const note = document.getElementById('applyNote');
  for (let i = 0; i < 50 && !/name write/.test(note.textContent); i++)
    await new Promise(r => setTimeout(r, 5));
  const during = {
    apply: document.getElementById('btnApply').disabled,
    applyNote: document.getElementById('applyNote').textContent,
    sdRefresh: window.__sdRole('refresh').disabled,
    sdDownloadAll: window.__sdRole('downloadAll').disabled,
  };
  const ok = await run;
  await new Promise(r => setTimeout(r, 200));
  return { ok, during, afterApply: document.getElementById('applyNote').textContent,
    afterSdRefresh: window.__sdRole('refresh').disabled };
`);
check(
  "while a name is being written, Apply and the SD panel are refused with a reason",
  brandBlocksSd.ok === true &&
    brandBlocksSd.during.apply &&
    brandBlocksSd.during.sdRefresh &&
    brandBlocksSd.during.sdDownloadAll &&
    /name write and a configuration write cannot share the link/.test(
      brandBlocksSd.during.applyNote,
    ) &&
    brandBlocksSd.afterApply === "" &&
    !brandBlocksSd.afterSdRefresh,
  brandBlocksSd.during.applyNote,
);

// ---- restore the factory names: erase, then prove the restart re-seeds them
const brandRestore = await evaluate(`
  const sdk = await import('/vendor/shimmer-web-sdk.esm.js');
  window.mockTransport.writes.length = 0;
  const before = window.mockTransport.eeprom.brandBytes();
  const ok = await window.brandEditor.restoreDefaults();
  const erased = window.mockTransport.eeprom.brandBytes();
  const afterErase = {
    pill: window.__brandRole('recordPill').textContent,
    note: window.__brandRole('recordNote').textContent,
    matchesBlank: window.__sameBytes(erased, sdk.buildBlankBrandRecord()),
    stats: window.__brandStats(),
    inputs: { bt: window.__brandInput('btClassic').value,
      man: window.__brandInput('usbManufacturer').value },
    isStock: window.brandEditor.isStockRecord(),
    armed: window.mockTransport.eeprom.rebootArmed,
    reboots: window.mockTransport.eeprom.reboots,
  };
  return { ok, confirm: window.__confirm, wasCustom: sdk.parseBrandRecord(before).btClassic,
    afterErase, writes: window.__opCount(0x67) };
`);
check(
  "restore-defaults erases the record and says the factory names come back at the restart",
  brandRestore.ok === true &&
    brandRestore.wasCustom === "AcmeTwo" &&
    brandRestore.writes === 1 &&
    brandRestore.afterErase.matchesBlank === -1 &&
    /invalid: blank \(erased\) record/.test(brandRestore.afterErase.pill) &&
    /using its factory names/.test(brandRestore.afterErase.note) &&
    brandRestore.afterErase.inputs.bt === "" &&
    brandRestore.afterErase.inputs.man === "Shimmer Research Ltd." &&
    /Shimmer3R/.test(brandRestore.confirm) &&
    brandRestore.afterErase.reboots === 0,
  `${brandRestore.afterErase.pill}; confirmed "${
    brandRestore.confirm.split("\n").filter(Boolean)[1]?.trim() ?? ""
  }"`,
);

// ---- the Bluetooth route: arm the restart, drop the link, and the firmware
//      re-seeds the factory record at boot
const brandRestart = await evaluate(`
  window.mockTransport.writes.length = 0;
  const armedBefore = window.mockTransport.eeprom.rebootArmed;
  const ok = await window.brandEditor.armRestart();
  await new Promise(r => setTimeout(r, 400));
  const feature = window.mockTransport.writes.find(w => w.bytes[0] === 0xB7);
  const onDevice = window.mockTransport.eeprom.brandBytes();
  return { ok, armedBefore,
    featureCmd: feature ? [...feature.bytes] : null,
    reboots: window.mockTransport.eeprom.reboots,
    armedAfter: window.mockTransport.eeprom.rebootArmed,
    reseeded: window.__sameBytes(onDevice, window.mockTransport.eeprom.stockBrandBytes()),
    connPill: document.getElementById('connPill').textContent,
    bannerHidden: window.__brandRole('restart-banner').hidden,
    brandTabStat: window.__brandStats().btClassic,
    logs: [...document.querySelectorAll('#log .log-line')].map(l => l.textContent)
      .filter(l => /restart/i.test(l)) };
`);
check(
  "the Bluetooth route arms a one-shot restart with SET_FEATURE, then drops the link",
  brandRestart.ok === true &&
    brandRestart.armedBefore === false &&
    brandRestart.featureCmd?.join() === "183,2,1" &&
    brandRestart.connPill === "disconnected" &&
    brandRestart.bannerHidden &&
    brandRestart.brandTabStat === "–",
  `SET_FEATURE ${brandRestart.featureCmd?.join(" ")} → ${brandRestart.connPill}`,
);
check(
  "the restart fires once, clears itself, and the factory record is back byte for byte",
  brandRestart.reboots === 1 &&
    brandRestart.armedAfter === false &&
    brandRestart.reseeded === -1,
  `${brandRestart.reboots} restart, armed=${brandRestart.armedAfter}, stock bytes restored=${brandRestart.reseeded === -1}`,
);

// ===========================================================================
// Device naming on a sensor that will not say what it is.
//
// THE trap: the page defaults an unknown hardware version to 10 (Shimmer3R)
// when it builds the InfoMem context, because the field schema needs some
// layout to render. The naming panel must NOT see that default, or an
// unidentified Shimmer3 is offered a 10-character BLE prefix its own firmware
// truncates to 8 on air — invisibly, from this page.
// ===========================================================================
console.log("\n--- device naming: a sensor that will not identify itself ---");
await goto(`${BASE}?mock=1&hw=none`);
check(
  "connect to a sensor that refuses GET_DEVICE_VERSION",
  (await evaluate(CONNECT)) === "mock",
);
const brandUnknown = await evaluate(
  BRAND +
    `
  document.querySelector('.tabs [data-tab="tabBrand"]').click();
  for (let i = 0; i < 60 && !window.brandEditor.record(); i++)
    await new Promise(r => setTimeout(r, 100));
  window.__type('btClassic', 'AcmeWristband');
  window.__type('ble', 'TenCharsXX');
  const overCap = { error: window.__brandError('ble'), write: window.__brandRole('write').disabled };
  window.__type('ble', '');
  return { idHw: document.getElementById('idHw').textContent,
    contextHw: window.brandEditor.bleCap(), overCap,
    maxAttr: window.__brandInput('ble').maxLength,
    fields: document.querySelectorAll('#configForm .field').length,
    isStock: window.brandEditor.isStockRecord(),
    pill: window.__brandRole('recordPill').textContent,
    note: window.__brandRole('recordNote').textContent,
    stats: window.__brandStats(),
    derived: window.brandEditor.fields().ble,
    preview: window.__brandPreview('btClassic'),
    warned: [...document.querySelectorAll('#log .log-line')]
      .filter(l => /did not report its hardware version/.test(l.textContent)).length };
`,
);
check(
  "an unidentified sensor keeps the SHORT BLE cap, even though the config form defaulted to a Shimmer3R",
  brandUnknown.idHw === "–" &&
    brandUnknown.fields === 40 &&
    brandUnknown.contextHw === 8 &&
    brandUnknown.maxAttr === 8 &&
    brandUnknown.derived === "AcmeWris" &&
    /longer than 8 characters/.test(brandUnknown.overCap.error) &&
    brandUnknown.overCap.write &&
    brandUnknown.warned === 1,
  `cap ${brandUnknown.contextHw}, maxlength ${brandUnknown.maxAttr}, derived "${brandUnknown.derived}", "${brandUnknown.overCap.error}"`,
);
check(
  "and it declines to call the record stock or custom, rather than guessing",
  brandUnknown.isStock === null &&
    brandUnknown.pill === "valid" &&
    /did not report which hardware it is/.test(brandUnknown.note) &&
    brandUnknown.stats.device === "not identified" &&
    /on a Shimmer3, .*on a Shimmer3R/.test(brandUnknown.preview),
  `${brandUnknown.pill} — ${brandUnknown.preview}`,
);

// ===========================================================================
// Device naming over a link with no soft restart.
//
// The dock UART has no SET_FEATURE, so the panel has to walk the user through
// a power-cycle instead. The mock is always a Bluetooth client, so this one
// mounts the panel directly on a wired-shaped client: the same two
// daughter-card calls, no setRebootOnDisconnect.
// ===========================================================================
console.log("\n--- device naming: a link that cannot ask for a restart ---");
const brandWired = await evaluate(`
  const [m, sdk] = await Promise.all([
    import('/common/brand-editor.js'),
    import('/vendor/shimmer-web-sdk.esm.js'),
  ]);
  const store = new Uint8Array(2032).fill(0xff);
  store.set(sdk.buildBrandRecord({ btClassic: 'Shimmer3', ble: 'S3BLE',
    usbProduct: 'Shimmer', usbManufacturer: 'Shimmer Research Ltd.',
    seededPlatform: sdk.BRAND_PLATFORM.SHIMMER3 }), sdk.BRAND_RECORD_HOST_OFFSET);
  const wired = {
    async readDaughterCardMem(off, len) { return store.slice(off, off + len); },
    async writeDaughterCardMem(off, data) { store.set(data, off); },
  };
  const hostEl = document.createElement('div');
  document.body.appendChild(hostEl);
  const lines = [];
  const panel = m.createBrandEditor(hostEl, {
    client: wired, mode: 'usb', identifiedHardwareVersion: 3, macSuffix: 'AB12',
    log: { log: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s) },
    confirm: () => true,
  });
  const beforeEnable = await panel.write();
  panel.setEnabled(true);
  const rec = await panel.read();
  const role = (r) => hostEl.querySelector('[data-brand-role="' + r + '"]');
  const input = (k) => hostEl.querySelector('[data-brand-input="' + k + '"]');
  panel.setFields({ btClassic: 'DockBrand', usbManufacturer: 'Dock Ltd.' });
  const bleCap = panel.bleCap();
  const bleMax = input('ble').maxLength;
  const ok = await panel.write();
  const written = sdk.parseBrandRecord(store.slice(sdk.BRAND_RECORD_HOST_OFFSET,
    sdk.BRAND_RECORD_HOST_OFFSET + sdk.BRAND_RECORD_SIZE));
  const out = {
    beforeEnable, ok, bleCap, bleMax,
    stockOnRead: panel.isStockRecord(rec),
    canSoftRestart: panel.canSoftRestart(),
    bannerShown: !role('restart-banner').hidden,
    autoHidden: role('restartAuto').hidden,
    manualHidden: role('restartManual').hidden,
    restartHidden: role('restart').hidden,
    steps: [...hostEl.querySelectorAll('.brand-steps li')].map(li => li.textContent.slice(0, 40)),
    manualText: role('restartManual').textContent.slice(0, 200),
    written: { bt: written.btClassic, ble: written.ble, product: written.usbProduct, man: written.usbManufacturer },
    productPreview: hostEl.querySelector('[data-brand-preview="usbProduct"]').textContent,
    armed: await panel.armRestart(),
    refusal: lines.filter(l => /restart/i.test(l)),
  };
  panel.destroy();
  hostEl.remove();
  return out;
`);
check(
  "the panel mounts unchanged on a wired client and writes over it",
  brandWired.beforeEnable === false &&
    brandWired.ok === true &&
    brandWired.stockOnRead === true &&
    brandWired.written.bt === "DockBrand" &&
    brandWired.written.ble === "DockBran" &&
    brandWired.written.product === "DockBrand" &&
    brandWired.written.man === "Dock Ltd.",
  JSON.stringify(brandWired.written),
);
check(
  "a positively identified Shimmer3 gets the 8-character cap and the Shimmer3 name shapes",
  brandWired.bleCap === 8 &&
    brandWired.bleMax === 8 &&
    /unused on a Shimmer3/.test(brandWired.productPreview),
  `cap ${brandWired.bleCap} — ${brandWired.productPreview}`,
);
check(
  "with no soft restart the banner walks the user through a power-cycle instead",
  brandWired.canSoftRestart === false &&
    brandWired.bannerShown &&
    brandWired.autoHidden &&
    !brandWired.manualHidden &&
    brandWired.restartHidden &&
    brandWired.steps.length === 3 &&
    /dock\/USB serial protocol has no such command/.test(
      brandWired.manualText,
    ) &&
    brandWired.armed === false &&
    brandWired.refusal.some((l) => /power-cycle it by hand/.test(l)),
  brandWired.refusal.join(" | ") || brandWired.manualText,
);

// ===========================================================================
// Calibration.
//
// Its own page loads: the tab reads a whole dump, edits it and writes it
// back, and each of the hardware variants below needs the mock rebuilt with a
// different hardware id.
// ===========================================================================
console.log("\n--- calibration ---");
await goto(`${BASE}?mock=1`);
check("connect for the calibration pass", (await evaluate(CONNECT)) === "mock");

/* Shared helpers for this section: the panel plants `data-cal-*` roles rather
   than ids, exactly as the SD and device-naming panels do, so a page can
   mount it twice. */
const CAL = `
  const P = () => document.getElementById('calPanel');
  const role = (r) => P().querySelector('[data-cal-role="' + r + '"]');
  const card = (g) => P().querySelector('[data-cal-sensor="' + g + '"]');
  const cell = (g, part, i) =>
    P().querySelector('input[data-cal-input="' + g + ':' + part + ':' + i + '"]');
  const setCell = (g, part, i, v) => {
    const c = cell(g, part, i);
    c.value = v;
    c.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pill = (g) => card(g).querySelector('[data-cal-state]').textContent;
  const cells = (g, part) =>
    [...P().querySelectorAll('input[data-cal-input^="' + g + ':' + part + '"]')]
      .map(i => i.value).join(',');
  const setRange = (g, v) => {
    const s = card(g).querySelector('[data-cal-range]');
    s.value = String(v);
    s.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /* Every SET_CALIB_DUMP chunk since \`from\`, reassembled at its own offsets
     — which is also the assertion that the chunks arrived in order and
     covered the dump with no hole. */
  const sentDump = (from) => {
    const chunks = window.mockTransport.writes.slice(from)
      .map(w => Array.from(w.bytes)).filter(b => b[0] === 0x98);
    if (!chunks.length) return null;
    const total = chunks.reduce((n, c) => n + c.length - 4, 0);
    const out = new Uint8Array(total);
    for (const c of chunks) out.set(c.slice(4), c[2] | (c[3] << 8));
    return { bytes: out, sizes: chunks.map(c => c.length - 4),
             offsets: chunks.map(c => c[2] | (c[3] << 8)) };
  };
`;

// ---- the tab exists, sits next to Configure, and Configure no longer has it
const calTab = await evaluate(`
  ${CAL}
  return {
    order: [...document.querySelectorAll('.tabs [data-tab]')].map(b => b.dataset.tab),
    label: document.querySelector('.tabs [data-tab=tabCal]').textContent.trim(),
    goneFromConfig: [...document.querySelectorAll('#tabConfig .card-title')]
      .map(t => t.textContent.trim()),
    noOldIds: ['btnCalRead','btnCalWrite','btnCalSave','btnCalLoad','calTable','calPill']
      .filter(id => document.getElementById(id)),
    ownsItsButtons: ['read','write','save','load']
      .every(r => !!P().querySelector('[data-cal-role="' + r + '"]')),
  };
`);
check(
  "Calibration is a tab of its own, next to Configure, and has left it",
  // The whole strip is pinned, not just Calibration's neighbour, so that a
  // tab appearing in the wrong place is caught as loudly as one going
  // missing. Test joins the END of the strip: it is the tab you reach for
  // once the sensor is set up, not part of setting it up.
  calTab.order.join(",") ===
    "tabConfig,tabCal,tabStream,tabSd,tabBrand,tabTest" &&
    calTab.label === "Calibration" &&
    !calTab.goneFromConfig.includes("Calibration") &&
    calTab.noOldIds.length === 0 &&
    calTab.ownsItsButtons,
  `${calTab.order.join(" → ")}; Configure now holds ${calTab.goneFromConfig.join(", ")}`,
);

// ---- the dump reads, and every sensor renders with its own range and date
const calRead = await evaluate(`
  ${CAL}
  document.querySelector('.tabs [data-tab=tabCal]').click();
  role('read').click();
  await new Promise(r => setTimeout(r, 2500));
  const reads = window.mockTransport.writes.filter(w => w.bytes[0] === 0x9a)
    .map(w => ({ len: w.bytes[1], off: w.bytes[2] | (w.bytes[3] << 8) }));
  return {
    pill: role('storePill').textContent,
    banner: role('storeBanner').textContent,
    change: role('changeNote').textContent,
    reads,
    sensors: [...P().querySelectorAll('[data-cal-sensor]')].map(c => ({
      key: c.dataset.calSensor,
      id: Number(c.dataset.calSensorId),
      state: c.dataset.calState,
      avail: c.dataset.calAvailability,
      pill: c.querySelector('[data-cal-state]').textContent,
      range: c.querySelector('[data-cal-range]')?.value ?? null,
      rangeLabel: c.querySelector('[data-cal-range] option:checked')?.textContent ?? null,
      asOf: c.querySelector('[data-cal-as-of]')?.textContent ?? '',
      offset: cells(c.dataset.calSensor, 'offset'),
      sens: cells(c.dataset.calSensor, 'sens'),
      align: cells(c.dataset.calSensor, 'align'),
    })),
  };
`);
const byKey = Object.fromEntries(calRead.sensors.map((s) => [s.key, s]));
check(
  "the dump reads and renders per sensor, per range, with the date it was taken",
  calRead.pill === "209 bytes read" &&
    /6 records/.test(calRead.banner) &&
    byKey.lnAccel.id === 37 &&
    byKey.lnAccel.offset === "12,-30,4" &&
    byKey.lnAccel.sens === "1674,1670,1673" &&
    byKey.lnAccel.align === "-1,0,0,0,1,0,0,0,-1" &&
    /^calibrated 2026-06-11/.test(byKey.lnAccel.pill) &&
    /^as of 2026-06-11/.test(byKey.lnAccel.asOf) &&
    byKey.gyro.range === "3" &&
    /1000dps/.test(byKey.gyro.rangeLabel) &&
    byKey.mag.id === 42 &&
    /^calibrated 2026-04-02/.test(byKey.mag.pill),
  `${calRead.pill}; ln ${byKey.lnAccel.pill}; gyro at ${byKey.gyro.rangeLabel}`,
);
check(
  "sensitivity is three cells, not nine — the block stores a diagonal",
  calRead.sensors
    .filter((s) => s.state !== "unmodelled")
    .every(
      (s) => s.sens.split(",").length === 3 && s.align.split(",").length === 9,
    ),
  `sensitivity ${byKey.lnAccel.sens.split(",").length} cells, alignment ${byKey.lnAccel.align.split(",").length}`,
);
check(
  "the dump is paged at 128 bytes, the total taken from the first page",
  calRead.reads.length === 2 &&
    calRead.reads[0].len === 128 &&
    calRead.reads[0].off === 0 &&
    calRead.reads[1].off === 128 &&
    calRead.reads[1].len === 81,
  JSON.stringify(calRead.reads),
);
check(
  "the gyro's own values are the factory defaults, and the tab says so",
  byKey.gyro.state === "defaults" &&
    byKey.gyro.pill === "factory defaults" &&
    /firmware seeded this itself/.test(byKey.gyro.asOf) &&
    byKey.wrAccel.state === "defaults",
  `${byKey.gyro.pill} — ${byKey.gyro.asOf}`,
);

// ---- never calibrated is its own state, both flavours of it
check(
  "a sensor with no record at all reads as never calibrated, not as zeros",
  byKey.altAccel.state === "never" &&
    byKey.altAccel.pill === "never calibrated" &&
    byKey.altAccel.offset === ",," &&
    byKey.altAccel.asOf === "",
  `${byKey.altAccel.pill}, boxes "${byKey.altAccel.offset}"`,
);
check(
  "and so does a record whose block is all 0xFF — not 65535s",
  byKey.altMag.state === "never" &&
    byKey.altMag.pill === "never calibrated" &&
    byKey.altMag.sens === ",," &&
    !/65535/.test(byKey.altMag.sens),
  `${byKey.altMag.pill}, boxes "${byKey.altMag.sens}"`,
);
const calNever = await evaluate(`
  ${CAL}
  setRange('gyro', 0);
  await new Promise(r => setTimeout(r, 200));
  const at0 = { pill: pill('gyro'), state: card('gyro').dataset.calState,
    value: cells('gyro', 'sens'), placeholder: cell('gyro','sens',0).placeholder,
    note: card('gyro').querySelector('[data-cal-note]').textContent };
  setRange('gyro', 3);
  await new Promise(r => setTimeout(r, 200));
  return { at0, backAt3: cells('gyro', 'sens') };
`);
check(
  "a range with no record shows the defaults greyed and says nothing is stored",
  calNever.at0.state === "never" &&
    calNever.at0.value === ",," &&
    calNever.at0.placeholder === "229" &&
    /Nothing is stored for this sensor at this range/.test(calNever.at0.note) &&
    calNever.backAt3 === "29,29,29",
  `at ±125dps: "${calNever.at0.value}" with placeholder ${calNever.at0.placeholder}`,
);

// ---- the pressure sensor is present but not a kinematic set
check(
  "the pressure sensor is shown, disabled, with the reason — not hidden",
  byKey["id:43"] &&
    byKey["id:43"].avail === "disabled" &&
    byKey["id:43"].range === null &&
    /stored 2026-04-02/.test(byKey["id:43"].pill),
  byKey["id:43"] ? byKey["id:43"].pill : "(no pressure card)",
);

// ---- a value the format cannot hold: refused, and NOTHING goes on the wire
const calBad = await evaluate(`
  ${CAL}
  const before = window.mockTransport.writes.length;
  setCell('lnAccel', 'align', 0, '5');
  await new Promise(r => setTimeout(r, 200));
  const alignOnly = {
    error: card('lnAccel').querySelector('[data-cal-error]').textContent,
    header: role('changeNote').textContent,
  };
  setCell('lnAccel', 'offset', 1, '40000');
  await new Promise(r => setTimeout(r, 200));
  const state = {
    alignOnly,
    pill: pill('lnAccel'),
    cardState: card('lnAccel').dataset.calState,
    error: card('lnAccel').querySelector('[data-cal-error]').textContent,
    errorShown: !card('lnAccel').querySelector('[data-cal-error]').hidden,
    marked: cell('lnAccel','align',0).classList.contains('bad') &&
            cell('lnAccel','offset',1).classList.contains('bad'),
    untouchedClean: !cell('lnAccel','offset',0).classList.contains('bad'),
    writeDisabled: role('write').disabled,
    header: role('changeNote').textContent,
  };
  role('write').click();
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 800)));
  state.sent = window.mockTransport.writes.slice(before).map(w => w.bytes[0]);
  state.discarded = window.mockTransport.calib.discarded;
  return state;
`);
check(
  "an out-of-range alignment or offset is refused, Write is disabled, nothing is sent",
  calBad.cardState === "invalid" &&
    calBad.writeDisabled &&
    calBad.marked &&
    calBad.untouchedClean &&
    calBad.errorShown &&
    /-1\.28 to 1\.27 in steps of 0\.01/.test(calBad.alignOnly.error) &&
    /1 value the calibration format cannot hold/.test(
      calBad.alignOnly.header,
    ) &&
    /a whole number from -32768 to 32767/.test(calBad.error) &&
    /One other value also needs attention/.test(calBad.error) &&
    /2 values the calibration format cannot hold/.test(calBad.header) &&
    calBad.sent.length === 0 &&
    calBad.discarded === 0,
  `${calBad.error.slice(0, 80)}… — ${calBad.sent.length} commands sent`,
);
const calRound = await evaluate(`
  ${CAL}
  setCell('lnAccel', 'align', 0, '-1');
  setCell('lnAccel', 'offset', 1, '12.5');
  await new Promise(r => setTimeout(r, 150));
  const fractionalOffset = card('lnAccel').querySelector('[data-cal-error]').textContent;
  setCell('lnAccel', 'offset', 1, '-30');
  setCell('gyro', 'sens', 0, '29.005');
  await new Promise(r => setTimeout(r, 150));
  const finerThanTheScale = card('gyro').querySelector('[data-cal-error]').textContent;
  setCell('gyro', 'sens', 0, '29');
  await new Promise(r => setTimeout(r, 150));
  return { fractionalOffset, finerThanTheScale,
    clean: role('changeNote').textContent, writeDisabled: role('write').disabled };
`);
check(
  "a value the encoder would round or truncate is refused too, not silently changed",
  /must be a whole number/.test(calRound.fractionalOffset) &&
    /must be a multiple of 0\.01/.test(calRound.finerThanTheScale) &&
    calRound.clean === "No changes since the dump was read." &&
    calRound.writeDisabled,
  `${calRound.fractionalOffset.slice(0, 46)}… / ${calRound.finerThanTheScale.slice(0, 46)}…`,
);

// ---- a real edit: the exact bytes on the wire, then read back and compared
const calWrite = await evaluate(`
  ${CAL}
  const sdk = await import('/vendor/shimmer-web-sdk.esm.js');
  setCell('lnAccel', 'offset', 0, '25');
  await new Promise(r => setTimeout(r, 200));
  const dirtyCard = card('lnAccel').dataset.calDirty;
  const dirtyPill = pill('lnAccel');
  const from = window.mockTransport.writes.length;
  role('write').click();
  await new Promise(r => setTimeout(r, 3000));
  const sent = sentDump(from);
  const rec = sdk.parseCalibDump(sent.bytes).records
    .find(r => r.sensorId === 37 && r.range === 0);
  const expected = sdk.generateKinematicCalibBlock(
    [25, -30, 4], [1674, 1670, 1673], [-1, 0, 0, 0, 1, 0, 0, 0, -1],
    { sensitivityScale: 1 });
  const untouched = sdk.parseCalibDump(sent.bytes).records
    .find(r => r.sensorId === 38);
  const gyroDefault = sdk.getDefaultCalibration('shimmer3r', 'gyro', 3);
  return {
    dirtyCard, dirtyPill,
    confirm: window.__confirm,
    sizes: sent.sizes, offsets: sent.offsets,
    onWire: Array.from(rec.calibBytes).join(','),
    expected: Array.from(expected).join(','),
    gyroUntouched: Array.from(untouched.calibBytes).join(',') ===
      Array.from(sdk.generateKinematicCalibBlock(gyroDefault.calibration.offset,
        gyroDefault.calibration.sensitivity, gyroDefault.calibration.alignment,
        { sensitivityScale: 100 })).join(','),
    upd: window.mockTransport.calib.updates,
    discarded: window.mockTransport.calib.discarded,
    deviceHasIt: Array.from(window.mockTransport.calib.bytes()).join(',') ===
      Array.from(sent.bytes).join(','),
    afterPill: pill('lnAccel'),
    afterBoxes: cells('lnAccel', 'offset'),
    afterHeader: role('changeNote').textContent,
    log: [...document.querySelectorAll('#log .log-line')].map(l => l.textContent)
      .filter(l => /calibration/i.test(l)).slice(-3),
  };
`);
check(
  "an edit writes exactly the bytes the block encodes to, and only that record moves",
  calWrite.onWire === calWrite.expected &&
    calWrite.onWire ===
      "0,25,255,226,0,4,6,138,6,134,6,137,156,0,0,0,100,0,0,0,156" &&
    calWrite.gyroUntouched,
  `on the wire ${calWrite.onWire}`,
);
check(
  "the write starts at offset 0 and runs forward, then asks the firmware to apply it",
  calWrite.offsets[0] === 0 &&
    calWrite.offsets.every(
      (o, i) =>
        i === 0 || o === calWrite.offsets[i - 1] + calWrite.sizes[i - 1],
    ) &&
    calWrite.sizes.reduce((a, b) => a + b, 0) === 209 &&
    calWrite.upd === 1 &&
    calWrite.discarded === 0,
  `${calWrite.sizes.join("+")} bytes at offsets ${calWrite.offsets.join(", ")}`,
);
check(
  "the confirmation names the store and shows the value that moves",
  /CALIBRATION DUMP/.test(calWrite.confirm) &&
    /Low-noise accelerometer \(LSM6DSV\) at ± 2g/.test(calWrite.confirm) &&
    /was\s+offset \[12, -30, 4\]/.test(calWrite.confirm) &&
    /now\s+offset \[25, -30, 4\]/.test(calWrite.confirm) &&
    /rebuild the dump from the configuration bytes/.test(calWrite.confirm),
  calWrite.confirm
    .split("\n")
    .find((l) => /was\s+offset/.test(l))
    ?.trim(),
);
check(
  "the write is read back and byte-compared, and the tab settles on what came back",
  calWrite.deviceHasIt &&
    calWrite.afterBoxes === "25,-30,4" &&
    calWrite.afterHeader === "No changes since the dump was read." &&
    calWrite.log.some((l) => /read back byte-identical/.test(l)) &&
    calWrite.dirtyCard === "true" &&
    calWrite.dirtyPill === "edited, not written",
  calWrite.log[calWrite.log.length - 1],
);

// ---- restore defaults is the SDK's own block, byte for byte
const calDefaults = await evaluate(`
  ${CAL}
  const sdk = await import('/vendor/shimmer-web-sdk.esm.js');
  card('lnAccel').querySelector('[data-cal-defaults]').click();
  await new Promise(r => setTimeout(r, 200));
  const filled = cells('lnAccel', 'offset') + ' | ' + cells('lnAccel', 'sens');
  const from = window.mockTransport.writes.length;
  role('write').click();
  await new Promise(r => setTimeout(r, 3000));
  const rec = sdk.parseCalibDump(sentDump(from).bytes).records
    .find(r => r.sensorId === 37 && r.range === 0);
  const d = sdk.getDefaultCalibration('shimmer3r', 'lnAccel', 0);
  const exp = sdk.generateKinematicCalibBlock(d.calibration.offset,
    d.calibration.sensitivity, d.calibration.alignment,
    { sensitivityScale: d.sensitivityScale });
  return { filled, onWire: Array.from(rec.calibBytes).join(','),
    expected: Array.from(exp).join(','),
    pill: pill('lnAccel'), state: card('lnAccel').dataset.calState };
`);
check(
  "restore defaults produces the SDK's default block byte for byte, and says so",
  calDefaults.onWire === calDefaults.expected &&
    calDefaults.filled === "0,0,0 | 1672,1672,1672" &&
    calDefaults.state === "defaults" &&
    calDefaults.pill === "factory defaults",
  `${calDefaults.filled} → ${calDefaults.pill}`,
);

// ---- save and load the raw dump, as the retired card did
const calFile = await evaluate(`
  ${CAL}
  window.__blobs = [];
  role('save').click();
  await new Promise(r => setTimeout(r, 300));
  const saved = new Uint8Array(await window.__blobs.at(-1).arrayBuffer());
  /* Load it back through the panel's own entry point, which is what the file
     picker calls once the bytes are read. Byte 23 is the first record's
     offset-x low byte: 2 length + 8 version + 4 record header + 8 timestamp,
     then the block. */
  const edited = Uint8Array.from(saved);
  edited[23] = 0x63;
  const ok = window.calibrationEditor.load(edited);
  await new Promise(r => setTimeout(r, 300));
  return { savedLen: saved.length, ok,
    pill: role('storePill').textContent,
    note: role('storeNote').textContent,
    offsets: cells('lnAccel', 'offset'),
    loadEnabled: !role('load').disabled };
`);
check(
  "the raw dump still saves and loads, and a loaded one says it came from a file",
  calFile.savedLen === 209 &&
    calFile.ok &&
    /loaded/.test(calFile.pill) &&
    /came from a file on this host/.test(calFile.note) &&
    calFile.offsets === "99,0,0" &&
    calFile.loadEnabled,
  `${calFile.savedLen} bytes saved; reloaded offset ${calFile.offsets}`,
);

// ---- the link is shared: calibration cannot race a stream or an SD transfer
const calContend = await evaluate(`
  ${CAL}
  role('read').click();
  await new Promise(r => setTimeout(r, 2000));
  document.querySelector('.tabs [data-tab=tabStream]').click();
  document.getElementById('btnStreamStart').click();
  await new Promise(r => setTimeout(r, 1200));
  const during = {
    tabDisabled: document.getElementById('tabBtnCal').disabled,
    banner: document.getElementById('calBanner').textContent,
    readDisabled: role('read').disabled,
    writeDisabled: role('write').disabled,
    inputDisabled: cell('lnAccel', 'offset', 0).disabled,
  };
  const from = window.mockTransport.writes.length;
  /* Through the panel's own API, not the button: a disabled button proves
     the gate, this proves the panel refuses even when something reaches past
     it — and it is what produces the line in the log. */
  during.readAttempt = await window.calibrationEditor.read();
  during.writeAttempt = await window.calibrationEditor.write();
  during.sentWhileStreaming = window.mockTransport.writes.slice(from)
    .filter(w => [0x98, 0x9a, 0x9b].includes(w.bytes[0])).length;
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 120)));
  during.refusal = [...document.querySelectorAll('#log .log-line')].slice(-6)
    .map(l => l.textContent).find(l => /calibration cannot be reached/.test(l)) ?? '';
  document.getElementById('btnStreamStop').click();
  await new Promise(r => setTimeout(r, 1200));
  document.querySelector('.tabs [data-tab=tabCal]').click();
  return { during,
    after: { tabDisabled: document.getElementById('tabBtnCal').disabled,
             readDisabled: role('read').disabled,
             banner: document.getElementById('calBanner').textContent } };
`);
check(
  "a calibration read or write is refused while the sensor is streaming",
  calContend.during.tabDisabled &&
    calContend.during.readDisabled &&
    calContend.during.writeDisabled &&
    calContend.during.inputDisabled &&
    /firmware refuses every configuration command while it is/.test(
      calContend.during.banner,
    ) &&
    calContend.during.readAttempt === null &&
    calContend.during.writeAttempt === false &&
    calContend.during.sentWhileStreaming === 0 &&
    /calibration cannot be reached/.test(calContend.during.refusal),
  `${calContend.during.sentWhileStreaming} calibration commands sent while streaming`,
);
check(
  "and offered again the moment the stream stops",
  !calContend.after.tabDisabled &&
    !calContend.after.readDisabled &&
    calContend.after.banner === "",
  `tab ${calContend.after.tabDisabled ? "still closed" : "open"} after stop`,
);

const calVsSd = await evaluate(
  MEMFS +
    `
  ${CAL}
  document.querySelector('.tabs [data-tab="tabSd"]').click();
  await window.sdBrowser.refresh();
  await window.__useFs('CalibContendDest');
  const run = window.sdBrowser.download(['data'], { deleteVerified: false });
  const label = window.__sdRole('progress');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (/^download: /.test(label.textContent)) break;
  }
  const from = window.mockTransport.writes.length;
  const during = {
    tabDisabled: document.getElementById('tabBtnCal').disabled,
    banner: document.getElementById('calBanner').textContent,
    readDisabled: role('read').disabled,
    readAttempt: await window.calibrationEditor.read(),
    writeAttempt: await window.calibrationEditor.write(),
  };
  during.sentDuringTransfer = window.mockTransport.writes.slice(from)
    .filter(w => [0x98, 0x9a, 0x9b].includes(w.bytes[0])).length;
  window.sdBrowser.abort();
  await run.catch(() => {});
  await new Promise(r => setTimeout(r, 600));
  during.afterTab = document.getElementById('tabBtnCal').disabled;
  return during;
`,
);
check(
  "and refused while an SD transfer is holding the link",
  calVsSd.tabDisabled &&
    calVsSd.readDisabled &&
    calVsSd.readAttempt === null &&
    calVsSd.writeAttempt === false &&
    /SD card transfer is using the link/.test(calVsSd.banner) &&
    calVsSd.sentDuringTransfer === 0 &&
    !calVsSd.afterTab,
  `${calVsSd.sentDuringTransfer} calibration commands sent during the transfer`,
);

// ===========================================================================
// Calibration on a Shimmer3, which has neither of the alternate sensors.
// ===========================================================================
console.log("\n--- calibration: a Shimmer3 ---");
await goto(`${BASE}?mock=1&hw=3`);
check("connect to a Shimmer3", (await evaluate(CONNECT)) === "mock");
const calS3 = await evaluate(`
  ${CAL}
  document.querySelector('.tabs [data-tab=tabCal]').click();
  role('read').click();
  await new Promise(r => setTimeout(r, 2500));
  return {
    hw: document.getElementById('idHw').textContent,
    sensors: [...P().querySelectorAll('[data-cal-sensor]')].map(c => ({
      key: c.dataset.calSensor, id: Number(c.dataset.calSensorId),
      chip: c.querySelector('.cal-chip').textContent,
      state: c.dataset.calState,
      range: c.querySelector('[data-cal-range] option:checked')?.textContent ?? null,
      sens: cells(c.dataset.calSensor, 'sens'),
    })),
    records: role('storeBanner').textContent,
  };
`);
const s3keys = calS3.sensors.map((s) => s.key);
check(
  "a Shimmer3 hides the high-g accel and the alternate magnetometer it does not have",
  /^Shimmer3 \(hardware id 3\)$/.test(calS3.hw) &&
    !s3keys.includes("altAccel") &&
    !s3keys.includes("altMag") &&
    s3keys.join(",") === "lnAccel,gyro,wrAccel,mag,id:36",
  `cards: ${s3keys.join(", ")}`,
);
check(
  "and names the Shimmer3's own chips and sensor ids, not the Shimmer3R's",
  calS3.sensors.find((s) => s.key === "lnAccel").id === 2 &&
    calS3.sensors.find((s) => s.key === "gyro").id === 30 &&
    calS3.sensors.find((s) => s.key === "wrAccel").id === 31 &&
    calS3.sensors.find((s) => s.key === "mag").id === 32 &&
    calS3.sensors.find((s) => s.key === "mag").chip === "LSM303DLHC" &&
    calS3.sensors.find((s) => s.key === "mag").sens === "1104,1098,981",
  calS3.sensors.map((s) => `${s.key}=${s.id}`).join(" "),
);
check(
  "the Shimmer3 gyro's ±2000dps default parses through its ×100 sensitivity scale",
  calS3.sensors.find((s) => s.key === "gyro").sens === "16.4,16.4,16.4" &&
    /2000dps/.test(calS3.sensors.find((s) => s.key === "gyro").range),
  calS3.sensors.find((s) => s.key === "gyro").sens,
);

// ===========================================================================
// Calibration on a sensor that will not say what it is.
// ===========================================================================
console.log("\n--- calibration: an unidentified sensor ---");
await goto(`${BASE}?mock=1&hw=none`);
check(
  "connect to a sensor that refuses GET_DEVICE_VERSION",
  (await evaluate(CONNECT)) === "mock",
);
const calUnknown = await evaluate(`
  ${CAL}
  document.querySelector('.tabs [data-tab=tabCal]').click();
  const before = {
    unknownCard: !!P().querySelector('[data-cal-role=unknownHardware]'),
    text: P().querySelector('[data-cal-role=unknownHardware]')?.textContent ?? '',
    sensors: P().querySelectorAll('[data-cal-sensor]').length,
  };
  role('read').click();
  await new Promise(r => setTimeout(r, 2500));
  return { before, after: {
    unknownCard: !!P().querySelector('[data-cal-role=unknownHardware]'),
    sensors: [...P().querySelectorAll('[data-cal-sensor]')].map(c => c.dataset.calSensor),
    lnAccel: cells('lnAccel', 'sens'),
  } };
`);
check(
  "an unidentified sensor shows no sensor cards until the dump names its hardware",
  calUnknown.before.unknownCard &&
    calUnknown.before.sensors === 0 &&
    /has not said what hardware it is/.test(calUnknown.before.text) &&
    !calUnknown.after.unknownCard &&
    calUnknown.after.sensors.length === 7 &&
    calUnknown.after.lnAccel === "1674,1670,1673",
  `${calUnknown.before.sensors} cards before the read, ${calUnknown.after.sensors.length} after`,
);

// ---- the capability key, and which links actually have the dump commands
const calCaps = await evaluate(`
  const m = await import('/common/shimmer3-config-schema.js');
  const sdk = await import('/vendor/shimmer-web-sdk.esm.js');
  const full = { readCalibDump(){}, writeCalibDump(){}, updateCalibDump(){} };
  const wired = new sdk.WiredShimmerClient({ transport: new sdk.LoopbackTransport() });
  const radio = new sdk.Shimmer3RClient({ debug: false });
  return {
    full: m.describeShimmer3Caps(full, 'ble').calibration,
    readOnly: m.describeShimmer3Caps({ readCalibDump(){} }, 'ble').calibration,
    noUpdate: m.describeShimmer3Caps(
      { readCalibDump(){}, writeCalibDump(){} }, 'ble').calibration,
    none: m.describeShimmer3Caps({}, 'ble').calibration,
    /* Not link-gated: the same stub answers the same on every link, and it
       is the real clients that differ. */
    overUsb: m.describeShimmer3Caps(full, 'usb').calibration,
    realRadio: m.describeShimmer3Caps(radio, 'ble').calibration,
    realDock: m.describeShimmer3Caps(wired, 'usb').calibration,
    dockInfomem: m.describeShimmer3Caps(wired, 'usb').infomem,
  };
`);
check(
  "the calibration capability needs read and write, not the separate apply step",
  calCaps.full === true &&
    calCaps.overUsb === true &&
    calCaps.readOnly === false &&
    /* writeCalibDump issues UPD_CALIB_DUMP itself, so a bundle that does not
       expose the apply step as its own method still has a working editor. */
    calCaps.noUpdate === true &&
    calCaps.none === false &&
    calCaps.realRadio === true &&
    calCaps.realDock === false &&
    calCaps.dockInfomem === true,
  JSON.stringify(calCaps),
);

// ===========================================================================
// Calibration on a link with no calibration-dump commands, where the tab
// falls back to the six InfoMem blocks — read-only, and saying so.
// ===========================================================================
console.log("\n--- calibration: the InfoMem fallback ---");
await goto(`${BASE}?mock=1`);
check("connect for the fallback pass", (await evaluate(CONNECT)) === "mock");
const calFallback = await evaluate(`
  ${CAL}
  /* Shadow the dump commands on the connected client — prototype methods, so
     an own-property set to undefined is what hides them. This is exactly what the
     dock link and the classic Shimmer3Client present: an InfoMem they can
     read and no calibration-dump commands at all. */
  const c = window.calibrationEditor;
  window.mockClient.readCalibDump = undefined;
  window.mockClient.writeCalibDump = undefined;
  window.mockClient.updateCalibDump = undefined;
  document.querySelector('.tabs [data-tab=tabCal]').click();
  const before = window.mockTransport.writes.length;
  const read = await c.read();
  await new Promise(r => setTimeout(r, 800));
  const out = {
    store: c.store(),
    read: !!read,
    banner: role('storeBanner').textContent,
    bannerKind: role('storeBanner').className,
    writeDisabled: role('write').disabled,
    loadDisabled: role('load').disabled,
    inputsReadOnly: [...P().querySelectorAll('input.cal-cell')].every(i => i.readOnly),
    availability: card('lnAccel').dataset.calAvailability,
    writeAttempt: await c.write(),
    calibCmds: window.mockTransport.writes.slice(before)
      .filter(w => [0x98, 0x9a, 0x9b].includes(w.bytes[0])).length,
  };
  /* The log paints on an animation frame, so its newest lines are a frame
     behind the call that produced them. */
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 120)));
  out.refusal = [...document.querySelectorAll('#log .log-line')].slice(-6)
    .map(l => l.textContent)
    .find(l => /does not write the configuration image/.test(l)) ?? '';
  return out;
`);
check(
  "a link with no dump commands falls back to the InfoMem blocks, read-only and labelled",
  calFallback.store === "infomem" &&
    calFallback.read === true &&
    /CONFIGURATION IMAGE \(InfoMem\)/.test(calFallback.banner) &&
    /shown read-only/.test(calFallback.banner) &&
    calFallback.bannerKind === "banner warn" &&
    calFallback.inputsReadOnly &&
    calFallback.availability === "readonly" &&
    calFallback.writeDisabled &&
    calFallback.loadDisabled &&
    calFallback.writeAttempt === false &&
    calFallback.calibCmds === 0 &&
    /does not write the configuration image/.test(calFallback.refusal),
  `${calFallback.store}; ${calFallback.banner.slice(0, 80)}…`,
);

// ===========================================================================
// 2c. The raw byte tap against a 1024 Hz sensor: byte-exact on control
// traffic, silent on data packets until asked, and capped either way.
// ===========================================================================
console.log("\n--- raw byte tap ---");
await goto(`${BASE}?mock=1&rate=1024`);
const tapBytes = await evaluate(`
  const chk = document.getElementById('chkRawBytes');
  chk.checked = true; chk.dispatchEvent(new Event('change'));
  document.getElementById('btnMock').click();
  for (let i = 0; i < 80 && !document.getElementById('rateHelper'); i++)
    await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 500));
  const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join(' ');
  const strip = sel => [...document.querySelectorAll(sel)]
    .map(l => l.textContent.replace(/^\\S+ \\S+ /, ''));
  const tx = strip('#log .log-line.sev-tx');
  const rx = strip('#log .log-line.sev-rx');
  return {
    writes: window.mockTransport.writes.map(w => 'TX ' + hex(w.bytes)),
    tx, rxCount: rx.length, firstRx: rx[0], lastTx: tx.at(-1),
    // Nothing the page says about the tap should itself land in the filter.
    strays: tx.concat(rx).filter(l => !/^(TX|RX) [0-9a-f]/.test(l)),
  };
`);
check(
  "with the tap on, every command the mock received appears as a TX line, byte for byte",
  tapBytes.tx.length === tapBytes.writes.length &&
    tapBytes.tx.length > 8 &&
    tapBytes.tx.join("|") === tapBytes.writes.join("|") &&
    tapBytes.strays.length === 0,
  `${tapBytes.tx.length} writes, last ${tapBytes.lastTx}`,
);
check(
  "and every reply the mock sent appears as an RX line",
  tapBytes.rxCount >= tapBytes.tx.length - 1 &&
    /^RX ff /.test(tapBytes.firstRx),
  `${tapBytes.rxCount} RX lines, first ${tapBytes.firstRx}`,
);

const tapStream = await evaluate(`
  document.getElementById('btnLogClear').click();
  const t0 = performance.now();
  document.getElementById('btnStreamStart').click();
  await new Promise(r => setTimeout(r, 2500));
  document.getElementById('btnStreamStop').click();
  await new Promise(r => setTimeout(r, 600));
  const lines = [...document.querySelectorAll('#log .log-line')].map(l => l.textContent);
  const excluded = {
    frames: lines.filter(l => /RX 00 /.test(l)).length,
    summaries: lines.filter(l => /data packets not shown/.test(l)),
    total: lines.length,
  };
  // Opt in and do it again.
  document.getElementById('btnLogClear').click();
  const d = document.getElementById('chkRawData');
  d.checked = true; d.dispatchEvent(new Event('change'));
  document.getElementById('btnStreamStart').click();
  await new Promise(r => setTimeout(r, 2500));
  document.getElementById('btnStreamStop').click();
  await new Promise(r => setTimeout(r, 600));
  const lines2 = [...document.querySelectorAll('#log .log-line')].map(l => l.textContent);
  const included = {
    frames: lines2.filter(l => /RX 00 /.test(l)).length,
    capped: lines2.filter(l => /capped/.test(l)).length,
    sample: lines2.find(l => /RX 00 /.test(l)) ?? '',
  };
  // Still painting frames: rAF has to come back, and a tab click has to work.
  const rafStart = performance.now();
  await new Promise(r => requestAnimationFrame(r));
  const rafMs = performance.now() - rafStart;
  document.querySelector('.tabs [data-tab=tabSd]').click();
  return { excluded, included, rafMs, elapsed: performance.now() - t0,
    tab: document.querySelector('.tabs [aria-selected=true]').dataset.tab,
    rate: document.getElementById('ratePill').textContent };
`);
check(
  "a 1024 Hz stream logs no data packets by default, and says how many it held back",
  tapStream.rate === "1024 Hz" &&
    tapStream.excluded.frames === 0 &&
    tapStream.excluded.summaries.length >= 2 &&
    tapStream.excluded.summaries.every((l) =>
      /RX — \d+ data packets not shown/.test(l),
    ) &&
    Number(tapStream.excluded.summaries[1].match(/(\d+) data/)[1]) > 500,
  tapStream.excluded.summaries[1] ?? "(none)",
);
check(
  "opting in shows them, capped so a 1000-a-second burst cannot run away with the page",
  tapStream.included.frames > 100 &&
    tapStream.included.frames < 700 &&
    tapStream.included.capped >= 2 &&
    /^\S+ \S+ RX 00 /.test(tapStream.included.sample),
  `${tapStream.included.frames} frames shown over ~3 s, ${tapStream.included.capped} cap notices`,
);
check(
  "and the page is still responsive with the tap wide open",
  tapStream.rafMs < 200 && tapStream.tab === "tabSd",
  `rAF ${tapStream.rafMs.toFixed(0)} ms, tab click landed on ${tapStream.tab}`,
);

// ===========================================================================
// 3. The device identity panel: beside the Sensor link card, on every tab,
// above the fold, and stacked rather than squeezed on a phone.
// ===========================================================================
console.log("\n--- device identity panel ---");
const laptop = {
  width: 1366,
  height: 700,
  deviceScaleFactor: 1,
  mobile: false,
};
await send("Emulation.setDeviceMetricsOverride", laptop);
// testMs shortens the mock's per-step dwell so the narrow-screen half of this
// section can print a whole self-test report in a couple of seconds.
await goto(`${BASE}?mock=1&testMs=20`);
check("connect on a laptop viewport", (await evaluate(CONNECT)) === "mock");

const panel = await evaluate(`
  const r = el => el.getBoundingClientRect();
  const link = document.getElementById('btnBle').closest('.card');
  const dev = document.getElementById('devicePanel');
  const tabs = document.querySelector('.tabs');
  const perTab = {};
  for (const b of document.querySelectorAll('.tabs [data-tab]')) {
    if (b.disabled) continue;
    b.click();
    await new Promise(r => requestAnimationFrame(r));
    const box = r(dev);
    perTab[b.dataset.tab] = {
      visible: dev.offsetParent !== null && box.width > 0 && box.height > 0,
      name: document.getElementById('idName').textContent,
      flags: dev.querySelectorAll('#statusFlags .flag').length,
      batt: document.getElementById('idBatt').textContent,
    };
  }
  document.querySelector('.tabs [data-tab=tabConfig]').click();
  return {
    perTab,
    sideBySide: r(dev).left > r(link).right - 2 &&
      Math.abs(r(dev).top - r(link).top) < 4,
    tabsBottom: r(tabs).bottom,
    viewport: window.innerHeight,
    // The clock kept its own card on the Configure tab; the battery is now
    // one reading in one place rather than two of the same number.
    clockCard: [...document.querySelectorAll('#tabConfig .card-title')]
      .map(t => t.textContent.trim()),
    battDetailGone: !document.getElementById('battDetail'),
    refreshInPanel: !!dev.querySelector('#btnRefreshDevice'),
  };
`);
const tabIds = Object.keys(panel.perTab);
check(
  "the identity panel sits beside the Sensor link card and stays put on every tab",
  panel.sideBySide &&
    // Six since the Test tab joined Configure, Calibration, Stream, SD card
    // and Naming. Counted rather than named on purpose: a tab that goes
    // missing is as much a regression as one that paints wrong.
    tabIds.length === 6 &&
    tabIds.every((t) => panel.perTab[t].visible) &&
    tabIds.every((t) => panel.perTab[t].name.includes("Shimmer3R")) &&
    tabIds.every((t) => panel.perTab[t].flags === 9) &&
    /V \(.*%\) — charger/.test(panel.perTab.tabSd.batt),
  `${tabIds.join(", ")} — ${panel.perTab.tabSd.batt}`,
);
check(
  "and it does not push the tab strip below the fold on a laptop",
  // 424px is where the tab strip sat before this panel existed, measured on
  // the same viewport against the previous commit — so the budget is "no
  // lower than the identity list it replaced", not an arbitrary line.
  panel.tabsBottom < panel.viewport &&
    panel.tabsBottom <= 430 &&
    panel.refreshInPanel &&
    panel.battDetailGone &&
    panel.clockCard[1] === "Clock",
  `tab strip ends at ${Math.round(panel.tabsBottom)}px of ${panel.viewport}px`,
);

await send("Emulation.setDeviceMetricsOverride", {
  width: 375,
  height: 812,
  deviceScaleFactor: 1,
  mobile: false,
});
const narrow = await evaluate(`
  const r = el => el.getBoundingClientRect();
  const link = document.getElementById('btnBle').closest('.card');
  const dev = document.getElementById('devicePanel');
  const overflow = {};
  for (const b of document.querySelectorAll('.tabs [data-tab]')) {
    if (b.disabled) continue;
    b.click();
    await new Promise(r => requestAnimationFrame(r));
    overflow[b.dataset.tab] =
      document.documentElement.scrollWidth - document.documentElement.clientWidth;
  }
  document.querySelector('.tabs [data-tab=tabConfig]').click();
  await new Promise(r => requestAnimationFrame(r));
  return { overflow,
    stacked: r(dev).top >= r(link).bottom - 1 && Math.abs(r(dev).left - r(link).left) < 2,
    devWidth: r(dev).width, linkWidth: r(link).width,
    bodyScrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth };
`);
check(
  "at 375px the panel stacks under the link card instead of squeezing beside it",
  narrow.stacked && Math.abs(narrow.devWidth - narrow.linkWidth) < 2,
  `${Math.round(narrow.devWidth)}px wide, top of panel below the link card`,
);
check(
  "and no tab gives the page a horizontal scrollbar at 375px",
  Object.values(narrow.overflow).every((n) => n <= 0),
  `scrollWidth ${narrow.bodyScrollWidth} vs clientWidth ${narrow.clientWidth}; ` +
    JSON.stringify(narrow.overflow),
);

/* The sweep above measures every tab EMPTY. The Test tab is the one that
   fills with content wider than the screen — an 80-column fixed-pitch report
   the firmware prints, and a canvas — so it is measured again with a report
   actually on it. A report that scrolls its own box sideways is a nuisance;
   one that scrolls the whole page is a bug, and they look the same until you
   check which element overflowed. */
const narrowTest = await evaluate(`
  ${TEST}
  document.querySelector('.tabs [data-tab=tabTest]').click();
  role('run').click();
  for (let i = 0; i < 200 && window.factoryTestPanel.running(); i++)
    await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 250));
  return {
    reportChars: role('report').textContent.length,
    bodyOverflow:
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reportScrolls: role('report').scrollWidth <= role('report').clientWidth + 1,
    plotWidth: D().querySelector('canvas').getBoundingClientRect().width,
  };
`);
check(
  "a printed report wraps at 375px rather than scrolling the page sideways",
  narrowTest.reportChars > 1500 &&
    narrowTest.reportScrolls &&
    narrowTest.bodyOverflow <= 0,
  `${narrowTest.reportChars} chars, page overflow ${narrowTest.bodyOverflow}px`,
);
check(
  "and the drift plot fits the viewport it is drawn into",
  narrowTest.plotWidth > 0 && narrowTest.plotWidth <= 375,
  `${Math.round(narrowTest.plotWidth)}px of 375px`,
);

await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

// ===========================================================================
// 4. The status flags: where they come from, and whether the panel says so.
//
// Read once at connect and once per Refresh press is not enough — the flags
// have three sources now (a read, a push from the firmware, and the page's own
// last command) and the panel has to distinguish them.
// ===========================================================================
console.log("\n--- device status flags ---");
await send("Emulation.setDeviceMetricsOverride", laptop);
await goto(`${BASE}?mock=1`);
check("connect for the status-flag pass", (await evaluate(CONNECT)) === "mock");

/* One reader for the whole section: the flags with their state and whether
   each is marked as inferred, plus the freshness badge and where the tab strip
   ends — the panel is the taller column above the tabs, so a freshness
   indication that cost a line would show up here. */
const FLAGS = `
  const snap = () => {
    const fresh = document.getElementById('statusFresh');
    const flag = label => [...document.querySelectorAll('#statusFlags .flag')]
      .find(s => s.textContent.replace(/ \\*$/, '') === label);
    return {
      count: document.querySelectorAll('#statusFlags .flag').length,
      on: label => !!flag(label)?.classList.contains('on'),
      starred: label => / \\*$/.test(flag(label)?.textContent ?? ''),
      marks: [...document.querySelectorAll('#statusFlags .flag.inferred')]
        .map(s => s.textContent),
      badge: fresh.hidden ? null : fresh.textContent,
      why: fresh.title,
      unread: fresh.classList.contains('unread'),
      tabsBottom: Math.round(document.querySelector('.tabs').getBoundingClientRect().bottom),
    };
  };
  const state = () => { const s = snap(); return {
    count: s.count, marks: s.marks, badge: s.badge, why: s.why,
    unread: s.unread, tabsBottom: s.tabsBottom,
    streaming: s.on('Streaming'), sensing: s.on('Sensing'),
    sdLogging: s.on('SD logging'), docked: s.on('Docked'),
    sdPresent: s.on('SD card present'),
    streamingStarred: s.starred('Streaming'),
    sdLoggingStarred: s.starred('SD logging'),
  }; };
`;

const read = await evaluate(`${FLAGS} return state();`);
check(
  "the flags read at connect are labelled as read, and the mock's own card shows through",
  read.badge !== null &&
    /^read \d\d:\d\d:\d\d$/.test(read.badge) &&
    !read.unread &&
    read.marks.length === 0 &&
    read.sdPresent &&
    !read.streaming &&
    read.count === 9,
  `${read.badge} — ${read.count} flags, ${read.marks.length} inferred`,
);

// ---- a start lights Streaming with no GET_STATUS on the wire at all
const started = await evaluate(`
  ${FLAGS}
  const from = window.mockTransport.writes.length;
  const lit = () => snap().on('Streaming');
  const t0 = performance.now();
  document.getElementById('btnStreamStart').click();
  for (let i = 0; i < 300 && !lit(); i++) await new Promise(r => setTimeout(r, 5));
  const s = state();
  s.ms = Math.round(performance.now() - t0);
  s.statusCmds = window.mockTransport.writes.slice(from)
    .filter(w => w.bytes[0] === 0x72).length;
  return s;
`);
check(
  "starting a stream lights Streaming without a status round trip, and marks it as inferred",
  started.streaming &&
    started.sensing &&
    !started.sdLogging &&
    started.statusCmds === 0 &&
    started.streamingStarred &&
    started.marks.length === 2 &&
    /^inferred \d\d:\d\d:\d\d$/.test(started.badge) &&
    started.unread &&
    /have not been read back/.test(started.why),
  `lit in ${started.ms}ms, ${started.statusCmds} GET_STATUS sent, marks: ${started.marks.join(", ")}`,
);
check(
  "and saying how fresh the flags are still costs the tab strip nothing",
  started.tabsBottom === read.tabsBottom && started.tabsBottom <= 430,
  `tab strip ends at ${started.tabsBottom}px, same as with the flags freshly read`,
);

// ---- and a stop clears it again
const stopped = await evaluate(`
  ${FLAGS}
  document.getElementById('btnStreamStop').click();
  await new Promise(r => setTimeout(r, 900));
  return state();
`);
check(
  "stopping clears Streaming, still marked as this page's word rather than the sensor's",
  !stopped.streaming &&
    !stopped.sensing &&
    stopped.streamingStarred &&
    stopped.unread &&
    /^inferred /.test(stopped.badge),
  `${stopped.badge} — marks: ${stopped.marks.join(", ")}`,
);

// ---- SD logging is its own flag, and only the SD start claims it
const sdStarted = await evaluate(`
  ${FLAGS}
  document.getElementById('btnSdStart').click();
  await new Promise(r => setTimeout(r, 900));
  const during = state();
  document.getElementById('btnSdStop').click();
  await new Promise(r => setTimeout(r, 900));
  return { during, after: state() };
`);
check(
  "starting stream + SD logging lights the SD logging flag too, and stopping clears it",
  sdStarted.during.sdLogging &&
    sdStarted.during.streaming &&
    sdStarted.during.sdLoggingStarred &&
    sdStarted.during.marks.length === 3 &&
    !sdStarted.after.sdLogging &&
    !sdStarted.after.streaming,
  `during: ${sdStarted.during.marks.join(", ")}`,
);

// ---- the next authoritative read replaces the guesses
const confirmed = await evaluate(`
  ${FLAGS}
  document.getElementById('btnRefreshDevice').click();
  await new Promise(r => setTimeout(r, 1200));
  return state();
`);
check(
  "a Refresh turns the inferred flags back into a reading and drops the marks",
  confirmed.marks.length === 0 &&
    !confirmed.unread &&
    /^read \d\d:\d\d:\d\d$/.test(confirmed.badge) &&
    !confirmed.streaming &&
    confirmed.sdPresent,
  confirmed.badge,
);

// ---- a read that does not answer must not pass the guesses off as readings
const unconfirmed = await evaluate(`
  ${FLAGS}
  /* Started and stopped first, so there are inferred marks to survive the
     failure — and Refresh is gated to an idle sensor, so the stop is also
     what makes the button clickable. */
  document.getElementById('btnStreamStart').click();
  await new Promise(r => setTimeout(r, 700));
  document.getElementById('btnStreamStop').click();
  await new Promise(r => setTimeout(r, 900));
  const before = state();
  const real = window.mockClient.getStatus.bind(window.mockClient);
  window.mockClient.getStatus = () => Promise.reject(new Error('Instream response 0x71 timeout'));
  document.getElementById('btnRefreshDevice').click();
  await new Promise(r => setTimeout(r, 1500));
  const s = state();
  s.before = before;
  window.mockClient.getStatus = real;
  document.getElementById('btnRefreshDevice').click();
  await new Promise(r => setTimeout(r, 1200));
  s.recovered = state().badge;
  return s;
`);
check(
  "a Refresh whose read does not answer keeps the values but stops calling them read",
  // The same badge it had, plus the admission — so the failed read did not
  // restamp the values as freshly known either.
  unconfirmed.badge === unconfirmed.before.badge + ", unconfirmed" &&
    unconfirmed.unread &&
    /did not answer/.test(unconfirmed.why) &&
    // Values it could not refresh are kept rather than wiped to "-", and the
    // marks stay: a failed confirmation must not silently promote a guess.
    unconfirmed.count === 9 &&
    unconfirmed.sdPresent &&
    unconfirmed.streamingStarred &&
    unconfirmed.marks.length === 2 &&
    /^read /.test(unconfirmed.recovered),
  `${unconfirmed.before.badge} → ${unconfirmed.badge} → ${unconfirmed.recovered} once the read answers again`,
);

// ---- and when it answers with something else, the sensor wins and says why
const disagreed = await evaluate(`
  ${FLAGS}
  document.getElementById('btnStreamStart').click();
  await new Promise(r => setTimeout(r, 700));
  const before = document.querySelectorAll('#log .log-line').length;
  /* The sensor insists it is still streaming — which is what an ACKed stop
     that did not take effect looks like from the host. */
  const real = window.mockClient.getStatus.bind(window.mockClient);
  window.mockClient.getStatus = async () => ({ ...(await real()), streaming: true, sensing: true });
  document.getElementById('btnStreamStop').click();
  await new Promise(r => setTimeout(r, 900));
  document.getElementById('btnRefreshDevice').click();
  await new Promise(r => setTimeout(r, 1200));
  const s = state();
  s.warned = [...document.querySelectorAll('#log .log-line')].slice(before)
    .map(l => l.textContent).filter(l => /did not take effect/.test(l));
  window.mockClient.getStatus = real;
  return s;
`);
check(
  "a read that contradicts what the page inferred wins, and the contradiction is logged",
  disagreed.streaming &&
    disagreed.marks.length === 0 &&
    /^read /.test(disagreed.badge) &&
    disagreed.warned.length === 2 &&
    disagreed.warned.some((l) => /streaming=true/.test(l)),
  disagreed.warned[0]?.slice(20, 120) ?? "(nothing logged)",
);

// ---- the firmware's own news: a dock and an undock, unasked for
const docked = await evaluate(`
  ${FLAGS}
  document.getElementById('btnRefreshDevice').click();
  await new Promise(r => setTimeout(r, 1200));
  const before = state();
  const from = window.mockTransport.writes.length;
  window.mockTransport.status.setDocked(true);
  await new Promise(r => setTimeout(r, 400));
  const onDock = state();
  onDock.hostSent = window.mockTransport.writes.slice(from).length;
  window.mockTransport.status.setDocked(false);
  await new Promise(r => setTimeout(r, 400));
  const onUndock = state();
  onUndock.pushed = [...document.querySelectorAll('#log .log-line')].slice(-8)
    .some(l => /the sensor pushed a status change/.test(l.textContent));
  return { before, onDock, onUndock };
`);
check(
  "an unsolicited status pushed while idle updates the panel with no command from the host",
  !docked.before.docked &&
    docked.onDock.docked &&
    !docked.onUndock.docked &&
    docked.onDock.hostSent === 0 &&
    docked.onDock.count === 9 &&
    docked.onUndock.pushed,
  `docked ${docked.before.docked} → ${docked.onDock.docked} → ${docked.onUndock.docked}, ` +
    `${docked.onDock.hostSent} commands sent`,
);
check(
  "and a pushed value is labelled as pushed, not as read and not as inferred",
  /^pushed \d\d:\d\d:\d\d$/.test(docked.onDock.badge) &&
    !docked.onDock.unread &&
    docked.onDock.marks.length === 0 &&
    /without being asked/.test(docked.onDock.why) &&
    /^read /.test(docked.before.badge),
  `${docked.before.badge} → ${docked.onDock.badge} → ${docked.onUndock.badge}`,
);

/* The push and the answer to GET_STATUS are the same message built by the same
   function — this is the assertion that they stayed that way. */
check(
  "the status the mock pushes is byte for byte the status it answers a read with",
  await evaluate(`
    const pushed = Array.from(window.mockTransport.status.bytes()).slice(2);
    const answered = Array.from((await window.mockClient.getStatus()).raw);
    return JSON.stringify(pushed) === JSON.stringify(answered);
  `),
);

/* And over a byte stream, where the push has to be re-framed out of 3-byte
   dribbles before the client can see it at all — the framer has to know the
   platform's status length to find the message boundary, and getting that
   wrong is what swallows the ACK behind it. */
await goto(`${BASE}?mock=1&framed=0`);
check(
  "connect over the unframed transport for the push",
  (await evaluate(CONNECT)) === "mock",
);
const dribbled = await evaluate(`
  ${FLAGS}
  const before = state();
  window.mockTransport.status.setDocked(true);
  await new Promise(r => setTimeout(r, 600));
  const onDock = state();
  /* A command straight after, to prove the re-framer consumed exactly the
     push and left the control channel usable. */
  onDock.stillTalks = (await window.mockClient.getStatus()).docked;
  return { before, onDock };
`);
check(
  "a push re-framed out of a 3-byte-at-a-time byte stream lands, and the link still works after it",
  !dribbled.before.docked &&
    dribbled.onDock.docked &&
    /^pushed /.test(dribbled.onDock.badge) &&
    dribbled.onDock.count === 9 &&
    dribbled.onDock.stillTalks === true,
  `${dribbled.before.badge} → ${dribbled.onDock.badge}`,
);
await goto(`${BASE}?mock=1`);
check(
  "reconnect framed for the teardown check",
  (await evaluate(CONNECT)) === "mock",
);

// ---- and a sensor the page has let go cannot paint the panel any more
const letGo = await evaluate(`
  ${FLAGS}
  const transport = window.mockTransport;
  document.getElementById('btnDisconnect').click();
  await new Promise(r => setTimeout(r, 900));
  const after = state();
  transport.status.setDocked(true);
  await new Promise(r => setTimeout(r, 400));
  return { after, still: state(),
    flagsText: document.getElementById('statusFlags').textContent };
`);
check(
  "letting the sensor go clears the flags, and a late push cannot repaint them",
  letGo.after.badge === null &&
    letGo.after.count === 0 &&
    letGo.flagsText === "–" &&
    letGo.still.count === 0 &&
    letGo.still.badge === null,
  `flags "${letGo.flagsText}", badge ${JSON.stringify(letGo.after.badge)}`,
);
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

// ===========================================================================
// 5. The event log as a drawer docked to the bottom of the viewport.
// ===========================================================================
console.log("\n--- event log drawer ---");
await goto(`${BASE}?mock=1`);
// Start from no remembered preference, which is the state a first visit is in.
await evaluate(
  `try { localStorage.removeItem('shimmerCaptureLogDrawer'); } catch {} return 1;`,
);
await goto(`${BASE}?mock=1`);

const shut = await evaluate(`
  const d = document.getElementById('logDrawer');
  const box = d.getBoundingClientRect();
  return { attr: document.documentElement.dataset.logOpen,
    expanded: document.getElementById('btnLogDrawer').getAttribute('aria-expanded'),
    bodyDisplay: getComputedStyle(document.getElementById('logDrawerBody')).display,
    height: box.height, bottom: box.bottom, left: box.left,
    width: box.width, viewportW: document.documentElement.clientWidth,
    viewportH: document.documentElement.clientHeight,
    // Reserved, not overlaid: the page's own foot padding covers the bar.
    pagePad: parseFloat(getComputedStyle(document.querySelector('.page')).paddingBottom),
    last: document.getElementById('logLast').textContent };
`);
check(
  "with nothing remembered the drawer starts collapsed, docked to the bottom edge",
  shut.attr === "false" &&
    shut.expanded === "false" &&
    shut.bodyDisplay === "none" &&
    shut.height > 25 &&
    shut.height < 45 &&
    Math.abs(shut.bottom - shut.viewportH) < 1 &&
    shut.left === 0 &&
    Math.abs(shut.width - shut.viewportW) < 1 &&
    shut.pagePad >= shut.height,
  `${Math.round(shut.height)}px bar, page reserves ${Math.round(shut.pagePad)}px`,
);

check(
  "connect with the drawer collapsed",
  (await evaluate(CONNECT)) === "mock",
);
const collapsed = await evaluate(`
  const alerts = () => document.querySelectorAll(
    '#log .log-line.sev-err, #log .log-line.sev-warn').length;
  const lines = [...document.querySelectorAll('#log .log-line')].map(l => l.textContent);
  const badge = document.getElementById('logBadge');
  const before = { badge: badge.textContent, hidden: badge.hidden, alerts: alerts(),
    last: document.getElementById('logLast').textContent,
    newest: lines.at(-1) };
  // Three warnings, one per call: disconnected, the panel has no client to
  // run the firmware's data-rate test against.
  document.getElementById('btnDisconnect').click();
  await new Promise(r => setTimeout(r, 400));
  const mid = alerts();
  for (let i = 0; i < 3; i++) await window.sdBrowser.measureLinkSpeed();
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 80)));
  return { before, mid, after: { badge: Number(document.getElementById('logBadge').textContent),
    hidden: document.getElementById('logBadge').hidden, alerts: alerts(),
    last: document.getElementById('logLast').textContent } };
`);
check(
  "collapsed it shows the newest line and badges the errors and warnings behind it",
  // The bar drops the date (same all session) and keeps the clock time.
  collapsed.before.newest.endsWith(collapsed.before.last) &&
    /^\d\d:\d\d:\d\d: /.test(collapsed.before.last) &&
    Number(collapsed.before.badge) === collapsed.before.alerts &&
    collapsed.before.hidden === false &&
    collapsed.after.alerts === collapsed.mid + 3 &&
    collapsed.after.badge === collapsed.after.alerts &&
    /data-rate test/.test(collapsed.after.last),
  `badge ${collapsed.before.badge} → ${collapsed.after.badge}, bar "${collapsed.after.last}"`,
);

const opened = await evaluate(`
  document.getElementById('btnLogDrawer').click();
  await new Promise(r => requestAnimationFrame(r));
  const d = document.getElementById('logDrawer');
  const panel = document.getElementById('log');
  const box = d.getBoundingClientRect();
  const bar = document.querySelector('#tabConfig .action-bar').getBoundingClientRect();
  const opened = { badge: document.getElementById('logBadge').hidden,
    expanded: document.getElementById('btnLogDrawer').getAttribute('aria-expanded'),
    height: box.height, width: box.width, viewportW: document.documentElement.clientWidth,
    logWidth: panel.getBoundingClientRect().width,
    // The log's own stick-to-the-tail, restored as the panel becomes visible.
    atTail: panel.scrollHeight - panel.scrollTop - panel.clientHeight < 4,
    scrollHeight: panel.scrollHeight,
    // Nothing is covered: the sticky action bar stops above the drawer.
    actionBarClear: bar.bottom <= box.top + 1,
    pagePad: parseFloat(getComputedStyle(document.querySelector('.page')).paddingBottom),
    everyControl: ['logFilter','logSeverity','chkRawBytes','chkRawData','btnLogClear','btnLogDownload','logCount']
      .filter(id => document.getElementById('logDrawerBody').contains(document.getElementById(id))).length };
  // While it is open the badge stays out of the way.
  await window.sdBrowser.measureLinkSpeed();
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 80)));
  opened.badgeStillHidden = document.getElementById('logBadge').hidden;
  return opened;
`);
check(
  "opening clears the badge, keeps the full page width and covers nothing",
  opened.badge === true &&
    opened.badgeStillHidden === true &&
    opened.expanded === "true" &&
    opened.height > 200 &&
    Math.abs(opened.width - opened.viewportW) < 1 &&
    opened.logWidth > opened.viewportW * 0.9 &&
    opened.atTail &&
    opened.scrollHeight > 400 &&
    opened.actionBarClear &&
    opened.pagePad >= opened.height &&
    opened.everyControl === 7,
  `${Math.round(opened.height)}px tall, log ${Math.round(opened.logWidth)} of ${opened.viewportW}px, all 7 controls kept`,
);

/* ---- and an alert that arrives while the drawer is OPEN but scrolled back
   through history still badges. An error nobody can see is an error nobody
   scrolled to, whether the drawer is shut or merely showing older lines —
   which is the whole reason the log moved to the bottom of the viewport. */
const badgeAway = await evaluate(`
  const panel = document.getElementById('log');
  const el = document.getElementById('logBadge');
  const badge = () => (el.hidden ? 0 : Number(el.textContent));
  const away = () => panel.scrollHeight - panel.scrollTop - panel.clientHeight >= 60;
  panel.scrollTop = 0;
  panel.dispatchEvent(new Event('scroll'));
  await new Promise(r => setTimeout(r, 100));
  const out = { open: document.documentElement.dataset.logOpen,
    scrolledAway: away(), before: badge() };
  // One warning: disconnected, the panel has no client to measure against.
  await window.sdBrowser.measureLinkSpeed();
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 120)));
  out.whileAway = badge();
  out.heldPosition = panel.scrollTop;
  out.stillAway = away();
  // Coming back to the newest line is as much an acknowledgement as opening.
  panel.scrollTop = panel.scrollHeight;
  panel.dispatchEvent(new Event('scroll'));
  await new Promise(r => setTimeout(r, 150));
  out.afterReturn = badge();
  return out;
`);
check(
  "an alert badges while the drawer is open but scrolled away, and clears on return",
  badgeAway.open === "true" &&
    badgeAway.scrolledAway &&
    badgeAway.before === 0 &&
    badgeAway.whileAway === 1 &&
    badgeAway.heldPosition === 0 &&
    badgeAway.stillAway &&
    badgeAway.afterReturn === 0,
  `badge ${badgeAway.before} → ${badgeAway.whileAway} → ${badgeAway.afterReturn}, ` +
    `scroll held at ${badgeAway.heldPosition}`,
);

await goto(`${BASE}?mock=1`);
const remembered = await evaluate(`
  const open = document.documentElement.dataset.logOpen;
  document.getElementById('btnLogDrawer').click();
  return { afterReload: open,
    stored: (() => { try { return localStorage.getItem('shimmerCaptureLogDrawer'); }
      catch { return 'unreadable'; } })() };
`);
await goto(`${BASE}?mock=1`);
const remembered2 = await evaluate(
  `return document.documentElement.dataset.logOpen;`,
);
check(
  "the drawer remembers open and closed across a reload",
  remembered.afterReload === "true" &&
    remembered.stored === "closed" &&
    remembered2 === "false",
  `reopened ${remembered.afterReload}, then reclosed → ${remembered2}`,
);

await send("Emulation.setDeviceMetricsOverride", {
  width: 375,
  height: 812,
  deviceScaleFactor: 1,
  mobile: false,
});
const sheet = await evaluate(`
  document.getElementById('btnLogDrawer').click();
  await new Promise(r => requestAnimationFrame(r));
  const box = document.getElementById('logDrawer').getBoundingClientRect();
  return { left: box.left, width: box.width, height: box.height,
    viewportW: document.documentElement.clientWidth,
    viewportH: document.documentElement.clientHeight,
    bottom: box.bottom,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
`);
check(
  "at 375px it stays a full-width bottom sheet and still scrolls nothing sideways",
  sheet.left === 0 &&
    Math.abs(sheet.width - sheet.viewportW) < 1 &&
    Math.abs(sheet.bottom - sheet.viewportH) < 1 &&
    sheet.height > sheet.viewportH * 0.5 &&
    sheet.overflow <= 0,
  `${Math.round(sheet.width)}x${Math.round(sheet.height)} on a ${sheet.viewportW}x${sheet.viewportH} screen`,
);
await evaluate(
  `try { localStorage.removeItem('shimmerCaptureLogDrawer'); } catch {} return 1;`,
);
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

// ===========================================================================
// A firmware below the SD-transfer gate. v1.01.009 and v1.01.010 serve the
// protocol and corrupt every block, so the tab has to refuse them by version
// — the same "permanent" branch the USB dock link takes.
// ===========================================================================
console.log("\n--- firmware below the SD-transfer gate ---");
await goto(`${BASE}?mock=1&fw=1.01.010`);
check("connect to a sensor on v1.01.010", (await evaluate(CONNECT)) === "mock");
const oldFw = await evaluate(`
  const btn = document.getElementById('tabBtnSd');
  return { fw: document.getElementById('idFw').textContent,
    tabDisabled: btn.disabled, title: btn.title,
    banner: document.getElementById('sdBanner').textContent,
    bannerKind: document.getElementById('sdBanner').className,
    selected: document.querySelector('.tabs [aria-selected="true"]').dataset.tab,
    streamTab: !document.getElementById('tabBtnStream').disabled,
    logs: [...document.querySelectorAll('#log .log-line')].map(l => l.textContent)
      .filter(l => /SD file transfer/.test(l)) };
`);
check(
  "v1.01.010 closes the SD tab and says which firmware version is needed",
  oldFw.fw === "LogAndStream v1.01.010" &&
    oldFw.tabDisabled &&
    /v1\.01\.011 or later/.test(oldFw.banner) &&
    /corrupt every block/.test(oldFw.banner) &&
    oldFw.bannerKind === "banner warn" &&
    oldFw.title === oldFw.banner &&
    oldFw.selected === "tabConfig" &&
    oldFw.streamTab &&
    oldFw.logs.length === 1,
  oldFw.banner.slice(0, 90) + "…",
);

// ===========================================================================
// Every panel competes for one link, so every panel's "why can't I" text has
// to know about every OTHER panel's busy flag. Each was written with the
// panels that existed at the time, so each new panel silently aged the ones
// written before it, and a control could grey out with nothing on screen.
// Source-level on purpose: driving four concurrent link holders through the
// UI is slow and flaky, and what needs pinning is that adding a holder
// teaches every panel about it.
// ===========================================================================
// The ExG preset path. Nothing here touched ExG until the 0.1.24 re-vendor
// turned a working apply into a refusal -- the new helpers READ the banks
// before writing where the old ones wrote blind, and the mock only served the
// write. The bytes are asserted, not just the call: three of them were wrong
// in the shipped bundle, and a preset that reaches the wire with the wrong
// PGA gain looks exactly like one that is right.
// ===========================================================================
// Device time is a PLAIN UNIX EPOCH: the page writes Date.now() and renders
// what comes back with the host's own formatter, so the timezone is applied
// exactly once, on the way to the screen. It used to be local civil time with
// the offset baked into the value, which had to be read back with the UTC
// accessors instead -- so a half-migrated page shifts it twice. Invisible in
// UTC, which is where a CI box and most benches sit, so the checks run under
// an emulated +09:00 where a double shift is nine hours wide.
// ===========================================================================
// The SDK is vendored twice on purpose -- the Chrome extension has to carry
// its own copy, because only that folder is packed for the store -- so the one
// thing that must never happen is a page loading BOTH. Two module instances
// means two class identities, and `client.connect()` does
// `if (t instanceof WebBluetoothTransport) this.device = t.device`, which then
// silently stops matching. That is how this check found the harness importing
// the extension's copy after the shared one moved to /vendor: nothing threw,
// one instanceof just went quiet.
// ===========================================================================
console.log("\n--- one shared SDK copy, not the extension's ---");
/* Checked over HTTP rather than on disk, so it tests what is actually served.
   Extend this list when a demo is added -- and when one leaves. The standalone
   drift page that used to sit here was folded into ShimmerCapture's Test tab
   and deleted; the two panels that came out of it are shared modules now, and
   they take its place in the list. */
const SDK_CONSUMERS = [
  "ShimmerCapture/index.html",
  "Verisense/index.html",
  "break-emg/index.html",
  "break-gyro/index.html",
  "brick/index.html",
  "punch-highG/index.html",
  "spell-gyro/index.html",
  "video-ppg/index.html",
  "common/brand-editor.js",
  "common/calibration-editor.js",
  "common/csv-recorder.js",
  "common/factory-test-panel.js",
  "common/rtc-drift-panel.js",
  "common/sd-browser.js",
  "common/stream-stats.js",
  "common/dev/mock-shimmer3r.js",
];
const ROOT = BASE.slice(0, BASE.indexOf("/ShimmerCapture/") + 1);
const reachingIntoExtension = [];
for (const f of SDK_CONSUMERS) {
  const text = await (await fetch(ROOT + f)).text();
  if (text.includes("shimmer-extension/vendor")) reachingIntoExtension.push(f);
}
check(
  "nothing outside the extension imports the extension's private SDK copy",
  reachingIntoExtension.length === 0,
  reachingIntoExtension.length
    ? reachingIntoExtension.join(", ")
    : `${SDK_CONSUMERS.length} files checked`,
);

/* And the extension keeps its own, which is the other half of the rule. */
const extensionCopy = await fetch(
  ROOT + "shimmer-extension/vendor/shimmer-web-sdk.esm.js",
);
const sharedCopy = await fetch(ROOT + "vendor/shimmer-web-sdk.esm.js");
/* Normalised, because this checkout has core.autocrlf=true and the two copies
   reach the working tree by different routes -- a rebase checks one out, the
   sync script writes the other. Git stores both blobs identically; only the
   bytes on disk differ, by exactly one per line. Comparing raw text here
   asserted the line-ending state of a developer's checkout, not the build. */
const norm = (t) =>
  t.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const extText = norm(await extensionCopy.text());
const shrText = norm(await sharedCopy.text());
check(
  "both copies are served and are the same build",
  extensionCopy.ok && sharedCopy.ok && extText === shrText,
  `extension ${extensionCopy.status}/${extText.length}B, shared ${sharedCopy.status}/${shrText.length}B (line endings normalised)`,
);

// ===========================================================================
console.log("\n--- device time is not shifted twice ---");
await send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Tokyo" });
await goto(`${BASE}?mock=1`);
check("connect under an emulated +09:00", (await evaluate(CONNECT)) === "mock");

const clocks = await evaluate(`
  document.getElementById('btnSetClock').click();
  await new Promise(r => setTimeout(r, 700));
  document.getElementById('btnRefreshDevice')?.click();
  await new Promise(r => setTimeout(r, 900));
  const rwc = document.getElementById('rwcValue').textContent;
  return {
    offsetMin: new Date().getTimezoneOffset(),
    rwc,
    host: document.getElementById('hostClock').textContent,
  };
`);

/* Both lines are "YYYY-MM-DD HH:MM:SS"; the RWC one carries a tick count
   after it. Compare to the minute: the two reads are a beat apart. */
const toMinute = (text) => (text ?? "").trim().slice(0, 16);
const rwcMinute = toMinute(clocks.rwc);
const hostMinute = toMinute(clocks.host);
/* Compared with a minute of tolerance, not as strings. The two values are
   read a beat apart, so a string compare fails whenever the clock happens to
   tick between them -- a flake that says "timezone bug" when there is none.
   The bug this is looking for is hours wide; a minute is noise. */
const asMinutes = (t) => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(t);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : NaN;
};
const driftMinutes = Math.abs(asMinutes(rwcMinute) - asMinutes(hostMinute));
check(
  "the browser really is nine hours off UTC for this check",
  clocks.offsetMin === -540,
  `getTimezoneOffset() = ${clocks.offsetMin}`,
);
check(
  "a clock set from the host reads back as the same wall clock, not offset by the timezone",
  rwcMinute.length === 16 && Number.isFinite(driftMinutes) && driftMinutes <= 1,
  `device ${rwcMinute || "(empty)"} vs host ${hostMinute} (${driftMinutes} min apart)`,
);
/* Same domain, same hazard, and the existing calibration check cannot see it:
   it asserts the date only, so an offset that does not cross midnight leaves
   it green.

   This used to assert that a stored stamp reads IDENTICALLY in Tokyo and in
   UTC, which was right while device time was local civil time -- the offset
   lived inside the value, so the value had to render the same everywhere.
   The page now treats the sensor's real-world clock as what it actually is,
   a plain Unix epoch in UTC: written with Date.now(), read back through the
   host's own formatter. A true epoch renders in LOCAL time by definition, so
   "identical everywhere" is now false by design and asserting it would be
   asserting the bug.
   The property that survives the change -- and the one that catches a double
   shift just as well -- is that the same stored instant reads exactly one
   timezone apart: 540 minutes later in Tokyo than in UTC. A stamp shifted
   twice is 1080 minutes out, an unshifted one is 0, and neither is 540.

   THIS CHECK IS RED as it stands, and it is right to be: the migration is
   half done. The page's own clock card renders through formatClock(), which
   reads a Date with the LOCAL accessors, but common/calibration-editor.js
   still has formatStamp() on the getUTC* accessors the old local-civil
   convention required. readStamp() already hands it a true epoch, so the same
   instant now comes out in local time on the Configure tab and in UTC on the
   Calibration tab -- nine hours apart on a Tokyo bench, and identical on the
   UTC box where nobody would notice. The fix is formatStamp's five accessors;
   until then this is the one readout left on the old convention. */
const stampTokyo = await evaluate(`
  ${CAL}
  document.querySelector('.tabs [data-tab=tabCal]').click();
  role('read').click();
  await new Promise(r => setTimeout(r, 2500));
  const c = P().querySelector('[data-cal-sensor="lnAccel"]');
  return c.querySelector('[data-cal-as-of]')?.textContent ?? '';
`);
await send("Emulation.setTimezoneOverride", { timezoneId: "" });
await goto(`${BASE}?mock=1`);
await evaluate(CONNECT);
const stampUtc = await evaluate(`
  ${CAL}
  document.querySelector('.tabs [data-tab=tabCal]').click();
  role('read').click();
  await new Promise(r => setTimeout(r, 2500));
  const c = P().querySelector('[data-cal-sensor="lnAccel"]');
  return c.querySelector('[data-cal-as-of]')?.textContent ?? '';
`);
/* Reuses the same "YYYY-MM-DD HH:MM" -> minutes parser as the readback check
   above, so nothing about the date is hard-coded: the mock seeds whatever
   instant it likes and the assertion is on the difference alone. The stamp is
   rendered as "as of <date>", so the date is picked out of the sentence. */
const stampDate = (t) =>
  /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(t ?? "")?.[0] ?? "";
const stampApart =
  asMinutes(stampDate(stampTokyo)) - asMinutes(stampDate(stampUtc));
check(
  "a calibration stamp reads exactly nine hours later in Tokyo than in UTC",
  stampDate(stampTokyo).length === 16 && stampApart === 540,
  `+09:00 "${stampTokyo}" vs UTC "${stampUtc}" (${stampApart} min apart, want 540)`,
);

// ===========================================================================
console.log("\n--- ExG presets ---");
await goto(`${BASE}?mock=1`);
check("connect for the ExG pass", (await evaluate(CONNECT)) === "mock");

const exg = await evaluate(`
  const t = window.mockTransport;
  const sel = document.getElementById('exgMode');
  const options = Array.from(sel.options).map(o => o.value);
  sel.value = options.find(v => /test/i.test(v));
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 250));
  const before = t.writes.length;
  document.getElementById('btnApply').click();
  for (let i=0;i<150 && document.getElementById('btnApply').disabled;i++)
    await new Promise(r=>setTimeout(r,100));
  await new Promise(r => setTimeout(r, 900));
  const hex = (a) => Array.from(a, b => b.toString(16).padStart(2,'0')).join(' ');
  const after = t.writes.slice(before).map(w => w.bytes);
  const lines = Array.from(document.querySelectorAll('#log .log-line')).map(n => n.textContent);
  return {
    options,
    banks: after.filter(b => b[0] === 0x61).map(b => ({ chip: b[1], regs: hex(b.slice(4)) })),
    readBack: after.some(b => b[0] === 0x63),
    refused: lines.some(l => /refused .*ExG registers/i.test(l)),
  };
`);

check(
  "applying the ExG test signal reaches the wire on both chips",
  exg.banks.length === 2 && !exg.refused,
  exg.refused
    ? "the sensor refused it"
    : `${exg.banks.length} SET_EXG_REGS writes`,
);
check(
  "and it reads the banks before writing them, as the driver does",
  exg.readBack === true,
  exg.readBack ? "GET_EXG_REGS sent first" : "no GET_EXG_REGS -- blind write",
);
/* CH1SET/CH2SET are regs[3] and regs[4]. Bits 6:4 are the PGA gain: the
   bundle shipped 0x15 (gain 1) where the driver has 0x05 (gain 6), a
   six-fold amplitude error on the one signal used to judge an ExG board. */
const gains = exg.banks.map((w) => {
  const b = w.regs.split(" ");
  return [b[3], b[4]];
});
check(
  "with the driver's PGA gain, not the 0x15 the old bundle wrote",
  gains.length === 2 && gains.every(([a, b]) => a === "05" && b === "05"),
  JSON.stringify(gains),
);

// ===========================================================================
// The Test tab: the sensor's own factory self-test, the clock-drift monitor
// that used to be a page of its own, and the red LED.
//
// The self-test is unlike every other panel here. It is one command that
// produces a MINUTE of unsolicited, unframed ASCII, printed a line at a time
// with no length up front and no acknowledgement at the end -- so what is
// being checked is mostly reassembly and release: that the text arrives whole
// and in order, that the page can tell when it is over, and that the link is
// handed back exactly once. And there is no abort: Cancel stops the page
// listening, but the sensor prints to its own end regardless, which is why
// this is the only panel that stays busy after the user has told it to stop.
// ===========================================================================
console.log("\n--- the Test tab itself ---");
// testMs shortens the mock's per-step dwell from the firmware's real 2 s per
// LED to something a pass can wait for.
await goto(`${BASE}?mock=1&testMs=30`);

const tabInfo = await evaluate(`
  const btns = [...document.querySelectorAll('.tabs [data-tab]')];
  const t = document.getElementById('tabBtnTest');
  return {
    ids: btns.map(b => b.dataset.tab),
    last: btns[btns.length - 1]?.id,
    role: t.getAttribute('role'),
    controls: t.getAttribute('aria-controls'),
    panelRole: document.getElementById('tabTest')?.getAttribute('role'),
    disabled: t.disabled,
    banner: document.getElementById('testBanner').textContent,
  };
`);
check(
  "the Test tab is last in the strip and is a real ARIA tab",
  tabInfo.ids.length === 6 &&
    tabInfo.last === "tabBtnTest" &&
    tabInfo.role === "tab" &&
    tabInfo.controls === "tabTest" &&
    tabInfo.panelRole === "tabpanel",
  JSON.stringify(tabInfo.ids),
);
/* Disconnected, this tab is the one place that explains what a connection
   would buy you, so it must not be greyed out before there is anything to
   grey out -- an unreachable tab cannot tell you why it is unreachable. */
check(
  "disconnected, the tab stays open and says what a connection would offer",
  !tabInfo.disabled && /^Connect over BLE/.test(tabInfo.banner),
  tabInfo.banner.slice(0, 60),
);

check("connect for the Test-tab pass", (await evaluate(CONNECT)) === "mock");

const testOpts = await evaluate(`
  ${TEST}
  return {
    types: [...role('type').options].map(o => [o.value, o.textContent.trim()]),
    timeout: role('timeout').value,
    runDisabled: role('run').disabled,
  };
`);
/* The four values are the firmware's own enum, and they go out on the wire as
   the byte after SET_FACTORY_TEST -- so their ORDER is a protocol constant,
   not a presentation choice. Reordering the list would silently run a
   different test than the one named. */
check(
  "the four firmware test types, in firmware order",
  testOpts.types.length === 4 &&
    testOpts.types.map((t) => t[0]).join() === "0,1,2,3",
  JSON.stringify(testOpts.types),
);
check(
  "Run is live once connected",
  !testOpts.runDisabled,
  `${testOpts.timeout} s timeout`,
);

// ===========================================================================
console.log("\n--- running a report ---");
const run = await evaluate(`
  ${TEST}
  document.querySelector('.tabs [data-tab=tabTest]').click();
  role('type').value = '0';
  role('type').dispatchEvent(new Event('change'));
  const before = opCount(0xA8);
  role('run').click();
  await new Promise(r => setTimeout(r, 400));
  const early = role('report').textContent.length;
  const applyDisabledMidRun = document.getElementById('btnApply').disabled;
  const applyNote = document.getElementById('applyNote').textContent;
  const sdBanner = document.getElementById('sdBanner').textContent;
  const brandBanner = document.getElementById('brandBanner').textContent;
  const calBanner = document.getElementById('calBanner').textContent;
  const disconnectEnabled = !document.getElementById('btnDisconnect').disabled;
  for (let i = 0; i < 250 && window.factoryTestPanel.running(); i++)
    await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300));
  const text = role('report').textContent;
  return {
    sent: opCount(0xA8) - before,
    lastWrite: Array.from((window.mockTransport.writes.at(-1).bytes ?? [])),
    early, finalLen: text.length,
    startsWithBanner: text.startsWith('//****'),
    hasEnd: /TEST END/.test(text),
    matchesMock: text === window.mockTransport.factoryTest.text(),
    modelLine: text.includes(' - S3R_TEST_0003 - PASS: Shimmer3R IMU (SR68-1-0)'),
    pass: P().querySelectorAll('.tr-pass').length,
    warn: P().querySelectorAll('.tr-warn').length,
    fail: P().querySelectorAll('.tr-fail').length,
    summary: role('summary').textContent,
    summaryClass: role('summary').className,
    copyDisabled: role('copy').disabled,
    txtDisabled: role('saveTxt').disabled,
    csvDisabled: role('csv')?.disabled,
    parsedOverall: window.factoryTestPanel.lastReport()?.parsed?.overall?.result,
    applyDisabledMidRun, applyNote, sdBanner, brandBanner, calBanner, disconnectEnabled,
    applyAfter: document.getElementById('btnApply').disabled,
  };
`);
check(
  "Run sends SET_FACTORY_TEST once, with the chosen type",
  run.sent === 1 && run.lastWrite[0] === 0xa8,
  JSON.stringify(run.lastWrite),
);
/* The report has to appear as it arrives. A minute of silence followed by a
   wall of text is indistinguishable, to the person at the bench, from a
   sensor that has hung -- which is the state this test exists to find. */
check(
  "the report arrives incrementally, not in one piece at the end",
  run.early > 0 && run.early < run.finalLen,
  `${run.early} → ${run.finalLen} chars`,
);
check(
  "the whole report arrives, banner to banner",
  run.startsWithBanner && run.hasEnd && run.finalLen > 1500,
  `${run.finalLen} chars`,
);
/* The strong form of the same claim: not "it looks right" but "it is what the
   sensor printed", compared against the mock's own copy of what it sent. */
check(
  "what is on screen is byte-for-byte what the sensor printed",
  run.matchesMock,
);
/* The reassembly hazard in one line: the mock deliberately splits this one
   across two writes and several notifications, because the firmware's own
   output is not aligned to anything. */
check(
  "a line split across two writes and many notifications reassembles",
  run.modelLine,
);
check(
  "PASS and WARNING are coloured, and nothing failed in this run",
  run.pass > 15 && run.warn === 1 && run.fail === 0,
  `pass ${run.pass} warn ${run.warn} fail ${run.fail}`,
);
check(
  "the summary reads the parsed overall verdict, not the last line printed",
  /^Overall: PASS/.test(run.summary) &&
    run.summaryClass.includes("on") &&
    run.parsedOverall === "PASS",
  run.summary,
);
check(
  "the exports come alive once there is a report",
  !run.copyDisabled && !run.txtDisabled && run.csvDisabled === false,
);
/* The link is held for the whole run, so every other panel has to say so in
   words -- "self-test" specifically, not a generic "busy": a control that
   greys out with no sentence anywhere is the failure mode the reason matrix
   at the end of this pass exists to prevent. */
check(
  "mid-run, every other panel is refused with a sentence naming the self-test",
  run.applyDisabledMidRun &&
    /self-test/.test(run.applyNote) &&
    /self-test/.test(run.sdBanner) &&
    /self-test/.test(run.brandBanner) &&
    /self-test/.test(run.calBanner),
  run.applyNote.slice(0, 60),
);
/* There is no abort command, so pulling the link is the only real escape.
   Disabling Disconnect during a run would trap the user for a minute. */
check(
  "Disconnect stays available during a run — the only real escape",
  run.disconnectEnabled,
);
check("the link is released when the report ends", run.applyAfter === false);

const saved = await evaluate(`
  ${TEST}
  window.__blobs.length = 0;
  role('saveTxt').click();
  role('csv').click();
  await new Promise(r => setTimeout(r, 200));
  const out = [];
  for (const b of window.__blobs) {
    /* The BOM is asserted on the RAW BYTES, not on b.text(): Blob.text()
       decodes as UTF-8 and strips a leading BOM, so a text compare passes
       whether or not the BOM was ever written -- and the BOM is the whole
       point, because Excel reads a BOM-less CSV as the local codepage. */
    const bytes = new Uint8Array(await b.arrayBuffer());
    out.push({
      type: b.type,
      head: (await b.text()).slice(0, 40),
      first3: Array.from(bytes.slice(0, 3)),
      size: b.size,
    });
  }
  return out;
`);
check(
  "Save .txt writes the report verbatim, and Save CSV writes a BOM'd table",
  saved.length === 2 &&
    saved[0].type.startsWith("text/plain") &&
    saved[0].head.startsWith("//****") &&
    saved[1].type.startsWith("text/csv") &&
    saved[1].first3.join() === "239,187,191",
  JSON.stringify(saved.map((s) => [s.type, s.size])),
);

// ===========================================================================
console.log("\n--- a failing unit ---");
await goto(`${BASE}?mock=1&testMs=20&testFail=1`);
check(
  "connect to a sensor that fails its self-test",
  (await evaluate(CONNECT)) === "mock",
);
const failRun = await evaluate(`
  ${TEST}
  document.querySelector('.tabs [data-tab=tabTest]').click();
  role('run').click();
  for (let i = 0; i < 250 && window.factoryTestPanel.running(); i++)
    await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300));
  const text = role('report').textContent;
  const lines = text.split('\\r\\n');
  return {
    fail: P().querySelectorAll('.tr-fail').length,
    summary: role('summary').textContent,
    cls: role('summary').className,
    longest: Math.max(...lines.map(l => l.length)),
    gluedLine: lines.find(l => l.length > 128)?.slice(0, 50),
    failedNames: window.factoryTestPanel.lastReport()?.parsed?.overall?.failedTestNames,
  };
`);
check(
  "a FAIL line and the verdict are both coloured",
  failRun.fail >= 2,
  `${failRun.fail} spans`,
);
/* The mask is the machine-readable half of the verdict, and the only place
   the failed test's NAME can come from -- the firmware prints the number. */
check(
  "the summary decodes the fail mask and names what failed",
  /FAIL \(0x00000040\)/.test(failRun.summary) && failRun.cls.includes("err"),
  failRun.summary,
);
check(
  "the parser names the failed test",
  Array.isArray(failRun.failedNames) && failRun.failedNames.length >= 1,
  JSON.stringify(failRun.failedNames),
);
/* The firmware truncates its own lines at 128 characters and carries on
   printing, with no newline at the seam. Nothing on this side can put the
   break back, so the page must show the seam as it is rather than inventing
   one -- a report that "looks tidy" here is a report that has been edited. */
check(
  "a line the firmware truncated at 128 chars is shown glued to the next",
  failRun.longest > 128,
  `${failRun.longest} chars: ${failRun.gluedLine}`,
);

// ===========================================================================
console.log("\n--- cancel, and the sensor that keeps printing ---");
await goto(`${BASE}?mock=1&testMs=120`);
check("connect for the cancel pass", (await evaluate(CONNECT)) === "mock");
const cancelled = await evaluate(`
  ${TEST}
  document.querySelector('.tabs [data-tab=tabTest]').click();
  role('type').value = '3';
  role('type').dispatchEvent(new Event('change'));
  role('run').click();
  await new Promise(r => setTimeout(r, 600));
  const beforeOps = opCount(0xA8);
  role('cancel').click();
  await new Promise(r => setTimeout(r, 300));
  const midLen = window.mockTransport.factoryTest.text().length;
  const out = {
    running: window.factoryTestPanel.running(),
    draining: window.factoryTestPanel.draining(),
    status: role('status').textContent,
    applyDisabled: document.getElementById('btnApply').disabled,
    sensorStillPrinting: window.mockTransport.factoryTest.running,
    opsAfterCancel: opCount(0xA8) - beforeOps,
  };
  await new Promise(r => setTimeout(r, 1200));
  out.grew = window.mockTransport.factoryTest.text().length > midLen;
  for (let i = 0; i < 400 && window.factoryTestPanel.draining(); i++)
    await new Promise(r => setTimeout(r, 100));
  out.drainedApply = document.getElementById('btnApply').disabled;
  out.finalStatus = role('status').textContent;
  return out;
`);
check("Cancel stops the page listening", !cancelled.running);
/* The distinction the whole panel turns on: the page has stopped, the SENSOR
   has not. Releasing the link here would let an apply go out into the middle
   of a report still being printed. */
check(
  "but the page stays busy, because the sensor keeps printing",
  cancelled.draining &&
    cancelled.applyDisabled &&
    /still running/i.test(cancelled.status),
  cancelled.status.slice(0, 90),
);
check(
  "nothing was sent to stop it — there is no such command",
  cancelled.opsAfterCancel === 0,
);
check(
  "the sensor really does keep printing",
  cancelled.sensorStillPrinting && cancelled.grew,
);
check(
  "the link frees itself once the report would have ended",
  cancelled.drainedApply === false,
  cancelled.finalStatus.slice(0, 80),
);

// ===========================================================================
console.log("\n--- the firmware's own refusal ---");
await goto(`${BASE}?mock=1&testMs=20`);
check("connect for the refusal pass", (await evaluate(CONNECT)) === "mock");
const refused = await evaluate(`
  document.getElementById('btnStreamStart').click();
  await new Promise(r => setTimeout(r, 700));
  const streamingState = {
    tabDisabled: document.getElementById('tabBtnTest').disabled,
    banner: document.getElementById('testBanner').textContent,
  };
  document.getElementById('btnStreamStop').click();
  await new Promise(r => setTimeout(r, 700));
  return streamingState;
`);
/* The one refusal that closes the tab rather than banner it: the firmware
   will not start a self-test while it is sensing, so there is nothing on the
   tab that could work. Every other holder is transient and leaves it open --
   see the paintTestGating pin at the end of this pass. */
check(
  "while streaming, the tab closes and says the refusal is the firmware's",
  refused.tabDisabled && /refuses a self-test/.test(refused.banner),
  refused.banner.slice(0, 80),
);

// ===========================================================================
console.log("\n--- the red LED ---");
const led = await evaluate(`
  ${TEST}
  document.querySelector('.tabs [data-tab=tabTest]').click();
  const before = opCount(0x06);
  document.getElementById('btnLedToggle').click();
  await new Promise(r => setTimeout(r, 700));
  const afterToggle = {
    ops: opCount(0x06) - before,
    bit: (window.mockTransport.status.bytes()[2] & 0x80) !== 0,
    pill: document.getElementById('ledPill').textContent,
    pillClass: document.getElementById('ledPill').className,
  };
  document.getElementById('btnLedOn').click();
  await new Promise(r => setTimeout(r, 700));
  const idempotent = opCount(0x06) - before;
  document.getElementById('btnLedOff').click();
  await new Promise(r => setTimeout(r, 900));
  return {
    afterToggle,
    idempotent,
    offOps: opCount(0x06) - before,
    offBit: (window.mockTransport.status.bytes()[2] & 0x80) !== 0,
    offPill: document.getElementById('ledPill').textContent,
  };
`);
/* The pill is painted from the sensor's own status bit rather than from what
   the page last asked for: the firmware's flag survives a disconnect, so the
   only honest source is the sensor. */
check(
  "Toggle sends the command and the pill follows the sensor's own bit",
  led.afterToggle.ops === 1 &&
    led.afterToggle.bit &&
    /red LED on/.test(led.afterToggle.pill) &&
    led.afterToggle.pillClass.includes("on"),
  led.afterToggle.pill,
);
/* The firmware has a TOGGLE, not a set, so "on" and "off" have to be built
   out of it: read the bit, and write only if it disagrees. Asking for a state
   the sensor is already in must put nothing on the wire, or the buttons flip
   the LED instead of setting it. */
check(
  "Red LED on is idempotent — already on, so nothing is written",
  led.idempotent === 1,
  `${led.idempotent} toggles`,
);
check(
  "Red LED off drives it back",
  led.offOps === 2 && !led.offBit && /red LED off/.test(led.offPill),
  led.offPill,
);

// ===========================================================================
console.log("\n--- clock drift ---");
/* ppm is deliberately enormous. The SDK steps the device clock in whole
   seconds, so a sample only moves when ppm × elapsed exceeds one second --
   at a realistic 20 ppm that is fourteen hours. 20000 ppm puts a step inside
   every 2 s interval while staying under a second per interval, which is what
   keeps the fitted slope meaningful rather than quantised to nothing.
   clockBase=local starts the sensor on this host's civil time instead of UTC,
   which is what a sensor last set by the old convention looks like. */
await send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Tokyo" });
await goto(`${BASE}?mock=1&ppm=20000&clockBase=local`);
check(
  "connect to a sensor with a fast clock, under +09:00",
  (await evaluate(CONNECT)) === "mock",
);
const drift = await evaluate(`
  ${TEST}
  document.querySelector('.tabs [data-tab=tabTest]').click();
  drole('interval').value = '2';
  drole('interval').dispatchEvent(new Event('change'));
  const before = opCount(0x91);
  drole('start').click();
  await new Promise(r => setTimeout(r, 6500));
  const out = {
    samples: dstat('samples'),
    reads: opCount(0x91) - before,
    ppmText: dstat('ppm'),
    fit: window.rtcDriftPanel.monitor()?.ppmFit(),
    base: window.rtcDriftPanel.clockBaseSec(),
    baseText: drole('base')?.textContent,
    running: window.rtcDriftPanel.running(),
  };
  window.__blobs.length = 0;
  drole('csv').click();
  await new Promise(r => setTimeout(r, 200));
  out.csvHead = window.__blobs.length ? (await window.__blobs[0].text()).slice(0, 260) : '';
  // Raw bytes again: Blob.text() would strip the BOM and hide its absence.
  out.csvBom = window.__blobs.length
    ? Array.from(new Uint8Array(await window.__blobs[0].arrayBuffer()).slice(0, 3)).join() === '239,187,191'
    : false;
  drole('stop').click();
  await new Promise(r => setTimeout(r, 200));
  out.stopped = !window.rtcDriftPanel.running();
  return out;
`);
/* The first sample is taken immediately rather than after one interval: a
   monitor left running overnight is useless if it cannot show anything for
   the first ten minutes. */
check(
  "sampling starts at once and keeps to its interval",
  Number(drift.samples) >= 3 && drift.reads >= 3,
  `${drift.samples} samples / ${drift.reads} reads`,
);
check(
  "the fitted slope is the drift the sensor was actually given",
  drift.fit != null && Math.abs(drift.fit - 20000) / 20000 < 0.2,
  `${Math.round(drift.fit)} ppm vs 20000`,
);
/* A whole-hour offset between sensor and host is a clock BASE, not drift: a
   sensor set by something that wrote local civil time. Folding it into the
   error would report a 32400-second "drift" and hide the ppm entirely. */
check(
  "a +09:00 sensor clock is recognised as a clock base, not as error",
  drift.base === 32400,
  `base ${drift.base} s — ${String(drift.baseText).slice(0, 70)}`,
);
check(
  "the CSV carries its metadata preamble and a BOM",
  drift.csvBom &&
    /clock_base_s/.test(drift.csvHead) &&
    /ppm_fit/.test(drift.csvHead),
  drift.csvHead.split(String.fromCharCode(10))[1],
);
check("Stop ends the run", drift.stopped);

/* The drift panel is the one panel that WAITS instead of closing when another
   panel takes the link -- so a skipped tick has to say so. A silent skip and
   a dead monitor look identical on a plot. */
const skip = await evaluate(`
  ${TEST}
  drole('interval').value = '2';
  drole('interval').dispatchEvent(new Event('change'));
  drole('start').click();
  await new Promise(r => setTimeout(r, 300));
  const before = opCount(0x91);
  document.getElementById('btnLinkTest').click();
  await new Promise(r => setTimeout(r, 3000));
  const status = drole('status').textContent;
  const during = opCount(0x91) - before;
  drole('stop').click();
  return { status, during };
`);
check(
  "a sample is skipped, with the reason, while another panel holds the link",
  /skipped/i.test(skip.status) && /link-speed/i.test(skip.status),
  skip.status.slice(0, 90),
);
await send("Emulation.setTimezoneOverride", { timezoneId: "" });

// ===========================================================================
console.log("\n--- refusal reasons cover every other link holder ---");

const pageSrc = await (await fetch(`${BASE}index.html`)).text();

/** The body of a `function name() { … }` declaration, brace-matched. */
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const i = src.indexOf("{", start);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

/* asking panel -> the flags it must be able to explain. Its own flag is
   absent by design: a panel refuses its own second operation itself. */
const MUST_EXPLAIN = {
  linkTestUnavailableReason: [
    "streaming",
    "sdLogging",
    "sdBusy",
    "brandBusy",
    "calibBusy",
    "testBusy",
  ],
  sdUnavailableReason: [
    "streaming",
    "sdLogging",
    "linkTesting",
    "brandBusy",
    "calibBusy",
    "testBusy",
  ],
  brandUnavailableReason: [
    "streaming",
    "sdLogging",
    "linkTesting",
    "sdBusy",
    "calibBusy",
    "testBusy",
  ],
  calibLinkHeldReason: [
    "streaming",
    "sdLogging",
    "linkTesting",
    "sdBusy",
    "brandBusy",
    "testBusy",
  ],
  /* The self-test is the sixth holder, and the first that outlives its own
     Cancel: the firmware has no abort, so testBusy stays up while the sensor
     finishes printing. That makes it exactly the flag the other five would
     have aged past silently. */
  testUnavailableReason: [
    "streaming",
    "sdLogging",
    "linkTesting",
    "sdBusy",
    "brandBusy",
    "calibBusy",
  ],
  /* The drift monitor is the one panel that waits instead of closing, so its
     skip reason has to name every holder INCLUDING the self-test it shares a
     tab with -- a silent skip is indistinguishable from a dead monitor. */
  driftSampleSkipReason: [
    "streaming",
    "sdLogging",
    "linkTesting",
    "sdBusy",
    "brandBusy",
    "calibBusy",
    "testBusy",
  ],
};

for (const [fn, flags] of Object.entries(MUST_EXPLAIN)) {
  const body = fnBody(pageSrc, fn);
  const missing = body ? flags.filter((f) => !body.includes(f)) : flags;
  check(
    `${fn} can explain every other panel holding the link`,
    !!body && missing.length === 0,
    body ? `missing: ${missing.join(", ") || "none"}` : "function not found",
  );
}

/* The one that had drifted: the calibration tab's disabled state must come
   from the same predicate as its sentence, not a hand-copied list. */
const CALIB_DISABLE = "btn.disabled = !!client && !!calibLinkHeldReason()";
const calibPaint = fnBody(pageSrc, "paintCalibGating");
check(
  "the calibration tab closes on the same predicate that explains why",
  !!calibPaint && calibPaint.includes(CALIB_DISABLE),
  (calibPaint ?? "")
    .split(String.fromCharCode(10))
    .find((l) => l.includes("btn.disabled")) ?? "not found",
);

/* The Test tab deliberately does NOT follow that rule, so pin the exception
   too — otherwise the next person to "fix the inconsistency" closes the tab
   whenever any other panel touches the link, and takes the drift plot down
   with it. Only the firmware's own refusal (it will not self-test while it is
   sensing) closes this tab; every other holder is a transient banner over a
   tab that stays open. */
const TEST_DISABLE = "btn.disabled = !!client && (streaming || sdLogging);";
const testPaint = fnBody(pageSrc, "paintTestGating");
check(
  "the Test tab closes only on the refusal that is the firmware's, not on a busy link",
  !!testPaint && testPaint.includes(TEST_DISABLE),
  (testPaint ?? "")
    .split(String.fromCharCode(10))
    .find((l) => l.includes("btn.disabled")) ?? "not found",
);

// ===========================================================================
console.log("\n--- console ---");
check(
  "no console errors across the whole pass",
  consoleErrors.length === 0,
  JSON.stringify(consoleErrors),
);

const failed = results.filter((r) => !r.pass);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
if (failed.length)
  console.log("FAILED:", failed.map((f) => f.name).join(" | "));
ws.close();
process.exit(failed.length ? 1 : 0);
