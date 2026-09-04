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

| Link                  | Configure | Read / write the configuration image | Set the clock | Status flags | Calibration dump | Stream to the host | Log to the SD card | Browse / download the card | Set device names | Factory self-test | Clock drift | Red LED |
| --------------------- | :-------: | :----------------------------------: | :-----------: | :----------: | :--------------: | :----------------: | :----------------: | :------------------------: | :--------------: | :---------------: | :---------: | :-----: |
| **BLE**               |    yes    |                 yes                  |      yes      |     yes      |       yes        |        yes         |        yes         |            yes             |       yes        |        yes        |     yes     |   yes   |
| **Classic Bluetooth** |    yes    |                 yes                  |      yes      |     yes      |       yes        |        yes         |        yes         |            yes             |       yes        |        yes        |     yes     |   yes   |
| **USB-C**             |    yes    |                 yes                  |      yes      | battery only |        no        |      **no**\*      |      **no**\*      |          **no**\*          |       yes        |      yes\*\*      |     yes     | **no**  |

\* **The Shimmer3R's USB-C port speaks the dock protocol, not the Bluetooth
one** — the firmware routes the bytes arriving on the USB serial port to the
same parser a docked sensor talks to, which is a configuration and
file-transfer channel with no sample stream on it at all. So over USB the page
configures the sensor, sets its clock and reads and writes its configuration
image, and it closes the Stream tab off with a note saying streaming needs a
Bluetooth link. That is a property of the firmware, not a limitation of the
page.

The dock protocol is a different command set, not a subset, which is why the
last few columns differ: it has no `STATUS_RESPONSE` (it reports the battery
instead of the status bits) and no calibration-dump command, so the page greys
those controls out rather than guessing. It does have a clock write, so
setting the clock works over all three links, and it has a test command, so the
self-test runs over all three too.

\*\* Over the dock the ExG chip test reports FAIL, because that connection and
the chip share pins and the firmware says so in the report itself. That is the
docked test, not the board — run the self-test over Bluetooth to judge an ExG
expansion board.

The two Bluetooth links reach the same command set by different routes. **BLE**
uses Web Bluetooth and its own device picker. **Classic Bluetooth** uses Web
Serial against a COM port the operating system created when the sensor was
paired, so the sensor must already be paired with this host and you pick the
port rather than the device. A Shimmer3R pairs as two separate entries — one
classic, one BLE — and only the classic one answers on this path; the page says
so if you pick the wrong one.

## General

The first tab, as in the Verisense device console, and for the same reason: the
one-shot commands somebody reaches for straight after connecting come before
the tabs that are a task in themselves.

The **clock** is here rather than with the configuration because it is a device
command and not a stored setting — the real-world clock is not part of the
configuration image. Set it from this host, or read it back on its own; reading
it alone is deliberately not the Device panel's **Refresh**, which also reads
the battery and the status bytes, because three round trips to answer one
question is three chances for one of the others to put an error on screen about
something nobody asked about.

The **LEDs** are here rather than on the Test tab because nothing about them is
a test. They drive the firmware's red-LED override, which holds the lower LED
solid red on top of the sensor's own indications: a "which sensor is this one"
aid, not a health check. The firmware never clears the flag, so it stays lit
across a disconnect until it is toggled again or the sensor is power-cycled,
and the pill shows what the sensor's own status byte says rather than what this
page last asked for. Bluetooth only — the dock protocol has no LED command. The
sequence that exercises every LED _colour_ is part of the factory self-test,
which is on **Test**.

**Device commands** is the general place for the rest. **Re-inquire channel
list** asks the firmware what it is set to send and at what rate — the page
does this on connect and after an Apply, so this is for the case where
something else reconfigured the sensor meanwhile. **Reboot on next disconnect**
arms the firmware's one-shot soft reboot: it cannot reboot while the link is
up, and it skips the reboot entirely while the sensor is recording so that it
can never truncate a trial. Reach for it after writing advertising names, which
the Bluetooth module only re-reads at boot.

## Configuring

The configuration editor is generated from the SDK's description of the
Shimmer3/Shimmer3R InfoMem, so it covers the **whole LogAndStream option set**
rather than a hand-picked subset: sampling rate, every sensor's range, rate,
low-power and high-resolution mode, GSR range, expansion-board power, the
pressure sensor's oversampling, the Bluetooth baud rate, the SD-logging
start-up and duration settings, the trial and experiment identifiers, the
multi-sensor sync settings and the stored calibration blocks. Every control
carries the byte and bit it lives in, on hover.

