/**
 * Reading a Shimmer3/Shimmer3R real-world clock, on whichever link is up.
 *
 * There are two ways to ask, and which one works is a property of the LINK,
 * not of the sensor:
 *
 *   - Over Bluetooth, `Shimmer3RClient.getRtcTime()` — GET_RWC (0x91), whose
 *     response is an 8-byte little-endian tick count at 32768 Hz since the
 *     Unix epoch.
 *   - Over the USB-C/dock link there is no such command. The dock protocol
 *     has a read-only property instead, `MAIN_PROCESSOR.CURR_LOCAL_TIME`,
 *     which returns the same eight bytes in the same unit.
 *
 * This module exists because that fact was known in exactly one place. The
 * clock-drift panel had worked out the dock path and used it; the page's own
 * "read the clock" paths tested `typeof client.getRtcTime === "function"` and
 * gave up over USB — while `describeShimmer3Caps` reported `rtcRead` TRUE
 * there, because it counts `getConfig` as a way to read the clock. So the
 * button was enabled and always refused, and the README had been written to
 * match the bug ("over USB the clock can be set but not read back"). Found by
 * Copilot on webBLEDemos#76.
 *
 * One definition, so a page cannot gate a control on one rule and act on
 * another.
 *
 * Nothing here touches `document`.
 *
 *   import { readDeviceRwc, canReadRwc } from "../common/device-clock.js";
 */

import * as sdk from "../vendor/shimmer-web-sdk.esm.js";

/** The real-world clock counts these per second, on both paths. */
export const RWC_TICKS_PER_SECOND = 32768;

/**
 * The dock's read-only "what time is it now" property.
 *
 * Optional: a vendored bundle from before it was exported simply cannot read
 * the clock over a wired link, which {@link canReadRwc} reports up front
 * rather than leaving to be discovered at the first read.
 */
const DOCK_TIME_PROP = sdk.UART_PROP?.MAIN_PROCESSOR?.CURR_LOCAL_TIME ?? null;

/** 64-bit little-endian tick count from an 8-byte answer. */
function ticksFromBytes(u8) {
  let ticks = 0n;
  for (let i = 7; i >= 0; i--) ticks = (ticks << 8n) | BigInt(u8[i]);
  return ticks;
}

/**
 * Whether this client on this link can be asked the time at all.
 *
 * Mirrors `describeShimmer3Caps(...).rtcRead`, deliberately: a control gated
 * on that capability has to be served by {@link readDeviceRwc}, or the button
 * is enabled and the handler refuses — which is the bug this module was
 * written for.
 *
 * @param {object|null|undefined} client
 * @param {string|null|undefined} [mode] the link — `"ble"`, `"rfcomm"`, `"usb"`
 * @returns {boolean}
 */
export function canReadRwc(client, mode) {
  if (!client) return false;
  if (typeof client.getRtcTime === "function") return true;
  return (
    mode === "usb" && typeof client.getConfig === "function" && !!DOCK_TIME_PROP
  );
}

/**
 * Read the sensor's real-world clock.
 *
 * The reading is handed back UNMODIFIED, in the sensor's own base. Do not
 * "correct" it here: a Shimmer3R set by the Java dock driver or by Consensys
 * carries UTC, and one set by a tool using another convention carries that
 * convention's base — the caller is what decides whether to treat a whole
 * offset as a base or as error (the drift panel detects it; the clock readout
 * simply shows it).
 *
 * @param {object} client
 * @param {string|null|undefined} [mode] the link — see {@link canReadRwc}
 * @returns {Promise<{ticks: bigint, unixMs: number, viaDock: boolean}>}
 * @throws if nothing is connected, the link has no way to read the clock, or
 *   the answer is the wrong length. Never returns a guess.
 */
export async function readDeviceRwc(client, mode) {
  if (!client) throw new Error("no sensor is connected");

  /* The wired path is also the fallback for a client with no radio clock
     command, so a dock-like client that only implements `getConfig` works
     without the caller having to declare a mode. */
  if (mode === "usb" || typeof client.getRtcTime !== "function") {
    if (typeof client.getConfig !== "function") {
      throw new Error("this link has no way to read the sensor clock");
    }
    if (!DOCK_TIME_PROP) {
      throw new Error(
        "this SDK bundle has no CURR_LOCAL_TIME property — re-vendor it to read the clock over a wired link",
      );
    }
    const raw = await client.getConfig(DOCK_TIME_PROP);
    if (!raw || raw.length < 8) {
      throw new Error(`CURR_LOCAL_TIME returned ${raw?.length ?? 0} bytes`);
    }
    const ticks = ticksFromBytes(raw);
    return {
      ticks,
      unixMs: (Number(ticks) / RWC_TICKS_PER_SECOND) * 1000,
      viaDock: true,
    };
  }

  const { ticks, unixMs } = await client.getRtcTime();
  return { ticks, unixMs, viaDock: false };
}
