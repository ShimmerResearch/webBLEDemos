// kinematics.js
// ---------------------------------------------------------------------------
// Knee joint-angle estimation from two thigh-mounted IMUs (accelerometer +
// gyroscope). Framework-agnostic: no DOM, no Web Bluetooth. Pure math you can
// unit-test in isolation and reuse anywhere.
//
// This is a clean re-implementation of the sensor-fusion core of the original
// "Shimmer Sirona" Android app (ShimmerKinematics / ComplementaryFilter /
// JointAngle). The low-level packet parsing and per-channel calibration that
// dominated the original are gone — Shimmer3RClient hands us raw sensor counts,
// so all this module does is the part that was actually worth keeping:
//
//   raw counts --calibrate--> g / deg/s
//   accel      --inclineFromAccel--> absolute tilt angle (noisy, drift-free)
//   gyro       --integrate--------> angle delta (smooth, drifts)
//   fuse the two with a complementary filter --> per-segment angle
//   knee angle = upper-segment angle - lower-segment angle
//
// Note on a fix vs. the original: the Android version fused `gyro*dt` (degrees)
// with the accelerometer angle (radians) in the same equation — a latent unit
// mismatch. Here everything is consistently in DEGREES.
// ---------------------------------------------------------------------------

const RAD2DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Calibration constants for the Shimmer3R, taken from the official C# API
// (Shimmer-C-API: ShimmerBluetooth.cs / GyroSensor.cs / WRAccel.cs).
//
// Sensitivity is "LSB per unit": physical = raw / sensitivity.
// The accelerometer output is normalised before use, so its scale only needs
// to be internally consistent; the gyro scale must be correct for the
// complementary filter to have physical meaning.
// ---------------------------------------------------------------------------
export const ACCEL_SENS = {   // LSB per g (LIS2DW12 wide-range accel)
  '2G': 1671,
  '4G': 836,
  '8G': 418,
  '16G': 209,
};

export const GYRO_SENS = {    // LSB per deg/s (LSM6DSV gyro)
  '125DPS': 229,
  '250DPS': 114,
  '500DPS': 57,
  '1000DPS': 29,
  '2000DPS': 14,
  '4000DPS': 7,
};

// ---------------------------------------------------------------------------
// Alignment matrices (device frame <- chip frame), from the C# API defaults.
// CRITICAL: on the Shimmer3R the wide-range accel (LIS2DW12) and the gyro
// (LSM6DSV) are DIFFERENT chips mounted in different orientations, so their
// raw channels are NOT in a common frame. The complementary filter fuses
// "gyro rotation about axis N" with "accel tilt about axis N" and therefore
// requires both in the same (device) frame — these matrices provide that.
//
// Calibration follows Ferraris et al.:  C = R^-1 · K^-1 · (U - B)
// with B = 0 by default. Both default R matrices happen to be involutions
// (R^-1 = R), but we apply the transpose (= inverse for orthonormal R) so
// user-supplied matrices also work.
// ---------------------------------------------------------------------------
export const ALIGN_WR_ACCEL_3R = [ // ALIGNMENT_MATRIX_WIDE_RANGE_ACCEL_SHIMMER3R_LIS2DW12
  [0, -1, 0],
  [-1, 0, 0],
  [0, 0, -1],
];
export const ALIGN_GYRO_3R = [     // ALIGNMENT_MATRIX_GYRO_SHIMMER3R_LSM6DSV
  [-1, 0, 0],
  [0, 1, 0],
  [0, 0, -1],
];

/** Apply the inverse (transpose) of an orthonormal alignment matrix: chip -> device frame. */
function alignToDevice(v, A) {
  return {
    x: A[0][0] * v.x + A[1][0] * v.y + A[2][0] * v.z,
    y: A[0][1] * v.x + A[1][1] * v.y + A[2][1] * v.z,
    z: A[0][2] * v.x + A[1][2] * v.y + A[2][2] * v.z,
  };
}

/** Raw counts -> device-frame physical units: align, then scale. */
export function calibrate(raw, sensitivity, alignment) {
  const scaled = { x: raw.x / sensitivity, y: raw.y / sensitivity, z: raw.z / sensitivity };
  return alignment ? alignToDevice(scaled, alignment) : scaled;
}

// ---------------------------------------------------------------------------
// Complementary filter.
//   a     = tau / (tau + dt)
//   angle = a * (prevAngle + gyroDelta) + (1 - a) * accelAngle
// `tau` is the fusion time constant (seconds): larger tau trusts the gyro for
// longer (smoother, more drift), smaller tau trusts the accelerometer more
// (more responsive to gravity, noisier).
// ---------------------------------------------------------------------------
export function complementaryFilter(gyroDeltaDeg, accelAngleDeg, dt, tau, prevAngleDeg) {
  const a = tau / (tau + dt);
  return a * (prevAngleDeg + gyroDeltaDeg) + (1 - a) * accelAngleDeg;
}