The **Calibration** group in that form is the six 21-byte kinematic blocks the
image holds, and they are laid out the way the Calibration tab lays out the
dump: an offset vector, a sensitivity vector and a 3x3 alignment matrix, each
labelled with its unit, and a chip naming the range the image is configured for
— which is what makes the numbers mean anything, since the image holds one
block per sensor rather than one per range. Forty-two hex characters in a text
box was what the bytes are and unreadable with it.

They are editable here, and read-only on the Calibration tab when that tab
falls back to showing the image: the configuration image belongs to this form,
and two panels writing one image would silently drop whichever change lost. A
value the 21-byte format cannot hold is refused with the box named, never
clamped, and a block holding no calibration at all — every byte 0x00 or 0xFF —
shows the factory defaults the firmware would fall back to, greyed, so nobody
reads them as measurements.

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

## Device identity, on every tab

The panel beside the Sensor link card carries what is true of the sensor
whatever tab you are on: its name, MAC, hardware and firmware, the battery
voltage, charge and charger state, which link it is on, and — over a Bluetooth
link — the decoded device status flags: docked, sensing, streaming, logging,
SD card present, SD file error, clock set, USB plugged in.

It sits there rather than on the Configure tab because two of those facts gate
work everywhere else. Whether the sensor is sensing decides both an SD download
and a name write, and the battery is the thing to check before starting a long
download. The flags are also the only way to learn that the sensor was started
from its own button, or that its firmware could not open its SD file; the page
says so in the log when it sees them.

**Measure link speed** is next to the connect buttons, because it measures the
link and not the card: it free-runs the firmware's data-rate test, which
reports the pipe itself — connection interval and MTU on BLE, buffering on
Classic Bluetooth — rather than the file-transfer protocol on top of it. It is
Bluetooth-only (the dock command set has no data-rate test) and refused while
the sensor is sensing or a transfer is running, because it saturates the link
on purpose. The figure it produces also drives the download ETAs on the SD tab.

## The clock

On the **General** tab. The sensor keeps its clock in **UTC**, which is what
desktop Consensys and the dock software write, so setting it from this host
writes a plain epoch and both the sensor's clock and the host's are shown in
this host's local time — they should read the same.

It reads and writes over **every** link, USB-C included. There is no dock
equivalent of the Bluetooth GET_RWC command, but the dock protocol has a
read-only `CURR_LOCAL_TIME` property that answers with the same eight bytes in
the same unit, so the two paths are interchangeable — `common/device-clock.js`
picks whichever the current link has. (An earlier version of this page said
the clock could be set but not read back over USB. That was true of the page,
not of the link: it tested for the Bluetooth method and gave up, while the
capability it gated the button on already counted the dock property. So the
button was enabled and always refused.)

(An earlier version of this page wrote and displayed the clock as local civil
time, a convention belonging to the Verisense console. It made a sensor set by
Consensys read a whole time-zone offset adrift, and a sensor set here read
adrift in Consensys.) The **Test** tab measures how far the sensor's clock
drifts from this host's over time.

## Calibration

Its own tab, because calibration is per-sensor and per-range rather than a
device setting, and because reading nine numbers off a hex dump is not a way to
check whether a sensor is calibrated.

Each sensor gets a card: an offset per axis, a sensitivity per axis in that
sensor's own units, and a 3x3 alignment matrix, with the range the values apply
to and the date they were written. Sensitivity is three numbers rather than a
matrix because that is what the 21-byte block holds — a 3x3 grid would offer
six cells that cannot be saved. Alignment entries are signed bytes scaled by a
hundredth, so they are bounded, and a value the format cannot hold is refused
rather than quietly clamped on the way out.

A sensor the hardware does not have is not offered: a Shimmer3 has neither the
high-g accelerometer nor the second magnetometer a Shimmer3R carries. Where the
sensor never said what hardware it is, the panel takes the hardware identity
from the dump's own version header rather than from the page's default, so it
cannot invite edits to sensors that may not exist.

Three states are worth telling apart, and the panel does: values written for
this particular device, values that are still the factory seed, and no record
at all. The last is not zero — an unwritten block reads back as all ones or all
zeros, and showing that as a calibration of zero would be a lie about a sensor
that has never been calibrated. A per-sensor restore puts the factory seed back
for the selected range.

The calibration is read **as part of the connect handshake**, along with the
configuration image, so the tab is populated before anybody opens it — a page
that showed a sensor's settings without showing what it is calibrated to had
told half the story, and the tab otherwise sat empty until somebody thought to
press Read. It goes last in the handshake, because it needs the generation and
the configured ranges the earlier reads establish, and it is tolerated rather
than required: an older firmware NACKs the command, and a tab that could not
be filled is not a connection that failed.

