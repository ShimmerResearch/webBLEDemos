# Shimmer Capture

An example of configuring, streaming, plotting and recording **one** Shimmer3R
from a web browser, with no installer and no driver.

It is a worked example, not a replacement for the desktop application. There
is no device list, no trial management, no multi-sensor synchronisation and no
analysis: one sensor, one connection, one recording at a time. What it does
show is that everything a Shimmer3R can be told over its Bluetooth or USB link
is reachable from a page you can read in an afternoon.

- Live demo: [https://shimmerresearch.github.io/webBLEDemos/ShimmerCapture/](https://shimmerresearch.github.io/webBLEDemos/ShimmerCapture/)

## The three ways to connect

| Link                  | Configure | Read / write the configuration image | Calibration | Set the clock | Stream to the host | Log to the SD card |
| --------------------- | :-------: | :----------------------------------: | :---------: | :-----------: | :----------------: | :----------------: |
| **BLE**               |    yes    |                 yes                  |     yes     |      yes      |        yes         |        yes         |
| **Classic Bluetooth** |    yes    |                 yes                  |     yes     |      yes      |        yes         |        yes         |
| **USB-C**             |    yes    |                 yes                  |     yes     |      yes      |      **no**\*      |      **no**\*      |

\* **The Shimmer3R's USB-C port speaks the dock protocol, not the Bluetooth
one** — the firmware routes the bytes arriving on the USB serial port to the
same parser a docked sensor talks to, which is a configuration and
file-transfer channel with no sample stream on it at all. So over USB the page
configures the sensor, sets its clock, and reads and writes its configuration
image and calibration, and it closes the Stream tab off with a note saying
streaming needs a Bluetooth link. That is a property of the firmware, not a
limitation of the page.

The two Bluetooth links reach the same command set by different routes. **BLE**
uses Web Bluetooth and its own device picker. **Classic Bluetooth** uses Web
Serial against a COM port the operating system created when the sensor was
paired, so the sensor must already be paired with this host and you pick the
port rather than the device. A Shimmer3R pairs as two separate entries — one
classic, one BLE — and only the classic one answers on this path; the page says
so if you pick the wrong one.

## Configuring

The configuration editor is generated from the SDK's description of the
Shimmer3/Shimmer3R InfoMem, so it covers the **whole LogAndStream option set**
rather than a hand-picked subset: sampling rate, every sensor's range, rate,
low-power and high-resolution mode, GSR range, expansion-board power, the
pressure sensor's oversampling, the Bluetooth baud rate, the SD-logging
start-up and duration settings, the trial and experiment identifiers, the
multi-sensor sync settings and the stored calibration blocks. Every control
carries the byte and bit it lives in, on hover.

Two things the page owns rather than the schema:

- **The sensor checkboxes.** The enable bitmaps are per-channel maps rather
  than scalar settings, so they get a checkbox grid instead of a spinner.
- **The ExG mode.** Nobody configures an ADS1292R front end by typing register
  values, so a single control picks one of the known-good banks — EMG, ECG or
  test signal, 16-bit — and takes over the ExG sensor bits so two controls can
  never fight over them.

**The working document is the 384-byte image.** Every control reads and writes
those bytes directly, so the reserved bits and the regions no field on the page
models survive a read, an edit and a write untouched — which is what makes it
safe to edit one setting on a sensor configured by something else. A hex view
shows the whole image with the changed bytes highlighted, and it can be saved
to a `.bin` and loaded back, so a configuration can be captured from one sensor
and applied to another.

**Apply** shows you what it is about to write, and then the steps it will take.
The order is the firmware's, not a preference: the stored image first, then the
SD-card configuration file, then the settings that also have an
immediate-effect command (sensors, then sampling rate, then ranges, then
expansion power) and the ExG bank last, because its oversampling ratio is
derived from the sampling rate that was just set. It finishes by asking the
sensor what it now says rather than trusting what was written. **The firmware
refuses configuration commands while the sensor is sensing**, so Apply is
greyed out with that reason while a stream or a recording is running.

## Device and clock

A refresh reads the battery voltage and charge, the decoded device status flags
— docked, sensing, streaming, logging, SD card present, SD file error, clock
set — and the real-world clock. The sensor keeps that clock in **local civil
time**, which is what the offline file parser expects, so setting it from the
host applies the host's time-zone offset rather than writing plain UTC.

## Calibration

The calibration dump is the sensor's own record of every per-sensor calibration
it holds: which sensor, at which range, calibrated when. The page reads it into
a table, saves it to a file and writes one back. Note the ordering the firmware
imposes — writing a configuration image regenerates the dump from the
configuration bytes, so a dump must be written **after** a configuration, never
before.

## Streaming, plotting and recording

Start a stream on its own, or a stream and an SD recording together. The plot
draws one panel per sensor group from the channels the sensor is actually
sending, in raw or calibrated units, over a 5, 10 or 30 second window, and can
be paused without interrupting the stream. Alongside it a statistics strip
reads the achieved rate, the configured rate, packet loss — measured against
gaps in the _device_ clock, not host arrival times, so host Bluetooth buffering
cannot invent losses — throughput, frame count and elapsed time.

Recording writes a CSV named `Shimmer3R_<last 4 of MAC>_<yyyymmdd_hhmmss>.csv`.
Its columns are derived from the first frame that arrives, so they are the
channels the sensor is sending rather than the ones the page expected, and rows
stream straight to the file you pick instead of being held in memory — a long
session is not lost if the tab closes. If the link drops mid-recording the file
is closed properly and what was captured is kept.

An event log below both tabs carries every command, reply and status message,
filterable by text and severity, and downloadable — which is the first thing to
attach to a support request.

## Requirements

- A **Shimmer3R**. Firmware v1.0.22 or later for BLE streaming; the
  configuration and calibration paths need firmware that serves the InfoMem
  commands.
- A **Chromium browser** — Chrome or Edge. BLE needs Web Bluetooth; classic
  Bluetooth and USB-C need Web Serial. Neither is available in iOS browsers,
  and Android has Web Serial for paired Bluetooth ports only.
- A **secure origin**: `https://` or `localhost`. Opening the file directly
  from disk will not do — the browser refuses both APIs on a `file://` page.
- Streaming a CSV straight to disk uses the File System Access API. Without it
  the page buffers the recording in memory and downloads it when you stop.

## `?mock=1` — developing without a sensor

Append `?mock=1` to the URL and a **Connect (mock)** button appears, which
connects the page to a scripted Shimmer3R that answers on a loopback link. It
is a development aid, not a firmware simulator: it answers the commands this
page sends with plausible values and correct framing, and emits synthetic sine
data at the configured rate. It does not model timing, power, the SD card or
error paths, and it deliberately does not implement every command — a refused
one is a useful thing to be able to see.

| Parameter    | Effect                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `?mock=1`    | Framed replies, one per notification — how BLE behaves.                                                                  |
| `&framed=0`  | Replies dribbled three bytes at a time — how a classic-Bluetooth or USB byte stream behaves, and what re-framing is for. |
| `&rate=<Hz>` | Sampling rate, default 51.2.                                                                                             |
| `&debug=1`   | Log every command and reply to the browser console.                                                                      |

While the mock is connected, `mockTransport.writes` in the console is every
command the page has sent, and `mockTransport.emitDisconnect()` simulates a
dropped link.

It is opt-in from the URL only, and deliberately so: a page that reached for
the mock on its own would quietly show fake data to somebody debugging real
hardware.

## Status

This is an early example. It has been exercised end to end against the mock
link; the paths that only a real sensor can prove — that a configuration write
is accepted and applied, that a calibration dump round-trips, that a long
recording holds up at high rates — want confirming on hardware before anyone
relies on them for real work. Check a recording before it matters.
