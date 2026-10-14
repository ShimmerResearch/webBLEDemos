# Knee Angle — Dual-IMU Physio Demo

> This folder contains **two demos**: `index.html` (knee angle, 2D) and
> `hands.html` (arm & hand, 3D — see [below](#arm--hand-3d-demo-handshtml)).

A Web Bluetooth demo that estimates **knee flexion/extension angle** in real time
from two Shimmer3R sensors (one above, one below the knee), and coaches the user
through repetitions against a target range.

This is a modern, browser-based reimagining of the sensor-fusion core of the
original **Shimmer Sirona** Android physio app — stripped of the patient/database
administration layers, focused on the algorithm and a polished live readout.

## Requirements
- 2× **Shimmer3R**, FW ≥ v1.0.22
- A Web Bluetooth capable browser (Chrome / Edge)

## Use
1. Mount one sensor on the thigh and one on the shank, sagittal axis aligned.
2. **Connect** both sensors.
3. Stand with a straight leg and press **Zero** — the straight-leg pose then
   reads **180°**, and flexing to a right angle reads 90° (the anatomical
   convention the gauge, the trace and the rep counter all use).
4. Flex and extend the knee. The gauge, live trace, and rep counter update in real time.

## Structure
| File | Responsibility |
|------|----------------|
| `kinematics.js` | **Pure algorithm module** — calibration, complementary filter, per-segment inclination, knee angle, rep counting. No DOM, no Bluetooth; unit-testable in isolation. |
| `index.html` | UI + Web Bluetooth wiring. Imports `Shimmer3RClient` from `../shimmer-extension/vendor/shimmer-web-sdk.esm.js` and `KneeTracker` from `kinematics.js`. |

## Algorithm
Each sensor delivers raw accelerometer and gyroscope counts, which are calibrated
to `g` / `deg/s` **and rotated into the device frame**, then fused per segment.

> **Why alignment matters here:** on the Shimmer3R the wide-range accel
> (LIS2DW12) and the gyro (LSM6DSV) are different chips mounted in different
> orientations, so their raw axes do **not** agree. The complementary filter
> fuses "gyro rotation about axis N" with "accel tilt about axis N" and breaks
> without a common frame. `kinematics.js` applies the default alignment
> matrices from the official Shimmer C# API (`Shimmer-C-API`,
> `ShimmerBluetooth.cs`) before fusing.

- **Accelerometer** → absolute tilt via `atan2` (drift-free but noisy)
- **Gyroscope** → integrated angle delta (smooth but drifts)
- **Complementary filter** blends them: `angle = a·(prev + gyroΔ) + (1−a)·accelAngle`, `a = τ/(τ+dt)`

The **knee angle** is the difference between the two fused segment angles, minus a
zeroing offset captured at the straight-leg pose — so absolute sensor alignment is
not required.

---

## Arm & Hand 3D demo (`hands.html`)

A 3D full-body mannequin (both arms + both legs) where **two IMUs drive
whichever limb you select** — proximal sensor on the upper arm / thigh, distal
on the wrist / ankle — with full quaternion sensor fusion. Sessions can be
**recorded and played back** on the mannequin.

| File | Responsibility |
|------|----------------|
| `fusion3d.js` | **Madgwick 6-DOF AHRS** (gradient-descent quaternion filter) + `ArmImu` (calibration, gyro-bias capture, reference pose, earth-frame delta). Pure module, no DOM/BLE; reuses `kinematics.js` for raw→device-frame calibration. |
| `hands.html` | three.js scene (articulated torso/arm/hand, orbit camera, lighting/shadows) + Web Bluetooth wiring + calibration UI. |

### Use
1. Strap one sensor to the upper arm, one to the wrist (any orientation).
   **Connect** both.
2. Press **▶ Demo the calibration** to watch the mannequin perform the
   procedure, then press **⦿ Calibrate**:
   - **1/2** — hold the arm still at your side (~1.25 s: gyro bias + reference pose)
   - **2/2** — swing the straight arm forward & back ×3 (the mannequin loops
     the motion as a guide). Swing **forward first** — that defines "forward".
3. Move: the 3D arm follows in real time. Orbit with the mouse.

**Why the swing?** Without a magnetometer, each IMU's heading (yaw) is
arbitrary, and strapping differences add an unknown yaw offset between the two
sensors. During the swing both sensors rotate about the same physical axis
(the shoulder), so measuring that axis in each filter's earth frame exposes the
offset exactly — no strapping discipline needed. Re-calibrate anytime to heal
slow yaw drift.

### Features
- **Madgwick fusion** per IMU: smooth drift-corrected 3D orientation from
  accel + gyro alone (high beta during settling, low beta while tracking).
- **Active-limb selector** — left/right arm or left/right leg (remembered per
  browser); sensor labels, joint limits, HUD wording, and piñata height adapt.
- **Record / playback** — capture a live session (world-orientation keyframes
  per frame) and replay it on the mannequin through the same pose pipeline.
- **Biological elbow limits** (toggleable, off by default): flexion 0–150°,
  pronation/supination ±90°, varus/valgus ±8° — applied to the relative
  wrist-vs-upper-arm rotation.
- Elbow flexion + forearm rotation HUD.
- **Functional calibration** (hold-still + arm-swing) aligns the two sensors'
  heading frames regardless of how each is strapped; the mannequin demos and
  guides the procedure. Re-calibrate anytime to heal slow yaw drift.
- **Piñata**: cannon-es rigid-body physics — rope chain, momentum transfer from
  real hand velocity, confetti hits, rope-snap break, floor bounce, respawn.