Every card carries its date line whenever anything has been read, saying "no
date" where there is none. A line that appeared on three sensors and not on the
others read as those three being the only ones with a calibration date, when
what it meant was that the rest have no calibration at all — a different fact,
and one the pill beside each title already makes.

Reads, writes and the raw dump's save and load all work over a Bluetooth link.
The dock protocol has no calibration-dump command, so the controls are greyed
out over USB. One ordering the firmware imposes and the tab says out loud:
writing a configuration image regenerates the dump from the configuration
bytes, so a calibration must be written **after** a configuration, never
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

## The event log

A drawer docked to the bottom of the viewport carries every command, reply and
status message, filterable by text and severity, and downloadable — which is
the first thing to attach to a support request.

Collapsed it is a single bar showing the newest line, with a badge counting the
errors and warnings you have not seen — anything that arrived while the drawer
was closed, or while it was open but scrolled back through history. Opening it,
or scrolling back to the newest line, clears the badge.
Expanded it keeps the full page width, and whether it is open is remembered per
browser. The page reserves the space it occupies in either state, so it never
covers what is underneath it.

**Copy** puts the whole log on the clipboard — every line, not just the ones
the filter is showing, which is the same text **Download** saves. It reports
what happened either way: the clipboard API is refused outside a secure context
and on an unfocused document, and a log is exactly what somebody wants to copy
when something has gone wrong, so a copy that silently did nothing would be the
worst possible failure.

**Log raw TX/RX bytes** adds the bytes themselves, in both directions, on any
of the three links — the diagnostic to reach for when a sensor answers
something unexpected, or answers nothing. It is off until asked, and it leaves
out the streaming data packets unless you tick the second box, because a sensor
at 1024 Hz sends one every millisecond. Either way it is capped at 100 lines a
second, with one line saying what was held back. The severity filter's
**TX / RX** option shows exactly these lines; if the two controls are set so
that nothing can appear, the drawer says which one to change.

## The SD card

Browses the sensor's card and pulls logged sessions off it. Sizes and free
space come from the card itself; pick whole sessions or individual files.

Files can be written either as the card lays them out or into the folder
structure Consensys imports, which is the default — the layout matters, because
Consensys will not find a session filed the other way. That structure is

    <destination>/<import date and time>/<MAC id>/data/<trial>/<session>/<file>

and the second level is the sensor's **MAC address**, twelve lowercase hex
digits, not its name: a name folder produces a tree the Consensys importer
walks straight past, so the download looks complete and cannot be imported.
The panel shows the path it is about to write before it writes anything, with
the real MAC in it, and says so plainly if the address could not be read.

The destination folder is remembered between visits, so a long download does
not start with a file dialog every time. A browser can never preselect an
absolute path, so the first download of a session asks once.

A transfer shows its throughput and an estimate of the time left, and can be
aborted. Aborting keeps what has already been written and the folder it went
into, so pressing Download again resumes rather than starting a second copy
alongside the first. A file can optionally be deleted from the card once its
download has been verified — only verified files, and it says how many before
it does it.

This needs a Bluetooth link and **firmware v1.01.011 or later**. Earlier
firmware either has no SD file-transfer commands at all or, on v1.01.009 and
v1.01.010, has them and corrupts every 512-byte block in transit, so the tab
refuses to start rather than hand back a file that looks fine and is not.

## Device names

Reads and writes the record in the sensor's EEPROM that decides the names it
advertises over Classic Bluetooth and BLE, and presents over USB, so a sensor
can carry a customer's branding instead of the Shimmer defaults.

Type one Classic-Bluetooth name and the BLE and USB product names follow it
unless you set them yourself; the USB manufacturer string is used verbatim by
the descriptor and is never derived. The name lengths a sensor can carry differ
by hardware and by field, and the editor holds you to them rather than letting
the firmware truncate a name on air — where a sensor will not say what hardware
it is, it applies the shorter limit rather than assuming the roomier one.

A write is CRC-protected, read back and compared, and shows what is changing
before it goes. **A new name only takes effect after the sensor restarts.** Over
a Bluetooth link the tab can arm the restart and trigger it by disconnecting;
over the dock it walks you through a power-cycle, because the dock protocol has
no restart command. "Restore stock defaults" returns the sensor to its factory
names.

Works over all three links: the record lives in the same place and is reached
the same way whether the sensor is on a radio or in a dock.

## Test

Two things the sensor can be asked about itself. (The red LED used to be a
third; it is on **General** now, because nothing about it is a test.)

