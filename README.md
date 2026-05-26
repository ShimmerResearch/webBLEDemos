# webBLEDemos

Web Bluetooth demos for Shimmer sensor devices, running entirely in the browser with no native app required.

> **Pre-Alpha Release** — these demos and the SDK are early-stage software. What that means from a support perspective is described [here](https://shimmersensing.com/wp-content/uploads/2022/04/Shimmer-Support-Policy_27.04.2022.pdf). If you encounter technical issues, or would like to express interest in shaping future development, please reach out to the Shimmer support team. If sufficient interest is registered, we may prioritise building a more fully scoped and robust API.

---

## Repository Layout

```
break-gyro/          ┐
break-emg/           │
punch-highG/         │
brick/               │  Shimmer3R demos
rythmgame-emggyro/   │
video-ppg/           │
ShimmerCapture/      │
Verisense/           ┘
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
**Requirements:** Verisense device (IMU or Pulse+), Chrome/Edge

| Demo | Link |
|---|---|
| Wrist sensor (accel + GSR streaming) | [Verisense](https://shimmerresearch.github.io/webBLEDemos/Verisense/) |

### Chrome Extension
[Shimmer3R Chrome Extension](https://github.com/ShimmerEngineering/webBLEDemos/tree/main/shimmer-extension) — source code only; load via **chrome://extensions → Developer mode → Load unpacked**.

---

## `@shimmerresearch/web-ble` SDK

The demos load the SDK directly from the jsDelivr CDN (served from the public GitHub repo):

```js
import { Shimmer3RClient } from 'https://cdn.jsdelivr.net/gh/ShimmerResearch/shimmer-web-sdk@latest/dist/shimmer-ble.esm.js';
```

`@latest` resolves to the most recently tagged release automatically, so new SDK releases are picked up with no changes needed here.

The SDK source lives at [ShimmerResearch/shimmer-web-sdk](https://github.com/ShimmerResearch/shimmer-web-sdk).
