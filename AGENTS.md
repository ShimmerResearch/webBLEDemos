# webBLEDemos

Browser demos for Shimmer devices — no native app, no build step, no bundler. Each demo is a
self-contained directory of static files. Published to GitHub Pages at
`shimmerresearch.github.io/webBLEDemos/`.

## The vendor path that matters

**`vendor/` at the repo root is the one almost every page imports.** There is no
`Verisense/vendor`; a sync script once targeted that path, threw, and silently left the real
`vendor/` un-updated. If a demo is running stale SDK behaviour, check which vendor directory was
actually written.

The same bundle is vendored again in `verisense-device-console` and in `shimmer-capture-web`.
`C:\dev\web\sync-all-vendors.ps1` writes all three; prefer it over this repo's script alone.

Update with the scripts, never by hand — they stamp `sdk-source.json`:

```
./sync-local-sdk.ps1      # sync only
./update-local-sdk.ps1    # build the SDK first, then sync
```

## Layout

Shimmer3R demos: `break-gyro/`, `break-emg/`, `punch-highG/`, `brick/`, `rythmgame-emggyro/`,
`video-ppg/`, `spell-gyro/`, `consensys-export/`.
Verisense demo: `Verisense/`.
`shimmer-extension/` is a Chrome extension source tree — loaded unpacked, not deployed with the pages.
`ShimmerCapture/` is a redirect stub only — the page moved to
[shimmer-capture-web](https://github.com/ShimmerResearch/shimmer-capture-web) and took `common/`,
the shared UI library nothing else here imported, with it. Leave the stub in place; published
links point at it.

## Demo requirements

Shimmer3R demos need firmware ≥ v1.0.22 and Chrome/Edge — Web Bluetooth for BLE, Web Serial for
Classic Bluetooth and USB. Keep that stated on any new demo page.

## CI

`html-format.yml` only. `verify.yml` went to `shimmer-capture-web` with the page it tested.
