# Teach a Robot — IMU Balance-Reflex Demo

A Web Bluetooth demo of the idea that **wearable IMUs are a robot demonstration
rig**: no cameras, no lab — one wrist sensor is enough to capture a human
balance correction, fit a transparent one-number rule, and test that rule on a
robot under a new randomized floor motion.

Two stations share one 3D scene:

- **Human** (left): an avatar wearing 1 wrist IMU balances a **tray of bottles
  on one palm** while the platform pitches forward and backward and ramps up.
  The demonstrator gently raises or lowers the hand and forearm as one natural
  motion; no side-to-side wrist twisting is required.
- **Robot** (right): a congruent robot arm first **mirrors the human live**.
  Show it with no correction to capture an untrained baseline, record the
  human balancing, then let the learned reflex control the robot solo.

## The three-act demo

1. **See why correction matters.** Start the shared moving floor, then show the
   robot with no correction. The human tray stays compensated while the rigid
   robot tray spills, producing the untrained baseline time.
2. **Teach one balance reflex.** Record about 10 seconds of human balancing.
   The demo fits `trayPitchCorrection = gain × floorPitch` from the
   forward/backward pitch examples and explains the result physically (for
   example: “10° floor pitch → 8.9° opposite tray pitch”).
3. **Test the robot solo.** The human is off duty. The robot applies the learned
   gain to a fresh randomized floor motion, and its balance time is compared
   with the untrained baseline.

The **Try instant demo** button runs this entire flow with a human-like simulated
demonstrator. The sensor setup remains available in a collapsible hardware
section.

## The balance challenge

Press **Start live challenge**: the floor begins pitching forward and backward
and gets harder over time (the angle ramps toward 30°). Gently raise or lower
the hand and forearm to keep the tray level — a bottle toppling ends the attempt
and the balance time is shown. Press **Show robot with no correction** to
contrast a compensated tray with an uncorrected one on the *same* floor.

## Why this task fits IMUs

Balancing is a *pure orientation* skill: the tray pitch follows the wrist IMU's
orientation — the quantity IMUs measure best. Position plays only a supporting
role (palm sway slides the bottles), so nothing depends on camera-grade
positional accuracy. The forearm/tray quaternion retargets directly to the
robot's distal joint while both upper arms stay in the same waiter pose — no IK
is required.

## Requirements & use

- 1× **Shimmer3R** worn at the wrist, FW ≥ v1.0.22, or press
  **Try instant demo** to run with no hardware (also a booth attract mode).
- Built on the local MARG (9-DOF) fusion stack in `./fusion3d.js`:
  optional magnetometer hard-iron calibration (figure-8, shared localStorage
  with the hands-mag demo) prevents heading drift during long sessions.
- Calibration automatically supports any sensor axis, sign, or intermediate
  strap angle. With the strap kept fixed, hold the straight arm hanging and
  still (gyro bias + first gravity vector), then raise the same forearm forward,
  hold the palm/tray level, and press **Set tray level & place bottles** (second
  gravity vector + task zero). The two non-parallel vectors define forward, up,
  and right; the detected nearest signed axes are shown after capture.
- During demonstration, raise or lower the hand and forearm together to oppose
  forward/backward floor pitch; avoid twisting the wrist side to side.
- The default camera is an over-the-shoulder view from behind the robot, so
  physical forward matches the screen. A **Front overview** toggle remains in
  challenge settings.
- **Right/Left hand selector** (persisted) moves the avatar's arm to match the
  arm wearing the sensors — the pose math itself is side-agnostic.
- **Floor speed slider** (persisted, default 55%) scales how fast the platform
  oscillates/rotates. **Max floor angle slider** (persisted, default 30°, range
  10–45°) sets the peak tilt the floor ramps to. Note: bottles topple around
  ~13°, so below that the uncorrected robot never spills (gentle/easy mode).
- **Floor mode** (persisted, default *Forward / back*): the default rocks the
  floor about its pitch axis, and every recording automatically uses this mode
  so teaching and the graph stay pitch-only. *Free range* slowly rotates the
  floor-tilt direction as an optional harder test after training; the learned
  scalar pitch rule is applied symmetrically across both horizontal tilt
  components.

| File | Responsibility |
|------|----------------|
| `index.html` | Scene (human + robot stations, tilting platforms), cannon-es tray/bottle physics, disturbance generator, simulated demonstrator, UI. |
| `fusion3d.js` | Madgwick MARG fusion + `ArmImu` calibration. |
| `../shimmer-extension/vendor/shimmer-web-sdk.esm.js` | Shimmer3R Web Bluetooth client from the vendored `shimmer-web-sdk` (reused). |
