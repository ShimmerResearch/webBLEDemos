# Teach a Robot — IMU Teleoperation Demo

A Web Bluetooth demo of the idea that **wearable IMUs are a robot control /
demonstration rig**: no cameras, no lab — a couple of sensors on the arm are
enough to drive a robot live and show why a human's corrections matter.

Two stations share one 3D scene:

- **Human** (left): an avatar wearing 2 IMUs balances a **tray of bottles on
  one palm** while the platform under it slowly tilts and ramps up.
- **Robot** (right): a congruent robot arm **shadows the human live**. Turn
  "follows my movements" off and its arm goes rigid — the same shifting floor
  now tips its tray and the bottles go over, while yours (compensated) stay up.

## The balance challenge

Press **Start**: the floor begins shifting and gets harder over time (tilt
ramps toward 30°). Keep the tray level — a bottle toppling ends the attempt and
your balance time is shown (with a session best). The robot mirrors you, so it
only survives as long as you do. Toggle **Robot follows my movements** any time
to contrast a compensated tray with an uncorrected one on the *same* floor.

## Why this task fits IMUs

Balancing is a *pure orientation* skill: the tray attitude **is** the wrist
IMU's orientation — the quantity IMUs measure best. Position plays only a
supporting role (palm sway slides the bottles), so nothing depends on
camera-grade positional accuracy. The robot arm is kinematically congruent
with the human arm, so joint quaternions retarget directly — no IK.

## Requirements & use

- 2× **Shimmer3R** (upper arm + wrist), FW ≥ v1.0.22, or tick
  **"Simulated demonstrator"** to run with no hardware (also a booth attract
  mode).
- Built on the MARG (9-DOF) fusion stack from `../knee-angle/fusion3d.js`:
  mag hard-iron calibration per sensor (figure-8, shared localStorage with the
  hands-mag demo), heading-drift-free for long wear.
- Calibration is the **functional 2-step flow** (avatar-guided): hang the arm
  &amp; hold still (gyro bias) → swing the straight arm forward &amp; back ×3
  (both sensors rotate about the same physical axis, which aligns their frames
  regardless of how the pucks are strapped, and pins "forward" physically).
- Then hold the tray pose and press **"Set tray level &amp; place bottles"** —
  an explicit capture, because stillness alone can't distinguish a hanging arm
  from the tray pose. The same button re-zeros the level anytime.
- **Right/Left hand selector** (persisted) moves the avatar's arm to match the
  arm wearing the sensors — the pose math itself is side-agnostic.
- **Floor speed slider** (persisted, default 25%) scales how fast the platform
  oscillates/rotates. **Max tilt slider** (persisted, default 30°, range
  10–45°) sets the peak tilt the floor ramps to. Note: bottles topple around
  ~13°, so below that the uncorrected robot never spills (gentle/easy mode).
- **Tilt mode** (persisted, default *Left / right*): *Left / right* rocks the
  floor along a single axis — compensated by one wrist roll, much easier for a
  demo. *Free range* slowly rotates the tilt direction (harder, all axes).

| File | Responsibility |
|------|----------------|
| `index.html` | Scene (human + robot stations, tilting platforms), cannon-es tray/bottle physics, disturbance generator, simulated demonstrator, UI. |
| `../knee-angle/fusion3d.js` | Madgwick MARG fusion + `ArmImu` calibration (reused). |
| `../ShimmerAPI/shimmer3r.js` | Shimmer3R Web Bluetooth client (reused). |
