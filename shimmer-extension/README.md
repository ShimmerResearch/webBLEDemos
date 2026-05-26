# Shimmer3R Chrome Extension

A Chrome extension that surfaces Shimmer3R sensor data (GSR, PPG) as an overlay while browsing.

The extension uses the `@shimmerresearch/shimmer-web-sdk` SDK for all BLE communication. For MV3, the SDK module must be inside this extension folder at `vendor/shimmer-ble.esm.js`.

## Loading the extension locally

1. Clone the SDK repository:
   ```
   git clone https://github.com/ShimmerResearch/shimmer-web-sdk
   ```
2. Build the SDK:
   ```
   cd shimmer-web-sdk
   npm install
   npm run build
   ```
3. Copy the built ESM file into this extension:
   ```
   cp dist/shimmer-ble.esm.js /path/to/webBLEDemos/shimmer-extension/vendor/shimmer-ble.esm.js
   ```
4. Open Chrome and navigate to `chrome://extensions/`.
5. Enable **Developer mode** (toggle in the top-right corner).
6. Click **Load unpacked** and select this `shimmer-extension/` folder.
7. The Shimmer companion icon should appear in the Chrome toolbar.
