// Builds the Chrome Web Store upload: a ZIP of the files the extension runs,
// listed below, with the manifest's "key" removed.
//
//   node tools/package.mjs [output-directory]
//
// The default output is dist/shimmer-companion-<version>.zip. The folder itself
// is never zipped whole: it also holds tests, source maps, unused SDK and
// MediaPipe builds, and any local editor or Claude Code settings.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSZip = createRequire(import.meta.url)("../jszip.min.js");

// Every file the extension loads at run time. A file the code starts loading
// must be added here; findUnlistedReferences() fails the build if it is not.
export const PACKAGE_FILES = [
  "background.js",
  "content.js",
  "shimmercompanion.html",
  "shimmercompanion.js",
  "cloudsync.js",
  "webcam.js",
  "vision-worker.js",
  "report_template.html",
  "chart.min.js",
  "jszip.min.js",
  "vendor/shimmer-web-sdk.esm.js",
  "vendor/mediapipe/vision_bundle.js",
  "vendor/mediapipe/models/face_landmarker.task",
  // FilesetResolver.forVisionTasks() without useModule loads these two pairs
  // (SIMD, or the fallback without it), never vision_wasm_module_internal.
  "vendor/mediapipe/wasm/vision_wasm_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_internal.wasm",
  "vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
  "THIRD_PARTY_NOTICES.md",
];

/** Files in the extension folder that shipped code names but the list leaves out. */
export function findUnlistedReferences(root = extensionRoot) {
  const listed = new Set(PACKAGE_FILES);
  const unlisted = new Set();
  const reference = /["'`](?:\.\/)?([\w-]+(?:\/[\w.-]+)*\.(?:js|mjs|html|css|json|wasm|task|png|svg))["'`?]/g;
  for (const file of PACKAGE_FILES.filter((f) => /\.(js|html)$/.test(f) && !f.startsWith("vendor/") && !f.endsWith(".min.js"))) {
    for (const [, path] of readFileSync(join(root, file), "utf8").matchAll(reference)) {
      if (!listed.has(path) && existsSync(join(root, path)) && path !== "manifest.json") unlisted.add(`${path} (named in ${file})`);
    }
  }
  return [...unlisted];
}

/** The manifest as uploaded: no "key", which only pins the ID of unpacked installs. */
export function storeManifest(root = extensionRoot) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  delete manifest.key;
  return manifest;
}

export async function buildPackage({ root = extensionRoot, outDir = join(root, "dist") } = {}) {
  const missing = PACKAGE_FILES.filter((file) => !existsSync(join(root, file)));
  if (missing.length) throw new Error(`Listed files are missing: ${missing.join(", ")}`);
  const unlisted = findUnlistedReferences(root);
  if (unlisted.length) throw new Error(`Add these to PACKAGE_FILES in tools/package.mjs: ${unlisted.join("; ")}`);

  const manifest = storeManifest(root);
  const warnings = [];
  const icons = manifest.icons || {};
  if (!icons["128"]) warnings.push('manifest.json has no 128 px icon ("icons": {"128": ...}); the Web Store requires one.');
  for (const icon of Object.values(icons)) {
    if (!existsSync(join(root, icon))) throw new Error(`Icon ${icon} is declared in manifest.json but missing.`);
  }

  const zip = new JSZip();
  zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of [...PACKAGE_FILES, ...Object.values(icons)]) zip.file(file, readFileSync(join(root, file)));
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });

  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `shimmer-companion-${manifest.version}.zip`);
  writeFileSync(zipPath, data);
  return { zipPath, bytes: data.length, files: Object.keys(zip.files).filter((name) => !zip.files[name].dir), manifest, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const outDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const result = await buildPackage({ outDir });
  const sdk = readFileSync(join(extensionRoot, "vendor/shimmer-web-sdk.esm.js"), "utf8").match(/SDK_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  console.log(`Wrote ${result.zipPath}`);
  console.log(`  ${result.files.length} files, ${(result.bytes / 1e6).toFixed(1)} MB, version ${result.manifest.version}${sdk ? `, shimmer-web-sdk ${sdk}` : ""}`);
  for (const warning of result.warnings) console.warn(`  Warning: ${warning}`);
}
