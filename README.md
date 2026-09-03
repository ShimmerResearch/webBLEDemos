# webBLEDemos

Web Bluetooth demos for Shimmer sensor devices, running entirely in the browser with no native app required.

> **Migration note** — this branch replaces the local `shimmer3r.js` / `verisense.js` files with the published [`shimmer-web-sdk`](https://github.com/ShimmerResearch/shimmer-web-sdk) package. If you need the pre-migration setup, check out the [v0.0.1](https://github.com/ShimmerResearch/webBLEDemos/releases/tag/v0.0.1) release tag.

> **Pre-Alpha Release** — these demos and the SDK are early-stage software. What that means from a support perspective is described [here](https://shimmersensing.com/wp-content/uploads/2022/04/Shimmer-Support-Policy_27.04.2022.pdf). If you encounter technical issues, or would like to express interest in shaping future development, please reach out to the Shimmer support team. If sufficient interest is registered, we may prioritise building a more fully scoped and robust API.

---

## Repository Layout

```
break-gyro/          ┐
break-emg/           │
punch-highG/         │
brick/               │
rythmgame-emggyro/   │  Shimmer3R demos
video-ppg/           │
spell-gyro/          │
ShimmerCapture/      │
consensys-export/    │
rtc-drift-test/      ┘
Verisense/           ←  Verisense demo
shimmer-extension/   ← Shimmer3R/Verisense Chrome extension (source; load unpacked in Chrome)
sdk-source.json      ←  Single source-of-truth for SDK source mode/version
update-local-sdk.ps1 ←  Build + sync local SDK artifacts
sync-local-sdk.ps1   ←  Sync-only local SDK artifacts
update-local-sdk.cmd ←  Windows CMD launcher for update script
```

The full Verisense control console now lives in a dedicated repository:

- [ShimmerResearch/verisense-device-console](https://github.com/ShimmerResearch/verisense-device-console)

---

## Live Demos

### Shimmer3R

**Requirements:** Shimmer3R device, firmware ≥ v1.0.22, Chrome/Edge (Web Bluetooth required)

| Demo                                                                     | Link                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Gyro breakout game                                                       | [break-gyro](https://shimmerresearch.github.io/webBLEDemos/break-gyro/)               |
| EMG breakout game                                                        | [break-emg](https://shimmerresearch.github.io/webBLEDemos/break-emg/)                 |
| 200 G accel punch detector                                               | [punch-highG](https://shimmerresearch.github.io/webBLEDemos/punch-highG/)             |
| EMG + Gyro rhythm game                                                   | [rythmgame-emggyro](https://shimmerresearch.github.io/webBLEDemos/rythmgame-emggyro/) |
| PPG heart-rate visualiser                                                | [video-ppg](https://shimmerresearch.github.io/webBLEDemos/video-ppg/)                 |
| Two-device gyro brick game                                               | [brick](https://shimmerresearch.github.io/webBLEDemos/brick/)                         |
| Spell caster (gyro gestures)                                             | [spell-gyro](https://shimmerresearch.github.io/webBLEDemos/spell-gyro/)               |
| Configure, stream, plot, record, browse the SD card and set device names | [ShimmerCapture](https://shimmerresearch.github.io/webBLEDemos/ShimmerCapture/)       |
| Consensys trial export + Bluetooth RTC set                               | [consensys-export](https://shimmerresearch.github.io/webBLEDemos/consensys-export/)   |
| RTC drift test (32 kHz crystal)                                          | [rtc-drift-test](https://shimmerresearch.github.io/webBLEDemos/rtc-drift-test/)       |

**Consensys Export** packages a logged Shimmer3/Shimmer3R trial into the Consensys import folder structure, zips it, and shares it. It also sets the device real-time clock over Bluetooth. Best on a Chromium browser (Chrome/Edge); on iPhone/iPad use the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) app for the Bluetooth RTC feature.

**RTC Drift Test** measures the Shimmer3R real-world-clock drift against the host clock and least-squares fits the slope in ppm, with NTP host-step detection and CSV export. Also works over the dock UART (Web Serial — preferred, lower jitter than BLE).

**Shimmer Capture** is a worked example of driving a single Shimmer3R from a browser: connect over **BLE**, **classic Bluetooth** (a paired COM port, via Web Serial) or **USB-C**, then configure it, stream from it, plot it and record a CSV. The configuration editor is generated from the SDK's description of the InfoMem, so it covers the whole LogAndStream option set — sampling rate, every sensor's range and rate, GSR, expansion power, the SD-logging and trial settings, the sync settings — and it edits the 384-byte image in place, so the bytes no field on the page models survive a read, an edit and a write untouched. There is a hex view of that image with save and load, a calibration-dump reader and writer, the decoded device status flags and a real-world-clock set. Note that **the Shimmer3R's USB-C port speaks the dock protocol, not the Bluetooth one**, so over USB the page configures the sensor but cannot stream from it; it says so rather than offering a button that cannot work. Append `?mock=1` to the URL to drive the whole page against a scripted sensor with no hardware on the desk. Two further tabs cover what used to be separate pages: **SD card** browses the sensor's card and pulls logged sessions off it, in the Consensys import layout or as the card is laid out, with a live throughput readout, an abort, resume after an abort, and an option to delete a file only once its download has been verified; **Device naming** reads and writes the EEPROM record holding the classic-Bluetooth, BLE and USB names, so a sensor advertises a customer's branding instead of the Shimmer defaults, with a restore-to-factory control and the restart a new name needs (armed over Bluetooth, walked through by hand over the dock). The standalone `sd-download` and `eeprom-branding` pages have been removed in favour of these tabs. It is an example for one device, not a replacement for the desktop application. See the [demo README](./ShimmerCapture/README.md).

### Verisense

**Requirements:** Verisense device (IMU or Pulse+), Chrome/Edge

| Demo                                           | Link                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Wrist sensor (accel + GSR streaming)           | [Verisense](https://shimmerresearch.github.io/webBLEDemos/Verisense/)                   |
| Verisense Device Console (full SDK operations) | [verisense-device-console](https://shimmerresearch.github.io/verisense-device-console/) |

### Chrome Extension

[Shimmer Companion Chrome extension](./shimmer-extension/) — a locally loaded Chrome extension for streaming PPG and GSR, capturing screenshots and media context, generating session reports, and optionally adding on-device webcam face/head-state analysis. It supports selecting between multiple cameras and uploading session files to a compatible ASM Cloud deployment. See the [extension README](./shimmer-extension/README.md) for installation, privacy, export, and server requirements.

Load via **chrome://extensions → Developer mode → Load unpacked**. This is optional and is **not required** for running the web demos in this repository.

---

## Local Quickstart

### Prerequisites

- Chrome or Edge (Web Bluetooth support required)
- VS Code with the **Live Server** extension
- Node.js and npm (required when `sdk-source.json` uses `local-repo`, `local-version`, or `local-latest`)
- This repo (`webBLEDemos`) checked out next to `shimmer-web-sdk` (required by `update-local-sdk.ps1` / `sync-local-sdk.ps1` unless you pass a custom `-SdkRepoPath`)

Expected folder layout:

```text
.../shimmer-web-workspace/
	shimmer-web-sdk/
	webBLEDemos/
```

If your folders are not siblings, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1 -SdkRepoPath "C:\path\to\shimmer-web-sdk"
```

### SDK source selection (single location)

Most demos import from `../shimmer-extension/vendor/shimmer-web-sdk.esm.js`.
The `Verisense` demo imports from `./vendor/shimmer-web-sdk.esm.js`.
The file that controls where vendor artifacts come from is `sdk-source.json`:

```json
{
  "sourceMode": "local-repo",
  "version": "0.1.7"
}
```

Supported `sourceMode` values:

- `local-repo`: build/sync using the current local `shimmer-web-sdk` checkout
- `local-version`: build/sync from a specific local SDK git tag using `version` (for example `0.1.7` resolves to `v0.1.7`)
- `local-latest`: build/sync from the latest local SDK `v*` git tag

In all modes, demos still import from the same vendored files already in this repo; `sourceMode` only changes which SDK source is used to generate those vendored files before sync.

How `version` is used:

- With `local-repo`, `version` is ignored (the current local SDK checkout is used).
- With `local-version`, `version` is required and selects the SDK tag to build (for example `0.1.7` -> `v0.1.7`).
- With `local-latest`, `version` is ignored (latest local `v*` tag is used).

### 1) Build and sync the local SDK

If you are using local SDK changes, rebuild and sync the vendored SDK files:

Script reference:

| Script                 | What it does                                                                          | Typical use                            |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| `update-local-sdk.ps1` | Uses `sdk-source.json`; builds SDK only for `local-repo`, then syncs vendor artifacts | Main workflow after SDK/source changes |
| `sync-local-sdk.ps1`   | Uses `sdk-source.json` to sync vendor artifacts only (no build)                       | You already built SDK elsewhere        |
| `update-local-sdk.cmd` | Windows CMD launcher for `update-local-sdk.ps1`                                       | Double-click or cmd.exe usage          |

```powershell
powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1
```

First run only (installs dependencies before build):

```powershell
powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1 -InstallDeps
```

If Node.js/npm is not installed and you only want to sync already-built vendor artifacts:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1 -SkipBuild
```

Use a specific SDK version (for example `0.1.7`) from one place:

1. Set `"sourceMode": "local-version"` in `sdk-source.json`
2. Set `"version": "0.1.7"` in `sdk-source.json`
3. Run `powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1`

Switch to latest SDK from one place:

1. Set `"sourceMode": "local-latest"` in `sdk-source.json`
2. Run `powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1`

Manual equivalent:

```powershell
cd ../shimmer-web-sdk
powershell -ExecutionPolicy Bypass -File .\build-local-sdk.ps1
cd ../webBLEDemos
powershell -ExecutionPolicy Bypass -File .\sync-local-sdk.ps1
```

### 2) Run a demo on localhost (required for BLE)

Open a demo file (for example `Verisense/index.html`) in VS Code and choose **Open with Live Server**.

Use the localhost URL opened by Live Server (commonly `http://localhost:5500/...`).

### 3) Connect from the page

- Click **Connect (BLE)** from the demo page (user gesture is required by the browser).
- For Verisense, you can also use **Connect USB (Serial)**.

### Troubleshooting

- If BLE buttons do not work, check the URL is `http://localhost/...` or `https://...` (not `file://...`).
- If a demo fails to import the SDK, run the sync command again from `webBLEDemos` root.
- If you updated SDK code but behavior did not change, re-run `.\update-local-sdk.ps1` from `webBLEDemos`.

---

## `@shimmerresearch/shimmer-web-sdk` SDK

The demos import the SDK from vendored files in this repository, using relative paths that work both on localhost and on GitHub Pages:

```js
import { Shimmer3RClient } from "../shimmer-extension/vendor/shimmer-web-sdk.esm.js";
```

This means:

- Local development uses the vendored SDK file without external CDN dependency.
- GitHub Pages deployments also resolve the same path under the published `webBLEDemos` site.
- The demos work on GitHub Pages as long as vendored SDK files are committed with the site.

For the Verisense demo in this repository:

```js
import { VerisenseBleDevice } from "./vendor/shimmer-web-sdk.esm.js";
```

### Update vendored SDK from local source

When you make SDK changes in the sibling `shimmer-web-sdk` repo, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-local-sdk.ps1
```

Windows CMD alternative:

```cmd
update-local-sdk.cmd
```

The sync script uses `sdk-source.json` to copy built artifacts from `shimmer-web-sdk/dist` into both:

- `webBLEDemos/shimmer-extension/vendor`
- `webBLEDemos/Verisense/vendor`

Build logic is centralized in `shimmer-web-sdk/build-local-sdk.ps1` and invoked by `update-local-sdk.ps1`.

Manual copying into vendor folders is no longer required when you use `update-local-sdk.ps1` or `sync-local-sdk.ps1`.

The SDK source lives at [ShimmerResearch/shimmer-web-sdk](https://github.com/ShimmerResearch/shimmer-web-sdk).
