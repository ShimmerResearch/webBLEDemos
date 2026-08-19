import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cloudSyncSource = readFileSync(new URL("../cloudsync.js", import.meta.url), "utf8");
const cloudSyncModuleUrl = `data:text/javascript;base64,${Buffer.from(cloudSyncSource).toString("base64")}`;
const { buildSessionFiles, uploadSession, DEFAULT_API_BASE } = await import(cloudSyncModuleUrl);
assert.equal(DEFAULT_API_BASE, "");

const baseSession = {
  csvRows: [{ timestamp: "2026-08-02T00:00:00.000Z", tMs: 1000, gsr: 2.5, ppg: 120 }],
  screenshots: [],
  reportHtml: "<html></html>",
  deviceMac: "00:11:22:33:44:55",
  pageInfo: { url: "https://example.test/demo", title: "Demo" },
  canonical: "example.test/demo",
};

const withoutVision = await buildSessionFiles({ ...baseSession, visionRows: [] });
assert.equal(withoutVision.some((file) => file.name.includes("_Vision_")), false);
const manifestWithoutVision = JSON.parse(await withoutVision.find((file) => file.type === "manifest").blob.text());
assert.equal(manifestWithoutVision.visionSampleCount, 0);

const visionRows = [{
  timestamp: "2026-08-02T00:00:00.100Z",
  tMs: 1100,
  videoTime: "0.100",
  facePresent: true,
}];
const withVision = await buildSessionFiles({ ...baseSession, visionRows });
const supportedUploadTypes = new Set(["signals", "vision", "events", "screenshots", "report", "manifest"]);
assert.deepEqual(withVision.filter(file => !supportedUploadTypes.has(file.type)), []);
const visionFile = withVision.find((file) => file.name.includes("_Vision_"));
assert.ok(visionFile);
assert.equal(visionFile.type, "vision");
const visionCsv = await visionFile.blob.text();
assert.match(visionCsv, /Timestamp,Elapsed \(s\),Video Time \(s\),Face Present/);
assert.match(visionCsv, /,1$/m);
assert.doesNotMatch(visionCsv, /Attention|Facing Score|Blink|Iris|Screen X/);
const manifestWithVision = JSON.parse(await withVision.find((file) => file.type === "manifest").blob.text());
assert.equal(manifestWithVision.visionSampleCount, 1);

const originalFetch = globalThis.fetch;
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage: (_message, callback) => callback({ ok: true, url: "https://example.test/demo", title: "Demo" }),
  },
};
globalThis.fetch = async (url, options) => {
  if (options?.method === "POST") {
    const request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        IsSuccess: true,
        Entity: { Files: request.Files.map(file => ({ FileName: file.FileName, UploadUrl: "https://storage.example.test/upload" })) },
      }),
    };
  }
  throw new TypeError("Failed to fetch");
};
await assert.rejects(
  uploadSession({
    auth: { apiBase: "https://tenantapi.verisense.net", token: "token" },
    deviceMac: "00:11:22:33:44:55",
    session: { ...baseSession, visionRows },
  }),
  /Could not upload .* to storage\.example\.test.*presigned storage URL.*Failed to fetch/
);
globalThis.fetch = originalFetch;

console.log("Conditional webcam export checks passed.");
