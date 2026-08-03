# Shimmer Companion Chrome extension

Note that `shimmer3r.js` is copied from the ShimmerAPI folder. Replace it when a newer API build is required.

## Install for development

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `shimmer-extension` folder.

Reload the extension from `chrome://extensions/` after changing its source files.

## Webcam analysis

Webcam analysis is optional and off by default. Select **Enable** in the compact Webcam Analysis section to grant camera access and start local processing.

The extension reports simple observable cues such as face presence, whether the head is facing the screen, head direction, eye state, blink rate, facial movement, and recent actions. These are interaction signals, not medical measurements or reliable inferences of emotion, identity, intent, or mental state.

- Processing runs locally with the vendored MediaPipe Face Landmarker model; frames are not uploaded or saved.
- The default UI shows only compact text values. Camera preview and landmark debugging can be enabled separately.
- The preview is hidden during the immersive fullscreen experience.
- When recording, only timestamped face presence is included in `vision.csv` and the report. The richer cues remain live-only. If webcam analysis is never enabled, webcam-specific export files and report sections are omitted.
- Reports align physiological signals with both session and media time, show the active media title, and flag inferred pauses, resumes, and seeks.
- Stopping webcam analysis releases the camera track and collapses the UI to one row.

For best results, use even front lighting, keep the face reasonably centered, and position a 1080p webcam around eye level. Analysis is intentionally limited to about 10 frames per second to leave CPU capacity for BLE streaming and charts.

Third-party versions and license information are listed in `THIRD_PARTY_NOTICES.md`.
