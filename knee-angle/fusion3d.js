// fusion3d.js
// ---------------------------------------------------------------------------
// Quaternion sensor fusion for 3D segment orientation from a 6-DOF IMU
// (accelerometer + gyroscope), plus helpers for driving an articulated model.
//
// Builds on kinematics.js (shared raw->device-frame calibration/alignment for
// the Shimmer3R) but replaces the scalar complementary filter with a Madgwick
// gradient-descent AHRS — the standard for smooth drift-corrected 3D
// orientation from accel+gyro alone.
//
// Frame conventions (verified by simulation in the repo tests):
//   - Madgwick earth frame: Z up (gravity = +Z at rest).
//   - filter.q rotates BODY -> EARTH:  v_earth = q ⊗ v_body ⊗ q*
//   - With no magnetometer, yaw (rotation about gravity) is unobservable and
//     drifts slowly; the reference-capture step re-aligns it, and relative
//     yaw between two IMUs calibrated at the same moment stays consistent
//     over demo timescales.
// ---------------------------------------------------------------------------

import { calibrate, ACCEL_SENS, GYRO_SENS, ALIGN_WR_ACCEL_3R, ALIGN_GYRO_3R } from './kinematics.js?v=2';

const D2R = Math.PI / 180;

// --- minimal quaternion ops ({w,x,y,z}) ------------------------------------
export const qIdentity = () => ({ w: 1, x: 0, y: 0, z: 0 });

export function qMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export const qConj = (q) => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });

