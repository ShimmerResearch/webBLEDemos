# `common/` — shared UI library

Framework-free ES modules and one stylesheet, shared by the demo pages in
this repo. This site is served straight off GitHub Pages: there is no build
step, no bundler and no `npm install`. Everything here is loaded by the
browser exactly as it is checked in.

Three rules the whole library follows, so a page can rely on them:

1. **Import convention.** Every module is reachable from any demo folder as
   `../common/<file>.js`. Modules import each other by bare relative path
   (`./ui-chrome.js`), and reach the SDK at
   `../shimmer-extension/vendor/shimmer-web-sdk.esm.js`.
2. **No DOM at import time.** No module touches `document` or `window` while
   it is being imported — every one of them does its DOM work inside an
   exported function. A page can therefore import in `<head>`, in any order,
   without a load-order knot.
3. **Say "host", not "PC".** User-facing strings talk about "this host",
   because these pages run on phones and tablets too.

## Modules

| File                        | What it does                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme.css`                 | Design tokens (Pantone Orange 021C accents) and base components: page, cards, rows, grids, buttons, inputs, pills, banners, collapsible groups, config fields, tabs, toasts, the event log, a hex byte grid, a stats strip and plot panels. Light, explicit-dark and OS-dark.                                                                                          |
| `theme.js`                  | `THEME_BOOTSTRAP_SNIPPET` (the pre-paint `<head>` script, as a string), `initThemeToggle`, `getTheme`, `setTheme`, `onThemeChange`.                                                                                                                                                                                                                                    |
| `ui-chrome.js`              | `$`, `el`, `createLog`, `showToast`, `createGate`, `initTabs`, `downloadBlob`, `fmtBytes`, `fmtHz`, `fmtDuration`, `classifyLogLine`, `formatLogTime`.                                                                                                                                                                                                                 |
| `connect-ui.js`             | `createConnectController` — capability gating for the BLE / classic-Bluetooth / wired buttons, connect-failure hints, port identity logging, platform advice, SDK version probe and disconnect detection.                                                                                                                                                              |
| `transport-tap.js`          | `createTransportTap` — wraps any `ShimmerTransport` and logs the bytes crossing it as `TX …` / `RX …` hex lines, which is what feeds `createLog`'s TX / RX filter. Off until asked, streaming data packets excluded by default, capped per second. Also `formatHexLine`.                                                                                               |
| `config-form.js`            | `createConfigForm` — renders a configuration editor from a declarative field schema and edits the device's configuration image in place, so bytes no field models survive untouched. Tracks which fields are dirty, validates before committing, and relocates fields a given hardware generation does not have.                                                       |
| `shimmer3-config-schema.js` | The Shimmer3/Shimmer3R glue for that form: `describeShimmer3Caps` (feature detection for the gating keys), `LIVE_OVERLAYS` (fields that also have an immediate-effect Bluetooth setter), `buildApplyPlan` (the order the firmware requires), `EXG_MODES`, `SENSOR_GROUPS`.                                                                                             |
| `plot.js`                   | `createStreamPlot` — one Chart.js panel per sensor group, fed from ring buffers. Also `groupForField`, `padRange`, `PLOT_GROUPS`, `SHIMMER_TRACE_PALETTE`.                                                                                                                                                                                                             |
| `stream-stats.js`           | `createStreamStats` — rate, expected rate, loss, throughput, frames and duration, over the SDK's `StreamStatsTracker`.                                                                                                                                                                                                                                                 |
| `csv-recorder.js`           | `createCsvRecorder` — streams rows to a file the user picks, or buffers and downloads.                                                                                                                                                                                                                                                                                 |
| `sd-browser.js`             | `createSdBrowser` — the on-card tree, a destination folder remembered across sessions, the Consensys-Backup layout, progress with a rolling rate and an ETA, delete-after-verified and abort. Its `measureLinkSpeed` runs the firmware data-rate test, but the button for it belongs to the mounting page, since it measures the link and not the card. Also `fmtEta`. |
| `vendor/chart.umd.min.js`   | Chart.js 4.5.1, pinned. See `vendor/README.md`.                                                                                                                                                                                                                                                                                                                        |
| `dev/mock-shimmer3r.js`     | `createMockShimmer3RTransport`, `mockEnabledFromUrl` — a scripted Shimmer3R for developing without hardware.                                                                                                                                                                                                                                                           |

## Using it from a page

```html
<head>
  <meta name="theme-color" content="#f4f6f8" />
  <!-- Inline, and NOT type="module": it must run before the first paint,
       or the page flashes the wrong theme. Paste THEME_BOOTSTRAP_SNIPPET. -->
  <script>
    /* … */
  </script>
  <link rel="stylesheet" href="../common/theme.css" />
  <!-- Only if the page plots. Defines the global `Chart`. -->
  <script src="../common/vendor/chart.umd.min.js"></script>
