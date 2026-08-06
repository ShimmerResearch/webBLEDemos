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
//   - With a magnetometer (MadgwickMARG + ArmImu useMag), yaw is observable:
//     every filter's earth frame shares magnetic north and yaw drift is
//     corrected continuously. Requires a per-device hard-iron calibration
//     (see startMagCapture); mag samples whose field magnitude deviates from
//     the calibrated field are rejected per-sample (indoor distortion).
// ---------------------------------------------------------------------------

import { calibrate, ACCEL_SENS, GYRO_SENS, MAG_SENS,
         ALIGN_WR_ACCEL_3R, ALIGN_GYRO_3R, ALIGN_MAG_3R } from './kinematics.js?v=3';

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
// Madgwick AHRS, 9-DOF (MARG) variant — canonical port of MadgwickAHRS.c.
// Same earth frame as the IMU variant (Z up), with the magnetic-field
// reference recomputed each step as b = [bx, 0, bz] (declination-free), which
// confines the mag's influence essentially to heading. Falls back to the
// 6-DOF update when no mag sample is supplied.
// ---------------------------------------------------------------------------
export class MadgwickMARG extends MadgwickIMU {
  /** gyro rad/s, accel any unit, mag any consistent unit ({x,y,z} or null). */
  updateMarg(gx, gy, gz, ax, ay, az, m, dt) {
    if (!m) { this.update(gx, gy, gz, ax, ay, az, dt); return; }
    const mNorm = Math.hypot(m.x, m.y, m.z);
    const aNorm = Math.hypot(ax, ay, az);
    if (mNorm === 0 || aNorm === 0) { this.update(gx, gy, gz, ax, ay, az, dt); return; }

    let { w: q0, x: q1, y: q2, z: q3 } = this.q;

    // Rate of change of quaternion from gyroscope
    let qDot0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let qDot1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let qDot2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let qDot3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

    ax /= aNorm; ay /= aNorm; az /= aNorm;
    const mx = m.x / mNorm, my = m.y / mNorm, mz = m.z / mNorm;

    const _2q0mx = 2 * q0 * mx, _2q0my = 2 * q0 * my, _2q0mz = 2 * q0 * mz;
    const _2q1mx = 2 * q1 * mx;
    const _2q0 = 2 * q0, _2q1 = 2 * q1, _2q2 = 2 * q2, _2q3 = 2 * q3;
    const _2q0q2 = 2 * q0 * q2, _2q2q3 = 2 * q2 * q3;
    const q0q0 = q0 * q0, q0q1 = q0 * q1, q0q2 = q0 * q2, q0q3 = q0 * q3;
    const q1q1 = q1 * q1, q1q2 = q1 * q2, q1q3 = q1 * q3;
    const q2q2 = q2 * q2, q2q3 = q2 * q3, q3q3 = q3 * q3;

    // Reference direction of Earth's magnetic field
    const hx = mx * q0q0 - _2q0my * q3 + _2q0mz * q2 + mx * q1q1
             + _2q1 * my * q2 + _2q1 * mz * q3 - mx * q2q2 - mx * q3q3;
    const hy = _2q0mx * q3 + my * q0q0 - _2q0mz * q1 + _2q1mx * q2
             - my * q1q1 + my * q2q2 + _2q2 * mz * q3 - my * q3q3;
    const _2bx = Math.hypot(hx, hy);
    const _2bz = -_2q0mx * q2 + _2q0my * q1 + mz * q0q0 + _2q1mx * q3
               - mz * q1q1 + _2q2 * my * q3 - mz * q2q2 + mz * q3q3;
    const _4bx = 2 * _2bx, _4bz = 2 * _2bz;

    // Gradient-descent corrective step
    const fgx = 2 * q1q3 - _2q0q2 - ax;                 // gravity objective terms
    const fgy = 2 * q0q1 + _2q2q3 - ay;
    const fgz = 1 - 2 * q1q1 - 2 * q2q2 - az;
    const fbx = _2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx;   // field objective terms
    const fby = _2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my;
    const fbz = _2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz;

    let s0 = -_2q2 * fgx + _2q1 * fgy
           - _2bz * q2 * fbx + (-_2bx * q3 + _2bz * q1) * fby + _2bx * q2 * fbz;
    let s1 = _2q3 * fgx + _2q0 * fgy - 4 * q1 * fgz
           + _2bz * q3 * fbx + (_2bx * q2 + _2bz * q0) * fby + (_2bx * q3 - _4bz * q1) * fbz;
    let s2 = -_2q0 * fgx + _2q3 * fgy - 4 * q2 * fgz
           + (-_4bx * q2 - _2bz * q0) * fbx + (_2bx * q1 + _2bz * q3) * fby + (_2bx * q0 - _4bz * q2) * fbz;
    let s3 = _2q1 * fgx + _2q2 * fgy
           + (-_4bx * q3 + _2bz * q1) * fbx + (-_2bx * q0 + _2bz * q2) * fby + _2bx * q1 * fbz;
    const sn = Math.hypot(s0, s1, s2, s3) || 1;
    qDot0 -= this.beta * (s0 / sn);
    qDot1 -= this.beta * (s1 / sn);
    qDot2 -= this.beta * (s2 / sn);
    qDot3 -= this.beta * (s3 / sn);

    this.q = qNormalize({
      w: q0 + qDot0 * dt,
      x: q1 + qDot1 * dt,
      y: q2 + qDot2 * dt,
      z: q3 + qDot3 * dt,
    });
  }
}

