// tools/package.mjs builds the Web Store ZIP from an allowlist: everything the
// extension loads, nothing else, and a manifest without "key".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildPackage, findUnlistedReferences, PACKAGE_FILES } = await import("../tools/package.mjs");
const JSZip = createRequire(import.meta.url)("../jszip.min.js");
const sourceManifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

const outDir = mkdtempSync(join(tmpdir(), "shimmer-companion-"));
try {
  const result = await buildPackage({ outDir });
  const zip = await JSZip.loadAsync(readFileSync(result.zipPath));
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);

  // The manifest is the source one minus "key".
  const shipped = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal("key" in shipped, false, "the store rejects a manifest with a key");
  const { key: _key, ...expected } = sourceManifest;
  assert.deepEqual(shipped, expected);

  // Everything the manifest and the companion need is in it.
  const required = [
    shipped.background.service_worker,
    ...shipped.web_accessible_resources.flatMap((entry) => entry.resources),
    "content.js", // injected by background.js on the toolbar click
    "vendor/mediapipe/wasm/vision_wasm_internal.wasm",
    "vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
    "vendor/mediapipe/models/face_landmarker.task",
  ];
  assert.deepEqual(required.filter((file) => !names.includes(file)), []);

  // Nothing that only belongs to development.
  const stray = names.filter((name) =>
    /^(tests|tools|dist|\.claude|\.vscode)\//.test(name) || /\.(map|cjs|d\.ts|pem)$/.test(name)
    || /\.umd\.js$/.test(name) || name === "ble.html" || name.includes("vision_wasm_module_internal"));
  assert.deepEqual(stray, []);
  assert.equal(names.length, PACKAGE_FILES.length + 1 + Object.keys(shipped.icons || {}).length);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// A file the code loads but the allowlist forgets fails the build.
assert.deepEqual(findUnlistedReferences(), []);
const index = PACKAGE_FILES.indexOf("webcam.js");
PACKAGE_FILES.splice(index, 1);
try {
  assert.match(findUnlistedReferences().join("\n"), /^webcam\.js \(named in shimmercompanion\.js\)$/m);
} finally {
  PACKAGE_FILES.splice(index, 0, "webcam.js");
}

console.log("Package checks passed (allowlisted files only, manifest without key).");
