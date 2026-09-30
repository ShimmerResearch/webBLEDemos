// Checks the vendored shimmer-web-sdk bundle against the code that uses it.
//
// This repo has no build step and no test suite, so nothing else notices when a
// re-vendor removes or renames an export that a page still imports: the page
// just fails to load in the browser. This loads the vendored bundle in plain
// Node and checks, without a browser or a device:
//
//   1. Every `import { ... } from ".../shimmer-web-sdk.esm.js"` name, and every
//      `sdk.X` on an `import * as sdk from ...` namespace, is an export of the
//      bundle that file imports.
//   2. The bundle's SDK_VERSION matches the version in sdk-source.json.
//   3. Where the repo carries more than one vendor copy, the copies are
//      byte-identical, so a partial sync cannot leave them on different builds.
//
// It finds its own inputs: every directory holding shimmer-web-sdk.esm.js is a
// vendor copy, and every .js, .mjs and .html file outside those directories is
// scanned. Run it with `node tools/check-vendored-sdk.mjs` from anywhere.
//
// The same file is used by verisense-device-console and webBLEDemos; keep the
// two copies identical.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_NAME = "shimmer-web-sdk.esm.js";
const SKIP_DIRS = new Set([".git", "node_modules"]);

const failures = [];
const fail = (message) => failures.push(message);
const rel = (path) => relative(repoRoot, path).split(sep).join("/");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const allFiles = walk(repoRoot);
const vendorDirs = allFiles.filter((path) => path.endsWith(sep + BUNDLE_NAME)).map(dirname);
if (vendorDirs.length === 0) {
  console.error(`No ${BUNDLE_NAME} found under ${repoRoot}.`);
  process.exit(1);
}
const inVendorDir = (path) => vendorDirs.some((dir) => path.startsWith(dir + sep));

// Import each vendor copy once.
const bundles = new Map();
async function loadBundle(bundlePath) {
  if (!bundles.has(bundlePath)) {
    bundles.set(bundlePath, await import(pathToFileURL(bundlePath).href));
  }
  return bundles.get(bundlePath);
}

// 1. Imports and namespace members.
const namedImport = /import\s*\{([^}]*)\}\s*from\s*["']([^"']*shimmer-web-sdk\.esm\.js)["']/g;
const namespaceImport = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']*shimmer-web-sdk\.esm\.js)["']/g;
// A side-effect import, a dynamic import(), or a default import: none of which this can check.
const otherImport = /import\s*(?:\(\s*)?["'][^"']*shimmer-web-sdk\.esm\.js["']|import\s+[A-Za-z_$][\w$]*\s*(?:,[^\n;]*)?\s+from\s*["'][^"']*shimmer-web-sdk\.esm\.js["']/g;

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

let importSites = 0;
let namesChecked = 0;
const sources = allFiles.filter((path) => /\.(m?js|html)$/.test(path) && !inVendorDir(path));

for (const file of sources) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("shimmer-web-sdk")) continue;
  const code = stripComments(text);

  for (const match of code.matchAll(otherImport)) {
    fail(`${rel(file)}: an import this check cannot read (${match[0].trim()}). Use named imports or \`import * as\`.`);
  }

  for (const [, list, specifier] of code.matchAll(namedImport)) {
    const bundlePath = resolve(dirname(file), specifier);
    if (!existsSync(bundlePath)) {
      fail(`${rel(file)}: imports ${specifier}, which does not exist`);
      continue;
    }
    importSites++;
    const bundle = await loadBundle(bundlePath);
    const names = list
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    for (const name of names) {
      namesChecked++;
      if (!(name in bundle)) fail(`${rel(file)}: imports \`${name}\`, which ${rel(bundlePath)} does not export`);
    }
  }

  for (const [, alias, specifier] of code.matchAll(namespaceImport)) {
    const bundlePath = resolve(dirname(file), specifier);
    if (!existsSync(bundlePath)) {
      fail(`${rel(file)}: imports ${specifier}, which does not exist`);
      continue;
    }
    importSites++;
    const bundle = await loadBundle(bundlePath);
    // Not preceded by an identifier character, a dot, or the - and / of a path such as the
    // import's own "shimmer-web-sdk.esm.js".
    const member = new RegExp(`(?<![\\w$./-])${alias.replace(/\$/g, "\\$")}\\??\\.([A-Za-z_$][\\w$]*)`, "g");
    const names = new Set([...code.matchAll(member)].map((m) => m[1]));
    for (const name of names) {
      namesChecked++;
      if (!(name in bundle)) fail(`${rel(file)}: uses \`${alias}.${name}\`, which ${rel(bundlePath)} does not export`);
    }
  }
}

if (importSites === 0) fail(`No file imports ${BUNDLE_NAME}; the scan found nothing to check.`);

// 2. Version.
const sdkSourcePath = join(repoRoot, "sdk-source.json");
const expectedVersion = existsSync(sdkSourcePath) ? JSON.parse(readFileSync(sdkSourcePath, "utf8")).version : undefined;
for (const dir of vendorDirs) {
  const bundle = await loadBundle(join(dir, BUNDLE_NAME));
  if (typeof bundle.SDK_VERSION !== "string") {
    fail(`${rel(dir)}/${BUNDLE_NAME}: exports no SDK_VERSION`);
  } else if (expectedVersion !== undefined && bundle.SDK_VERSION !== expectedVersion) {
    fail(`${rel(dir)}/${BUNDLE_NAME}: SDK_VERSION is ${bundle.SDK_VERSION}, but sdk-source.json says ${expectedVersion}`);
  }
}

// 3. Vendor copies agree.
const bundleFiles = (dir) => readdirSync(dir).filter((name) => name.startsWith("shimmer-web-sdk.")).sort();
const [first, ...others] = vendorDirs;
for (const dir of others) {
  const a = bundleFiles(first);
  const b = bundleFiles(dir);
  if (a.join() !== b.join()) {
    fail(`${rel(first)} and ${rel(dir)} hold different SDK files: [${a.join(", ")}] vs [${b.join(", ")}]`);
    continue;
  }
  for (const name of a) {
    if (!readFileSync(join(first, name)).equals(readFileSync(join(dir, name)))) {
      fail(`${rel(first)}/${name} and ${rel(dir)}/${name} differ; re-run sync-local-sdk.ps1`);
    }
  }
}

const version = bundles.get(join(first, BUNDLE_NAME))?.SDK_VERSION;
console.log(
  `Vendored shimmer-web-sdk ${version ?? "?"}: ${vendorDirs.length} vendor ${vendorDirs.length === 1 ? "copy" : "copies"}, ` +
    `${importSites} import sites, ${namesChecked} names checked.`,
);
if (failures.length) {
  for (const message of failures) console.error(`FAIL ${message}`);
  process.exit(1);
}
console.log("OK");