// ---------------------------------------------------------------------------
// Least-squares sphere fit (Kåsa method) from accumulated sums — used for
// hard-iron estimation without storing samples. Each point contributes
// 2p·c + d = |p|², linear in (cx, cy, cz, d); r = sqrt(d + |c|²).
// ---------------------------------------------------------------------------
function solve4(M, b) {   // Gaussian elimination with partial pivoting
  const A = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 5; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[4] / row[i]);
}

// ---------------------------------------------------------------------------
// ArmImu — one strapped IMU: raw counts in, drift-corrected orientation out.
//
// Handles: calibration to device frame (via kinematics.js), gyro-bias capture
// while held still, Madgwick fusion, and a reference pose so orientation is
// reported RELATIVE to the pose the user held at calibration time.
// ---------------------------------------------------------------------------
export class ArmImu {
  constructor({ accelRange = '4G', gyroRange = '500DPS', beta = 0.08, useMag = false } = {}) {
    this.accelSens = ACCEL_SENS[accelRange];
    this.gyroSens = GYRO_SENS[gyroRange];
    this.magSens = MAG_SENS['50GA'];
    this.useMag = useMag;
    this.filter = useMag ? new MadgwickMARG({ beta }) : new MadgwickIMU({ beta });
    this.bias = { x: 0, y: 0, z: 0 };   // gyro bias, deg/s (device frame)
    this.qRef = null;                   // filter.q captured at the reference pose
    this._cal = null;
    this._swing = null;
    this._swingCalibrated = false;      // a functional yaw datum exists (swing or working-pose)
    this.longAxis = null;               // segment long axis in the BODY frame, from the hang reference
    this.onCalibrated = null;
    this.accel = null;                  // last device-frame accel (g)
    this.gyro = null;                   // last device-frame gyro (deg/s), pre-bias
    this.mag = null;                    // last device-frame mag (gauss), hard-iron corrected
    this.sampleCount = 0;
    // hard-iron calibration + per-sample distortion gate diagnostics
    this.magOffset = null;              // hard-iron bias, RAW COUNTS
    this.magField = null;               // expected field magnitude (gauss) at cal time
    this.magAccepts = 0;                // samples fused via MARG
    this.magRejects = 0;                // samples gated out (field magnitude off)
    this._magCap = null;                // in-progress figure-8 capture
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
   * Clear all calibration state so the next run behaves exactly like the
   * first one. The filter quaternion is deliberately KEPT (a converged
   * attitude is the one thing that benefits from history); callers should
   * also raise beta during the hold-still phase to scrub accumulated tilt
   * error, mirroring first-run conditions.
   */
  resetCalibration() {
    this.qRef = null;
    this.qYawFix = undefined;
    this._swingCalibrated = false;
    this.longAxis = null;
    this._cal = null;
    this._swing = null;
  }

  /** Snapshot calibration state, for rollback when a re-calibration fails. */
  snapshotCalibration() {
    return {
      bias: { ...this.bias },
      qRef: this.qRef ? { ...this.qRef } : null,
      qYawFix: this.qYawFix ? { ...this.qYawFix } : undefined,
      swingCalibrated: this._swingCalibrated,
      longAxis: this.longAxis ? { ...this.longAxis } : null,
      beta: this.filter.beta,
    };
  }

  restoreCalibration(s) {
    this.bias = { ...s.bias };
    this.qRef = s.qRef ? { ...s.qRef } : null;
    this.qYawFix = s.qYawFix ? { ...s.qYawFix } : undefined;
    this._swingCalibrated = s.swingCalibrated;
    this.longAxis = s.longAxis ? { ...s.longAxis } : null;
    this.filter.beta = s.beta;
    this._cal = null;
    this._swing = null;
  }

  /**
   * Functional calibration, phase 2: while the user swings the straight arm
   * about one physical axis (e.g. forward/back at the shoulder), collect the
   * rotation axis in THIS filter's earth frame. Both sensors move rigidly
   * together, so the same physical axis measured in each earth frame exposes
   * the yaw offset between the frames — mounting differences included.
   */
  startSwingCapture() {
    // The segment's long axis in the body frame = whatever pointed down
    // (earth -Z) at the reference pose. Its horizontal tilt during the swing
    // reveals the dominant swing direction (= forward: shoulder/hip flexion
    // range far exceeds extension), which fixes the axis sign robustly.
    const down = this.qRef
      ? qRotate(qConj(this.qRef), { x: 0, y: 0, z: -1 })
      : { x: 0, y: 0, z: -1 };
    this._swing = { sum: { x: 0, y: 0, z: 0 }, count: 0, down, hx: 0, hy: 0, hn: 0 };
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
    let axis = { x: s.sum.x / n, y: s.sum.y / n, z: s.sum.z / n };
    if (Math.hypot(axis.x, axis.y) < 0.4) return null;   // near-vertical: no heading info
    // Fix the axis sign from the DOMINANT horizontal tilt direction: people
    // swing far further forward than backward, so the mean tilt points
    // forward. This makes the convention immune to a backswing wind-up, which
    // would flip a naive "first sample defines forward" seed by 180deg.
    const hx = s.hx / (s.hn || 1), hy = s.hy / (s.hn || 1);
    if (Math.hypot(hx, hy) > 0.08) {
      // for rotation about `axis`, the long axis tilts along axis x down = (-ay, ax, 0)
      if ((-axis.y) * hx + axis.x * hy < 0) {
        axis = { x: -axis.x, y: -axis.y, z: -axis.z };
      }
    }
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
    this._swingCalibrated = true;
  }

  /**
   * Heading datum for a SINGLE sensor, taken from the WORKING pose instead of a
   * swing. `longAxis` (captured at the hang reference) is the segment's own
   * axis; when the limb is held out horizontally in the task pose, that axis's
   * horizontal projection in the earth frame IS the user's forward direction.
   *
   * Preferred over setYawFix for one-sensor setups: a still capture in a pose
   * the user already has to hold, with no swing to perform, no dependence on
   * WHICH way they swung, and no forward-sign heuristic to get wrong. (Swinging
   * sideways instead of forward/back rotates a swing datum by 90 degrees, which
   * shows up as the two horizontal axes being transposed.)
   *
   * Returns false when the segment is too close to vertical to define a heading
   * — i.e. the user has not actually raised the limb into the task pose.
   */
  setForwardFix(targetYawRad = -Math.PI / 2, forwardBody = null, expectedUpBody = null) {
    const forward = forwardBody || this.longAxis;
    if (!forward) return false;
    // When the mounting protocol specifies which puck axis must point up in
    // the working pose, reject the capture unless it actually does. This keeps
    // a slightly twisted/sideways pose from silently rotating the task frame.
    if (expectedUpBody) {
      const u = qRotate(this.filter.q, expectedUpBody);
      const un = Math.hypot(u.x, u.y, u.z) || 1;
      if (u.z / un < 0.85) return false;   // expected axis must be within ~32° of up
    }
    const e = qRotate(this.filter.q, forward);   // forward axis in the earth frame
    if (Math.hypot(e.x, e.y) < 0.35) return false;     // ~>70deg from horizontal: no heading
    const yaw = Math.atan2(e.y, e.x);
    this.qYawFix = qFromAxisAngle(0, 0, 1, targetYawRad - yaw);
    this._swingCalibrated = true;   // functional datum: never downgrade to the body-X fallback
    return true;
  }

  /** Cosine alignment of a body-fixed axis with earth up (+Z). */
  bodyAxisUpDot(axisBody) {
    const e = qRotate(this.filter.q, axisBody);
    return e.z / (Math.hypot(e.x, e.y, e.z) || 1);
  }

  // --- magnetometer hard-iron calibration (in-hand figure-8) ---------------
  // A stationary mag reading cannot separate hard-iron offset from the earth
  // field, so unlike the gyro-bias capture this needs rotation coverage: the
  // user waves the unstrapped sensor through slow figure-8s until raw samples
  // cover the offset sphere. Offset = least-squares sphere centre (raw
  // counts); the fitted radius gives the expected field magnitude used by the
  // runtime distortion gate.

  get magCalibrated() { return this.magOffset !== null; }

  /** Install a (possibly persisted) hard-iron calibration. Pass null to clear. */
  setMagCalibration(cal) {
    this.magOffset = cal ? { ...cal.offset } : null;
    this.magField = cal ? cal.field : null;
    this.magAccepts = 0;
    this.magRejects = 0;
  }

  startMagCapture() {
    this._magCap = {
      n: 0,
      sx: 0, sy: 0, sz: 0,
      sxx: 0, syy: 0, szz: 0, sxy: 0, sxz: 0, syz: 0,
      sr: 0, sxr: 0, syr: 0, szr: 0,
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
      oct: new Array(8).fill(0),   // direction-coverage bins around the running centre
    };
  }

  get magCapturing() { return this._magCap !== null; }

  /** Coverage progress 0..1: each octant around the running centre needs samples. */
  get magCaptureProgress() {
    const c = this._magCap;
    if (!c) return null;
    const PER_OCT = 30;
    return c.oct.reduce((a, n) => a + Math.min(n, PER_OCT), 0) / (8 * PER_OCT);
  }

  cancelMagCapture() { this._magCap = null; }

  _accumulateMag(p) {
    const c = this._magCap;
    c.n++;
    const r2 = p.x * p.x + p.y * p.y + p.z * p.z;
    c.sx += p.x; c.sy += p.y; c.sz += p.z;
    c.sxx += p.x * p.x; c.syy += p.y * p.y; c.szz += p.z * p.z;
    c.sxy += p.x * p.y; c.sxz += p.x * p.z; c.syz += p.y * p.z;
    c.sr += r2; c.sxr += p.x * r2; c.syr += p.y * r2; c.szr += p.z * r2;
    for (const ax of ['x', 'y', 'z']) {
      c.min[ax] = Math.min(c.min[ax], p[ax]);
      c.max[ax] = Math.max(c.max[ax], p[ax]);
    }
    // octant coverage relative to the running min/max midpoint; skip samples
    // too close to the centre to classify (< ~0.15 Ga in counts)
    const dx = p.x - (c.min.x + c.max.x) / 2;
    const dy = p.y - (c.min.y + c.max.y) / 2;
    const dz = p.z - (c.min.z + c.max.z) / 2;
    if (Math.hypot(dx, dy, dz) > 100) {
      c.oct[(dx > 0 ? 1 : 0) | (dy > 0 ? 2 : 0) | (dz > 0 ? 4 : 0)]++;
    }
  }

  /**
   * End the figure-8 capture and fit the sphere. Returns
   * { offset (raw counts), field (gauss), quality, samples } or null when
   * coverage is too poor / the fit is implausible. quality is the relative
   * radial spread (~0.02 good, > 0.15 suspect — ferrous environment or a
   * rushed wave).
   */
  finishMagCapture(minSamples = 200) {
    const c = this._magCap;
    this._magCap = null;
    if (!c || c.n < minSamples) return null;
    const M = [
      [4 * c.sxx, 4 * c.sxy, 4 * c.sxz, 2 * c.sx],
      [4 * c.sxy, 4 * c.syy, 4 * c.syz, 2 * c.sy],
      [4 * c.sxz, 4 * c.syz, 4 * c.szz, 2 * c.sz],
      [2 * c.sx, 2 * c.sy, 2 * c.sz, c.n],
    ];
    const b = [2 * c.sxr, 2 * c.syr, 2 * c.szr, c.sr];
    const sol = solve4(M, b);
    if (!sol) return null;
    const [cx, cy, cz, d] = sol;
    const c2 = cx * cx + cy * cy + cz * cz;
    const r2 = d + c2;
    if (r2 <= 0) return null;
    const r = Math.sqrt(r2);
    const field = r / this.magSens;
    if (field < 0.15 || field > 1.2) return null;   // implausible earth field (gauss)
    // relative radial spread from the accumulated sums:
    // Σ|p−c|²/n − r² ≈ var(ρ) when the fit is decent
    const meanRho2 = (c.sr - 2 * (cx * c.sx + cy * c.sy + cz * c.sz)) / c.n + c2;
    const quality = Math.sqrt(Math.max(0, meanRho2 - r2)) / r;
    return { offset: { x: cx, y: cy, z: cz }, field, quality, samples: c.n };
  }

  /**
   * Re-capture the reference pose from the CURRENT attitude — gyro bias and
   * any swing-based yaw alignment are kept. Use to re-zero "deltaQ = identity"
   * on a task pose after the functional calibration was done in another pose.
   */
  captureReference() {
    this.qRef = { ...this.filter.q };
    this._computeYawFix();   // no-op when a swing datum exists
  }

  /** Feed one sample of raw sensor counts. magRaw is optional ({x,y,z} counts). */
  update(accelRaw, gyroRaw, dt, magRaw = null) {
    const accel = calibrate(accelRaw, this.accelSens, ALIGN_WR_ACCEL_3R);
    const gyro = calibrate(gyroRaw, this.gyroSens, ALIGN_GYRO_3R);
    this.accel = accel;
    this.gyro = gyro;
    // bias-corrected rotation speed (deg/s) — used for swing/quiet detection
    this.gyroMag = Math.hypot(gyro.x - this.bias.x, gyro.y - this.bias.y, gyro.z - this.bias.z);
    this.sampleCount++;

    // magnetometer: figure-8 accumulation, hard-iron correction, and the
    // per-sample distortion gate (|B| must stay near the calibrated field)
    let mag = null;
    if (magRaw) {
      if (this._magCap) this._accumulateMag(magRaw);
      if (this.magOffset) {
        const m = calibrate(magRaw, this.magSens, ALIGN_MAG_3R, this.magOffset);
        this.mag = m;
        const magNorm = Math.hypot(m.x, m.y, m.z);
        if (this.magField && Math.abs(magNorm - this.magField) <= 0.25 * this.magField) {
          mag = m;
          this.magAccepts++;
        } else {
          this.magRejects++;
        }
      }
    }

    if (this._cal) {
      const c = this._cal;
      c.sum.x += gyro.x; c.sum.y += gyro.y; c.sum.z += gyro.z;
      if (++c.count >= c.n) {
        this.bias = { x: c.sum.x / c.count, y: c.sum.y / c.count, z: c.sum.z / c.count };
        this._cal = null;
        this.qRef = { ...this.filter.q };
        // the segment's own axis: whatever pointed down (earth -Z) while the
        // limb hung straight. Held out horizontally later, this is what reveals
        // the heading — see setForwardFix.
        this.longAxis = qRotate(qConj(this.qRef), { x: 0, y: 0, z: -1 });
        this._computeYawFix();
        this.onCalibrated?.(this);
      }
    }

    if (this._swing) {
      const s = this._swing;
      // horizontal tilt of the segment's long axis: forward-direction evidence
      const dE = qRotate(this.filter.q, s.down);
      s.hx += dE.x; s.hy += dE.y; s.hn++;
      const gb = { x: gyro.x - this.bias.x, y: gyro.y - this.bias.y, z: gyro.z - this.bias.z };
      if (Math.hypot(gb.x, gb.y, gb.z) > 40) {   // deg/s: only count real swinging
        const ge = qRotate(this.filter.q, gb);   // rotation axis in this earth frame
        const dot = ge.x * s.sum.x + ge.y * s.sum.y + ge.z * s.sum.z;
        const sign = (s.count === 0 || dot >= 0) ? 1 : -1;   // provisional seed
        s.sum.x += sign * ge.x; s.sum.y += sign * ge.y; s.sum.z += sign * ge.z;
        s.count++;
      }
    }

    const gx = (gyro.x - this.bias.x) * D2R;
    const gy = (gyro.y - this.bias.y) * D2R;
    const gz = (gyro.z - this.bias.z) * D2R;
    if (this.useMag && this.filter.updateMarg) {
      this.filter.updateMarg(gx, gy, gz, accel.x, accel.y, accel.z, mag, dt);
    } else {
      this.filter.update(gx, gy, gz, accel.x, accel.y, accel.z, dt);
    }
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
    // Once a swing-based (functional) datum exists, never downgrade it: the
    // yaw alignment is a property of the filter's earth frame, which persists
    // across reference re-captures — a re-calibration whose swing phase fails
    // must keep the previous good alignment.
    if (this._swingCalibrated) return;
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