// ---------------------------------------------------------------------------
// Inclination angle (degrees) from a normalised accelerometer vector, about a
// chosen rotation axis. Faithful port of the original inclineFromAccel branch
// table: `commonAxis` is the axis the segment rotates about ('X'|'Y'|'Z') and
// `refAxis` is the axis pointing "up" at rest ('+X'|'-X'|'+Y'|...). The pairing
// selects which two accel components feed atan2.
// ---------------------------------------------------------------------------
export function inclineFromAccel(ax, ay, az, { commonAxis = 'X', refAxis = '+Y' } = {}) {
  const n = Math.hypot(ax, ay, az) || 1;
  ax /= n; ay /= n; az /= n;

  let i1 = 0, i2 = 0;
  if (commonAxis === 'X') {
    if (refAxis === '+Y') { i1 = az;  i2 = ay; }
    else if (refAxis === '-Y') { i1 = -az; i2 = -ay; }
    else if (refAxis === '+Z') { i1 = -ay; i2 = az; }
    else if (refAxis === '-Z') { i1 = ay;  i2 = -az; }
  } else if (commonAxis === 'Y') {
    if (refAxis === '+X') { i1 = -az; i2 = ax; }
    else if (refAxis === '-X') { i1 = az;  i2 = -ax; }
    else if (refAxis === '+Z') { i1 = ax;  i2 = az; }
    else if (refAxis === '-Z') { i1 = -ax; i2 = -az; }
  } else if (commonAxis === 'Z') {
    if (refAxis === '+X') { i1 = ay;  i2 = ax; }
    else if (refAxis === '-X') { i1 = -ay; i2 = -ax; }
    else if (refAxis === '+Y') { i1 = -ax; i2 = ay; }
    else if (refAxis === '-Y') { i1 = ax;  i2 = -ay; }
  }
  // The leading minus is carried over from the original ("temp fix").
  return -Math.atan2(i1, i2) * RAD2DEG;
}

/** Pick the gyro rate component (deg/s) about the segment's rotation axis. */
function gyroRateAboutAxis(gyro, commonAxis) {
  if (commonAxis === 'X') return gyro.x;
  if (commonAxis === 'Y') return gyro.y;
  return gyro.z;
}

// ---------------------------------------------------------------------------
// SegmentTracker — the fused inclination of ONE limb segment (one sensor).
// Holds the only piece of state the fusion needs: the previous fused angle.
// ---------------------------------------------------------------------------
export class SegmentTracker {
  /**
   * @param {object}  opts
   * @param {string}  opts.commonAxis  axis the segment rotates about ('X'|'Y'|'Z')
   * @param {string}  opts.refAxis     axis pointing up at rest ('+X'..'-Z')
   * @param {number}  opts.axisSign    +1 or -1: rotation polarity for this
   *                            mounting. -1 mirrors the segment (equivalent to
   *                            rotating about the negative axis) and is applied
   *                            consistently to BOTH the accel-derived angle and
   *                            the gyro rate, so the fusion stays coherent.
   * @param {number}  opts.tau         complementary-filter time constant (s)
   * @param {string}  opts.accelRange  key into ACCEL_SENS
   * @param {string}  opts.gyroRange   key into GYRO_SENS
   * @param {number[][]|null} opts.accelAlign  3x3 alignment matrix (device<-chip); default Shimmer3R WR accel
   * @param {number[][]|null} opts.gyroAlign   3x3 alignment matrix (device<-chip); default Shimmer3R gyro
   */
  constructor({ commonAxis = 'X', refAxis = '+Y', axisSign = 1, tau = 0.125,
                accelRange = '4G', gyroRange = '500DPS',
                accelAlign = ALIGN_WR_ACCEL_3R, gyroAlign = ALIGN_GYRO_3R } = {}) {
    this.commonAxis = commonAxis;
    this.refAxis = refAxis;
    this.axisSign = axisSign;
    this.tau = tau;
    this.accelSens = ACCEL_SENS[accelRange];
    this.gyroSens = GYRO_SENS[gyroRange];
    this.accelAlign = accelAlign;
    this.gyroAlign = gyroAlign;
    this.angle = null;       // fused angle (deg); null until first sample
  }

  reset() { this.angle = null; }

  /**
   * Feed one synchronised sample.
   * @param {{x,y,z}} accelRaw  raw accelerometer counts
   * @param {{x,y,z}} gyroRaw   raw gyroscope counts
   * @param {number}  dt        seconds since previous sample
   * @returns {number} the updated fused angle (deg)
   */
  update(accelRaw, gyroRaw, dt) {
    const accel = calibrate(accelRaw, this.accelSens, this.accelAlign);
    // axisSign mirrors the rotation sense for this mounting; it must be applied
    // to the accel angle and the gyro rate together or the fusion fights itself.
    const accelAngle = this.axisSign * inclineFromAccel(accel.x, accel.y, accel.z,
                                        { commonAxis: this.commonAxis, refAxis: this.refAxis });

    // Expose the device-frame inputs for debugging/plotting (what the filter sees).
    this.accel = accel;                       // g
    this.gyro = calibrate(gyroRaw, this.gyroSens, this.gyroAlign);  // deg/s
    this.accelAngle = accelAngle;             // deg, accel-only tilt (mirrored)

    // Seed with the absolute accelerometer angle on the first sample.
    if (this.angle === null) { this.angle = accelAngle; return this.angle; }

    const gyroDelta = this.axisSign * gyroRateAboutAxis(this.gyro, this.commonAxis) * dt; // deg
    this.angle = complementaryFilter(gyroDelta, accelAngle, dt, this.tau, this.angle);
    return this.angle;
  }
}

