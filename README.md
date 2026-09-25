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
consensys-export/    ┘
Verisense/           ←  Verisense demo
ShimmerCapture/      ←  redirect stub only; the page moved to shimmer-capture-web
shimmer-extension/   ← Shimmer3R/Verisense Chrome extension (source; load unpacked in Chrome)
sdk-source.json      ←  Single source-of-truth for SDK source mode/version
update-local-sdk.ps1 ←  Build + sync local SDK artifacts
sync-local-sdk.ps1   ←  Sync-only local SDK artifacts
update-local-sdk.cmd ←  Windows CMD launcher for update script
```

Two of these grew past being demos and now live in dedicated repositories:

- [ShimmerResearch/verisense-device-console](https://github.com/ShimmerResearch/verisense-device-console)
  — the full Verisense control console.
- [ShimmerResearch/shimmer-capture-web](https://github.com/ShimmerResearch/shimmer-capture-web)
  — Shimmer Capture, which took `common/` (the shared UI library nothing else
  here imported) and the `verify.yml` pass with it. `ShimmerCapture/` here is a
  redirect stub; leave it in place, published links point at it.

---

## Live Demos

### Shimmer3R

**Requirements:** Shimmer3R device, firmware ≥ v1.0.22, Chrome/Edge (Web Bluetooth for BLE; Web Serial for Classic Bluetooth/USB)

| Demo                                       | Link                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Gyro breakout game                         | [break-gyro](https://shimmerresearch.github.io/webBLEDemos/break-gyro/)               |
| EMG breakout game                          | [break-emg](https://shimmerresearch.github.io/webBLEDemos/break-emg/)                 |
| 200 G accel punch detector                 | [punch-highG](https://shimmerresearch.github.io/webBLEDemos/punch-highG/)             |
| EMG + Gyro rhythm game                     | [rythmgame-emggyro](https://shimmerresearch.github.io/webBLEDemos/rythmgame-emggyro/) |
| PPG heart-rate visualiser                  | [video-ppg](https://shimmerresearch.github.io/webBLEDemos/video-ppg/)                 |
| Two-device gyro brick game                 | [brick](https://shimmerresearch.github.io/webBLEDemos/brick/)                         |
| Spell caster (gyro gestures)               | [spell-gyro](https://shimmerresearch.github.io/webBLEDemos/spell-gyro/)               |
| Consensys trial export + Bluetooth RTC set | [consensys-export](https://shimmerresearch.github.io/webBLEDemos/consensys-export/)   |

**Consensys Export** packages a logged Shimmer3/Shimmer3R trial into the Consensys import folder structure, zips it, and shares it. It also sets the device real-time clock over Bluetooth. Best on a Chromium browser (Chrome/Edge); on iPhone/iPad use the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) app for the Bluetooth RTC feature.

**Shimmer Capture** — configure, stream, plot, record, browse the SD card,
set device names, run the factory self-test and measure clock drift on a single
Shimmer3R, over BLE, Classic Bluetooth or USB-C. It moved to its own repository:
[shimmer-capture-web](https://github.com/ShimmerResearch/shimmer-capture-web),
live at
[shimmerresearch.github.io/shimmer-capture-web](https://shimmerresearch.github.io/shimmer-capture-web/).

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

Every page imports the SDK from the shared `vendor/` directory at the
repository root, e.g. `../vendor/shimmer-web-sdk.esm.js`. The Chrome extension
keeps its own copy at `shimmer-extension/vendor/` because only that folder is
packed for the store — see `vendor/README.md`. The file that controls where
vendor artifacts come from is `sdk-source.json`:

```json
{
  "sourceMode": "local-repo",
  "version": "0.1.11"
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
import { Shimmer3RClient } from "../vendor/shimmer-web-sdk.esm.js";
```

This means:

- Local development uses the vendored SDK file without external CDN dependency.
- GitHub Pages deployments also resolve the same path under the published `webBLEDemos` site.
- The demos work on GitHub Pages as long as vendored SDK files are committed with the site.

The Verisense demo is no different — it sits one level down like the others:

```js
import { VerisenseBleDevice } from "../vendor/shimmer-web-sdk.esm.js";
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

- `webBLEDemos/vendor` — the shared copy every page imports
- `webBLEDemos/shimmer-extension/vendor` — the Chrome extension's own, which
  cannot import from outside its folder

Build logic is centralized in `shimmer-web-sdk/build-local-sdk.ps1` and invoked by `update-local-sdk.ps1`.

Manual copying into vendor folders is no longer required when you use `update-local-sdk.ps1` or `sync-local-sdk.ps1`.

The SDK source lives at [ShimmerResearch/shimmer-web-sdk](https://github.com/ShimmerResearch/shimmer-web-sdk).