</head>
```

```js
import { initThemeToggle } from "../common/theme.js";
import { $, createLog, showToast } from "../common/ui-chrome.js";
import { createConnectController } from "../common/connect-ui.js";
import * as sdkNs from "../shimmer-extension/vendor/shimmer-web-sdk.esm.js";
```

Pass the SDK to `createConnectController` as a **namespace object**, not as
destructured names: a vendored bundle that predates one of the exports then
degrades to a warning instead of breaking the page's import.

## Chart.js is pinned

`common/vendor/chart.umd.min.js` is Chart.js **4.5.1**, checked in and
pinned. `plot.js` reads the global `Chart` rather than importing it, and
depends on version-specific behaviour (`parsing: false` with pre-sorted
point arrays, and the min-max `decimation` plugin). Do not swap in a CDN
copy or bump the version without re-checking a high-rate stream on hardware.
Details in `vendor/README.md`.

## `?mock=1` — running without hardware

Append `?mock=1` to a page's URL and `mockEnabledFromUrl()` returns true;
the page then hands `createMockShimmer3RTransport()` to the client instead
of opening a real link:

```js
import {
  createMockShimmer3RTransport,
  mockEnabledFromUrl,
} from "../common/dev/mock-shimmer3r.js";

const transport = mockEnabledFromUrl()
  ? createMockShimmer3RTransport()
  : undefined; // undefined → the client opens a real BLE/serial link
const client = new Shimmer3RClient({ transport });
```

The mock answers ACK/NACK, INQUIRY, firmware and device version, status,
battery, InfoMem read/write, the RTC, the sensor/rate/range setters and
start/stop for both streaming and SD-plus-Bluetooth logging, and emits
synthetic sine data at the configured rate. It also serves a small
synthetic SD card — one trial folder holding two session folders, sizes
that are not round, one file large enough to span three read windows —
over the real transfer protocol: `SD_LIST_DIR` with paging,
`SD_FILE_STAT`, `SD_FILE_READ` as CRC'd block frames, `SD_TRANSFER_ABORT`,
`SD_FREE_SPACE` and `SD_DELETE`, plus `SET_DATA_RATE_TEST` for a
link-speed readout. Options worth knowing:

- `framed: false` makes it behave like an RFCOMM byte stream, delivering
  every reply in 3-byte dribbles — that is how to exercise the SDK's
  control-plane re-framing without a paired sensor.
- `firmware: {major, minor, patch}` sets what `GET_FW_VERSION` reports.
  The default v1.01.012 is above the SD-transfer gate; pass v1.01.010 to
  exercise a page's refusal path.
- `sdKBps` paces the streamed file blocks, so a download takes long
  enough to have a progress bar, a throughput readout and an ETA worth
  looking at, and long enough to abort mid-flight.
- `debug: true` logs every command and reply to the console.

`transport.emitDisconnect()` simulates a dropped link,
`transport.writes` is every command the page sent, and
`transport.sdCard.bytes(path)` is exactly what a download of that card
file should produce — which is what a test compares against.

It is a development aid, not a firmware simulator: it does not model
power or most error paths, and its timing is plausible rather than real.
It is opt-in from the URL only, deliberately — a page that reached for
the mock on its own would quietly show fake data to someone debugging
real hardware.

## Formatting

CI (`.github/workflows/html-format.yml`) runs prettier 3.3.3 over
`**/*.html` only, and auto-commits the result onto the pushed branch. It
does **not** touch the `.js`, `.css` or `.md` files in this folder, so
format them yourself before pushing:

```bash
npx --yes prettier@3.3.3 --write "common/**/*.{js,css,md}"
```

Use that exact version. A different prettier reflows the whole folder and
buries the real change in a diff nobody can read.

That glob does match `vendor/chart.umd.min.js`, and prettier un-minifies a
minified file — it grows from 204 KB to 342 KB and the diff is the whole
library. The repo's `.prettierignore` lists the vendored bundles for exactly
that reason, so the command above is safe as written; if you run prettier
with `--ignore-path` pointed somewhere else, exclude `common/vendor/`
yourself.