// ---------------------------------------------------------------------------
// KneeTracker — combines the two thigh segments into a single knee angle and
// counts flexion/extension repetitions.
//
// Angle convention (clinical goniometry, as in the original Sirona config
// where startangle=90 is the flexion limit and stopangle=180 the extension
// limit):
//     180 deg = straight leg (full extension)
//      90 deg = right-angle flexion
// Internally we track "flexion" = relative segment angle minus the zeroing
// offset (0 at the straight-leg pose), and report  angle = 180 - flexion.
// Zeroing at a known pose means absolute sensor alignment isn't required.
// ---------------------------------------------------------------------------
export class KneeTracker {
  /**
   * @param {object} opts
   * @param {object} opts.upper  SegmentTracker options for the upper-thigh sensor
   * @param {object} opts.lower  SegmentTracker options for the lower-thigh sensor
   * @param {number} opts.flexThreshold  angle (deg) at/below which a rep counts as flexed   (e.g. 95)
   * @param {number} opts.extThreshold   angle (deg) at/above which a rep counts as extended (e.g. 170)
   * @param {number} opts.sign  +1 or -1: flexion direction. Flip if flexing
   *                            reads above 180 (e.g. 270) instead of below.
   * @param {number} opts.thighSign  +1 or -1: direction of the thighTilt
   *                            posture readout, independent of the knee sign
   *                            (the two can disagree depending on mounting).
   */
  constructor({ upper = {}, lower = {}, flexThreshold = 95, extThreshold = 170,
                sign = 1, thighSign = 1 } = {}) {
    this.upper = new SegmentTracker(upper);
    this.lower = new SegmentTracker(lower);
    this.offset = 0;
    this.upperZero = null;   // upper-segment angle captured at the zero pose
    this.sign = sign;
    this.thighSign = thighSign;

    // Rep detection: a rep is one extended -> flexed -> extended cycle.
    this.flexThreshold = flexThreshold;
    this.extThreshold = extThreshold;
    this.reps = 0;
    this._phase = 'extended';   // 'extended' | 'flexed'
    this.minAngle = 180;        // peak flexion (lowest angle) within the current rep
  }

  updateUpper(accelRaw, gyroRaw, dt) { this.upper.update(accelRaw, gyroRaw, dt); }
  updateLower(accelRaw, gyroRaw, dt) { this.lower.update(accelRaw, gyroRaw, dt); }

  /** True once both segments have produced at least one sample. */
  get ready() { return this.upper.angle !== null && this.lower.angle !== null; }

  /** Current knee angle (deg): 180 = straight leg after zeroing, 90 = right-angle flexion. */
  get angle() {
    if (!this.ready) return null;
    const flexion = ((this.upper.angle - this.lower.angle) - this.offset) * this.sign;
    return 180 - flexion;
  }

  /** Capture the current pose as 180deg (patient standing with a straight leg). */
  zero() {
    if (this.ready) {
      this.offset = this.upper.angle - this.lower.angle;
      this.upperZero = this.upper.angle;
    }
  }

  /** Rep-detection phase: 'extended' (next goal: flex) or 'flexed' (next goal: extend). */
  get phase() { return this._phase; }

  /**
   * Thigh tilt (deg) relative to the zeroed pose — 0 when the patient is in
   * the same posture as at zero(), ~90 when the thigh has rotated to
   * horizontal (e.g. sitting down). Lets a visualization mirror the actual
   * posture, not just the knee angle. Null before zero() has been called.
   */
  get thighTilt() {
    if (!this.ready || this.upperZero === null) return null;
    return (this.upper.angle - this.upperZero) * this.thighSign;
  }

  /**
   * Update the flexion/extension rep counter with the latest knee angle.
   * Call once per rendered frame after feeding samples. Returns true when a
   * new rep was just completed.
   */
  tickRepCounter() {
    const a = this.angle;
    if (a === null) return false;

    let repCompleted = false;
    if (this._phase === 'extended' && a <= this.flexThreshold) {
      this._phase = 'flexed';
      this.minAngle = a;
    } else if (this._phase === 'flexed') {
      this.minAngle = Math.min(this.minAngle, a);
      if (a >= this.extThreshold) {
        this._phase = 'extended';
        this.reps += 1;
        repCompleted = true;
      }
    }
    return repCompleted;
  }

  resetReps() {
    this.reps = 0;
    this._phase = 'extended';
    this.minAngle = 180;
  }
}
