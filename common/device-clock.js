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
 *
 *   if (canReadRwc(client)) {
 *     const { unixMs } = await readDeviceRwc(client, mode);
 *   }
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

/** Does this client carry the Bluetooth clock read (GET_RWC)? */
function hasRadioRead(client) {
  return typeof client?.getRtcTime === "function";
}

/** Does this client carry the dock's clock-property read? */
function hasDockRead(client) {
  return typeof client?.getConfig === "function" && !!DOCK_TIME_PROP;
}

/**
 * Whether this client can be asked the time at all.
 *
 * **Takes no mode, on purpose.** The link decides WHICH read is used, not
 * WHETHER one is available — a client carrying either command can be asked.
 * An earlier version took a mode and answered "no" for a dock-like client on
 * an undeclared link, while {@link readDeviceRwc} read it happily: the gate
 * and the reader disagreed on one shape, which is the same class of bug this
 * module was written to remove, one layer down. Found by Copilot on
 * webBLEDemos#76. The reader now refuses exactly when this returns false, so
 * the two cannot drift apart again.
 *
 * The invariant worth stating, because it is the one that broke: a control
 * gated on `describeShimmer3Caps(...).rtcRead` must be servable here.
 * `rtcRead` is `getRtcTime || (usb && getConfig)`, and both of those imply
 * this — so "enabled and always refuses" is unreachable. This is deliberately
 * the more permissive of the two: it says yes to a `getConfig`-only client on
 * any link, which is what lets the clock-drift panel keep working for a
 * dock-like client whose page never declared a mode.
 *
 * @param {object|null|undefined} client
 * @returns {boolean}
 */
export function canReadRwc(client) {
  if (!client) return false;
  return hasRadioRead(client) || hasDockRead(client);
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
 * @param {string|null|undefined} [mode] the link — `"ble"`, `"rfcomm"`,
 *   `"usb"`. Chooses the PATH, never whether there is one: see
 *   {@link canReadRwc}. On `"usb"` the dock property is used even by a client
 *   that also carries `getRtcTime`, because on that link the radio command
 *   does not exist.
 * @returns {Promise<{ticks: bigint, unixMs: number, viaDock: boolean}>}
 * @throws if nothing is connected, this client has no way to read the clock,
 *   or the answer is the wrong length. Never returns a guess.
 */
export async function readDeviceRwc(client, mode) {
  if (!client) throw new Error("no sensor is connected");
  /* The gate, called rather than restated: an independent condition here is
     exactly how the page came to have a button that was enabled and always
     refused. */
  if (!canReadRwc(client)) {
    /* `getConfig` and not `hasDockRead` here: the latter already folds in the
       property check, so testing it would make this branch unreachable. The
       distinction is worth keeping — a dock client on a bundle too old to
       export CURR_LOCAL_TIME is a re-vendor away from working, and saying
       "no way to read the clock" would send someone looking at the sensor. */
    throw new Error(
      typeof client.getConfig === "function"
        ? "this SDK bundle has no CURR_LOCAL_TIME property — re-vendor it to read the clock over a wired link"
        : "this client has no way to read the sensor clock",
    );
  }

  /* Dock first when the link is the dock's, because the radio command does
     not exist there whatever methods the object happens to carry — and dock
     also as the fallback for a client with no radio read, so a dock-like
     client works without the caller having to declare a mode. */
  const useDock =
    (mode === "usb" || !hasRadioRead(client)) && hasDockRead(client);

  if (useDock) {
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
