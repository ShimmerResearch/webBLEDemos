# webBLEDemos

These examples are pre-alpha releases. See the [Shimmer support policy](https://shimmersensing.com/wp-content/uploads/2022/04/Shimmer-Support-Policy_27.04.2022.pdf) for what that means. If you encounter a technical issue or would like to help shape future development, please contact our support team.

If sufficient interest is registered, we may prioritize building a more fully scoped and robust API.

## Migration notice
In the next 4–8 weeks, we plan to migrate to [`shimmer-web-sdk`](https://github.com/ShimmerResearch/shimmer-web-sdk) as a replacement for `shimmer3r.js` and `verisense.js`.
Migration work has already started on the [`copilot/restructure-repo-for-api-support`](https://github.com/ShimmerResearch/webBLEDemos/tree/copilot/restructure-repo-for-api-support) branch.

## Shimmer3R demos

### Requirements

- Shimmer3R
- FW Version >= v1.0.22

[Gyro Example](https://shimmerresearch.github.io/webBLEDemos/break-gyro/)

[EMG Example](https://shimmerresearch.github.io/webBLEDemos/break-emg/)

[200G Accel Example](https://shimmerresearch.github.io/webBLEDemos/punch-highG/)

[EMG+GYRO Example](https://shimmerresearch.github.io/webBLEDemos/rythmgame-emggyro/)

[PPG Example](https://shimmerresearch.github.io/webBLEDemos/video-ppg/)

[Two Gyro Example](https://shimmerresearch.github.io/webBLEDemos/brick/)

[Spell Caster — Gyro Demo](https://shimmerresearch.github.io/webBLEDemos/spell-gyro/)

[Shimmer Capture](https://shimmerresearch.github.io/webBLEDemos/ShimmerCapture/)

[Shimmer Companion Chrome extension](./shimmer-extension/) — a locally loaded Chrome extension for streaming PPG and GSR, capturing screenshots and media context, generating session reports, and optionally adding on-device webcam face/head-state analysis. It supports selecting between multiple cameras and uploading session files to a compatible ASM Cloud deployment. See the [extension README](./shimmer-extension/README.md) for installation, privacy, export, and server requirements.

[Consensys Export](https://shimmerresearch.github.io/webBLEDemos/consensys-export/) — package a logged Shimmer3/Shimmer3R trial into the Consensys import folder structure, zip it, and share. Also sets the device real-time clock over Bluetooth. Best on a Chromium browser (Chrome/Edge); on iPhone/iPad use the [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) app for the Bluetooth RTC feature.

[RTC Drift Test](https://shimmerresearch.github.io/webBLEDemos/rtc-drift-test/) — measure the Shimmer3R real-world-clock drift against the host clock (DEV-866 32k crystal investigation). Samples the device RTC over the dock UART (Web Serial, preferred — lower jitter) or BLE and least-squares fits the drift slope in ppm, with NTP host-step detection and CSV export. Requires the vendored SDK (`shimmer-extension/vendor/`, ≥ v0.1.10 for the BLE path — run `./sync-local-sdk.ps1` locally).

## Verisense demos

# Requirements
- Verisense

[Wrist Sensor Example](https://shimmerresearch.github.io/webBLEDemos/Verisense/)
