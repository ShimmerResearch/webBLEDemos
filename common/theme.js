/**
 * Light/dark theme plumbing for the webBLEDemos pages.
 *
 * Extracted from verisense-device-console: the pre-paint bootstrap in
 * `index.html` (L12-36) and the header toggle in `console-ui.js` (L4-22).
 *
 * Nothing here touches `document` at import time — the bootstrap is exported
 * as a *string* for the page to inline in <head>, and everything else runs
 * only when called.
 *
 *   import { THEME_BOOTSTRAP_SNIPPET, initThemeToggle } from "../common/theme.js";
 */

/** localStorage key holding an explicit light/dark choice. */
export const THEME_STORAGE_KEY = "uiTheme";

/** Event name dispatched on `document` whenever the theme changes. */
export const THEME_CHANGE_EVENT = "ui-theme-change";

/** `<meta name="theme-color">` values. These mirror --bg in theme.css. */
export const THEME_COLORS = Object.freeze({
  light: "#f4f6f8",
  dark: "#0d1117",
});

/**
 * The inline <head> script, as source text.
 *
 * Paste it into a page's <head> inside a plain `<script>` — NOT a module, and
 * NOT an external file: it has to run before the first paint, or the page
 * flashes the wrong theme while the module graph loads.
 *
 *     <script>/* … THEME_BOOTSTRAP_SNIPPET … *\/</script>
 *
 * An explicit choice (localStorage "uiTheme") wins; otherwise it follows the
 * OS preference. Deliberately duplicates a little of setTheme() below rather
 * than importing anything, because at that point nothing has loaded yet.
 */
export const THEME_BOOTSTRAP_SNIPPET = `(function () {
  var theme = "light";
  try {
    var saved = localStorage.getItem("uiTheme");
    if (saved === "dark" || saved === "light") theme = saved;
    else if (window.matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  } catch (e) {}
  document.documentElement.dataset.theme = theme;
  // Keep the browser chrome (mobile address bar, installed-app title bar) in
  // step with the page theme. Values mirror --bg in common/theme.css.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#0d1117" : "#f4f6f8";
})();`;

/**
 * The theme currently applied to the document.
 *
 * Reads `data-theme` rather than storage, so it is correct on a page that
 * never ran the bootstrap (falls back to the OS preference, then light).
 *
 * @returns {"light"|"dark"}
 */
export function getTheme() {
  const attr = document.documentElement.dataset.theme;
  if (attr === "dark" || attr === "light") return attr;
  try {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches)
      return "dark";
  } catch {
    /* matchMedia missing — fall through to light */
  }
  return "light";
}

/**
 * Apply a theme, persist the choice, and broadcast the change.
 *
 * @param {"light"|"dark"} theme
 * @returns {"light"|"dark"} the theme actually applied
 */
export function setTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* private mode / storage disabled — the theme still applies for this
       page view, it just will not be remembered */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[next];
  document.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: next } }),
  );
  return next;
}

/**
 * Wire a header button as the light/dark toggle.
 *
 * The button's glyph shows the theme the click switches TO, which is the
 * convention the console settled on (a sun on a dark page).
 *
 * @param {HTMLElement|string|null} button element, or its id
 * @returns {() => void} detach the listener
 */
export function initThemeToggle(button) {
  const btn =
    typeof button === "string" ? document.getElementById(button) : button;
  if (!btn) return () => {};

  const syncGlyph = () => {
    const label =
      getTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme";
    btn.textContent = getTheme() === "dark" ? "☀︎" : "☾︎";
    btn.setAttribute("aria-label", label);
    /* And a tooltip, because the button is a bare glyph: a sun or a moon on
       its own is a guess until you have clicked it once. The console has had
       one from the start; these pages had only the aria-label, which a mouse
       user never sees. Dynamic rather than the console's static "Switch
       between light and dark theme" — it says which way the click goes, which
       is the thing the glyph is already trying and failing to say. */
    btn.title = label;
  };

  const onClick = () => {
    setTheme(getTheme() === "dark" ? "light" : "dark");
    syncGlyph();
  };

  btn.classList.add("theme-toggle");
  btn.type = "button";
  btn.addEventListener("click", onClick);
  syncGlyph();
  // Keep the glyph right when some other code calls setTheme().
  document.addEventListener(THEME_CHANGE_EVENT, syncGlyph);

  return () => {
    btn.removeEventListener("click", onClick);
    document.removeEventListener(THEME_CHANGE_EVENT, syncGlyph);
  };
}

/**
 * Subscribe to theme changes. Fires on an explicit toggle and — for a page
 * that has never pinned a theme — on the OS preference flipping, which the
 * CSS follows too (`:root:not([data-theme="light"])`).
 *
 * @param {(theme: "light"|"dark") => void} cb
 * @returns {() => void} unsubscribe
 */
export function onThemeChange(cb) {
  const handler = (e) => cb(e?.detail?.theme ?? getTheme());
  document.addEventListener(THEME_CHANGE_EVENT, handler);

  let mql = null;
  const onOsChange = () => {
    // Only relevant while no explicit choice is stored; once the user picks,
    // the CSS ignores the OS and so should the plot colours.
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      /* unreadable storage — treat as "no explicit choice" */
    }
    if (saved === "dark" || saved === "light") return;
    cb(getTheme());
  };
  try {
    mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", onOsChange);
  } catch {
    mql = null;
  }

  return () => {
    document.removeEventListener(THEME_CHANGE_EVENT, handler);
    mql?.removeEventListener("change", onOsChange);
  };
}