**The factory self-test** is the same suite the firmware runs on the
production line, and it prints the same report: pick one of its four suites
(everything, LEDs only, chips only, or the LED operating states), press Run,
and the report appears line by line as the sensor prints it, with PASS, FAIL
and WARNING picked out. When it finishes, the parsed verdict appears above it
— including the failing test names decoded from the report's own fail mask —
and the report can be copied, saved as text, or saved as a CSV row.

Two things are worth knowing before pressing Run. The sensor stops everything
else while it runs, and answers no other command until the report ends, so the
rest of the page is refused with that reason meanwhile — up to about a minute
for the LED-state walk-through. And **the firmware has no way to be
interrupted**: Cancel stops this page listening, but the sensor keeps printing
to its own end, so the page stays busy until then and says so. Disconnecting
is the only way out early. The LED suites are meant to be watched — each line
names the LED that should be lit at that moment.

Over the USB-C/dock link the test runs through the dock protocol's own test
command. One line comes out differently there: the ExG chip test reports FAIL
from the dock, because that connection and the chip share pins. That is the
docked test, not the board.

**The clock-drift monitor** samples the sensor's real-world clock against this
host's on an interval and least-squares fits the slope in ppm, with a plot, a
seconds-per-day readout, and CSV export carrying the fit and its metadata. The
sensor's clock is driven by its 32 kHz crystal, so the crystal's error shows up
here directly — the absolute figure the self-test's own crystal check cannot
give, because that one measures the 32 kHz crystal against the 16 MHz one and
reports only the difference. A wired link is the better one for this: its round
trips jitter less than Bluetooth. Expect a usable figure within an hour or two.
If this host's clock is stepped (by NTP, or by a daylight-saving change) the
fit rebaselines itself rather than fitting across the discontinuity, and a
sensor whose clock was set on a whole-quarter-hour offset — by a tool using a
different convention — is recognised as such and reported, rather than shown
as an hour of error. A clock that is genuinely wrong still shows as wrong.

First measurements on hardware, docked: a stock Shimmer3R read about −9 ppm,
and a unit reworked to 22 pF crystal load capacitors about −98 ppm. Docked
sensors read a few ppm low from charge self-heating, so a battery run at room
temperature gives the comparable figure.

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
data at the configured rate. It models a small synthetic card, but not timing, power or
error paths, and it deliberately does not implement every command — a refused
one is a useful thing to be able to see.

| Parameter          | Effect                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `?mock=1`          | Framed replies, one per notification — how BLE behaves.                                                                                 |
| `&framed=0`        | Replies dribbled three bytes at a time — how a Classic-Bluetooth or USB byte stream behaves, and what re-framing is for.                |
| `&rate=<Hz>`       | Sampling rate, default 51.2.                                                                                                            |
| `&sdKBps=`         | Throttle the synthetic card's transfer rate, so progress and abort have something to act on.                                            |
| `&fw=`             | Report a different firmware version, to see the SD tab refuse an unsupported one.                                                       |
| `&hw=none`         | Refuse to say what hardware it is, to see the conservative name limits apply.                                                           |
| `&testMs=`         | Shorten the self-test's per-LED dwell (2000 ms on real hardware, so a full LED test really is 18 seconds).                              |
| `&testFail=1`      | A failing self-test: a FAIL line, a line long enough for the firmware to truncate, and the fail mask that goes with it.                 |
| `&ppm=`            | Run the mock sensor's clock at this error, so the drift monitor has a slope to find.                                                    |
| `&clockBase=local` | Start the sensor's clock on this host's civil time rather than UTC — what a sensor set by a tool using the other convention looks like. |
| `&debug=1`         | Log every command and reply to the browser console.                                                                                     |

While the mock is connected, `mockTransport.writes` in the console is every
command the page has sent, and `mockTransport.emitDisconnect()` simulates a
dropped link. `mockTransport.factoryTest` reports how many self-tests have run,
whether one is still printing and exactly what text it printed;
`mockTransport.rtc` exposes the sensor's own running clock. The panels
themselves are `factoryTestPanel` and `rtcDriftPanel`, beside `sdBrowser`,
`brandEditor` and `calibrationEditor`.

It is opt-in from the URL only, and deliberately so: a page that reached for
the mock on its own would quietly show fake data to somebody debugging real
hardware.

## Status

This is an early example. It has been exercised end to end against the mock
link; the paths that only a real sensor can prove — that a configuration write
is accepted and applied, that a calibration dump round-trips, that a long
recording holds up at high rates, that the self-test report arrives whole over
a real link, that the red LED really lights — want confirming on hardware
before anyone relies on them for real work. Check a recording before it
matters.
