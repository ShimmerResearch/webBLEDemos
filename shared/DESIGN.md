# Shimmer Web BLE Demos — Design System Guide

The suite uses the **Consensys Design System** — a web recreation of Shimmer's
Consensys desktop instrument UI. LIGHT theme: white surfaces, thin grey
hairline borders, grey text, UPPERCASE control/section labels, square 2px
corners, Shimmer orange `#F15D22` accents, Carlito (Calibri-metric) type.

Apps link **only** `../shared/shimmer-ui.css`; it `@import`s
`consensys/styles.css` (tokens + vendored Carlito woff2). Use the `--cs-*`
tokens in any local CSS — **never** the DS's internal `cs-*` component classes.

## Golden rules

- **DO NOT** change any JavaScript logic, event wiring, or BLE/Shimmer code.
- **DO NOT** rename or remove element `id`s — the JS depends on them.
- Only change **markup structure/classes** and CSS. Runtime behavior must stay
  identical. Keep every existing `id`; wrap rather than rewrite.
- Trim ad-hoc `<style>` down to app-specific bits (canvas sizing, game logic
  visuals) written with `--cs-*` tokens.

## Idiom rules

- Page chrome is **LIGHT**: white panels, hairline borders (`--cs-border` /
  `--cs-border-strong`), no shadows/glows.
- Buttons and section titles are **UPPERCASE**; active/selected = orange,
  inactive = grey. Values use `--cs-text-strong`, labels use `--cs-text`.
- Square corners everywhere (`--cs-radius: 2px`).
- **Exception — intentional dark insets:** `.console` and `.game-frame` stay
  dark (dark canvas framed by the light instrument panel is the desired look).
  Hairline border, no glow.

## `<head>` boilerplate

Keep the app's existing GA4 snippet at the top, then:

```html
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="description" content="One-line description of this demo." />
<title>App Name · Shimmer Web BLE Demos</title>
<link rel="icon" type="image/svg+xml" href="../shared/favicon.svg" />
<link rel="stylesheet" href="../shared/shimmer-ui.css" />
```

(From the repo-root `index.html`, use `shared/…` paths instead of `../shared/…`.)

## Per-app accent

Chrome stays light and grey; the accent is **trim only** (badges, `.game-frame`
top trim). Optionally set on `<body>`:

```html
<body style="--accent:#0081C6; --accent-2:#006CA6">
```

Default (unset) = Shimmer orange `#F15D22`. Do not theme whole panels with it.

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
<main class="app-main"><!-- app content --></main>
```

## Toolbar + status + console

Map existing buttons/IDs onto these classes (keep the IDs!). Button text is
auto-uppercased by CSS — don't rewrite labels.

```html
<div class="card">
  <h3>Device</h3>  <!-- first h3 in .card renders as uppercase title row -->
  <div class="toolbar">
    <button id="scanBtn" class="btn btn-primary">Scan</button>
    <button id="configureBtn" class="btn btn-secondary" disabled>Configure</button>
    <button id="streamBtn" class="btn btn-success" disabled>Start Streaming</button>
    <button id="disconfigureBtn" class="btn btn-danger" disabled>Disconnect</button>
    <span class="spacer"></span>
    <span id="statusPill" class="status-pill is-idle">Idle</span>
  </div>
  <p id="deviceName" class="muted" style="margin-top:12px">No device selected</p>
  <pre id="consoleOutput" class="console" aria-live="polite"></pre>
</div>
```

Variants: Scan = `btn-primary` (orange), Configure/util = `btn-secondary`
(grey outline), Start Streaming = `btn-success`, Disconnect = `btn-danger`.
Small: add `btn-sm`. Status states: `is-idle`, `is-connecting`, `is-connected`,
`is-streaming`, `is-error` (connecting/streaming pulse; reduced-motion safe).

## Modal / intro overlay

Hidden by default; reveal by removing `hidden` (`el.hidden = false`) or
toggling `.is-open`. If the app's JS toggles `style.display`, keep that JS —
just restyle the markup with these classes.

```html
<div id="introOverlay" class="overlay" hidden role="dialog" aria-modal="true">
  <div class="overlay-panel">
    <h2>App Name</h2>
    <ul><li>Scan → Configure → Start Streaming</li></ul>
    <div class="overlay-foot">
      <label><input type="checkbox" id="dontShowAgain"> Don't show again</label>
      <button id="closeIntroBtn" class="btn btn-primary">Got it!</button>
    </div>
  </div>
</div>
```

## Game canvas

```html
<div class="game-frame"><canvas id="game"></canvas></div>
```

## Other components

- `.card` — instrument panel (leading `h2/h3` becomes the uppercase title row).
- `.row` / `.stack` — flex helpers. `.muted`, `.badge` (sensor tags), `.kbd`.
- Form controls (`input`, `select`, `range`, `checkbox`) styled globally.
