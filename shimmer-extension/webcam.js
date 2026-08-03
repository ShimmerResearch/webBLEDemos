const FRAME_INTERVAL_MS = 100;
const BLINK_THRESHOLD = 0.55;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 1) => Number(value.toFixed(digits));

export class WebcamAnalysis {
  constructor({ video, canvas, onState, onError }) {
    this.video = video;
    this.canvas = canvas;
    this.onState = onState;
    this.onError = onError;
    this.stream = null;
    this.worker = null;
    this.running = false;
    this.workerReady = false;
    this.framePending = false;
    this.loopTimer = null;
    this.debugLandmarks = false;
    this.blinkActive = false;
    this.blinkTimes = [];
    this.lastState = null;
  }

  get active() {
    return Boolean(this.stream && this.running);
  }

  async start() {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is not supported in this browser.");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });

    this.video.srcObject = this.stream;
    await this.video.play();

    const workerVersion = encodeURIComponent(chrome.runtime.getManifest().version);
    this.worker = new Worker(`${chrome.runtime.getURL("vision-worker.js")}?v=${workerVersion}`);
    this.worker.onmessage = (event) => this.handleWorkerMessage(event.data || {});
    this.worker.onerror = (event) => this.fail(event.message || "Webcam analysis worker failed.");
    this.worker.postMessage({
      type: "init",
      wasmRoot: chrome.runtime.getURL("vendor/mediapipe/wasm"),
      modelPath: chrome.runtime.getURL("vendor/mediapipe/models/face_landmarker.task"),
    });
    this.worker.postMessage({ type: "config", debugLandmarks: this.debugLandmarks });
    this.running = true;
    this.emit({ status: "Loading model", facePresent: false });
  }

  stop() {
    this.running = false;
    this.workerReady = false;
    this.framePending = false;
    clearTimeout(this.loopTimer);
    this.loopTimer = null;
    this.worker?.postMessage({ type: "close" });
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.blinkActive = false;
    this.blinkTimes = [];
    this.lastState = null;
    this.clearCanvas();
  }

  setDebugLandmarks(enabled) {
    this.debugLandmarks = Boolean(enabled);
    this.worker?.postMessage({ type: "config", debugLandmarks: this.debugLandmarks });
    if (!enabled) this.clearCanvas();
  }

  handleWorkerMessage(message) {
    if (!this.running) return;
    if (message.type === "ready") {
      this.workerReady = true;
      this.emit({ status: "Active", facePresent: false });
      this.scheduleFrame(0);
      return;
    }
    if (message.type === "frame-complete") {
      this.framePending = false;
      this.scheduleFrame(FRAME_INTERVAL_MS);
      return;
    }
    if (message.type === "result") {
      this.processSample(message.sample || {});
      return;
    }
    if (message.type === "error") this.fail(message.message || "Webcam analysis failed.");
  }

  scheduleFrame(delay) {
    clearTimeout(this.loopTimer);
    if (!this.running || !this.workerReady) return;
    this.loopTimer = setTimeout(() => this.captureFrame(), delay);
  }

  async captureFrame() {
    if (!this.running || !this.workerReady || this.framePending) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.scheduleFrame(FRAME_INTERVAL_MS);
      return;
    }

    this.framePending = true;
    try {
      const bitmap = await createImageBitmap(this.video);
      this.worker.postMessage({
        type: "frame",
        bitmap,
        timestampMs: performance.now(),
      }, [bitmap]);
    } catch (error) {
      this.framePending = false;
      this.fail(error?.message || String(error));
    }
  }

  processSample(raw) {
    const now = Date.now();
    if (!raw.facePresent) {
      this.blinkActive = false;
      this.clearCanvas();
      this.emit({
        status: "Active",
        timestamp: new Date(now).toISOString(),
        tMs: now,
        facePresent: false,
        face: "Not detected",
        attention: "Unavailable",
        head: "Unavailable",
        eyes: "Unavailable",
        movement: "Unavailable",
        action: "Face not detected",
      });
      return;
    }

    const blinkNow = raw.blinkScore >= BLINK_THRESHOLD;
    const blinkEvent = blinkNow && !this.blinkActive;
    this.blinkActive = blinkNow;
    if (blinkEvent) this.blinkTimes.push(now);
    this.blinkTimes = this.blinkTimes.filter((time) => now - time <= 60000);

    const yaw = Number.isFinite(raw.yaw) ? raw.yaw : 0;
    const pitch = Number.isFinite(raw.pitch) ? raw.pitch : 0;
    const head = Math.abs(yaw) > 14
      ? (yaw > 0 ? "Turned right" : "Turned left")
      : Math.abs(pitch) > 12
        ? (pitch > 0 ? "Tilted down" : "Tilted up")
        : "Centered";
    const facingScore = clamp(raw.facingScore || 0, 0, 1);
    const attention = facingScore >= 0.55 ? "Facing screen" : "Looking away";
    const movement = raw.motionScore < 0.025 ? "Low" : raw.motionScore < 0.075 ? "Moderate" : "High";
    const eyes = blinkNow ? "Blinking" : "Open";

    let action = blinkEvent ? "Blink detected" : attention;
    if (!blinkEvent && raw.smileScore > 0.55) action = "Smile detected";
    else if (!blinkEvent && raw.jawOpen > 0.55) action = "Mouth open";
    else if (!blinkEvent && movement === "High") action = "Movement increased";

    const state = {
      status: "Active",
      timestamp: new Date(now).toISOString(),
      tMs: now,
      facePresent: true,
      face: "Detected",
      attention,
      head,
      eyes,
      movement,
      action,
      blinkEvent,
      blinkRate: this.blinkTimes.length,
      yaw: round(yaw, 2),
      pitch: round(raw.pitch || 0, 2),
      roll: round(raw.roll || 0, 2),
      facingScore: round(facingScore, 3),
      blinkLeft: round(raw.blinkLeft || 0, 3),
      blinkRight: round(raw.blinkRight || 0, 3),
      smileScore: round(raw.smileScore || 0, 3),
      jawOpen: round(raw.jawOpen || 0, 3),
      motionScore: round(raw.motionScore || 0, 4),
    };
    this.lastState = state;
    this.emit(state);
    if (this.debugLandmarks) this.drawLandmarks(raw.landmarks || []);
  }

  emit(state) {
    this.onState?.(state);
  }

  fail(message) {
    this.onError?.(message);
  }

  clearCanvas() {
    const context = this.canvas.getContext("2d");
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  drawLandmarks(landmarks) {
    const width = this.video.videoWidth || 640;
    const height = this.video.videoHeight || 360;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const context = this.canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(79, 195, 247, 0.82)";
    for (let index = 0; index < landmarks.length; index += 2) {
      const point = landmarks[index];
      context.beginPath();
      context.arc(point.x * width, point.y * height, 1.4, 0, Math.PI * 2);
      context.fill();
    }
  }
}
