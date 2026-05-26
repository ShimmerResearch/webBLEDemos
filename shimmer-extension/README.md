# Shimmer3R Chrome Extension

A Chrome extension that surfaces Shimmer3R sensor data (GSR, PPG) as an overlay while browsing.

The extension uses the `@shimmerresearch/shimmer-web-sdk` SDK (`../shimmer-web-sdk/dist/shimmer-ble.esm.js`) for all BLE communication — there is no longer a separate copy of `shimmer3r.js` inside this folder.

## Loading the extension locally

1. Clone the SDK repository as a sibling directory next to this repo:
   ```
   git clone https://github.com/ShimmerResearch/shimmer-web-sdk
   ```
   The directory layout should look like:
   ```
   webBLEDemos/
   shimmer-web-sdk/
   ```
2. Build the SDK: `cd shimmer-web-sdk && npm install && npm run build`
3. Open Chrome and navigate to `chrome://extensions/`.
4. Enable **Developer mode** (toggle in the top-right corner).
5. Click **Load unpacked** and select this `shimmer-extension/` folder.
6. The Shimmer companion icon should appear in the Chrome toolbar.
