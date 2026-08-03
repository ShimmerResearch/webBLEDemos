// MediaPipe's WebAssembly bootstrap still calls importScripts internally, so
// this worker must be classic rather than a module worker. The vendored IIFE
// bundle exposes the same API on self.Vision.
importScripts("./vendor/mediapipe/vision_bundle.js");
const { FaceLandmarker, FilesetResolver } = self.Vision;

let landmarker = null;
let debugLandmarks = false;
let previousAnchor = null;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const radiansToDegrees = (value) => value * 180 / Math.PI;

function blendshapeMap(result) {
  const categories = result.faceBlendshapes?.[0]?.categories || [];
  const map = Object.create(null);
  for (const category of categories) map[category.categoryName] = category.score;
  return map;
}

function eulerFromMatrix(matrix) {
  const m = matrix?.data;
  if (!m || m.length < 11) return null;

  // MediaPipe exposes the canonical-face transform in column-major order.
  const pitch = Math.atan2(m[6], m[10]);
  const yaw = Math.asin(clamp(-m[2], -1, 1));
  const roll = Math.atan2(m[1], m[0]);
  return {
    yaw: radiansToDegrees(yaw),
    pitch: radiansToDegrees(pitch),
    roll: radiansToDegrees(roll),
  };
}

function fallbackPose(landmarks) {
  const nose = landmarks[1];
  const left = landmarks[234];
  const right = landmarks[454];
  const forehead = landmarks[10];
  const chin = landmarks[152];
  if (!nose || !left || !right || !forehead || !chin) return { yaw: 0, pitch: 0, roll: 0 };

  const faceWidth = Math.max(0.001, Math.abs(right.x - left.x));
  const faceHeight = Math.max(0.001, Math.abs(chin.y - forehead.y));
  const centerX = (left.x + right.x) / 2;
  const centerY = (forehead.y + chin.y) / 2;
  return {
    yaw: clamp((nose.x - centerX) / faceWidth * 90, -45, 45),
    pitch: clamp((nose.y - centerY) / faceHeight * 70, -35, 35),
    roll: 0,
  };
}

function motionScore(landmarks, timestampMs) {
  const nose = landmarks[1];
  const left = landmarks[234];
  const right = landmarks[454];
  if (!nose || !left || !right) return 0;

  const width = Math.max(0.001, Math.abs(right.x - left.x));
  const anchor = { x: nose.x, y: nose.y, width, timestampMs };
  if (!previousAnchor) {
    previousAnchor = anchor;
    return 0;
  }

  const dx = anchor.x - previousAnchor.x;
  const dy = anchor.y - previousAnchor.y;
  const scaleChange = Math.abs(anchor.width - previousAnchor.width);
  const normalized = (Math.hypot(dx, dy) + scaleChange * 0.5) / width;
  previousAnchor = anchor;
  return clamp(normalized, 0, 1);
}

function simplifyResult(result, timestampMs) {
  const landmarks = result.faceLandmarks?.[0];
  if (!landmarks?.length) {
    previousAnchor = null;
    return { facePresent: false, timestampMs };
  }

  const shapes = blendshapeMap(result);
  const pose = eulerFromMatrix(result.facialTransformationMatrixes?.[0]) || fallbackPose(landmarks);
  const blinkLeft = shapes.eyeBlinkLeft || 0;
  const blinkRight = shapes.eyeBlinkRight || 0;
  const smileLeft = shapes.mouthSmileLeft || 0;
  const smileRight = shapes.mouthSmileRight || 0;
  const facingScore = clamp(1 - Math.abs(pose.yaw) / 42 - Math.abs(pose.pitch) / 32, 0, 1);

  const sample = {
    facePresent: true,
    timestampMs,
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
    facingScore,
    blinkLeft,
    blinkRight,
    blinkScore: (blinkLeft + blinkRight) / 2,
    smileScore: (smileLeft + smileRight) / 2,
    jawOpen: shapes.jawOpen || 0,
    browRaise: shapes.browInnerUp || 0,
    motionScore: motionScore(landmarks, timestampMs),
  };

  if (debugLandmarks) {
    sample.landmarks = landmarks.map(({ x, y }) => ({ x, y }));
  }
  return sample;
}

async function initialize({ wasmRoot, modelPath }) {
  const fileset = await FilesetResolver.forVisionTasks(wasmRoot);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: modelPath,
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  self.postMessage({ type: "ready" });
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    try {
      await initialize(message);
    } catch (error) {
      self.postMessage({ type: "error", message: error?.message || String(error || "MediaPipe could not start.") });
    }
    return;
  }

  if (message.type === "config") {
    debugLandmarks = Boolean(message.debugLandmarks);
    return;
  }

  if (message.type === "frame") {
    const bitmap = message.bitmap;
    try {
      if (!landmarker) throw new Error("Face Landmarker is not ready.");
      const result = landmarker.detectForVideo(bitmap, message.timestampMs);
      self.postMessage({ type: "result", sample: simplifyResult(result, message.timestampMs) });
    } catch (error) {
      self.postMessage({ type: "error", message: error?.message || String(error || "MediaPipe frame processing failed.") });
    } finally {
      bitmap?.close?.();
      self.postMessage({ type: "frame-complete" });
    }
    return;
  }

  if (message.type === "close") {
    landmarker?.close?.();
    landmarker = null;
    previousAnchor = null;
    self.close();
  }
};