export function qNormalize(q) {
  const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

/** Rotate vector {x,y,z} by quaternion q. */
export function qRotate(q, v) {
  const p = qMul(qMul(q, { w: 0, ...v }), qConj(q));
  return { x: p.x, y: p.y, z: p.z };
}

export function qFromAxisAngle(x, y, z, angleRad) {
  const n = Math.hypot(x, y, z) || 1;
  const s = Math.sin(angleRad / 2);
  return { w: Math.cos(angleRad / 2), x: (x / n) * s, y: (y / n) * s, z: (z / n) * s };
}

// ---------------------------------------------------------------------------
// Madgwick AHRS, 6-DOF (IMU) variant — canonical gradient-descent update.
// gyro in rad/s, accel in any consistent unit (normalized internally).
// beta trades gyro trust (low beta: smooth, slower drift correction) against
// accel trust (high beta: fast correction, noisier).
// ---------------------------------------------------------------------------
export class MadgwickIMU {
  constructor({ beta = 0.08 } = {}) {
    this.beta = beta;
    this.q = qIdentity();
  }

  reset() { this.q = qIdentity(); }

  update(gx, gy, gz, ax, ay, az, dt) {
    let { w: q1, x: q2, y: q3, z: q4 } = this.q;

    // Rate of change of quaternion from gyroscope
    let qDot1 = 0.5 * (-q2 * gx - q3 * gy - q4 * gz);
    let qDot2 = 0.5 * (q1 * gx + q3 * gz - q4 * gy);
    let qDot3 = 0.5 * (q1 * gy - q2 * gz + q4 * gx);
    let qDot4 = 0.5 * (q1 * gz + q2 * gy - q3 * gx);

    const norm = Math.hypot(ax, ay, az);
    if (norm > 0) {
      ax /= norm; ay /= norm; az /= norm;

      const _2q1 = 2 * q1, _2q2 = 2 * q2, _2q3 = 2 * q3, _2q4 = 2 * q4;
      const _4q1 = 4 * q1, _4q2 = 4 * q2, _4q3 = 4 * q3;
      const _8q2 = 8 * q2, _8q3 = 8 * q3;
      const q1q1 = q1 * q1, q2q2 = q2 * q2, q3q3 = q3 * q3, q4q4 = q4 * q4;

      // Gradient-descent corrective step (objective: measured accel vs
      // gravity direction predicted from q)
      let s1 = _4q1 * q3q3 + _2q3 * ax + _4q1 * q2q2 - _2q2 * ay;
      let s2 = _4q2 * q4q4 - _2q4 * ax + 4 * q1q1 * q2 - _2q1 * ay - _4q2 + _8q2 * q2q2 + _8q2 * q3q3 + _4q2 * az;
      let s3 = 4 * q1q1 * q3 + _2q1 * ax + _4q3 * q4q4 - _2q4 * ay - _4q3 + _8q3 * q2q2 + _8q3 * q3q3 + _4q3 * az;
      let s4 = 4 * q2q2 * q4 - _2q2 * ax + 4 * q3q3 * q4 - _2q3 * ay;
      const sn = Math.hypot(s1, s2, s3, s4) || 1;
      qDot1 -= this.beta * (s1 / sn);
      qDot2 -= this.beta * (s2 / sn);
      qDot3 -= this.beta * (s3 / sn);
      qDot4 -= this.beta * (s4 / sn);
    }

    this.q = qNormalize({
      w: q1 + qDot1 * dt,
      x: q2 + qDot2 * dt,
      y: q3 + qDot3 * dt,
      z: q4 + qDot4 * dt,
    });
  }

  /** Gravity direction predicted in the body frame (for diagnostics/tests). */
  gravityBody() {
    const { w: q1, x: q2, y: q3, z: q4 } = this.q;
    return {
      x: 2 * (q2 * q4 - q1 * q3),
      y: 2 * (q1 * q2 + q3 * q4),
      z: q1 * q1 - q2 * q2 - q3 * q3 + q4 * q4,
    };
  }
}

// ---------------------------------------------------------------------------
// ArmImu — one strapped IMU: raw counts in, drift-corrected orientation out.
//
// Handles: calibration to device frame (via kinematics.js), gyro-bias capture
// while held still, Madgwick fusion, and a reference pose so orientation is
// reported RELATIVE to the pose the user held at calibration time.
// ---------------------------------------------------------------------------
export class ArmImu {
  constructor({ accelRange = '4G', gyroRange = '500DPS', beta = 0.08 } = {}) {
    this.accelSens = ACCEL_SENS[accelRange];
    this.gyroSens = GYRO_SENS[gyroRange];
    this.filter = new MadgwickIMU({ beta });
    this.bias = { x: 0, y: 0, z: 0 };   // gyro bias, deg/s (device frame)
    this.qRef = null;                   // filter.q captured at the reference pose
    this._cal = null;
    this.onCalibrated = null;
    this.accel = null;                  // last device-frame accel (g)
    this.gyro = null;                   // last device-frame gyro (deg/s), pre-bias
    this.sampleCount = 0;
  }

  /**
   * Begin the hold-still calibration: averages the next n samples of gyro to
   * estimate bias, then captures the current orientation as the reference.
   */
  startCalibration(nSamples = 160) {
    this._cal = { n: nSamples, count: 0, sum: { x: 0, y: 0, z: 0 } };
  }

  get calibrating() { return this._cal !== null; }
  get ready() { return this.qRef !== null; }

  /** Progress of the hold-still capture (0..1), or null when not capturing. */
  get calProgress() { return this._cal ? this._cal.count / this._cal.n : null; }

  /** Abort any in-progress hold-still or swing capture. */
  cancelCalibration() { this._cal = null; this._swing = null; }

  /**
   * Functional calibration, phase 2: while the user swings the straight arm
   * about one physical axis (e.g. forward/back at the shoulder), collect the
   * rotation axis in THIS filter's earth frame. Both sensors move rigidly
   * together, so the same physical axis measured in each earth frame exposes
   * the yaw offset between the frames — mounting differences included.
   */
  startSwingCapture() {
    this._swing = { sum: { x: 0, y: 0, z: 0 }, count: 0 };
  }

  get swingCount() { return this._swing ? this._swing.count : 0; }

  /**
   * End swing capture. Returns the unit rotation axis in this filter's earth
   * frame (sign seeded by the FIRST swing direction), or null if there was
   * not enough rotation or the axis is too vertical to define a heading.
   */
  finishSwingCapture(minSamples = 50) {
    const s = this._swing;
    this._swing = null;
    if (!s || s.count < minSamples) return null;
    const n = Math.hypot(s.sum.x, s.sum.y, s.sum.z) || 1;
    const axis = { x: s.sum.x / n, y: s.sum.y / n, z: s.sum.z / n };
    if (Math.hypot(axis.x, axis.y) < 0.4) return null;   // near-vertical: no heading info
    return axis;
  }

  /**
   * Align this filter's earth frame so `axis` (from finishSwingCapture) maps
   * to the shared heading datum. Default target -X: with a forward-first
   * swing this makes "forward" consistent across devices AND the scene.
   * Overrides the body-X default datum from _computeYawFix.
   */
  setYawFix(axis, targetYawRad = Math.PI) {
    const yaw = Math.atan2(axis.y, axis.x);
    this.qYawFix = qFromAxisAngle(0, 0, 1, targetYawRad - yaw);
  }

  /** Feed one sample of raw sensor counts. */
  update(accelRaw, gyroRaw, dt) {
    const accel = calibrate(accelRaw, this.accelSens, ALIGN_WR_ACCEL_3R);
    const gyro = calibrate(gyroRaw, this.gyroSens, ALIGN_GYRO_3R);
    this.accel = accel;
    this.gyro = gyro;
    // bias-corrected rotation speed (deg/s) — used for swing/quiet detection
    this.gyroMag = Math.hypot(gyro.x - this.bias.x, gyro.y - this.bias.y, gyro.z - this.bias.z);
    this.sampleCount++;

    if (this._cal) {
      const c = this._cal;
      c.sum.x += gyro.x; c.sum.y += gyro.y; c.sum.z += gyro.z;
      if (++c.count >= c.n) {
        this.bias = { x: c.sum.x / c.count, y: c.sum.y / c.count, z: c.sum.z / c.count };
        this._cal = null;
        this.qRef = { ...this.filter.q };
        this._computeYawFix();
        this.onCalibrated?.(this);
      }
    }

    if (this._swing) {
      const gb = { x: gyro.x - this.bias.x, y: gyro.y - this.bias.y, z: gyro.z - this.bias.z };
      if (Math.hypot(gb.x, gb.y, gb.z) > 40) {   // deg/s: only count real swinging
        const ge = qRotate(this.filter.q, gb);   // rotation axis in this earth frame
        const s = this._swing;
        const dot = ge.x * s.sum.x + ge.y * s.sum.y + ge.z * s.sum.z;
        const sign = (s.count === 0 || dot >= 0) ? 1 : -1;   // sign seeded by first swing
        s.sum.x += sign * ge.x; s.sum.y += sign * ge.y; s.sum.z += sign * ge.z;
        s.count++;
      }
    }

    this.filter.update(
      (gyro.x - this.bias.x) * D2R,
      (gyro.y - this.bias.y) * D2R,
      (gyro.z - this.bias.z) * D2R,
      accel.x, accel.y, accel.z, dt,
    );
  }

  /**
   * Without a magnetometer each filter's yaw datum is arbitrary (whatever the
   * device's heading was at connect time), so two IMUs' earth frames disagree
   * by an unknown rotation about vertical — which would corrupt any RELATIVE
   * orientation computed between them. Fix: define a shared yaw datum from
   * the device's own body-X direction at the reference pose (falling back to
   * body-Z when X is near-vertical). Valid whenever both sensors are strapped
   * facing the same way — the demo-grade equivalent of a functional
   * heading calibration.
   */
  _computeYawFix() {
    const xe = qRotate(this.qRef, { x: 1, y: 0, z: 0 });
    const ze = qRotate(this.qRef, { x: 0, y: 0, z: 1 });
    const use = Math.hypot(xe.x, xe.y) >= 0.2 ? xe : ze;
    const yaw = Math.atan2(use.y, use.x);
    this.qYawFix = qFromAxisAngle(0, 0, 1, -yaw);
  }

  /**
   * Earth-frame rotation from the reference pose to now, expressed in the
   * shared yaw-datum frame (see _computeYawFix):
   *   v_earth(t) = deltaQ ⊗ v_earth(ref) ⊗ deltaQ*   for any body-fixed vector.
   * Identity until a reference has been captured.
   */
  get deltaQ() {
    if (!this.qRef) return qIdentity();
    const d = qMul(this.filter.q, qConj(this.qRef));
    return qMul(qMul(this.qYawFix, d), qConj(this.qYawFix));
  }
}
