# Shimmer Companion Chrome extension

Shimmer Companion streams Shimmer3R PPG and GSR data alongside browser media context. A session can include physiological CSV files, timestamped screenshots and events, an HTML report, and optional webcam-derived face-presence data.

All Shimmer3R BLE communication uses the [`shimmer-web-sdk`](https://github.com/ShimmerResearch/shimmer-web-sdk) package. For MV3, the SDK module is vendored inside this extension folder at `vendor/shimmer-web-sdk.esm.js`; rebuild the SDK (`npm install && npm run build`) and copy `dist/shimmer-web-sdk.esm.js` over it when a newer SDK build is required.

## Install for development

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `shimmer-extension` folder.

Reload the extension from `chrome://extensions/` after changing its source files.

## Recording and exports

The extension can record PPG and GSR signals, associate them with the active page and media timeline, capture timestamped screenshots, and generate a session report. Local downloads are available without signing in.

Cloud uploads are split into typed files rather than one large payload:

- GSR and PPG CSV files use the `signals` type.
- Webcam face-presence samples use `vision` and are omitted when webcam analysis was not enabled.
- Screenshot metadata and images use `events` and `screenshots`.
- The generated HTML report and JSON session manifest use `report` and `manifest`.

## Webcam analysis

Webcam analysis is optional and off by default. Select **Enable** in the compact Webcam Analysis section to grant camera access and start local processing.

The extension reports simple observable cues such as face presence, whether the head is facing the screen, head direction, eye state, blink rate, facial movement, and recent actions. These are interaction signals, not medical measurements or reliable inferences of emotion, identity, intent, or mental state.

- Processing runs locally with the vendored MediaPipe Face Landmarker model; frames are not uploaded or saved.
- The default UI shows only compact text values. Camera preview and landmark debugging can be enabled separately.
- When more than one video input is available, a camera selector appears after webcam access is enabled. Changing it restarts analysis with that exact camera, and the choice is remembered locally. If the selected camera is later unavailable, the extension falls back to Chrome's default camera.
- The preview is hidden during the immersive fullscreen experience.
- When recording, only timestamped face presence is included in `vision.csv` and the report. The richer cues remain live-only. If webcam analysis is never enabled, webcam-specific export files and report sections are omitted.
- Reports align physiological signals with both session and media time, show the active media title, and flag inferred pauses, resumes, and seeks.
- Stopping webcam analysis releases the camera track and collapses the UI to one row.

For best results, use even front lighting, keep the face reasonably centered, and position a 1080p webcam around eye level. Analysis is intentionally limited to about 10 frames per second to leave CPU capacity for BLE streaming and charts.

## ASM Cloud uploads

The **Server** field expects the tenant-specific API origin in the form `https://XXXXapi.verisense.net`. This is intentionally a placeholder; the extension does not contain a default production server.

The compatible ASM Cloud deployment must provide:

- `POST /api/auth/sign_in` for participant authentication.
- `POST /api/neurolynq/upload_urls` for batched presigned S3 PUT URLs.
- Support for the file types `signals`, `vision`, `screenshots`, `events`, `manifest`, and `report`.
- Tenant-bucket CORS permission for `PUT` requests from the extension origin `chrome-extension://iopbgbojjmclpdbfblghdnndnkjnocnb`.

The extension ID is pinned by the `key` in `manifest.json`, so the CORS origin remains stable across unpacked installations. CORS setup performed only during tenant creation does not update older buckets; existing tenant buckets may need a one-time CORS update.

The API currently accepts at most 200 files in one upload-URL request. A session containing both signals, webcam data, events, a report, and a manifest can therefore contain at most approximately 194 screenshots.

Only generated session artifacts are uploaded. Raw webcam frames are never included.

## Checks

Run the automated checks from this directory:

```powershell
node tests/static-check.mjs
node tests/export-check.mjs
node tests/webcam-camera-check.mjs
```

Third-party versions and license information are listed in `THIRD_PARTY_NOTICES.md`.
