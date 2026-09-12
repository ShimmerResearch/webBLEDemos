# webBLEDemos

Browser demos for Shimmer devices — no native app, no build step, no bundler. Each demo is a
self-contained directory of static files. Published to GitHub Pages at
`shimmerresearch.github.io/webBLEDemos/`.

## The vendor path that matters
**`vendor/` at the repo root is the one almost everything imports** — 18 of the 19 pages plus
`common/`, ShimmerCapture included. There is no `Verisense/vendor`; a sync script once targeted that
path, threw, and silently left the real `vendor/` un-updated. If a demo is running stale SDK
behaviour, check which vendor directory was actually written.

Update with the scripts, never by hand — they stamp `sdk-source.json`:
```
./sync-local-sdk.ps1      # sync only
./update-local-sdk.ps1    # build the SDK first, then sync
```

## Layout
Shimmer3R demos: `break-gyro/`, `break-emg/`, `punch-highG/`, `brick/`, `rythmgame-emggyro/`,
`video-ppg/`, `spell-gyro/`, `ShimmerCapture/`, `consensys-export/`.
Verisense demo: `Verisense/`. Shared code: `common/`.
`shimmer-extension/` is a Chrome extension source tree — loaded unpacked, not deployed with the pages.

The full Verisense console moved out to `ShimmerResearch/verisense-device-console`; don't rebuild it here.

## Demo requirements
Shimmer3R demos need firmware ≥ v1.0.22 and Chrome/Edge — Web Bluetooth for BLE, Web Serial for
Classic Bluetooth and USB. Keep that stated on any new demo page.

## CI
`verify.yml` and `html-format.yml`.
