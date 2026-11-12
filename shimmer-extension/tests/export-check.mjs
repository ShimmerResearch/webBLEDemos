import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cloudSyncSource = readFileSync(new URL("../cloudsync.js", import.meta.url), "utf8");
const cloudSyncModuleUrl = `data:text/javascript;base64,${Buffer.from(cloudSyncSource).toString("base64")}`;
const {
  buildSessionFiles, uploadSession, signIn, signOut, getAuth, getSignInDefaults,
  normalizeApiBase, stripUrlQuery, csvText, DEFAULT_API_BASE,
} = await import(cloudSyncModuleUrl);
assert.equal(DEFAULT_API_BASE, "");

// Page titles in CSV: quoted, and a leading = + - @ cannot run as a formula.
assert.equal(csvText("Plain title"), "Plain title");
assert.equal(csvText("Title, with comma"), '"Title, with comma"');
assert.equal(csvText("=1+1"), "'=1+1");
assert.equal(csvText("-5"), "'-5");
assert.equal(csvText("@SUM(A1)"), "'@SUM(A1)");
assert.equal(csvText('=HYPERLINK("https://x.test","y")'), '"\'=HYPERLINK(""https://x.test"",""y"")"');
assert.equal(csvText(null), "");

// Sign-in storage: the token lives in chrome.storage.session only. Server and
// email are kept in chrome.storage.local to prefill the form; an older version's
// token left in local storage is removed.
{
  const areas = { local: {}, session: {} };
  const area = (name) => ({
    get: (keys, callback) => callback(Object.fromEntries(keys.filter((k) => k in areas[name]).map((k) => [k, areas[name][k]]))),
    set: (items, callback) => { Object.assign(areas[name], items); callback(); },
    remove: (key, callback) => { delete areas[name][key]; callback(); },
  });
  const savedChrome = globalThis.chrome;
  const savedFetch = globalThis.fetch;
  globalThis.chrome = { storage: { local: area("local"), session: area("session") } };

  areas.local.neurolynqAuth = { apiBase: "https://oldapi.verisense.net", login: "p@example.test", token: "old-token" };
  assert.equal(await getAuth(), null, "an old local token does not count as signed in");
  assert.equal("neurolynqAuth" in areas.local, false, "the old local token is deleted");
  assert.deepEqual(await getSignInDefaults(), { apiBase: "https://oldapi.verisense.net", login: "p@example.test" });

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ AccesToken: "new-token", ParticipantId: "42" }) });
  const auth = await signIn("https://tenantapi.verisense.net", "p@example.test", "pw");
  assert.equal(auth.token, "new-token");
  assert.equal(areas.session.neurolynqAuth.token, "new-token");
  assert.equal(JSON.stringify(areas.local).includes("new-token"), false, "no token in local storage");
  assert.deepEqual(areas.local.neurolynqSignInDefaults, { apiBase: "https://tenantapi.verisense.net", login: "p@example.test" });
  assert.equal((await getAuth()).token, "new-token");

  await signOut();
  assert.equal(await getAuth(), null);
  assert.equal((await getSignInDefaults()).login, "p@example.test", "the email is still prefilled after signing out");

  globalThis.chrome = savedChrome;
  globalThis.fetch = savedFetch;
}

// Only https://…verisense.net servers receive credentials.
assert.equal(normalizeApiBase(" https://TenantAPI.verisense.net/ "), "https://tenantapi.verisense.net");
for (const refused of [
  "",
  "tenantapi.verisense.net",
  "http://tenantapi.verisense.net",
  "https://verisense.net.example.com",
  "https://tenantapi.verisense.net.example.com",
  "https://evil.example/tenantapi.verisense.net",
  "https://user:pass@tenantapi.verisense.net",
  "https://tenantapi.verisense.net:8443",
  "https://notverisense.net",
]) {
  assert.throws(() => normalizeApiBase(refused), /https:\/\/…verisense\.net/, refused);
}
{
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error("should not be called"); };
  await assert.rejects(signIn("http://tenantapi.verisense.net", "a@example.test", "pw"), /https:\/\/…verisense\.net/);
  assert.equal(fetched, false, "a refused server must not receive the password");
  globalThis.fetch = realFetch;
}

assert.equal(stripUrlQuery("https://example.test/watch?v=abc&token=secret#t=10"), "https://example.test/watch");
assert.equal(stripUrlQuery("not a url"), "");

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

// The uploaded manifest keeps the page address without its query string or fragment.
const withQuery = await buildSessionFiles({
  ...baseSession,
  visionRows: [],
  pageInfo: { url: "https://example.test/demo?q=private+search&session=abc#frag", title: "Demo" },
});
const manifestWithQuery = JSON.parse(await withQuery.find((file) => file.type === "manifest").blob.text());
assert.equal(manifestWithQuery.content.url, "https://example.test/demo");

// A page title in the uploaded events CSV cannot run as a spreadsheet formula.
const withFormulaTitle = await buildSessionFiles({
  ...baseSession,
  visionRows: [],
  screenshots: [{
    timestamp: "2026-08-02T00:00:00.200Z", tMs: 1200, reason: "periodic", videoTime: "0.2",
    title: '=HYPERLINK("https://x.test","click")', file: "shot_0001.jpg", dataUrl: "data:image/jpeg;base64,AAAA",
  }],
});
const eventsCsv = await withFormulaTitle.find((file) => file.type === "events").blob.text();
assert.match(eventsCsv, /,"'=HYPERLINK\(""https:\/\/x\.test"",""click""\)",shot_0001\.jpg$/m);

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

// A plain-http upload URL from the server is refused before any upload.
globalThis.fetch = async (url, options) => {
  if (options?.method === "POST") {
    const request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        IsSuccess: true,
        Entity: { Files: request.Files.map(file => ({ FileName: file.FileName, UploadUrl: "http://storage.example.test/upload" })) },
      }),
    };
  }
  throw new Error("an http upload URL must not be used");
};
await assert.rejects(
  uploadSession({
    auth: { apiBase: "https://tenantapi.verisense.net", token: "token" },
    deviceMac: "00:11:22:33:44:55",
    session: { ...baseSession, visionRows },
  }),
  /non-HTTPS upload URL/
);

// A sign-in saved before the server check, pointing elsewhere, is refused.
await assert.rejects(
  uploadSession({
    auth: { apiBase: "http://tenantapi.verisense.net", token: "token" },
    deviceMac: "00:11:22:33:44:55",
    session: { ...baseSession, visionRows },
  }),
  /Sign out and sign in again/
);
globalThis.fetch = originalFetch;

console.log("Conditional webcam export checks passed.");
