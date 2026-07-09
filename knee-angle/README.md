# Knee Angle — Dual-IMU Physio Demo

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
3. Stand with a straight leg and press **Zero** — this defines 0°.
4. Flex and extend the knee. The gauge, live trace, and rep counter update in real time.

## Structure
| File | Responsibility |
|------|----------------|
| `kinematics.js` | **Pure algorithm module** — calibration, complementary filter, per-segment inclination, knee angle, rep counting. No DOM, no Bluetooth; unit-testable in isolation. |
| `index.html` | UI + Web Bluetooth wiring. Imports `Shimmer3RClient` from `../ShimmerAPI/shimmer3r.js` and `KneeTracker` from `kinematics.js`. |

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
