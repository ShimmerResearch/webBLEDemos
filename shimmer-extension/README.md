# Shimmer3R Chrome Extension

A Chrome extension that surfaces Shimmer3R sensor data (GSR, PPG) as an overlay while browsing.

The extension uses the `@shimmerresearch/web-ble` SDK (`../shimmer-ble-sdk/dist/shimmer-ble.esm.js`) for all BLE communication — there is no longer a separate copy of `shimmer3r.js` inside this folder.

## Loading the extension locally

1. Run `cd ../shimmer-ble-sdk && npm install && npm run build` to produce the SDK dist files (required the first time, or after any SDK change).
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select this `shimmer-extension/` folder.
5. The Shimmer companion icon should appear in the Chrome toolbar.
