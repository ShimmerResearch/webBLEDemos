# Shimmer Web BLE Demos — Design System Guide

Apply the shared design system in `shared/shimmer-ui.css` to each app so the
suite feels like one product. **Style only — never touch behavior.**

## Golden rules

- **DO NOT** change any JavaScript logic, event wiring, or BLE/Shimmer code.
- **DO NOT** rename or remove element `id`s — the JS depends on them.
- Only change **markup structure/classes** and swap ad-hoc `<style>` for shared
  classes. Each app's functionality must stay byte-for-byte identical at runtime.
- Keep every existing `id`. You may add wrapper elements and classes around them.
- Prefer replacing inline `<style>` rules with shared classes; keep app-specific
  rules (canvas sizing, game-specific bits) in a trimmed local `<style>`.

## `<head>` boilerplate

Add/normalize the head. Keep the app's existing GA4 snippet at the top.

```html
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="description" content="One-line description of this demo." />
<title>App Name · Shimmer Web BLE Demos</title>
<link rel="icon" type="image/svg+xml" href="../shared/favicon.svg" />
<link rel="stylesheet" href="../shared/shimmer-ui.css" />
```

Title convention: `App Name · Shimmer Web BLE Demos`.
(From the repo-root `index.html`, use `shared/…` paths instead of `../shared/…`.)

## Per-app accent

Keep each app's identity by setting `--accent` (and optionally `--accent-2` and
`--accent-ink`) on `<body>`. Pick `--accent-ink` to contrast the accent fill.

```html
<body style="--accent:#66fcf1; --accent-2:#45a29e; --accent-ink:#04201f">
```

Default (unset) = Shimmer orange `#F26522`.

## App header (with back-link to the index)

```html
<header class="app-header">
  <a class="brand" href="../">
    <span class="brand-mark"></span>
    <span class="brand-name">Shimmer <span class="brand-sub">Web BLE</span></span>
  </a>
  <span class="app-title">App Name</span>
  <span class="spacer"></span>
  <a class="back-link" href="../">← All demos</a>
</header>
<main class="app-main">
  <!-- app content -->
</main>
```

## Toolbar + status + console

Map existing buttons/IDs onto these classes (keep the IDs!):

```html
<div class="card">
  <div class="toolbar">
    <button id="scanBtn" class="btn btn-primary">🔍 Scan</button>
    <button id="configureBtn" class="btn btn-secondary" disabled>⚙️ Configure</button>
    <button id="streamBtn" class="btn btn-success" disabled>📡 Start Streaming</button>
    <button id="disconfigureBtn" class="btn btn-danger" disabled>❌ Disconnect</button>
    <span class="spacer"></span>
    <span id="statusPill" class="status-pill is-idle"><!-- dot via ::before -->Idle</span>
  </div>
  <p id="deviceName" class="muted" style="margin-top:12px">No device selected</p>
  <pre id="consoleOutput" class="console" aria-live="polite"></pre>
</div>
```

Button variant convention: Scan = `btn-primary`, Configure = `btn-secondary`,
Start Streaming = `btn-success`, Disconnect = `btn-danger`, game/util =
`btn-secondary`. Small buttons add `btn-sm`.

Status pill states (optional — set via JS or leave static `is-idle`):
`is-idle`, `is-connecting`, `is-connected`, `is-streaming`, `is-error`.

## Modal / intro overlay

The overlay is hidden by default. Reveal it by **removing the `hidden`
attribute** (`el.hidden = false`) or by toggling **`.is-open`** — pick whichever
matches the app's existing JS. If the JS currently sets
`style.display = 'flex'/'none'`, keep that JS working by using the `hidden`
attribute pattern (simplest: leave the existing JS and just restyle the panel),
or migrate the JS's display toggles — but only if you can do so without changing
any other logic.

```html
<div id="introOverlay" class="overlay" hidden role="dialog" aria-modal="true">
  <div class="overlay-panel">
    <h2>App Name</h2>
    <p>How to play / use…</p>
    <ul><li>Scan → Configure → Start Streaming</li></ul>
    <div class="overlay-foot">
      <label><input type="checkbox" id="dontShowAgain"> Don't show again</label>
      <button id="closeIntroBtn" class="btn btn-primary">Got it!</button>
    </div>
  </div>
</div>
```

## Game canvas

Wrap game `<canvas>` elements in `.game-frame` for a consistent framed look:

```html
<div class="game-frame"><canvas id="game"></canvas></div>
```

## Other components

- `.card` — surface for grouping content.
- `.row` (flex wrap) / `.stack` (column) — layout helpers.
- `.badge` — sensor tags (GYRO, EMG…). `.kbd` — keyboard hints.
- Form controls (`input`, `select`, `range`, `checkbox`) are styled globally —
  no class needed.

Keep changes minimal and reversible; when in doubt, wrap rather than rewrite.
