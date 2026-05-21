# webBLEDemos

Web Bluetooth demos and a typed JavaScript/TypeScript SDK for Shimmer sensor devices, running entirely in the browser with no native app required.

> **Pre-Alpha Release** — these demos and the SDK are early-stage software. What that means from a support perspective is described [here](https://shimmersensing.com/wp-content/uploads/2022/04/Shimmer-Support-Policy_27.04.2022.pdf). If you encounter technical issues, or would like to express interest in shaping future development, please reach out to the Shimmer support team. If sufficient interest is registered, we may prioritise building a more fully scoped and robust API.

---

## Repository Layout

```
shimmer-ble-sdk/     ← @shimmerresearch/web-ble — TypeScript SDK (build → dist/)
ShimmerAPI/          ← legacy ES-module source for Shimmer3R (superseded by the SDK)
Verisense/           ← legacy source for Verisense (superseded by the SDK)
examples/            ← updated demo pages that import from the SDK dist
  shimmer3r/         ← Shimmer3R demos
  verisense/         ← Verisense demos
break-gyro/          ┐
break-emg/           │
punch-highG/         │  original standalone demos (still served via GitHub Pages)
brick/               │
rythmgame-emggyro/   │
video-ppg/           │
ShimmerCapture/      ┘
Verisense/           ← original Verisense demo (still served via GitHub Pages)
shimmer-extension/   ← Shimmer3R Chrome extension (source; load unpacked in Chrome)
```

---

## Live Demos

### Shimmer3R
**Requirements:** Shimmer3R device, firmware ≥ v1.0.22, Chrome/Edge (Web Bluetooth required)

| Demo | Link |
|---|---|
| Gyro breakout game | [break-gyro](https://shimmerresearch.github.io/webBLEDemos/break-gyro/) |
| EMG breakout game | [break-emg](https://shimmerresearch.github.io/webBLEDemos/break-emg/) |
| 200 G accel punch detector | [punch-highG](https://shimmerresearch.github.io/webBLEDemos/punch-highG/) |
| EMG + Gyro rhythm game | [rythmgame-emggyro](https://shimmerresearch.github.io/webBLEDemos/rythmgame-emggyro/) |
| PPG heart-rate visualiser | [video-ppg](https://shimmerresearch.github.io/webBLEDemos/video-ppg/) |
| Two-device gyro brick game | [brick](https://shimmerresearch.github.io/webBLEDemos/brick/) |
| Data capture / CSV download | [ShimmerCapture](https://shimmerresearch.github.io/webBLEDemos/ShimmerCapture/) |

### Verisense
**Requirements:** Verisense device (Pulse Plus or GSR Plus), Chrome/Edge

| Demo | Link |
|---|---|
| Wrist sensor (accel + GSR streaming) | [Verisense](https://shimmerresearch.github.io/webBLEDemos/Verisense/) |

### Chrome Extension
[Shimmer3R Chrome Extension](https://github.com/ShimmerEngineering/webBLEDemos/tree/main/shimmer-extension) — source code only; load via **chrome://extensions → Developer mode → Load unpacked**.

---

## `@shimmerresearch/web-ble` SDK

The `shimmer-ble-sdk/` directory contains a TypeScript SDK that consolidates the Shimmer3R and Verisense protocol implementations into a single, testable, publishable package.

### Key features
- **`Shimmer3RClient`** — typed BLE client with ACK-gated command flow, stream parsing, GSR/ExG calibration
- **`VerisenseBleDevice`** — BLE + Web Serial client with per-sensor decoders, CRC validation, and operational config helpers
- **`ObjectCluster`** — shared typed data-frame container used by both device clients
- ESM + UMD bundles and TypeScript declarations in `dist/`
- 59 Vitest unit tests — run without a browser

### Quick build

```bash
cd shimmer-ble-sdk
npm install
npm run build   # → dist/shimmer-ble.esm.js, dist/shimmer-ble.umd.js, dist/shimmer-ble.d.ts
npm test        # run unit tests
```

See [`shimmer-ble-sdk/README.md`](shimmer-ble-sdk/README.md) for full API documentation and usage examples.

