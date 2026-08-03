import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const webcamSource = readFileSync(new URL("../webcam.js", import.meta.url), "utf8");
const webcamModuleUrl = `data:text/javascript;base64,${Buffer.from(webcamSource).toString("base64")}`;
const { WebcamAnalysis } = await import(webcamModuleUrl);

const requests = [];
let currentDeviceId = "internal-camera";
const makeStream = () => {
  const track = {
    stop() {},
    getSettings: () => ({ deviceId: currentDeviceId }),
  };
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        requests.push(constraints);
        currentDeviceId = constraints.video.deviceId?.exact || "internal-camera";
        return makeStream();
      },
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "microphone", label: "Microphone" },
        { kind: "videoinput", deviceId: "internal-camera", label: "Internal Camera" },
        { kind: "videoinput", deviceId: "external-camera", label: "Logitech Camera" },
      ],
    },
  },
});

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: "test" }),
    getURL: (path) => `chrome-extension://test/${path}`,
  },
};
globalThis.Worker = class {
  postMessage() {}
  terminate() {}
};

const video = {
  srcObject: null,
  async play() {},
  pause() {},
};
const canvas = { width: 0, height: 0, getContext: () => ({ clearRect() {} }) };
const webcam = new WebcamAnalysis({ video, canvas, onState() {}, onError() {} });

await webcam.start("external-camera");
assert.equal(requests[0].video.deviceId.exact, "external-camera");
assert.equal("facingMode" in requests[0].video, false);
assert.equal(webcam.activeDeviceId, "external-camera");
assert.deepEqual((await webcam.listCameras()).map(({ deviceId }) => deviceId), ["internal-camera", "external-camera"]);
webcam.stop();

await webcam.start();
assert.equal(requests[1].video.facingMode, "user");
assert.equal("deviceId" in requests[1].video, false);
webcam.stop();

console.log("Webcam camera-selection checks passed.");
