import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(extensionRoot, "shimmercompanion.html"), "utf8");
const companion = readFileSync(resolve(extensionRoot, "shimmercompanion.js"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));

const referencedIds = [...companion.matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds)].filter((id) => !html.includes(`id="${id}"`));
if (missingIds.length) throw new Error(`Missing DOM ids: ${missingIds.join(", ")}`);

const requiredAssets = [
  "vision-worker.js",
  "webcam.js",
  "vendor/mediapipe/vision_bundle.js",
  "vendor/mediapipe/wasm/vision_wasm_internal.wasm",
  "vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
  "vendor/mediapipe/models/face_landmarker.task",
];
const missingAssets = requiredAssets.filter((path) => !existsSync(resolve(extensionRoot, path)));
if (missingAssets.length) throw new Error(`Missing webcam assets: ${missingAssets.join(", ")}`);

if (manifest.manifest_version !== 3) throw new Error("The extension must use Manifest V3.");
if (!manifest.content_security_policy?.extension_pages?.includes("wasm-unsafe-eval")) {
  throw new Error("The extension CSP must permit local MediaPipe WebAssembly.");
}

const reportTemplate = readFileSync(resolve(extensionRoot, "report_template.html"), "utf8");
const reportScripts = [...reportTemplate.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!reportScripts.length) throw new Error("The report template has no inline script.");
for (const [, source] of reportScripts) new vm.Script(source);

console.log(`Static checks passed (${new Set(referencedIds).size} DOM ids, ${requiredAssets.length} webcam assets).`);
