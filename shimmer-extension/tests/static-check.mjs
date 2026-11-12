import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(extensionRoot, "shimmercompanion.html"), "utf8");
const companion = readFileSync(resolve(extensionRoot, "shimmercompanion.js"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));
const visionWorker = readFileSync(resolve(extensionRoot, "vision-worker.js"), "utf8");

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

// Access to a page comes only from the toolbar click (activeTab). Host
// permissions or a content script on every site would bring back the
// "read and change all your data on all websites" warning and the store's
// in-depth review; see README.md.
const permissions = [...(manifest.permissions || [])].sort();
if (permissions.join(",") !== "activeTab,scripting,storage") {
  throw new Error(`Unexpected permissions: ${permissions.join(", ")}. Justify any addition in README.md and PRIVACY.md.`);
}
if (manifest.host_permissions?.length || manifest.optional_host_permissions?.length) {
  throw new Error("The extension must not request host permissions.");
}
if (manifest.content_scripts?.length) {
  throw new Error("The content script is injected on the toolbar click, not declared for every site.");
}
// Every web-accessible file lets any site detect the extension. Only the overlay
// page needs it; the files that page loads are fetched by the extension itself.
const webAccessible = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []);
if (webAccessible.join(",") !== "shimmercompanion.html") {
  throw new Error(`Only shimmercompanion.html may be web-accessible, not: ${webAccessible.join(", ")}`);
}

// The companion and the content script talk through extension messaging only:
// window.postMessage would let the page read the recording timeline and spoof commands.
const contentScript = readFileSync(resolve(extensionRoot, "content.js"), "utf8");
if (/\bpostMessage\s*\(/.test(companion)) {
  throw new Error("shimmercompanion.js must not use window.postMessage; send overlay commands with toHost().");
}
if (/addEventListener\(\s*["']message["']/.test(contentScript)) {
  throw new Error("content.js must not listen for window messages; handle commands in chrome.runtime.onMessage.");
}

const workerSandbox = {
  importScripts() {},
  self: {
    Vision: { FaceLandmarker: {}, FilesetResolver: {} },
    postMessage() {},
    close() {},
  },
};
vm.runInNewContext(`${visionWorker}\n;globalThis.eulerFromMatrixForTest = eulerFromMatrix;`, workerSandbox);

const pitchMatrix = (degrees) => {
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    rows: 4,
    columns: 4,
    // Column-major rotation around the X axis.
    data: [
      1, 0, 0, 0,
      0, cosine, sine, 0,
      0, -sine, cosine, 0,
      0, 0, 0, 1,
    ],
  };
};
const downPose = workerSandbox.eulerFromMatrixForTest(pitchMatrix(20));
const upPose = workerSandbox.eulerFromMatrixForTest(pitchMatrix(-20));
if (Math.abs(downPose.pitch - 20) > 0.001 || Math.abs(upPose.pitch + 20) > 0.001) {
  throw new Error(`MediaPipe pitch direction is inverted (down=${downPose.pitch}, up=${upPose.pitch}).`);
}

const reportTemplate = readFileSync(resolve(extensionRoot, "report_template.html"), "utf8");
const reportScripts = [...reportTemplate.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!reportScripts.length) throw new Error("The report template has no inline script.");
for (const [, source] of reportScripts) new vm.Script(source);

console.log(`Static checks passed (${new Set(referencedIds).size} DOM ids, ${requiredAssets.length} webcam assets).`);
